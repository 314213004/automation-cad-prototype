import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { join } from 'node:path';
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

export interface IpcContext {
  builtinDir: string;
  userDir: string;
  stateFile: string;
  factoryConfigFile: string;
  plcConfigFile: string;
  syncConfigFile: string;
  version: string;
  getAgentInfo(): unknown;
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

async function exportReport(payload: unknown): Promise<{ path: string; htmlPath: string }> {
  const source = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
  const html = source?.html;
  if (typeof html !== 'string' || !html.trim()) throw new Error('报告 HTML 不能为空');
  if (html.length > 20 * 1024 * 1024) throw new Error('报告 HTML 超过 20MB，已拒绝导出');
  if (!html.includes('<html') || !html.includes('</html>')) throw new Error('报告 HTML 结构不完整');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(app.getPath('userData'), 'exports', timestamp);
  mkdirSync(directory, { recursive: true });
  const htmlPath = join(directory, 'report.html');
  const pdfPath = join(directory, 'report.pdf');
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
      landscape: true,
      pageSize: 'A3',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    if (pdf.byteLength === 0) throw new Error('PDF 打印结果为空');
    writeFileSync(pdfPath, pdf);
  } catch (error) {
    throw new Error(`PDF 报告导出失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
  return { path: pdfPath, htmlPath };
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
