import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { PackRegistry } from '../src/packs/registry';
import { FactoryManager } from '../src/factory/manager.ts';
import type { TagValue } from '../src/factory/types.ts';
import { PlcManager } from '../src/plc/manager.ts';
import { SyncClient } from '../src/sync/client.ts';
import { mergeSyncConfig, publicSyncConfig, readSyncConfig, writeSyncConfig } from '../src/sync/config.ts';
import { buildDesignPackage } from '../src/sync/package.ts';
import type { DesignBomRow, SyncConfig, SyncUploadPayload } from '../src/sync/types.ts';
import {
  EXPORT_EXTENSIONS,
  assertAllowedTargetPath,
  ensureExportExtension,
  validateExportFileName
} from '../src/export/file';
import { CAD_EXTENSIONS, isCadExtension } from '../src/shared/cad';
import { isUsablePricebookItem, validatePricebook } from '../src/cost/pricebook.ts';
import { CostExportError, planExportName } from '../src/cost/export.ts';
import type { AgentTools } from '../src/agent/tools.ts';
import type { CommandBus } from '../src/agent/commands.ts';
import { mergeLlmConfig, readLlmConfig, publicLlmConfig, saveLlmConfig } from '../src/agent/llm-config.ts';
import { OpenAiCompatibleClient, testLlmConnection } from '../src/agent/llm.ts';
import { AgentCancelledError, AgentSession } from '../src/agent/session.ts';
import { collectAgentContext } from '../src/agent/context.ts';
import { executePlan, type AgentPlan, type PlanStep } from '../src/agent/planner.ts';
import { runRecipe, type RecipeContext, type RecipeProgressEvent } from '../src/agent/recipes.ts';
import { createAuditLog, parseAuditLines, summarizeAudit } from '../src/agent/audit.ts';
import { AUDIT_DISPLAY_LIMIT, limitAuditEntries } from '../src/agent/audit-view.ts';
import type { AgentProgressEvent } from '../src/agent/feedback.ts';
import type { FeatureDoc } from '../src/parametric/features.ts';
import type { ParametricManager, ParametricStartInfo } from './parametric.ts';
import { createZip, normalizeZipPath, type ZipEntry } from '../src/shared/zip.ts';
import { planPlcExportDirectory } from '../src/plcgen/export.ts';
import {
  mergePlcHistory,
  normalizeHistoryEntry,
  parsePlcHistory,
  type PlcHistoryEntry
} from '../src/plcgen/history.ts';

export interface IpcContext {
  builtinDir: string;
  userDir: string;
  stateFile: string;
  factoryConfigFile: string;
  plcConfigFile: string;
  syncConfigFile: string;
  version: string;
  getAgentInfo(): unknown;
  getParametric(): ParametricManager | null;
}

export interface AgentChatIpcContext {
  userDataDir: string;
  getTools(): AgentTools | null;
  getBus(): CommandBus | null;
  getWindow(): BrowserWindow | null;
}

export { CAD_EXTENSIONS } from '../src/shared/cad';

function exportPayload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error('导出数据必须是字符串或字节数组');
}

interface ReportPageOptions {
  size: 'A3' | 'A4';
  landscape: boolean;
}

