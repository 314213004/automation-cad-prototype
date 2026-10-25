import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProject, saveProject } from '../../electron/projects.ts';
import { projectGeometryReviewFrom, projectGeometryReviewLabel, reopenedGeometryReviewMessage, canSaveAsConcept } from '../../src/design/geometry-review.ts';
import { reviewDesign } from '../../src/design/review.ts';
import { renderReportHtml } from '../../src/export/report.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('概念工程端到端：空几何仍是 error，可保存/重开为未验证，导入 CAD 重校核后记录初筛状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'geometry-review-flow-'));
  roots.push(root);
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));

  const emptyReview = reviewDesign(design, []);
  assert.equal(emptyReview.geometryCheck, 'not-executed');
  assert.equal(emptyReview.errors, 1, '空场景 error 必须保留');
  assert.equal(emptyReview.items.find((item) => item.title === '干涉初筛未执行')?.severity, 'error');
  assert.equal(canSaveAsConcept(emptyReview), true, '仅允许显式保存唯一空场景 error');
  assert.equal(canSaveAsConcept({ ...emptyReview, items: [...emptyReview.items, { severity: 'error', title: '其他阻断', detail: '必须阻断' }] }), false);
  const conceptState = projectGeometryReviewFrom(emptyReview, { source: 'empty' }, 0);
  assert.deepEqual(conceptState, { status: 'not-executed', partCount: 0 });

  const concept = saveProject(root, {
    name: '概念首版锁螺丝机', process: 'screw', parts: 0, design, config: design.config,
    geometryReview: conceptState
  });
  assert.equal(concept.ok, true, concept.message);
  const reopenedConcept = openProject(root, concept.record.id);
  assert.equal(reopenedConcept.ok, true);
  assert.deepEqual(reopenedConcept.record.geometryReview, conceptState);
  assert.match(projectGeometryReviewLabel(reopenedConcept.record.geometryReview), /3D\/干涉校核未执行（未验证）/);
  assert.match(reopenedGeometryReviewMessage(reopenedConcept.record.geometryReview), /概念估算占位体/);

  const report = renderReportHtml({
    project: { name: '概念首版锁螺丝机' }, bom: [], interference: emptyReview.interference, stress: [],
    geometryReview: conceptState
  });
  assert.match(report, /3D\/干涉校核未执行\/未验证/);
  assert.match(report, /不得解释为无干涉或校核通过/);
  assert.doesNotMatch(report, /未发现包围盒级干涉/);

  // 代表“导入有效 CAD 后”的主视口几何；实际 CAD importer 负责解析并提供这些包围盒。
  const importedCadParts = [{ name: 'fixture.step · 零件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const checkedReview = reviewDesign(design, importedCadParts);
  assert.equal(checkedReview.geometryCheck, 'aabb-screened');
  assert.equal(checkedReview.items.some((item) => item.title === '干涉初筛未执行'), false);
  assert.equal(checkedReview.errors, 0);
  assert.equal(canSaveAsConcept(checkedReview), false);
  const checkedState = projectGeometryReviewFrom(
    checkedReview,
    { source: 'imported-model', sourceName: 'fixture.step' },
    importedCadParts.length,
    '2026-10-26T03:00:00.000Z'
  );
  assert.deepEqual(checkedState, {
    status: 'aabb-screened', partCount: 1, method: 'AABB', sourceName: 'fixture.step', checkedAt: '2026-10-26T03:00:00.000Z'
  });

  const checkedSave = saveProject(root, {
    name: '概念首版锁螺丝机', process: 'screw', parts: 0, design, config: design.config,
    geometryReview: checkedState
  });
  assert.equal(checkedSave.ok, true, checkedSave.message);
  const reopenedChecked = openProject(root, checkedSave.record.id);
  assert.equal(reopenedChecked.ok, true);
  assert.deepEqual(reopenedChecked.record.geometryReview, checkedState);
  assert.match(projectGeometryReviewLabel(reopenedChecked.record.geometryReview), /包围盒级干涉初筛已执行/);
  assert.match(reopenedGeometryReviewMessage(reopenedChecked.record.geometryReview), /不是 B-rep 精检或工程签核/);
  const checkedReport = renderReportHtml({
    project: { name: '概念首版锁螺丝机' }, bom: [], interference: checkedReview.interference, stress: [],
    geometryReview: checkedState
  });
  assert.match(checkedReport, /仅完成包围盒级干涉初筛（1 件）/);
  assert.match(checkedReport, /不等同于 B-rep 精检或工程签核/);
  assert.doesNotMatch(checkedReport, /3D\/干涉校核未执行\/未验证/);
});
