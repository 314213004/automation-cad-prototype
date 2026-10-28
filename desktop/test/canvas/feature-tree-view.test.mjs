import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeatureTree, panelFieldsForFeature } from '../../src/canvas/feature-tree.ts';
import { escapeHtml, renderFeatureTreeHtml, renderPanelHtml } from '../../src/canvas/feature-tree-view.ts';

const demoDoc = {
  features: [
    { id: 'f-body', type: 'box', name: '90×90×12 板体', params: { length: 90, width: 90, height: 12 } },
    {
      id: 'f-cb-in',
      type: 'counterbore',
      name: '母件侧沉头孔',
      params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, positions: [[-30, -30], [30, 30]] }
    },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' }, suppressed: true }
  ]
};

test('树渲染：四个特征都在 HTML 里，选中项与压缩项有对应 class', () => {
  const html = renderFeatureTreeHtml(buildFeatureTree(demoDoc), 'f-cb-in');
  assert.ok(html.includes('data-tree-id="f-cb-in"'));
  assert.ok(html.includes('母件侧沉头孔'));
  assert.ok(html.includes('沉孔'));
  assert.ok(html.includes('tree-node--selected'));
  assert.ok(html.includes('tree-node--suppressed'));
});

test('面板渲染：沉孔字段齐全，单位与布尔值按中文呈现', () => {
  const html = renderPanelHtml('母件侧沉头孔', panelFieldsForFeature(demoDoc.features[1]));
  assert.ok(html.includes('沉窝直径'));
  assert.ok(html.includes('8.5 mm'));
  assert.ok(html.includes('沉窝深度'));
  assert.ok(html.includes('5 mm'));
  assert.ok(renderPanelHtml('测试', [{ key: 'counterBore', label: '沉头', value: true }]).includes('是'));
});

test('转义：名称里的尖括号不原样进 HTML', () => {
  assert.equal(escapeHtml('<a>&"'), '&lt;a&gt;&amp;&quot;');
  const html = renderFeatureTreeHtml(buildFeatureTree({
    features: [{ id: 'f-x', type: 'holes', name: '<script>', params: {} }]
  }));
  assert.ok(!html.includes('<script>'));
});
