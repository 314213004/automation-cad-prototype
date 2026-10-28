import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAssemblyTree,
  buildFeatureTree,
  findTreeNode,
  panelFieldsForAdapter,
  panelFieldsForFeature
} from '../../src/canvas/feature-tree.ts';

// 演示转接板的 FeatureDoc（adapter-model.ts 的 adapterFeatureDoc 形状，
// 字段名原样保留，只在界面术语上映射）。
const demoDoc = {
  features: [
    { id: 'f-body', type: 'box', name: '90×90×12 板体', params: { length: 90, width: 90, height: 12, centered: true } },
    {
      id: 'f-cb-in',
      type: 'counterbore',
      name: '母件侧沉头孔 Ø5.5 / Ø8.5×5（M5）',
      params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, depth: 'through', positions: [[-30, -30], [30, -30], [-30, 30], [30, 30]] }
    },
    {
      id: 'f-holes-out',
      type: 'holes',
      name: '子件侧孔阵列（body）',
      params: { diameter: 5.5, depth: 'through', positions: [[-24, -18], [24, -18], [-24, 18], [24, 18]] }
    },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
  ]
};

test('特征树：按 FeatureDoc 顺序渲染四个特征，术语只映射不改类型', () => {
  const tree = buildFeatureTree(demoDoc);
  assert.equal(tree.kind, 'part');
  assert.deepEqual(
    tree.children.map((c) => c.id),
    ['f-body', 'f-cb-in', 'f-holes-out', 'f-fillet']
  );
  assert.deepEqual(
    tree.children.map((c) => c.displayType),
    ['拉伸（凸台）', '沉孔', '孔', '圆角/倒角']
  );
  assert.deepEqual(
    tree.children.map((c) => c.featureType),
    ['box', 'counterbore', 'holes', 'fillet']
  );
});

test('特征树：suppressed 特征照常列出并标记压缩，不丢节点', () => {
  const tree = buildFeatureTree({
    features: [{ id: 'f-x', type: 'holes', name: '孔', params: { diameter: 5.5 }, suppressed: true }]
  });
  assert.equal(tree.children[0].suppressed, true);
  assert.equal(findTreeNode(tree, 'f-x').label, '孔');
  assert.equal(findTreeNode(tree, '不存在'), null);
});

test('装配树：节点即组件，边即配合，名称按节点名呈现', () => {
  const tree = buildAssemblyTree({
    nodes: [
      { id: 'a', name: '直线模组', kind: 'linear' },
      { id: 'b', name: '转接板', kind: 'adapter' }
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b' }]
  });
  assert.equal(tree.kind, 'assembly');
  assert.deepEqual(
    tree.children.map((c) => [c.kind, c.label]),
    [['component', '直线模组'], ['component', '转接板'], ['mate', '配合 直线模组 → 转接板']]
  );
});

test('属性面板：沉孔列出孔径、沉窝直径与深度，不丢字段', () => {
  const fields = panelFieldsForFeature(demoDoc.features[1]);
  assert.deepEqual(
    fields.map((f) => [f.key, f.value]),
    [['diameter', 5.5], ['cbDiameter', 8.5], ['cbDepth', 5]]
  );
  assert.deepEqual(panelFieldsForFeature(demoDoc.features[3]), [
    { key: 'radius', label: '圆角半径', value: 3, unit: 'mm' },
    { key: 'edges', label: '边', value: '|Z' }
  ]);
});

test('属性面板：转接板列出两端端口与板参数，金额不进面板', () => {
  const fields = panelFieldsForAdapter({
    fromPort: { family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 },
    toPort: { family: 'body', holeDiaMm: 5.5, pitchXMm: 48, pitchYMm: 36, count: 4 },
    plateDimsMm: [90, 90, 12],
    thicknessMm: 12,
    material: '6061-T6',
    counterBore: true,
    dowelDiaMm: 0,
    massKg: 1
  });
  assert.ok(fields.some((f) => f.key === 'fromPort.pitchXMm' && f.value === 60));
  assert.ok(fields.some((f) => f.key === 'toPort.pitchYMm' && f.value === 36));
  assert.ok(fields.some((f) => f.key === 'material' && f.value === '6061-T6'));
  assert.ok(!fields.some((f) => f.key.includes('cost') || f.key.includes('Yuan')));
});
