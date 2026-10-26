import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLayoutDxf, describeLayoutDxf, layoutStations } from '../../src/canvas/layout-dxf.ts';
import { buildOrthoView } from '../../src/canvas/view-model.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('layoutStations：Y 轴翻转（画布 Y 向下 → DXF Y 向上）', () => {
  const view = buildOrthoView(demoCanvasGraph());
  const stations = layoutStations(view.stations, view.boundsMm);
  const frame = stations.find((station) => station.id === 'FRAME');
  // 机架从下沿起、高 650，整体高也是 650 → cadY 应为 0
  assert.equal(frame.cadY, 0);
  assert.equal(frame.cadX, 0);
  const cam = stations.find((station) => station.id === 'CAM');
  // CAM 在 mmY=480、高 90 → DXF 里 y = 650 - (480+90) = 80
  assert.equal(cam.cadY, 80);
});

test('buildLayoutDxf：出 DXF 文本，工位矩形数 = 工位数 + 外框', () => {
  const graph = demoCanvasGraph();
  const view = buildOrthoView(graph);
  const result = buildLayoutDxf(graph, view);
  assert.equal(result.stations, view.stations.length);
  assert.equal(result.widthMm, 1160);
  assert.equal(result.heightMm, 650);
  assert.equal(result.dimensions, 7, '不选中节点时：2 条总尺寸 + 5 段中心距');
  assert.ok(result.dxf.startsWith('0\nSECTION'));
  assert.ok(result.dxf.trimEnd().endsWith('EOF'));
  const rects = (result.dxf.match(/\nLWPOLYLINE\n/g) ?? []).length;
  assert.ok(rects >= result.stations + 1, `矩形数 ${rects} 少于 工位+外框`);
  for (const layer of ['OUTLINE', 'STATION', 'ADAPTER', 'DIM', 'TEXT']) {
    assert.ok(result.dxf.includes(layer), `缺少图层 ${layer}`);
  }
  assert.ok(result.dxf.includes('2D 排布图'));
  assert.ok(result.dxf.includes('重叠不代表干涉'));
});

test('buildLayoutDxf：同一输入两次结构一致（dxf-writer 的句柄号会递增，字节不保证相同）', () => {
  const graph = demoCanvasGraph();
  const view = buildOrthoView(graph);
  const first = buildLayoutDxf(graph, view);
  const second = buildLayoutDxf(graph, view);
  assert.equal(first.stations, second.stations);
  assert.equal(first.dimensions, second.dimensions);
  assert.equal((first.dxf.match(/\nLWPOLYLINE\n/g) ?? []).length, (second.dxf.match(/\nLWPOLYLINE\n/g) ?? []).length);
  assert.equal(first.dxf.split('\n')[0], second.dxf.split('\n')[0]);
  assert.equal(first.dxf.includes('2D 排布图'), second.dxf.includes('2D 排布图'));
});

test('describeLayoutDxf：讲清尺寸/工位/尺寸条数', () => {
  const graph = demoCanvasGraph();
  const text = describeLayoutDxf(buildLayoutDxf(graph, buildOrthoView(graph)));
  assert.match(text, /1160×650mm/);
  assert.match(text, /6 个工位/);
  assert.match(text, /1:1 mm/);
  assert.match(describeLayoutDxf(null), /没有可导出的 2D 排布/);
});
