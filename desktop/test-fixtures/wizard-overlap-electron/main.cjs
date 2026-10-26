const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const targetUrl = process.argv[2];
if (!targetUrl) throw new Error('Electron fixture 缺少 Vite 页面 URL');

let windowRef;
app.whenReady().then(async () => {
  windowRef = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  windowRef.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`页面加载失败 ${code} ${description}: ${url}`);
  });

  try {
    await windowRef.loadURL(targetUrl);
    await waitForRenderer();
    const results = [];

    await reset('clear');
    const layoutCopy = await evaluate(`(() => ({
      note: document.querySelector('.design-layout-semantics')?.innerText ?? '',
      metrics: document.querySelector('.design-layout-tools')?.innerText ?? ''
    }))()`);
    const geometryView = await evaluate(`(() => {
      const panel = document.querySelector('.design-geometry-plan');
      const svg = panel?.querySelector('#designGeometryTopView');
      return {
        status: panel?.dataset.geometryPlanStatus ?? '',
        count: Number(panel?.dataset.geometryPartCount ?? 0),
        drawn: svg?.querySelectorAll('[data-geometry-part-id]').length ?? 0,
        markup: svg?.outerHTML ?? '',
        note: panel?.innerText ?? '',
        placementCount: svg?.querySelectorAll('[data-placement]').length ?? -1
      };
    })()`);
    assert.match(layoutCopy.note, /矩形尺寸仅为示意卡片/);
    assert.match(layoutCopy.note, /毫米坐标只代表二维预排布/);
    assert.match(layoutCopy.note, /不代表组件实际外形、安装包络或三维几何/);
    assert.match(layoutCopy.note, /重叠矩形可能重复计入/);
    assert.match(layoutCopy.note, /不驱动 3D 预览或整机\/单件 STL/);
    assert.match(layoutCopy.metrics, /示意卡片占画布比例\s+\d+(?:\.\d+)?%/);
    assert.doesNotMatch(layoutCopy.metrics, /利用率/);
    assert.equal(geometryView.status, 'ready');
    assert.ok(geometryView.count > 0 && geometryView.drawn === geometryView.count, '俯视 SVG 应逐个绘制当前几何零件的毫米 AABB');
    assert.equal(geometryView.placementCount, 0, '几何投影 SVG 不得包含可编辑 placements');
    assert.match(geometryView.note, /概念估算占位体/);
    assert.match(geometryView.markup, /不含手工 placements/);
    results.push('当前几何毫米 AABB 俯视视图与示意 placements 分离');
    results.push('向导布局明确标注示意卡片、二维预排布与重叠重复计入');
    await click('[data-action="next"]');
    await waitForStep('5');
    assert.equal(await currentStep(), '5', '无冲突布局应从 step4 前进到 step5');
    results.push('无冲突布局可直接进入 step5');

    await reset('identity-warning');
    await click('[data-action="next"]');
    await waitForStep('5');
    const reviewNotice = await evaluate(`(() => ({
      text: document.querySelector('#designWizard')?.innerText ?? '',
      notice: document.querySelector('#designWizard .design-notice[role="status"]')?.innerText ?? ''
    }))()`);
    assert.match(reviewNotice.notice, /旧版工位偏移已安全清除/);
    assert.match(reviewNotice.text, /第 4 步的二维 placements 不驱动 3D\/STL/);
    assert.match(reviewNotice.text, /真实工位 X\/Y 偏移会进入保存工程与 STL/);
    results.push('第 5 步续做仍显示工位偏移告警，准确区分 placements 与真实几何 STL');

    await reset('overlap');
    const geometryAfterPlacementEdit = await evaluate(`document.querySelector('#designGeometryTopView')?.outerHTML ?? ''`);
    assert.equal(geometryAfterPlacementEdit, geometryView.markup, '仅改变手工二维 placements 不得改变几何投影');
    const conflicts = await evaluate(`(() => {
      const list = document.querySelector('.design-layout-conflicts');
      return {
        text: list?.innerText ?? '',
        rows: [...(list?.querySelectorAll('li') ?? [])].map((item) => item.innerText),
        checked: document.querySelector('[data-layout-overlap-confirmation]')?.checked ?? null
      };
    })()`);
    assert.equal(conflicts.rows.length, 1, '应展示一条重叠对象对');
    assert.match(conflicts.text, /测试工位 1/);
    assert.match(conflicts.text, /测试工位 2/);
    assert.equal(conflicts.checked, false, '新布局不能预先勾选确认');
    await click('[data-action="next"]');
    await waitForNotification(/重叠冲突/);
    assert.equal(await currentStep(), '4', '未确认重叠时 next 必须阻断在 step4');
    assert.equal(await evaluate(`document.querySelector('[data-layout-overlap-confirmation]')?.checked`), false);
    results.push('冲突对象可见且未确认时被阻断');

    await reset('overlap');
    await setCheckbox(true);
    await click('[data-action="next"]');
    await waitForStep('5');
    assert.equal(await currentStep(), '5', '确认当前重叠后应可进入 step5');
    results.push('主动确认当前重叠后可进入 step5');

    await reset('overlap');
    await setCheckbox(true);
    await changeCoordinate('x', 5);
    assert.equal(await evaluate(`document.querySelector('[data-layout-overlap-confirmation]')?.checked`), false,
      '坐标修改后旧确认应失效');
    assert.match(await evaluate(`document.querySelector('.design-layout-confirm-state')?.innerText ?? ''`), /重新确认|勾选确认/);
    await click('[data-action="next"]');
    await waitForNotification(/重叠冲突/);
    assert.equal(await currentStep(), '4', '仍重叠但快照已改变时应再次阻断');
    results.push('坐标变更使旧确认失效并再次阻断');

    await reset('out-of-bounds');
    const bounds = await evaluate(`(() => ({
      hasCheckbox: Boolean(document.querySelector('[data-layout-overlap-confirmation]')),
      blocked: document.querySelector('.design-layout-blocked[role="alert"]')?.innerText ?? '',
      alert: document.querySelector('.design-errors[role="alert"]')?.innerText ?? ''
    }))()`);
    assert.equal(bounds.hasCheckbox, false, '越界布局应缺少确认控件（或不可操作）');
    assert.match(bounds.blocked, /越界时不能确认或继续/);
    await click('[data-action="next"]');
    await waitForNotification(/越界为硬阻断/);
    assert.equal(await currentStep(), '4', '越界布局 next 必须被硬阻断');
    results.push('越界时确认控件缺失且 next 被硬阻断');

    await reset('clear');
    const original = await storedDraft();
    const originalPlacement = original.placements[0];
    assert.ok(original.design && original.candidates?.length === 3 && originalPlacement,
      '需求更改测试需有旧主方案、候选和布局');
    for (const step of ['3', '2', '1']) {
      await click('[data-action="prev"]');
      await waitForStep(step);
    }
    await changeBriefInput('cyclePerMin', '24');
    await waitUntil(async () => (await storedDraft())?.pendingBrief?.cyclePerMin === 24);
    const staleView = await evaluate(`(() => ({
      visible: !document.querySelector('[data-brief-stale]')?.hidden,
      summary: document.querySelector('[data-brief-stale-summary]')?.innerText ?? '',
      replaceVisible: !document.querySelector('[data-action="recompute-brief"]')?.hidden
    }))()`);
    assert.equal(staleView.visible, true, '需求与旧方案不一致时应清楚提示');
    assert.equal(staleView.replaceVisible, true, '应提供显式重算入口');
    assert.match(staleView.summary, /二维布局将清空/);
    await click('[data-action="next"]');
    await waitForNotification(/不一致/);
    let staged = await storedDraft();
    assert.equal(await currentStep(), '1', '未确认新需求时 next 不得默默重算');
    assert.equal(staged?.brief.cyclePerMin, original.brief.cyclePerMin);
    assert.equal(staged?.pendingBrief?.cyclePerMin, 24);
    assert.equal(staged?.design?.form.id, original.design.form.id);
    assert.deepEqual(staged?.placements, original.placements, '编辑需求不得清空旧二维布局');

    await evaluate(`window.__wizardConfirmCalls = []; window.confirm = (message) => { window.__wizardConfirmCalls.push(message); return false; }; true;`);
    await click('[data-action="recompute-brief"]');
    await waitUntil(async () => evaluate(`(window.__wizardConfirmCalls ?? []).length === 1`));
    const cancelledPrompt = await evaluate(`window.__wizardConfirmCalls[0]`);
    assert.match(cancelledPrompt, /当前主方案/);
    assert.match(cancelledPrompt, /1 项二维布局将清空/);
    assert.match(cancelledPrompt, /新候选方案/);
    staged = await storedDraft();
    assert.equal(staged?.pendingBrief?.cyclePerMin, 24);
    assert.equal(staged?.design?.form.id, original.design.form.id);
    assert.deepEqual(staged?.placements, original.placements, '取消确认必须原样保留旧布局');

    await click('[data-action="close"]');
    await waitUntil(async () => evaluate(`document.querySelector('#designWizard')?.hidden === true`));
    await evaluate('window.__reopenWizard()');
    await waitForStep('1');
    assert.equal(await evaluate(`document.querySelector('#designBriefForm [name="cyclePerMin"]')?.value`), '24',
      '重开后恢复自动保存的需求输入');
    staged = await storedDraft();
    assert.equal(staged?.pendingBrief?.cyclePerMin, 24);
    assert.equal(staged?.design?.form.id, original.design.form.id);
    assert.deepEqual(staged?.placements, original.placements, '重开后旧方案和布局仍在');

    await click('[data-action="restore-brief"]');
    await waitUntil(async () => (await storedDraft())?.pendingBrief === undefined);
    assert.equal(await evaluate(`document.querySelector('#designBriefForm [name="cyclePerMin"]')?.value`),
      String(original.brief.cyclePerMin), '撤销需求编辑应恢复原值');
    assert.deepEqual((await storedDraft())?.placements, original.placements);

    await changeBriefInput('cyclePerMin', '24');
    await waitUntil(async () => (await storedDraft())?.pendingBrief?.cyclePerMin === 24);
    await evaluate(`window.confirm = (message) => { window.__wizardConfirmCalls.push(message); return true; }; true;`);
    await click('[data-action="recompute-brief"]');
    await waitForStep('2');
    const replaced = await storedDraft();
    assert.equal(replaced?.brief.cyclePerMin, 24, '确认后应将新需求应用到方案');
    assert.equal(replaced?.pendingBrief, undefined);
    assert.ok(replaced?.design && replaced.design.cycle.perMin === 24,
      '确认后应生成并选中绑定新目标产能的主方案');
    assert.notDeepEqual(replaced?.candidates, original.candidates, '确认后候选方案应按新需求重算');
    assert.deepEqual(replaced?.placements, [], '只有确认替换后才清空旧二维布局');
    assert.match(await evaluate(`window.__wizardConfirmCalls.at(-1)`), /1 项二维布局将清空/);
    results.push('需求编辑仅暂存；取消/重开保留旧方案布局，确认重算后才替换并清空布局');

    console.log(`DOM_REGRESSION_RESULT ${JSON.stringify({ passed: results.length, results })}`);
    app.exit(0);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    try {
      console.error('renderer diagnostics:', await evaluate(`({
        step: document.querySelector('.design-steps li.active')?.dataset.step,
        notices: window.__wizardTestNotices,
        body: document.body.innerText.slice(0, 2500)
      })`));
    } catch { /* 页面尚未完成加载时没有 renderer 诊断可取。 */ }
    app.exit(1);
  }
});

