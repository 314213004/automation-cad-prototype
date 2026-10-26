import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignLayers, autoLayout } from '../../src/canvas/auto-layout.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('assignLayers：按边方向分层，FRAME 在最左、叶片在最右', () => {
  const graph = demoCanvasGraph();
  const layers = assignLayers(graph);
  assert.equal(layers.get('FRAME'), 0);
  assert.equal(layers.get('AXIS-X'), 1);
  assert.equal(layers.get('AXIS-Y'), 2);
  assert.equal(layers.get('AXIS-Z'), 3);
  assert.equal(layers.get('GRIP'), 4);
  assert.equal(layers.get('CAM'), 1);
});

test('autoLayout：所有节点都有坐标，且子节点在父节点右侧', () => {
  const graph = demoCanvasGraph();
  const result = autoLayout(graph);
  assert.equal(result.graph.nodes.length, graph.nodes.length);
  const byId = new Map(result.graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    assert.ok(to.ortho.x > from.ortho.x, `${edge.id}: 子节点必须在父节点右侧`);
  }
});

test('autoLayout：同层节点纵向不重叠（间距 ≥ gapY）', () => {
  const graph = demoCanvasGraph();
  const gapY = 40;
  const result = autoLayout(graph, { gapYMm: gapY });
  const groups = new Map();
  for (const node of result.graph.nodes) {
    const key = `${node.ortho.x}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a.ortho.y - b.ortho.y);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      const prevBottom = prev.ortho.y + Math.max(prev.dimsMm[1], 60);
      assert.ok(next.ortho.y - prevBottom >= gapY - 0.1, `同层 ${prev.id}/${next.id} 间距不足`);
    }
  }
});

test('autoLayout：不动尺寸/端口/节拍，入参不改', () => {
  const graph = demoCanvasGraph();
  const before = graph.nodes.map((node) => ({
    id: node.id,
    dims: [...node.dimsMm],
    step: node.stepSec,
    portIn: JSON.stringify(node.portIn)
  }));
  const result = autoLayout(graph);
  for (const node of result.graph.nodes) {
    const origin = before.find((item) => item.id === node.id);
    assert.deepEqual([...node.dimsMm], origin.dims);
    assert.equal(node.stepSec, origin.step);
    assert.equal(JSON.stringify(node.portIn), origin.portIn);
  }
  assert.deepEqual(graph.nodes.map((node) => node.ortho), demoCanvasGraph().nodes.map((node) => node.ortho));
});

test('autoLayout：有环也能排完（环上节点放最后一层）', () => {
  const graph = demoCanvasGraph();
  const cyclic = {
    ...graph,
    edges: [...graph.edges, { id: 'e-cycle', from: 'GRIP', to: 'AXIS-X' }]
  };
  const result = autoLayout(cyclic);
  assert.equal(result.graph.nodes.length, graph.nodes.length);
  for (const node of result.graph.nodes) {
    assert.ok(Number.isFinite(node.ortho.x) && Number.isFinite(node.ortho.y));
  }
  // 环打断了拓扑序：环上整条链会被压到同一层（Kahn 处理不了的节点统一放最后），
  // 这里只要求「排完、坐标有效、层数有限」，不假装还能正确分层
  assert.ok(result.layers >= 2 && result.layers <= graph.nodes.length);
  const grip = result.graph.nodes.find((node) => node.id === 'GRIP');
  const axisX = result.graph.nodes.find((node) => node.id === 'AXIS-X');
  assert.equal(grip.ortho.x, axisX.ortho.x, '环上节点被压到同层');
});

test('autoLayout：moved 反映实际被移动的节点数', () => {
  const graph = demoCanvasGraph();
  const first = autoLayout(graph);
  const second = autoLayout(first.graph);
  assert.equal(second.moved, 0, '同一张图重复布局应稳定不变');
  assert.ok(first.moved > 0);
});
