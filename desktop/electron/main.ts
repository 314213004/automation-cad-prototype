import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerIpcHandlers, registerAgentChatIpc, CAD_EXTENSIONS } from './ipc';
import { PackRegistry } from '../src/packs/registry';
import { AgentTools } from '../src/agent/tools';
import { AgentRpcServer, createAgentTokenFile, type AgentRpcInfo } from '../src/agent/rpc';
import { RendererBridge, createAgentCommandBus, type CommandBus } from '../src/agent/commands';
import { buildDesignPackage } from '../src/sync/package';

const HEADLESS_SMOKE = process.argv.includes('--headless-smoke');
const APP_NAME = 'AutomationCAD';
app.setName(APP_NAME);

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (HEADLESS_SMOKE) {
  app.disableHardwareAcceleration();
  // CI 的 xvfb 环境没有 GPU；显式关闭 WebGL 以稳定覆盖降级面板路径。
  app.commandLine.appendSwitch('disable-webgl');
  // 避免与开发机上正在运行的实例争抢单实例锁。
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'automationcad-smoke-')));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  void bootstrap();
}

let mainWindow: BrowserWindow | null = null;
let agentServer: AgentRpcServer | null = null;
let agentTools: AgentTools | null = null;
let commandBus: CommandBus | null = null;
let agentInfo: (AgentRpcInfo & { toolCount: number }) | { error: string } = { error: 'Agent 服务尚未启动' };

