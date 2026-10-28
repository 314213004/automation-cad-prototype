import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDocFeatureEdit, reorderFeature, toggleSuppressed } from '../../src/canvas/feature-tree-doc.ts';
import { mountFeatureWorkbench } from '../../src/canvas/feature-tree-mount.ts';

function demoDoc() {
  return {
    schemaVersion: 1,
    features: [
      { id: 'f-body', type: 'box', name: '板体', params: { length: 90, width: 90, height: 12 } },
      { id: 'f-cb', type: 'counterbore', name: '沉头孔', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5 } },
      { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
    ],
    updatedAt: '2026-10-28T00:00:00.000Z'
  };
}

test('文档操作：排序改数组顺序，压缩取反，原文档都不动', () => {
  const doc = demoDoc();
  const reordered = reorderFeature(doc, 'f-fillet', 0);
  assert.deepEqual(reordered.value.features.map((f) => f.id), ['f-fillet', 'f-body', 'f-cb']);
  assert.equal(reorderFeature(doc, '不存在', 0).ok, false);
  const toggled = toggleSuppressed(doc, 'f-fillet');
  assert.equal(toggled.value.features[2].suppressed, true);
  assert.equal(toggleSuppressed(toggled.value, 'f-fillet').value.features[2].suppressed, false);
  assert.equal(doc.features[2].suppressed, undefined);
});

test('文档操作：按 id 面板编辑走校验，非法值不改文档', () => {
  const doc = demoDoc();
  assert.equal(applyDocFeatureEdit(doc, 'f-cb', 'cbDiameter', 5.5).ok, false);
  const ok = applyDocFeatureEdit(doc, 'f-body', 'length', 100);
  assert.equal(ok.value.features[0].params.length, 100);
  assert.equal(doc.features[0].params.length, 90);
});

function fakeContainer() {
  const listeners = {};
  return {
    innerHTML: '',
    listeners,
    addEventListener(type, listener) {
      listeners[type] = listener;
    }
  };
}

test('挂载：点击选中树节点、面板编辑回调、非法编辑不回调', () => {
  const tree = fakeContainer();
  const panel = fakeContainer();
  const changed = [];
  const mounted = mountFeatureWorkbench(demoDoc(), {
    tree,
    panel,
    onDocChange: (next) => changed.push(next)
  });
  assert.ok(tree.innerHTML.includes('沉头孔'));
  assert.ok(panel.innerHTML.includes('未选中特征'));

  // 模拟一次树点击：target.closest 返回带 data-tree-id 的元素。
  tree.listeners.click({ target: { closest: () => ({ dataset: { treeId: 'f-cb' } }) } });
  assert.equal(mounted.getSelectedId(), 'f-cb');
  assert.ok(panel.innerHTML.includes('沉窝直径'));
  assert.equal(mounted.select('不存在'), false);

  assert.equal(mounted.applyEdit('cbDiameter', 9.5), true);
  assert.equal(mounted.getDoc().features[1].params.cbDiameter, 9.5);
  assert.equal(changed.length, 1);
  assert.equal(mounted.applyEdit('cbDiameter', 5.5), false);
  assert.equal(changed.length, 1);
  assert.equal(mounted.getDoc().features[1].params.cbDiameter, 9.5);
});
