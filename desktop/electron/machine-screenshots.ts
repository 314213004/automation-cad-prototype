// 六工位锁螺丝机全流程截图。使用本地 OpenAI 兼容桩驱动真实智能体会话，
// 所有画面均由 Electron 渲染后 capturePage 捕获，不使用静态设计稿。
import { type BrowserWindow } from 'electron';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SHOT_WIDTH = 1600;
const SHOT_HEIGHT = 1000;
const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

export interface MachineScreenshotOptions {
  outputDir: string;
}

export interface MachineShotValidation {
  name: string;
  label: string;
  width: number;
  height: number;
  bytes: number;
  uniqueColors: number;
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
      setTimeout(() => { clearInterval(timer); resolve(false); }, 15000);
    })`
  ) as boolean;
  if (!ready) throw new Error('桌面扩展未在 15 秒内就绪');
}

async function waitFor(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = 20_000
): Promise<void> {
  const ok = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        let value = false;
        try { value = Boolean(${expression}); } catch { value = false; }
        if (value) return resolve(true);
        if (Date.now() - started > ${timeoutMs}) return resolve(false);
        setTimeout(check, 120);
      };
      check();
    })`
  ) as boolean;
  if (!ok) throw new Error(`等待超时：${label}`);
}

async function settle(window: BrowserWindow, extraMs = 220): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      setTimeout(resolve, ${Math.max(0, Math.round(extraMs))})
    )))`
  );
}

function uniqueColorCount(bitmap: Buffer): number {
  const seen = new Set<number>();
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const key = (bitmap[index]! << 16) | (bitmap[index + 1]! << 8) | bitmap[index + 2]!;
    seen.add(key);
    if (seen.size > 20_000) break;
  }
  return seen.size;
}

async function capture(
  window: BrowserWindow,
  outputDir: string,
  name: string,
  label: string
): Promise<MachineShotValidation> {
  await window.webContents.executeJavaScript(
    `document.getElementById('cadNotice')?.classList.remove('is-on');
     document.getElementById('acpToast')?.classList.remove('is-on'); true`
  );
  await settle(window);
  const image = await window.webContents.capturePage();
  const { width, height } = image.getSize();
  if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
    throw new Error(`${name} 尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
  }
  const png = image.toPNG();
  const target = join(outputDir, name);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= 20 * 1024) throw new Error(`${name} 仅 ${bytes} 字节，疑似空白`);
  const uniqueColors = uniqueColorCount(image.toBitmap());
  if (uniqueColors <= 500) throw new Error(`${name} 唯一色数 ${uniqueColors}，疑似单色/空白`);
  console.log(`MACHINE_SHOT_OK name=${name} label=${label} size=${width}x${height} bytes=${bytes} colors=${uniqueColors}`);
  return { label, name, width, height, bytes, uniqueColors };
}

