import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateFlow } from '../../src/machine/flow.ts';
import { findMismatchedEdges, insertAdapterForEdge, portDiff } from '../../src/canvas/graph.ts';
import { machineMetrics } from '../../src/canvas/metrics.ts';
import { CANVAS_PALETTE, demoCanvasGraph, paletteNode } from '../../src/canvas/demo-graph.ts';
import {
  adapterSpecPreview,
  buildArtboards,
  buildBomLines,
  buildGanttView,
  buildOrthoView,
  buildSummary,
  buildTopologyView,
  createDefaultAdapterFactory,
  formatPort,
  topologyDepth
} from '../../src/canvas/view-model.ts';

const noPrice = () => null;

function graphOf(nodes, edges, extra = {}) {
  return { schemeId: 'vm-test', nodes, edges, ...extra };
}

test('topologyDepth：链式深度递进，分支各自成列，环不死循环', () => {
  const demo = demoCanvasGraph();
  const depth = topologyDepth(demo);
  assert.equal(depth.get('FRAME'), 0);
  assert.equal(depth.get('AXIS-X'), 1);
  assert.equal(depth.get('AXIS-Y'), 2);
  assert.equal(depth.get('AXIS-Z'), 3);
  assert.equal(depth.get('GRIP'), 4);
  assert.equal(depth.get('CAM'), 1, 'CAM 与 X 轴同列（都挂在机架上）');

  const cyclic = graphOf(
    [
      { ...demo.nodes[0], id: 'A' },
      { ...demo.nodes[1], id: 'B' }
    ],
    [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'B', to: 'A' }
    ]
  );
  const cyclicDepth = topologyDepth(cyclic);
  assert.equal(cyclicDepth.size, 2, '环图也要给每个节点一个深度');
  assert.ok([...cyclicDepth.values()].every((value) => Number.isInteger(value) && value >= 0));
});

test('buildTopologyView：节点不重叠、边端点落在卡片边缘、演示图有 1 条不匹配', () => {
  const demo = demoCanvasGraph();
  const view = buildTopologyView(demo);
  assert.equal(view.nodes.length, demo.nodes.length);
  assert.equal(view.edges.length, demo.edges.length);
  assert.equal(view.mismatchCount, 1);
  assert.equal(view.adapterCount, 0);

  for (let i = 0; i < view.nodes.length; i += 1) {
    for (let j = i + 1; j < view.nodes.length; j += 1) {
      const a = view.nodes[i];
      const b = view.nodes[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 0 || overlapY <= 0, `${a.id} 与 ${b.id} 卡片重叠`);
    }
  }

  const mismatchEdge = view.edges.find((edge) => edge.mismatched);
  assert.ok(mismatchEdge, '演示图的 Y→Z 边必须标成不匹配');
  assert.equal(mismatchEdge.id, 'e-y-z');
  assert.deepEqual(mismatchEdge.diffFields, ['family', 'pitchXMm', 'pitchYMm']);

  for (const edge of view.edges) {
    const from = view.nodes.find((node) => node.id === edge.from);
    const to = view.nodes.find((node) => node.id === edge.to);
    assert.ok(from && to);
    assert.equal(edge.d.startsWith('M '), true);
    assert.ok(edge.d.includes(`${from.x + from.width}`), '边必须从上游卡片右边缘出发');
    assert.ok(edge.d.includes(`${to.x}`), '边必须落到下游卡片左边缘');
  }
});

test('formatPort：孔阵列写孔距×孔数，单孔写「单孔」', () => {
  const demo = demoCanvasGraph();
  const frame = demo.nodes.find((node) => node.id === 'FRAME');
  const grip = demo.nodes.find((node) => node.id === 'GRIP');
  assert.match(formatPort(frame.portOut), /网格面\(grid\) · Ø6\.6 · 50×50mm · 4 孔/);
  assert.match(formatPort(grip.portOut), /末端\(tip\) · Ø0 · 单孔 · 0 孔/);
});

test('buildOrthoView：站点数、包络按行程展开、投影重叠只做布局提示', () => {
  const demo = demoCanvasGraph();
  const view = buildOrthoView(demo);
  assert.equal(view.stations.length, demo.nodes.length);
  const axisX = view.stations.find((station) => station.id === 'AXIS-X');
  assert.equal(axisX.envelopeWidthMm, axisX.mmWidth + 450, 'X 轴包络 = 外形 + 行程');
  assert.equal(axisX.envelopeHeightMm, axisX.mmHeight);
  const adapter = view.stations.find((station) => station.adapter);
  assert.equal(adapter, undefined, '演示图还没插板');

  assert.ok(view.stations.every((station) => station.x >= 0 && station.y >= 0));
  assert.ok(view.boundsMm.maxX > view.boundsMm.minX);
  assert.ok(view.notes.some((note) => note.includes('平面投影') || note.includes('无重叠')));
  assert.equal(view.notes.some((note) => note.includes('干涉结论') && !note.includes('非')), false, '不得把 AABB 说成干涉结论');
});

