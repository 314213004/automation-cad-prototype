import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAdjacency,
  findMismatchedEdges,
  graphConsistencyIssues,
  insertAdapterForEdge,
  insertAdaptersForAllMismatches,
  normalizeGraph,
  portDiff,
  portsCompatible,
  removeNode
} from '../../src/canvas/graph.ts';

// ---------------------------------------------------------------------------
// 夹具：端口全结构化，任何"字符串端口"都不允许出现在测试里
// ---------------------------------------------------------------------------

function port(overrides = {}) {
  return { family: 'grid', holeDiaMm: 6.6, pitchXMm: 50, pitchYMm: 50, count: 4, ...overrides };
}

const SLIDER_PORT = port({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 });
const BODY_PORT = port({ family: 'body', holeDiaMm: 5.5, pitchXMm: 48, pitchYMm: 36, count: 4 });
const GRID_PORT = port();

function node(id, overrides = {}) {
  return {
    id,
    kind: 'linear',
    partId: `part-${id}`,
    name: `节点${id}`,
    spec: '',
    portIn: port(),
    portOut: port({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60 }),
    strokeMm: 300,
    leadMm: 10,
    massKg: 5,
    stepSec: 0.4,
    dimsMm: [400, 80, 70],
    io: { di: 2, do: 1, desc: '' },
    pos: { x: 100, y: 100 },
    ortho: { x: 0, y: 0 },
    ...overrides
  };
}

function graphOf(nodes, edges, extra = {}) {
  return { schemeId: 'scheme-test', nodes, edges, ...extra };
}

/** 转接板工厂：尺寸/质量/询价全由测试显式给，模块内没有任何单价。 */
function factory(overrides = {}) {
  return () => ({
    plateDimsMm: [92, 76, 12],
    thicknessMm: 12,
    massKg: 0.42,
    costYuan: null,
    ...overrides
  });
}

function editChain(stepSec, extra = {}) {
  // 一条匹配链：A(slider 出) → B(slider 进/body 出)? 这里用显式端口保证匹配
  const a = node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT, pos: { x: 0, y: 0 }, ortho: { x: 0, y: 0 } });
  const b = node('B', { portIn: SLIDER_PORT, portOut: BODY_PORT, pos: { x: 260, y: 0 }, ortho: { x: 300, y: 0 } });
  return graphOf([a, b], [{ id: 'e1', from: 'A', to: 'B' }], extra);
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

test('normalizeGraph：重复 id / 孤儿边 / 自环 / 非法边全部清理，入边出边一致', () => {
  const a = node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT });
  const aDup = node('A', { name: '重复的A' });
  const b = node('B', { portIn: SLIDER_PORT, portOut: BODY_PORT });
  const input = graphOf(
    [a, aDup, b],
    [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e-orphan', from: 'A', to: '幽灵节点' },
      { id: 'e-loop', from: 'A', to: 'A' },
      { id: '', from: 'A', to: 'B' }
    ]
  );

  const { graph, issues } = normalizeGraph(input);
  assert.deepEqual(graph.nodes.map((n) => n.id), ['A', 'B']);
  assert.deepEqual(graph.edges.map((e) => e.id), ['e1']);
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('DUPLICATE_NODE_ID'), `缺 DUPLICATE_NODE_ID：${codes.join(',')}`);
  assert.ok(codes.includes('ORPHAN_EDGE'), `缺 ORPHAN_EDGE：${codes.join(',')}`);
  assert.ok(codes.includes('SELF_LOOP'), `缺 SELF_LOOP：${codes.join(',')}`);
  assert.ok(codes.includes('INVALID_EDGE'), `缺 INVALID_EDGE：${codes.join(',')}`);
  // 每个 issue 都必须是中文人话，且提到具体 id
  for (const issue of issues) assert.match(issue.message, /[\u4e00-\u9fa5]/);

  const adjacency = buildAdjacency(graph);
  const outTotal = [...adjacency.outgoing.values()].reduce((sum, list) => sum + list.length, 0);
  const inTotal = [...adjacency.incoming.values()].reduce((sum, list) => sum + list.length, 0);
  assert.equal(outTotal, graph.edges.length);
  assert.equal(inTotal, graph.edges.length);
  assert.deepEqual([...adjacency.outgoing.keys()].sort(), ['A', 'B']);
});

