import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { PackRegistry } from '../src/packs/registry';
import type { AgentRpcInfo } from '../src/agent/rpc';

export interface IpcContext {
  builtinDir: string;
  userDir: string;
  stateFile: string;
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

  ipcMain.handle('agent:info', () => context.getAgentInfo());

  const factoryInfo = () => ({
    ok: true,
    adapters: ['demo', 'opcua', 'mqtt'],
    connected: false,
    status: 'disconnected'
  });
  ipcMain.handle('factory:info', factoryInfo);
  ipcMain.handle('factory:status', factoryInfo);
  for (const channel of ['factory:connect', 'factory:disconnect', 'factory:browse', 'factory:read-tags', 'factory:write-tag', 'factory:subscribe']) {
    ipcMain.handle(channel, () => ({
      ok: false,
      code: 'NOT_IMPLEMENTED',
      message: '智慧工厂适配器将在 M4 接入。'
    }));
  }

  app.on('before-quit', () => {
    // 清理由主进程持有的资源；注册表本身无长连接。
  });

  return registry;
}
