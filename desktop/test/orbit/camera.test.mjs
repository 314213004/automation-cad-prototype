import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STANDARD_VIEWS,
  boundsCenter,
  boundsRadius,
  cross,
  dot,
  fitDistance,
  isEmptyBounds,
  emptyBounds,
  nearestStandardView,
  normalize,
  orthoFrustum,
  orthoToPerspectiveDistance,
  perspectiveToOrthoHalfHeight,
  poseAlong,
  poseForView,
  projectAxes,
  standardViewDirection,
  unionBounds
} from '../../src/orbit/camera.ts';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const BOUNDS = { min: [0, 0, 0], max: [210, 72, 129] };

test('标准视图：方向为单位向量，前/后/左/右/俯/仰/等轴测指向正确', () => {
  const expect = {
    front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
    top: [0, 0, 1], bottom: [0, 0, -1], iso: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)]
  };
  for (const view of STANDARD_VIEWS) {
    const { dir, up } = standardViewDirection(view);
    near(Math.hypot(...dir), 1);
    assert.deepEqual(up, [0, 0, 1]);
    expect[view].forEach((v, i) => near(dir[i], v, 1e-3));
  }
});

test('俯视/仰视不与 Z-up 共线（避免 OrbitControls 退化），屏幕上方为 +Y', () => {
  for (const view of ['top', 'bottom']) {
    const { dir, up } = standardViewDirection(view);
    assert.ok(Math.hypot(...cross(dir, up)) > 0, `${view} 与 up 共线`);
  }
  // 俯视：相机在 +Z 略偏 -Y，向前 = -dir；屏幕上方 = up 在视平面上的投影 ≈ +Y
  const { dir } = standardViewDirection('top');
  const forward = dir.map((v) => -v);
  const right = normalize(cross(forward, [0, 0, 1]));
  const screenUp = cross(right, forward);
  assert.ok(screenUp[1] > 0.99, `屏幕上方应为 +Y，实际 ${screenUp}`);
  near(right[0], 1, 1e-6);
});

test('前视：X 向右、Z 向上、Y 指向屏幕里（不在屏幕平面）', () => {
  const axes = projectAxes([1, 0, 0], [0, 0, 1]);
  assert.deepEqual(axes.x, [1, -0]);
  assert.deepEqual(axes.z, [0, -1]);
  near(Math.hypot(...axes.y), 0);
});

test('fitDistance：包围球恰好贴合较窄方向的半视角（含边距）', () => {
  const r = 100, fov = 40;
  const wide = fitDistance(r, fov, 2, 1);
  near(wide * Math.sin((fov * Math.PI) / 360), r, 1e-9);
  const narrow = fitDistance(r, fov, 0.5, 1);
  const halfH = Math.atan(Math.tan((fov * Math.PI) / 360) * 0.5);
  near(narrow * Math.sin(halfH), r, 1e-9);
  assert.ok(narrow > wide, '竖窗需要更远');
  near(fitDistance(r, fov, 2, 1.15), wide * 1.15, 1e-9);
  assert.equal(fitDistance(0, fov, 1), 1);
  assert.throws(() => fitDistance(10, 0, 1), /视角/);
});

test('poseForView：目标为包围盒中心，相机沿视图方向，距离 = fitDistance', () => {
  const pose = poseForView('iso', BOUNDS, 40, 1.6);
  assert.deepEqual(pose.target, boundsCenter(BOUNDS));
  const d = fitDistance(boundsRadius(BOUNDS), 40, 1.6);
  near(pose.distance, d);
  const offset = pose.position.map((v, i) => v - pose.target[i]);
  near(Math.hypot(...offset), d, 1e-6);
  const dir = normalize(offset);
  near(dot(dir, standardViewDirection('iso').dir), 1, 1e-12);
  const front = poseForView('front', BOUNDS, 40, 1.6);
  near(front.position[0], front.target[0]);
  assert.ok(front.position[1] < BOUNDS.min[1], '前视相机应在 -Y 侧');
});

test('poseAlong 保持当前视线方向重新取景；空包围盒退回原点', () => {
  const pose = poseAlong([3, 4, 0], [0, 0, 1], BOUNDS, 40, 1);
  const dir = normalize(pose.position.map((v, i) => v - pose.target[i]));
  near(dir[0], 0.6); near(dir[1], 0.8); near(dir[2], 0);
  const empty = poseAlong([1, 0, 0], [0, 0, 1], emptyBounds(), 40, 1);
  assert.deepEqual(empty.target, [0, 0, 0]);
  assert.ok(empty.distance > 0);
});

test('透视 ↔ 正交切换：可见高度一致，往返距离不变', () => {
  const half = perspectiveToOrthoHalfHeight(500, 40);
  near(half, 500 * Math.tan((20 * Math.PI) / 180));
  near(orthoToPerspectiveDistance(half, 1, 40), 500, 1e-9);
  near(orthoToPerspectiveDistance(half, 2, 40), 250, 1e-9);
  near(orthoToPerspectiveDistance(half, 0, 40), 500, 1e-9);
});

test('orthoFrustum：横窗按高、竖窗按宽装下包围球', () => {
  const wide = orthoFrustum(100, 2, 1);
  assert.deepEqual([wide.top, wide.right], [100, 200]);
  const tall = orthoFrustum(100, 0.5, 1);
  assert.deepEqual([tall.right, tall.top], [100, 200]);
});

test('包围盒并集、中心、半径与空判定', () => {
  const u = unionBounds([{ min: [0, 0, 0], max: [10, 10, 10] }, { min: [-5, 2, 3], max: [4, 20, 6] }]);
  assert.deepEqual(u, { min: [-5, 0, 0], max: [10, 20, 10] });
  assert.equal(isEmptyBounds(emptyBounds()), true);
  assert.equal(isEmptyBounds(u), false);
  near(boundsRadius({ min: [0, 0, 0], max: [2, 2, 1] }), 1.5);
});

test('nearestStandardView：识别标准方向，自由视角返回 null；零向量抛错', () => {
  assert.equal(nearestStandardView([0, -5, 0]), 'front');
  assert.equal(nearestStandardView([2, -2, 2]), 'iso');
  assert.equal(nearestStandardView([0, 0, 9]), 'top');
  assert.equal(nearestStandardView([1, -0.3, 0.2]), null);
  assert.throws(() => normalize([0, 0, 0]), /零向量/);
});
