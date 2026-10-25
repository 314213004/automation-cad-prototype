import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampDesignCanvasZoom,
  designCanvasSvgDimensions,
  stepDesignCanvasZoom
} from '../../src/design/canvas-viewport.ts';

test('布局画布缩放按固定比例步进并限制在可用范围内', () => {
  assert.equal(stepDesignCanvasZoom(1, 1), 1.25);
  assert.equal(stepDesignCanvasZoom(1, -1), 0.8);
  assert.equal(stepDesignCanvasZoom(2.8, 1), 3);
  assert.equal(stepDesignCanvasZoom(0.51, -1), 0.5);
  assert.equal(clampDesignCanvasZoom(Number.NaN), 1);
});

test('缩放只改变 SVG 显示尺寸，不改变毫米画布的宽高比例', () => {
  const size = { width: 2400, height: 1200 };
  const normal = designCanvasSvgDimensions(size, 1000 / size.width, 1);
  const zoomed = designCanvasSvgDimensions(size, 1000 / size.width, 1.5);
  assert.deepEqual(normal, { width: 1000, height: 500 });
  assert.deepEqual(zoomed, { width: 1500, height: 750 });
  assert.equal(zoomed.width / zoomed.height, size.width / size.height);
  assert.throws(() => designCanvasSvgDimensions({ width: 0, height: 100 }, 1, 1), /正数/);
});
