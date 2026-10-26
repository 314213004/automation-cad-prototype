import assert from 'node:assert/strict';
import test from 'node:test';
import { toCsv } from '../../src/export/bom.ts';
import { renderReportHtml } from '../../src/export/report.ts';
import { annotateBomRowsForGeometryReview, annotatePlcFilesForGeometryReview, canExportDesignDeliverables, geometryReviewExportNotes } from '../../src/design/geometry-review-export.ts';
import { projectGeometryReviewFrom } from '../../src/design/geometry-review.ts';
import { completeDesign } from '../../src/design/synthesis.ts';
import { reviewDesign } from '../../src/design/review.ts';
import { buildMachineCircuit } from '../../src/elec/machine-circuit.ts';
import { renderSheet } from '../../src/elec/sheet.ts';
import { generateProject } from '../../src/plcgen/generate.ts';

const design = completeDesign({
  process: 'screw',
  stations: 3,
  cyclePerMin: 10,
  layout: 'auto',
  processes: ['锁螺丝'],
  actuators: [],
  sensors: [],
  brand: null,
  voltage: '380VAC',
  notes: []
}, []);
const bom = [{ index: 1, name: '支架', model: '待选型', quantity: 1, material: '标准件', note: '规格待复核' }];
const circuit = buildMachineCircuit({
  project: '状态标注测试',
  drive: { powerKw: 0.04, rpm: 76, ratio: 18.4 },
  sensors: [{ tag: '-PE1', label: '进料检测', address: 'I0.3' }],
  controls: { estop: true, startStop: true, lamp: true },
  selection: { breaker: 'iC65N 3P C1', contactor: 'LC1D09', thermal: 'LRD01', currentA: 0.1, thermalSetA: 0.1 }
});
const generatedPlc = generateProject({
  config: {
    id: 'export-test-machine',
    name: '导出状态测试机型',
    stations: ['上料'],
    actuators: [{ id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1' }],
    sensors: [{ point: 'X0', station: '上料', part: 'cyl-1' }, { point: 'X1', station: '上料', part: 'cyl-1' }],
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sequence: []
  },
  target: 'generic'
});
assert.equal(generatedPlc.ok, true, 'PLC 测试配置应能生成工程');

function outputsFor(state) {
  const notes = geometryReviewExportNotes(state);
  const csvRows = annotateBomRowsForGeometryReview(bom, state);
  const csv = toCsv(csvRows);
  const plcFiles = annotatePlcFilesForGeometryReview(generatedPlc.files, state);
  const st = plcFiles.find((file) => file.path.endsWith('.st'));
  assert.ok(st, 'PLC 工程应包含 ST 源文件');
  const svg = renderSheet(circuit, { project: '状态标注测试', notes: [...notes.svg] }).svg;
  const pdfHtml = renderReportHtml({
    project: { name: '状态标注测试' },
    bom: csvRows,
    interference: [],
    stress: [],
    geometryReview: state
  });
  return { csv, plc: st.content, svg, pdfHtml };
}

test('概念未校核状态随 BOM、PLC ST、SVG 和 PDF 正文导出，且不伪造通过', () => {
  const review = reviewDesign(design, []);
  assert.equal(review.geometryCheck, 'not-executed');
  assert.equal(canExportDesignDeliverables(review), true, '唯一几何未执行错误允许显式概念输出');
  const state = projectGeometryReviewFrom(review, { source: 'empty' }, 0, '2026-10-26T00:00:00.000Z');
  assert.deepEqual(state, { status: 'not-executed', partCount: 0 });
  const output = outputsFor(state);
  for (const body of Object.values(output)) {
    assert.match(body, /概念版/);
    assert.match(body, /3D\/干涉校核未执行\/未验证/);
    assert.match(body, /导出不代表验收或发布/);
    assert.doesNotMatch(body, /几何校核通过|项目校核通过|签核通过/);
  }
  assert.match(output.csv, /规格待复核；【概念版】/);
  assert.match(output.plc, /^\/\/ 【概念版】/);
  assert.match(output.pdfHtml, /不得解释为无干涉或校核通过/);
  assert.match(output.plc, /不得视为校核通过/);
});

test('真实导入 CAD 的 AABB 初筛状态自动变成初步版标识，明确不是 B-rep 签核', () => {
  const importedParts = [{ name: 'fixture.step · 零件 A', bbox: { min: [0, 0, 0], max: [20, 10, 8] } }];
  const review = reviewDesign(design, importedParts);
  assert.equal(review.geometryCheck, 'aabb-screened');
  assert.equal(canExportDesignDeliverables(review), true);
  const state = projectGeometryReviewFrom(
    review,
    { source: 'imported-model', sourceName: 'fixture.step' },
    importedParts.length,
    '2026-10-26T00:00:00.000Z'
  );
  assert.equal(state.status, 'aabb-screened');
  const output = outputsFor(state);
  for (const body of Object.values(output)) {
    assert.match(body, /初步版/);
    assert.match(body, /AABB/);
    assert.match(body, /B-rep/);
    assert.match(body, /导出不代表验收或发布/);
  }
  assert.doesNotMatch(output.plc, /已通过几何校核/);
  assert.match(output.pdfHtml, /仅完成包围盒级干涉初筛（1 件）/);
  assert.match(output.pdfHtml, /fixture\.step/);
});

test('非几何阻断错误仍阻止交付输出；旧式未带几何状态的通用报告不被改写', () => {
  const review = reviewDesign(design, []);
  const blocked = {
    ...review,
    errors: review.errors + 1,
    items: [...review.items, { severity: 'error', title: '安全配置无效', detail: '修复后重试' }]
  };
  assert.equal(canExportDesignDeliverables(blocked), false);
  const legacy = renderReportHtml({ project: { name: '旧报告' }, bom, interference: [], stress: [] });
  assert.doesNotMatch(legacy, /概念版|初步版|导出不代表验收或发布/);
});

test('空 BOM 仍保持六列结构，并可在备注列标题携带概念状态而不制造虚假物料行', () => {
  const review = reviewDesign(design, []);
  const state = projectGeometryReviewFrom(review, { source: 'empty' }, 0);
  const notes = geometryReviewExportNotes(state);
  const csv = toCsv([], { noteHeader: `备注（${notes.bom}）` });
  assert.equal(csv.split(',').length, 6);
  assert.match(csv, /概念版/);
  assert.equal(csv.split('\r\n').length, 1, '不得添加伪造 BOM 物料行');
});
