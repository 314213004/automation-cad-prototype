import { type BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoMachineConfig } from '../src/commission/machine-config';

const SHOT_WIDTH = 1600;
const SHOT_HEIGHT = 1000;

export interface ProductScreenshotOptions {
  outputDir: string;
  fixtureDir: string;
}

interface SetupResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

interface ShotDefinition {
  name: string;
  label: string;
  setup: () => Promise<SetupResult>;
  assert: (result: SetupResult) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForExtension(window: BrowserWindow): Promise<void> {
  const ready = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      if (window.__AUTOMATION_CAD_EXTENSION_READY__ === true) return resolve(true);
      const timer = setInterval(() => {
        if (window.__AUTOMATION_CAD_EXTENSION_READY__ === true) {
          clearInterval(timer);
          resolve(true);
        }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(false); }, 10000);
    })`
  ) as boolean;
  if (!ready) throw new Error('桌面扩展未在 10 秒内就绪');
}

async function settle(window: BrowserWindow, extraMs = 180): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      setTimeout(resolve, ${Math.max(0, Math.round(extraMs))})
    )))`
  );
}

function plcConfig(sequencePrefix: string): unknown {
  const demo = demoMachineConfig();
  const cylindersByStation = new Map(
    demo.actuators
      .filter((actuator) => actuator.kind === 'cylinder')
      .map((actuator) => [actuator.station, actuator.id])
  );
  return {
    ...demo,
    safety: { emergencyStop: 'X100', safetyDoor: 'X101' },
    sensors: demo.sensors.map((sensor) => {
      const cylinder = cylindersByStation.get(sensor.station);
      return sensor.part === sensor.station && cylinder ? { ...sensor, part: cylinder } : sensor;
    }),
    sequence: [
      { id: `${sequencePrefix}-1`, name: '上料气缸伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { id: `${sequencePrefix}-2`, name: '上料夹爪夹紧', action: 'set', point: 'Y8', condition: 'X1', timeoutMs: 1000 }
    ]
  };
}

export async function captureProductScreenshots(
  window: BrowserWindow,
  options: ProductScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  await delay(250);
  await waitForExtension(window);

  const pricebook = JSON.parse(readFileSync(join(options.fixtureDir, 'pricebook.json'), 'utf8')) as unknown;
  const costCase = JSON.parse(readFileSync(join(options.fixtureDir, 'cost-case.json'), 'utf8')) as unknown;

  const shots: ShotDefinition[] = [
    {
      name: '11-plcgen.png',
      label: 'PLC 程序生成',
      setup: async () => await window.webContents.executeJavaScript(
        `(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const config = ${JSON.stringify(plcConfig('shot-plc'))};
          window.__PlcGenConfigProvider = () => config;
          window.ElecDomain?.setDomain('elec');
          await wait(100);
          const entry = document.getElementById('plcGenEntryButton');
          if (!entry) return { ok: false, message: 'PLC 程序入口缺失' };
          if (entry.hidden) return { ok: false, message: 'PLC 程序入口在电气域不可见' };
          entry.click();
          await wait(100);
          const panel = window.__PlcGenPanel;
          if (!panel) return { ok: false, message: 'PLC 面板 API 缺失' };
          const pre = await panel.precheck();
          const generated = await panel.generate();
          await wait(100);
          document.querySelector('#plcFileTree [data-plc-file="README.md"]')?.click();
          await wait(120);
          const state = panel.uiState();
          return {
            ok: true,
            preErrors: pre ? pre.errors.length : -1,
            files: state.files,
            treeRows: state.treeRows,
            previewPath: state.previewPath,
            stats: state.stats,
            open: state.open,
            issueCount: document.getElementById('plcIssueCount')?.textContent || '',
            previewLines: (document.getElementById('plcPreviewBody')?.textContent || '').split('\\n').length
          };
        })()`
      ) as Promise<SetupResult>,
      assert: (result) => {
        if (result.preErrors !== 0 || result.files !== 11 || Number(result.treeRows) < 12 ||
            result.previewPath !== 'README.md' || result.open !== true ||
            !String(result.stats).includes('11 个文件')) {
          throw new Error(`PLC 面板内容不完整：${JSON.stringify(result)}`);
        }
      }
    },
    {
      name: '12-parametric.png',
      label: '参数化特征树',
      setup: async () => await window.webContents.executeJavaScript(
        `(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          window.__PlcGenPanel?.close();
          await wait(80);
          const entry = document.getElementById('cadEntryButton');
          const toggle = document.querySelector('[data-cad-action="parametric"]');
          const ui = window.AutomationCadParametric;
          if (!entry || !toggle || !ui) return { ok: false, message: '参数化入口缺失' };
          entry.click();
          await wait(140);
          toggle.click();
          let state = ui.state();
          const deadline = Date.now() + 8000;
          while (state.status !== 'ready' && state.status !== 'unavailable' && state.status !== 'crashed') {
            if (Date.now() > deadline) break;
            await wait(80);
            state = ui.state();
          }
          if (state.status !== 'ready') return { ok: false, message: '参数化内核未就绪：' + state.status };
          const auto = document.querySelector('[data-param-auto]');
          if (auto) {
            auto.checked = false;
            auto.dispatchEvent(new Event('change', { bubbles: true }));
          }
          ui.setSource('demo-bracket.step');
          ui.setDoc({
            schemaVersion: 2,
            updatedAt: '2026-10-23T12:00:00+08:00',
            instances: [
              {
                id: 'p1', name: '安装底板', partId: 'BASE-01',
                transform: { x: 0, y: 0, z: 0, rz: 0 },
                features: [
                  { id: 'f1', type: 'box', name: '底板', params: { length: 160, width: 100, height: 10 } },
                  { id: 'f2', type: 'holes', name: '安装孔', params: { diameter: 6, depth: 'through', positions: [[-60, -35], [60, -35], [-60, 35], [60, 35]] } },
                  { id: 'f3', type: 'slot', name: '腰形槽', params: { length: 50, width: 18 } },
                  { id: 'f4', type: 'fillet', name: '四角圆角', params: { radius: 3, edges: '|Z' } }
                ]
              }
            ]
          });
          const built = await ui.build();
          if (!built.ok) return { ok: false, message: built.message || '重建失败' };
          await wait(120);
          document.querySelector('[data-param-select="f2"]')?.click();
          await wait(100);
          const body = document.querySelector('.cad-param-body');
          if (body) body.scrollTop = 70;
          await wait(60);
          const drawer = document.getElementById('cadParametricDrawer');
          const final = ui.state();
          return {
            ok: true,
            drawerOpen: Boolean(drawer && !drawer.hidden),
            features: final.features,
            rows: document.querySelectorAll('[data-param-feature]').length,
            formFields: document.querySelectorAll('[data-param-form] [data-param-field]').length,
            holeRows: document.querySelectorAll('[data-param-hole]').length,
            buildStatus: document.querySelector('[data-param-build-status]')?.textContent || '',
            statusLabel: final.statusLabel
          };
        })()`
      ) as Promise<SetupResult>,
      assert: (result) => {
        if (result.drawerOpen !== true || result.features !== 4 || result.rows !== 4 ||
            Number(result.formFields) < 2 || result.holeRows !== 4 ||
            result.statusLabel !== '就绪' ||
            !String(result.buildStatus).includes('面 19') ||
            !String(result.buildStatus).includes('体积 71.5 cm³')) {
          throw new Error(`参数化抽屉内容不完整：${JSON.stringify(result)}`);
        }
      }
    },
    {
      name: '13-cost.png',
      label: '成本估算面板',
      setup: async () => await window.webContents.executeJavaScript(
        `(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          window.__PlcGenPanel?.close();
          window.AutomationCadParametric?.close();
          window.AutomationCadViewer?.close();
          await wait(120);
          const api = window.__CostPanel;
          if (!api) return { ok: false, message: '成本面板 API 缺失' };
          api.open();
          await wait(80);
          const book = api.setPricebook(${JSON.stringify(pricebook)});
          const report = await api.run(${JSON.stringify(costCase)});
          if (!report) return { ok: false, message: '成本计算未返回结果' };
          const body = document.querySelector('#costDrawer .acp-drawer-body');
          if (body) body.scrollTop = 0;
          await wait(120);
          return {
            ok: true,
            opened: !document.getElementById('costDrawer')?.hidden,
            rows: document.querySelectorAll('#costTable tbody tr').length,
            cards: document.querySelectorAll('#costSummary .acp-check-card').length,
            missing: report.missing.length,
            grand: report.totals.grand,
            usable: book.usable,
            status: document.getElementById('costStatus')?.textContent || '',
            source: document.getElementById('costSource')?.textContent || ''
          };
        })()`
      ) as Promise<SetupResult>,
      assert: (result) => {
        if (result.opened !== true || result.rows !== 6 || result.cards !== 9 ||
            result.missing !== 1 || Math.abs(Number(result.grand) - 1398.64) > 0.001 ||
            result.usable !== 6 || !String(result.status).includes('¥1,398.64')) {
          throw new Error(`成本面板内容不完整：${JSON.stringify(result)}`);
        }
      }
    },
    {
      name: '14-enclosure.png',
      label: '底板布置画布',
      setup: async () => await window.webContents.executeJavaScript(
        `(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          window.__CostPanel?.close();
          window.ElecDomain?.setDomain('elec');
          await wait(100);
          const api = window.__Enclosure;
          if (!api) return { ok: false, message: '底板布置 API 缺失' };
          api.open();
          await wait(180);
          api.clear();
          const first = await api.add('iC65N-C16-1P', 120, 180);
          const second = await api.add('iC65N-C16-1P', 126, 180);
          const third = await api.add('iC65N-C32-3P', 240, 400);
          await wait(200);
          const state = api.state();
          return {
            ok: true,
            added: Boolean(first && second && third),
            opened: !document.getElementById('enclosureOverlay')?.hidden,
            placed: state?.placed || 0,
            overlap: state?.overlap || 0,
            ratio: state?.ratio || 0,
            status: document.getElementById('encStatus')?.textContent || '',
            collisionNodes: document.querySelectorAll('.enc-part[data-collision="1"]').length
          };
        })()`
      ) as Promise<SetupResult>,
      assert: (result) => {
        if (result.opened !== true || !result.added || result.placed !== 3 || result.overlap !== 1 ||
            !(Number(result.ratio) > 0) || !String(result.status).includes('已放置') ||
            Number(result.collisionNodes) < 2) {
          throw new Error(`底板画布内容不完整：${JSON.stringify(result)}`);
        }
      }
    }
  ];

  let captured = 0;
  let failed = 0;
  for (const shot of shots) {
    try {
      const result = await shot.setup();
      if (!result.ok) throw new Error(result.message || '界面未就绪');
      shot.assert(result);
      await window.webContents.executeJavaScript(
        `document.getElementById('cadNotice')?.classList.remove('is-on');
         document.getElementById('acpToast')?.classList.remove('is-on'); true`
      );
      await settle(window);
      const image = await window.webContents.capturePage();
      const { width, height } = image.getSize();
      if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
        throw new Error(`截图尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
      }
      const png = image.toPNG();
      const target = join(options.outputDir, shot.name);
      writeFileSync(target, png);
      const bytes = statSync(target).size;
      if (bytes < 10_000) throw new Error(`截图疑似空白：${bytes} 字节`);
      console.log(`SMOKE_SHOT_OK name=${shot.name} label=${shot.label} size=${width}x${height} bytes=${bytes}`);
      captured += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`SMOKE_SHOT_FAIL name=${shot.name} label=${shot.label} error=${message}`);
    }
  }

  console.log(`SMOKE_SHOTS_DONE captured=${captured} failed=${failed} size=${SHOT_WIDTH}x${SHOT_HEIGHT}`);
  return { captured, failed };
}
