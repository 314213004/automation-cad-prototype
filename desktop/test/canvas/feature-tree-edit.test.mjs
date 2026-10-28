import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAdapterEdit, applyPanelEdit } from '../../src/canvas/feature-tree-edit.ts';

const box = { id: 'f-body', type: 'box', name: '板体', params: { length: 90, width: 90, height: 12 } };
const counterbore = {
  id: 'f-cb',
  type: 'counterbore',
  name: '沉头孔',
  params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5 }
};

test('面板编辑：合法改动返回新对象，原对象不动', () => {
  const result = applyPanelEdit(box, 'length', 100);
  assert.equal(result.ok, true);
  assert.equal(result.value.params.length, 100);
  assert.equal(box.params.length, 90);
});

test('面板编辑：长度为 0 或负数被拒绝，原对象不动', () => {
  for (const bad of [0, -5, Number.NaN, '90']) {
    const result = applyPanelEdit(box, 'length', bad);
    assert.equal(result.ok, false);
    assert.match(result.error, /长度/);
  }
  assert.equal(box.params.length, 90);
});

test('面板编辑：沉窝直径必须大于孔径，两边都拦', () => {
  assert.equal(applyPanelEdit(counterbore, 'cbDiameter', 5.5).ok, false);
  assert.equal(applyPanelEdit(counterbore, 'diameter', 8.5).ok, false);
  assert.equal(applyPanelEdit(counterbore, 'cbDiameter', 9.5).value.params.cbDiameter, 9.5);
});

test('面板编辑：孔数是派生值、未知字段一律拒绝', () => {
  assert.match(applyPanelEdit(counterbore, 'count', 6).error, /孔位阵列/);
  assert.match(applyPanelEdit(box, 'notAField', 1).error, /未知字段/);
});

test('转接板编辑：板厚、孔距、孔数、材料、沉头各按规则校验', () => {
  const adapter = {
    fromPort: { family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 },
    toPort: { family: 'body', holeDiaMm: 5.5, pitchXMm: 48, pitchYMm: 36, count: 4 },
    plateDimsMm: [90, 90, 12],
    thicknessMm: 12,
    material: '6061-T6',
    counterBore: true,
    dowelDiaMm: 0,
    massKg: 1,
    costYuan: null
  };
  assert.equal(applyAdapterEdit(adapter, 'thicknessMm', 14).value.thicknessMm, 14);
  assert.equal(applyAdapterEdit(adapter, 'fromPort.pitchXMm', 0).value.fromPort.pitchXMm, 0);
  assert.equal(applyAdapterEdit(adapter, 'fromPort.pitchXMm', -1).ok, false);
  assert.equal(applyAdapterEdit(adapter, 'toPort.count', 0).ok, false);
  assert.equal(applyAdapterEdit(adapter, 'material', '  ').ok, false);
  assert.equal(applyAdapterEdit(adapter, 'counterBore', 'yes').ok, false);
  assert.equal(adapter.thicknessMm, 12);
});
