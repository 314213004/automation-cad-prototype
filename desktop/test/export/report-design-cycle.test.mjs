import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReportHtml } from '../../src/export/report.ts';
import { assessStationCycles, buildStationCycleReport } from '../../src/design/station-cycle.ts';
import { buildCycleEngineeringNote } from '../../src/design/review.ts';
import { completeDesign } from '../../src/design/synthesis.ts';

const fallback = {
  mode: 'linear',
  stationSeconds: [3.5, 2.8],
  stationSecondsMax: 3.5,
  cycleSeconds: 4.1,
  throughputPerMin: 60 / 4.1,
  meetsTarget: true,
  requiredStations: 2,
  bottleneck: { station: 0, seconds: 3.5, op: '模型默认动作' },
  notes: ['模板默认估算']
};

const design = completeDesign({
  process: 'screw',
  stations: 2,
  cyclePerMin: 12,
  layout: 'linear',
  processes: ['锁螺丝'],
  actuators: [],
  sensors: [],
  brand: null,
  voltage: '380VAC',
  notes: []
}, []);

test('PDF 报告渲染完整工位周期表，并对用户控制的工位名称执行 HTML 转义', () => {
  const unsafeName = '工位 <img src=x onerror="alert(1)"> & \'记录\'';
  const stations = [
    { id: 's1', name: unsafeName, cycleTime: { seconds: 2.75, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } },
    { id: 's2', name: '锁付', cycleTime: { seconds: 4, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } }
  ];
  const stationCycle = buildStationCycleReport(assessStationCycles(fallback, stations, 12), stations, 12);
  const html = renderReportHtml({
    project: { name: '测试设备' },
    bom: [],
    interference: [],
    stress: [],
    stationCycle
  });

  assert.match(html, /工位周期输入与产能依据/);
  assert.match(html, /工位 &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;记录&#39;/);
  assert.match(html, /工程师输入（完整周期；待实测）/);
  assert.match(html, /整机节拍/);
  assert.match(html, /完整周期（秒\/件）/);
  assert.match(html, /瓶颈/);
  assert.doesNotMatch(html, /<img src=x|<script>alert\(1\)/);
});

test('PDF 通过现有 warning/设计假设栏交代模型节拍边界，且完整手工周期仍标为工程师输入', () => {
  const modelNote = buildCycleEngineeringNote(design, 'model-estimate');
  const modelStations = [];
  const modelCycle = buildStationCycleReport(assessStationCycles(fallback, modelStations, 12), modelStations, 12);
  const modelHtml = renderReportHtml({
    project: { name: '模型节拍边界' },
    bom: [],
    interference: [],
    stress: [],
    stationCycle: modelCycle,
    engineeringNotes: { assumptions: [], warnings: [modelNote.detail] }
  });

  assert.equal(modelNote.kind, 'warning');
  assert.match(modelHtml, /模型节拍估算仅按工艺与执行机构类别默认值/);
  assert.match(modelHtml, /行程\/分度角（包括工程师输入）只驱动概念运动几何预览，单动作 durationMs 只用于动画预览，均不参与节拍估算/);
  assert.match(modelHtml, /速度\/加速度、完整动作时序、并行调度、等待\/上下料时间或现场实测数据，不能签核/);

  const stations = ['上料', '锁付'].map((name, index) => ({
    id: `s${index + 1}`,
    name,
    cycleTime: { seconds: [2, 4][index], sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' }
  }));
  const manualAssessment = assessStationCycles(fallback, stations, 12);
  const manualCycle = buildStationCycleReport(manualAssessment, stations, 12);
  const manualNote = buildCycleEngineeringNote(design, manualAssessment.source);
  const manualHtml = renderReportHtml({
    project: { name: '工程师完整周期' },
    bom: [],
    interference: [],
    stress: [],
    stationCycle: manualCycle,
    engineeringNotes: { assumptions: [manualNote.detail], warnings: [] }
  });

  assert.equal(manualNote.kind, 'assumption');
  assert.match(manualHtml, /工程师输入（完整周期；待实测）/);
  assert.match(manualHtml, /节拍计算依据为工程师输入的完整工位周期（仍待现场实测）/);
  assert.doesNotMatch(manualHtml, /产能依据.*模型估算/);
});

test('PDF 报告对部分周期输入明确显示模型估算，列出未填工位且不把手工输入写成计算依据', () => {
  const stations = [
    { id: 's1', name: '上料', cycleTime: { seconds: 2.5, source: 'engineer-input', verification: 'pending-measurement' } },
    { id: 's2', name: '检测' }
  ];
  const stationCycle = buildStationCycleReport(assessStationCycles(fallback, stations, 12), stations, 12);
  const html = renderReportHtml({
    project: { name: '部分输入测试' },
    bom: [],
    interference: [],
    stress: [],
    stationCycle
  });

  assert.match(html, /模型估算（未实测）/);
  assert.match(html, /仅录入 1\/2 个工位；未填写：检测/);
  assert.ok(html.includes('上料</td>'));
  assert.ok(html.includes('待实测；因输入未完整，未参与产能计算'));
  assert.ok(html.includes('检测</td>'));
  assert.ok(html.includes('未输入；未参与周期输入计算'));
  assert.match(html, /已填写的工程师周期仅作记录，未参与本次产能计算/);
  assert.doesNotMatch(html, /工程师输入瓶颈/);
});

test('PDF 对 cell 部分/零输入同时显示永久布局限制与缺失工位', () => {
  const cellFallback = { ...fallback, mode: 'cell' };
  const partialStations = [
    { id: 's1', name: '上料', cycleTime: { seconds: 2, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } },
    { id: 's2', name: '加工' },
    { id: 's3', name: '检测' }
  ];
  const partialReport = buildStationCycleReport(assessStationCycles(cellFallback, partialStations, 12), partialStations, 12);
  const partialHtml = renderReportHtml({ project: { name: 'cell 部分周期' }, bom: [], interference: [], stress: [], stationCycle: partialReport });
  assert.match(partialHtml, /仅录入 1\/3 个工位；未填写：加工、检测；永久布局限制：单元\/多轨布局/);
  assert.match(partialHtml, /该布局即使所有工位周期都补齐，人工值仍仅作记录、不会参与产能计算/);
  assert.ok(partialHtml.includes('待实测；因输入未完整，未参与产能计算'));
  assert.match(partialHtml, /不输出基于这些人工值的目标判定/);
  assert.doesNotMatch(partialHtml, /工程师输入瓶颈|全部工位均.*才会切换为工程师输入计算/);

  const emptyStations = [{ id: 's1', name: '上料' }, { id: 's2', name: '加工' }, { id: 's3', name: '检测' }];
  const emptyReport = buildStationCycleReport(assessStationCycles(cellFallback, emptyStations, 12), emptyStations, 12);
  const emptyHtml = renderReportHtml({ project: { name: 'cell 无周期' }, bom: [], interference: [], stress: [], stationCycle: emptyReport });
  assert.match(emptyHtml, /无周期输入；未填写：上料、加工、检测；永久布局限制：单元\/多轨布局/);
  assert.match(emptyHtml, /该布局即使所有工位周期都补齐，人工值仍仅作记录/);
  assert.doesNotMatch(emptyHtml, /全部工位均.*才会切换为工程师输入计算/);
});
