import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';

let sandbox;
let tools;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-tools-test-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0'
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: { 缸径: '20 mm' } }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  tools = new AgentTools(registry);
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('注册六个工具且 list_components 可用', async () => {
  assert.equal(tools.list().length, 6);
  const result = await tools.call('list_components', { category: '气缸' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.components[0].model, 'MXQ20-50.stp');
});

test('未实现工具返回结构化 NOT_IMPLEMENTED', async () => {
  const result = await tools.call('insert_component', { partId: 'MXQ20-50' });
  assert.deepEqual(result, {
    ok: false,
    code: 'NOT_IMPLEMENTED',
    message: '插入操作必须与 UI 共用事务/撤销栈，当前版本尚未接入。'
  });
});
