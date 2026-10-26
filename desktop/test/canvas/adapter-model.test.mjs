import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFeatures } from '../../src/parametric/features.ts';
import {
  adapterFeatureDoc,
  describeAdapterModel,
  holePositions,
  screwHeadForClearance
} from '../../src/canvas/adapter-model.ts';
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
  assert.deepEqual(doc.features.map((feature) => feature.type), ['box', 'counterbore', 'holes', 'fillet']);
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

test('screwHeadForClearance：按通孔推定 ISO 4762 头部尺寸，查不到返回 null', () => {
  assert.deepEqual(screwHeadForClearance(5.5), { screw: 'M5', headDiaMm: 8.5, headHeightMm: 5 });
  assert.deepEqual(screwHeadForClearance(6.6), { screw: 'M6', headDiaMm: 10, headHeightMm: 6 });
  assert.equal(screwHeadForClearance(3), null);
});

test('adapterFeatureDoc：母件侧出 counterbore，参数与特征树合法', () => {
  const { node } = demoAdapter();
  const doc = adapterFeatureDoc(node);
  const cb = doc.features.find((feature) => feature.type === 'counterbore');
  assert.ok(cb, '沉头默认开启，母件侧应是 counterbore');
  assert.equal(cb.params.diameter, 5.5);
  assert.equal(cb.params.cbDiameter, 8.5);
  assert.equal(cb.params.cbDepth, 5);
  assert.equal(cb.params.positions.length, 4);
  assert.equal(doc.features.filter((feature) => feature.type === 'holes').length, 1, '子件侧仍是通孔');
  assert.deepEqual(validateFeatures(doc), []);
});

test('adapterFeatureDoc：沉头关闭时退回通孔；孔径查不到标准头部也退回通孔', () => {
  const { node } = demoAdapter();
  const off = { ...node, adapterParams: { ...node.adapterParams, counterBore: false } };
  const offDoc = adapterFeatureDoc(off);
  assert.equal(offDoc.features.some((feature) => feature.type === 'counterbore'), false);
  assert.equal(offDoc.features.filter((feature) => feature.type === 'holes').length, 2);

  const weird = {
    ...node,
    adapterParams: { ...node.adapterParams, fromPort: { ...node.adapterParams.fromPort, holeDiaMm: 3 } }
  };
  const weirdDoc = adapterFeatureDoc(weird);
  assert.equal(weirdDoc.features.some((feature) => feature.type === 'counterbore'), false);
  assert.equal(weirdDoc.features.filter((feature) => feature.type === 'holes').length, 2);
});

test('describeAdapterModel：讲清特征数、孔数与沉头依据', () => {
  const { node } = demoAdapter();
  const text = describeAdapterModel(adapterFeatureDoc(node));
  assert.match(text, /特征树 4 个/);
  assert.match(text, /8 孔/);
  assert.match(text, /Ø8\.5×5 沉窝/);
  assert.match(text, /ISO 4762/);
  assert.match(describeAdapterModel(null), /无法生成建模请求/);
});
