import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  build123dScript,
  buildMachineGraphJson,
  plcSt,
  portReport
} from '../../src/canvas/export.ts';
import { insertAdapterForEdge } from '../../src/canvas/graph.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function port(overrides = {}) {
  return { family: 'grid', holeDiaMm: 6.6, pitchXMm: 50, pitchYMm: 50, count: 4, ...overrides };
}

const SLIDER_PORT = port({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60 });
const BODY_PORT = port({ family: 'body', holeDiaMm: 4.5, pitchXMm: 48, pitchYMm: 36 });

function node(id, overrides = {}) {
  return {
    id,
    kind: 'linear',
    partId: `part-${id}`,
    name: `节点${id}`,
    spec: `规格${id}`,
    portIn: port(),
    portOut: SLIDER_PORT,
    strokeMm: 450,
    leadMm: 10,
    massKg: 9.2,
    stepSec: 0.55,
    dimsMm: [620, 86, 74],
    io: { di: 3, do: 2, desc: '正负限位+原点' },
    pos: { x: 100, y: 120 },
    ortho: { x: 0, y: 0 },
    ...overrides
  };
}

function graphOf(nodes, edges, extra = {}) {
  return { schemeId: 'scheme-export', title: '三轴龙门视觉飞拍贴合机', nodes, edges, ...extra };
}

function mismatchedChain() {
  const a = node('A', { portIn: port(), portOut: SLIDER_PORT, pos: { x: 0, y: 0 }, ortho: { x: 0, y: 0 } });
  const b = node('B', {
    portIn: BODY_PORT,
    portOut: port({ family: 'plate', holeDiaMm: 4.5, pitchXMm: 32, pitchYMm: 32 }),
    pos: { x: 260, y: 0 },
    ortho: { x: 300, y: 0 }
  });
  return graphOf([a, b], [{ id: 'e1', from: 'A', to: 'B' }]);
}

const factory = () => () => ({
  plateDimsMm: [92, 76, 12],
  thicknessMm: 12,
  massKg: 0.42,
  costYuan: null
});

// ---------------------------------------------------------------------------
// Machine Graph JSON
// ---------------------------------------------------------------------------

test('buildMachineGraphJson：字段顺序稳定，边乱序输出字节一致', () => {
  const a = node('A', { portIn: port(), portOut: SLIDER_PORT });
  const b = node('B', { portIn: SLIDER_PORT, portOut: BODY_PORT });
  const c = node('C', { portIn: BODY_PORT, portOut: SLIDER_PORT });
  const forward = graphOf(
    [a, b, c],
    [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'C' }
    ]
  );
  const reversed = graphOf(
    [a, b, c],
    [
      { id: 'e2', from: 'B', to: 'C' },
      { id: 'e1', from: 'A', to: 'B' }
    ]
  );
  assert.equal(buildMachineGraphJson(forward), buildMachineGraphJson(reversed));

  const parsed = JSON.parse(buildMachineGraphJson(forward));
  assert.deepEqual(Object.keys(parsed), [
    'schemaVersion',
    'schemeId',
    'title',
    'layout',
    'summary',
    'nodes',
    'edges'
  ]);
  assert.deepEqual(Object.keys(parsed.nodes[0]).slice(0, 7), [
    'id',
    'kind',
    'name',
    'spec',
    'partId',
    'dimsMm',
    'portIn'
  ]);
  assert.deepEqual(Object.keys(parsed.nodes[0].portIn), [
    'family',
    'holeDiaMm',
    'pitchXMm',
    'pitchYMm',
    'count'
  ]);
  assert.deepEqual(Object.keys(parsed.summary), [
    'nodeCount',
    'edgeCount',
    'adapterCount',
    'mismatchedEdgeCount'
  ]);
  assert.deepEqual(Object.keys(parsed.edges[0]), ['id', 'from', 'to']);
});

test('buildMachineGraphJson：summary 计数与图一致，且不含任何金额字段', () => {
  const base = mismatchedChain();
  const inserted = insertAdapterForEdge(base, 'e1', factory());
  const json = buildMachineGraphJson(inserted.graph);
  const parsed = JSON.parse(json);
  assert.equal(parsed.summary.nodeCount, 3);
  assert.equal(parsed.summary.edgeCount, 2);
  assert.equal(parsed.summary.adapterCount, 1);
  assert.equal(parsed.summary.mismatchedEdgeCount, 0);
  assert.equal(parsed.schemaVersion, '1.0.0-canvas-graph');
  assert.equal(json.includes('totalYuan'), false);
  assert.equal(json.endsWith('\n'), true, 'JSON 必须以换行结尾，便于 diff');

  const adapter = parsed.nodes.find((entry) => entry.kind === 'adapter');
  assert.deepEqual(adapter.adapterParams.fromPort, SLIDER_PORT);
  assert.deepEqual(adapter.adapterParams.toPort, BODY_PORT);
  assert.equal(adapter.adapterParams.costYuan, null);
});

// ---------------------------------------------------------------------------
// build123d
// ---------------------------------------------------------------------------

