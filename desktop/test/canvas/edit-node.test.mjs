import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDITABLE_FIELDS, applyNodePatch, patchChangesNode } from '../../src/canvas/edit-node.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

function axis() {
  return demoCanvasGraph().nodes.find((node) => node.id === 'AXIS-X');
}

test('EDITABLE_FIELDS：带单位/范围/步长，名称是文本其余是数字', () => {
  const fields = EDITABLE_FIELDS.map((meta) => meta.field);
  assert.deepEqual(fields, ['name', 'strokeMm', 'leadMm', 'massKg', 'stepSec']);
  for (const meta of EDITABLE_FIELDS) {
    assert.ok(meta.label.length > 0);
    assert.ok(meta.hint.length > 0);
    if (meta.kind === 'number') assert.equal(typeof meta.min, 'number');
  }
});

test('applyNodePatch：合法输入整批生效，且不改入参', () => {
  const node = axis();
  const snapshot = JSON.parse(JSON.stringify(node));
  const result = applyNodePatch(node, { strokeMm: '500', leadMm: '16', massKg: '10.5', stepSec: '0.6', name: 'X 轴加长' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.node.strokeMm, 500);
  assert.equal(result.node.leadMm, 16);
  assert.equal(result.node.massKg, 10.5);
  assert.equal(result.node.stepSec, 0.6);
  assert.equal(result.node.name, 'X 轴加长');
  assert.deepEqual(node, snapshot, '入参不能被改');
  assert.notEqual(result.node, node);
  assert.notEqual(result.node.portIn, node.portIn, '端口对象也要独立');
});

test('applyNodePatch：任一字段非法 → 整批拒绝并给中文原因', () => {
  const node = axis();
  const cases = [
    [{ strokeMm: '-1' }, /行程不能小于 0/],
    [{ leadMm: 'abc' }, /导程必须是数字/],
    [{ massKg: '' }, /质量不能为空/],
    [{ stepSec: 'NaN' }, /单步时间必须是数字/],
    [{ name: '   ' }, /名称不能为空/],
    [{ name: 'x'.repeat(81) }, /最多 80 个字符/]
  ];
  for (const [patch, pattern] of cases) {
    const result = applyNodePatch(node, patch);
    assert.ok(result.errors.length > 0, `${JSON.stringify(patch)} 应该被拒绝`);
    assert.match(result.errors.join('；'), pattern);
    assert.equal(result.node, node, '拒绝时必须原样返回');
  }
  // 一半合法一半非法：合法字段也不能被应用
  const mixed = applyNodePatch(node, { strokeMm: '500', leadMm: '-5' });
  assert.equal(mixed.node.strokeMm, node.strokeMm);
  assert.equal(mixed.errors.length, 1);
});

test('applyNodePatch：0 是合法值（气缸导程 0 / 无节拍节点）', () => {
  const node = axis();
  const result = applyNodePatch(node, { leadMm: '0', stepSec: '0' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.node.leadMm, 0);
  assert.equal(result.node.stepSec, 0);
});

test('patchChangesNode：没变 / 非法都算「不算改动」', () => {
  const node = axis();
  assert.equal(patchChangesNode(node, { strokeMm: String(node.strokeMm) }), false);
  assert.equal(patchChangesNode(node, { strokeMm: '-2' }), false);
  assert.equal(patchChangesNode(node, { strokeMm: '480' }), true);
  assert.equal(patchChangesNode(node, { name: `${node.name} ` }), false, '首尾空格 trim 后相同');
});

test('applyNodePatch：改完的节点仍满足画布结构（端口/尺寸引用不共享）', () => {
  const node = axis();
  const result = applyNodePatch(node, { massKg: '11' });
  assert.equal(result.node.dimsMm.length, 3);
  assert.equal(result.node.io.di, node.io.di);
  assert.notEqual(result.node.dimsMm, node.dimsMm);
  assert.deepEqual(result.node.portOut, node.portOut);
});
