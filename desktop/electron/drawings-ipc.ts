/**
 * 工程图 / FreeCAD 后台任务 IPC（drawings.techdraw 模块）。
 *
 * 安全约定（沿用 PR #6 的 IPC 加固）：
 * - 所有 invoke 通道经 createTrustedIpcHandler：只接受当前主窗口主 frame、且页面为应用入口 HTML；
 * - 模块状态由 renderer 经受信同步通道写入，主进程在每个副作用前复核（fail-closed）；
 * - renderer 不能传任何文件路径：图纸按 projectKey + partKey + format 在清单里解析；
 *   freecadcmd 路径只接受原生文件对话框的选择或绝对路径的 freecadcmd 可执行文件，并做版本探测。
 */
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type OpenDialogOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTrustedIpcSender } from './security.ts';
import { createTrustedIpcHandler } from './ipc.ts';
import { isFreecadCmdPath, type FreecadInfo, type FreecadJobSnapshot, type FreecadRunner } from './freecad.ts';
import { DRAWINGS_MODULE_DISABLED_MESSAGE, type DrawingsService } from './drawings-service.ts';

export interface FreecadSettings {
  schemaVersion: 1;
  path: string | null;
}

export function readFreecadSettings(file: string): FreecadSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).schemaVersion === 1) {
      const path = (raw as Record<string, unknown>).path;
      return { schemaVersion: 1, path: typeof path === 'string' && isFreecadCmdPath(path) ? path : null };
    }
  } catch {
    // 无设置文件即默认探测
  }
  return { schemaVersion: 1, path: null };
}