async function printHtmlToPdf(
  html: string,
  page: ReportPageOptions,
  directory: string
): Promise<{ pdf: Uint8Array; htmlPath: string }> {
  if (typeof html !== 'string' || !html.trim()) throw new Error('报告 HTML 不能为空');
  if (html.length > 20 * 1024 * 1024) throw new Error('报告 HTML 超过 20MB，已拒绝导出');
  if (!html.includes('<html') || !html.includes('</html>')) throw new Error('报告 HTML 结构不完整');

  mkdirSync(directory, { recursive: true });
  const htmlPath = join(directory, 'report.html');
  writeFileSync(htmlPath, html, 'utf8');

  const reportWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try {
    reportWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    await reportWindow.loadFile(htmlPath);
    const pdf = await reportWindow.webContents.printToPDF({
      landscape: page.landscape,
      pageSize: page.size,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    if (pdf.byteLength === 0) throw new Error('PDF 打印结果为空');
    return { pdf, htmlPath };
  } catch (error) {
    throw new Error(`PDF 报告导出失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
}

async function exportReport(payload: unknown): Promise<{ path: string; htmlPath: string }> {
  const source = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  const html = source?.html;
  if (typeof html !== 'string' || !html.trim()) throw new Error('报告 HTML 不能为空');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(app.getPath('userData'), 'exports', timestamp);
  const page = typeof source?.page === 'object' && source.page !== null ? source.page as Record<string, unknown> : {};
  const { pdf, htmlPath } = await printHtmlToPdf(html, {
    size: page.size === 'A4' ? 'A4' : 'A3',
    landscape: page.landscape === undefined ? true : page.landscape === true
  }, directory);
  const pdfPath = join(directory, 'report.pdf');
  writeFileSync(pdfPath, pdf);
  return { path: pdfPath, htmlPath };
}

/** Agent 导出 PDF：复用 A4 打印管线，返回字节；临时目录用完即删。 */
export async function renderCostReportPdf(html: string): Promise<Uint8Array> {
  const root = join(app.getPath('userData'), 'exports');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, '.render-'));
  try {
    const { pdf } = await printHtmlToPdf(html, { size: 'A4', landscape: false }, directory);
    return pdf;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Agent 导出装配报告 PDF：复用 A3 横向打印管线，返回字节；临时目录用完即删。 */
export async function renderAssemblyReportPdf(html: string): Promise<Uint8Array> {
  const root = join(app.getPath('userData'), 'exports');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, '.render-'));
  try {
    const { pdf } = await printHtmlToPdf(html, { size: 'A3', landscape: true }, directory);
    return pdf;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function costExportFailure(error: unknown): { ok: false; code: string; message: string } {
  const code = error instanceof CostExportError ? error.code : 'WRITE_FAILED';
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code,
    message: code === 'UNSUPPORTED_FORMAT' ? detail : `成本报告写入失败：${detail}`
  };
}

function syncBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label}必须是字节数组`);
}

function syncText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  return value;
}

function syncBom(value: unknown): DesignBomRow[] {
  if (!Array.isArray(value)) throw new Error('BOM 必须是数组');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`第 ${index + 1} 条 BOM 不是对象`);
    const row = entry as Record<string, unknown>;
    const no = typeof row.no === 'number' ? row.no : index + 1;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const spec = typeof row.spec === 'string' ? row.spec.trim() : '';
    const mat = typeof row.mat === 'string' ? row.mat.trim() : '';
    const qty = typeof row.qty === 'number' && Number.isFinite(row.qty) ? row.qty : 1;
    if (!name) throw new Error(`第 ${index + 1} 条 BOM 缺少名称`);
    const result: DesignBomRow = { no, name, spec, qty, mat };
    if (typeof row.remark === 'string' && row.remark.trim()) result.remark = row.remark.trim();
    return result;
  });
}

function parseSyncPayload(value: unknown): SyncUploadPayload {
  if (typeof value !== 'object' || value === null) throw new Error('同步数据必须是对象');
  const source = value as Record<string, unknown>;
  return {
    projectName: syncText(source.projectName, 'projectName'),
    bomCsv: typeof source.bomCsv === 'string' ? source.bomCsv : syncBytes(source.bomCsv, 'bom.csv'),
    reportHtml: syncText(source.reportHtml, '报告 HTML'),
    glb: syncBytes(source.glb, 'model.glb'),
    dxf: typeof source.dxf === 'string' ? source.dxf : syncBytes(source.dxf, 'drawing.dxf'),
    bom: syncBom(source.bom)
  };
}

export function createPackRegistry(context: Pick<IpcContext, 'builtinDir' | 'userDir' | 'stateFile'>): PackRegistry {
  return new PackRegistry({
    builtinDir: context.builtinDir,
    userDir: context.userDir,
    stateFile: context.stateFile
  });
}

function plcExportRoot(): string {
  return join(app.getPath('userData'), 'exports', 'plc');
}

function plcHistoryFile(): string {
  return join(app.getPath('userData'), 'plc-gen-history.json');
}

function readPlcGenHistory(): PlcHistoryEntry[] {
  try {
    return parsePlcHistory(JSON.parse(readFileSync(plcHistoryFile(), 'utf8')));
  } catch {
    return [];
  }
}

