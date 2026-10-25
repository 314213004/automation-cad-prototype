import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDxf, parseDxfPairs } from '../../src/cad/dxf.ts';

function dxf(entities) {
  return `0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;
}

function entity(type, ...codes) {
  return `0\n${type}\n${codes.join('')}`;
}

test('parseDxfPairs：两行一对，跳过非数字组码', () => {
  const pairs = parseDxfPairs('0\nLINE\n10\n5.5\nabc\nxyz\n20\n-3\n');
  assert.deepEqual(pairs, [[0, 'LINE'], [10, '5.5'], [20, '-3']]);
});

test('LINE：得到一条线段，bounds 精确', () => {
  const drawing = parseDxf(dxf(entity('LINE', '10\n0\n20\n0\n11\n100\n21\n0\n')));
  assert.equal(drawing.segments.length, 1);
  assert.deepEqual(drawing.segments[0].points, [0, 0, 0, 100, 0, 0]);
  assert.deepEqual(drawing.bounds.min, [0, 0, 0]);
  assert.deepEqual(drawing.bounds.max, [100, 0, 0]);
  assert.equal(drawing.stats.lines, 1);
});

test('CIRCLE：闭合折线，首尾回到起点，半径正确', () => {
  const drawing = parseDxf(dxf(entity('CIRCLE', '10\n0\n20\n0\n40\n50\n')));
  assert.ok(drawing.segments.length >= 8);
  const first = drawing.segments[0].points;
  const last = drawing.segments[drawing.segments.length - 1].points;
  assert.ok(Math.abs(first[0] - 50) < 1e-9 && Math.abs(first[1]) < 1e-9, '起点在 (50,0)（角度 0 起画）');
  assert.ok(Math.abs(last[3] - first[0]) < 1e-6 && Math.abs(last[4] - first[1]) < 1e-6, '末点回到起点，圆闭合');
  assert.equal(drawing.stats.circles, 1);
});

test('ARC：只画给定角度范围', () => {
  const drawing = parseDxf(dxf(entity('ARC', '10\n0\n20\n0\n40\n10\n50\n0\n51\n90\n')));
  const xs = drawing.segments.flatMap((s) => [s.points[0], s.points[3]]);
  const ys = drawing.segments.flatMap((s) => [s.points[1], s.points[4]]);
  assert.ok(Math.min(...xs) >= -1e-9, '0..90° 不应出现负 X');
  assert.ok(Math.min(...ys) >= -1e-9, '0..90° 不应出现负 Y');
  assert.ok(Math.max(...xs) > 9.9);
});

test('LWPOLYLINE 闭合：末尾补回起点的线段', () => {
  const drawing = parseDxf(dxf(entity('LWPOLYLINE', '70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n')));
  assert.equal(drawing.segments.length, 3, '两条边 + 一条闭合边');
  assert.deepEqual(drawing.segments[2].points, [10, 10, 0, 0, 0, 0]);
});

test('INSERT：块内容按平移/旋转/缩放展开（矩阵合成）', () => {
  const blocks = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nB1\n0\nLINE\n8\nINNER\n10\n0\n20\n0\n11\n10\n21\n0\n0\nENDBLK\n0\nENDSEC\n`;
  const entities = entity('INSERT', '2\nB1\n10\n100\n20\n50\n41\n2\n42\n2\n50\n90\n');
  const drawing = parseDxf(`${blocks}0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`);
  const seg = drawing.segments[0].points;
  // 块内线段 (0,0)-(10,0)，scale=2 → (0,0)-(20,0)，rotation=90° → (0,0)-(0,20)，再平移 (100,50)
  assert.equal(drawing.stats.inserts, 1);
  assert.deepEqual(seg.map((n) => Math.round(n)), [100, 50, 0, 100, 70, 0]);
});

test('嵌套 INSERT：双层变换不产生坐标爆炸', () => {
  const blocks = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nINNER\n0\nLINE\n10\n0\n20\n0\n11\n10\n21\n0\n0\nENDBLK\n0\nBLOCK\n2\nOUTER\n0\nINSERT\n2\nINNER\n10\n0\n20\n0\n41\n2\n42\n2\n0\nENDBLK\n0\nENDSEC\n`;
  const entities = entity('INSERT', '2\nOUTER\n10\n1000\n20\n0\n41\n3\n42\n3\n');
  const drawing = parseDxf(`${blocks}0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`);
  const seg = drawing.segments[0].points;
  assert.ok(Math.max(...seg.map(Math.abs)) < 2000, `坐标应保持在千级，实际 ${seg}`);
});

test('文字/标注/填充不转几何，只计数', () => {
  const drawing = parseDxf(dxf(
    entity('TEXT', '10\n0\n20\n0\n1\nhello\n') +
    entity('DIMENSION', '10\n0\n20\n0\n') +
    entity('HATCH', '10\n0\n20\n0\n')
  ));
  assert.equal(drawing.segments.length, 0);
  assert.deepEqual([drawing.stats.skippedText, drawing.stats.skippedDimension, drawing.stats.skippedHatch], [1, 1, 1]);
  assert.equal(drawing.bounds, null);
});