function publicAgentInfo(): unknown {
  if ('error' in agentInfo) return agentInfo;
  const tools = agentTools?.summaries().map(({ name, description }) => ({ name, description })) ?? [];
  return {
    ...agentInfo,
    toolCount: tools.length,
    tools,
    history: commandBus?.history().slice(-5) ?? []
  };
}

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
      if (existsSync(fixture)) {
        try {
          const rendered = await window.webContents.executeJavaScript(
            `(async () => {
              window.AutomationCadViewer.open();
              await window.AutomationCadViewer.importPath(${JSON.stringify(fixture)});
              const fallback = document.getElementById('cadWebglFallback');
              return fallback ? {
                text: fallback.innerText || fallback.textContent || '',
                meshCount: Number(fallback.dataset.meshCount || 0),
                triangleCount: Number(fallback.dataset.triangleCount || 0),
                bounds: fallback.querySelector('[data-cad-fallback="bounds"]')?.textContent || ''
              } : null;
            })()`
          ) as { text: string; meshCount: number; triangleCount: number; bounds: string } | null;
          if (!rendered) {
            console.error('SMOKE_FAIL webgl_fallback_missing');
            setTimeout(() => app.exit(1), 100);
            return;
          }
          if (!rendered.text.includes('当前环境不支持 WebGL，无法显示 3D 模型') ||
              rendered.meshCount !== 1 || rendered.triangleCount !== 12) {
            console.error('SMOKE_FAIL webgl_fallback', JSON.stringify(rendered));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_WEBGL_FALLBACK_OK meshes=${rendered.meshCount} triangles=${rendered.triangleCount} bounds=${rendered.bounds}`);
        } catch (error) {
          console.error('SMOKE_FAIL webgl_fallback_import', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      if (existsSync(fixture)) {
        try {
          const mech = await window.webContents.executeJavaScript(
            `(() => {
              const hits = window.AutomationCadViewer.runInterference([
                { name: 'Fixture-A', bbox: { min: [0, 0, 0], max: [100, 100, 100] } },
                { name: 'Fixture-B', bbox: { min: [90, 90, 90], max: [190, 190, 190] } }
              ]);
              return { hits: hits.length, overlap: hits[0]?.overlap || null, severity: hits[0]?.severity || null };
            })()`
          ) as { hits: number; overlap: [number, number, number] | null; severity: string | null };
          if (mech.hits < 1 || !mech.overlap || mech.overlap.some((value) => Math.abs(value - 10) > 0.01)) {
            console.error('SMOKE_FAIL mech', JSON.stringify(mech));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_MECH_OK hits=${mech.hits}`);
        } catch (error) {
          console.error('SMOKE_FAIL mech_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const exported = await window.webContents.executeJavaScript(
            `(async () => {
              const csv = await window.AutomationCadViewer.exportData('csv');
              const dxf = await window.AutomationCadViewer.exportData('dxf');
              const xlsx = await window.AutomationCadViewer.exportData('xlsx');
              const glb = await window.AutomationCadViewer.exportMesh('glb');
              const obj = await window.AutomationCadViewer.exportMesh('obj');
              return { csv: csv.size, dxf: dxf.size, xlsx: xlsx.size, glb: glb.size, obj: obj.size };
            })()`
          ) as { csv: number; dxf: number; xlsx: number; glb: number; obj: number };
          if (!(exported.csv > 0) || !(exported.dxf > 0) || !(exported.xlsx > 0) ||
              !(exported.glb > 0) || !(exported.obj > 0)) {
            console.error('SMOKE_FAIL export', JSON.stringify(exported));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log('SMOKE_EXPORT_OK csv=1 dxf=1');
          console.log(`SMOKE_EXPORT_ASSETS_OK xlsx=${exported.xlsx} glb=${exported.glb} obj=${exported.obj}`);
        } catch (error) {
          console.error('SMOKE_FAIL export_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const pdf = await window.webContents.executeJavaScript(
            `window.AutomationCadViewer.exportReportPdf()`
          ) as { path: string; htmlPath: string };
          if (!pdf || !existsSync(pdf.path) || !pdf.path.endsWith('report.pdf')) {
            console.error('SMOKE_FAIL pdf', JSON.stringify(pdf));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_PDF_OK path=${pdf.path}`);
        } catch (error) {
          console.error('SMOKE_FAIL pdf_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        try {
          const mechUi = await window.webContents.executeJavaScript(
            `(() => {
              const rootTab = document.getElementById('cadStressRootTab');
              window.AutomationCadViewer.open();
              document.querySelector('[data-cad-side="stress"]')?.click();
              const calculators = document.querySelectorAll('#cadStressPane .cad-calc').length;
              const results = document.querySelectorAll('#cadStressPane .cad-calc-result').length;
              const inspector = Boolean(document.getElementById('cadInterferencePanel'));
              window.AutomationCadViewer.close();
              return { rootTab: Boolean(rootTab), calculators, results, inspector };
            })()`
          ) as { rootTab: boolean; calculators: number; results: number; inspector: boolean };
          if (!mechUi.rootTab || mechUi.calculators !== 3 || mechUi.results !== 3 || !mechUi.inspector) {
            console.error('SMOKE_FAIL mech_ui', JSON.stringify(mechUi));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log('SMOKE_MECH_UI_OK rootTab=1 calculators=3 inspector=1');
        } catch (error) {
          console.error('SMOKE_FAIL mech_ui_exception', error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
      }
      try {
        const ui = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            window.AutomationCadViewer.close();
            const factoryEntry = document.getElementById('factoryEntryButton');
            const packEntry = document.getElementById('packEntryButton');
            if (!factoryEntry || !packEntry) return { error: '扩展入口按钮缺失' };

            factoryEntry.click();
            await wait(120);
            const kind = document.getElementById('factoryKind');
            kind.value = 'demo';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('factoryConnect').click();
            await wait(700);
            const stations = document.querySelectorAll('#factoryStations .acp-station').length;
            const tags = document.querySelectorAll('#factoryStations .acp-tag').length;
            const factoryStatus = document.getElementById('factoryStatusBar')?.textContent || '';
            document.getElementById('factoryDisconnect').click();
            await wait(200);

            packEntry.click();
            await wait(350);
            const packRows = document.querySelectorAll('#packList .acp-pack-row').length;
            const search = document.getElementById('packSearch');
            search.value = 'SMC';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(450);
            const partRows = document.querySelectorAll('#packResults [data-part-row]').length;
            document.querySelector('#packResults [data-insert-part]')?.click();
            const overlay = JSON.parse(localStorage.getItem('automationcad.parts.overlay.v1') || '{"parts":[]}');
            return {
              stations,
              tags,
              factoryStatus,
              packRows,
              partRows,
              overlayCount: Array.isArray(overlay.parts) ? overlay.parts.length : 0
            };
          })()`
        ) as {
          error?: string;
          stations: number;
          tags: number;
          factoryStatus: string;
          packRows: number;
          partRows: number;
          overlayCount: number;
        };
        if (ui.error || ui.stations !== 2 || ui.tags !== 8 || !ui.factoryStatus.includes('已连接：demo') ||
            ui.packRows < 1 || ui.partRows < 1 || ui.overlayCount < 1) {
          console.error('SMOKE_FAIL ui', JSON.stringify(ui));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_UI_OK stations=${ui.stations} tags=${ui.tags} packs=${ui.packRows} parts=${ui.partRows} overlay=${ui.overlayCount}`);
      } catch (error) {
        console.error('SMOKE_FAIL ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const elecLib = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('elecLibEntryButton');
            if (!entry) return { error: '电气元件入口按钮缺失' };
            entry.click();
            let ready = false;
            for (let attempt = 0; attempt < 50; attempt += 1) {
              await wait(100);
              const state = document.getElementById('elecLibResults')?.dataset.ready;
              if (state === '1') { ready = true; break; }
              if (state === 'error') break;
            }
            const results = document.getElementById('elecLibResults');
            if (!ready || !results) {
              return { error: document.getElementById('elecLibStatus')?.textContent || '电气元件面板加载超时' };
            }
            const parts = Number(results.dataset.parts || 0);
            const categories = Number(results.dataset.categories || 0);
            const symbols = Number(results.dataset.symbols || 0);
            const rows = document.querySelectorAll('#elecLibResults [data-elec-part]').length;
            const contactor = Array.from(document.querySelectorAll('#elecLibCategories [data-elec-category]'))
              .find((button) => (button.textContent || '').startsWith('接触器'));
            contactor?.click();
            await wait(60);
            const contactorRows = document.querySelectorAll('#elecLibResults [data-elec-part]').length;
            const beforePlaced = document.querySelectorAll('#elPlaceLayer .esym').length;
            document.querySelector('#elecLibResults [data-elec-insert]:not([disabled])')?.click();
            await wait(120);
            const placedLayer = document.querySelectorAll('#elPlaceLayer .esym');
            const placedTag = placedLayer[placedLayer.length - 1]?.dataset.tag || '';
            const placed = placedLayer.length - beforePlaced;
            window.ElecDomain?.setDomain('mech');
            await wait(60);
            return { parts, categories, symbols, rows, contactorRows, placed, placedTag };
          })()`
        ) as { error?: string; parts: number; categories: number; symbols: number; rows: number; contactorRows: number; placed: number; placedTag: string };
        if (elecLib.error || elecLib.parts < 350 || elecLib.categories < 20 || elecLib.rows !== elecLib.parts || elecLib.contactorRows < 10 || elecLib.placed !== 1 || !elecLib.placedTag) {
          console.error('SMOKE_FAIL elec_lib', JSON.stringify(elecLib));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_LIB_OK parts=${elecLib.parts} categories=${elecLib.categories} symbols=${elecLib.symbols}`);
      } catch (error) {
        console.error('SMOKE_FAIL elec_lib_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const syncUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('syncEntryButton');
            if (!entry) return { error: '智慧工厂入口按钮缺失' };
            entry.click();
            await wait(120);
            const ids = ['syncBaseUrl', 'syncDeviceId', 'syncProjectId', 'syncApiKey', 'syncEnabled', 'syncTest', 'syncUpload', 'syncLastResult'];
            const missing = ids.filter((id) => !document.getElementById(id));
            const apiKeyType = document.getElementById('syncApiKey')?.getAttribute('type') || '';
            const enabledType = document.getElementById('syncEnabled')?.getAttribute('type') || '';
            const drawer = document.getElementById('syncDrawer');
            return {
              missing,
              apiKeyType,
              enabledType,
              visible: Boolean(drawer && !drawer.hidden),
              fields: ids.length
            };
          })()`
        ) as { error?: string; missing: string[]; apiKeyType: string; enabledType: string; visible: boolean; fields: number };
        if (syncUi.error || syncUi.missing.length > 0 || syncUi.apiKeyType !== 'password' ||
            syncUi.enabledType !== 'checkbox' || !syncUi.visible) {
          console.error('SMOKE_FAIL sync_ui', JSON.stringify(syncUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_SYNC_UI_OK fields=${syncUi.fields} apiKey=password enabled=checkbox`);
      } catch (error) {
        console.error('SMOKE_FAIL sync_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const built = buildDesignPackage({
          projectId: 'smoke-project',
          projectName: '冒烟测试装配体',
          appVersion: app.getVersion(),
          createdAt: '2026-10-22T14:00:00.000Z',
          bom: [{ no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061' }],
          bomCsv: '序号,名称\r\n1,底板\r\n',
          pdf: new TextEncoder().encode('%PDF-1.4 smoke'),
          glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
          dxf: '0\nSECTION\n0\nENDSEC\n'
        });
        if (built.manifest.files.length !== 4 || !/^[a-f0-9]{64}$/.test(built.manifest.bomSha256)) {
          console.error('SMOKE_FAIL sync_package', JSON.stringify({ files: built.manifest.files.length, sha: built.manifest.bomSha256 }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_SYNC_PACKAGE_OK files=${built.manifest.files.length} sha=1`);
      } catch (error) {
        console.error('SMOKE_FAIL sync_package_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const plcUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('commissionEntryButton');
            if (!entry) return { error: '联调入口按钮缺失' };
            entry.click();
            await wait(150);
            const kind = document.getElementById('commissionKind');
            kind.value = 'sim';
            kind.dispatchEvent(new Event('change', { bubbles: true }));
            document.getElementById('commissionConnect').click();
            await wait(450);
            const pointRows = document.querySelectorAll('#commissionPoints tr[data-plc-point]').length;
            const monitorRows = document.querySelectorAll('#commissionMonitor tr[data-monitor-point]').length;
            const lamp = document.getElementById('commissionLamp')?.dataset.state || '';
            const connectText = document.getElementById('commissionStatusText')?.textContent || '';
            if (pointRows !== 28 || monitorRows !== 28 || lamp !== 'connected' || !connectText.includes('已连接')) {
              return { error: 'PLC 连接或点位表异常', pointRows, monitorRows, lamp, connectText };
            }

            document.getElementById('commissionPowerRun').click();
            let powerText = '';
            for (let attempt = 0; attempt < 80; attempt += 1) {
              await wait(100);
              powerText = document.getElementById('commissionPowerSummary')?.textContent || '';
              if (powerText.includes('6/6 通过')) break;
            }
            if (!powerText.includes('6/6 通过')) return { error: '上电流程未全部通过', powerText };

            document.getElementById('commissionCasesRun').click();
            let casePass = 0;
            for (let attempt = 0; attempt < 80; attempt += 1) {
              await wait(100);
              casePass = document.querySelectorAll('#commissionCases .commission-badge.pass').length;
              if (casePass === 3) break;
            }
            const caseRows = document.querySelectorAll('#commissionCaseResults tr[data-case-id]').length;
            const failRows = document.querySelectorAll('#commissionCaseResults .commission-badge.fail').length;
            const exportButton = Boolean(document.getElementById('commissionExport'));
            let pdfPath = '';
            try {
              const pdf = await window.AutomationCadViewer.exportReportPdf();
              pdfPath = pdf.path;
            } catch (error) {
              return { error: '联调报告 PDF 导出失败：' + String(error) };
            }
            document.getElementById('commissionDisconnect').click();
            await wait(120);
            return { pointRows, monitorRows, powerText, casePass, caseRows, failRows, exportButton, pdfPath };
          })()`
        ) as {
          error?: string;
          pointRows: number;
          monitorRows: number;
          powerText: string;
          casePass: number;
          caseRows: number;
          failRows: number;
          exportButton: boolean;
          pdfPath: string;
        };
        if (plcUi.error || plcUi.pointRows !== 28 || plcUi.monitorRows !== 28) {
          console.error('SMOKE_FAIL plc', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLC_OK points=${plcUi.pointRows}`);
        if (!plcUi.powerText.includes('6/6 通过') || plcUi.casePass !== 3 || plcUi.failRows !== 0) {
          console.error('SMOKE_FAIL commission', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_COMMISSION_OK steps=6 passed=6');
        if (plcUi.caseRows < 18 || !plcUi.exportButton) {
          console.error('SMOKE_FAIL commission_ui', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_UI_OK cases=3 monitor=${plcUi.monitorRows} results=${plcUi.caseRows}`);
        if (!plcUi.pdfPath || !existsSync(plcUi.pdfPath)) {
          console.error('SMOKE_FAIL commission_pdf', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_PDF_OK path=${plcUi.pdfPath}`);
      } catch (error) {
        console.error('SMOKE_FAIL commission_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const summaries = agentTools?.summaries() ?? [];
        if (summaries.length !== 7) {
          console.error('SMOKE_FAIL agent_tools', JSON.stringify(summaries.map((tool) => tool.name)));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_TOOLS_OK tools=${summaries.length} implemented=${summaries.length}`);

        const bridgeState = await window.webContents.executeJavaScript(
          `(() => {
            const bridge = window.__AgentBridge;
            if (!bridge) return { ready: false, scene: 0, bom: 0, error: 'missing_bridge' };
            const scene = bridge.getScene();
            const bom = bridge.getBom();
            return {
              ready: bridge.ready() === true,
              scene: Array.isArray(scene?.parts) ? 1 : 0,
              bom: Array.isArray(bom) ? 1 : 0,
              error: (scene && scene.message) || (bom && bom.message) || ''
            };
          })()`
        ) as { ready: boolean; scene: number; bom: number; error?: string };
        if (!bridgeState.ready || bridgeState.scene !== 1 || bridgeState.bom !== 1) {
          console.error('SMOKE_FAIL agent_bridge', JSON.stringify(bridgeState));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_BRIDGE_OK scene=${bridgeState.scene} bom=${bridgeState.bom}`);

        const chatUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const entry = document.getElementById('agentEntryButton');
            if (!entry) return { error: '智能体入口按钮缺失' };
            entry.click();
            let fields = 0;
            let log = 0;
            for (let attempt = 0; attempt < 50; attempt += 1) {
              await wait(100);
              const drawer = document.getElementById('agentDrawer');
              fields = drawer?.querySelectorAll('.acp-field').length || 0;
              log = drawer?.querySelectorAll('.acp-chat-log').length || 0;
              if (fields === 6 && log === 1) break;
            }
            const drawer = document.getElementById('agentDrawer');
            return {
              fields,
              log,
              send: Boolean(document.getElementById('agentChatSend')),
              input: Boolean(document.getElementById('agentChatInput')),
              apiKeyPassword: document.getElementById('agentLlmApiKey')?.type === 'password',
              visible: Boolean(drawer && !drawer.hidden)
            };
          })()`
        ) as {
          error?: string;
          fields: number;
          log: number;
          send: boolean;
          input: boolean;
          apiKeyPassword: boolean;
          visible: boolean;
        };
        if (chatUi.error || chatUi.fields !== 6 || chatUi.log !== 1 ||
            !chatUi.send || !chatUi.input || !chatUi.apiKeyPassword || !chatUi.visible) {
          console.error('SMOKE_FAIL agent_chat_ui', JSON.stringify(chatUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_CHAT_UI_OK fields=${chatUi.fields} log=${chatUi.log}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const proto = await window.webContents.executeJavaScript(
          `(() => {
            const api = window.ProtoApi;
            if (!api || api.version !== 1) return { error: 'ProtoApi 缺失或版本不符' };
            const countParts = (nodes, inStd = false) => nodes.reduce((total, node) => {
              const std = inStd || node.id === 'g-std';
              const legacyStd = std && node.kind === 'part' && !String(node.id).startsWith('ins');
              const isModelPart = node.kind === 'part' || Boolean(node.part);
              return total + (!legacyStd && isModelPart ? 1 : 0) + countParts(node.children || [], std);
            }, 0);
            const hasNode = (nodes, id) => nodes.some((node) => node.id === id || hasNode(node.children || [], id));
            const beforeTree = api.getTree();
            const beforeParts = countParts(beforeTree);
            const beforeDof = api.getDofTotal();
            const inserted = api.insertPart('MXQ20-32-50');
            const afterTree = api.getTree();
            const afterParts = countParts(afterTree);
            const afterDof = api.getDofTotal();
            const nodeAdded = Boolean(inserted && inserted.id && hasNode(afterTree, inserted.id));
            const undo = api.undo();
            const undoTree = api.getTree();
            const undoParts = countParts(undoTree);
            const undoDof = api.getDofTotal();
            const redo = api.redo();
            const redoTree = api.getTree();
            const redoParts = countParts(redoTree);
            const redoDof = api.getDofTotal();
            return {
              inserted, nodeAdded, undo, redo,
              beforeParts, afterParts, undoParts, redoParts,
              beforeDof, afterDof, undoDof, redoDof
            };
          })()`
        ) as {
          error?: string;
          inserted: { ok: boolean; id?: string; label?: string; message?: string };
          nodeAdded: boolean;
          undo: { ok: boolean; label?: string; message?: string };
          redo: { ok: boolean; label?: string; message?: string };
          beforeParts: number;
          afterParts: number;
          undoParts: number;
          redoParts: number;
          beforeDof: number;
          afterDof: number;
          undoDof: number;
          redoDof: number;
        };
        if (proto.error || !proto.inserted?.ok || !proto.inserted.id || !proto.nodeAdded ||
            proto.afterParts - proto.beforeParts !== 1 || proto.afterDof - proto.beforeDof !== 2) {
          console.error('SMOKE_FAIL proto_insert', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_INSERT_OK parts=${proto.beforeParts}→${proto.afterParts} dof=+${proto.afterDof - proto.beforeDof}`);
        if (!proto.undo?.ok || proto.undoParts !== proto.beforeParts || proto.undoDof !== proto.beforeDof) {
          console.error('SMOKE_FAIL proto_undo', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_UNDO_OK parts=${proto.afterParts}→${proto.undoParts}`);
        if (!proto.redo?.ok || proto.redoParts !== proto.afterParts || proto.redoDof !== proto.afterDof) {
          console.error('SMOKE_FAIL proto_redo', JSON.stringify(proto));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PROTO_REDO_OK parts=${proto.undoParts}→${proto.redoParts}`);
      } catch (error) {
        console.error('SMOKE_FAIL proto_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
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

async function startAgent(registry: PackRegistry, commands: CommandBus): Promise<void> {
  const { token, tokenFile } = createAgentTokenFile(app.getPath('userData'));
  const tools = new AgentTools(registry, commands);
  agentTools = tools;
  commandBus = commands;
  agentServer = new AgentRpcServer({
    tools,
    token,
    version: app.getVersion(),
    host: '127.0.0.1',
    port: HEADLESS_SMOKE ? 0 : 7420
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
    factoryConfigFile: join(app.getPath('userData'), 'factory.json'),
    plcConfigFile: join(app.getPath('userData'), 'plc.json'),
    syncConfigFile: join(app.getPath('userData'), 'sync.json'),
    version: app.getVersion(),
    getAgentInfo: publicAgentInfo
  });

  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });

  commandBus = createAgentCommandBus(registry, new RendererBridge(() => mainWindow));
  await startAgent(registry, commandBus);
  registerAgentChatIpc({
    userDataDir: app.getPath('userData'),
    getTools: () => agentTools,
    getBus: () => commandBus,
    getWindow: () => mainWindow
  });

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