test('normalizeGraph：同一对节点的重复连线只留一条', () => {
  const graph = graphOf(
    [node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT }), node('B', { portIn: SLIDER_PORT })],
    [
      { id: 'e1', from: 'A', to: 'B' },
      { id: 'e2', from: 'A', to: 'B' }
    ]
  );
  const { graph: normalized, issues } = normalizeGraph(graph);
  assert.equal(normalized.edges.length, 1);
  assert.ok(issues.some((issue) => issue.code === 'DUPLICATE_EDGE'));
});

test('normalizeGraph：纯函数，不改入参也不复用节点引用', () => {
  const input = editChain();
  const snapshot = JSON.parse(JSON.stringify(input));
  const { graph } = normalizeGraph(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(graph.nodes[0], input.nodes[0]);
  graph.nodes[0].pos.x = 999;
  assert.equal(input.nodes[0].pos.x, 0);
});

// ---------------------------------------------------------------------------
// 端口兼容
// ---------------------------------------------------------------------------

test('portsCompatible：全字段相等才兼容，任一字段不同即不兼容', () => {
  assert.equal(portsCompatible(GRID_PORT, port()), true);
  const mutations = {
    family: { family: 'slider' },
    holeDiaMm: { holeDiaMm: 5.5 },
    pitchXMm: { pitchXMm: 60 },
    pitchYMm: { pitchYMm: 48 },
    count: { count: 2 }
  };
  for (const [field, patch] of Object.entries(mutations)) {
    assert.equal(portsCompatible(GRID_PORT, port(patch)), false, `${field} 不同却判成兼容`);
    assert.deepEqual(portDiff(GRID_PORT, port(patch)), [field], `${field} 差异字段漏报`);
  }
});

test('portsCompatible：同 family 不同孔距不兼容（原型的 isPortCompatible 就错在这）', () => {
  const out = port({ family: 'slider', pitchXMm: 60, pitchYMm: 60 });
  const inPort = port({ family: 'slider', pitchXMm: 40, pitchYMm: 40 });
  assert.equal(out.family, inPort.family);
  assert.equal(portsCompatible(out, inPort), false);
});

test('findMismatchedEdges：不匹配的直连边必被报出且列出差异字段', () => {
  const a = node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT });
  const b = node('B', { portIn: port({ family: 'body', holeDiaMm: 4.5, pitchXMm: 48, pitchYMm: 36 }) });
  const graph = graphOf([a, b], [{ id: 'e1', from: 'A', to: 'B' }]);
  const mismatches = findMismatchedEdges(graph);
  assert.equal(mismatches.length, 1);
  const mismatch = mismatches[0];
  assert.equal(mismatch.edgeId, 'e1');
  assert.deepEqual(mismatch.diffFields, ['family', 'holeDiaMm', 'pitchXMm', 'pitchYMm']);
  assert.equal(mismatch.outPort.family, 'slider');
  assert.equal(mismatch.inPort.family, 'body');
  assert.match(mismatch.message, /不兼容/);
});

// ---------------------------------------------------------------------------
// 插转接板
// ---------------------------------------------------------------------------

test('insertAdapterForEdge：端口不匹配必出转接板，且两端端口参数写进 adapterParams', () => {
  const graph = editChain();
  const toPort = port({ family: 'body', holeDiaMm: 4.5, pitchXMm: 48, pitchYMm: 36 });
  graph.nodes[1].portIn = toPort;
  const result = insertAdapterForEdge(graph, 'e1', factory());

  assert.equal(result.inserted, true);
  assert.ok(result.adapterId);
  const adapter = result.graph.nodes.find((n) => n.id === result.adapterId);
  assert.ok(adapter, '缺 adapter 节点');
  assert.equal(adapter.kind, 'adapter');
  assert.equal(adapter.adapter, true);
  assert.deepEqual(adapter.portIn, SLIDER_PORT, 'adapter.portIn 必须等于上游 portOut');
  assert.deepEqual(adapter.portOut, toPort, 'adapter.portOut 必须等于下游 portIn');
  assert.deepEqual(adapter.adapterParams.fromPort, SLIDER_PORT);
  assert.deepEqual(adapter.adapterParams.toPort, toPort);
  assert.deepEqual(adapter.adapterParams.plateDimsMm, [92, 76, 12]);
  assert.equal(adapter.adapterParams.thicknessMm, 12);
  assert.equal(adapter.adapterParams.massKg, 0.42);
  assert.equal(adapter.adapterParams.costYuan, null, '缺价必须是 null 而不是 0');
  assert.equal(result.graph.edges.length, 2);
  assert.deepEqual(
    result.graph.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['A->' + result.adapterId, result.adapterId + '->B'].sort()
  );
});

