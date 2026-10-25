import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSphereVisible } from '../../src/cad/render-plan.ts';
import { frustumPlanesFromClipElements } from '../../src/cad/render-plan.ts';

// 透视相机（fov 45、aspect 1、near 0.1、far 5000）朝 -Z 看的投影矩阵
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ];
}

const proj = perspective(45, 1, 0.1, 5000);
const planes = frustumPlanesFromClipElements(proj);

test('相机正前方 500 mm 处的球体在视锥内', () => {
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: -500 }, 50), true);
});

test('相机背后（+Z）的球体被剔除', () => {
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: 500 }, 50), false);
});

test('超出 near/far 的球体被剔除', () => {
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: -0.01 }, 0.001), false, '近平面之内');
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: -9000 }, 50), false, '远平面之外');
});

test('横向偏出视锥很远的球体被剔除，靠近边缘的仍保留', () => {
  // 500 mm 处半高 = 500 * tan(22.5°) ≈ 207 mm
  assert.equal(isSphereVisible(planes, { x: 2000, y: 0, z: -500 }, 50), false);
  assert.equal(isSphereVisible(planes, { x: 200, y: 0, z: -500 }, 50), true);
});

test('大半径球体即使球心在外，只要与视锥相交就保留', () => {
  // 500 mm 处视锥半宽约 207 mm；球心在 900 mm（在外），半径 800 仍与视锥相交
  assert.equal(isSphereVisible(planes, { x: 900, y: 0, z: -500 }, 800), true);
  assert.equal(isSphereVisible(planes, { x: 2400, y: 0, z: -500 }, 800), false, '完全够不着的仍要剔除');
});

test('平面提取不退化：法向为单位向量，6 个平面互不相同', () => {
  assert.equal(planes.length, 6);
  for (const plane of planes) {
    const length = Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z);
    assert.ok(Math.abs(length - 1) < 1e-9, `法向未归一化：${length}`);
  }
  const keys = new Set(planes.map((plane) => `${plane.normal.x.toFixed(3)},${plane.normal.y.toFixed(3)},${plane.normal.z.toFixed(3)},${plane.constant.toFixed(3)}`));
  assert.equal(keys.size, 6, '旧实现里近/左平面重复，导致误剔除');
});
