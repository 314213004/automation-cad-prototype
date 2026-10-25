import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeRenderStats,
  isSoftwareRenderer,
  normalizeRenderStats
} from '../../src/shared/render-stats.ts';

const SAMPLE = {
  glRenderer: 'ANGLE (NVIDIA GeForce RTX 4060 Direct3D11)',
  isSoftware: false,
  pixelRatio: 1.5,
  quality: 'standard',
  partCount: 11,
  triangleCount: 4832,
  dragFrames: 4,
  dragAvgFrameMs: 42,
  dragMaxFrameMs: 58,
  lastDragAt: '2026-10-25T02:00:00.000Z'
};

test('软件渲染识别覆盖 SwiftShader / llvmpipe / Software（大小写不敏感）', () => {
  assert.equal(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'), true);
  assert.equal(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftwareRenderer('Software Rasterizer'), true);
  assert.equal(isSoftwareRenderer('NVIDIA GeForce RTX 4060'), false);
  assert.equal(isSoftwareRenderer(''), false);
});

test('IPC 指标归一化：保留合法字段、截断非法输入并强制识别软件渲染', () => {
  const normalized = normalizeRenderStats({ ...SAMPLE, isSoftware: false, glRenderer: 'SwiftShader', quality: 'high' });
  assert.equal(normalized.quality, 'high');
  assert.equal(normalized.isSoftware, true);
  assert.equal(normalized.partCount, 11);
  assert.equal(normalizeRenderStats({ ...SAMPLE, quality: 'ultra' }), null);
  assert.equal(normalizeRenderStats(null), null);
  assert.equal(normalizeRenderStats('x'), null);
  const clamped = normalizeRenderStats({ ...SAMPLE, dragFrames: -1, dragAvgFrameMs: Number.NaN, pixelRatio: 99 });
  assert.equal(clamped.dragFrames, 0);
  assert.equal(clamped.dragAvgFrameMs, 0);
  assert.equal(clamped.pixelRatio, 16);
});

test('中文结论：30 fps 以下点名不跟手，软件渲染点名已降级 flow', () => {
  assert.match(describeRenderStats(SAMPLE), /平均 42 ms\/帧.*低于 30 fps.*不跟手/);
  assert.match(describeRenderStats({ ...SAMPLE, dragAvgFrameMs: 20 }), /低于 60 fps/);
  assert.match(describeRenderStats({ ...SAMPLE, dragAvgFrameMs: 12 }), /帧率正常/);
  assert.match(describeRenderStats({ ...SAMPLE, isSoftware: true, glRenderer: 'SwiftShader' }), /软件渲染.*flow/);
  assert.match(describeRenderStats({ ...SAMPLE, dragFrames: 0 }), /尚未采集到拖动帧/);
  assert.match(describeRenderStats(null), /尚未收到渲染指标/);
});
