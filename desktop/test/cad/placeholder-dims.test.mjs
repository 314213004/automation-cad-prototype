import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACEHOLDER_FALLBACK_MM, resolvePlaceholderDims } from '../../src/cad/placeholder-dims.ts';

test('三轴齐全：按真实外形，sized=true', () => {
  assert.deepEqual(resolvePlaceholderDims({ w: 20, h: 50, d: 30 }), { dims: { w: 20, h: 50, d: 30 }, sized: true });
});

test('没有 dims：退回 20mm 方块，sized=false', () => {
  assert.deepEqual(resolvePlaceholderDims(undefined), {
    dims: { w: PLACEHOLDER_FALLBACK_MM, h: PLACEHOLDER_FALLBACK_MM, d: PLACEHOLDER_FALLBACK_MM },
    sized: false
  });
});

test('缺一轴：只补那一轴，sized=false', () => {
  assert.deepEqual(resolvePlaceholderDims({ w: 120, h: 60 }), { dims: { w: 120, h: 60, d: 20 }, sized: false });
});

test('非法值（0/负数/NaN/超 20m）逐轴回落，不整体放弃', () => {
  assert.deepEqual(resolvePlaceholderDims({ w: 0, h: -5, d: Number.NaN }), {
    dims: { w: 20, h: 20, d: 20 },
    sized: false
  });
  assert.deepEqual(resolvePlaceholderDims({ w: 30_000, h: 40, d: 50 }), { dims: { w: 20, h: 40, d: 50 }, sized: false });
});

test('边界值：上限内最大外形可用', () => {
  assert.deepEqual(resolvePlaceholderDims({ w: 20_000, h: 1, d: 1 }).dims, { w: 20_000, h: 1, d: 1 });
});