test('buildOrthoView：空图给出明确说明而不是 0 尺寸画布', () => {
  const view = buildOrthoView(graphOf([], []));
  assert.equal(view.stations.length, 0);
  assert.ok(view.width > 0 && view.height > 0);
  assert.ok(view.notes[0].includes('没有节点'));
});

test('buildGanttView：排除转接板与无节拍节点，比例和为 1，说明里点明不是产能口径', () => {
  const demo = demoCanvasGraph();
  const view = buildGanttView(demo);
  assert.equal(view.rows.length, 5, 'FRAME 无节拍，不进行');
  assert.ok(view.rows.every((row) => row.stepSec > 0));
  const total = view.rows.reduce((sum, row) => sum + row.durationSec, 0);
  assert.equal(Number(total.toFixed(3)), view.totalSec);
  const ratioSum = view.rows.reduce((sum, row) => sum + row.widthRatio, 0);
  assert.ok(Math.abs(ratioSum - 1) < 1e-9);
  assert.match(view.note, /evaluateFlow/);
  assert.equal(view.rows[0].startSec, 0);
  assert.ok(view.rows[1].startSec > 0);
});

test('buildSummary：CT 来自 evaluateFlow，价格全缺时总额 0 且全部待询价', () => {
  const demo = demoCanvasGraph();
  const summary = buildSummary(demo, { priceLookup: noPrice });
  const flow = evaluateFlow({
    layout: 'linear',
    stations: 5,
    transferSeconds: 0.2,
    ops: demo.nodes
      .filter((node) => node.stepSec > 0)
      .map((node, index) => ({ id: node.id, name: node.name, seconds: node.stepSec, station: index }))
  });
  assert.equal(summary.cycleSeconds, Number(flow.cycleSeconds.toFixed(3)));
  assert.equal(summary.unitsPerHour, Math.round(flow.throughputPerMin * 60));
  assert.equal(summary.totalCostYuan, 0);
  assert.equal(summary.pendingQuoteCount, demo.nodes.length);
  assert.equal(summary.costComplete, false);
  assert.equal(summary.mismatchCount, 1);
  assert.ok(summary.primaryAxis, '演示图有丝杠模组，必须有主运动轴选型');
  assert.equal(summary.primaryAxis.nodeId, 'AXIS-X', '行程最大（450mm）');
  assert.match(summary.bottleneck, /工位/);
});

test('buildSummary：注入价格后只累加查得到价的节点', () => {
  const demo = demoCanvasGraph();
  const summary = buildSummary(demo, {
    priceLookup: (partId) => (partId === 'linear-kk86-450' ? 3450 : null)
  });
  assert.equal(summary.totalCostYuan, 3450);
  assert.equal(summary.pendingQuoteCount, demo.nodes.length - 1);
  assert.equal(summary.costComplete, false);
});

test('buildArtboards：三种口径同一拓扑，CT 顺序 single > dial > linear', () => {
  const demo = demoCanvasGraph();
  const boards = buildArtboards(demo, { priceLookup: noPrice });
  assert.deepEqual(boards.map((board) => board.layout), ['single', 'linear', 'dial']);
  const [single, linear, dial] = boards;
  assert.ok(single.cycleSeconds > dial.cycleSeconds, `${single.cycleSeconds} 应大于 ${dial.cycleSeconds}`);
  assert.ok(dial.cycleSeconds > linear.cycleSeconds, `${dial.cycleSeconds} 应大于 ${linear.cycleSeconds}`);
  assert.equal(single.cycleSeconds, 1.85, '单工位串行 = ΣstepSec');
  assert.equal(linear.cycleSeconds, 0.75, '最慢工位 0.55 + 转移 0.2');
  assert.equal(dial.cycleSeconds, 1.15, '最慢工位 0.55 + 分度 0.6');
  assert.ok(boards.every((board) => board.pendingQuoteCount === demo.nodes.length));
  assert.ok(boards.every((board) => board.note.length > 0));
});

