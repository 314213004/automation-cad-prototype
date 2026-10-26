import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefFromGraph,
  buildCandidateSummaries,
  candidateHeadline,
  summarizeDesign
} from '../../src/canvas/candidates-source.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('briefFromGraph：工位=运动节点数、机构按 kind 计数、目标节拍透传', () => {
  const brief = briefFromGraph(demoCanvasGraph());
  assert.equal(brief.stations, 5, '演示图 6 个节点里 5 个有行程/节拍（机架不算工位）');
  assert.equal(brief.cyclePerMin, 20);
  assert.equal(brief.process, 'screw');
  const kinds = brief.actuators.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['cylinder', 'gripper']);
  assert.ok(brief.sensors.length >= 1);
  assert.match(brief.notes[0], /估计值/);
});

test('briefFromGraph：工位数夹到 1–12，空图也给最小可用 brief', () => {
  const demo = demoCanvasGraph();
  const many = { ...demo, nodes: Array.from({ length: 20 }, (_, index) => ({ ...demo.nodes[1], id: `N${index}` })), edges: [] };
  assert.equal(briefFromGraph(many).stations, 12);
  const empty = { schemeId: 's', nodes: [], edges: [] };
  const brief = briefFromGraph(empty);
  assert.equal(brief.stations, 1);
  assert.equal(brief.actuators.length, 1);
});

test('buildCandidateSummaries：三套不同形态，节拍/成本/BOM 都是真实评估值', () => {
  const brief = briefFromGraph(demoCanvasGraph());
  const candidates = buildCandidateSummaries(brief);
  assert.equal(candidates.length, 3, '必须给出 3 套候选');
  const formIds = new Set(candidates.map((item) => item.formId));
  assert.equal(formIds.size, 3, '三套形态不能重复');

  for (const candidate of candidates) {
    assert.ok(candidate.cycleSeconds > 0, `${candidate.formId} 节拍必须大于 0`);
    assert.ok(candidate.unitsPerHour > 0);
    assert.ok(candidate.costTotalYuan >= 0);
    assert.ok(candidate.stations >= 1);
    assert.ok(candidate.bomRows >= 0);
    assert.equal(typeof candidate.formName, 'string');
    assert.ok(candidate.formName.length > 0);
    // 成本口径：缺价行不计入总额但要报数量
    assert.equal(typeof candidate.missingPriceCount, 'number');
    assert.match(candidateHeadline(candidate), /工位/);
  }
  // 不同形态的工位数/节拍不应完全一样（否则说明 formId 没生效）
  const signatures = new Set(candidates.map((c) => `${c.stations}|${c.cycleSeconds}|${c.layout}`));
  assert.ok(signatures.size > 1, '三套候选的指标完全相同，疑似没有真正换形态');
});

test('summarizeDesign：节拍 = 60 / 估算产能，达标判定按目标节拍', () => {
  const brief = briefFromGraph(demoCanvasGraph());
  const candidates = buildCandidateSummaries(brief);
  for (const candidate of candidates) {
    if (candidate.targetPerMin === null) continue;
    const expected = 60 / (candidate.unitsPerHour / 60);
    assert.ok(Math.abs(candidate.cycleSeconds - expected) < 0.01, `${candidate.formId} 节拍与 UPH 不自洽`);
    assert.equal(candidate.meetsTarget, candidate.unitsPerHour / 60 >= candidate.targetPerMin - 1e-9);
  }
});

test('summarizeDesign：候选不会凭空造价——缺价只报数量，总额来自成本模型', () => {
  const candidates = buildCandidateSummaries(briefFromGraph(demoCanvasGraph()));
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(Number.isFinite(candidate.costTotalYuan), true);
    assert.ok(candidate.missingPriceCount >= 0);
    assert.ok(candidate.assumptions.length > 0, '必须带假设说明');
  }
});
