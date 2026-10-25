import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, reevaluateCandidateCycle, flowModelForDesign } from '../../src/design/candidates.ts';
import { evaluateFlow } from '../../src/machine/flow.ts';
import { completeDesign } from '../../src/design/synthesis.ts';
import { AgentTools } from '../../src/agent/tools.ts';

const brief = { process: 'screw', stations: 3, cyclePerMin: 10, layout: 'auto', processes: ['锁螺丝'], actuators: [], sensors: [], brand: null, voltage: '380VAC', notes: [] };
test('同一 brief 生成三个互不相同形态', () => {
  const candidates = generateCandidates(brief);
  assert.equal(candidates.length, 3);
  assert.equal(new Set(candidates.map((design) => design.form.id)).size, 3);
  console.log(`DESIGN_SAMPLE ${candidates.map((design) => `${design.form.id}:${design.cycle.partsPerMinute}`).join(' ')}`);
});
test('每个候选 partsPerMinute 与 flow 公式一致且 ops 只在本工位范围', () => {
  for (const design of generateCandidates(brief)) {
    const model = flowModelForDesign(design);
    assert.equal(design.cycle.partsPerMinute, Math.round(evaluateFlow(model).throughputPerMin * 100) / 100);
    for (const op of model.ops) assert.ok(op.station >= 0 && op.station < model.stations);
    assert.equal(reevaluateCandidateCycle(design).throughputPerMin, evaluateFlow(model).throughputPerMin);
  }
});
test('检测工艺不可用的六工位转盘按适配形态补位', () => {
  const candidates = generateCandidates({ ...brief, process: 'inspection', processes: ['检测'] });
  assert.equal(new Set(candidates.map((design) => design.form.id)).size, 3);
  assert.ok(candidates.every((design) => design.form.id !== 'dial-6'));
});
test('completeDesign 与 Agent design_machine 对同一 brief 一致', async () => {
  const parts = [{ id: 'SV660PS5R5I', packId: 'iec-cn', model: 'SV660', category: '伺服', specs: {}, price: 100 }];
  const registry = { listParts: () => parts };
  const tools = new AgentTools(registry);
  const result = await tools.call('design_machine', { brief: '三工位锁螺丝机，10 件/分钟' });
  const { parseMachineBrief } = await import('../../src/machine/spec.ts');
  const expected = completeDesign(parseMachineBrief('三工位锁螺丝机，10 件/分钟'), parts);
  const { points: _points, ...publicDesign } = expected;
  assert.deepEqual(result.design, publicDesign);
});
