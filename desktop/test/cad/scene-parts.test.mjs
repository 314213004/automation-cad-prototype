import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CadViewer } from '../../src/cad/viewer.ts';

function degradedViewer(modelParts) {
  const viewer = Object.create(CadViewer.prototype);
  viewer.parts = [];
  viewer.modelParts = modelParts;
  return viewer;
}

test('降级模式：没有 three 网格时 getSceneParts 仍返回已加载零件', () => {
  const viewer = degradedViewer([
    { name: 'base', bbox: { min: [0, 0, 0], max: [10, 20, 30] } },
    { name: 'gantry', bbox: { min: [1, 2, 3], max: [4, 5, 6] } }
  ]);
  const parts = viewer.getSceneParts();
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'base');
  assert.equal(parts[0].triangles, 0);
  assert.deepEqual(parts[0].bbox, { min: [0, 0, 0], max: [10, 20, 30] });
});

test('降级模式：modelParts 为空时返回空数组，不抛错', () => {
  const viewer = degradedViewer([]);
  assert.deepEqual(viewer.getSceneParts(), []);
});

test('正常模式：有 three 网格时优先用 parts（不被 modelParts 覆盖）', () => {
  const viewer = Object.create(CadViewer.prototype);
  viewer.modelParts = [{ name: 'stale', bbox: { min: [0, 0, 0], max: [1, 1, 1] } }];
  viewer.parts = [
    {
      data: { name: 'live-part' },
      triangleCount: 12,
      bbox: { min: [0, 0, 0], max: [2, 2, 2] }
    }
  ];
  // 正常路径调用 partBounds(part) 计算包围盒；这里用真实几何的最小替身
  viewer.partBounds = (part) => part.bbox;
  const parts = viewer.getSceneParts();
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'live-part');
  assert.equal(parts[0].triangles, 12);
});
