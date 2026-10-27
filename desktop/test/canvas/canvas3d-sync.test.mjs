import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Canvas3DSync,
  dirtySubtreeOfGraph,
  incrementalBoxesMm,
  pipBoxForNodeMm,
  syncFrom3DToCanvas
} from '../../src/canvas/canvas3d-sync.ts';

const node = (over = {}) => ({
  id: 'n1', kind: 'linear', name: 'X 轴', spec: '', portIn: {}, portOut: {},
  strokeMm: 450, leadMm: 10, massKg: 9.2, stepSec: 0.55, dimsMm: [620, 86, 74],
  io: { di: 0, do: 0, desc: '' }, pos: { x: 0, y: 0 }, ortho: { x: 320, y: 120 }, ...over
});
const graph = {
  schemeId: 'demo', title: 'demo',
  nodes: [node(), node({ id: 'n2', kind: 'actuator', strokeMm: 0, dimsMm: [80, 62, 195], ortho: { x: 600, y: 120 } }), node({ id: 'n3', kind: 'gripper', strokeMm: 0, dimsMm: [70, 70, 95], ortho: { x: 880, y: 120 } })],
  edges: [
    { id: 'e1', from: 'n1', to: 'n2' },
    { id: 'e2', from: 'n2', to: 'n3' },
    { id: 'e3', from: 'n3', to: 'n2' } // 环：不能死循环，也不能重复
  ]
};

test('dirtySubtreeOfGraph：BFS 下游含 root，环不重复，未知 root 返回空', () => {
  assert.deepEqual(dirtySubtreeOfGraph('n1', graph), ['n1', 'n2', 'n3']);
  assert.deepEqual(dirtySubtreeOfGraph('n2', graph), ['n2', 'n3']);
  assert.deepEqual(dirtySubtreeOfGraph('nope', graph), []);
});

test('pipBoxForNodeMm：公式与 pip3d 一致（中心 = ortho + 半尺寸，高度 = h/2，行程沿 X 展开）', () => {
  const box = pipBoxForNodeMm(graph.nodes[0]);
  assert.deepEqual(box.centerMm, [320 + 310, 43, 120 + 37]);
  assert.deepEqual(box.sizeMm, [620, 86, 74]);
  assert.deepEqual(box.envelopeMm, [620 + 450, 86, 74]);
  assert.equal(box.adapter, false);
});

test('incrementalBoxesMm：只重算脏节点', () => {
  const boxes = incrementalBoxesMm(graph, ['n2']);
  assert.deepEqual(boxes.map((b) => b.id), ['n2']);
  assert.deepEqual(boxes[0].centerMm, [600 + 40, 31, 120 + 97.5]);
});

test('syncFrom3DToCanvas：盒中心往返后 ortho 不变；拖动 +10mm 后 ortho +10；原图不动；未知节点返回 null', () => {
  const box = pipBoxForNodeMm(graph.nodes[0]);
  const back = syncFrom3DToCanvas(graph, 'n1', box.centerMm);
  assert.deepEqual(back.nodes[0].ortho, { x: 320, y: 120 });
  const moved = syncFrom3DToCanvas(graph, 'n1', [box.centerMm[0] + 10, box.centerMm[1], box.centerMm[2] + 20]);
  assert.deepEqual(moved.nodes[0].ortho, { x: 330, y: 140 });
  assert.deepEqual(graph.nodes[0].ortho, { x: 320, y: 120 });
  assert.equal(syncFrom3DToCanvas(graph, 'nope', box.centerMm), null);
  assert.throws(() => syncFrom3DToCanvas(graph, 'n1', [NaN, 0, 0]), /有限数/);
});

test('Canvas3DSync：mark 后 flush 只回调脏节点，flush 后脏集清空', () => {
  const sync = new Canvas3DSync();
  sync.markSubtreeDirty('n1', graph.edges);
  assert.deepEqual(sync.dirtyIds(), ['n1', 'n2', 'n3']);
  const seen = [];
  const boxes = sync.flushIncrementalBoxes(graph, (b) => seen.push(b.id));
  assert.deepEqual(seen, ['n1', 'n2', 'n3']);
  assert.equal(boxes.length, 3);
  assert.deepEqual(sync.dirtyIds(), []);
});
