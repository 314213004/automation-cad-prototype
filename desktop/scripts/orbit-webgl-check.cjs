// 主视口 3D 的 WebGL 路径手动验证（不进 CI、不进 smoke）。
// `npm run smoke` 为稳定覆盖降级路径显式关闭了 WebGL；这里用 swiftshader 软件 GL 打开它，
// 加载原型 + 扩展（需先 `npm run build:ext`），跑交互断言，可选截图。
//
// 用法（desktop/ 目录）：
//   ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a -s "-screen 0 1700x1100x24" npx electron scripts/orbit-webgl-check.cjs
//   ORBIT_SHOTS=/tmp 同上   # 另存 orbit-assembly.png / orbit-check.png
const { app, BrowserWindow } = require('electron');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const REPO = resolve(__dirname, '..', '..');
const SHOTS = process.env.ORBIT_SHOTS || '';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-gl', 'angle');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

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
