import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateFlow } from '../../src/machine/flow.ts';
import {
  axisSizing,
  costSummary,
  graphFlowModel,
  machineMetrics,
  railMomentCheck,
  screwSizing,
  selectPrimaryAxis
} from '../../src/canvas/metrics.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function port(overrides = {}) {
  return { family: 'grid', holeDiaMm: 6.6, pitchXMm: 50, pitchYMm: 50, count: 4, ...overrides };
}

const SLIDER_PORT = port({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60 });

function node(id, overrides = {}) {
  return {
    id,
    kind: 'linear',
    partId: `part-${id}`,
    name: `节点${id}`,
    spec: '',
    portIn: port(),
    portOut: SLIDER_PORT,
    strokeMm: 300,
    leadMm: 10,
    massKg: 5,
    stepSec: 0.4,
    dimsMm: [400, 80, 70],
    io: { di: 2, do: 1, desc: '' },
    pos: { x: 0, y: 0 },
    ortho: { x: 0, y: 0 },
    ...overrides
  };
}

function chainOf(specs, extra = {}) {
  const nodes = specs.map((spec, index) => {
    const current = node(spec.id, spec);
    if (index > 0) {
      const previous = specs[index - 1];
      current.portIn = node(previous.id, previous).portOut;
    }
    return current;
  });
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({ id: `e${index + 1}`, from: nodes[index].id, to: nodes[index + 1].id });
  }
  return { schemeId: 'scheme-metrics', nodes, edges, ...extra };
}

const noPrice = () => null;
const near = (actual, expected, tolerance = 1e-4, label = '') => {
  const relative = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
  assert.ok(
    relative <= tolerance,
    `${label} 实测 ${actual} 与手算 ${expected} 偏差 ${(relative * 100).toFixed(4)}%`
  );
};

// ---------------------------------------------------------------------------
// CT / UPH：必须走 evaluateFlow
// ---------------------------------------------------------------------------

test('machineMetrics：dial 布局 CT 与 evaluateFlow 同 brief 完全一致（不是 ΣstepSec）', () => {
  const graph = chainOf(
    [
      { id: 'A', stepSec: 0.5 },
      { id: 'B', stepSec: 0.4 },
      { id: 'C', stepSec: 0.3 }
    ],
    { layout: 'dial', indexSeconds: 0.6 }
  );
  const options = { priceLookup: noPrice };
  const model = graphFlowModel(graph, options);
  const expected = evaluateFlow(model);
  const metrics = machineMetrics(graph, options);

  assert.equal(model.layout, 'dial');
  assert.equal(model.ops.length, 3);
  assert.equal(metrics.cycleSeconds, Number(expected.cycleSeconds.toFixed(3)));
  assert.equal(metrics.throughputPerMin, Number(expected.throughputPerMin.toFixed(3)));
  assert.equal(metrics.unitsPerHour, Math.round(expected.throughputPerMin * 60));
  assert.equal(metrics.flow.mode, 'dial');
  assert.equal(metrics.flow.bottleneck.station, 0);

  const serialSum = 0.5 + 0.4 + 0.3;
  assert.equal(Number(serialSum.toFixed(3)), 1.2);
  assert.notEqual(metrics.cycleSeconds, Number(serialSum.toFixed(3)), 'CT 不能退化成 ΣstepSec');
  assert.equal(metrics.cycleSeconds, 1.1, 'dial：瓶颈工位 0.5 + 分度 0.6');
});

test('machineMetrics：parallel 布局按并行副本分摊，ΣstepSec 会算慢', () => {
  const graph = chainOf(
    [
      { id: 'A', stepSec: 0.5 },
      { id: 'B', stepSec: 0.5 }
    ],
    { layout: 'parallel' }
  );
  const options = { priceLookup: noPrice };
  const expected = evaluateFlow(graphFlowModel(graph, options));
  const metrics = machineMetrics(graph, options);
  assert.equal(metrics.cycleSeconds, Number(expected.cycleSeconds.toFixed(3)));
  assert.equal(metrics.cycleSeconds, 0.5);
  assert.notEqual(metrics.cycleSeconds, 1);
  assert.equal(metrics.unitsPerHour, Math.round(expected.throughputPerMin * 60));
});