export function writeFreecadSettings(file: string, settings: FreecadSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const staging = `${file}.tmp`;
  writeFileSync(staging, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(staging, file);
}

/** FreeCAD 侧 PDF 渲染失败时的兜底：隐藏、沙箱化窗口打印 SVG（与成本报告 PDF 同一打印管线思路）。 */
export async function svgToPdfWithElectron(svgPath: string, pdfPath: string, paper: string): Promise<void> {
  const size = paper === 'A4' ? { w: 297, h: 210, name: 'A4' as const } : { w: 420, h: 297, name: 'A3' as const };
  const htmlPath = join(dirname(svgPath), `${basename(svgPath, '.svg')}.print.html`);
  writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${size.w}mm ${size.h}mm;margin:0}`
    + `html,body{margin:0;padding:0}img{display:block;width:${size.w}mm;height:${size.h}mm}</style></head>`
    + `<body><img src="${pathToFileURL(svgPath).href}"></body></html>`, 'utf8');
  const window = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
  });
  try {
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    await window.loadFile(htmlPath);
    const pdf = await window.webContents.printToPDF({
      landscape: true,
      pageSize: size.name,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    if (pdf.byteLength === 0) throw new Error('PDF 打印结果为空');
    writeFileSync(pdfPath, pdf);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    rmSync(htmlPath, { force: true });
  }
}

export interface DrawingsIpcContext {
  getWindow(): BrowserWindow | null;
  trustedUiPath: string;
  runner: FreecadRunner;
  service: DrawingsService;
  settingsFile: string;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  /** runner 内部配置路径缓存需要同步更新 */
  setConfiguredPath(path: string | null): void;
}

function disabled(): { ok: false; code: 'MODULE_DISABLED'; message: string } {
  return { ok: false, code: 'MODULE_DISABLED', message: DRAWINGS_MODULE_DISABLED_MESSAGE };
}

function publicInfo(info: FreecadInfo): FreecadInfo {
  return { ...info };
}

export function registerDrawingsIpc(context: DrawingsIpcContext): void {
  const handle = createTrustedIpcHandler(() => context.getWindow(), context.trustedUiPath);
  const broadcast = (snapshot: FreecadJobSnapshot): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('drawings:job-changed', snapshot);
    }
  };
  context.runner.onJobListener = broadcast;

  ipcMain.on('modules:sync-drawings-techdraw-enabled', (event: IpcMainEvent, enabled: unknown) => {
    const window = context.getWindow();
    const trusted = Boolean(window && !window.isDestroyed()
      && isTrustedIpcSender(event, window.webContents.id, context.trustedUiPath));
    if (!trusted || typeof enabled !== 'boolean') {
      event.returnValue = false;
      return;
    }
    context.setEnabled(enabled);
    if (!enabled) {
      for (const job of context.runner.jobs()) {
        if (['queued', 'preparing', 'running'].includes(job.state)) context.runner.cancel(job.jobId);
      }
    }
    event.returnValue = true;
  });

  handle('freecad:status', () => (context.isEnabled() ? { ok: true, info: publicInfo(context.runner.info()) } : disabled()));
  handle('freecad:detect', async () => {
    if (!context.isEnabled()) return disabled();
    return { ok: true, info: publicInfo(await context.runner.detect(true)) };
  });
  handle('freecad:choose-path', async () => {
    if (!context.isEnabled()) return disabled();
    const window = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: '选择 FreeCAD 命令行程序（安装目录 bin 下的 freecadcmd）',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'freecadcmd.exe', extensions: ['exe'] }]
        : [{ name: 'freecadcmd', extensions: ['*'] }]
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return { ok: false, code: 'CANCELED', message: '已取消' };
    return await applyPath(path);
  });
  handle('freecad:set-path', async (_event, path: unknown) => {
    if (!context.isEnabled()) return disabled();
    if (path === null) return await applyPath(null);
    if (typeof path !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '路径必须是字符串或 null' };
    return await applyPath(path);
  });

  async function applyPath(path: string | null): Promise<{ ok: boolean; code?: string; message?: string; info?: FreecadInfo }> {
    if (path !== null) {
      if (!isFreecadCmdPath(path)) {
        return { ok: false, code: 'INVALID_ARGUMENT', message: '只能选择 FreeCAD 安装目录 bin 下的 freecadcmd 可执行文件（不是 FreeCAD.exe）' };
      }
      if (!existsSync(path)) return { ok: false, code: 'NOT_FOUND', message: `文件不存在：${path}` };
    }
    writeFreecadSettings(context.settingsFile, { schemaVersion: 1, path });
    context.setConfiguredPath(path);
    const info = await context.runner.detect(true);
    if (path !== null && info.path !== path) {
      return { ok: false, code: 'PROBE_FAILED', message: `所选程序不可用：${info.reason}`, info: publicInfo(info) };
    }
    return { ok: true, info: publicInfo(info) };
  }

  handle('drawings:generate', async (_event, payload: unknown) => {
    if (!context.isEnabled()) return disabled();
    return await context.service.generate(payload);
  });
  handle('drawings:cancel', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: 'jobId 必须是字符串' };
    return { ok: context.runner.cancel(jobId) };
  });
  handle('drawings:jobs', () => (context.isEnabled() ? { ok: true, jobs: context.runner.jobs() } : disabled()));
  handle('drawings:list', (_event, payload: unknown) => {
    if (!context.isEnabled()) return disabled();
    try {
      const projectKey = (payload as { projectKey?: unknown } | null)?.projectKey;
      return context.service.list(projectKey);
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) };
    }
  });
  handle('drawings:open', async (_event, payload: unknown) => {
    if (!context.isEnabled()) return disabled();
    const source = (payload ?? {}) as { projectKey?: unknown; partKey?: unknown; format?: unknown };
    let path: string | null = null;
    try {
      path = context.service.resolveFile(source.projectKey, source.partKey, source.format);
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) };
    }
    if (!path) return { ok: false, code: 'NOT_FOUND', message: '图纸文件不存在，请重新出图' };
    const failure = await shell.openPath(path);
    return failure ? { ok: false, code: 'OPEN_FAILED', message: failure } : { ok: true };
  });
  handle('drawings:reveal', (_event, payload: unknown) => {
    if (!context.isEnabled()) return disabled();
    const source = (payload ?? {}) as { projectKey?: unknown; partKey?: unknown };
    try {
      const file = typeof source.partKey === 'string'
        ? (context.service.resolveFile(source.projectKey, source.partKey, 'pdf')
          ?? context.service.resolveFile(source.projectKey, source.partKey, 'dxf')
          ?? context.service.resolveFile(source.projectKey, source.partKey, 'svg'))
        : null;
      if (file) {
        shell.showItemInFolder(file);
        return { ok: true };
      }
      const directory = context.service.list(source.projectKey).directory;
      if (!existsSync(directory)) return { ok: false, code: 'NOT_FOUND', message: '还没有出过图' };
      void shell.openPath(directory);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) };
    }
  });
}