test('insertAdapterForEdge：插完两端均匹配，整图无残留不匹配边', () => {
  const graph = editChain();
  graph.nodes[1].portIn = BODY_PORT;
  const result = insertAdapterForEdge(graph, 'e1', factory());
  assert.equal(findMismatchedEdges(result.graph).length, 0);
  const issues = graphConsistencyIssues(result.graph);
  assert.equal(issues.filter((issue) => issue.code === 'PORT_MISMATCH').length, 0);
  assert.equal(issues.filter((issue) => issue.code === 'ADAPTER_DEGREE').length, 0);
});

test('insertAdapterForEdge：端口已匹配不得插转接板', () => {
  const graph = editChain();
  const result = insertAdapterForEdge(graph, 'e1', factory());
  assert.equal(result.inserted, false);
  assert.equal(result.adapterId, null);
  assert.match(result.reason, /无需转接板/);
  assert.equal(result.graph.nodes.length, graph.nodes.length);
  assert.equal(result.graph.edges.length, graph.edges.length);
});

test('insertAdapterForEdge：不移动任何其它节点坐标，adapter 落在两端中点', () => {
  const graph = editChain();
  graph.nodes[1].portIn = BODY_PORT;
  const before = new Map(graph.nodes.map((n) => [n.id, JSON.parse(JSON.stringify({ pos: n.pos, ortho: n.ortho }))]));
  const result = insertAdapterForEdge(graph, 'e1', factory());
  for (const n of result.graph.nodes) {
    const original = before.get(n.id);
    if (!original) continue;
    assert.deepEqual({ pos: n.pos, ortho: n.ortho }, original, `${n.id} 坐标被改动了`);
  }
  const adapter = result.graph.nodes.find((n) => n.id === result.adapterId);
  assert.equal(adapter.pos.x, Math.round((0 + 260) / 2));
  assert.equal(adapter.pos.y, Math.round((0 + 0) / 2) + 8);
  assert.deepEqual(adapter.ortho, { x: (0 + 300) / 2, y: (0 + 0) / 2 });
});

test('insertAdapterForEdge：纯函数，不改入参；未知边与非法工厂参数抛中文错误', () => {
  const graph = editChain();
  graph.nodes[1].portIn = BODY_PORT;
  const snapshot = JSON.parse(JSON.stringify(graph));
  insertAdapterForEdge(graph, 'e1', factory());
  assert.deepEqual(graph, snapshot);

  assert.throws(() => insertAdapterForEdge(graph, 'e-不存在', factory()), /边 e-不存在 不存在/);
  assert.throws(() => insertAdapterForEdge(graph, 'e1', factory({ plateDimsMm: [92, 76] })), /plateDimsMm/);
  assert.throws(() => insertAdapterForEdge(graph, 'e1', factory({ massKg: -1 })), /massKg/);
  assert.throws(() => insertAdapterForEdge(graph, 'e1', factory({ costYuan: Number.NaN })), /costYuan/);
  assert.throws(() => insertAdapterForEdge(graph, 'e1', factory({ thicknessMm: 0 })), /thicknessMm/);
});

