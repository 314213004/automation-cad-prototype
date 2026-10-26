import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDimensions, selectionToBounds } from '../../src/canvas/dimensions.ts';
import { buildOrthoView } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

function view(graph = demoCanvasGraph()) {
  return buildOrthoView(graph);
}

test('buildDimensions：总宽/总高取包络，单位 mm', () => {
  const result = buildDimensions(view());
  const x = result.chains.find((chain) => chain.id === 'dim-overall-x');
  const y = result.chains.find((chain) => chain.id === 'dim-overall-y');
  assert.ok(x && y);
  // 包络含运动行程：X 轴 450 行程展开后总宽 1160（静止外形只到 930）
  assert.equal(x.valueMm, 1160);
  assert.equal(y.valueMm, 650);   // FRAME 高 650
  assert.match(x.text, /总宽 1160（含行程包络）/);
  assert.match(y.text, /总高 650（含行程包络）/);
  assert.ok(x.valueMm > 930, '总宽必须比静止外形宽（含行程）');
});

test('buildDimensions：中心距按 ortho X 排序，段数 = 工位数 - 1', () => {
  const result = buildDimensions(view());
  const pitches = result.chains.filter((chain) => chain.kind === 'pitch');
  assert.equal(pitches.length, result.chains.filter((c) => c.kind === 'pitch').length);
  assert.equal(pitches.length, view().stations.length - 1);
  // 相邻两站的中心距必须等于两站中心差
  for (const pitch of pitches) {
    assert.equal(pitch.valueMm, Math.round((pitch.toMm - pitch.fromMm) * 10) / 10);
  }
  assert.match(result.note, /中心距 \d+ 段/);
});

test('buildDimensions：重叠如实报出，不当作碰撞结论', () => {
  const result = buildDimensions(view());
  assert.ok(result.overlaps.length > 0, '演示布局里 X/Y 轴包围盒本来就重叠');
  assert.match(result.note, /包围盒重叠（示意坐标，非干涉结论）/);
});

test('buildDimensions：选中工位给出上下游中心距', () => {
  const result = buildDimensions(view(), 'AXIS-Z');
  const up = result.chains.find((chain) => chain.id === 'dim-sel-up-AXIS-Z');
  const down = result.chains.find((chain) => chain.id === 'dim-sel-down-AXIS-Z');
  assert.ok(up && down);
  assert.match(up.text, /^上游 \d/);
  assert.match(down.text, /^下游 \d/);
  assert.equal(up.nodeIds[1], 'AXIS-Z');
});

test('selectionToBounds：给出四至距离，未知节点返回空', () => {
  const graph = demoCanvasGraph();
  const lines = selectionToBounds(graph, view(graph).stations, 'AXIS-Z');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /距左 \d/);
  assert.match(lines[1], /距下 \d/);
  assert.deepEqual(selectionToBounds(graph, view(graph).stations, 'NOPE'), []);
});
