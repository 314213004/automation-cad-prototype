import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCandidates, reevaluateCandidateCycle, flowModelForDesign, withReviewedCycle } from '../../src/design/candidates.ts';
import { evaluateFlow } from '../../src/machine/flow.ts';
import { completeDesign } from '../../src/design/synthesis.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { assessStationCycles } from '../../src/design/station-cycle.ts';

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

test('工程师行程/分度角与运动预览 durationMs 不参与模型节拍估算', () => {
  const design = generateCandidates(brief)[0];
  const withPreviewMotion = {
    ...design,
    config: {
      ...design.config,
      actuators: [
        { id: 'ACT-CYL', name: '直线气缸', kind: 'cylinder', station: design.config.stations[0], travelMm: 40, durationMs: 300 },
        { id: 'ACT-ROT', name: '旋转台', kind: 'rotary', station: design.config.stations[1], rotationRangeDeg: 90, durationMs: 450 }
      ]
    }
  };
  const editedPreviewMotion = {
    ...withPreviewMotion,
    config: {
      ...withPreviewMotion.config,
      actuators: withPreviewMotion.config.actuators.map((actuator) => actuator.kind === 'rotary'
        ? { ...actuator, rotationRangeDeg: 225, rotationRangeSource: 'engineer-input', durationMs: 60_000 }
        : { ...actuator, travelMm: 175, travelSource: 'engineer-input', durationMs: 45_000 })
    }
  };

  assert.deepEqual(flowModelForDesign(editedPreviewMotion), flowModelForDesign(withPreviewMotion));
  assert.deepEqual(reevaluateCandidateCycle(editedPreviewMotion), reevaluateCandidateCycle(withPreviewMotion));
});

test('执行机构编辑后的校核节拍回写到工程模型，避免保存旧产能', () => {
  const original = generateCandidates(brief)[0];
  const edited = {
    ...original,
    config: {
      ...original.config,
      actuators: [{ id: 'ACT-1', name: '旋转轴', kind: 'rotary', station: original.config.stations[0], point: 'Q0.0' }]
    }
  };
  const evaluation = reevaluateCandidateCycle(edited);
  assert.notEqual(evaluation.throughputPerMin, original.cycle.throughputPerMin);

  const saveable = withReviewedCycle(edited, evaluation);
  const throughput = Math.round(evaluation.throughputPerMin * 100) / 100;
  assert.equal(saveable.cycle.throughputPerMin, throughput);
  assert.equal(saveable.cycle.partsPerMinute, throughput);
  assert.equal(saveable.cycle.stationSeconds, Math.round(evaluation.stationSecondsMax * 1000) / 1000);
  assert.equal(saveable.cycle.meetsTarget, evaluation.meetsTarget === true);
  assert.equal(saveable.cycle.slowestStation, (evaluation.bottleneck?.station ?? 0) + 1);
  assert.ok(saveable.cycle.bottleneck.includes(evaluation.bottleneck?.op ?? '无关键工序'));
  assert.equal(edited.cycle.throughputPerMin, original.cycle.throughputPerMin);
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

test('完整工程师周期按真实布局口径处理：转盘要求含分度，双轨 cell 不猜每轨/整机', () => {
  const candidates = generateCandidates(brief);
  const examples = [
    { form: 'dial-6', expectedMode: 'dial' },
    { form: 'dual-lane', expectedMode: 'cell' }
  ];

  for (const example of examples) {
    const design = candidates.find((candidate) => candidate.form.id === example.form);
    assert.ok(design, `${example.form} candidate exists`);
    assert.equal(design.cycle.mode, example.expectedMode);
    const stations = design.config.stations.map((name, index) => ({
      id: `station-${index + 1}`,
      name,
      cycleTime: { seconds: [2, 4, 3][index % 3], sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' }
    }));
    const assessment = assessStationCycles(reevaluateCandidateCycle(design), stations, design.cycle.perMin);
    assert.equal(assessment.mode, example.expectedMode);

    const saveable = withReviewedCycle(design, assessment);
    assert.equal(saveable.cycle.mode, example.expectedMode);
    if (example.expectedMode === 'dial') {
      assert.equal(assessment.source, 'engineer-input');
      assert.equal(assessment.cycleSeconds, 4, 'confirmed input already includes index time, so the model index is not added again');
      assert.equal(assessment.throughputPerMin, 15);
      assert.equal(assessment.bottleneck.station, 1);
      assert.equal(saveable.cycle.stationSeconds, 4);
      assert.equal(saveable.cycle.throughputPerMin, 15);
    } else {
      const model = reevaluateCandidateCycle(design);
      assert.equal(assessment.source, 'model-estimate');
      assert.equal(assessment.meetsTarget, model.meetsTarget, 'the preserved target comparison belongs to the model estimate');
      assert.match(assessment.manualCalculationBlockedReason, /每条轨道还是整机周期/);
      assert.equal(assessment.cycleSeconds, model.cycleSeconds);
      assert.equal(assessment.throughputPerMin, model.throughputPerMin);
      assert.equal(saveable.cycle.stationSeconds, Math.round(model.stationSecondsMax * 1000) / 1000);
      assert.equal(saveable.cycle.throughputPerMin, Math.round(model.throughputPerMin * 100) / 100);
    }
  }
});
