import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMismatchedEdges, insertAdapterForEdge } from '../../src/canvas/graph.ts';
import { createDefaultAdapterFactory } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';
import { machineMetrics } from '../../src/canvas/metrics.ts';
import {
  CANVAS_DRAFT_KEY,
  CANVAS_DRAFT_SCHEMA,
  clearDraft,
  loadDraft,
  parseDraft,
  saveDraft,
  serializeDraft
} from '../../src/canvas/persistence.ts';

const SAVED_AT = '2026-10-26T00:00:00.000Z';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); }
  };
}

function payload(overrides = {}) {
  return { graph: demoCanvasGraph(), selectedId: 'AXIS-X', mode: 'topology', ...overrides };
}

test('serializeDraft：字段顺序固定，同一图 + 同一时间戳字节一致', () => {
  const a = serializeDraft(payload(), SAVED_AT);
  const b = serializeDraft(payload(), SAVED_AT);
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.deepEqual(Object.keys(parsed), ['schema', 'savedAt', 'mode', 'selectedId', 'graph']);
  assert.equal(parsed.schema, CANVAS_DRAFT_SCHEMA);
  assert.equal(parsed.graph.layout, 'linear');
  assert.equal(a.endsWith('\n'), true);
});

test('parseDraft：往返后图/选中/模式完整保留', () => {
  const raw = serializeDraft(payload(), SAVED_AT);
  const { draft, issues } = parseDraft(raw);
  assert.ok(draft);
  assert.deepEqual(issues, []);
  assert.equal(draft.schema, CANVAS_DRAFT_SCHEMA);
  assert.equal(draft.selectedId, 'AXIS-X');
  assert.equal(draft.mode, 'topology');
  assert.deepEqual(draft.graph.nodes.map((n) => n.id), demoCanvasGraph().nodes.map((n) => n.id));
  assert.deepEqual(draft.graph.edges.map((e) => e.id), demoCanvasGraph().edges.map((e) => e.id));
  assert.deepEqual(draft.graph.nodes[1].portOut, demoCanvasGraph().nodes[1].portOut);
  assert.equal(findMismatchedEdges(draft.graph).length, 1, '往返后仍只有那条不匹配边');
});

test('parseDraft：插过转接板的图往返后转接板参数不丢', () => {
  const inserted = insertAdapterForEdge(demoCanvasGraph(), 'e-y-z', createDefaultAdapterFactory({ dowelDiaMm: 4 }));
  const raw = serializeDraft({ graph: inserted.graph, selectedId: inserted.adapterId, mode: 'ortho' }, SAVED_AT);
  const { draft } = parseDraft(raw);
  assert.ok(draft);
  assert.equal(draft.mode, 'ortho');
  assert.equal(draft.selectedId, inserted.adapterId);
  const adapter = draft.graph.nodes.find((node) => node.kind === 'adapter');
  assert.ok(adapter);
  assert.deepEqual(adapter.adapterParams.plateDimsMm, [90, 90, 12]);
  assert.equal(adapter.adapterParams.dowelDiaMm, 4);
  assert.equal(adapter.adapterParams.costYuan, null);
  assert.equal(findMismatchedEdges(draft.graph).length, 0);
});

test('parseDraft：空/坏 JSON/坏结构都返回中文原因，不抛错', () => {
  assert.equal(parseDraft(null).draft, null);
  assert.match(parseDraft(null).reason, /没有本地草稿/);
  assert.match(parseDraft('').reason, /没有本地草稿/);
  assert.match(parseDraft('{oops').reason, /不是合法 JSON/);
  assert.match(parseDraft('"text"').reason, /不是对象/);
  assert.match(parseDraft(JSON.stringify({ schema: CANVAS_DRAFT_SCHEMA })).reason, /缺少 graph/);
});

test('parseDraft：schema 版本不匹配时拒绝，不做自动迁移', () => {
  const raw = JSON.stringify({ ...JSON.parse(serializeDraft(payload(), SAVED_AT)), schema: 'canvas-workbench-draft/0' });
  const result = parseDraft(raw);
  assert.equal(result.draft, null);
  assert.match(result.reason, /版本不支持/);
});

