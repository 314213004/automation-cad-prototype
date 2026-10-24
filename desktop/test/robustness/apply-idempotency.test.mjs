import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { activeMachinePath, machineBomDraftPath, machineDesignPath } from '../../src/machine/store.ts';

const BRIEF = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cad-machine-idempotent-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: args?.rows?.length ?? 0 };
      if (method === 'removeMachineBomRows') return { ok: true, removed: 1 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus({ listParts: () => [] }, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: () => new Date('2026-10-24T01:00:00.000Z')
  });
  return { root, calls, bus };
}

test('幂等：同参数重复 apply 不重写方案、不重复追加 BOM', async () => {
  const { root, calls, bus } = setup();
  const first = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(first.ok, true);
  const designPath = machineDesignPath(root, first.data.machineId);
  const bomPath = machineBomDraftPath(root, first.data.machineId);
  assert.ok(existsSync(designPath));
  assert.ok(existsSync(bomPath));
  const designBefore = readFileSync(designPath, 'utf8');
  const bomBefore = readFileSync(bomPath, 'utf8');
  const appliedAtBefore = JSON.parse(designBefore).appliedAt;
  const mtimeBefore = statSync(designPath, { bigint: true }).mtimeNs;

  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(second.ok, true);
  assert.equal(second.data.idempotent, true);
  assert.equal(second.data.bom.added, 0);
  assert.equal(readFileSync(designPath, 'utf8'), designBefore);
  assert.equal(readFileSync(bomPath, 'utf8'), bomBefore);
  assert.equal(JSON.parse(readFileSync(designPath, 'utf8')).appliedAt, appliedAtBefore);
  assert.equal(statSync(designPath, { bigint: true }).mtimeNs, mtimeBefore);
  assert.equal(calls.filter((call) => call.method === 'appendMachineBomRows').length, 1);
  assert.equal(calls.filter((call) => call.method === 'removeMachineBomRows').length, 0);
});

test('幂等：重复 apply 仍刷新渲染层且返回稳定机器 id', async () => {
  const { calls, bus } = setup();
  const first = await bus.execute('apply_machine_design', { brief: BRIEF });
  const second = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(first.data.machineId, second.data.machineId);
  assert.equal(second.data.sceneRefreshed, true);
  assert.equal(calls.filter((call) => call.method === 'applyMachineConfig').length, 2);
});

test('幂等：相同 id 但参数变化不会被静默覆盖', async () => {
  const { bus } = setup();
  const first = await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(first.ok, true);
  const changed = await bus.execute('apply_machine_design', { brief: BRIEF, name: '另一台锁螺丝机' });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'FILE_EXISTS');
  assert.match(changed.error.message, /overwrite=true/);
});

test('幂等：带 BOM 关闭时重复 apply 不返回 BOM 草稿信息', async () => {
  const { bus } = setup();
  await bus.execute('apply_machine_design', { brief: BRIEF, withBom: false });
  const second = await bus.execute('apply_machine_design', { brief: BRIEF, withBom: false });
  assert.equal(second.ok, true);
  assert.equal(second.data.idempotent, true);
  assert.equal(second.data.bom, undefined);
});

test('幂等：active 指针内容在重复 apply 后保持不变', async () => {
  const { root, bus } = setup();
  await bus.execute('apply_machine_design', { brief: BRIEF });
  const before = readFileSync(activeMachinePath(root), 'utf8');
  await bus.execute('apply_machine_design', { brief: BRIEF });
  assert.equal(readFileSync(activeMachinePath(root), 'utf8'), before);
});
