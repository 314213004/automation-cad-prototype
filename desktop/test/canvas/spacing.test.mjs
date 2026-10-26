import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  currentPitchMm,
  downstreamOf,
  shiftToPitch,
  stationOrder,
  upstreamOf
} from '../../src/canvas/spacing.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('stationOrder / upstreamOf / downstreamOf：按 ortho.x 排列', () => {
  const graph = demoCanvasGraph();
  assert.deepEqual(stationOrder(graph).map((node) => node.id), ['FRAME', 'AXIS-X', 'AXIS-Y', 'CAM', 'AXIS-Z', 'GRIP']);
  assert.equal(upstreamOf(graph, 'AXIS-Z')?.id, 'CAM');
  assert.equal(downstreamOf(graph, 'AXIS-Z')?.id, 'GRIP');
  assert.equal(upstreamOf(graph, 'FRAME'), null);
  assert.equal(downstreamOf(graph, 'GRIP'), null);
});

test('currentPitchMm：中心距 = 本中心 − 上游中心', () => {
  const graph = demoCanvasGraph();
  // FRAME 中心 400，AXIS-X 中心 60+310=370 → 间距 -30（示意坐标本身重叠）
  assert.equal(currentPitchMm(graph, 'AXIS-X'), -30);
  // AXIS-Y 中心 420+220=640 → 640-370=270
  assert.equal(currentPitchMm(graph, 'AXIS-Y'), 270);
  assert.equal(currentPitchMm(graph, 'FRAME'), null);
});

test('shiftToPitch：只动目标节点的 ortho.x，其它节点坐标不变', () => {
  const graph = demoCanvasGraph();
  const upstream = upstreamOf(graph, 'AXIS-Y');
  const result = shiftToPitch(graph, 'AXIS-Y', 420);
  assert.equal(result.error, null);
  // 与「移动前的上游」比较中心距，必须正好等于目标值 420
  const moved = result.graph.nodes.find((n) => n.id === 'AXIS-Y');
  const pitch = moved.ortho.x + moved.dimsMm[0] / 2 - (upstream.ortho.x + upstream.dimsMm[0] / 2);
  assert.equal(Math.round(pitch * 10) / 10, 420);
  // 其它节点坐标原样（含上游）
  for (const node of graph.nodes.filter((n) => n.id !== 'AXIS-Y')) {
    assert.deepEqual(result.graph.nodes.find((n) => n.id === node.id).ortho, node.ortho, `${node.id} 不应移动`);
  }
  // 入参不变
  assert.equal(currentPitchMm(graph, 'AXIS-Y'), 270);
});

test('shiftToPitch：跨过其它工位时标记 reordered（尺寸链会重排）', () => {
  const graph = demoCanvasGraph();
  // 拉到 420mm 时 AXIS-Y 跑到 CAM 右侧，上游邻居从 AXIS-X 变成 CAM
  const result = shiftToPitch(graph, 'AXIS-Y', 420);
  assert.equal(result.error, null);
  assert.equal(result.reordered, true);
  assert.equal(upstreamOf(result.graph, 'AXIS-Y')?.id, 'CAM');
  const kept = shiftToPitch(graph, 'AXIS-Y', 300);
  assert.equal(kept.reordered, false);
  assert.equal(upstreamOf(kept.graph, 'AXIS-Y')?.id, 'AXIS-X');
});

test('shiftToPitch：非法输入拒绝且不改图', () => {
  const graph = demoCanvasGraph();
  assert.match(shiftToPitch(graph, 'AXIS-Y', 0).error, /必须大于 0/);
  assert.match(shiftToPitch(graph, 'AXIS-Y', -50).error, /必须大于 0/);
  assert.match(shiftToPitch(graph, 'AXIS-Y', Number.NaN).error, /必须是数字/);
  assert.match(shiftToPitch(graph, 'FRAME', 100).error, /没有上游/);
  assert.match(shiftToPitch(graph, 'NOPE', 100).error, /找不到节点/);
});

test('shiftToPitch：目标间距已满足时返回 movedMm=0 且不产生新对象改值', () => {
  const graph = demoCanvasGraph();
  const same = shiftToPitch(graph, 'AXIS-Y', 270);
  assert.equal(same.error, null);
  assert.equal(same.movedMm, 0);
  assert.equal(currentPitchMm(same.graph, 'AXIS-Y'), 270);
});
