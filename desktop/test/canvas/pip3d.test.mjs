import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPipBoxes } from '../../src/canvas/pip3d.ts';
import { insertAdapterForEdge } from '../../src/canvas/graph.ts';
import { createDefaultAdapterFactory } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('buildPipBoxes：mm→m、盒子落地、尺寸与节点外形一致', () => {
  const graph = demoCanvasGraph();
  const boxes = buildPipBoxes(graph, null);
  assert.equal(boxes.length, graph.nodes.length);
  const frame = boxes.find((box) => box.id === 'FRAME');
  const frameNode = graph.nodes.find((node) => node.id === 'FRAME');
  assert.deepEqual(frame.size, [0.8, 0.65, 0.75]);
  assert.equal(frame.center[1], 0.65 / 2, '盒子中心离地半个高度（用 Y 向尺寸）');
  assert.equal(frame.center[0], (frameNode.ortho.x + 800 / 2) / 1000);
  assert.equal(frame.center[2], (frameNode.ortho.y + 750 / 2) / 1000, 'Z 向用 dimsMm[2]');
  assert.equal(frame.adapter, false);
  assert.equal(frame.selected, false);
});

test('buildPipBoxes：直线轴包络沿行程展开，非运动件包络=外形', () => {
  const graph = demoCanvasGraph();
  const boxes = buildPipBoxes(graph, null);
  const axis = boxes.find((box) => box.id === 'AXIS-X');
  const axisNode = graph.nodes.find((node) => node.id === 'AXIS-X');
  assert.equal(axis.size[0], 620 / 1000);
  assert.equal(axis.envelope[0], (620 + axisNode.strokeMm) / 1000);
  const grip = boxes.find((box) => box.id === 'GRIP');
  assert.deepEqual(grip.envelope, grip.size, '夹爪没有直线行程');
});

test('buildPipBoxes：选中与转接板标记透传', () => {
  const graph = demoCanvasGraph();
  const selected = buildPipBoxes(graph, 'AXIS-Y');
  assert.equal(selected.filter((box) => box.selected).length, 1);
  assert.equal(selected.find((box) => box.selected).id, 'AXIS-Y');

  const inserted = insertAdapterForEdge(graph, 'e-y-z', createDefaultAdapterFactory());
  const withAdapter = buildPipBoxes(inserted.graph, inserted.adapterId);
  const adapter = withAdapter.find((box) => box.adapter);
  assert.ok(adapter, '转接板必须在 3D 里标出来');
  assert.equal(adapter.selected, true);
  assert.deepEqual(adapter.size, [0.09, 0.09, 0.012]);
});

test('buildPipBoxes：空图返回空数组，不抛错', () => {
  assert.deepEqual(buildPipBoxes({ schemeId: 's', nodes: [], edges: [] }, null), []);
});
