// 主视口 3D 的 WebGL 路径手动验证（不进 CI、不进 smoke）。
// `npm run smoke` 为稳定覆盖降级路径显式关闭了 WebGL；这里用 swiftshader 软件 GL 打开它，
// 加载原型 + 扩展（需先 `npm run build:ext`），跑交互断言，可选截图。
//
// 用法（desktop/ 目录）：
//   ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a -s "-screen 0 1700x1100x24" npx electron scripts/orbit-webgl-check.cjs
//   ORBIT_SHOTS=/tmp 同上   # 另存 orbit-assembly.png / orbit-check.png
//   无 xvfb：ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/orbit-webgl-check.cjs --ozone-platform=headless
const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const REPO = resolve(__dirname, '..', '..');
const SHOTS = process.env.ORBIT_SHOTS || '';

// 3D 几何会持久化到 localStorage：每次用临时 userData，避免上一次运行的覆盖影响断言。
app.setPath('userData', mkdtempSync(join(tmpdir(), 'orbit-webgl-check-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 无 xvfb 时可用 `--ozone-platform=headless` 跑：headless 默认屏幕 1×1，窗口内容会是 0 尺寸。
app.commandLine.appendSwitch('ozone-override-screen-size', '1700,1100');

function fail(message, detail) {
  console.error('ORBIT_WEBGL_FAIL', message, detail ? JSON.stringify(detail) : '');
  app.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1600, height: 1000,
    webPreferences: { contextIsolation: true, backgroundThrottling: false }
  });
  win.webContents.on('did-finish-load', async () => {
    try {
      const ext = pathToFileURL(join(REPO, 'desktop', 'dist', 'extension.js')).href;
      await win.webContents.executeJavaScript(`(() => { const s = document.createElement('script'); s.src = ${JSON.stringify(ext)}; document.body.appendChild(s); })()`);
      await new Promise((r) => setTimeout(r, 2500));
      const a = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const api = window.AutomationCadOrbit;
        if (!api) return { error: 'AutomationCadOrbit 缺失' };
        const out = { mode: api.state().mode };
        out.canvas = document.querySelectorAll('.orbit-canvas').length;
        out.svgHidden = getComputedStyle(document.getElementById('scene3d')).visibility === 'hidden';
        api.setView('front'); await wait(60);
        const front = api.state().views.assembly;
        out.front = front.view;
        api.setProjection('orthographic'); await wait(60);
        const ortho = api.state().views.assembly;
        api.setProjection('perspective'); await wait(60);
        const persp = api.state().views.assembly;
        out.projRoundTrip = ortho.projection === 'orthographic' && Math.abs(persp.distance - front.distance) < 1e-6;
        api.setView('iso'); await wait(60);
        api.select('rail'); await wait(60);
        const canvas = document.querySelector('#stageAssembly .orbit-canvas');
        const r = canvas.getBoundingClientRect();
        const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1 };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        await wait(80);
        out.pickedRow = document.querySelector('[data-panel="left"][data-for="assembly"] .tree-row.is-sel')?.dataset.node;
        api.select('carriage'); await wait(60);
        const geom = document.querySelector('[data-orbit-geom="carriage"]');
        out.geomFields = geom ? geom.querySelectorAll('input[data-orbit-key]').length : 0;
        const xIn = geom && geom.querySelector('input[data-orbit-key="x"]');
        if (xIn) { xIn.value = '140'; xIn.dispatchEvent(new Event('input', { bubbles: true })); }
        await wait(400);
        out.cylX = api.state().parts.find((p) => p.id === 'cyl').bbox.min[0];
        if (xIn) { xIn.value = '500'; xIn.dispatchEvent(new Event('input', { bubbles: true })); }
        await wait(400);
        out.invalid = Boolean(xIn && xIn.classList.contains('is-invalid'));
        return out;
      })()`);
      // 迭代 35 收尾：WebGL 框选（API + 真实 Shift 拖拽 + 粘滞框选模式）与 3D 编辑撤销/重做
      const m = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const api = window.AutomationCadOrbit;
        const out = {};
        api.setView('top'); await wait(80);
        const all = api.marquee({ x0: 0, y0: 0, x1: 1, y1: 1 }) || [];
        await wait(40);
        out.all = all.length;
        out.parts = api.state().parts.length;
        out.allSel = api.state().selected.length;
        out.msg = document.getElementById('stMsg')?.textContent || '';
        await wait(200);
        const canvas = document.querySelector('#stageAssembly .orbit-canvas');
        const r = canvas.getBoundingClientRect();
        const before = api.state().views.assembly.position.slice();
        const ev = (type, fx, fy, extra = {}) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, button: 0, buttons: 1, pointerId: 7, ...extra }));
        ev('pointerdown', 0.02, 0.02, { shiftKey: true });
        ev('pointermove', 0.5, 0.5, { shiftKey: true });
        out.boxShown = !document.getElementById('marquee').hidden;
        ev('pointermove', 0.98, 0.98, { shiftKey: true });
        ev('pointerup', 0.98, 0.98, { shiftKey: true });
        await wait(60);
        out.dragSel = api.state().selected.length;
        out.boxHidden = document.getElementById('marquee').hidden;
        // 自动取景会以同一标准视图重新求位姿，浮点有 1e-10 级抖动；旋转/平移会是毫米级变化。
        out.cameraKept = api.state().views.assembly.position.every((v, i) => Math.abs(v - before[i]) < 1e-6);
        await wait(200);
        // 局部框：真实拖拽与 API 计算的命中集一致，且只是部分零件
        const partial = (api.marquee({ x0: 0.40, y0: 0.40, x1: 0.47, y1: 0.47 }) || []).slice().sort().join(',');
        await wait(200);
        ev('pointerdown', 0.40, 0.40, { shiftKey: true });
        ev('pointermove', 0.47, 0.47, { shiftKey: true });
        ev('pointerup', 0.47, 0.47, { shiftKey: true });
        await wait(60);
        out.partial = partial;
        out.partialDrag = api.state().selected.slice().sort().join(',');
        await wait(200);
        api.select('rail'); await wait(40);
        out.pickReplaced = api.state().selected.join(',');
        document.querySelector('#stageAssembly [data-orbit-marquee]').click();
        out.modeOn = api.state().views.assembly.marqueeMode;
        ev('pointerdown', 0.02, 0.02);
        ev('pointermove', 0.98, 0.98);
        ev('pointerup', 0.98, 0.98);
        await wait(60);
        out.modeSel = api.state().selected.length;
        api.setMarqueeMode(false);
        await wait(200);
        // 撤销/重做：面板输入改滑台 X → Ctrl+Z 回退（输入框同步回旧值）→ Ctrl+Y 重做
        api.select('carriage'); await wait(60);
        const xIn = document.querySelector('[data-orbit-geom="carriage"] input[data-orbit-key="x"]');
        const x0 = Number(xIn.value);
        xIn.value = '110'; xIn.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
        const key = (k, extra = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
        key('z'); await wait(60);
        out.undoInput = Number(xIn.value) === x0 && api.state().parts.find((p) => p.id === 'cyl').bbox.min[0] === x0 - 20;
        key('y'); await wait(60);
        out.redoInput = Number(xIn.value) === 110;
        out.stored = JSON.parse(localStorage.getItem('automationcad.orbit.v1') || 'null')?.overrides?.carriage?.x;
        return out;
      })()`);
      const mOk = m.all === m.parts && m.allSel === m.parts && m.msg.includes(m.parts + ' 个对象') && m.boxShown &&
        m.dragSel === m.parts && m.boxHidden && m.partial !== '' &&
        m.partial.split(',').length < m.parts && m.partialDrag === m.partial && m.cameraKept && m.pickReplaced === 'rail' && m.modeOn && m.modeSel === m.parts &&
        m.undoInput && m.redoInput && m.stored === 110;
      if (!mOk) {
        fail('marquee-undo', m);
        return;
      }
      console.log(`ORBIT_WEBGL_MARQUEE_OK all=${m.all} shiftDrag=${m.dragSel} partial=${m.partial} camera=kept mode=${m.modeSel} undo=1 redo=1 stored=${m.stored}`);
      if (a.error || a.mode !== 'webgl' || a.canvas !== 2 || !a.svgHidden || a.front !== 'front' || !a.projRoundTrip ||
          a.pickedRow !== 'cyl' || a.geomFields !== 4 || a.cylX !== 120 || !a.invalid) {
        fail('assembly', a);
        return;
      }
      if (SHOTS) writeFileSync(join(SHOTS, 'orbit-assembly.png'), (await win.webContents.capturePage()).toPNG());
      const c = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('.mode[data-mode="check"]')?.click();
        await wait(200);
        Array.from(document.querySelectorAll('#stageCheck .vpbtn')).find((b) => b.title === '剖切面')?.click();
        await wait(700);
        const st = window.AutomationCadOrbit.state();
        const callout = document.getElementById('checkCallout');
        return { clip: st.views.check.clipping, hit: st.hit, hits: st.interference.length, left: callout.style.left };
      })()`);
      if (!c.clip || c.hit !== 'cyl' || c.hits < 1 || c.left === '57%') {
        fail('check', c);
        return;
      }
      if (SHOTS) writeFileSync(join(SHOTS, 'orbit-check.png'), (await win.webContents.capturePage()).toPNG());
      console.log(`ORBIT_WEBGL_OK mode=webgl canvases=${a.canvas} pick=${a.pickedRow} carriageX=140 clip=1 hits=${c.hits}`);
      app.exit(0);
    } catch (error) {
      fail('exception', { message: String(error && error.message || error) });
    }
  });
  await win.loadFile(join(REPO, 'index.html'));
});
