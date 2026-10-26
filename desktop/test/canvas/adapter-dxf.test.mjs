import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterHoleLayout, adapterPlateDxf, describeAdapterDxf } from '../../src/canvas/adapter-dxf.ts';
import { insertAdapterForEdge } from '../../src/canvas/graph.ts';
import { createDefaultAdapterFactory } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

function adapterNode(dowelDiaMm = 0) {
  const inserted = insertAdapterForEdge(demoCanvasGraph(), 'e-y-z', createDefaultAdapterFactory({ dowelDiaMm }));
  return { node: inserted.graph.nodes.find((item) => item.kind === 'adapter'), graph: inserted.graph };
}

test('adapterHoleLayout：绝对坐标落在板内，两端孔数正确，销孔可选', () => {
  const { node } = adapterNode(0);
  const holes = adapterHoleLayout(node);
  assert.equal(holes.length, node.adapterParams.fromPort.count + node.adapterParams.toPort.count);
  for (const hole of holes) {
    assert.ok(hole.x >= 0 && hole.x <= node.dimsMm[0], `孔 x=${hole.x} 越界`);
    assert.ok(hole.y >= 0 && hole.y <= node.dimsMm[1], `孔 y=${hole.y} 越界`);
  }
  const withDowel = adapterHoleLayout(adapterNode(4).node);
  assert.equal(withDowel.filter((hole) => hole.group === 'dowel').length, 2);
});

test('adapterPlateDxf：出 DXF 文本，圆数=孔数，图元分层', () => {
  const { node } = adapterNode(4);
  const result = adapterPlateDxf(node);
  assert.ok(result);
  assert.equal(result.widthMm, 90);
  assert.equal(result.heightMm, 90);
  assert.equal(result.thicknessMm, 12);
  assert.equal(result.holes, 8);
  assert.equal(result.dowels, 2);
  const circles = (result.dxf.match(/\nCIRCLE\n/g) ?? []).length;
  assert.equal(circles, 10, '8 个安装孔 + 2 个销孔');
  for (const layer of ['OUTLINE', 'HOLES-IN', 'HOLES-OUT', 'PILOT', 'TEXT']) {
    assert.ok(result.dxf.includes(layer), `缺少图层 ${layer}`);
  }
  assert.ok(result.dxf.startsWith('0\nSECTION'));
  assert.ok(result.dxf.trimEnd().endsWith('EOF'));
  assert.ok(result.dxf.includes('仅开孔图'), '必须带「不含公差/不替代 B-Rep」说明');
  assert.ok(result.dxf.includes('COUNTERBORE'), '沉头必须在图纸上标注说明');
});

test('adapterPlateDxf：非转接板返回 null', () => {
  const graph = demoCanvasGraph();
  assert.equal(adapterPlateDxf(graph.nodes[1]), null);
});

test('describeAdapterDxf：讲清尺寸/孔数/比例，无板时明说', () => {
  const { node } = adapterNode(0);
  const text = describeAdapterDxf(adapterPlateDxf(node));
  assert.match(text, /90×90×12mm/);
  assert.match(text, /通孔 8 个/);
  assert.match(text, /1:1 mm/);
  assert.match(describeAdapterDxf(null), /没有可导出的转接板/);
});