function writePlcGenHistory(history: PlcHistoryEntry[]): void {
  mkdirSync(dirname(plcHistoryFile()), { recursive: true });
  writeFileSync(plcHistoryFile(), `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

function plcExportFiles(value: unknown): ZipEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('PLC 导出缺少文件');
  if (value.length > 200) throw new Error('PLC 导出文件过多');
  let total = 0;
  const entries = value.map((item, index): ZipEntry => {
    if (typeof item !== 'object' || item === null) throw new Error(`PLC 导出文件 ${index + 1} 格式不合法`);
    const source = item as Record<string, unknown>;
    const path = normalizeZipPath(source.path);
    if (typeof source.content !== 'string') throw new Error(`PLC 导出文件 ${path} 缺少正文`);
    total += Buffer.byteLength(source.content, 'utf8');
    return { path, content: source.content };
  });
  if (total > 20 * 1024 * 1024) throw new Error('PLC 导出正文超过 20MB');
  return entries;
}

function plcExportFailure(error: unknown): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'PLC_EXPORT_FAILED',
    message: error instanceof Error ? error.message : String(error)
  };
}

export function registerIpcHandlers(context: IpcContext): PackRegistry {
  const registry = createPackRegistry(context);
  const factory = new FactoryManager({ configFile: context.factoryConfigFile });
  const plc = new PlcManager({ configFile: context.plcConfigFile });
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  factory.on('status', (status: unknown) => broadcast('factory:status', status));
  factory.on('values', (value: TagValue) => broadcast('factory:values', value));
  plc.on('status', (status: unknown) => broadcast('plc:status', status));
  plc.on('values', (values: unknown) => broadcast('plc:values', values));

  ipcMain.handle('app:version', () => ({
    app: context.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }));

  ipcMain.handle('export:saveFile', async (_event, name: unknown, data: unknown) => {
    const validated = validateExportFileName(name);
    const content = exportPayload(data);
    const window = BrowserWindow.getFocusedWindow();
    const options = {
      title: '导出文件',
      defaultPath: validated.name,
      filters: [
        { name: '导出文件', extensions: EXPORT_EXTENSIONS.map((extension) => extension.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true, path: null };
    const target = ensureExportExtension(result.filePath, validated.extension);
    assertAllowedTargetPath(target);
    writeFileSync(target, content);
    return { canceled: false, path: target };
  });

  ipcMain.handle('export:report', async (_event, payload: unknown) => await exportReport(payload));

  // Agent 成本报告落盘：目录固定 userData/exports，不接受调用方传入路径，也不弹系统对话框。
  ipcMain.handle('export:costFile', async (_event, payload: unknown) => {
    try {
      if (!isRecord(payload)) throw new Error('导出参数必须是对象');
      const format = payload.format;
      if (format !== 'pdf' && format !== 'csv') {
        throw new CostExportError('UNSUPPORTED_FORMAT', '导出格式仅支持 pdf 或 csv');
      }
      let data = payload.data;
      if (payload.encoding === 'base64') {
        if (typeof data !== 'string' || !data) throw new Error('导出数据不能为空');
        data = Buffer.from(data, 'base64');
      }
      const content = exportPayload(data);
      if (typeof content === 'string' && content.length === 0) throw new Error('导出数据不能为空');
      if (content instanceof Uint8Array && content.byteLength === 0) throw new Error('导出数据不能为空');

      const directory = join(app.getPath('userData'), 'exports');
      mkdirSync(directory, { recursive: true });
      const planned = planExportName({
        directory,
        format,
        fileName: payload.fileName,
        suggestedName: payload.suggestedName,
        overwrite: payload.overwrite === true,
        exists: existsSync
      });
      writeFileSync(planned.path, content);
      const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
      return { ok: true, path: planned.path, bytes };
    } catch (error) {
      return costExportFailure(error);
    }
  });

  // PLC 生成历史与导出：目录固定 userData/exports/plc，不接受任意绝对路径。
  ipcMain.handle('plcgen:history', () => readPlcGenHistory());

  ipcMain.handle('plcgen:recordHistory', (_event, value: unknown) => {
    const entry = normalizeHistoryEntry(value);
    if (!entry) throw new Error('PLC 生成历史条目格式不合法');
    const next = parsePlcHistory(mergePlcHistory(readPlcGenHistory(), entry));
    writePlcGenHistory(next);
    return next;
  });

  ipcMain.handle('plcgen:export', (_event, payload: unknown) => {
    try {
      if (!isRecord(payload)) throw new Error('PLC 导出参数必须是对象');
      const files = plcExportFiles(payload.files);
      const plan = planPlcExportDirectory({
        exportsRoot: plcExportRoot(),
        machineName: payload.machineName,
        now: new Date(),
        exists: existsSync
      });
      mkdirSync(plan.path, { recursive: true });
      for (const file of files) {
        const target = resolve(plan.path, file.path);
        if (!target.startsWith(resolve(plan.path) + sep)) throw new Error(`PLC 导出路径越界：${file.path}`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      const zip = createZip(files);
      writeFileSync(plan.zipPath, zip);
      return {
        ok: true,
        path: plan.path,
        zipPath: plan.zipPath,
        bytes: zip.byteLength,
        files: files.length
      };
    } catch (error) {
      return plcExportFailure(error);
    }
  });

  ipcMain.handle('plcgen:openExportDir', async (_event, value: unknown) => {
    try {
      const root = resolve(plcExportRoot());
      const target = typeof value === 'string' && value.trim() ? resolve(value) : root;
      if (target !== root && !target.startsWith(root + sep)) {
        throw new Error('只能打开 PLC 导出目录内的路径');
      }
      mkdirSync(target, { recursive: true });
      const message = await shell.openPath(target);
      return message ? { ok: false, path: target, message } : { ok: true, path: target };
    } catch (error) {
      return {
        ok: false,
        path: typeof value === 'string' ? value : '',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  });

  ipcMain.handle('cad:open-dialog', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: '打开 CAD 文件',
      properties: ['openFile'],
      filters: [
        { name: 'CAD 文件', extensions: CAD_EXTENSIONS.map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('cad:read-file', (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('缺少文件路径');
    if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error(`文件不存在：${filePath}`);
    const ext = extname(filePath).toLowerCase();
    if (!isCadExtension(ext)) throw new Error(`不支持的 CAD 扩展名：${ext || '(无)'}`);
    return readFileSync(filePath);
  });

  // 成本估算的内置价格簿：只读，返回校验后的价格簿与条目统计（示例条目不计价）。
  ipcMain.handle('cost:pricebook', () => {
    const pricebookPath = join(context.builtinDir, 'pricebook-cn', 'pricebook.json');
    if (!existsSync(pricebookPath)) {
      return { ok: false, message: `内置价格簿缺失：${pricebookPath}` };
    }
    try {
      const book = validatePricebook(JSON.parse(readFileSync(pricebookPath, 'utf8')) as unknown);
      const items = Object.values(book.items);
      const usableItems = items.filter((item) => isUsablePricebookItem(item)).length;
      return {
        ok: true,
        book,
        path: pricebookPath,
        currency: book.currency,
        updatedAt: book.updatedAt,
        usableItems,
        exampleItems: items.length - usableItems
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('packs:list', async () => await registry.scan());
  ipcMain.handle('packs:import-zip', async (_event, zipPath: unknown) => {
    if (typeof zipPath !== 'string' || !zipPath) throw new Error('缺少 ZIP 路径');
    return await registry.importZip(zipPath);
  });
  ipcMain.handle('packs:set-enabled', async (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('参数不合法');
    await registry.setEnabled(id, enabled);
    return { ok: true };
  });
  ipcMain.handle('packs:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('参数不合法');
    await registry.remove(id);
    return { ok: true };
  });
  ipcMain.handle('packs:list-parts', (_event, filter: unknown) => {
    const source = typeof filter === 'object' && filter !== null ? filter as Record<string, unknown> : {};
    return registry.listParts({
      ...(typeof source.q === 'string' ? { q: source.q } : {}),
      ...(typeof source.category === 'string' ? { category: source.category } : {}),
      ...(typeof source.packId === 'string' ? { packId: source.packId } : {})
    });
  });

  ipcMain.handle('packs:choose-zip', async () => {
    const window = BrowserWindow.getFocusedWindow();
    const options: OpenDialogOptions = {
      title: '导入数据包',
      properties: ['openFile'],
      filters: [{ name: '数据包 ZIP', extensions: ['zip'] }]
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return { canceled: result.canceled, filePaths: result.filePaths };
  });

  ipcMain.handle('agent:info', () => context.getAgentInfo());

  const getParametric = (): ParametricManager | null => context.getParametric();
  const unavailableStatus = { status: 'unavailable' as const, message: '参数化建模内核不可用' };
  const publicStart = (info: ParametricStartInfo): Omit<ParametricStartInfo, 'port' | 'token'> => ({
    ok: info.ok,
    status: info.status,
    message: info.message,
    ...(info.version ? { version: info.version } : {})
  });
  const parametric = getParametric();
  parametric?.onStatus((state) => broadcast('parametric:status-changed', state));
  ipcMain.handle('parametric:status', () => getParametric()?.status() ?? unavailableStatus);
  ipcMain.handle('parametric:start', async () => {
    const manager = getParametric();
    if (!manager) return { ok: false, status: 'unavailable', message: unavailableStatus.message };
    return publicStart(await manager.start());
  });
  ipcMain.handle('parametric:build', async (_event, doc: unknown) => {
    const manager = getParametric();
    if (!manager) return { ok: false, code: 'UNAVAILABLE', message: unavailableStatus.message };
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { ok: false, code: 'BUILD_FAILED', message: '特征树必须是对象' };
    }
    return await manager.build(doc as FeatureDoc);
  });
  ipcMain.handle('parametric:stop', async () => {
    const manager = getParametric();
    if (!manager) return unavailableStatus;
    await manager.stop();
    return manager.status();
  });

  ipcMain.handle('factory:info', () => ({ ok: true, adapters: factory.list(), status: factory.getStatus() }));
  ipcMain.handle('factory:list', () => ({ ok: true, data: factory.list() }));
  ipcMain.handle('factory:status', () => ({ ok: true, data: factory.getStatus() }));
  ipcMain.handle('factory:config', () => factory.getConfig());
  ipcMain.handle('factory:connect', (_event, config: unknown) => factory.connect(config));
  ipcMain.handle('factory:disconnect', () => factory.disconnect());
  ipcMain.handle('factory:browse', (_event, nodeId: unknown) => {
    if (nodeId !== undefined && typeof nodeId !== 'string') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'nodeId 必须是字符串' };
    }
    return factory.browse(nodeId);
  });
  ipcMain.handle('factory:read-tags', (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是数组' };
    return factory.readTags(ids);
  });
  ipcMain.handle('factory:write-tag', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    return factory.writeTag(id, value);
  });
  ipcMain.handle('factory:subscribe', (_event, ids: unknown) => {
    if (!Array.isArray(ids)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是数组' };
    return factory.subscribe(ids, (value) => broadcast('factory:values', value));
  });

  ipcMain.handle('plc:info', () => ({ ok: true, adapters: plc.list(), status: plc.getStatus() }));
  ipcMain.handle('plc:list', () => ({ ok: true, data: plc.list() }));
  ipcMain.handle('plc:status', () => ({ ok: true, data: plc.getStatus() }));
  ipcMain.handle('plc:config', () => plc.getConfig());
  ipcMain.handle('plc:connect', (_event, config: unknown) => plc.connect(config));
  ipcMain.handle('plc:disconnect', () => plc.disconnect());
  ipcMain.handle('plc:read', (_event, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    return plc.read(id);
  });
  ipcMain.handle('plc:read-all', () => plc.readAll());
  ipcMain.handle('plc:write', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (typeof value !== 'boolean' && typeof value !== 'number') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    }
    return plc.write(id, value);
  });
  ipcMain.handle('plc:force', (_event, id: unknown, value: unknown) => {
    if (typeof id !== 'string') return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (typeof value !== 'boolean' && typeof value !== 'number') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    }
    return plc.force(id, value);
  });

  const syncConfig = (): SyncConfig => readSyncConfig(context.syncConfigFile);
  const syncClient = (config: SyncConfig): SyncClient => new SyncClient(config);

  ipcMain.handle('sync:getConfig', () => publicSyncConfig(syncConfig()));
  ipcMain.handle('sync:saveConfig', (_event, patch: unknown) => {
    const next = mergeSyncConfig(syncConfig(), patch);
    writeSyncConfig(context.syncConfigFile, next);
    return publicSyncConfig(next);
  });
  ipcMain.handle('sync:test', async () => {
    try {
      return await syncClient(syncConfig()).testConnection();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:list', async () => {
    try {
      return await syncClient(syncConfig()).listPackages();
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:diff', async (_event, packageId: unknown) => {
    if (typeof packageId !== 'string' || !packageId.trim()) {
      return { ok: false, message: '缺少 packageId' };
    }
    try {
      return await syncClient(syncConfig()).diff(packageId);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('sync:upload', async (_event, value: unknown) => {
    let payload: SyncUploadPayload;
    try {
      payload = parseSyncPayload(value);
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    let config: SyncConfig;
    try {
      config = syncConfig();
    } catch (error) {
      return {
        ok: false,
        stage: '连接',
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (!config.enabled) {
      return { ok: false, stage: '上传', message: '智慧工厂同步未启用，请先在设置中打开启用开关' };
    }
    if (!config.baseUrl || !config.deviceId || !config.projectId) {
      return { ok: false, stage: '连接', message: '请先完整填写 baseUrl、deviceId、projectId 与 apiKey' };
    }

    let pdf: Uint8Array;
    try {
      const report = await exportReport({ html: payload.reportHtml, projectName: payload.projectName });
      pdf = new Uint8Array(readFileSync(report.path));
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：PDF 报告生成失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    let built: ReturnType<typeof buildDesignPackage>;
    try {
      built = buildDesignPackage({
        projectId: config.projectId,
        projectName: payload.projectName,
        appVersion: context.version,
        bom: payload.bom,
        bomCsv: payload.bomCsv,
        pdf,
        glb: payload.glb,
        dxf: payload.dxf
      });
    } catch (error) {
      return {
        ok: false,
        stage: '打包',
        message: `打包失败：${error instanceof Error ? error.message : String(error)}`
      };
    }

    let result: Awaited<ReturnType<SyncClient['uploadPackage']>>;
    try {
      result = await syncClient(config).uploadPackage(built.zip, built.manifest);
    } catch (error) {
      return {
        ok: false,
        stage: '上传',
        message: `上传失败：${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (result.ok && built.skipped.length > 0) {
      const skipped = `未包含缺失文件：${built.skipped.join('、')}`;
      return { ...result, message: result.message ? `${result.message}；${skipped}` : skipped };
    }
    return result;
  });

  app.on('before-quit', () => {
    void factory.disconnect();
    void plc.disconnect();
  });

  return registry;
}