test('createDefaultAdapterFactory：尺寸由两端孔距算，价格恒为 null', () => {
  const factory = createDefaultAdapterFactory({ dowelDiaMm: 4 });
  const demo = demoCanvasGraph();
  const edge = demo.edges.find((item) => item.id === 'e-y-z');
  const from = demo.nodes.find((node) => node.id === edge.from);
  const to = demo.nodes.find((node) => node.id === edge.to);
  const spec = factory({
    edge,
    from,
    to,
    fromPort: from.portOut,
    toPort: to.portIn,
    diffFields: portDiff(from.portOut, to.portIn),
    existingIds: demo.nodes.map((node) => node.id)
  });
  assert.deepEqual(spec.plateDimsMm, [90, 90, 12], 'max(60,48)+2×15 / max(60,36)+2×15');
  assert.equal(spec.thicknessMm, 12);
  assert.equal(spec.material, '6061-T6');
  assert.equal(spec.costYuan, null, '禁止内置单价');
  const volume = (90 * 90 * 12) / 1e9;
  assert.ok(Math.abs(spec.massKg - volume * 2700) < 0.002);
  assert.equal(spec.dowelDiaMm, 4);
  assert.equal(spec.counterBore, true);
});

test('adapterSpecPreview：只在不匹配边上给预览，匹配边返回 null', () => {
  const demo = demoCanvasGraph();
  const preview = adapterSpecPreview(demo, 'e-y-z');
  assert.ok(preview);
  assert.deepEqual(preview.plateDimsMm, [90, 90, 12]);
  assert.equal(adapterSpecPreview(demo, 'e-x-y'), null, '匹配的边不得给转接板预览');
  assert.equal(adapterSpecPreview(demo, 'e-missing'), null);
});

test('插板后：拓扑视图不再有不匹配边，adapter 卡片带橙色标记', () => {
  const demo = demoCanvasGraph();
  const result = insertAdapterForEdge(demo, 'e-y-z', createDefaultAdapterFactory());
  const view = buildTopologyView(result.graph);
  assert.equal(view.mismatchCount, 0);
  assert.equal(view.adapterCount, 1);
  const adapterBox = view.nodes.find((node) => node.adapter);
  assert.ok(adapterBox);
  assert.equal(adapterBox.mismatch, false);
  assert.match(adapterBox.name, /转接板/);
});

test('buildBomLines：无价源全部待询价，有价源按 partId 命中', () => {
  const demo = demoCanvasGraph();
  const pending = buildBomLines(demo, noPrice);
  assert.equal(pending.length, demo.nodes.length);
  assert.ok(pending.every((line) => line.priceState === 'pending'));
  const priced = buildBomLines(demo, (partId) => (partId === 'frame-4040-800x650' ? 3200 : null));
  assert.equal(priced.filter((line) => line.priceState === 'priced').length, 1);
  assert.equal(priced.find((line) => line.priceState === 'priced').partId, 'frame-4040-800x650');
});

test('模组库：模板不带价格；绑型号的必须能在价格簿里查价，没绑的就是待选型', () => {
  assert.ok(CANVAS_PALETTE.length >= 4);
  for (const item of CANVAS_PALETTE) {
    assert.equal('cost' in item, false, `${item.id} 不得内置价格`);
    assert.equal('price' in item, false, `${item.id} 不得内置价格`);
    if (item.partId !== undefined) assert.equal(typeof item.partId, 'string');
  }
  // 至少留一个「待选型」模板，避免所有模组都假装有型号
  assert.ok(CANVAS_PALETTE.some((item) => item.partId === undefined));
  const unbound = CANVAS_PALETTE.find((item) => item.partId === undefined);
  const node = paletteNode(unbound, 'n1', { x: 10, y: 20 }, { x: 30, y: 40 });
  assert.equal(node.partId, undefined);
  assert.deepEqual(node.pos, { x: 10, y: 20 });
  assert.deepEqual(node.ortho, { x: 30, y: 40 });
  const lines = buildBomLines(graphOf([node], []), noPrice);
  assert.equal(lines[0].priceState, 'pending');
  assert.equal(lines[0].partId, null);

  // 绑了型号的模板：型号透传到节点，价格仍然只能由 priceLookup 决定
  const bound = CANVAS_PALETTE.find((item) => item.partId !== undefined);
  assert.ok(bound, '至少有一个绑定真实型号的模板');
  const boundNode = paletteNode(bound, 'n2', { x: 0, y: 0 }, { x: 0, y: 0 });
  assert.equal(boundNode.partId, bound.partId);
  const priced = buildBomLines(graphOf([boundNode], []), (partId) => (partId === bound.partId ? 1109 : null));
  assert.equal(priced[0].priceState, 'priced');
});

test('演示图自身：只有 Y→Z 一条不匹配，且机器指标与 metrics 一致', () => {
  const demo = demoCanvasGraph();
  const mismatches = findMismatchedEdges(demo);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].edgeId, 'e-y-z');
  const metrics = machineMetrics(demo, { priceLookup: noPrice });
  const summary = buildSummary(demo, { priceLookup: noPrice });
  assert.equal(summary.cycleSeconds, metrics.cycleSeconds);
  assert.equal(summary.unitsPerHour, metrics.unitsPerHour);
});
