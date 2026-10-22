import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers, CAD_EXTENSIONS } from './ipc';
import { PackRegistry } from '../src/packs/registry';
import { AgentTools } from '../src/agent/tools';
import { AgentRpcServer, createAgentTokenFile, type AgentRpcInfo } from '../src/agent/rpc';

const HEADLESS_SMOKE = process.argv.includes('--headless-smoke');
const APP_NAME = 'AutomationCAD';
app.setName(APP_NAME);

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (HEADLESS_SMOKE) app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void bootstrap();
}

let mainWindow: BrowserWindow | null = null;
let agentServer: AgentRpcServer | null = null;
let agentInfo: (AgentRpcInfo & { toolCount: number }) | { error: string } = { error: 'Agent 服务尚未启动' };

function desktopRoot(): string {
  return resolve(__dirname, '..');
}

function indexHtmlPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web', 'index.html')
    : resolve(desktopRoot(), '..', 'index.html');
}

function extensionPath(): string {
  return join(app.getAppPath(), 'dist', 'extension.js');
}

function extensionBaseUrl(): string {
  return pathToFileURL(join(app.getAppPath(), 'dist') + '/').href;
}

function builtinPacksDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'packs', 'builtin')
    : resolve(desktopRoot(), '..', 'packs', 'builtin');
}

function userPacksDir(): string {
  return join(app.getPath('userData'), 'packs');
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#1E2124',
    show: !HEADLESS_SMOKE,
    title: 'AutomationCAD · 非标自动化整机设计',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  window.webContents.on('did-finish-load', async () => {
    try {
      const scriptUrl = pathToFileURL(extensionPath()).href;
      await window.webContents.executeJavaScript(
        `(() => {
          if (document.getElementById('automation-cad-extension')) return;
          const script = document.createElement('script');
          script.id = 'automation-cad-extension';
          script.src = ${JSON.stringify(scriptUrl)};
          document.body.appendChild(script);
        })()`
      );
    } catch (error) {
      console.error('[desktop] 扩展脚本注入失败', error);
    }
    if (HEADLESS_SMOKE) {
      let extensionReady = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        extensionReady = await window.webContents.executeJavaScript('window.__AUTOMATION_CAD_EXTENSION_READY__ === true');
        if (extensionReady) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      if (!extensionReady) {
        console.error('SMOKE_FAIL extension_not_ready');
        setTimeout(() => app.exit(1), 100);
        return;
      }
      const fixture = resolve(desktopRoot(), 'test', 'fixtures', 'cube.stp');
      if (existsSync(fixture)) {
        try {
          const stats = await window.webContents.executeJavaScript(
            `window.AutomationCadViewer.inspectPath(${JSON.stringify(fixture)})`
          ) as { triangleCount: number; meshCount: number };
          if (stats.triangleCount !== 12 || stats.meshCount !== 1) {
            console.error('SMOKE_FAIL cad_stats', JSON.stringify(stats));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_CAD_OK triangles=${stats.triangleCount} meshes=${stats.meshCount}`);
        } catch (error) {
          console.error('SMOKE_FAIL cad_parse', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      console.log('SMOKE_OK');
      setTimeout(() => app.quit(), 100);
    }
  });

  void window.loadFile(indexHtmlPath());
  buildMenu(window);
  return window;
}

async function chooseCadFile(window: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    title: '打开 CAD 文件',
    properties: ['openFile'],
    filters: [
      { name: 'CAD 文件', extensions: CAD_EXTENSIONS.map((ext) => ext.slice(1)) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function buildMenu(window: BrowserWindow): void {
  const send = (channel: string, payload?: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 CAD…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const filePath = await chooseCadFile(window);
            if (filePath) send('desktop:open-cad', { path: filePath, source: 'menu' });
          }
        },
        {
          label: '导入数据包…',
          click: async () => {
            const result = await dialog.showOpenDialog(window, {
              title: '导入数据包',
              properties: ['openFile'],
              filters: [{ name: '数据包 ZIP', extensions: ['zip'] }]
            });
            if (!result.canceled && result.filePaths[0]) {
              send('desktop:import-pack', { path: result.filePaths[0] });
            }
          }
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '机械', accelerator: 'CmdOrCtrl+Alt+1', click: () => send('desktop:set-domain', 'mech') },
        { label: '电气', accelerator: 'CmdOrCtrl+Alt+2', click: () => send('desktop:set-domain', 'elec') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 AutomationCAD',
          click: () => {
            void dialog.showMessageBox(window, {
              type: 'info',
              title: '关于 AutomationCAD',
              message: 'AutomationCAD 0.1.0',
              detail: 'Windows 11 桌面版首个可运行版本\nCAD 轻量化查看 · 数据包 · Agent 接口骨架',
              buttons: ['确定']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startAgent(registry: PackRegistry): Promise<void> {
  const { token, tokenFile } = createAgentTokenFile(app.getPath('userData'));
  const tools = new AgentTools(registry);
  agentServer = new AgentRpcServer({
    tools,
    token,
    version: app.getVersion(),
    host: '127.0.0.1',
    port: 7420
  });
  try {
    const info = await agentServer.start(tokenFile);
    agentInfo = { ...info, toolCount: tools.list().length };
    console.log(`[agent] ${info.url} · tools=${tools.list().length} · token=${tokenFile}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentInfo = { error: `Agent 服务启动失败：${message}` };
    console.error('[agent] 启动失败', error);
  }
}

async function bootstrap(): Promise<void> {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();

  const registry = registerIpcHandlers({
    builtinDir: builtinPacksDir(),
    userDir: userPacksDir(),
    stateFile: join(app.getPath('userData'), 'packs-state.json'),
    version: app.getVersion(),
    getAgentInfo: () => agentInfo
  });

  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });

  await startAgent(registry);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (agentServer) void agentServer.stop();
});