test('machineMetrics：显式注入 FlowModel 优先于图上 layout 推导', () => {
  const graph = chainOf([{ id: 'A', stepSec: 0.5 }, { id: 'B', stepSec: 0.5 }], { layout: 'single' });
  const flow = {
    layout: 'linear',
    stations: 2,
    transferSeconds: 0.2,
    ops: [
      { id: 'A', name: 'A', seconds: 0.5, station: 0 },
      { id: 'B', name: 'B', seconds: 0.4, station: 1 }
    ]
  };
  const metrics = machineMetrics(graph, { priceLookup: noPrice, flow });
  const expected = evaluateFlow(flow);
  assert.equal(metrics.cycleSeconds, Number(expected.cycleSeconds.toFixed(3)));
  assert.equal(metrics.flow.mode, 'linear');
  assert.equal(metrics.cycleSeconds, 0.7, 'linear：max(0.5,0.4) + 转移 0.2');
});

test('graphFlowModel：缺省每节点一个工位，节点显式 station 可覆盖', () => {
  const graph = chainOf([
    { id: 'A', stepSec: 0.5, station: 0 },
    { id: 'B', stepSec: 0.4, station: 0 },
    { id: 'C', stepSec: 0.3, station: 1 }
  ], { layout: 'linear', transferSeconds: 0.1 });
  const model = graphFlowModel(graph, { priceLookup: noPrice });
  assert.deepEqual(model.ops.map((op) => op.station), [0, 0, 1]);
  assert.equal(model.stations, 2);
  assert.equal(model.transferSeconds, 0.1);

  const single = graphFlowModel(
    chainOf([{ id: 'A', stepSec: 0.5 }, { id: 'B', stepSec: 0.4 }]),
    { priceLookup: noPrice }
  );
  assert.equal(single.layout, 'single');
  assert.equal(single.stations, 1);
  assert.deepEqual(single.ops.map((op) => op.station), [0, 0]);
});

test('machineMetrics：没有运动节点时不编造 CT，flow=null 并给出说明', () => {
  const graph = chainOf([{ id: 'FRAME', stepSec: 0, strokeMm: 0, leadMm: 0, massKg: 48 }]);
  const metrics = machineMetrics(graph, { priceLookup: noPrice });
  assert.equal(metrics.flow, null);
  assert.equal(metrics.cycleSeconds, 0);
  assert.equal(metrics.unitsPerHour, 0);
  assert.ok(metrics.notes.some((note) => note.includes('不适用')));
});

// ---------------------------------------------------------------------------
// 成本：只认注入 lookup
// ---------------------------------------------------------------------------

test('costSummary：缺价的节点不进总额，进待询价清单', () => {
  const nodes = [
    node('A', { partId: 'part-A' }),
    node('B', { partId: 'part-B' }),
    node('C', { partId: undefined }),
    node('AD', { kind: 'adapter', adapter: true, partId: undefined, name: '转接板', massKg: 0.42, stepSec: 0 })
  ];
  const graph = { schemeId: 's', nodes, edges: [] };
  const summary = costSummary(graph, (partId) => (partId === 'part-A' ? 3450 : null));

  assert.equal(summary.totalYuan, 3450);
  assert.equal(summary.pricedNodes, 1);
  assert.equal(summary.pendingQuote.length, 3);
  assert.equal(summary.complete, false);
  assert.match(summary.label, /不完全统计/);
  assert.match(summary.label, /3 项待询价/);
  assert.ok(summary.pendingQuote.some((item) => item.reason.includes('待选型')));
  assert.ok(summary.pendingQuote.some((item) => item.reason.includes('查不到')));
  assert.ok(summary.pendingQuote.every((item) => Number.isFinite(item.qty) && item.qty > 0));
});

test('costSummary：全部查得到价时 complete=true，总额为注入价之和', () => {
  const graph = {
    schemeId: 's',
    nodes: [node('A', { partId: 'part-A' }), node('B', { partId: 'part-B' })],
    edges: []
  };
  const summary = costSummary(graph, (partId) => (partId === 'part-A' ? 1000 : 250.5));
  assert.equal(summary.totalYuan, 1250.5);
  assert.equal(summary.complete, true);
  assert.equal(summary.label, '价格齐全');
  assert.deepEqual(summary.pendingQuote, []);
});

test('costSummary：priceLookup 未注入直接抛中文错误（禁止内置单价）', () => {
  assert.throws(
    () => costSummary({ schemeId: 's', nodes: [], edges: [] }, undefined),
    /priceLookup 必须由调用方注入/
  );
});

// ---------------------------------------------------------------------------
// 单轴伺服选型
// ---------------------------------------------------------------------------

