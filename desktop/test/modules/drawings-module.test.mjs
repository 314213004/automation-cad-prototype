import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MODULE_REGISTRY, createModuleManager, resolveModuleStates } from '../../src/modules/registry.ts';

const memoryStorage = () => {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('drawings.techdraw 注册为可选模块：依赖参数化，默认启用，说明写清 FreeCAD 可选与数据保留', () => {
  const module = MODULE_REGISTRY.find((item) => item.id === 'drawings.techdraw');
  assert.ok(module);
  assert.equal(module.kind, 'optional');
  assert.equal(module.version, '1.0.0');
  assert.equal(module.defaultEnabled, true);
  assert.deepEqual(module.apiCompatibility, { min: 1, max: 1 });
  assert.deepEqual(module.dependencies, ['core', 'cad.parametric-import']);
  assert.deepEqual(module.requiredCapabilities, ['drawings.freecad.runner', 'drawings.techdraw.part', 'drawings.staleness']);
  assert.match(module.description, /FreeCAD 未安装时只禁用出图/);
  assert.match(module.description, /已生成的图纸与清单保留/);
  assert.match(module.description, /LGPL/);
  const state = resolveModuleStates().find((item) => item.id === 'drawings.techdraw');
  assert.equal(state.status, 'enabled');
});

test('drawings.techdraw：参数化模块关闭时不可用且不能单独启用；重开参数化后恢复', () => {
  const manager = createModuleManager(memoryStorage());
  manager.setEnabled('cad.parametric-import', false);
  const blocked = manager.getStatus('drawings.techdraw');
  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.reason, /参数化/);
  assert.throws(() => manager.setEnabled('drawings.techdraw', true));
  manager.setEnabled('cad.parametric-import', true);
  assert.equal(manager.getStatus('drawings.techdraw').enabled, true);
  manager.setEnabled('drawings.techdraw', false);
  assert.equal(manager.getStatus('drawings.techdraw').status, 'disabled');
  assert.equal(manager.getStatus('cad.parametric-import').enabled, true, '关闭工程图不影响建模');
});

test('drawings.techdraw：缺少运行时能力时 fail-closed', () => {
  const states = resolveModuleStates({ capabilities: ['workspace.project-storage', 'workspace.extension-host', 'cad.parametric.feature-tree', 'cad.parametric.sidecar-build', 'cad.parametric.export'] });
  const state = states.find((item) => item.id === 'drawings.techdraw');
  assert.equal(state.status, 'unavailable');
  assert.match(state.reason, /drawings\.freecad\.runner/);
});

test('打包配置登记 FreeCAD 作业脚本（extraResources → resources/freecad/techdraw_job.py）', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
  assert.ok(pkg.build.extraResources.some((entry) => entry.from === '../spike/freecad/techdraw_job.py' && entry.to === 'freecad/techdraw_job.py'));
});
