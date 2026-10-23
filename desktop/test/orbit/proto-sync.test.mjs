import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boreFromEllipseRx, pushCandidate, snapValue, strokeFromRodPath } from '../../src/orbit/proto-sync.ts';
import { effectiveBore } from '../../src/orbit/model.ts';

test('反算公式：rx → 缸径，杆路径 → 行程；非法路径返回 null', () => {
  const r = 4 + 40 * 0.32;
  assert.ok(Math.abs(boreFromEllipseRx(r * 1.2247) - 40) < 1e-9);
  // y0 − y1 = 10 + 75·0.12 = 19
  assert.ok(Math.abs(strokeFromRodPath('M51.2,20.0 L51.2,1.0 A5.0,2.9 0 0 1 60,1Z') - 75) < 1e-9);
  assert.equal(strokeFromRodPath('Z'), null);
  assert.equal(strokeFromRodPath(''), null);
});

test('snapValue：容差内取最近；距离相同取较新的；容差外返回 0.1 精度近似值', () => {
  assert.deepEqual(snapValue(39.9, [32, 40, 50], 0.2), { value: 40, exact: true });
  assert.deepEqual(snapValue(41.0, [32, 40, 50], 0.2), { value: 41, exact: false });
  assert.deepEqual(snapValue(36.04, [36.1, 36.0], 0.2), { value: 36.0, exact: true });
  assert.deepEqual(snapValue(36.5, [36.25, 36.75], 0.3), { value: 36.75, exact: true });
  assert.deepEqual(snapValue(36.5, [36.75, 36.25], 0.3), { value: 36.25, exact: true });
  assert.deepEqual(snapValue(12.345, [], 0.2), { value: 12.3, exact: false });
});

test('snapValue 按原型夹紧比较：输入过 80，SVG 画 63 时仍回到 80（较新）', () => {
  assert.deepEqual(snapValue(63.02, [63, 80], 0.2, effectiveBore), { value: 80, exact: true });
  assert.deepEqual(snapValue(63.02, [80, 63], 0.2, effectiveBore), { value: 63, exact: true });
});

test('pushCandidate：去重后置、忽略空串与非数字、限制长度', () => {
  assert.deepEqual(pushCandidate([1, 2, 3], '2'), [1, 3, 2]);
  assert.deepEqual(pushCandidate([1], ''), [1]);
  assert.deepEqual(pushCandidate([1], 'abc'), [1]);
  assert.deepEqual(pushCandidate([1, 2, 3], 4, 3), [2, 3, 4]);
});
