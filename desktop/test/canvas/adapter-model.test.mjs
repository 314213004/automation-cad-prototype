import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFeatures } from '../../src/parametric/features.ts';
import { adapterFeatureDoc, describeAdapterModel, holePositions } from '../../src/canvas/adapter-model.ts';
import { insertAdapterForEdge } from '../../src/canvas/graph.ts';
import { createDefaultAdapterFactory } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

const port = (over = {}) => ({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4, ...over });

function demoAdapter(dowelDiaMm = 0) {
  const inserted = insertAdapterForEdge(demoCanvasGraph(), 'e-y-z', createDefaultAdapterFactory({ dowelDiaMm }));
  const node = inserted.graph.nodes.find((item) => item.kind === 'adapter');
  return { inserted, node };
}

test('holePositions：1 孔居中，4 孔成 2×2 按孔距铺开，6 孔 2×3', () => {
  assert.deepEqual(holePositions(port({ count: 1, pitchXMm: 0, pitchYMm: 0 })), [[0, 0]]);
  assert.deepEqual(holePositions(port({ count: 4, pitchXMm: 60, pitchYMm: 60 })), [
    [-30, -30],
    [30, -30],
    [-30, 30],
    [30, 30]
  ]);
  const six = holePositions(port({ count: 6, pitchXMm: 48, pitchYMm: 36 }));
  assert.equal(six.length, 6);
  assert.deepEqual(six.slice(0, 2), [[-24, -36], [24, -36]]);
  assert.deepEqual(holePositions(port({ count: 0 })), []);
});

test('adapterFeatureDoc：板体 + 两端孔阵列 + 圆角，且能通过仓库自带的 validateFeatures', () => {
  const { node } = demoAdapter();
  const doc = adapterFeatureDoc(node);
  assert.ok(doc);
  assert.deepEqual(doc.features.map((feature) => feature.type), ['box', 'holes', 'holes', 'fillet']);
  const body = doc.features[0];
  assert.deepEqual(body.params, { length: 90, width: 90, height: 12, centered: true });
  const inHoles = doc.features[1].params.positions;
  const outHoles = doc.features[2].params.positions;
  assert.equal(inHoles.length, node.adapterParams.fromPort.count);
  assert.equal(outHoles.length, node.adapterParams.toPort.count);
  assert.equal(doc.features[3].params.radius, 3);

  const errors = validateFeatures(doc);
  assert.deepEqual(errors, [], `特征树没通过仓库校验：${errors.join('; ')}`);
});

test('adapterFeatureDoc：带定位销孔时仍然合法（销孔不越界、不撞安装孔）', () => {
  const { node } = demoAdapter(5);
  const doc = adapterFeatureDoc(node);
  assert.ok(doc);
  const dowel = doc.features.find((feature) => feature.id === 'f-holes-dowel');
  assert.ok(dowel, 'dowelDiaMm>0 时应生成销孔特征');
  assert.equal(dowel.params.diameter, 5);
  const errors = validateFeatures(doc);
  assert.deepEqual(errors, [], `销孔版本没通过校验：${errors.join('; ')}`);
});

test('adapterFeatureDoc：非转接板 / 缺参数返回 null，不给假模型', () => {
  const graph = demoCanvasGraph();
  const axis = graph.nodes.find((node) => node.id === 'AXIS-X');
  assert.equal(adapterFeatureDoc(axis), null);
  const emptyAdapter = { ...graph.nodes[0], kind: 'adapter' };
  assert.equal(adapterFeatureDoc(emptyAdapter), null);
});

test('describeAdapterModel：讲清特征数与「沉头不支持」', () => {
  const { node } = demoAdapter();
  const text = describeAdapterModel(adapterFeatureDoc(node));
  assert.match(text, /特征树 4 个/);
  assert.match(text, /8 孔/);
  assert.match(text, /沉头孔协议不支持/);
  assert.match(describeAdapterModel(null), /无法生成建模请求/);
});
