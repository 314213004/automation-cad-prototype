import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInstance, quaternionFromNormal, resetInstanceCounter, snapPosition, surfaceOffset } from '../../src/assembly/instances.ts';

const BOX = { shape: 'box', size: [100, 50, 20], diameter: null, estimated: false, source: 'test' };

function rotateByQuat(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x
  ].map((n) => Math.round(n * 1000) / 1000);
}

test('法向 → 四元数：+Z 不变、-Z 翻转、+X 让 +Z 转到 +X', () => {
  assert.deepEqual(rotateByQuat(quaternionFromNormal([0, 0, 1]), [0, 0, 1]), [0, 0, 1]);
  assert.deepEqual(rotateByQuat(quaternionFromNormal([0, 0, -1]), [0, 0, 1]), [0, 0, -1]);
  assert.deepEqual(rotateByQuat(quaternionFromNormal([1, 0, 0]), [0, 0, 1]), [1, 0, 0]);
  const slanted = rotateByQuat(quaternionFromNormal([1, 1, 1]), [0, 0, 1]);
  assert.ok(Math.abs(Math.hypot(...slanted) - 1) < 0.01);
});

test('贴合偏移：盒体按法向半投影，圆柱按轴向半长', () => {
  assert.equal(surfaceOffset(BOX, [0, 0, 1]), 10);
  assert.equal(surfaceOffset(BOX, [1, 0, 0]), 50);
  // 轴线沿 X：贴到 Z 法向的面上时，接触的是 Z 向半径 8
  assert.equal(surfaceOffset({ shape: 'cylinder', size: [300, 16, 16], diameter: 16, estimated: true, source: 't' }, [0, 0, 1]), 8);
});

test('落位点沿法向抬高，避免嵌进被贴的面', () => {
  assert.deepEqual(snapPosition({ point: [10, 20, 5], normal: [0, 0, 1] }, BOX), [10, 20, 15]);
  assert.deepEqual(snapPosition({ point: [0, 0, 0], normal: [1, 0, 0] }, BOX), [50, 0, 0]);
});

test('createInstance：地面命中标记 ground，表面命中标记 surface', () => {
  resetInstanceCounter();
  const ground = createInstance({ partId: 'P1', model: 'M', category: '导轨', vendor: 'V', dims: BOX, hit: { point: [0, 0, 0], normal: [0, 0, 1] } });
  const surface = createInstance({ partId: 'P1', model: 'M', category: '导轨', vendor: 'V', dims: BOX, hit: { point: [0, 0, 100], normal: [0, 0, 1] } });
  assert.equal(ground.snappedTo, 'ground');
  assert.equal(surface.snappedTo, 'surface');
  assert.notEqual(ground.id, surface.id);
  assert.deepEqual(surface.position, [0, 0, 110]);
});
