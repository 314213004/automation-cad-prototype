import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessMachineFootprint, footprintAssessmentText, geometryForDesign, withFootprintAssessment } from '../../src/design/footprint.ts';
import { generateCandidates } from '../../src/design/candidates.ts';
import { briefToMachineBrief, initialDraft } from '../../src/design/wizard-state.ts';
import { saveProject } from '../../electron/projects.ts';

function wizardBrief(footprint) {
  const base = initialDraft().brief;
  return briefToMachineBrief({
    ...base,
    name: '三工位锁螺丝机',
    cyclePerMin: 10,
    stations: 3,
    footprint
  });
}

test('第 1 步结构化占地边界对每个候选真实包络给出符合、超出和未设限制状态', () => {
  const requirement = { lengthMm: 10000, widthMm: 5000 };
  const brief = wizardBrief(requirement);
  assert.deepEqual(brief.footprint, requirement, '表单尺寸应作为结构化字段传入方案合成');
  const candidates = generateCandidates(brief);
  assert.equal(candidates.length, 3);

  for (const candidate of candidates) {
    const envelope = geometryForDesign(candidate).envelope;
    const actual = [envelope[0], envelope[1]];
    const fittingLimit = { lengthMm: actual[0] + 1, widthMm: actual[1] + 1 };
    const fitting = assessMachineFootprint(fittingLimit, envelope);
    assert.equal(fitting.status, 'within', candidate.form.id);
    assert.match(footprintAssessmentText(fitting), /^符合/);
    assert.ok(candidate.assumptions.some((line) => line.includes('占地需求已结构化记录')));

    const restrictiveLimit = { lengthMm: actual[0] - 20, widthMm: actual[1] - 10 };
    const exceeded = assessMachineFootprint(restrictiveLimit, envelope);
    assert.equal(exceeded.status, 'exceeds', candidate.form.id);
    assert.equal(exceeded.excess[0], 20);
    assert.equal(exceeded.excess[1], 10);
    assert.match(footprintAssessmentText(exceeded), /超出长度 20 mm、宽度 10 mm/);

    const noLimit = assessMachineFootprint(null, envelope);
    assert.equal(noLimit.status, 'unbounded', candidate.form.id);
    assert.match(footprintAssessmentText(noLimit), /未设边界/);
  }
});

test('占地超限不缩放几何，且保存后的设计仍可追溯用户需求和差额', () => {
  const initial = generateCandidates(wizardBrief(null))[0];
  assert.ok(initial);
  const envelopeBefore = geometryForDesign(initial).envelope;
  const requirement = { lengthMm: envelopeBefore[0] - 25, widthMm: envelopeBefore[1] + 100 };
  const brief = wizardBrief(requirement);
  const design = generateCandidates(brief).find((candidate) => candidate.form.id === initial.form.id);
  assert.ok(design);
  const geometry = geometryForDesign(design);
  const assessment = assessMachineFootprint(brief.footprint, geometry.envelope);
  const assessedDesign = withFootprintAssessment(design, assessment);

  assert.deepEqual(geometryForDesign(assessedDesign).envelope, envelopeBefore, '评估不得缩放实体几何');
  assert.ok(assessedDesign.warnings.some((warning) => /占地超限/.test(warning)));
  assert.ok(assessedDesign.assumptions.some((line) => line.includes(`${requirement.lengthMm} × ${requirement.widthMm} mm`)));
  assert.ok(assessedDesign.assumptions.some((line) => /超出长度 25 mm/.test(line)));

  const root = mkdtempSync(join(tmpdir(), 'design-footprint-test-'));
  const saved = saveProject(root, {
    name: '占地追溯测试',
    process: 'screw',
    parts: geometry.parts.length,
    envelope: geometry.envelope,
    design: assessedDesign,
    config: assessedDesign.config
  });
  assert.equal(saved.ok, true, saved.message);
  const persisted = JSON.parse(readFileSync(join(root, 'projects', '占地追溯测试', 'design.json'), 'utf8'));
  assert.ok(persisted.design.assumptions.some((line) => line.includes('占地评估：')));
  assert.ok(persisted.design.assumptions.some((line) => line.includes(`${requirement.lengthMm} × ${requirement.widthMm} mm`)));
  assert.ok(persisted.design.warnings.some((line) => /占地超限/.test(line)));
});
