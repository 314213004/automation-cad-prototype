// 六工位锁螺丝机全流程截图。使用本地 OpenAI 兼容桩驱动真实智能体会话，
// 所有画面均由 Electron 渲染后 capturePage 捕获，不使用静态设计稿。
import { nativeImage, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/** 同 waitFor，但超时返回 false 而不是抛错——需要在超时时自己诊断的步骤用这个。 */
async function waitForSoft(
  window: BrowserWindow,
  expression: string,
  timeoutMs = 20_000
): Promise<boolean> {
  return await window.webContents.executeJavaScript(
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

/**
 * xvfb + SwiftShader 下 `webContents.capturePage()` 会一直返回第一帧（实测 15/16/17/18
 * 字节完全相同），但 CDP 的 Page.captureScreenshot 是重新合成后再取，能拿到当前画面。
 */
/**
 * 抓图说明（2026-10-27 审计）：
 * xvfb + SwiftShader 下 capturePage / CDP Page.captureScreenshot 都返回同一张首帧
 * （实测 15/16/17/18 字节完全相同），desktopCapturer 在无窗口管理器的 xvfb 里又没有窗口源。
 * 因此这里保留最简单的 capturePage，由调用方用 sha256 去重——重复即报错，
 * 不再产出「四张不同面板」的假截图。真正的修法是换通道（外部 CDP 连可见窗口，已在本机验证可拿到不同帧）。
 */
/**
 * 抓图通道（2026-10-27 审计后改）：
 * xvfb + SwiftShader 下 `capturePage()` 与 CDP `Page.captureScreenshot` 都返回同一张首帧
 * （实测 15/16/17/18 字节完全相同），`desktopCapturer` 在无窗口管理器的 xvfb 里又没有窗口源。
 * 改成：主进程把窗口的屏幕矩形发给旁路 HTTP 服务（由 capture-machine-screenshots.mjs 提供），
 * 那边用 `ffmpeg -f x11grab` 直接抓 X 服务器像素——绕过渲染进程的帧冻结。
 */
async function grabPng(window: BrowserWindow): Promise<Buffer> {
  const shotUrl = process.env.AUTOMATIONCAD_SHOT_URL;
  if (shotUrl) {
    try {
      const bounds = window.getContentBounds();
      const response = await fetch(shotUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 旁路没响应时必须自己放弃，否则 Electron 会一直等下去、CI 步骤挂死
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          name: pendingShotName,
          display: process.env.DISPLAY,
          // xvfb-run 给子进程发的是临时 Xauthority，外部抓屏进程必须用同一份，否则 Authorization required
          xauthority: process.env.XAUTHORITY ?? '',
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
      });
      if (response.ok) {
        const result = (await response.json()) as { ok?: boolean; path?: string };
        if (result.ok && result.path) return readFileSync(result.path);
      } else {
        console.warn('[machine-screenshots] X11 抓屏失败', response.status, await response.text());
      }
    } catch (error) {
      console.warn('[machine-screenshots] X11 抓屏异常，回退 capturePage', error);
    }
  }
  const image = await window.webContents.capturePage();
  return image.toPNG();
}

/** X11 抓屏需要把文件名带过去，用模块级变量传递（capture 里已串行调用）。 */
let pendingShotName = '';

async function capture(
  window: BrowserWindow,
  outputDir: string,
  name: string,
  label: string,
  seenHashes: Map<string, string>
): Promise<MachineShotValidation> {
  await window.webContents.executeJavaScript(
    `document.getElementById('cadNotice')?.classList.remove('is-on');
     document.getElementById('acpToast')?.classList.remove('is-on'); true`
  );
  await settle(window);
  // xvfb + SwiftShader 下窗口可能被判为被遮挡，合成器不产新帧，capturePage 会重复返回同一张。
  // 先确保窗口可见并主动作废一帧，再等两个 rAF，最后才抓图。
  if (!window.isVisible()) window.showInactive();
  window.webContents.invalidate();
  await settle(window, 320);
  pendingShotName = name;
  const png = await grabPng(window);
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
    throw new Error(`${name} 尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
  }
  // 四张图必须真的是四个画面：字节级重复说明抓到的是同一帧（合成器没刷新），
  // 这种「看起来成功」的截图比失败更糟，直接报错。
  const hash = createHash('sha256').update(png).digest('hex');
  const duplicateOf = seenHashes.get(hash);
  if (duplicateOf) {
    throw new Error(`${name} 与 ${duplicateOf} 字节完全相同，抓到的是同一帧（画面没刷新）`);
  }
  seenHashes.set(hash, name);
  const target = join(outputDir, name);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= 20 * 1024) throw new Error(`${name} 仅 ${bytes} 字节，疑似空白`);
  const uniqueColors = uniqueColorCount(nativeImage.createFromBuffer(png).toBitmap());
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
  window.webContents.setBackgroundThrottling(false);
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
  const seenHashes = new Map<string, string>();
  try {
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // 启动后停在首页；不先离开首页，后面所有操作都在首页底下进行，
        // 抓到的四张图就都是首页（这正是之前「四张图字节相同」的真正原因）。
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) {
          document.querySelector('.home-link')?.click();
          await wait(600);
        }
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
    const expectedStats = ['6', '12', '7', '20', '31.75', '2.18', '3.7', '6A/3P', '79%'];
    if (JSON.stringify(cardState.stats) !== JSON.stringify(expectedStats)) {
      throw new Error(`方案卡统计不符合预期：${JSON.stringify(cardState.stats)}`);
    }
    if (!cardState.hasButton || !cardState.drawerOpen) throw new Error('方案卡应用按钮或侧栏缺失');
    if (!(cardState.warnings ?? []).some((text) => text.includes('安全光栅'))) {
      throw new Error(`方案卡缺少安全光栅选型/安全距离提示：${JSON.stringify(cardState.warnings)}`);
    }
    if (!(cardState.warnings ?? []).some((text) => text.includes('断路器'))) {
      throw new Error(`方案卡缺少断路器交叉校验警告：${JSON.stringify(cardState.warnings)}`);
    }
    if (!(cardState.warnings ?? []).some((text) => text.includes('缺价'))) {
      throw new Error(`方案卡缺少成本缺价警告：${JSON.stringify(cardState.warnings)}`);
    }
    shots.push(await capture(window, options.outputDir, '15-machine-design-card.png', '机型方案卡', seenHashes));

    // 写操作确认现在是页面卡片：截图脚本无人值守，必须在点「应用」前装自动确认
    // （只点「允许一次」，不写死 remember；计数回读写进日志，免得看不出到底弹没弹）
    await window.webContents.executeJavaScript(
      `(() => {
        if (window.__machineShotAutoConfirm) return true;
        const state = { count: 0 };
        window.__machineShotAutoConfirm = state;
        const accept = () => {
          const button = document.querySelector('#acwConfirmMask [data-acw="once"]');
          if (button) { button.click(); state.count += 1; }
        };
        new MutationObserver(accept).observe(document.body, { childList: true, subtree: true });
        accept();
        return true;
      })()`
    );
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const button = document.querySelector('.acp-machine-card [data-apply-machine]');
        if (!button) throw new Error('应用按钮缺失');
        button.click();
        return true;
      })()`
    );
    const applied = await waitForSoft(
      window,
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        return pill && (pill.textContent || '').includes('已应用');
      })()`,
      30_000
    );
    if (!applied) {
      // 超时不能只说"等待超时"：把卡片状态/反馈/确认次数都打出来，否则没法判断卡在哪一步
      const diagnosis = await window.webContents.executeJavaScript(
        `(() => {
          const pill = document.querySelector('.acp-machine-card .acp-pill');
          return {
            pill: pill ? pill.textContent : '(无 pill)',
            pillOk: Boolean(document.querySelector('.acp-machine-card .acp-pill.is-ok')),
            feedback: (document.querySelector('#agentChatFeedback')?.textContent || '').slice(0, 200),
            confirmMask: Boolean(document.getElementById('acwConfirmMask')),
            confirms: window.__machineShotAutoConfirm?.count ?? 0,
            buttonDisabled: document.querySelector('.acp-machine-card [data-apply-machine]')?.disabled ?? null
          };
        })()`
      );
      throw new Error(`机型方案应用完成超时：${JSON.stringify(diagnosis)}`);
    }
    const applyState = await window.webContents.executeJavaScript(
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        const feedback = document.querySelector('#agentChatFeedback')?.textContent || '';
        return { applied: pill?.textContent || '', feedback };
      })()`
    ) as { applied: string; feedback: string };
    const confirmCount = await window.webContents.executeJavaScript(
      `(() => window.__machineShotAutoConfirm?.count ?? 0)()`
    ) as number;
    console.log(`MACHINE_APPLY_OK ${applyState.applied} feedback=${applyState.feedback} confirms=${confirmCount}`);

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
    shots.push(await capture(window, options.outputDir, '16-machine-3d.png', '6 工位 3D 联调', seenHashes));

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
    shots.push(await capture(window, options.outputDir, '17-machine-bom.png', 'BOM 真实型号', seenHashes));

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
    shots.push(await capture(window, options.outputDir, '18-machine-iomap.png', 'PLC IO 点位', seenHashes));

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
    } catch (error) {
      // 失败报告是辅助信息，不覆盖原始错误。
      console.warn(`[MACHINE_SCREENSHOT_FAILURE_REPORT]`, { site: 'desktop/electron/machine-screenshots.ts:398' }, error);
    }
    return { captured: shots.length, failed: 1 };
  }
}