test('axisSizing：梯形曲线 → 惯量 → 扭矩 → 挠度，与手算逐项对齐', () => {
  const axis = node('X', { strokeMm: 450, leadMm: 10, stepSec: 0.55, massKg: 12 });
  const carriedMassKg = 12;
  const result = axisSizing(axis, carriedMassKg, 0.55);

  // 手算：加速 25%、匀速 50%、减速 25%
  const tAcc = 0.25 * 0.55;
  const tConst = 0.55 - 2 * tAcc;
  const vMax = 0.45 / (tAcc + tConst);
  const accel = vMax / tAcc;
  const maxRpm = (vMax / 0.01) * 60;
  const omega = (maxRpm * 2 * Math.PI) / 60;
  const alpha = omega / tAcc;
  const screwDiaM = 0.016;
  const screwLengthM = 0.55;
  const jScrew = (Math.PI / 32) * 7850 * screwLengthM * screwDiaM ** 4;
  const jLoad = carriedMassKg * (0.01 / (2 * Math.PI)) ** 2 + jScrew;
  const rotor = 1.2e-5;
  const frictionForce = 0.05 * carriedMassKg * 9.80665 + 10;
  const tFriction = (frictionForce * 0.01) / (2 * Math.PI * 0.9);
  const tAccel = (jLoad + rotor) * alpha;
  const tPeak = tAccel + tFriction;
  const tRms = Math.sqrt((tPeak ** 2 * 2 * tAcc + tFriction ** 2 * tConst) / 0.55);
  const inertiaM4 = ((60 * 60 ** 3) / 12) * 1e-12;
  const deflectionMm = ((carriedMassKg * 9.80665 * 0.3 ** 3) / (3 * 70e9 * inertiaM4)) * 1000;

  near(result.tAccelSec, tAcc, 1e-5, 'tAccelSec');
  near(result.tConstSec, tConst, 1e-5, 'tConstSec');
  near(result.vMaxMs, vMax, 1e-5, 'vMaxMs');
  near(result.accelMs2, accel, 1e-4, 'accelMs2');
  near(result.maxRpm, maxRpm, 1e-4, 'maxRpm');
  near(result.omegaMaxRadS, omega, 1e-4, 'omegaMaxRadS');
  near(result.alphaRadS2, alpha, 1e-4, 'alphaRadS2');
  near(result.jScrewKgM2, jScrew, 1e-4, 'jScrewKgM2');
  near(result.jLoadKgM2, jLoad, 1e-4, 'jLoadKgM2');
  near(result.inertiaRatio, jLoad / rotor, 1e-3, 'inertiaRatio');
  near(result.frictionForceN, frictionForce, 1e-6, 'frictionForceN');
  near(result.tFrictionNm, tFriction, 1e-4, 'tFrictionNm');
  near(result.tPeakNm, tPeak, 1e-4, 'tPeakNm');
  near(result.tRmsNm, tRms, 1e-4, 'tRmsNm');
  near(result.deflectionMm, deflectionMm, 1e-4, 'deflectionMm');

  assert.ok(result.tPeakNm >= result.tRmsNm, '峰值扭矩必须不小于 RMS 扭矩');
  assert.ok(result.pass, `应通过：${result.verdict}`);
  assert.ok(result.formulas.length >= 6);
  assert.ok(result.formulas.some((line) => line.includes('v_max')));
  assert.ok(result.formulas.some((line) => line.includes('δ')));
});

test('axisSizing：分段时间闭合，惯量比超限时 pass=false 且指出原因', () => {
  const axis = node('X', { strokeMm: 300, leadMm: 5, stepSec: 0.3 });
  const result = axisSizing(axis, 40, 0.3, { rotorInertiaKgM2: 5e-6, inertiaRatioLimit: 5 });
  near(result.tAccelSec * 2 + result.tConstSec, 0.3, 1e-6, '分段时间和');
  assert.ok(result.inertiaRatio > 5);
  assert.equal(result.checks.inertiaOk, false);
  assert.equal(result.pass, false);
  assert.match(result.verdict, /惯量比/);
});

test('axisSizing：悬臂挠度超限单独判定，反馈加大截面', () => {
  const axis = node('X', { strokeMm: 300, leadMm: 10, stepSec: 0.4 });
  const result = axisSizing(axis, 30, 0.4, { deflectionLimitMm: 0.005, sectionWidthMm: 20, sectionHeightMm: 20 });
  assert.equal(result.checks.deflectionOk, false);
  assert.match(result.verdict, /挠度/);
  assert.match(result.verdict, /加大截面/);
});