export async function captureMachineScreenshots(
  window: BrowserWindow,
  options: MachineScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  const evalDir = process.env.AUTOMATIONCAD_EVAL_DIR
    ? resolve(process.env.AUTOMATIONCAD_EVAL_DIR)
    : resolve(options.outputDir, '..', 'eval');
  mkdirSync(evalDir, { recursive: true });
  const baseUrl = process.env.AUTOMATIONCAD_STUB_BASE_URL;
  if (!baseUrl) throw new Error('缺少 AUTOMATIONCAD_STUB_BASE_URL，无法启动离线模型桩');

  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  await delay(350);
  await waitForExtension(window);

  await window.webContents.executeJavaScript(
    `(async () => {
      const result = await window.desktop.agent.saveLlmConfig({
        baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'offline-stub',
        model: 'offline-stub',
        maxIterations: 4
      });
      return result;
    })()`
  );

  const shots: MachineShotValidation[] = [];
  try {
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        document.getElementById('commissionDrawer')?.setAttribute('hidden', '');
        document.querySelector('#agentEntryButton')?.click();
        await wait(260);
        const input = document.querySelector('#agentChatInput');
        if (!input) throw new Error('智能体输入框缺失');
        input.value = ${JSON.stringify(BRIEF)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#agentChatSend')?.click();
        return true;
      })()`
    );

    try {
      await waitFor(
        window,
        `document.querySelector('.acp-machine-card') && document.querySelectorAll('.acp-machine-card .acp-machine-stats b').length >= 6`,
        '机型方案卡渲染'
      );
    } catch (error) {
      const debug = await window.webContents.executeJavaScript(
        `(() => ({
          drawerOpen: !document.getElementById('agentDrawer')?.hidden,
          status: document.getElementById('agentChatStatus')?.textContent || '',
          feedback: document.getElementById('agentChatFeedback')?.textContent || '',
          chatText: (document.getElementById('agentChatLog')?.textContent || '').slice(0, 1600),
          toolCards: document.querySelectorAll('.acp-chat-tool').length,
          cards: document.querySelectorAll('.acp-machine-card').length
        }))()`
      );
      console.error('MACHINE_CARD_DEBUG', JSON.stringify(debug));
      throw error;
    }
    await settle(window, 400);

    const cardState = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const card = document.querySelector('.acp-machine-card');
        const log = document.querySelector('#agentChatLog');
        if (!card) return { ok: false, message: '机型方案卡缺失' };
        const stats = Array.from(card.querySelectorAll('.acp-machine-stats b')).map((node) => node.textContent || '');
        const warnings = Array.from(card.querySelectorAll('.acp-machine-warning')).map((node) => node.textContent || '');
        const button = card.querySelector('[data-apply-machine]');
        if (log) {
          const cardRect = card.getBoundingClientRect();
          const logRect = log.getBoundingClientRect();
          log.scrollTop += cardRect.top - logRect.top - 8;
        }
        await wait(120);
        return {
          ok: true,
          stats,
          warnings,
          hasButton: Boolean(button),
          drawerOpen: !document.getElementById('agentDrawer')?.hidden,
          feedback: document.querySelector('#agentChatFeedback')?.textContent || ''
        };
      })()`
    ) as {
      ok: boolean;
      message?: string;
      stats?: string[];
      warnings?: string[];
      hasButton?: boolean;
      drawerOpen?: boolean;
      feedback?: string;
    };
    if (!cardState.ok) throw new Error(cardState.message ?? '机型方案卡状态异常');
    const expectedStats = ['6', '12', '7', '20', '3.18', '4628'];
    if (JSON.stringify(cardState.stats) !== JSON.stringify(expectedStats)) {
      throw new Error(`方案卡统计不符合预期：${JSON.stringify(cardState.stats)}`);
    }
    if (!cardState.hasButton || !cardState.drawerOpen) throw new Error('方案卡应用按钮或侧栏缺失');
    if (!(cardState.warnings ?? []).some((text) => text.includes('节拍瓶颈'))) {
      throw new Error(`方案卡缺少节拍瓶颈警告：${JSON.stringify(cardState.warnings)}`);
    }
    if (!(cardState.warnings ?? []).some((text) => text.includes('安全光栅'))) {
      throw new Error(`方案卡缺少安全光栅选型/安全距离提示：${JSON.stringify(cardState.warnings)}`);
    }
    shots.push(await capture(window, options.outputDir, '15-machine-design-card.png', '机型方案卡'));

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const button = document.querySelector('.acp-machine-card [data-apply-machine]');
        if (!button) throw new Error('应用按钮缺失');
        button.click();
        return true;
      })()`
    );
    await waitFor(
      window,
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        return pill && (pill.textContent || '').includes('已应用');
      })()`,
      '机型方案应用完成',
      30_000
    );
    const applyState = await window.webContents.executeJavaScript(
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        const feedback = document.querySelector('#agentChatFeedback')?.textContent || '';
        return { applied: pill?.textContent || '', feedback };
      })()`
    ) as { applied: string; feedback: string };
    console.log(`MACHINE_APPLY_OK ${applyState.applied} feedback=${applyState.feedback}`);

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        window.AutomationCadViewer?.close();
        document.querySelector('#commissionEntryButton')?.click();
        await wait(500);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(() => {
        const stats = window.__Commission3D?.stats?.();
        return stats && stats.stations === 6 && stats.actuators === 12 && stats.sensors === 7 && stats.webgl === true;
      })()`,
      '6 工位 3D 场景就绪'
    );
    await waitFor(window, `(window.__Commission3D?.stats?.().ticks || 0) > 0`, '3D 帧循环');
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const config = window.AutomationCadCommission.getMachineConfig();
        const on = {};
        for (const actuator of config.actuators) {
          if (actuator.point) on[actuator.point] = true;
          if (actuator.gripPoint) on[actuator.gripPoint] = true;
        }
        for (const sensor of config.sensors) on[sensor.point] = true;
        window.__Commission3D.update(on);
        for (let index = 0; index < 14; index += 1) {
          await wait(90);
          window.__Commission3D.update(index % 2 === 0 ? on : { ...on, ...Object.fromEntries(Object.keys(on).map((key) => [key, false])) });
        }
        const body = document.querySelector('#commissionDrawer .acp-drawer-body');
        if (body) body.scrollTop = 0;
        await wait(450);
        return window.__Commission3D.stats();
      })()`
    );
    const sceneStats = await window.webContents.executeJavaScript(
      `window.__Commission3D.stats()`
    ) as { stations: number; actuators: number; sensors: number; ticks: number; webgl: boolean };
    if (sceneStats.stations !== 6 || sceneStats.actuators !== 12 || sceneStats.ticks <= 0) {
      throw new Error(`3D 场景状态异常：${JSON.stringify(sceneStats)}`);
    }
    console.log(`MACHINE_3D_OK stations=${sceneStats.stations} actuators=${sceneStats.actuators} sensors=${sceneStats.sensors} ticks=${sceneStats.ticks}`);
    shots.push(await capture(window, options.outputDir, '16-machine-3d.png', '6 工位 3D 联调'));

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#commissionDrawer [data-acp-close]')?.click();
        window.AutomationCadKinematics?.close();
        document.querySelector('#cadEntryButton')?.click();
        await wait(350);
        window.AutomationCadKinematics?.close();
        document.querySelector('[data-cad-side="bom"]')?.click();
        await wait(260);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(document.querySelectorAll('#cadBomRows tbody tr').length || 0) >= 12`,
      'BOM 面板真实型号行'
    );
    const bomState = await window.webContents.executeJavaScript(
      `(() => {
        const text = document.getElementById('cadBomRows')?.textContent || '';
        return {
          rows: document.querySelectorAll('#cadBomRows tbody tr').length,
          hasSvt: text.includes('SV660P 750 W'),
          hasGripper: text.includes('MHZ2-20D'),
          hasSensor: text.includes('D-M9B'),
          hasValve: text.includes('SY5120-5LZD'),
          hasCurtain: text.includes('F3SG-4SRA0640-14'),
          hasPending: text.includes('待选型'),
          paneOpen: !document.getElementById('cadBomPane')?.hidden
        };
      })()`
    ) as Record<string, unknown>;
    if (bomState.rows !== 12 || !bomState.hasSvt || !bomState.hasGripper || !bomState.hasSensor ||
        !bomState.hasValve || !bomState.hasCurtain || bomState.hasPending || !bomState.paneOpen) {
      throw new Error(`BOM 面板内容不完整：${JSON.stringify(bomState)}`);
    }
    shots.push(await capture(window, options.outputDir, '17-machine-bom.png', 'BOM 真实型号'));

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('[data-cad-side="io"]')?.click();
        await wait(300);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(document.querySelectorAll('#cadIoRows tbody tr').length || 0) >= 19`,
      'PLC IO 点位行'
    );
    const ioState = await window.webContents.executeJavaScript(
      `(() => {
        const text = document.getElementById('cadIoRows')?.textContent || '';
        return {
          rows: document.querySelectorAll('#cadIoRows tbody tr').length,
          hasRotary: text.includes('ST1-ROT-A2'),
          hasGripper: text.includes('ST1-GRIP-A1'),
          hasProximity: text.includes('ST1-PRX-S1'),
          hasSafety: text.includes('ST1-SAFE-S2'),
          meta: document.getElementById('cadIoMeta')?.textContent || '',
          paneOpen: !document.getElementById('cadIoPane')?.hidden
        };
      })()`
    ) as Record<string, unknown>;
    if (ioState.rows !== 19 || !ioState.hasRotary || !ioState.hasGripper ||
        !ioState.hasProximity || !ioState.hasSafety || !ioState.paneOpen) {
      throw new Error(`IO 点位面板不完整：${JSON.stringify(ioState)}`);
    }
    console.log(`MACHINE_IOMAP_OK rows=${ioState.rows} meta=${String(ioState.meta)}`);
    shots.push(await capture(window, options.outputDir, '18-machine-iomap.png', 'PLC IO 点位'));

    const validationFile = join(evalDir, 'machine-screenshots.json');
    writeFileSync(validationFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'machine-screenshots',
      size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
      minBytes: 20 * 1024,
      minUniqueColors: 500,
      shots
    }, null, 2)}\n`, 'utf8');
    console.log(`MACHINE_SHOTS_DONE captured=${shots.length} failed=0 validation=${validationFile}`);
    return { captured: shots.length, failed: 0 };
  } catch (error) {
    console.error('MACHINE_SHOTS_FAIL', error);
    try {
      const validationFile = join(evalDir, 'machine-screenshots.json');
      writeFileSync(validationFile, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'machine-screenshots',
        size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
        shots,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`, 'utf8');
    } catch {
      // 失败报告是辅助信息，不覆盖原始错误。
    }
    return { captured: shots.length, failed: 1 };
  }
}
