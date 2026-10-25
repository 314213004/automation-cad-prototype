import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimsForPart, parseMm, parseSection } from '../../src/assembly/dims.ts';

test('parseMm 从中文/单位混杂的字符串里取第一个长度', () => {
  assert.equal(parseMm('15 mm'), 15);
  assert.equal(parseMm('1000 mm（样本 ≤4000 mm 定制）'), 1000);
  assert.equal(parseMm('40×40'), 40);
  assert.equal(parseMm(5), 5);
  assert.equal(parseMm(''), null);
  assert.equal(parseMm('不适用'), null);
  assert.equal(parseMm(undefined), null);
});

test('parseSection 解析截面', () => {
  assert.deepEqual(parseSection('40×40'), [40, 40]);
  assert.deepEqual(parseSection('45 x 90'), [45, 90]);
  assert.equal(parseSection('n/a'), null);
});

test('直线导轨：轨宽定截面、样本长度直接用', () => {
  const dims = dimsForPart({
    id: 'HIWIN-HGH15CA', model: 'HGH15CA', category: '直线导轨',
    specs: { type: 'rail', railWidth: '15 mm', length: '1000 mm（样本 ≤4000 mm 定制）' }
  });
  assert.equal(dims.shape, 'box');
  assert.equal(dims.size[0], 1000, 'X = 导轨长度');
  assert.equal(dims.size[1], 15, 'Y = 轨宽');
  assert.ok(dims.size[2] < 15, 'Z = 轨高（贴合方向）');
  assert.equal(dims.estimated, false);
});

test('滚珠丝杠：定制长度不能取上限值当尺寸', () => {
  const dims = dimsForPart({
    id: 'HIWIN-R16-5-C7', model: 'R16-5-C7', category: '滚珠丝杠',
    specs: { type: 'ballscrew', nominalDiameter: '16 mm', length: '按行程定制（样本 ≤3000 mm）' }
  });
  assert.equal(dims.shape, 'cylinder');
  assert.equal(dims.diameter, 16);
  assert.equal(dims.size[0], 300, 'X = 轴向长度，应按 300 mm 占位而不是 3000');
  assert.equal(dims.estimated, true, '定制长度必须标记为估算');
});

test('气缸：缸径 + 行程 → 圆柱外长', () => {
  const dims = dimsForPart({ model: 'CDQ2B20-30DZ', category: '气缸', specs: { bore: '20 mm', stroke: '30 mm' } });
  assert.equal(dims.shape, 'cylinder');
  assert.equal(dims.diameter, 20);
  assert.ok(dims.size[0] >= 30, 'X = 轴向长度');
  assert.equal(dims.estimated, false);
});

test('减速机：机座号取型号数字', () => {
  const a = dimsForPart({ model: 'PLE60-5-S2-P1', category: '减速机', specs: { type: 'reducer' } });
  const b = dimsForPart({ model: 'AB120-10-S2-P1', category: '减速机', specs: { type: 'reducer' } });
  assert.equal(a.size[0], 60);
  assert.equal(b.size[0], 120);
});

test('铝型材：截面 × 长度', () => {
  const dims = dimsForPart({ model: 'P8-4040', category: '工业铝型材', specs: { type: 'profile', section: '40×40', length: 6000 } });
  assert.equal(dims.size[0], 1000, '样本长度 6000 太长，按 1000 展示');
  assert.deepEqual([dims.size[1], dims.size[2]], [40, 40], 'Y/Z = 截面');
  assert.equal(dims.estimated, true);
});

test('缺尺寸的品类退回占位体并明确标记估算', () => {
  const dims = dimsForPart({ model: 'X1', category: '未知品类', specs: {} });
  assert.deepEqual(dims.size, [40, 40, 40]);
  assert.equal(dims.estimated, true);
  assert.match(dims.source, /占位/);
});