test('axisSizing：非法输入一律抛中文错误', () => {
  const axis = node('X');
  assert.throws(() => axisSizing(node('X', { strokeMm: 0 }), 5, 0.4), /行程/);
  assert.throws(() => axisSizing(node('X', { leadMm: 0 }), 5, 0.4), /导程/);
  assert.throws(() => axisSizing(axis, 5, 0), /单步时间/);
  assert.throws(() => axisSizing(axis, -1, 0.4), /负载质量/);
  assert.throws(() => axisSizing(axis, 5, 0.4, { accelTimeRatio: 0.5 }), /加速段时间占比/);
  assert.throws(() => axisSizing(axis, 5, 0.4, { efficiency: 1.2 }), /传动效率/);
});

// ---------------------------------------------------------------------------
// 整机指标组装
// ---------------------------------------------------------------------------

test('machineMetrics：主运动轴取最大行程节点，负载质量按下游质量累加', () => {
  const graph = chainOf([
    { id: 'A', strokeMm: 450, leadMm: 10, massKg: 9, stepSec: 0.55 },
    { id: 'B', strokeMm: 300, leadMm: 10, massKg: 5, stepSec: 0.45 },
    { id: 'C', strokeMm: 0, leadMm: 0, massKg: 0.4, stepSec: 0 }
  ]);
  assert.equal(selectPrimaryAxis(graph).id, 'A');
  const metrics = machineMetrics(graph, { priceLookup: noPrice });
  assert.equal(metrics.primaryAxis.nodeId, 'A');
  assert.equal(metrics.primaryAxis.sizing.carriedMassKg, 5.4);
  assert.ok(metrics.notes.some((note) => note.includes('主运动轴')));
  assert.equal(metrics.nodeCount, 3);
  assert.equal(metrics.adapterCount, 0);
  assert.equal(metrics.mismatchCount, 0, '夹具链端口全匹配，不应有残留不匹配边');
});

test('machineMetrics：转接板计入 adapterCount 且缺价进待询价', () => {
  const graph = chainOf([
    { id: 'A', strokeMm: 450, leadMm: 10, stepSec: 0.5 },
    { id: 'B', strokeMm: 300, leadMm: 10, stepSec: 0.4 }
  ]);
  // 人为插入一个转接板节点，模拟插图后的图
  const adapter = node('AD', {
    kind: 'adapter',
    adapter: true,
    partId: undefined,
    name: '转接板',
    portIn: SLIDER_PORT,
    portOut: SLIDER_PORT,
    massKg: 0.42,
    stepSec: 0,
    strokeMm: 0,
    leadMm: 0
  });
  const withAdapter = {
    ...graph,
    nodes: [graph.nodes[0], adapter, graph.nodes[1]],
    edges: [
      { id: 'e1', from: 'A', to: 'AD' },
      { id: 'e2', from: 'AD', to: 'B' }
    ]
  };
  const metrics = machineMetrics(withAdapter, { priceLookup: (partId) => (partId === 'part-A' ? 3450 : null) });
  assert.equal(metrics.adapterCount, 1);
  assert.equal(metrics.mismatchCount, 0);
  assert.equal(metrics.cost.totalYuan, 3450);
  assert.ok(metrics.cost.pendingQuote.some((item) => item.nodeId === 'AD'));
  assert.ok(metrics.notes.some((note) => note.includes('不完全统计')));
});


// ---------------------------------------------------------------------------
// 丝杠临界转速 / 压杆稳定 / DN，导轨倾覆力矩
// ---------------------------------------------------------------------------

test('screwSizing：临界转速、压杆稳定、DN 与手算对齐', () => {
  const axis = node('X', { strokeMm: 450, leadMm: 10, stepSec: 0.55 });
  const result = screwSizing(axis, { screwDiaMm: 16, rootDiaMm: 13, lengthMm: 550, endFixity: 'fixed-supported', maxRpm: 4800, axialLoadN: 2000 });

  const rootM = 0.013;
  const lengthM = 0.55;
  const I = (Math.PI * rootM ** 4) / 64;
  const A = (Math.PI * rootM ** 2) / 4;
  const E = 206e9;
  const rho = 7850;
  const beta = 3.927;
  const k = 0.707;
  const omega = ((beta ** 2) / lengthM ** 2) * Math.sqrt((E * I) / (rho * A));
  const nCr = (omega * 60) / (2 * Math.PI);
  const pCr = (Math.PI ** 2 * E * I) / ((k * lengthM) ** 2);

  near(result.criticalSpeedRpm, nCr, 1e-3, 'criticalSpeedRpm');
  near(result.allowableSpeedRpm, nCr * 0.8, 1e-3, 'allowableSpeedRpm');
  assert.equal(result.dnSpeedRpm, 80000 / 16);
  assert.equal(result.speedLimitRpm, Math.min(Number((nCr * 0.8).toFixed(1)), 5000));
  near(result.bucklingLoadN, pCr, 1e-3, 'bucklingLoadN');
  near(result.bucklingAllowableN, pCr / 2.5, 1e-3, 'bucklingAllowableN');
  assert.equal(result.dnValue, 4800 * 16);
  assert.equal(result.checks.dnOk, true);
  assert.equal(result.checks.criticalSpeedOk, true);
  assert.equal(result.checks.bucklingOk, true);
  assert.equal(result.pass, true);
  assert.match(result.formulas.join('\n'), /n_cr/);
});

