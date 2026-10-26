import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_REGISTRY, createModuleManager } from '../../src/modules/registry.ts';

test('整机布局 3D 编辑注册为默认启用的可选模块，可关闭与重开', () => {
  const definition = MODULE_REGISTRY.find((module) => module.id === 'design.layout-editor');
  assert.ok(definition);
  assert.equal(definition.kind, 'optional');
  assert.equal(definition.defaultEnabled, true);
  assert.deepEqual(definition.dependencies, ['core']);
  assert.deepEqual(definition.requiredCapabilities, ['design.layout-editor.viewport']);
  assert.match(definition.description, /stationGeometryLayout/);
  const data = new Map();
  const manager = createModuleManager({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  assert.equal(manager.getStatus('design.layout-editor').enabled, true);
  manager.setEnabled('design.layout-editor', false);
  assert.equal(manager.getStatus('design.layout-editor').status, 'disabled');
  manager.setEnabled('design.layout-editor', true);
  assert.equal(manager.getStatus('design.layout-editor').enabled, true);
});
