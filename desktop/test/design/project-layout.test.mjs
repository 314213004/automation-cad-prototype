import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectLayoutPlacements, projectLayoutBounds, renderProjectLayoutSvg } from '../../src/design/project-layout.ts';
import { buildProjectLayoutValidationView } from '../../src/design/project-layout-validation.ts';

const placement = {
  id: 'station:station-1',
  partId: 'station:station-1',
  model: '上料工位',
  x: 120,
  y: 240,
  w: 280,
  h: 140,
  tag: '工位',
  note: '入口'
};

test('工程布局解析保留兼容字段和精确毫米坐标', () => {
  assert.deepEqual(parseProjectLayoutPlacements([placement]), [placement]);
});

test('工程布局解析拒绝坏条目、无界尺寸、越界外沿、重复 ID 和超量输入', () => {
  assert.equal(parseProjectLayoutPlacements([{ ...placement, x: Number.NaN }]), null);
  assert.equal(parseProjectLayoutPlacements([{ ...placement, w: 0 }]), null);
  assert.equal(parseProjectLayoutPlacements([{ ...placement, x: 1_000_001 }]), null);
  assert.equal(parseProjectLayoutPlacements([{ ...placement, x: 1_000_000, w: 1 }]), null);
  assert.equal(parseProjectLayoutPlacements([placement, placement]), null);
  assert.equal(parseProjectLayoutPlacements(Array.from({ length: 2001 }, () => placement)), null);
});

test('布局范围覆盖项目包络与坐标外接框，不移动原坐标', () => {
  assert.deepEqual(projectLayoutBounds([{ ...placement, x: -20, y: 40 }], [500, 300, 800]), {
    x: -20,
    y: 0,
    width: 520,
    height: 300
  });
});

test('只读 SVG 转义用户可控文本并保留布局毫米坐标', () => {
  const items = [{ ...placement, model: '<script>alert(1)</script>' }];
  const bounds = projectLayoutBounds(items, [500, 300, 800]);
  const rendered = renderProjectLayoutSvg(items, bounds);
  assert.match(rendered.markup, /&lt;script&gt;/);
  assert.doesNotMatch(rendered.markup, /<script>/);
  assert.match(rendered.markup, /viewBox="0 0 500 380"/);
  assert.match(rendered.markup, /x="120" y="240" width="280" height="140"/);
  assert.equal(rendered.widthPx, 500);
  assert.equal(rendered.heightPx, 380);
});

test('交互 SVG 只为编辑模式输出可定位项目标记', () => {
  const bounds = projectLayoutBounds([placement]);
  const interactive = renderProjectLayoutSvg([placement], bounds, 1100, 620, { interactive: true, selectedId: placement.id });
  assert.match(interactive.markup, /data-layout-placement="station:station-1"/);
  assert.match(interactive.markup, /data-layout-selected="true"/);
  assert.match(interactive.markup, /可编辑的已保存二维毫米布局/);
  const readonly = renderProjectLayoutSvg([placement], bounds);
  assert.doesNotMatch(readonly.markup, /data-layout-placement=/);
  assert.match(readonly.markup, /只读/);
});

test('编辑器 SVG 数据路径绘制真实项目包络并标出重叠与越界项', () => {
  const items = [
    { ...placement, id: 'station:a', model: '工位 A', x: 0, y: 0, w: 100, h: 80 },
    { ...placement, id: 'station:b', model: '工位 B', x: 50, y: 20, w: 100, h: 80 },
    { ...placement, id: 'part:c', model: '边界外传感器', x: 950, y: 550, w: 80, h: 60 }
  ];
  const envelope = [1000, 600, 900];
  const validation = buildProjectLayoutValidationView(items, envelope);
  const svg = renderProjectLayoutSvg(items, projectLayoutBounds(items, envelope), 1100, 620, {
    interactive: true,
    projectEnvelope: envelope,
    validation
  }).markup;
  assert.match(svg, /data-project-envelope="true" x="0" y="0" width="1000" height="600"/);
  assert.match(svg, /data-layout-placement="station:a" data-layout-state="overlap"/);
  assert.match(svg, /data-layout-placement="station:b" data-layout-state="overlap"/);
  assert.match(svg, /data-layout-placement="part:c" data-layout-state="out-of-bounds"/);
  assert.match(svg, /stroke="#e59a22"/);
  assert.match(svg, /stroke="#e15b50"/);
});
