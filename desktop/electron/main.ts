import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  registerIpcHandlers,
  registerAgentChatIpc,
  CAD_EXTENSIONS,
  renderAssemblyReportPdf,
  renderCostReportPdf
} from './ipc';
import { PackRegistry } from '../src/packs/registry';
import { AgentTools } from '../src/agent/tools';
import { planReadOnly, planTool, routeIntent } from '../src/agent/router';
import { executePlan, plan } from '../src/agent/planner';
import { AgentThread, formatThreadContext, projectFingerprint, runPlan } from '../src/agent/thread';
import { RECIPES, runRecipe } from '../src/agent/recipes';
import {
  buildAgentContext,
  collectAgentContext,
  emptyAgentContext,
  serializeAgentContext
} from '../src/agent/context';
import { resolveReference } from '../src/agent/reference';
import { trimListResult } from '../src/agent/trim';
import { estimateTokens, pack } from '../src/agent/budget';
import { createAuditLog, formatAuditLine, parseAuditLines } from '../src/agent/audit';
import { AgentCancelledError, AgentSession } from '../src/agent/session';
import { TurnCallDeduper } from '../src/agent/dedupe';
import { runReadOnlyBatch } from '../src/agent/parallel';
import { ToolResultCache } from '../src/agent/cache';
import { BYPASS_CONFIRMATION_NOTICE, detectBypassIntent } from '../src/agent/policy';
import { suggestFailure } from '../src/agent/suggest';
import { suggestNextActions } from '../src/agent/advisor';
import { KB_STATS } from '../src/agent/kb/search';
import { repairToolCall } from '../src/agent/repair';
import { AgentRpcServer, createAgentTokenFile, type AgentRpcInfo } from '../src/agent/rpc';
import { RendererBridge, createAgentCommandBus, type CommandBus } from '../src/agent/commands';
import { buildDesignPackage } from '../src/sync/package';
import { describeCheck, runElectricalCheck } from '../src/elec/check';
import { computeCost, type CostInput } from '../src/cost/engine';
import { validatePricebook } from '../src/cost/pricebook';
import { planExportName } from '../src/cost/export';
import { demoMachineConfig } from '../src/commission/machine-config';
import { generateSt } from '../src/plcgen/st';
import { generateProject } from '../src/plcgen/generate';
import { verifyGenerated } from '../src/plcgen/verify';
import { ParametricManager } from './parametric.ts';
import { captureProductScreenshots } from './screenshots';

const HEADLESS_SMOKE = process.argv.includes('--headless-smoke');
const HEADLESS_SCREENSHOTS = process.argv.includes('--headless-screenshots');
const HEADLESS = HEADLESS_SMOKE || HEADLESS_SCREENSHOTS;
const APP_NAME = 'AutomationCAD';
app.setName(APP_NAME);

