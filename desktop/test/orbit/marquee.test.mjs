import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildAssembly } from '../../src/orbit/model.ts';
import { partsInRect, projectBounds, rectFromPoints, rectsIntersect } from '../../src/orbit/marquee.ts';

const VP = { left: 100, top: 50, width: 800, height: 600 };

/** 正交俯视相机：世界 X → 屏幕右，世界 Y → 屏幕上；1 mm = 2 px，视野中心 (105, 36)。 */
function topCamera() {
  const cam = new THREE.OrthographicCamera(-200, 200, 150, -150, 0.1, 5000);
  cam.up.set(0, 1, 0);
  cam.position.set(105, 36, 1000);
  cam.lookAt(105, 36, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

const toScreen = (x, y) => [VP.left + (x - 105 + 200) * 2, VP.top + (150 - (y - 36)) * 2];

test('rectFromPoints / rectsIntersect：任意方向拖拽、相交即命中（同原型）', () => {
  assert.deepEqual(rectFromPoints(10, 20, 0, 5), { left: 0, top: 5, right: 10, bottom: 20 });
  const a = { left: 0, top: 0, right: 10, bottom: 10 };
  assert.ok(rectsIntersect(a, { left: 10, top: 10, right: 20, bottom: 20 }));
  assert.ok(rectsIntersect(a, { left: 2, top: 2, right: 3, bottom: 3 }));
  assert.ok(!rectsIntersect(a, { left: 11, top: 0, right: 20, bottom: 10 }));
});

test('projectBounds：正交俯视下包围盒投影为对应屏幕矩形；相机后方返回 null', () => {
  const cam = topCamera();
  const r = projectBounds({ min: [0, 0, 0], max: [210, 72, 8] }, cam, VP);
  const [l, b] = toScreen(0, 0);
  const [rr, t] = toScreen(210, 72);
  assert.ok(Math.abs(r.left - l) < 1e-6 && Math.abs(r.right - rr) < 1e-6);
  assert.ok(Math.abs(r.top - t) < 1e-6 && Math.abs(r.bottom - b) < 1e-6);
  const persp = new THREE.PerspectiveCamera(40, 4 / 3, 1, 5000);
  persp.position.set(0, 0, 100);
  persp.lookAt(0, 0, 0);
  assert.equal(projectBounds({ min: [-5, -5, 200], max: [5, 5, 210] }, persp, VP), null);
});

test('partsInRect：俯视框住滑台中心附近只命中重叠的零件，空白处不命中', () => {
  const asm = buildAssembly({ bore: 32, stroke: 50, inserted: [{ id: 'ins1', x: 4, y: 2, z: 8, w: 20, d: 20, h: 20 }], overrides: {} });
  const cam = topCamera();
  // 左下角插入件 (4..24, 2..22) 所在区域：只碰底板与插入件
  const [x0, y0] = toScreen(5, 5);
  const [x1, y1] = toScreen(10, 8);
  assert.deepEqual(partsInRect(asm, cam, VP, rectFromPoints(x0, y0, x1, y1)), ['base', 'ins1']);
  // 整个装配：全部命中，保持装配顺序
  const [a0, b0] = toScreen(-10, -10);
  const [a1, b1] = toScreen(220, 80);
  assert.deepEqual(partsInRect(asm, cam, VP, rectFromPoints(a0, b0, a1, b1)), asm.parts.map((p) => p.id));
  // 底板之外的空白
  const [c0, d0] = toScreen(230, 100);
  const [c1, d1] = toScreen(260, 120);
  assert.deepEqual(partsInRect(asm, cam, VP, rectFromPoints(c0, d0, c1, d1)), []);
});

test('partsInRect：开剖切时完全在剖切面之后的零件不命中', () => {
  const asm = buildAssembly({ bore: 32, stroke: 50, inserted: [{ id: 'ins9', x: 160, y: 2, z: 8, w: 20, d: 20, h: 20 }], overrides: {} });
  const cam = topCamera();
  const [x0, y0] = toScreen(165, 5);
  const [x1, y1] = toScreen(170, 8);
  assert.deepEqual(partsInRect(asm, cam, VP, rectFromPoints(x0, y0, x1, y1)), ['base', 'ins9']);
  // 剖切面 X=92：插入件 160..180 整体在后方；底板被切到 0..92，框 (165..170) 不再碰到它
  assert.deepEqual(partsInRect(asm, cam, VP, rectFromPoints(x0, y0, x1, y1), 92), []);
});
