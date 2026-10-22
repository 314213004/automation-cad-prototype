import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { PackRegistry } from '../src/packs/registry';
import type { AgentRpcInfo } from '../src/agent/rpc';
import { FactoryManager } from '../src/factory/manager.ts';
import type { TagValue } from '../src/factory/types.ts';

export interface IpcContext {
  builtinDir: string;
  userDir: string;
  stateFile: string;
  factoryConfigFile: string;
  version: string;
  getAgentInfo(): (AgentRpcInfo & { toolCount: number; error?: string }) | { error: string };
}

export const CAD_EXTENSIONS = ['.step', '.stp', '.iges', '.igs', '.brep', '.stl', '.obj', '.gltf', '.glb'];

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
  const broadcast = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  factory.on('status', (status: unknown) => broadcast('factory:status', status));
  factory.on('values', (value: TagValue) => broadcast('factory:values', value));

  ipcMain.handle('app:version', () => ({
    app: context.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }));

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
    if (!CAD_EXTENSIONS.includes(ext)) throw new Error(`不支持的 CAD 扩展名：${ext || '(无)'}`);
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

  app.on('before-quit', () => {
    void factory.disconnect();
  });

  return registry;
}
