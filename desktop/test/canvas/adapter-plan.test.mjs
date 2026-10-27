import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFeatures } from '../../src/parametric/features.ts';
import {
  adapterFastenerBom,
  adapterFeatureDoc,
  adapterPlan,
  describeAdapterPlan
} from '../../src/canvas/adapter-model.ts';

const port = (over = {}) => ({ family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4, ...over });
const node = (from, to) => ({
  id: 'adapter-1',
  kind: 'adapter',
  dimsMm: [90, 90, 12],
  adapterParams: {
    fromPort: from,
    toPort: to,
    plateDimsMm: [90, 90, 12],
    thicknessMm: 12,
    material: '6061-T6',
    counterBore: true,
    dowelDiaMm: 0,
    massKg: 1,
    costYuan: null
  }
});

test('adapterPlan：孔距充足时平板通孔，FeatureDoc 不变', () => {
  const n = node(port(), port({ pitchXMm: 40, pitchYMm: 40 }));
  const plan = adapterPlan(n);
  assert.equal(plan.strategy.kind, 'flat_through');
  assert.match(describeAdapterPlan(n), /平板通孔/);
  const doc = adapterFeatureDoc(n);
  assert.deepEqual(doc.features[0].params, { length: 90, width: 90, height: 12, centered: true });
  assert.deepEqual(validateFeatures(doc), []);
});

test('adapterPlan：孔壁略不足时 FeatureDoc 加厚至 18mm 盲孔', () => {
  const n = node(port(), port({ pitchXMm: 48, pitchYMm: 48 }));
  const plan = adapterPlan(n);
  assert.equal(plan.strategy.kind, 'flat_blind_thick');
  assert.match(describeAdapterPlan(n), /加厚至 18mm/);
  const doc = adapterFeatureDoc(n);
  assert.equal(doc.features[0].params.height, 18);
  assert.deepEqual(validateFeatures(doc), []);
});

test('adapterPlan：孔距高度重合时子件孔沿 Y 偏置 16mm，板宽随之扩 16mm', () => {
  const n = node(port({ pitchXMm: 40, pitchYMm: 40 }), port({ pitchXMm: 36, pitchYMm: 36 }));
  const plan = adapterPlan(n);
  assert.equal(plan.strategy.kind, 'flat_offset');
  const doc = adapterFeatureDoc(n);
  assert.equal(doc.features[0].params.width, 106);
  assert.equal(doc.features[0].params.height, 14);
  const out = doc.features.find((f) => f.id === 'f-holes-out');
  // 原子件孔 Y 为 -18/+18，偏置后为 -2/+34
  assert.deepEqual(out.params.positions, [[-18, -2], [18, -2], [-18, 34], [18, 34]]);
  assert.deepEqual(validateFeatures(doc), []);
});

test('adapterPlan：非转接板 / 孔径不在标准表内返回 null，不猜', () => {
  assert.equal(adapterPlan({ id: 'x', kind: 'frame' }), null);
  const weird = node(port(), port({ holeDiaMm: 2 }));
  assert.equal(adapterPlan(weird), null);
  assert.equal(adapterFastenerBom(weird), null);
});

test('adapterFastenerBom：按两端孔径推螺栓规格，3 项国标件', () => {
  const items = adapterFastenerBom(node(port(), port()));
  assert.equal(items.length, 3);
  assert.equal(items[0].partId, 'GB70.1-M5x16');
  assert.equal(items[1].partId, 'GB70.1-M5x12');
  assert.equal(items[2].partId, 'GB120.2-D4x14');
  assert.ok(items.every((it) => it.parentNodeId === 'adapter-1'));
});