test('screwSizing：超转速 / 超压杆载荷时 pass=false 并指出原因', () => {
  const axis = node('X', { strokeMm: 800, leadMm: 5, stepSec: 0.3 });
  const result = screwSizing(axis, {
    screwDiaMm: 16,
    rootDiaMm: 13,
    lengthMm: 900,
    endFixity: 'fixed-free',
    maxRpm: 9000,
    axialLoadN: 40000
  });
  assert.equal(result.checks.criticalSpeedOk, false);
  assert.equal(result.checks.bucklingOk, false);
  assert.equal(result.pass, false);
  assert.match(result.verdict, /不满足/);
  assert.match(result.verdict, /转速/);
  assert.match(result.verdict, /轴向载荷/);
});

test('screwSizing：不给转速/轴向载荷时只给允许值，pass=null 不装通过', () => {
  const result = screwSizing(node('X', { strokeMm: 300 }));
  assert.equal(result.pass, null);
  assert.equal(result.checks.criticalSpeedOk, null);
  assert.equal(result.checks.bucklingOk, null);
  assert.match(result.verdict, /不做通过判定/);
  assert.ok(result.speedLimitRpm > 0);
});

test('screwSizing：非法输入抛中文错误', () => {
  assert.throws(() => screwSizing(node('X'), { rootDiaMm: 20, screwDiaMm: 16 }), /螺纹底径/);
  assert.throws(() => screwSizing(node('X'), { endFixity: 'magic' }), /端部支撑方式/);
  assert.throws(() => screwSizing(node('X'), { criticalSpeedDerate: 1.5 }), /降额系数/);
  assert.throws(() => screwSizing(node('X'), { axialLoadN: -1 }), /轴向载荷/);
});

test('railMomentCheck：三向力矩与手算一致，缺额定值时 pass=null', () => {
  const result = railMomentCheck({ loadKg: 12, offsetXMm: 80, offsetYMm: 40, offsetZMm: 150, externalForceN: 100, horizontalForceN: 50 });
  const Fv = 12 * 9.80665 + 100;
  near(result.verticalForceN, Fv, 1e-6, 'verticalForceN');
  near(result.pitchNm, (Fv * 0.08), 1e-3, 'pitchNm');
  near(result.rollNm, (Fv * 0.04), 1e-3, 'rollNm');
  near(result.yawNm, 50 * 0.15, 1e-3, 'yawNm');
  assert.equal(result.pass, null);
  assert.match(result.verdict, /不做通过判定/);
});

test('railMomentCheck：给了样本额定值才判定，超限明确指出', () => {
  const ok = railMomentCheck({
    loadKg: 12, offsetXMm: 80, offsetYMm: 40, offsetZMm: 150, externalForceN: 100, horizontalForceN: 50,
    allowableNm: { pitch: 20, roll: 8, yaw: 10 }
  });
  assert.equal(ok.checks.pitch, true);
  assert.equal(ok.checks.roll, false);
  assert.equal(ok.pass, false);
  assert.match(ok.verdict, /加大导轨规格/);

  const pass = railMomentCheck({ loadKg: 5, offsetXMm: 20, allowableNm: { pitch: 20, roll: 20, yaw: 20 } });
  assert.equal(pass.pass, true);
});

test('railMomentCheck：非法输入抛中文错误', () => {
  assert.throws(() => railMomentCheck({ loadKg: -1 }), /负载质量/);
  assert.throws(() => railMomentCheck({ loadKg: 1, gravity: 0 }), /重力加速度/);
  assert.throws(() => railMomentCheck({ loadKg: 1, offsetXMm: -5 }), /X 偏置/);
});
