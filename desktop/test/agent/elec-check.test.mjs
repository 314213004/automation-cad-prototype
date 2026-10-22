import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';

let sandbox;
let bus;
let tools;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-elec-check-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0'
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  const bridge = {
    async call(method) {
      return { ok: false, message: `不应调用渲染桥：${method}` };
    }
  };
  bus = createAgentCommandBus(registry, bridge);
  tools = new AgentTools(registry, bus);
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('run_electrical_check 命令返回线号跨网络重号等严重问题', async () => {
  const result = await bus.execute('run_electrical_check', {
    wires: [
      { no: '101', net: 'n1', potential: 'L1', from: 'QF1:2', to: 'KM1:1' },
      { no: '101', net: 'n2', potential: 'L1', from: 'KM1:2', to: 'M1:U' }
    ]
  });
  assert.equal(result.ok, true);
  assert.ok(result.data.counts.error >= 1);
  assert.ok(result.data.findings.some((item) => item.code === 'WIRE_NO_CROSS_NET'));
  assert.equal(result.data.counts.error + result.data.counts.warning + result.data.counts.info, result.data.findings.length);
});

test('run_electrical_check 命令统计功率并给出主断路器建议', async () => {
  const result = await bus.execute('run_electrical_check', {
    loads: [
      { tag: 'M1', powerKw: 2.2, phase: '3P' },
      { tag: 'M2', powerKw: 1.5, phase: 'L1' },
      { tag: 'YV1', powerKw: 0.02, phase: 'DC24' }
    ],
    options: { demandFactor: 0.8, psuRatedA: 5 }
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.totalKw, 3.72);
  assert.ok(result.data.summary.maxPhaseCurrentA > 0);
  assert.ok(result.data.summary.breakerSuggestion.ratedA > 0);
  assert.ok(result.data.summary.breakerSuggestion.cableMm2 > 0);
  assert.ok(result.data.summary.psuMarginRatio > 0);
});

test('run_electrical_check 命令校验回路截面与断路器配合', async () => {
  const result = await bus.execute('run_electrical_check', {
    circuits: [{ wireNo: '101', currentA: 30, sectionMm2: 2.5, breakerA: 32 }]
  });
  assert.equal(result.ok, true);
  const codes = result.data.findings.map((item) => item.code);
  assert.ok(codes.includes('WIRE_SECTION_UNDER'));
  assert.ok(codes.includes('BREAKER_OVERSIZE'));
});

test('run_electrical_check 命令拒绝空文档并给出中文原因', async () => {
  const result = await bus.execute('run_electrical_check', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.match(result.error.message, /至少一条 wires \/ loads \/ circuits/);
});

test('run_electrical_check 命令拒绝非法入参', async () => {
  const notArray = await bus.execute('run_electrical_check', { wires: 'L1' });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.error.code, 'INVALID_ARGUMENT');
  assert.match(notArray.error.message, /wires 必须是数组/);

  const badPhase = await bus.execute('run_electrical_check', {
    loads: [{ tag: 'M1', powerKw: 1, phase: 'L9' }]
  });
  assert.equal(badPhase.ok, false);
  assert.match(badPhase.error.message, /phase 只能是/);

  const missingPower = await bus.execute('run_electrical_check', { loads: [{ tag: 'M1' }] });
  assert.equal(missingPower.ok, false);
  assert.match(missingPower.error.message, /缺少额定功率 powerKw/);

  const missingCurrent = await bus.execute('run_electrical_check', { circuits: [{ wireNo: '101' }] });
  assert.equal(missingCurrent.ok, false);
  assert.match(missingCurrent.error.message, /缺少工作电流 currentA/);

  const badOptions = await bus.execute('run_electrical_check', { loads: [{ powerKw: 1 }], options: 3 });
  assert.equal(badOptions.ok, false);
  assert.match(badOptions.error.message, /options 必须是对象/);
});

test('Agent 工具 run_electrical_check 返回 counts/summary/findings', async () => {
  const result = await tools.call('run_electrical_check', {
    wires: [{ no: '101', net: 'n1', potential: 'L1', from: 'A', to: 'B' }],
    loads: [{ tag: 'M1', powerKw: 2.2, phase: '3P' }]
  });
  assert.equal(result.ok, true);
  assert.ok(result.counts.error >= 0);
  assert.ok(result.summary.totalKw >= 2.2);
  assert.ok(Array.isArray(result.findings));
  assert.equal(result.truncated, false);
});

test('Agent 工具 run_electrical_check 透传参数错误', async () => {
  const result = await tools.call('run_electrical_check', { wires: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
  assert.match(result.message, /wires 必须是数组/);
});

test('Agent 工具 run_electrical_check 暴露 JSON Schema 且声明必填', () => {
  const summary = tools.summaries().find((tool) => tool.name === 'run_electrical_check');
  assert.ok(summary);
  assert.match(summary.description, /电气校验/);
  assert.equal(summary.inputSchema.type, 'object');
  assert.deepEqual(summary.inputSchema.properties.circuits.items.required, ['wireNo', 'currentA']);
  assert.deepEqual(summary.inputSchema.properties.loads.items.required, ['powerKw']);
});
