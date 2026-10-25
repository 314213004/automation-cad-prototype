import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_DOWNGRADE_PART_THRESHOLD,
  DRAG_PIXEL_RATIO,
  RENDER_QUALITY_CAPS,
  effectivePixelRatio,
  normalizeRenderQuality,
  resolveEffectiveQuality,
  shouldAutoDowngrade
} from '../../src/orbit/quality.ts';

test('拖动像素比固定 0.8，与设备 dpr 和用户档位无关', () => {
  assert.equal(DRAG_PIXEL_RATIO, 0.8);
  for (const quality of ['flow', 'standard', 'high']) {
    for (const dpr of [1, 1.5, 2, 3]) {
      assert.equal(effectivePixelRatio(dpr, quality, true), 0.8);
    }
  }
});

test('静止像素比按档位封顶：flow ≤ 1、standard ≤ 1.5、high ≤ 2', () => {
  assert.deepEqual(RENDER_QUALITY_CAPS, { flow: 1, standard: 1.5, high: 2 });
  assert.equal(effectivePixelRatio(3, 'flow', false), 1);
  assert.equal(effectivePixelRatio(3, 'standard', false), 1.5);
  assert.equal(effectivePixelRatio(3, 'high', false), 2);
  assert.equal(effectivePixelRatio(1.25, 'standard', false), 1.25);
});

test('非法 dpr / 档位安全回落', () => {
  assert.equal(effectivePixelRatio(0, 'standard', false), 1);
  assert.equal(effectivePixelRatio(Number.NaN, 'standard', false), 1);
  assert.equal(effectivePixelRatio(2, 'ultra', false), 1.5);
  assert.equal(normalizeRenderQuality('unknown'), 'standard');
});

test('大装配体阈值：> 1500 自动降 flow 并标记原因', () => {
  assert.equal(AUTO_DOWNGRADE_PART_THRESHOLD, 1500);
  assert.equal(shouldAutoDowngrade(1500), false);
  assert.equal(shouldAutoDowngrade(1501), true);
  assert.deepEqual(resolveEffectiveQuality('high', 1501), { quality: 'flow', autoDowngraded: true });
  assert.deepEqual(resolveEffectiveQuality('high', 1500), { quality: 'high', autoDowngraded: false });
  assert.deepEqual(resolveEffectiveQuality('standard', 3), { quality: 'standard', autoDowngraded: false });
});