test('build123dScript：转接板参数化孔位（两端端口）写进脚本', () => {
  const inserted = insertAdapterForEdge(mismatchedChain(), 'e1', factory());
  const script = build123dScript(inserted.graph);

  assert.ok(script.includes('from build123d import *'));
  assert.ok(script.includes('RectangleRounded(92.0, 76.0, radius=6.0)'), '板外形未参数化');
  assert.ok(script.includes('Extrude(amount=12.0)'), '板厚未参数化');
  assert.ok(script.includes('GridLocations(60.0, 60.0, 2, 2)'), '母件侧孔距未参数化');
  assert.ok(script.includes('CounterBoreHole(radius=2.75'), '母件侧沉头孔半径未参数化');
  assert.ok(script.includes('GridLocations(48.0, 36.0, 2, 2)'), '子件侧孔距未参数化');
  assert.ok(script.includes('Hole(radius=2.25'), '子件侧孔径未参数化');
  assert.ok(script.includes('导出'), '缺导出说明');
  assert.ok(script.includes('export_step(assy, "machine_assembly.step")'));
  assert.ok(/def build_adapter_/.test(script));
  assert.ok(script.includes('端口 A（母件侧 portIn）'), '缺端点语义注释');
  assert.ok(script.includes('端口 B（子件侧 portOut）'));
});

test('build123dScript：无转接板时仍产出装配脚本并写明无需转接板', () => {
  const a = node('A', { portIn: port(), portOut: SLIDER_PORT });
  const b = node('B', { portIn: SLIDER_PORT, portOut: BODY_PORT });
  const script = build123dScript(graphOf([a, b], [{ id: 'e1', from: 'A', to: 'B' }]));
  assert.ok(script.includes('无需转接板'));
  assert.ok(script.includes('Box(620.0, 86.0, 74.0)'), '缺节点占位包围盒');
  assert.ok(script.includes('parts["A"]'));
  assert.ok(script.includes('parts["B"]'));
  assert.equal(/def build_adapter_/.test(script), false);
});

test('build123dScript：只输出文本，不含执行痕迹（不 import os/subprocess，不写文件）', () => {
  const script = build123dScript(mismatchedChain());
  assert.equal(typeof script, 'string');
  assert.ok(script.includes('生成器不执行本脚本'));
  assert.equal(script.includes('subprocess'), false);
  assert.equal(script.includes('open('), false);
  assert.equal(script.includes('import os'), false);
});

// ---------------------------------------------------------------------------
// PLC ST
// ---------------------------------------------------------------------------

const PLC_CONFIG = {
  id: 'canvas-machine',
  name: '画布机型',
  stations: ['上料'],
  actuators: [
    {
      id: 'cyl-1',
      name: '上料气缸',
      kind: 'cylinder',
      station: '上料',
      extendPoint: 'Y0',
      retractPoint: 'Y1',
      travelMm: 40,
      durationMs: 400
    }
  ],
  sensors: [
    { point: 'X0', station: '上料', part: 'cyl-1' },
    { point: 'X1', station: '上料', part: 'cyl-1' }
  ],
  safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
  sequence: []
};

test('plcSt：没有 plcConfig 时降级为 supported=false + Graph JSON IR', () => {
  const graph = mismatchedChain();
  const result = plcSt(graph);
  assert.equal(result.supported, false);
  assert.equal(result.content, null);
  assert.deepEqual(result.files, []);
  assert.match(result.reason, /PlcGenConfig/);
  assert.match(result.reason, /点位地址/);
  assert.ok(result.graphIr, '降级时必须给出 JSON IR');
  const parsed = JSON.parse(result.graphIr);
  assert.equal(parsed.schemeId, 'scheme-export');
  assert.equal(parsed.summary.mismatchedEdgeCount, 1);
});

test('plcSt：注入合法 plcConfig 时复用 plcgen 生成 ST（同一生成器，不另写模板）', () => {
  const result = plcSt(mismatchedChain(), { plcConfig: PLC_CONFIG });
  assert.equal(result.supported, true);
  assert.equal(result.graphIr, null);
  assert.equal(result.files.length, 5);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['src/FB_Cylinder.st', 'src/FB_Gripper.st', 'src/FB_RotaryAxis.st', 'src/DB_IO.st', 'src/OB1_Main.st']
  );
  assert.ok(result.content.includes('PROGRAM OB1_Main'));
  assert.ok(result.content.includes('END_PROGRAM'));
  assert.ok(result.content.includes('FC_Safety'), 'ST 必须来自 plcgen（含安全 FC 调用）');
  assert.match(result.reason, /plcgen/);
});

test('plcSt：plcgen 预检不通过时返回 supported=false 而不是生成假 ST', () => {
  const result = plcSt(mismatchedChain(), { plcConfig: { id: 'x', name: '缺安全回路' } });
  assert.equal(result.supported, false);
  assert.equal(result.content, null);
  assert.match(result.reason, /预检未通过/);
  assert.match(result.reason, /ESTOP_UNDEFINED/);
  assert.ok(result.graphIr);
  assert.deepEqual(result.files, []);
});

// ---------------------------------------------------------------------------
// 端口报告
// ---------------------------------------------------------------------------

test('portReport：逐边给出兼容明细，不匹配边指出差异字段', () => {
  const graph = mismatchedChain();
  const report = portReport(graph);
  assert.equal(report.length, 1);
  assert.equal(report[0].compatible, false);
  assert.match(report[0].detail, /不匹配字段/);
  assert.match(report[0].detail, /pitchXMm/);

  const fixed = insertAdapterForEdge(graph, 'e1', factory()).graph;
  const fixedReport = portReport(fixed);
  assert.equal(fixedReport.length, 2);
  assert.ok(fixedReport.every((line) => line.compatible));
  assert.ok(fixedReport.every((line) => line.detail === '端口全字段匹配'));
});
