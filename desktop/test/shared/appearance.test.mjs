import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  DEFAULT_APPEARANCE_CONFIG,
  appearanceConfigPath,
  mergeAppearanceConfig,
  normalizeAppearanceConfig,
  normalizeUiScale,
  readAppearanceConfig,
  writeAppearanceConfig
} from '../../src/shared/appearance.ts';
import { normalizeRenderQuality } from '../../src/orbit/quality.ts';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-appearance-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('界面缩放默认 1.15、渲染质量默认 standard', () => {
  assert.deepEqual(readAppearanceConfig(sandbox), DEFAULT_APPEARANCE_CONFIG);
  assert.deepEqual(DEFAULT_APPEARANCE_CONFIG, { uiScale: 1.15, renderQuality: 'standard' });
});

test('界面缩放只接受六个档位，非法值回落 1.15', () => {
  for (const value of [1, 1.1, 1.15, 1.25, 1.4, 1.5]) assert.equal(normalizeUiScale(value), value);
  for (const value of [0.9, 1.2, 2, '1.25', null, undefined, Number.NaN]) assert.equal(normalizeUiScale(value), 1.15);
});

test('渲染质量解析：合法三档，未知值回落 standard', () => {
  assert.equal(normalizeRenderQuality('flow'), 'flow');
  assert.equal(normalizeRenderQuality('standard'), 'standard');
  assert.equal(normalizeRenderQuality('high'), 'high');
  assert.equal(normalizeRenderQuality('ultra'), 'standard');
  assert.equal(normalizeRenderQuality(2), 'standard');
});

test('外观配置持久化往返、原子落盘且权限为 600', { skip: process.platform === 'win32' }, () => {
  const written = writeAppearanceConfig(sandbox, { uiScale: 1.25, renderQuality: 'high' });
  assert.deepEqual(written, { uiScale: 1.25, renderQuality: 'high' });
  assert.deepEqual(readAppearanceConfig(sandbox), written);
  const file = appearanceConfigPath(sandbox);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), written);
});

test('部分更新保留未提交字段，越界字段回落默认值', () => {
  assert.deepEqual(
    mergeAppearanceConfig({ uiScale: 1.4, renderQuality: 'high' }, { uiScale: 1.5 }),
    { uiScale: 1.5, renderQuality: 'high' }
  );
  assert.deepEqual(
    normalizeAppearanceConfig({ uiScale: 1.33, renderQuality: 'turbo' }),
    { uiScale: 1.15, renderQuality: 'standard' }
  );
});

