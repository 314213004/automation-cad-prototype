import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allPartIds,
  findTreeNode,
  insertedIdsFromTree,
  nodeForPart,
  nodePath,
  partsForNode,
  resolveSelection
} from '../../src/orbit/selection.ts';

const TREE = [{
  id: 'root', label: '装配体', kind: 'asm', children: [
    { id: 'g-slide', label: '滑台模组', kind: 'grp', children: [
      { id: 'base', kind: 'part', part: 'base' },
      { id: 'rail', kind: 'part', part: 'rail' },
      { id: 'carriage', kind: 'part', part: 'carriage' },
      { id: 'g-cyl', label: '气缸组', kind: 'grp', part: 'cyl', children: [
        { id: 'cyl', label: '缸体', kind: 'part', part: 'cyl' },
        { id: 'rod', kind: 'part', part: 'rod' },
        { id: 'sensor', kind: 'part', part: 'sensor' }
      ] }
    ] },
    { id: 'g-std', label: '标准件', kind: 'folder', children: [
      { id: 'std1', kind: 'part', part: 'base' },
      { id: 'std3', kind: 'part', part: 'cyl' },
      { id: 'ins1', kind: 'part', part: 'ins1' },
      { id: 'ins2', kind: 'part', part: 'ins2' }
    ] }
  ]
}];

test('树 → 3D：叶子只高亮自身，组节点展开子孙，代理节点映射到被借用零件', () => {
  assert.deepEqual(partsForNode(TREE, 'rail'), ['rail']);
  assert.deepEqual(partsForNode(TREE, 'g-cyl'), ['cyl', 'rod', 'sensor']);
  assert.deepEqual(partsForNode(TREE, 'std1'), ['base']);
  assert.deepEqual(partsForNode(TREE, 'g-std'), ['ins1', 'ins2']);
  assert.deepEqual(partsForNode(TREE, 'root'), ['base', 'rail', 'carriage', 'cyl', 'rod', 'sensor', 'ins1', 'ins2']);
  assert.deepEqual(partsForNode(TREE, 'missing'), []);
});

test('3D → 树：优先本体叶子，其次组节点，最后代理；未知零件返回 null', () => {
  assert.equal(nodeForPart(TREE, 'cyl'), 'cyl');
  assert.equal(nodeForPart(TREE, 'base'), 'base');
  assert.equal(nodeForPart(TREE, 'ins2'), 'ins2');
  assert.equal(nodeForPart(TREE, 'nope'), null);
  const onlyGroup = [{ id: 'g', kind: 'grp', part: 'x', children: [{ id: 'p', kind: 'part', part: 'x' }] }];
  assert.equal(nodeForPart(onlyGroup, 'x'), 'g');
  const onlyProxy = [{ id: 'f', kind: 'folder', children: [{ id: 'std9', kind: 'part', part: 'y' }] }];
  assert.equal(nodeForPart(onlyProxy, 'y'), 'std9');
});

test('选择集合成：叶子沿用原型 SVG 选中（含框选多选），组并入子孙，文件夹替换残留选中', () => {
  assert.deepEqual(resolveSelection(TREE, ['rail'], 'rail'), ['rail']);
  assert.deepEqual(resolveSelection(TREE, ['base', 'rail'], null), ['base', 'rail']);
  assert.deepEqual(resolveSelection(TREE, ['cyl'], 'g-cyl'), ['cyl', 'rod', 'sensor']);
  assert.deepEqual(resolveSelection(TREE, ['cyl'], 'g-std'), ['ins1', 'ins2']);
  assert.deepEqual(resolveSelection(TREE, ['cyl'], 'unknown'), ['cyl']);
});

test('辅助：插入件按顺序、全部零件去重、路径与查找', () => {
  assert.deepEqual(insertedIdsFromTree(TREE), ['ins1', 'ins2']);
  assert.deepEqual(insertedIdsFromTree([]), []);
  assert.deepEqual(allPartIds(TREE), ['base', 'rail', 'carriage', 'cyl', 'rod', 'sensor', 'ins1', 'ins2']);
  assert.deepEqual(nodePath(TREE, 'cyl'), ['装配体', '滑台模组', '气缸组', '缸体']);
  assert.equal(findTreeNode(TREE, 'g-std').label, '标准件');
  assert.equal(findTreeNode(TREE, 'zzz'), null);
});

test('框选多选（原型 SVG 同时选中多个零件）原样显示，不叠加当前树节点的组展开', () => {
  assert.deepEqual(resolveSelection(TREE, ['base', 'rail', 'ins1'], 'g-cyl'), ['base', 'rail', 'ins1']);
  assert.deepEqual(resolveSelection(TREE, ['base', 'rail'], 'g-std'), ['base', 'rail']);
});