export function registerAgentChatIpc(context: AgentChatIpcContext): void {
  let session: AgentSession | null = null;
  let activeChat: AbortController | null = null;
  let activePlan: AbortController | null = null;
  let activeRecipe: AbortController | null = null;

  const clearSession = (): void => {
    session = null;
  };

  const getSession = (): AgentSession => {
    if (session) return session;
    const tools = context.getTools();
    const bus = context.getBus();
    if (!tools || !bus) throw new Error('智能体服务尚未启动');
    const config = readLlmConfig(context.userDataDir);
    if (!config.apiKey) throw new Error('请先在模型设置中填写 API Key');
    const llm = new OpenAiCompatibleClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      tools: tools.summaries()
    });
    const auditFile = join(context.userDataDir, 'agent-audit.jsonl');
    const audit = createAuditLog({
      write: (line) => {
        appendFileSync(auditFile, `${line}\n`, 'utf8');
      }
    });
    session = new AgentSession({
      llm,
      bus,
      maxIterations: config.maxIterations,
      audit: (record) => audit.record(record),
      contextProvider: async () => {
        try {
          const result = await bus.execute('get_project_context');
          if (!result.ok) return null;
          return collectAgentContext({ projectContext: () => result.data });
        } catch {
          return null;
        }
      },
      confirmWrite: async (name, args) => {
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const serialized = JSON.stringify(args);
        const summary = serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized;
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: '智能体写操作确认',
          message: `智能体请求执行 ${name}，参数：${summary}，是否允许？`,
          detail: '该操作会修改当前装配体。',
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return result.response === 0;
      }
    });
    return session;
  };

  ipcMain.handle('agent:llm:get', () => publicLlmConfig(readLlmConfig(context.userDataDir)));

  ipcMain.handle('agent:llm:save', (_event, patch: unknown) => {
    const saved = saveLlmConfig(context.userDataDir, patch);
    clearSession();
    return publicLlmConfig(saved);
  });

  ipcMain.handle('agent:llm:test', async (_event, patch: unknown) => {
    let config: ReturnType<typeof readLlmConfig>;
    try {
      const existing = readLlmConfig(context.userDataDir);
      config = patch === undefined ? existing : mergeLlmConfig(existing, patch);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!config.apiKey) return { ok: false, message: '请先在模型设置中填写 API Key' };
    return await testLlmConnection(config);
  });

  ipcMain.handle('agent:chat:history', () => ({ ok: true, messages: session?.history() ?? [] }));

  // 审计只读接口：最近 200 条，凭据已在写入前脱敏；更早记录用 total/dropped 如实回报。
  ipcMain.handle('agent:audit:read', () => {
    const file = join(context.userDataDir, 'agent-audit.jsonl');
    try {
      if (!existsSync(file)) {
        return { ok: true, entries: [], total: 0, dropped: 0, summary: summarizeAudit([]) };
      }
      const all = parseAuditLines(readFileSync(file, 'utf8'));
      const limited = limitAuditEntries(all, AUDIT_DISPLAY_LIMIT);
      return { ok: true, ...limited, summary: summarizeAudit(all) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('agent:chat:clear', () => {
    clearSession();
    return { ok: true, messages: [] };
  });

  // P7-C：计划执行。规划在渲染层离线完成；主进程只接受已注册工具并再次校验。
  ipcMain.handle('agent:plan:execute', async (event, payload: unknown) => {
    const tools = context.getTools();
    const bus = context.getBus();
    if (!tools || !bus) {
      return {
        ok: false,
        confirmationRequired: false,
        confirmed: false,
        refused: true,
        results: [],
        totalMs: 0,
        summary: '智能体服务尚未启动'
      };
    }

    let plan: AgentPlan;
    let startAt: number | undefined;
    let maxSteps: number | undefined;
    try {
      if (typeof payload !== 'object' || payload === null) throw new Error('计划参数必须是对象');
      const source = payload as Record<string, unknown>;
      const rawPlan = source.plan;
      if (typeof rawPlan !== 'object' || rawPlan === null) throw new Error('缺少计划');
      const planRecord = rawPlan as Record<string, unknown>;
      if (!Array.isArray(planRecord.steps)) throw new Error('计划步骤必须是数组');
      const steps: PlanStep[] = planRecord.steps.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new Error(`第 ${index + 1} 步不是对象`);
        const step = entry as Record<string, unknown>;
        const tool = typeof step.tool === 'string' ? step.tool.trim() : '';
        if (!tool) throw new Error(`第 ${index + 1} 步缺少工具名`);
        if (!tools.has(tool)) throw new Error(`第 ${index + 1} 步工具未注册：${tool}`);
        const args = typeof step.args === 'object' && step.args !== null && !Array.isArray(step.args)
          ? { ...(step.args as Record<string, unknown>) }
          : {};
        const missing = Array.isArray(step.missing)
          ? step.missing.filter((value): value is string => typeof value === 'string')
          : undefined;
        return {
          tool,
          args,
          why: typeof step.why === 'string' ? step.why : '',
          readOnly: step.readOnly === true,
          ...(missing && missing.length > 0 ? { missing } : {})
        };
      });
      const confidence = typeof planRecord.confidence === 'number' && Number.isFinite(planRecord.confidence)
        ? planRecord.confidence
        : 0;
      const suggestions = Array.isArray(planRecord.suggestions)
        ? planRecord.suggestions.filter((value): value is string => typeof value === 'string')
        : undefined;
      const warnings = Array.isArray(planRecord.warnings)
        ? planRecord.warnings.filter((value): value is string => typeof value === 'string')
        : undefined;
      plan = {
        steps,
        confidence,
        ...(planRecord.refused === true ? { refused: true } : {}),
        ...(typeof planRecord.reason === 'string' ? { reason: planRecord.reason } : {}),
        ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
        ...(warnings && warnings.length > 0 ? { warnings } : {})
      };
      startAt = typeof source.startAt === 'number' && Number.isFinite(source.startAt)
        ? Math.max(0, Math.trunc(source.startAt))
        : undefined;
      maxSteps = typeof source.maxSteps === 'number' && Number.isFinite(source.maxSteps)
        ? Math.max(1, Math.trunc(source.maxSteps))
        : undefined;
    } catch (error) {
      return {
        ok: false,
        confirmationRequired: false,
        confirmed: false,
        refused: true,
        results: [],
        totalMs: 0,
        summary: `计划无效：${error instanceof Error ? error.message : String(error)}`
      };
    }

    const auditFile = join(context.userDataDir, 'agent-audit.jsonl');
    const audit = createAuditLog({ write: (line) => appendFileSync(auditFile, `${line}\n`, 'utf8') });
    let confirmCount = 0;
    const controller = new AbortController();
    activePlan = controller;
    const emitProgress = (progress: AgentProgressEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
    };
    const result = await executePlan(plan, {
      ...(startAt !== undefined ? { startAt } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      signal: controller.signal,
      onProgress: emitProgress,
      confirmPlan: async (request) => {
        confirmCount += 1;
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const detail = request.steps
          .map((step, index) => `${index + 1}. ${step.tool} ${JSON.stringify(step.args)}`)
          .join('\n');
        const response = await dialog.showMessageBox(window, {
          type: 'question',
          title: '智能体多步计划确认',
          message: request.message,
          detail: detail.length > 1200 ? `${detail.slice(0, 1200)}…` : detail,
          buttons: ['全部允许', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return response.response === 0;
      },
      execute: async (step, _index, signal) => {
        const stepStarted = Date.now();
        const outcome = await tools.call(step.tool, step.args, signal);
        const record = typeof outcome === 'object' && outcome !== null
          ? outcome as Record<string, unknown>
          : null;
        const ok = record ? record.ok !== false : true;
        const code = record && typeof record.code === 'string'
          ? record.code
          : record && typeof record.error === 'object' && record.error !== null && typeof (record.error as Record<string, unknown>).code === 'string'
            ? String((record.error as Record<string, unknown>).code)
            : undefined;
        audit.record({
          tool: step.tool,
          ok,
          source: 'plan',
          args: step.args,
          elapsedMs: Math.max(0, Date.now() - stepStarted),
          ...(code ? { code } : {})
        });
        return outcome;
      }
    });
    if (activePlan === controller) activePlan = null;
    return { ...result, confirmations: confirmCount };
  });

  // P7-I：流程模板执行。模板与占位符在共享模块中解析，主进程只负责逐步骤确认、审计与进度。
  ipcMain.handle('agent:recipe:execute', async (event, payload: unknown) => {
    const tools = context.getTools();
    const bus = context.getBus();
    let recipeId = '';
    if (!tools || !bus) {
      return {
        ok: false,
        code: 'AGENT_UNAVAILABLE',
        recipeId,
        recipeTitle: '',
        runId: '',
        results: [],
        completed: [],
        kept: [],
        skipped: [],
        totalMs: 0,
        summary: '智能体服务尚未启动',
        report: '智能体服务尚未启动，未执行任何步骤。',
        error: { code: 'AGENT_UNAVAILABLE', message: '智能体服务尚未启动' }
      };
    }

    let ctx: RecipeContext = {};
    let skipSteps: string[] = [];
    let rememberSameKind = false;
    try {
      if (typeof payload !== 'object' || payload === null) throw new Error('流程参数必须是对象');
      const source = payload as Record<string, unknown>;
      recipeId = typeof source.recipeId === 'string' ? source.recipeId.trim() : '';
      if (!recipeId) throw new Error('缺少 recipeId');
      if (source.context !== undefined) {
        if (typeof source.context !== 'object' || source.context === null || Array.isArray(source.context)) {
          throw new Error('context 必须是对象');
        }
        ctx = { ...(source.context as Record<string, unknown>) } as RecipeContext;
      }
      skipSteps = Array.isArray(source.skipSteps)
        ? source.skipSteps.filter((value): value is string => typeof value === 'string')
        : [];
      rememberSameKind = source.rememberSameKind === true;
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_ARGUMENT',
        recipeId,
        recipeTitle: '',
        runId: '',
        results: [],
        completed: [],
        kept: [],
        skipped: [],
        totalMs: 0,
        summary: `流程参数无效：${error instanceof Error ? error.message : String(error)}`,
        report: `流程参数无效：${error instanceof Error ? error.message : String(error)}`,
        error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) }
      };
    }

    if (Object.keys(ctx).length === 0) {
      try {
        const project = await bus.execute('get_project_context');
        if (project.ok) {
          ctx = { ...collectAgentContext({ projectContext: () => project.data }) } as RecipeContext;
        }
      } catch {
        ctx = {};
      }
    }
    if (!Array.isArray(ctx.bom)) {
      try {
        const bom = await bus.execute('get_bom');
        if (bom.ok && Array.isArray(bom.data)) ctx.bom = bom.data;
      } catch {
        // BOM 只影响成本流程前置条件；读取失败时让前置条件如实拦截。
      }
    }

    const auditFile = join(context.userDataDir, 'agent-audit.jsonl');
    const audit = createAuditLog({ write: (line) => appendFileSync(auditFile, `${line}
`, 'utf8') });
    let confirmCount = 0;
    const controller = new AbortController();
    activeRecipe = controller;
    const emitProgress = (progress: RecipeProgressEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
    };
    const result = await runRecipe(recipeId, ctx, {
      signal: controller.signal,
      skipSteps,
      rememberSameKind,
      onProgress: emitProgress,
      confirm: async (request) => {
        confirmCount += 1;
        const window = context.getWindow();
        if (!window || window.isDestroyed()) return false;
        const detail = `${request.tool} ${JSON.stringify(request.args)}`;
        const response = await dialog.showMessageBox(window, {
          type: 'question',
          title: '流程写操作确认',
          message: request.message,
          detail: detail.length > 1200 ? `${detail.slice(0, 1200)}…` : detail,
          buttons: ['允许', '拒绝'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return response.response === 0;
      },
      execute: async (step, _index, signal) => {
        const stepStarted = Date.now();
        const outcome = await tools.call(step.tool, step.args, signal);
        const record = typeof outcome === 'object' && outcome !== null
          ? outcome as Record<string, unknown>
          : null;
        const ok = record ? record.ok !== false : true;
        const code = record && typeof record.code === 'string'
          ? record.code
          : record && typeof record.error === 'object' && record.error !== null && typeof (record.error as Record<string, unknown>).code === 'string'
            ? String((record.error as Record<string, unknown>).code)
            : undefined;
        audit.record({
          tool: step.tool,
          ok,
          source: 'recipe',
          args: step.args,
          elapsedMs: Math.max(0, Date.now() - stepStarted),
          ...(code ? { code } : {})
        });
        return outcome;
      }
    });
    if (activeRecipe === controller) activeRecipe = null;
    return { ...result, confirmations: confirmCount };
  });

  ipcMain.handle('agent:chat:cancel', () => {
    if (!activeChat) return { ok: true, cancelled: false, message: '当前没有执行中的对话' };
    activeChat.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:plan:cancel', () => {
    if (!activePlan) return { ok: true, cancelled: false, message: '当前没有执行中的计划' };
    activePlan.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:recipe:cancel', () => {
    if (!activeRecipe) return { ok: true, cancelled: false, message: '当前没有执行中的流程' };
    activeRecipe.abort();
    return { ok: true, cancelled: true };
  });

  ipcMain.handle('agent:chat:send', async (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, message: '请输入要发送给智能体的内容', messages: session?.history() ?? [] };
    }
    if (text.length > 20_000) {
      return { ok: false, message: '消息过长，请控制在 20000 字以内', messages: session?.history() ?? [] };
    }
    try {
      const current = getSession();
      const started = Date.now();
      const controller = new AbortController();
      activeChat = controller;
      const runId = `chat-${started}-${Math.random().toString(36).slice(2, 8)}`;
      const emitProgress = (progress: AgentProgressEvent): void => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:progress', progress);
      };
      const reply = await current.run(text, {
        signal: controller.signal,
        onProgress: emitProgress,
        runId
      });
      if (activeChat === controller) activeChat = null;
      return {
        ok: true,
        reply,
        mode: current.mode(),
        elapsedMs: Math.max(0, Date.now() - started),
        messages: current.history()
      };
    } catch (error) {
      if (activeChat) {
        activeChat = null;
      }
      if (error instanceof AgentCancelledError) {
        return {
          ok: false,
          cancelled: true,
          message: error.message,
          completedSteps: error.completedSteps,
          elapsedMs: 0,
          messages: session?.history() ?? []
        };
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        messages: session?.history() ?? []
      };
    }
  });
}