if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (HEADLESS_SMOKE) {
  app.disableHardwareAcceleration();
  // CI 的 xvfb 环境没有 GPU；显式关闭 WebGL 以稳定覆盖降级面板路径。
  app.commandLine.appendSwitch('disable-webgl');
}
if (HEADLESS) {
  // 避免与开发机上正在运行的实例争抢单实例锁。
  app.setPath('userData', mkdtempSync(join(tmpdir(), HEADLESS_SCREENSHOTS ? 'automationcad-shots-' : 'automationcad-smoke-')));
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
let parametric: ParametricManager | null = null;
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

/** Agent 工具 `run_cost_report` 的内置价格簿来源；与 `cost:pricebook` IPC 读同一份文件。 */
function readBuiltinPricebookRaw(): unknown {
  const pricebookPath = join(builtinPacksDir(), 'pricebook-cn', 'pricebook.json');
  if (!existsSync(pricebookPath)) throw new Error(`内置价格簿缺失：${pricebookPath}`);
  return JSON.parse(readFileSync(pricebookPath, 'utf8')) as unknown;
}

function userPacksDir(): string {
  return join(app.getPath('userData'), 'packs');
}

async function runParametricSmoke(window: BrowserWindow): Promise<void> {
  if (!process.env.AUTOMATIONCAD_PARAMETRIC_CMD) {
    console.log('SMOKE_PARAMETRIC_SIDECAR_SKIP');
    console.log('SMOKE_PARAMETRIC_UI_SKIP');
    return;
  }
  try {
    const result = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const api = window.__Parametric;
        const ui = window.AutomationCadParametric;
        const button = document.querySelector('[data-cad-action="parametric"]');
        if (!api || !ui || !button) return { error: '参数化入口缺失' };
        button.click();
        let status = await api.status();
        const deadline = Date.now() + 6000;
        while (status.status === 'stopped' || status.status === 'starting') {
          if (Date.now() > deadline) break;
          await wait(50);
          status = await api.status();
        }
        const auto = document.querySelector('[data-param-auto]');
        if (auto) {
          auto.checked = false;
          auto.dispatchEvent(new Event('change', { bubbles: true }));
        }
        ui.setDoc({
          schemaVersion: 1,
          updatedAt: '2026-10-23T12:00:00+08:00',
          features: [
            { id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8 } },
            { id: 'f2', type: 'holes', name: '安装孔', params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] } }
          ]
        });
        const build = await ui.build();
        await wait(80);
        const state = ui.state();
        const drawer = document.getElementById('cadParametricDrawer');
        const rows = document.querySelectorAll('[data-param-feature]').length;
        const oldBuildStatus = document.querySelector('[data-param-build-status]')?.textContent || '';
        const assemblyDoc = {
          schemaVersion: 2,
          updatedAt: '2026-10-23T12:00:00+08:00',
          instances: [
            {
              id: 'p1', name: '底板 A', partId: 'BASE-01',
              transform: { x: 0, y: 0, z: 0, rz: 0 },
              features: [
                { id: 'f1', type: 'box', name: '底板', params: { length: 120, width: 80, height: 8 } },
                { id: 'f2', type: 'holes', name: '安装孔', params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] } }
              ]
            },
            {
              id: 'p2', name: '顶板 B', partId: 'PLATE-02',
              transform: { x: 140, y: 0, z: 0, rz: 0 },
              features: [{ id: 'f1', type: 'box', name: '顶板', params: { length: 120, width: 80, height: 8 } }]
            },
            {
              id: 'p3', name: '支架', transform: { x: 0, y: 100, z: 0, rz: 30 },
              features: [{ id: 'f1', type: 'box', name: '支架', params: { length: 60, width: 40, height: 12 } }]
            }
          ]
        };
        ui.setDoc(assemblyDoc);
        const assemblyBuild = await ui.build();
        await wait(80);
        const assemblyState = ui.state();
        const instanceRows = document.querySelectorAll('[data-param-instance]').length;
        const bomRows = document.querySelectorAll('[data-param-bom-row]').length;
        return {
          button: true,
          status,
          build,
          state,
          rows,
          assemblyBuild,
          assemblyState,
          instanceRows,
          bomRows,
          drawerOpen: Boolean(drawer && !drawer.hidden),
          buildStatus: oldBuildStatus
        };
      })()`
    ) as {
      error?: string;
      button?: boolean;
      status?: { status: string; message: string; version?: string };
      build?: { ok: boolean; stats?: { faces?: number }; message?: string };
      state?: { features: number; instances?: number; bomRows?: number; status: string; statusLabel: string; stlLoaded: boolean; ghost: boolean };
      rows?: number;
      assemblyBuild?: { ok: boolean; stats?: { solids?: number; instances?: unknown[] }; message?: string };
      assemblyState?: { features: number; instances?: number; bomRows?: number; status: string };
      instanceRows?: number;
      bomRows?: number;
      drawerOpen?: boolean;
      buildStatus?: string;
    };
    if (result.error || !result.button || result.status?.status !== 'ready' || !result.status.version?.endsWith('-fake')) {
      throw new Error(`参数化入口状态异常：${JSON.stringify(result)}`);
    }
    if (!result.build?.ok || result.build.stats?.faces !== 19) {
      throw new Error(`参数化构建异常：${JSON.stringify(result.build)}`);
    }
    if (!result.drawerOpen || result.rows !== 2 || result.state?.features !== 2 ||
        result.state.status !== 'ready' || result.state.statusLabel !== '就绪' ||
        !result.state.stlLoaded || !result.buildStatus?.includes('面 19') ||
        !result.buildStatus?.includes('体积 71.5 cm³')) {
      throw new Error(`参数化 UI 异常：${JSON.stringify(result)}`);
    }
    console.log('SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1');
    console.log(`SMOKE_PARAMETRIC_UI_OK features=${result.state.features} status=${result.state.status}`);
    if (!result.assemblyBuild?.ok || result.assemblyBuild.stats?.solids !== 2 ||
        result.assemblyState?.instances !== 3 || result.assemblyState.bomRows !== 3 ||
        result.instanceRows !== 3 || result.bomRows !== 3) {
      throw new Error(`参数化装配异常：${JSON.stringify({
        build: result.assemblyBuild,
        state: result.assemblyState,
        instanceRows: result.instanceRows,
        bomRows: result.bomRows
      })}`);
    }
    console.log(`SMOKE_PARAMETRIC_ASSEMBLY_OK solids=${result.assemblyBuild.stats.solids} bomRows=${result.assemblyState.bomRows}`);
  } finally {
    if (parametric) await parametric.stop();
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: HEADLESS_SCREENSHOTS ? 1600 : 1440,
    height: HEADLESS_SCREENSHOTS ? 1000 : 900,
    useContentSize: HEADLESS_SCREENSHOTS,
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
    if (HEADLESS_SCREENSHOTS) {
      const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
        ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
        : resolve(desktopRoot(), '..', 'docs', 'desktop', 'screenshots');
      try {
        const result = await captureProductScreenshots(window, {
          outputDir,
          fixtureDir: resolve(desktopRoot(), 'test', 'fixtures')
        });
        if (parametric) await parametric.stop();
        setTimeout(() => app.exit(result.failed > 0 ? 1 : 0), 100);
      } catch (error) {
        console.error('SMOKE_SHOTS_FAIL', error);
        if (parametric) await parametric.stop();
        setTimeout(() => app.exit(1), 100);
      }
      return;
    }
    if (HEADLESS_SMOKE) {
      try {
        const generated = generateSt({ config: demoMachineConfig() });
        const repeated = generateSt({ config: demoMachineConfig() });
        if (
          generated.stats.files !== 5 ||
          generated.stats.tags !== 32 ||
          !/^[a-f0-9]{12}$/.test(generated.stats.inputHash) ||
          JSON.stringify(generated.files) !== JSON.stringify(repeated.files)
        ) {
          console.error('SMOKE_FAIL plcgen', JSON.stringify(generated.stats));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_OK files=${generated.stats.files} tags=${generated.stats.tags}`);

        const demo = demoMachineConfig();
        const cylindersByStation = new Map(
          demo.actuators
            .filter((actuator) => actuator.kind === 'cylinder')
            .map((actuator) => [actuator.station, actuator.id])
        );
        const projectConfig = {
          ...demo,
          safety: { emergencyStop: 'X100', safetyDoor: 'X101' },
          sensors: demo.sensors.map((sensor) => {
            const cylinder = cylindersByStation.get(sensor.station);
            return sensor.part === sensor.station && cylinder ? { ...sensor, part: cylinder } : sensor;
          }),
          sequence: [
            { id: 'smoke-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
            { id: 'smoke-2', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 1000 }
          ]
        };
        const project = generateProject({ config: projectConfig });
        const repeatedProject = generateProject({ config: projectConfig });
        if (
          !project.ok ||
          project.stats.files !== 11 ||
          project.stats.steps !== 2 ||
          JSON.stringify(project.files) !== JSON.stringify(repeatedProject.ok ? repeatedProject.files : [])
        ) {
          console.error('SMOKE_FAIL plcgen_project', JSON.stringify(project.ok ? project.stats : project.errors));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_SEQ_OK files=${project.stats.files} steps=${project.stats.steps}`);

        const simConfig = {
          ...projectConfig,
          sequence: [
            { id: 'sim-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 2000 },
            { id: 'sim-2', name: '压装气缸伸出', action: 'set', point: 'Y1', condition: 'X4', timeoutMs: 2000 },
            { id: 'sim-3', name: '锁付气缸伸出', action: 'set', point: 'Y2', condition: 'X8', timeoutMs: 2000 },
            { id: 'sim-4', name: '下料气缸伸出', action: 'set', point: 'Y3', condition: 'X12', timeoutMs: 2000 },
            { id: 'sim-5', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 2000 },
            { id: 'sim-6', name: '压装夹爪夹紧', action: 'set', point: 'Y9', condition: 'X5', timeoutMs: 2000 }
          ]
        };
        const verified = verifyGenerated(simConfig);
        if (
          !verified.ok ||
          verified.simulation?.steps.length !== 6 ||
          verified.simulation.alarms.length !== 0
        ) {
          console.error('SMOKE_FAIL plcgen_sim', JSON.stringify({
            ok: verified.ok,
            stage: verified.stage,
            steps: verified.simulation?.steps.length ?? 0,
            alarms: verified.simulation?.alarms ?? [],
            errors: verified.errors
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_PLCGEN_SIM_OK steps=${verified.simulation.steps.length} ok=1 alarms=${verified.simulation.alarms.length}`);
      } catch (error) {
        console.error('SMOKE_FAIL plcgen_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
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
      try {
        const demo = demoMachineConfig();
        const cylindersByStation = new Map(
          demo.actuators
            .filter((actuator) => actuator.kind === 'cylinder')
            .map((actuator) => [actuator.station, actuator.id])
        );
        const plcUiConfig = {
          ...demo,
          safety: { emergencyStop: 'X100', safetyDoor: 'X101' },
          sensors: demo.sensors.map((sensor) => {
            const cylinder = cylindersByStation.get(sensor.station);
            return sensor.part === sensor.station && cylinder ? { ...sensor, part: cylinder } : sensor;
          }),
          sequence: [
            { id: 'smoke-ui-1', name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
            { id: 'smoke-ui-2', name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 1000 }
          ]
        };
        const plcUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const config = ${JSON.stringify(plcUiConfig)};
            window.__PlcGenConfigProvider = () => config;
            window.ElecDomain?.setDomain('elec');
            await wait(30);
            const entry = document.getElementById('plcGenEntryButton');
            if (!entry) return { error: 'PLC 程序入口缺失' };
            if (entry.hidden) return { error: 'PLC 程序入口在电气域不可见' };
            entry.click();
            await wait(60);
            const panel = window.__PlcGenPanel;
            if (!panel) return { error: 'PLC 面板 API 缺失' };
            if (!panel.hasConfig()) return { skip: true };
            const pre = await panel.precheck();
            if (!pre) return { error: '预检未返回结果' };
            const before = panel.uiState();
            await panel.generate();
            await wait(40);
            const after = panel.uiState();
            const verify = await panel.simulate();
            const simulateButton = Boolean(document.getElementById('plcSimulate'));
            const exported = await panel.exportZip();
            await wait(20);
            return {
              preErrors: pre.errors.length,
              beforeDisabled: before.generateDisabled,
              files: after.files,
              history: after.history,
              treeRows: after.treeRows,
              previewPath: after.previewPath,
              stats: after.stats,
              simulateButton,
              verifyOk: verify ? verify.ok : null,
              exportOk: exported.ok,
              exportPath: exported.path || '',
              zipPath: exported.zipPath || ''
            };
          })()`
        ) as {
          error?: string;
          skip?: boolean;
          preErrors?: number;
          beforeDisabled?: boolean;
          files?: number;
          history?: number;
          treeRows?: number;
          previewPath?: string | null;
          stats?: string;
          simulateButton?: boolean;
          verifyOk?: boolean | null;
          exportOk?: boolean;
          exportPath?: string;
          zipPath?: string;
        };
        if (plcUi.error) {
          console.error('SMOKE_FAIL plcgen_ui', plcUi.error);
          setTimeout(() => app.exit(1), 100);
          return;
        }
        if (plcUi.skip) {
          console.log('SMOKE_PLCGEN_UI_SKIP no_machine_config');
        } else if (
          plcUi.preErrors !== 0 ||
          plcUi.beforeDisabled !== false ||
          plcUi.files !== 11 ||
          plcUi.history !== 1 ||
          (plcUi.treeRows ?? 0) < 12 ||
          plcUi.previewPath !== 'README.md' ||
          !plcUi.stats?.includes('11 个文件 · 变量') ||
          plcUi.simulateButton !== true ||
          plcUi.verifyOk !== true ||
          !plcUi.exportOk ||
          !plcUi.exportPath || !existsSync(plcUi.exportPath) ||
          !plcUi.zipPath || !existsSync(plcUi.zipPath)
        ) {
          console.error('SMOKE_FAIL plcgen_ui', JSON.stringify(plcUi));
          setTimeout(() => app.exit(1), 100);
          return;
        } else {
          console.log(`SMOKE_PLCGEN_UI_OK files=${plcUi.files} history=${plcUi.history}`);
        }
      } catch (error) {
        console.error('SMOKE_FAIL plcgen_ui_exception', error);
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
          const kin = await window.webContents.executeJavaScript(
            `(async () => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const handle = window.AutomationCadKinematics;
              if (!handle) return { error: '运动学标注入口缺失' };
              handle.open();
              await wait(40);
              const initial = handle.state();
              const meshId = initial.meshes[0]?.id;
              if (meshId === undefined) return { error: '未枚举到 STEP 网格', meshes: initial.meshes.length };
              const first = handle.addMovingPart([meshId], '立方体-A');
              handle.updatePart(first, { kind: 'linear', axis: 'z', direction: 1, travelMm: 50, retractedMm: 0, point: 'Y0' });
              const second = handle.addMovingPart([meshId], '立方体-B');
              handle.updatePart(second, { kind: 'linear', axis: 'x', direction: 1, travelMm: 30, retractedMm: 0, point: '', role: '' });
              const state = handle.state();
              const pose = handle.slide(first, 25);
              await wait(30);
              const cards = document.querySelectorAll('[data-kin-part]').length;
              const alert = document.querySelector('[data-kin-alert]')?.textContent || '';
              const slider = document.querySelector('[data-kin-part="' + first + '"] [data-kin-slide]');
              const distance = pose ? Math.hypot(...pose.offset) : 0;
              const mode = window.__Commission3D?.kinematicsMode?.() ?? null;
              return {
                parts: state.parts.length,
                errors: state.errors,
                warnings: state.warnings,
                cards,
                alert,
                slider: Number(slider?.value ?? -1),
                distance,
                mode: mode?.mode || '',
                modeBar: document.getElementById('commission3dMode')?.textContent || ''
              };
            })()`
          ) as {
            error?: string;
            parts: number;
            errors: number;
            warnings: number;
            cards: number;
            alert: string;
            slider: number;
            distance: number;
            mode: string;
            modeBar: string;
          };
          if (kin.error || kin.parts !== 2 || kin.errors !== 1 || kin.cards !== 2 ||
              !kin.alert.includes('1 项未通过') || kin.slider !== 25 || !(kin.distance > 0) ||
              kin.mode !== 'config' || !kin.modeBar.includes('配置驱动')) {
            console.error('SMOKE_FAIL kinematics_ui', JSON.stringify(kin));
            setTimeout(() => app.exit(1), 100);
            return;
          }
          console.log(`SMOKE_KINEMATICS_UI_OK parts=${kin.parts} errors=${kin.errors} slide=${kin.slider}`);
        } catch (error) {
          console.error('SMOKE_FAIL kinematics_ui_exception', error);
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
        const enclosure = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__Enclosure;
            if (!api) return { error: '底板布置 API 缺失' };
            const first = await api.add('iC65N-C16-1P', 120, 180);
            const second = await api.add('iC65N-C16-1P', 126, 180);
            const state = api.state();
            api.close();
            return {
              added: Boolean(first && second),
              placed: state?.placed || 0,
              overlap: state?.overlap || 0,
              ratio: state?.ratio || 0,
              status: document.getElementById('encStatus')?.textContent || ''
            };
          })()`
        ) as { error?: string; added: boolean; placed: number; overlap: number; ratio: number; status: string };
        if (enclosure.error || !enclosure.added || enclosure.placed !== 2 || enclosure.overlap !== 1 || !(enclosure.ratio > 0) || !enclosure.status.includes('已放置')) {
          console.error('SMOKE_FAIL enclosure_canvas', JSON.stringify(enclosure));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1 ratio>0');
      } catch (error) {
        console.error('SMOKE_FAIL enclosure_canvas_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // P7-B：Agent 单步放置 + 撤销。走真实命令总线与 __Enclosure，不模拟几何。
        if (!commandBus) throw new Error('命令总线尚未就绪');
        const cleared = await window.webContents.executeJavaScript(
          `(() => { window.__Enclosure?.clear(); return window.__Enclosure?.state()?.placed ?? -1; })()`
        ) as number;
        const placed = await commandBus.execute('place_component', {
          partId: 'iC65N-C16-1P',
          x: 12,
          y: 40,
          rotate: false,
          railSnap: true
        });
        const placementId = placed.ok && placed.data && typeof placed.data === 'object'
          ? (placed.data as Record<string, unknown>).placementId
          : null;
        const afterPlace = await window.webContents.executeJavaScript(
          `(() => {
            const state = window.__Enclosure?.state();
            const item = state?.placements?.[0];
            return {
              placed: state?.placed ?? -1,
              x: item?.x ?? -1,
              y: item?.y ?? -1,
              w: item?.w ?? -1,
              h: item?.h ?? -1,
              railId: item?.railId ?? ''
            };
          })()`
        ) as { placed: number; x: number; y: number; w: number; h: number; railId: string };
        const undone = await commandBus.undoLast();
        const removed = undone.ok && undone.data && typeof undone.data === 'object'
          ? (undone.data as Record<string, unknown>).removed
          : null;
        const afterUndo = await window.webContents.executeJavaScript(
          `(() => window.__Enclosure?.state()?.placed ?? -1)()`
        ) as number;
        if (
          cleared !== 0 || !placed.ok || typeof placementId !== 'string' ||
          afterPlace.placed !== 1 || afterPlace.w !== 18 || afterPlace.h !== 85 ||
          !afterPlace.railId || !undone.ok || removed !== placementId || afterUndo !== 0
        ) {
          console.error('SMOKE_FAIL agent_place', JSON.stringify({
            cleared, placed, placementId, afterPlace, undone, removed, afterUndo
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_PLACE_OK placed=${afterPlace.placed} undo=${removed ? 1 : 0}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_place_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 电气校验规则引擎：用一段含跨网络重号 + 截面不足的样例电路自检。
        const result = runElectricalCheck({
          wires: [
            { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
            { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' },
            { no: 'L1', net: 'n3', potential: 'L2', from: 'QF1:1', to: 'KM1:3' }
          ],
          loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }],
          circuits: [{ wireNo: '101', currentA: 40, sectionMm2: 4 }],
          options: { demandFactor: 0.8 }
        });
        const codes = result.findings.map((item) => item.code);
        if (result.findings.length < 1 || result.counts.error < 1 ||
            !codes.includes('WIRE_NO_CROSS_NET') || !codes.includes('WIRE_SECTION_UNDER') ||
            result.summary.breakerSuggestion?.ratedA !== 16) {
          console.error('SMOKE_FAIL elec_check', JSON.stringify({ codes, counts: result.counts, summary: result.summary }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_CHECK_OK findings=${result.findings.length} errors=${result.counts.error} ${describeCheck(result)}`);
      } catch (error) {
        console.error('SMOKE_FAIL elec_check_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 电气校验面板：入口打开 → 运行样例 → 渲染问题表 → 导出 PDF。
        const elecUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__ElecCheckPanel;
            const entry = document.getElementById('elecCheckEntryButton');
            if (!api || !entry) return { error: '电气校验面板缺失' };
            entry.click();
            const drawer = document.getElementById('elecCheckDrawer');
            const opened = Boolean(drawer && !drawer.hidden);
            const result = await api.run({
              wires: [
                { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
                { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' },
                { no: '', net: 'n3', potential: 'L2', from: 'QF2:2', to: 'KM1:3' }
              ],
              loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }],
              circuits: [{ wireNo: '101', currentA: 40, sectionMm2: 4 }],
              options: { demandFactor: 0.8 }
            });
            if (!result) return { error: '校验未返回结果' };
            const rows = document.querySelectorAll('#elecCheckTable tbody tr').length;
            const cards = document.querySelectorAll('#elecCheckSummary .acp-check-card').length;
            const status = document.getElementById('elecCheckStatus')?.textContent || '';
            const html = api.html();
            const pdf = await api.exportPdf();
            api.close();
            return {
              opened,
              rows,
              cards,
              status,
              findings: result.findings.length,
              errors: result.counts.error,
              pdfPath: pdf.path,
              htmlSize: html.length,
              hasReport: html.includes('电气校验报告') && html.includes('校验问题明细')
            };
          })()`
        ) as {
          error?: string; opened: boolean; rows: number; cards: number; status: string;
          findings: number; errors: number; pdfPath: string; htmlSize: number; hasReport: boolean;
        };
        if (elecUi.error || !elecUi.opened || elecUi.cards !== 9 || elecUi.errors < 1 ||
            elecUi.rows !== elecUi.findings || !elecUi.status.includes('电气校验：错误') ||
            !elecUi.hasReport || !(elecUi.htmlSize > 1000) ||
            !elecUi.pdfPath || !elecUi.pdfPath.endsWith('report.pdf')) {
          console.error('SMOKE_FAIL elec_check_ui', JSON.stringify(elecUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_ELEC_CHECK_UI_OK rows=${elecUi.rows} cards=${elecUi.cards} pdf=${elecUi.pdfPath.endsWith('report.pdf')}`);
      } catch (error) {
        console.error('SMOKE_FAIL elec_check_ui_exception', error);
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
            const machine3d = document.getElementById('commission3dMachine')?.textContent || '';
            const lamp = document.getElementById('commissionLamp')?.dataset.state || '';
            const connectText = document.getElementById('commissionStatusText')?.textContent || '';
            if (pointRows !== 28 || monitorRows !== 28 || lamp !== 'connected' || !connectText.includes('已连接')) {
              return { error: 'PLC 连接或点位表异常', pointRows, monitorRows, lamp, connectText };
            }
            if (!machine3d.includes('4 工位') || !machine3d.includes('12 执行机构') || !machine3d.includes('16 传感器')) {
              return { error: '3D 机型摘要异常', machine3d };
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
            const stats3d = window.__Commission3D?.stats?.() ?? null;
            await window.desktop.plc.force('X6', false);
            const failedCase = await window.AutomationCadCommission.runCase('jog');
            await wait(150);
            const diagCodes = window.__Commission3D?.lastDiagnosis?.().length ?? 0;
            const diagCards = document.querySelectorAll('#commissionDiagnosis .commission-diagnosis-card').length;
            document.getElementById('commissionDisconnect').click();
            await wait(120);
            return { pointRows, monitorRows, machine3d, powerText, casePass, caseRows, failRows, exportButton, pdfPath, stats3d, failedCase, diagCodes, diagCards };
          })()`
        ) as {
          error?: string;
          pointRows: number;
          monitorRows: number;
          machine3d: string;
          powerText: string;
          casePass: number;
          caseRows: number;
          failRows: number;
          exportButton: boolean;
          pdfPath: string;
          stats3d: {
            frames: number;
            ticks: number;
            parts: number;
            stations: number;
            sensors: number;
            actuators: number;
          } | null;
          failedCase: boolean;
          diagCodes: number;
          diagCards: number;
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
        if (!plcUi.stats3d || plcUi.stats3d.frames < 3 || plcUi.stats3d.ticks < 3 || plcUi.stats3d.parts < 16) {
          console.error('SMOKE_FAIL commission_3d', JSON.stringify(plcUi.stats3d));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_3D_OK ticks=${plcUi.stats3d.ticks} parts=${plcUi.stats3d.parts}`);
        if (
          plcUi.stats3d.stations !== 4 ||
          plcUi.stats3d.actuators !== 12 ||
          plcUi.stats3d.sensors !== 16 ||
          plcUi.stats3d.parts < 16 ||
          plcUi.stats3d.ticks < 10
        ) {
          console.error('SMOKE_FAIL commission_3d_scale', JSON.stringify(plcUi.stats3d));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COMMISSION_3D_SCALE_OK stations=${plcUi.stats3d.stations} actuators=${plcUi.stats3d.actuators} sensors=${plcUi.stats3d.sensors} parts=${plcUi.stats3d.parts} ticks=${plcUi.stats3d.ticks}`);
        if (plcUi.failedCase !== false || plcUi.diagCodes < 1 || plcUi.diagCards < 1) {
          console.error('SMOKE_FAIL diagnose', JSON.stringify({ failedCase: plcUi.failedCase, diagCodes: plcUi.diagCodes, diagCards: plcUi.diagCards }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_DIAGNOSE_OK codes=${plcUi.diagCodes}`);
      } catch (error) {
        console.error('SMOKE_FAIL commission_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const activeTools = agentTools;
        if (!activeTools) throw new Error('Agent 工具尚未启动');
        const summaries = activeTools.summaries();
        if (
          summaries.length !== 20 ||
          !summaries.some((tool) => tool.name === 'design_machine') ||
          !summaries.some((tool) => tool.name === 'apply_machine_design') ||
          !summaries.some((tool) => tool.name === 'search_docs') ||
          !summaries.some((tool) => tool.name === 'run_electrical_check') ||
          !summaries.some((tool) => tool.name === 'run_cost_report') ||
          !summaries.some((tool) => tool.name === 'export_cost_report') ||
          !summaries.some((tool) => tool.name === 'place_component') ||
          !summaries.some((tool) => tool.name === 'verify_plc_program') ||
          !summaries.some((tool) => tool.name === 'get_project_context') ||
          !summaries.some((tool) => tool.name === 'update_component') ||
          !summaries.some((tool) => tool.name === 'remove_component') ||
          !summaries.some((tool) => tool.name === 'run_plc_generate') ||
          !summaries.some((tool) => tool.name === 'export_files')
        ) {
          console.error('SMOKE_FAIL agent_tools', JSON.stringify(summaries.map((tool) => tool.name)));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_TOOLS_OK tools=${summaries.length} implemented=${summaries.length}`);
        console.log(`SMOKE_AGENT_TOOLS_V2 tools=${summaries.length}`);

        const machineDesign = await activeTools.call('design_machine', {
          brief: '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服',
          stationCount: 3
        }) as {
          ok?: boolean;
          design?: {
            config?: { stations?: unknown[]; actuators?: unknown[]; sensors?: unknown[] };
            cycle?: { perMin?: number; secondsPerPiece?: number };
            power?: { va?: number };
            warnings?: unknown[];
            assumptions?: unknown[];
          };
          summary?: string;
          message?: string;
        };
        if (
          !machineDesign.ok ||
          machineDesign.design?.config?.stations?.length !== 3 ||
          machineDesign.design?.config?.actuators?.length !== 6 ||
          machineDesign.design?.config?.sensors?.length !== 6 ||
          machineDesign.design?.cycle?.perMin !== 20 ||
          machineDesign.design?.cycle?.secondsPerPiece !== 3 ||
          !(Number(machineDesign.design?.power?.va) > 0) ||
          machineDesign.design?.warnings?.length !== 1 ||
          !Array.isArray(machineDesign.design?.assumptions) ||
          typeof machineDesign.summary !== 'string' ||
          machineDesign.summary.length > 600
        ) {
          console.error('SMOKE_FAIL machine_design', JSON.stringify(machineDesign));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1');

        const applied = await activeTools.call('apply_machine_design', {
          brief: '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服',
          withPlc: true
        }) as {
          ok?: boolean;
          machineId?: string;
          stations?: number;
          actuators?: number;
          sensors?: number;
          bom?: { count?: number };
          bomPath?: string;
          plcPath?: string;
          designPath?: string;
          message?: string;
        };
        const appliedScene = await window.webContents.executeJavaScript(
          'window.__Commission3D?.stats?.()?.stations ?? -1'
        ) as number;
        if (
          !applied.ok ||
          applied.stations !== 3 ||
          applied.actuators !== 6 ||
          applied.sensors !== 6 ||
          applied.bom?.count !== 6 ||
          !applied.bomPath || !existsSync(applied.bomPath) ||
          !applied.plcPath || !existsSync(applied.plcPath) ||
          !applied.designPath || !existsSync(applied.designPath) ||
          appliedScene !== 3
        ) {
          console.error('SMOKE_FAIL machine_apply', JSON.stringify({ ...applied, appliedScene }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        const undone = await activeTools.call('undo_last', {}) as {
          ok?: boolean;
          command?: string;
          message?: string;
        };
        const restoredScene = await window.webContents.executeJavaScript(
          'window.__Commission3D?.stats?.()?.stations ?? -1'
        ) as number;
        if (!undone.ok || undone.command !== 'apply_machine_design' || restoredScene !== 4) {
          console.error('SMOKE_FAIL machine_apply_undo', JSON.stringify({ undone, restoredScene }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_MACHINE_APPLY_OK machine=${applied.machineId} stations=3 bom=6 undo=1`);

        const kbResult = await activeTools.call('search_docs', { query: 'D2', limit: 1 }) as {
          ok?: boolean;
          hits?: Array<{ source?: string; heading?: string; snippet?: string }>;
        };
        if (!kbResult?.ok || kbResult.hits?.length !== 1 || !kbResult.hits[0]?.source?.includes('docs/desktop/')) {
          console.error('SMOKE_FAIL agent_kb', JSON.stringify(kbResult));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_KB_OK docs=${KB_STATS.docs} chunks=${KB_STATS.chunks} query=D2 hits=${kbResult.hits.length}`);

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
              plc: typeof bridge.getPlcGenConfig === 'function' && bridge.getPlcGenConfig() ? 1 : 0,
              error: (scene && scene.message) || (bom && bom.message) || ''
            };
          })()`
        ) as { ready: boolean; scene: number; bom: number; plc: number; error?: string };
        if (!bridgeState.ready || bridgeState.scene !== 1 || bridgeState.bom !== 1 || bridgeState.plc !== 1) {
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

        // P7-I：流程下拉、步骤预览与「开始 / 导出执行记录」按钮。
        const recipeUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const select = document.getElementById('agentRecipeSelect');
            const panel = document.getElementById('agentRecipePanel');
            if (!select || !panel) return { error: 'missing_recipe_panel' };
            const options = select.querySelectorAll('option').length;
            const before = panel.querySelectorAll('.acp-recipe-step').length;
            select.value = 'cost-review';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await wait(80);
            const after = panel.querySelectorAll('.acp-recipe-step').length;
            return {
              options,
              before,
              after,
              start: Boolean(document.getElementById('agentRecipeStart')),
              exportButton: Boolean(document.getElementById('agentRecipeExport')),
              preconditions: panel.querySelectorAll('.acp-recipe-pre').length,
              remember: document.getElementById('agentRecipeRemember')?.checked === false
            };
          })()`
        ) as {
          error?: string;
          options: number;
          before: number;
          after: number;
          start: boolean;
          exportButton: boolean;
          preconditions: number;
          remember: boolean;
        };
        if (
          recipeUi.error || recipeUi.options !== 5 || recipeUi.before !== 5 ||
          recipeUi.after !== 4 || !recipeUi.start || !recipeUi.exportButton ||
          recipeUi.preconditions !== 1 || !recipeUi.remember
        ) {
          console.error('SMOKE_FAIL agent_recipe_ui', JSON.stringify(recipeUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_RECIPE_UI_OK recipes=${recipeUi.options} steps=${recipeUi.before}`);

        // P7-A-2：侧栏计划预览（只读可离线 / 写操作需联网）+ 审计面板
        const auditUiFile = join(app.getPath('userData'), 'agent-audit.jsonl');
        appendFileSync(
          auditUiFile,
          `${formatAuditLine({ tool: 'run_cost_report', ok: true, source: 'offline' })}\n` +
          `${formatAuditLine({ tool: 'export_cost_report', ok: false, code: 'USER_DENIED', source: 'llm' })}\n`,
          'utf8'
        );

        const readonlyUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const box = document.getElementById('agentPlanPreview');
            if (!input || !box) return { error: 'missing_preview' };
            const sceneParts = () => {
              const scene = window.__AgentBridge?.getScene?.();
              return Array.isArray(scene?.parts) ? scene.parts.length : -1;
            };
            const before = sceneParts();
            const type = async (text) => {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(80);
              return {
                tool: box.dataset.tool || '',
                readOnly: box.dataset.readOnly || '',
                offline: box.dataset.offline || '',
                title: document.getElementById('agentPlanTitle')?.textContent || '',
                hint: document.getElementById('agentPlanHint')?.textContent || ''
              };
            };
            const read = await type('列一下所有接触器');
            const write = await type('插入一个气缸');
            const after = sceneParts();
            document.getElementById('agentAuditRefresh')?.click();
            let rows = 0;
            let summary = '';
            for (let attempt = 0; attempt < 40; attempt += 1) {
              await wait(100);
              rows = document.querySelectorAll('#agentAuditList .acp-audit-row').length;
              summary = document.getElementById('agentAuditSummary')?.textContent || '';
              if (rows >= 2) break;
            }
            const firstRow = document.querySelector('#agentAuditList .acp-audit-row')?.textContent || '';
            return { before, after, read, write, rows, summary, firstRow };
          })()`
        ) as {
          error?: string;
          before: number;
          after: number;
          read: { tool: string; readOnly: string; offline: string; title: string; hint: string };
          write: { tool: string; readOnly: string; offline: string; title: string; hint: string };
          rows: number;
          summary: string;
          firstRow: string;
        };
        if (
          readonlyUi.error ||
          readonlyUi.read?.tool !== 'list_components' ||
          readonlyUi.read?.readOnly !== '1' ||
          readonlyUi.read?.offline !== '1' ||
          readonlyUi.write?.tool !== 'insert_component' ||
          readonlyUi.write?.readOnly !== '0' ||
          readonlyUi.write?.offline !== '0' ||
          !readonlyUi.write?.hint.includes('partId') ||
          readonlyUi.rows < 2 ||
          !readonlyUi.summary.includes('共 2 条') ||
          readonlyUi.before !== readonlyUi.after
        ) {
          console.error('SMOKE_FAIL agent_readonly_ui', JSON.stringify(readonlyUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=${readonlyUi.rows} summary=ok scene=${readonlyUi.after}`);

        // P7-C：多步计划卡片 + 顺序执行 + 写步骤一次确认
        const planUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const card = document.getElementById('agentPlanCard');
            if (!input || !card) return { error: 'missing_plan_card' };
            input.value = '读一下当前 BOM，算一下成本，然后导出 CSV 报价单';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(120);
            return {
              hidden: card.hidden === true,
              steps: card.querySelectorAll('.acp-plan-step').length,
              tools: Array.from(card.querySelectorAll('.acp-plan-step')).map((node) => node.dataset.tool || ''),
              runAll: Boolean(document.getElementById('agentPlanRunAll')),
              runStep: Boolean(document.getElementById('agentPlanRunStep')),
              cancel: Boolean(document.getElementById('agentPlanCancel')),
              meta: document.getElementById('agentPlanCardMeta')?.textContent || ''
            };
          })()`
        ) as {
          error?: string;
          hidden: boolean;
          steps: number;
          tools: string[];
          runAll: boolean;
          runStep: boolean;
          cancel: boolean;
          meta: string;
        };
        if (
          planUi.error ||
          planUi.hidden ||
          planUi.steps !== 3 ||
          planUi.tools.join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          !planUi.runAll || !planUi.runStep || !planUi.cancel ||
          !planUi.meta.includes('3 步')
        ) {
          console.error('SMOKE_FAIL agent_plan_ui', JSON.stringify(planUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const planRunUi = await window.webContents.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const input = document.getElementById('agentChatInput');
            const card = document.getElementById('agentPlanCard');
            if (!input || !card) return { error: 'missing_plan_card' };
            input.value = '读一下当前 BOM，然后查一下 24V 开关电源';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(100);
            const steps = card.querySelectorAll('.acp-plan-step').length;
            document.getElementById('agentPlanRunAll')?.click();
            let done = 0;
            let failed = 0;
            for (let attempt = 0; attempt < 60; attempt += 1) {
              await wait(100);
              done = card.querySelectorAll('.acp-plan-step.is-done').length;
              failed = card.querySelectorAll('.acp-plan-step.is-fail').length;
              if (done + failed >= steps && steps > 0) break;
            }
            return {
              steps,
              done,
              failed,
              feedback: document.getElementById('agentPlanFeedback')?.textContent || ''
            };
          })()`
        ) as { error?: string; steps: number; done: number; failed: number; feedback: string };
        if (planRunUi.error || planRunUi.steps !== 2 || planRunUi.done !== 2 || planRunUi.failed !== 0) {
          console.error('SMOKE_FAIL agent_plan_run_ui', JSON.stringify(planRunUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const planned = plan('读一下当前 BOM，算一下成本，然后导出 CSV 报价单');
        let planConfirms = 0;
        const planTools: string[] = [];
        const planResult = await executePlan(planned, {
          confirmPlan: async (request) => {
            planConfirms += 1;
            return request.steps.length === 3 && request.writeIndexes.length === 1;
          },
          execute: async (step) => {
            planTools.push(step.tool);
            if (step.tool === 'export_cost_report') {
              // 冒烟不落盘：写步骤只验证执行器顺序与确认，不制造临时文件。
              return { ok: true, data: { simulated: true, format: step.args.format } };
            }
            if (!agentTools) return { ok: false, code: 'AGENT_UNAVAILABLE', message: '工具未启动' };
            return await agentTools.call(step.tool, step.args);
          }
        });
        if (
          planned.steps.length !== 3 ||
          planned.steps.map((step) => step.tool).join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          planConfirms !== 1 ||
          planTools.join(',') !== 'get_bom,run_cost_report,export_cost_report' ||
          !planResult.ok ||
          !planResult.confirmationRequired ||
          !planResult.confirmed ||
          planResult.results.length !== 3 ||
          planResult.results.some((item) => !item.ok)
        ) {
          console.error('SMOKE_FAIL agent_plan', JSON.stringify({
            steps: planned.steps.map((step) => step.tool),
            planConfirms,
            planTools,
            planResult
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_PLAN_OK steps=${planned.steps.length} confirm=${planConfirms}`);

        // P7-I：流程模板执行——5 个模板、5 步流程、第 3 步注入失败、保留前 2 步。
        const recipeSmoke = await runRecipe('new-machine', {
          machine: { name: 'SF-2026-01' },
          cadPath: 'D:\\models\\smoke.step'
        }, {
          confirm: async () => true,
          execute: async (step) => {
            if (step.id === 'interference') {
              return { ok: false, code: 'SMOKE_INJECTED', message: '冒烟注入失败' };
            }
            return { ok: true, data: { smoke: step.id } };
          }
        });
        const recipeFailed = recipeSmoke.results.filter((item) => !item.ok && !item.skipped).length;
        if (
          RECIPES.length !== 5 ||
          (RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0) !== 5 ||
          recipeSmoke.ok ||
          recipeFailed !== 1 ||
          recipeSmoke.kept.length !== 2
        ) {
          console.error('SMOKE_FAIL agent_recipe', JSON.stringify({
            recipes: RECIPES.length,
            steps: (RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0),
            failed: recipeFailed,
            kept: recipeSmoke.kept.length,
            summary: recipeSmoke.summary
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_RECIPE_OK recipes=${RECIPES.length} steps=${(RECIPES.find((recipe) => recipe.id === 'new-machine')?.steps.length ?? 0)} failed=${recipeFailed} kept=${recipeSmoke.kept.length}`);

        // P7-A：离线规则路由 + 上下文裁剪 + 审计脱敏（无网络也必须是真实覆盖）
        const nlSamples = [
          '列一下所有接触器',
          '搜一下 SMC 气缸',
          '读一下当前 BOM',
          '这台机台成本多少',
          '检查有没有干涉',
          '电气校验线号有没有重复',
          '上电跑一遍联调序列',
          '把设计包同步到智慧工厂',
          '导出报价单 CSV',
          '插入一个气缸',
          '今天天气怎么样'
        ];
        const intents = nlSamples.map((sample) => routeIntent(sample));
        const intentKinds = new Set(intents.map((item) => item.intent));
        const readOnlyPlans = nlSamples
          .map((sample) => ({ sample, plan: planTool(sample), readOnly: planReadOnly(sample) }))
          .filter((item) => item.plan !== null);
        const leakedWrite = nlSamples.filter((sample) => {
          const plan = planTool(sample);
          return plan !== null && !plan.readOnly && planReadOnly(sample) !== null;
        });
        const costPlan = planReadOnly('这台机台成本多少');
        const listPlan = planReadOnly('列一下所有接触器');
        if (
          intentKinds.size !== 7 ||
          leakedWrite.length > 0 ||
          readOnlyPlans.length < 8 ||
          costPlan?.tool !== 'run_cost_report' ||
          listPlan?.tool !== 'list_components' ||
          listPlan.args.category !== '接触器'
        ) {
          console.error('SMOKE_FAIL agent_nl_router', JSON.stringify({
            intents: Array.from(intentKinds),
            leakedWrite,
            plans: readOnlyPlans.map((item) => `${item.sample}->${item.plan?.tool}`)
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const packed = buildAgentContext({
          project: '烟包机',
          deviceNo: 'SF-2026-01',
          domain: '电气',
          view: '底板',
          selection: { id: 'iC65N-C16-1P', tag: 'QF1' },
          recent: Array.from({ length: 6 }, (_unused, index) => ({ name: `op-${index}`, ok: index % 2 === 0 })),
          tools: (agentTools?.summaries() ?? []).map((tool) => ({ name: tool.name, description: tool.description }))
        });
        if (packed.bytes > 2048 || packed.toolCount === 0) {
          console.error('SMOKE_FAIL agent_context', JSON.stringify({ bytes: packed.bytes, tools: packed.toolCount }));
          setTimeout(() => app.exit(1), 100);
          return;
        }

        const uiContext = collectAgentContext({
          projectContext: () => ({
            domain: 'elec',
            view: '底板',
            selection: { kind: 'placement', id: 'p1', label: 'QF1' },
            machine: { name: '烟包机', stations: 4, actuators: 8, sensors: 12 },
            plate: {
              width: 600,
              height: 400,
              placed: 3,
              overlaps: 0,
              placements: [
                { id: 'p1', tag: 'QF1', model: 'iC65N-C16-1P', x: 200, y: 40, w: 36, h: 80 },
                { id: 'p2', tag: 'KM1', model: 'LC1D09', x: 20, y: 40, w: 45, h: 80 },
                { id: 'p3', tag: 'KA1', model: 'RXM2AB2BD', x: 80, y: 200, w: 30, h: 60 }
              ]
            },
            units: 'mm'
          }),
          recentActions: () => [
            { tool: 'search_components', summary: 'search_components 成功', at: '2026-10-23T00:00:01Z' },
            { tool: 'get_bom', summary: 'get_bom 成功', at: '2026-10-23T00:00:02Z' },
            { tool: 'run_cost_report', summary: 'run_cost_report 成功', at: '2026-10-23T00:00:03Z' },
            { tool: 'place_component', summary: 'place_component 成功 [target=placement:p1:QF1]', at: '2026-10-23T00:00:04Z' }
          ]
        }, () => '2026-10-23T00:00:05Z');
        const serializedContext = serializeAgentContext(uiContext);
        const deictic = resolveReference('把它改一下', uiContext);
        const geometry = resolveReference('左边第二个', uiContext);
        const trimmed = trimListResult(Array.from({ length: 25 }, (_unused, index) => ({ index })));
        if (
          serializedContext.bytes > 1536 ||
          uiContext.selection === null ||
          uiContext.recentActions.length !== 3 ||
          deictic.target?.id !== 'p1' ||
          geometry.target?.id !== 'p3' ||
          trimmed.items.length !== 20 ||
          trimmed.total !== 25 ||
          !trimmed.truncated
        ) {
          console.error('SMOKE_FAIL agent_context_snapshot', JSON.stringify({
            bytes: serializedContext.bytes,
            selection: uiContext.selection,
            recent: uiContext.recentActions.length,
            deictic,
            geometry,
            trimmed: { items: trimmed.items.length, total: trimmed.total, truncated: trimmed.truncated }
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_AGENT_CONTEXT_OK selection=1 recent=3');

        // 上下文预算：长列表先首尾收敛、history 先丢、system 永不裁。
        const budgetPayload = {
          system: '你是 AutomationCAD 的桌面智能体。所有写操作必须先确认。',
          selection: '选中：QF1（iC65N-C16-1P）\n机型：烟包机 · 4 工位',
          memory: '最近工具调用：get_bom → OK',
          docs: Array.from({ length: 24 }, (_unused, index) => `doc-${index}: 文档摘要 ${'说明'.repeat(18)}`),
          toolResults: Array.from({ length: 36 }, (_unused, index) => `tool-${index}: ${'结果'.repeat(22)}`),
          history: Array.from({ length: 40 }, (_unused, index) => `turn-${index}: 历史消息 ${'上下文'.repeat(16)}`)
        };
        const budgeted = pack(budgetPayload, {
          total: 420,
          caps: { history: 160, docs: 140, toolResults: 180 },
          listHead: 5,
          listTail: 5
        });
        const budgetSampleTokens = estimateTokens(`${'中文上下文'.repeat(20)}${'token budget '.repeat(20)}`);
        const budgetHasSystem = budgeted.text.includes('所有写操作必须先确认');
        const budgetDropSections = budgeted.dropped.map((entry) => entry.section);
        if (
          budgeted.used > 420 ||
          !budgetHasSystem ||
          budgeted.dropped.length === 0 ||
          budgetDropSections.indexOf('history') === -1 ||
          budgeted.docsSources < 0 ||
          budgetSampleTokens <= 0
        ) {
          console.error('SMOKE_FAIL agent_budget', JSON.stringify({
            used: budgeted.used,
            docsSources: budgeted.docsSources,
            system: budgetHasSystem,
            dropped: budgeted.dropped
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_BUDGET_OK used=${budgeted.used} dropped=${budgeted.dropped.length} tokens=${budgetSampleTokens}`);

        // P7-L：多轮状态、续跑跳过、工程变化拒续跑（3 轮状态写入）。
        const threadSmoke = new AgentThread();
        threadSmoke.write({
          turnId: 1,
          projectFingerprint: projectFingerprint(uiContext),
          intent: 'modify',
          targets: ['QF1'],
          denials: [],
          completedSteps: [{ step: 1, index: 0, tool: 'get_bom', ok: true, wrote: false }],
          lastReplySummary: '已读取 BOM'
        });
        const threadPlan = plan('读一下 BOM，算一下成本，然后导出 CSV 报价单');
        const smokeResumeRuns: number[] = [];
        const smokeResume = await runPlan(threadPlan, {
          resumeFrom: 0,
          previous: threadSmoke.read(),
          currentContext: uiContext,
          thread: threadSmoke,
          confirmPlan: async () => true,
          execute: async (step, index) => {
            smokeResumeRuns.push(index);
            return { ok: true, data: { tool: step.tool } };
          }
        });
        const smokeChangedContext = {
          ...uiContext,
          machine: { ...uiContext.machine!, name: '装盒机' },
          bomRows: 7
        };
        let smokeStaleRuns = 0;
        const smokeStale = await runPlan(threadPlan, {
          resumeFrom: 0,
          previous: threadSmoke.read(),
          currentContext: smokeChangedContext,
          execute: async () => {
            smokeStaleRuns += 1;
            return { ok: true };
          }
        });
        threadSmoke.finish({
          intent: 'modify',
          context: uiContext,
          completedSteps: [],
          reply: '已读取上一轮状态'
        });
        const smokeThreadPrompt = formatThreadContext(threadSmoke.read(), smokeChangedContext);
        const smokeTurns = threadSmoke.read()?.turnId ?? 0;
        if (
          smokeResume.resumedFrom !== 1 ||
          smokeResume.skippedSteps !== 1 ||
          smokeResumeRuns.join(',') !== '1,2' ||
          smokeStale.stale !== true ||
          smokeStaleRuns !== 0 ||
          !smokeThreadPrompt.includes('工程已变化，不要沿用旧结论') ||
          smokeTurns !== 3
        ) {
          console.error('SMOKE_FAIL agent_thread', JSON.stringify({
            resumedFrom: smokeResume.resumedFrom,
            skippedSteps: smokeResume.skippedSteps,
            resumed: smokeResumeRuns,
            stale: smokeStale.stale,
            staleRuns: smokeStaleRuns,
            turns: smokeTurns,
            prompt: smokeThreadPrompt
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log('SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1');

        // P7-N：去重 / 只读并行 / 会话缓存
        const smokeDedupe = new TurnCallDeduper({ isWrite: () => false });
        const smokeDedupeDecisions = smokeDedupe.plan([
          { tool: 'search_components', args: { q: 'SMC' } },
          { tool: 'search_components', args: { q: ' SMC ' } },
          { tool: 'search_components', args: { q: 'SMC' } }
        ]);
        const dedupeCount = smokeDedupeDecisions.filter((decision) => decision.action === 'reuse').length;
        const parallelSummary = await runReadOnlyBatch([0, 1], async (item) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return item;
        }, { concurrency: 3 });
        const smokeCache = new ToolResultCache({ now: () => 1_000 });
        smokeCache.set('get_bom', {}, 'machine=smoke;bom=1;placed=0;cad=0', { ok: true, data: { rows: 1 } });
        const cacheCount = smokeCache.get('get_bom', {}, 'machine=smoke;bom=1;placed=0;cad=0').hit ? 1 : 0;
        if (dedupeCount !== 2 || parallelSummary.maxConcurrency !== 2 || cacheCount !== 1) {
          console.error('SMOKE_FAIL agent_efficiency', JSON.stringify({
            dedupe: dedupeCount,
            parallel: parallelSummary.maxConcurrency,
            cache: cacheCount
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_EFFICIENCY_OK dedupe=${dedupeCount} parallel=${parallelSummary.maxConcurrency} cache=${cacheCount}`);

        const auditPath = join(app.getPath('userData'), 'agent-audit-smoke.jsonl');
        const auditLog = createAuditLog({ write: (line) => appendFileSync(auditPath, `${line}\n`, 'utf8') });
        auditLog.record({ tool: 'run_cost_report', ok: true, source: 'offline', args: { bom: [], apiKey: 'sk-live-abcdef123456' }, docsSources: 2 });
        auditLog.record({ tool: 'search_components', ok: false, code: 'NO_RESULT', source: 'llm', args: { q: '接触器' }, promptTokens: 120, completionTokens: 34, estimated: false });
        auditLog.record({ tool: 'export_cost_report', ok: true, source: 'llm', args: { format: 'csv', token: 'tp-9f8e7d6c5b4a' } });
        const auditRaw = readFileSync(auditPath, 'utf8');
        const auditEntries = parseAuditLines(auditRaw);
        if (auditEntries.length !== 3 || auditRaw.includes('abcdef123456') || auditRaw.includes('9f8e7d6c5b4a')) {
          console.error('SMOKE_FAIL agent_audit', JSON.stringify({ count: auditEntries.length, leaked: true }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_NL_OK intents=${intentKinds.size} tools=${summaries.length} audit=${auditEntries.length} ctx=${packed.bytes}`);

        // P7-F：执行进度、失败建议、取消与审计面板数据源
        const uxProgress: Array<{ phase: string; index: number; total: number; tool: string; argsSummary: string }> = [];
        let uxTurn = 0;
        const uxLlm = {
          async chat() {
            uxTurn += 1;
            if (uxTurn === 1) {
              return {
                content: '',
                toolCalls: [
                  { id: 'ux-1', type: 'function' as const, function: { name: 'search_components', arguments: JSON.stringify({ q: 'SMC', apiKey: 'sk-live-ux-secret' }) } },
                  { id: 'ux-2', type: 'function' as const, function: { name: 'get_bom', arguments: '{}' } },
                  { id: 'ux-3', type: 'function' as const, function: { name: 'run_electrical_check', arguments: '{}' } }
                ]
              };
            }
            return { content: '三步完成', toolCalls: [] };
          }
        };
        const uxBus = {
          async execute(name: string) {
            return { ok: true, data: { name } };
          },
          async undoLast() {
            return { ok: true, data: {} };
          }
        };
        const uxAudit = createAuditLog({ write: () => {} });
        const uxSession = new AgentSession({
          llm: uxLlm,
          bus: uxBus,
          confirmWrite: async () => true,
          audit: (record) => uxAudit.record(record)
        });
        const uxReply = await uxSession.run('执行三步', {
          runId: 'smoke-ux',
          onProgress: (event) => uxProgress.push({
            phase: event.phase,
            index: event.index,
            total: event.total,
            tool: event.tool,
            argsSummary: event.argsSummary
          })
        });
        const uxStarts = uxProgress.filter((event) => event.phase === 'start');
        const uxEnds = uxProgress.filter((event) => event.phase === 'end');

        const uxController = new AbortController();
        const uxCancelSession = new AgentSession({
          llm: {
            async chat() {
              return {
                content: '',
                toolCalls: [{ id: 'ux-cancel', type: 'function' as const, function: { name: 'get_bom', arguments: '{}' } }]
              };
            }
          },
          bus: {
            async execute() {
              return await new Promise(() => {});
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          confirmWrite: async () => true
        });
        const uxCancelRun = uxCancelSession.run('取消', { signal: uxController.signal, runId: 'smoke-cancel' });
        setTimeout(() => uxController.abort(), 15);
        let uxCancelOk = 0;
        try {
          await uxCancelRun;
        } catch (error) {
          if (error instanceof AgentCancelledError && /已取消，未写入任何更改/.test(error.message)) uxCancelOk = 1;
        }
        const uxSuggestion = suggestFailure({ code: 'PART_NOT_FOUND', args: { model: 'MXQ99' }, tool: 'update_component' });
        if (
          uxReply !== '三步完成' ||
          uxStarts.length !== 3 ||
          uxEnds.length !== 3 ||
          uxStarts.some((event) => event.total !== 3 || !event.argsSummary) ||
          uxStarts[0]?.argsSummary.includes('ux-secret') ||
          uxAudit.entries.length !== 3 ||
          uxCancelOk !== 1 ||
          !uxSuggestion.advice.includes('search_components')
        ) {
          console.error('SMOKE_FAIL agent_ux', JSON.stringify({
            reply: uxReply,
            starts: uxStarts.length,
            ends: uxEnds.length,
            audit: uxAudit.entries.length,
            cancel: uxCancelOk
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_UX_OK steps=${uxStarts.length} audit=${uxAudit.entries.length} cancel=${uxCancelOk}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const advisorContext = {
          ...emptyAgentContext(),
          domain: 'mech' as const,
          plate: { width: 600, height: 400, placed: 7, overlaps: 3 }
        };
        const suggestions = suggestNextActions(advisorContext, {
          bomRows: 12,
          unplaced: 1,
          conflicts: null,
          missingDimensions: 5,
          hasCadModel: true,
          elecCheckPassed: true,
          elecIssueCount: 0,
          costStale: false,
          plcGenerated: false
        });
        if (
          suggestions.length !== 3 ||
          suggestions[0]?.id !== 'overlap' ||
          suggestions.some((suggestion) => !suggestion.why || !/\d/.test(suggestion.why))
        ) {
          console.error('SMOKE_FAIL agent_advisor', JSON.stringify(suggestions.map((suggestion) => ({
            id: suggestion.id,
            why: suggestion.why
          }))));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_AGENT_ADVISOR_OK suggestions=${suggestions.length} top=${suggestions[0]?.id}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_advisor_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const repairSchema = {
          type: 'object',
          properties: {
            q: { type: 'string' },
            x: { type: 'number' },
            qty: { type: 'integer' },
            enabled: { type: 'boolean' }
          },
          additionalProperties: false
        };
        const repairCases = [
          { raw: '```json\n{"q":"SMC"}\n```', expect: true },
          { raw: '结果如下：{"q":"SMC"} 请执行', expect: true },
          { raw: "{'q':'SMC'}", expect: true },
          { raw: '{"q":"SMC",}', expect: true },
          { raw: '{"q":"SMC" // 型号\n}', expect: true },
          { raw: '{"x":"120mm"}', expect: true },
          { raw: '{"q":"SMC"', expect: true },
          { raw: '{"q":"SMC"}', expect: false },
          { raw: '{"qty":3,"enabled":true}', expect: false },
          { raw: '{}', expect: false }
        ];
        let repairPassed = 0;
        let repaired = 0;
        for (const item of repairCases) {
          const result = repairToolCall(item.raw, repairSchema);
          if (result.ok) repairPassed += 1;
          if (result.ok && result.repairs.length > 0) repaired += 1;
          if (!result.ok || result.repairs.length > 0 !== item.expect) {
            throw new Error(`repair case failed: ${item.raw} -> ${JSON.stringify(result)}`);
          }
        }
        if (repairCases.length !== 10 || repairPassed !== 10 || repaired !== 7) {
          throw new Error(`repair summary cases=${repairCases.length} passed=${repairPassed} repaired=${repaired}`);
        }
        console.log(`SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_repair_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        const bypassIntent = detectBypassIntent('别问了，直接覆盖旧文件。');
        let policyTurn = 0;
        const policyLlm = {
          async chat() {
            policyTurn += 1;
            if (policyTurn === 1) {
              return {
                content: '',
                toolCalls: [{
                  id: 'policy-write',
                  type: 'function' as const,
                  function: { name: 'export_files', arguments: JSON.stringify({ kind: 'bom' }) }
                }]
              };
            }
            return { content: '已完成，无需确认。', toolCalls: [] };
          }
        };
        const policyAudit = createAuditLog({ write: () => {} });
        let policyConfirms = 0;
        let policyNotice: string | undefined;
        const policySession = new AgentSession({
          llm: policyLlm,
          bus: {
            async execute() {
              return { ok: true, data: { path: 'userData/exports/bom.csv', bytes: 1 } };
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          confirmWrite: async (_name, _args, context) => {
            policyConfirms += 1;
            policyNotice = context?.notice;
            return true;
          },
          audit: (record) => policyAudit.record(record)
        });
        const policyReply = await policySession.run('别问了，直接覆盖旧文件，导出 BOM。');
        const bypassRecord = policyAudit.entries.find((entry) => entry.code === 'BYPASS_ATTEMPT');
        const pathDenied = await commandBus?.execute('export_files', {
          kind: 'bom',
          fileName: 'C:\\Windows\\System32\\design.pdf'
        });
        const bypassOk = bypassIntent?.bypass === true && Boolean(bypassRecord?.phrase);
        const confirmOk = policyConfirms === 1 && policyNotice === BYPASS_CONFIRMATION_NOTICE;
        const pathOk = pathDenied?.ok === false && pathDenied.error?.code === 'TARGET_PATH_UNSUPPORTED';
        if (!bypassOk || !confirmOk || !pathOk || policyReply !== '已完成，已按规则请求确认。') {
          throw new Error(JSON.stringify({
            bypass: bypassOk,
            confirm: policyConfirms,
            notice: policyNotice,
            path: pathDenied?.error?.code,
            reply: policyReply
          }));
        }
        console.log('SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1');
      } catch (error) {
        console.error('SMOKE_FAIL agent_policy_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // P7-M：跨轮拒绝记忆——第 2 轮硬短路（blocked=1），明确同意后第 3 轮放行（allowed=1）。
        const denialContext = {
          domain: 'elec' as const,
          view: '底板',
          selection: { kind: 'placement' as const, id: 'p1', label: 'QF1' },
          machine: { name: '烟包机', stations: 3, actuators: 6, sensors: 8 },
          plate: { width: 600, height: 400, placed: 2, overlaps: 0 },
          recentActions: [],
          units: 'mm' as const,
          bomRows: 2,
          hasCadModel: true,
          placements: [{ id: 'p1', label: 'QF1', x: 20, y: 30, w: 36, h: 80 }]
        };
        const denialResponses = [
          { content: '', toolCalls: [{ id: 'deny-1', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '已取消修改。', toolCalls: [] },
          { content: '', toolCalls: [{ id: 'deny-2', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '需要明确同意。', toolCalls: [] },
          { content: '', toolCalls: [{ id: 'deny-3', type: 'function' as const, function: { name: 'update_component', arguments: JSON.stringify({ ref: 'QF1', model: 'NXB-63' }) } }] },
          { content: '已执行修改。', toolCalls: [] }
        ];
        let denialTurn = 0;
        let denialConfirms = 0;
        let denialExecuted = 0;
        const denialPrompts: string[] = [];
        const denialAudit = createAuditLog({ write: () => {} });
        const denialSession = new AgentSession({
          llm: {
            async chat(messages) {
              denialPrompts.push(String(messages[0]?.content ?? ''));
              return denialResponses[Math.min(denialTurn++, denialResponses.length - 1)]!;
            }
          },
          bus: {
            async execute() {
              denialExecuted += 1;
              return { ok: true, data: { updated: true } };
            },
            async undoLast() {
              return { ok: true, data: {} };
            }
          },
          contextProvider: () => denialContext,
          confirmWrite: async () => {
            denialConfirms += 1;
            return denialConfirms > 1;
          },
          audit: (record) => denialAudit.record(record)
        });
        await denialSession.run('把 QF1 的型号改成 NXB-63');
        await denialSession.run('继续');
        const blocked = denialAudit.entries.filter((entry) => entry.code === 'USER_DENIED_PREVIOUSLY').length;
        const promptInjected = denialPrompts.some((prompt) =>
          prompt.includes('跨轮拒绝记忆') && prompt.includes('update_component(QF1)（用户拒绝，第 1 轮）')
        );
        await denialSession.run('我同意，现在就改');
        const remaining = denialSession.threadState()?.denials.length ?? -1;
        if (blocked !== 1 || denialExecuted !== 1 || denialConfirms !== 2 || remaining !== 0 || !promptInjected) {
          throw new Error(JSON.stringify({ blocked, allowed: denialExecuted, confirms: denialConfirms, remaining, promptInjected }));
        }
        console.log(`SMOKE_AGENT_DENIAL_OK blocked=${blocked} allowed=${denialExecuted}`);
      } catch (error) {
        console.error('SMOKE_FAIL agent_denial_exception', error);
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
      try {
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const pricebook = validatePricebook(
          JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown
        );
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Pick<CostInput, 'bom' | 'placements' | 'plate' | 'options' | 'wireSection'>;
        const report = computeCost({
          ...costCase,
          pricebook,
          now: '2026-10-23T12:00:00+08:00'
        });
        if (report.lines.length !== 6 || report.missing.length !== 1 || report.totals.grand !== 1398.64) {
          console.error('SMOKE_FAIL cost', JSON.stringify({
            lines: report.lines.length,
            missing: report.missing.length,
            grand: report.totals.grand
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(
          `SMOKE_COST_OK lines=${report.lines.length} missing=${report.missing.length} grand=${report.totals.grand.toFixed(2)}`
        );
      } catch (error) {
        console.error('SMOKE_FAIL cost_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // Agent 工具 run_cost_report：经命令总线执行，结果必须与直接调用引擎一致（含价格簿注入）。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Record<string, unknown>;
        const agentCost = commandBus
          ? await commandBus.execute('run_cost_report', {
              ...costCase,
              pricebook: fixtureBook,
              now: '2026-10-23T12:00:00+08:00'
            })
          : null;
        const agentData = agentCost && agentCost.ok && agentCost.data && typeof agentCost.data === 'object'
          ? (agentCost.data as Record<string, unknown>)
          : null;
        const agentTotals = agentData && typeof agentData.totals === 'object'
          ? (agentData.totals as Record<string, unknown>)
          : null;
        const agentCounts = agentData && typeof agentData.counts === 'object'
          ? (agentData.counts as Record<string, unknown>)
          : null;
        const agentLines = agentCounts ? Number(agentCounts.lines ?? -1) : -1;
        const agentMissing = agentCounts ? Number(agentCounts.missing ?? -1) : -1;
        const agentGrand = agentTotals ? Number(agentTotals.grand ?? -1) : -1;
        if (!agentData || agentData.bomSource !== 'argument' || agentLines !== 6 || agentMissing !== 1 || agentGrand !== 1398.64) {
          console.error('SMOKE_FAIL cost_agent', JSON.stringify({
            ok: agentCost?.ok,
            error: agentCost?.error,
            bomSource: agentData?.bomSource,
            lines: agentLines,
            missing: agentMissing,
            grand: agentGrand
          }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(
          `SMOKE_COST_AGENT_OK bomSource=${String(agentData.bomSource)} lines=${agentLines} missing=${agentMissing} grand=${agentGrand.toFixed(2)}`
        );
      } catch (error) {
        console.error('SMOKE_FAIL cost_agent_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // Agent 导出：用假桥接直接调命令，不弹系统对话框、不依赖 GUI 保存界面。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const costCase = JSON.parse(
          readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')
        ) as Record<string, unknown>;
        const exportDir = mkdtempSync(join(tmpdir(), 'automationcad-cost-export-'));
        const fakeBridge = {
          async call<T>(method: string, args: unknown): Promise<T> {
            if (method !== 'exportCostFile') return { ok: false, message: `unexpected ${method}` } as T;
            const payload = (args ?? {}) as Record<string, unknown>;
            const format = payload.format === 'pdf' ? 'pdf' : 'csv';
            const data = payload.encoding === 'base64'
              ? Buffer.from(String(payload.data ?? ''), 'base64')
              : String(payload.data ?? '');
            const planned = planExportName({
              directory: exportDir,
              format,
              fileName: payload.fileName,
              suggestedName: payload.suggestedName,
              overwrite: payload.overwrite === true,
              exists: existsSync
            });
            writeFileSync(planned.path, data);
            return {
              ok: true,
              path: planned.path,
              bytes: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
            } as T;
          }
        };
        const exportBus = createAgentCommandBus({} as PackRegistry, fakeBridge, {
          loadBuiltinPricebook: () => fixtureBook
        });
        const exported = await exportBus.execute('export_cost_report', {
          ...costCase,
          format: 'csv',
          fileName: '报价/单:2026*',
          allowSanitize: true,
          pricebook: fixtureBook,
          now: '2026-10-23T12:00:00+08:00'
        });
        const exportData = exported.ok && exported.data && typeof exported.data === 'object'
          ? exported.data as Record<string, unknown>
          : null;
        const exportPath = typeof exportData?.path === 'string' ? exportData.path : '';
        const exportBytes = Number(exportData?.bytes ?? 0);
        const exportName = exportPath ? basename(exportPath) : '';
        if (!exportData || exportBytes <= 0 || !exportName.endsWith('.csv') ||
            /[\\/:*?"<>|]/.test(exportName) || exportData.format !== 'csv' ||
            exportData.sanitized !== true ||
            Number(exportData.lines ?? -1) !== 6 || Math.abs(Number(exportData.grand ?? -1) - 1398.64) > 0.001) {
          console.error('SMOKE_FAIL cost_agent_export', JSON.stringify({ exported, exportName, exportBytes }));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=${exportBytes} name=sanitized`);
      } catch (error) {
        console.error('SMOKE_FAIL cost_agent_export_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        // 成本估算面板：内置价格簿 IPC → 打开面板 → 载入价格簿 → 计算 → 渲染 → 导出 PDF。
        const fixtureDir = resolve(desktopRoot(), 'test', 'fixtures');
        const fixtureBook = JSON.parse(readFileSync(join(fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
        const caseInput = JSON.parse(readFileSync(join(fixtureDir, 'cost-case.json'), 'utf8')) as unknown;
        const costUi = await window.webContents.executeJavaScript(
          `(async () => {
            const api = window.__CostPanel;
            const entry = document.getElementById('costEntryButton');
            if (!api || !entry) return { error: '成本估算面板缺失' };
            const defaultBook = await window.desktop.cost.pricebook();
            entry.click();
            const drawer = document.getElementById('costDrawer');
            const opened = Boolean(drawer && !drawer.hidden);
            const set = api.setPricebook(${JSON.stringify(fixtureBook)});
            const report = await api.run(${JSON.stringify(caseInput)});
            const rows = document.querySelectorAll('#costTable tbody tr').length;
            const cards = document.querySelectorAll('#costSummary .acp-check-card').length;
            const status = api.status();
            const html = api.html();
            const csv = api.csv();
            const pdf = await api.exportPdf();
            const book = api.pricebook();
            api.close();
            return {
              opened,
              rows,
              cards,
              status,
              missing: report ? report.missing.length : -1,
              grand: report ? report.totals.grand : -1,
              usable: set.usable,
              bookLabel: book ? book.label : '',
              defaultBookOk: defaultBook.ok === true,
              defaultExamples: defaultBook.exampleItems ?? -1,
              htmlSize: html.length,
              hasSections: html.includes('机台成本报告') && html.includes('总价构成') &&
                html.includes('硬件明细') && html.includes('缺价清单'),
              csvHasDetail: csv.includes('PART-QF') && csv.includes('合计,1398.64') && csv.includes('缺价'),
              pdfPath: pdf.path
            };
          })()`
        ) as {
          error?: string; opened: boolean; rows: number; cards: number; status: string;
          missing: number; grand: number; usable: number; bookLabel: string;
          defaultBookOk: boolean; defaultExamples: number; htmlSize: number;
          hasSections: boolean; csvHasDetail: boolean; pdfPath: string;
        };
        if (costUi.error || !costUi.opened || costUi.rows !== 6 || costUi.cards !== 9 ||
            costUi.missing !== 1 || Math.abs(costUi.grand - 1398.64) > 0.001 || costUi.usable !== 6 ||
            !costUi.status.includes('成本：合计 ¥1,398.64') ||
            !costUi.defaultBookOk || costUi.defaultExamples !== 4 ||
            !costUi.hasSections || costUi.htmlSize < 2000 || !costUi.csvHasDetail ||
            !costUi.pdfPath || !costUi.pdfPath.endsWith('report.pdf')) {
          console.error('SMOKE_FAIL cost_ui', JSON.stringify(costUi));
          setTimeout(() => app.exit(1), 100);
          return;
        }
        console.log(`SMOKE_COST_UI_OK rows=${costUi.rows} cards=${costUi.cards} grand=${costUi.grand.toFixed(2)} book=${costUi.usable} pdf=1`);
      } catch (error) {
        console.error('SMOKE_FAIL cost_ui_exception', error);
        setTimeout(() => app.exit(1), 100);
        return;
      }
      try {
        await runParametricSmoke(window);
      } catch (error) {
        console.error('SMOKE_FAIL parametric_sidecar', error);
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
    port: HEADLESS ? 0 : 7420
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

  parametric = new ParametricManager({
    appRoot: resolve(desktopRoot(), '..'),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });

  const registry = registerIpcHandlers({
    builtinDir: builtinPacksDir(),
    userDir: userPacksDir(),
    stateFile: join(app.getPath('userData'), 'packs-state.json'),
    factoryConfigFile: join(app.getPath('userData'), 'factory.json'),
    plcConfigFile: join(app.getPath('userData'), 'plc.json'),
    syncConfigFile: join(app.getPath('userData'), 'sync.json'),
    version: app.getVersion(),
    getAgentInfo: publicAgentInfo,
    getParametric: () => parametric
  });

  mainWindow = createWindow();
  mainWindow.on('closed', () => { mainWindow = null; });

  commandBus = createAgentCommandBus(registry, new RendererBridge(() => mainWindow), {
    loadBuiltinPricebook: readBuiltinPricebookRaw,
    renderCostPdf: renderCostReportPdf,
    renderReportPdf: renderAssemblyReportPdf,
    exportsRoot: join(app.getPath('userData'), 'exports'),
    userDataRoot: app.getPath('userData')
  });
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

let quitAfterParametricStop = false;
app.on('before-quit', (event) => {
  if (agentServer) void agentServer.stop();
  if (!parametric || parametric.status().status === 'stopped') return;
  if (quitAfterParametricStop) return;
  event.preventDefault();
  quitAfterParametricStop = true;
  const manager = parametric;
  parametric = null;
  void manager.stop().finally(() => app.quit());
});