test('parseDraft：孤儿边/重复 id 被清理并回报 issues', () => {
  const demo = demoCanvasGraph();
  const raw = JSON.stringify({
    schema: CANVAS_DRAFT_SCHEMA,
    savedAt: SAVED_AT,
    mode: 'topology',
    selectedId: 'AXIS-X',
    graph: {
      schemeId: demo.schemeId,
      layout: demo.layout,
      nodes: [...demo.nodes, { ...demo.nodes[0], name: '重复机架' }],
      edges: [...demo.edges, { id: 'e-ghost', from: 'AXIS-X', to: '不存在' }]
    }
  });
  const { draft, issues } = parseDraft(raw);
  assert.ok(draft);
  assert.equal(draft.graph.nodes.length, demo.nodes.length, '重复 id 只保留首个');
  assert.equal(draft.graph.edges.length, demo.edges.length, '孤儿边被清理');
  const codes = issues.map((issue) => issue.code);
  assert.ok(codes.includes('DUPLICATE_NODE_ID'));
  assert.ok(codes.includes('ORPHAN_EDGE'));
});

test('parseDraft：非法 mode 回落 topology，选中节点不存在时置空', () => {
  const raw = JSON.stringify({
    schema: CANVAS_DRAFT_SCHEMA,
    savedAt: SAVED_AT,
    mode: 'hologram',
    selectedId: 'nope',
    graph: demoCanvasGraph()
  });
  const { draft } = parseDraft(raw);
  assert.ok(draft);
  assert.equal(draft.mode, 'topology');
  assert.equal(draft.selectedId, null);
});

test('saveDraft/loadDraft/clearDraft：走注入的存储，写失败返回人话原因', () => {
  const storage = memoryStorage();
  const ok = saveDraft(storage, payload(), SAVED_AT);
  assert.equal(ok.ok, true);
  assert.ok(storage.map.has(CANVAS_DRAFT_KEY));

  const loaded = loadDraft(storage);
  assert.ok(loaded.draft);
  assert.equal(loaded.draft.selectedId, 'AXIS-X');

  clearDraft(storage);
  assert.equal(storage.map.has(CANVAS_DRAFT_KEY), false);
  assert.match(loadDraft(storage).reason, /没有本地草稿/);

  const broken = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => undefined
  };
  const failed = saveDraft(broken, payload(), SAVED_AT);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /QuotaExceededError/);
});

test('loadDraft：没有存储时明确说「没有本地存储」', () => {
  const result = loadDraft(null);
  assert.equal(result.draft, null);
  assert.match(result.reason, /没有本地存储/);
});


test('serializeDraft / parseDraft：布局口径参数（转移时间/分度时间/轨道/目标节拍）不丢', () => {
  const graph = demoCanvasGraph();
  const withOptions = { ...graph, targetPerMin: 24, transferSeconds: 0.35, indexSeconds: 1.2, lanes: 2 };
  const json = serializeDraft({ graph: withOptions, selectedId: null, mode: 'topology' }, '2026-10-26T10:00:00+08:00');
  const parsed = parseDraft(json);
  assert.equal(parsed.draft.graph.transferSeconds, 0.35);
  assert.equal(parsed.draft.graph.indexSeconds, 1.2);
  assert.equal(parsed.draft.graph.lanes, 2);
  assert.equal(parsed.draft.graph.targetPerMin, 24);
});

test('parseDraft：恢复后的 CT 与原始图一致（transferSeconds 丢了会算错）', () => {
  const graph = demoCanvasGraph();
  const before = machineMetrics(graph, { priceLookup: () => null });
  const json = serializeDraft({ graph, selectedId: null, mode: 'topology' }, '2026-10-26T10:00:00+08:00');
  const after = machineMetrics(parseDraft(json).draft.graph, { priceLookup: () => null });
  assert.equal(after.cycleSeconds, before.cycleSeconds);
  assert.equal(after.unitsPerHour, before.unitsPerHour);
});