async function evaluate(source) {
  if (!windowRef || windowRef.isDestroyed()) throw new Error('Electron 窗口已关闭');
  return windowRef.webContents.executeJavaScript(source, true);
}

async function waitForRenderer() {
  await waitUntil(async () => evaluate('Boolean(window.__wizardFixtureReady)'));
}

async function reset(mode) {
  await evaluate(`window.__resetWizard(${JSON.stringify(mode)})`);
  await waitForStep('4');
}

async function click(selector) {
  const found = await evaluate(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!control) return false;
    control.click();
    return true;
  })()`);
  assert.equal(found, true, `找不到 DOM 控件：${selector}`);
}

async function setCheckbox(checked) {
  const found = await evaluate(`(() => {
    const input = document.querySelector('[data-layout-overlap-confirmation]');
    if (!input) return false;
    input.checked = ${JSON.stringify(checked)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(found, true, '应存在重叠确认 checkbox');
  await waitUntil(async () => evaluate(`document.querySelector('[data-layout-overlap-confirmation]')?.checked === ${JSON.stringify(checked)}`));
}

async function changeCoordinate(axis, value) {
  const found = await evaluate(`(() => {
    const input = document.querySelector('[data-placement-coordinate="${axis}"]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(found, true, `应存在 ${axis} 坐标输入框`);
  await waitUntil(async () => evaluate(`document.querySelector('[data-placement-coordinate="${axis}"]')?.value === ${JSON.stringify(String(value))}`));
}

async function changeBriefInput(name, value) {
  const found = await evaluate(`(() => {
    const input = document.querySelector('#designBriefForm [name=${JSON.stringify(name)}]');
    if (!input) return false;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(found, true, `应存在需求字段 ${name}`);
}

async function storedDraft() {
  const value = await evaluate('JSON.stringify(window.__wizardStoredDraft?.() ?? null)');
  return value === 'null' ? null : JSON.parse(value);
}

async function currentStep() {
  return evaluate(`document.querySelector('.design-steps li.active')?.dataset.step ?? null`);
}

async function waitForStep(step) {
  await waitUntil(async () => (await currentStep()) === step);
}

async function waitForNotification(pattern) {
  await waitUntil(async () => evaluate(`(window.__wizardTestNotices ?? []).some((item) => ${pattern.toString()}.test(item.message))`));
}

async function waitUntil(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('等待 Electron DOM 状态超时');
}