test('insertAdaptersForAllMismatches：一键补齐 4 个节点间的 3 条不匹配边', () => {
  const nodes = [
    node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT }),
    node('B', { portIn: BODY_PORT, portOut: BODY_PORT }),
    node('C', { portIn: port({ family: 'plate', holeDiaMm: 4.5, pitchXMm: 32, pitchYMm: 32 }), portOut: SLIDER_PORT }),
    node('D', { portIn: port({ family: 'tip', holeDiaMm: 0, pitchXMm: 0, pitchYMm: 0, count: 0 }) })
  ];
  const chain = graphOf(nodes, [
    { id: 'e1', from: 'A', to: 'B' },
    { id: 'e2', from: 'B', to: 'C' },
    { id: 'e3', from: 'C', to: 'D' }
  ]);
  const result = insertAdaptersForAllMismatches(chain, factory());
  assert.equal(result.adapterIds.length, 3);
  assert.equal(result.skipped.length, 0);
  assert.equal(findMismatchedEdges(result.graph).length, 0);
  assert.equal(result.graph.nodes.filter((n) => n.kind === 'adapter').length, 3);
  assert.equal(result.graph.edges.length, 6);
});

// ---------------------------------------------------------------------------
// 删节点
// ---------------------------------------------------------------------------

test('removeNode：删掉转接板后恢复直连，两端不匹配重新报出', () => {
  const graph = editChain();
  const toPort = port({ family: 'body', holeDiaMm: 4.5, pitchXMm: 48, pitchYMm: 36 });
  graph.nodes[1].portIn = toPort;
  const inserted = insertAdapterForEdge(graph, 'e1', factory());
  const adapterId = inserted.adapterId;
  assert.equal(findMismatchedEdges(inserted.graph).length, 0);

  const removed = removeNode(inserted.graph, adapterId);
  assert.ok(removed.restoredEdge, '删除转接板后必须恢复直连边');
  assert.equal(removed.restoredEdge.from, 'A');
  assert.equal(removed.restoredEdge.to, 'B');
  assert.equal(removed.graph.nodes.length, 2);
  assert.equal(removed.graph.edges.length, 1);

  const mismatches = findMismatchedEdges(removed.graph);
  assert.equal(mismatches.length, 1, '恢复直连后必须重新报出不匹配');
  assert.equal(mismatches[0].edgeId, removed.restoredEdge.id);
  assert.ok(graphConsistencyIssues(removed.graph).some((issue) => issue.code === 'PORT_MISMATCH'));
});

test('removeNode：删普通节点清掉相关边并连带清理只剩一端的转接板', () => {
  const a = node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT });
  const b = node('B', { portIn: BODY_PORT, portOut: BODY_PORT });
  const c = node('C', { portIn: port({ family: 'plate' }), portOut: SLIDER_PORT });
  const graph = graphOf([a, b, c], [{ id: 'e1', from: 'A', to: 'B' }, { id: 'e2', from: 'B', to: 'C' }]);
  const inserted = insertAdapterForEdge(graph, 'e1', factory());
  const adapterId = inserted.adapterId;

  const removed = removeNode(inserted.graph, 'B');
  assert.deepEqual(removed.prunedAdapters, [adapterId], '失去下游的转接板应被连带清理');
  assert.deepEqual(removed.graph.nodes.map((n) => n.id).sort(), ['A', 'C']);
  assert.equal(removed.graph.edges.length, 0);
  assert.ok(removed.removedEdges.length >= 3);
});

test('removeNode：节点不存在时抛中文错误；纯函数不改入参', () => {
  const graph = editChain();
  const snapshot = JSON.parse(JSON.stringify(graph));
  assert.throws(() => removeNode(graph, '不存在'), /节点 不存在 不存在/);
  removeNode(graph, 'B');
  assert.deepEqual(graph, snapshot);
});

test('graphConsistencyIssues：缺一端连接的转接板被报出', () => {
  const a = node('A', { portIn: GRID_PORT, portOut: SLIDER_PORT });
  const adapter = node('AD', {
    kind: 'adapter',
    adapter: true,
    portIn: SLIDER_PORT,
    portOut: BODY_PORT,
    pos: { x: 10, y: 10 }
  });
  const graph = graphOf([a, adapter], [{ id: 'e1', from: 'A', to: 'AD' }]);
  const issues = graphConsistencyIssues(graph);
  const degree = issues.find((issue) => issue.code === 'ADAPTER_DEGREE');
  assert.ok(degree, '缺少 ADAPTER_DEGREE 报出');
  assert.match(degree.message, /1 进 1 出/);
});
