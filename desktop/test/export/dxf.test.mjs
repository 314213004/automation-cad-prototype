import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toDxf } from '../../src/export/dxf.ts';

test('DXF 含 SECTION / ENTITIES 与三视图图框', () => {
  const dxf = toDxf([
    { name: '底座', bbox: { min: [0, 0, 0], max: [100, 80, 30] } },
    { name: '立柱', bbox: { min: [20, 20, 30], max: [50, 50, 160] } }
  ]);
  assert.match(dxf, /SECTION/);
  assert.match(dxf, /ENTITIES/);
  assert.match(dxf, /主视图/);
  assert.match(dxf, /俯视图/);
  assert.match(dxf, /左视图/);
  assert.ok(dxf.length > 1000);
});

test('空形状仍输出 A3 图框', () => {
  const dxf = toDxf([]);
  assert.match(dxf, /SECTION/);
  assert.match(dxf, /AutomationCAD/);
});

test('非法形状包围盒抛中文错误', () => {
  assert.throws(
    () => toDxf([{ name: 'bad', bbox: { min: [0, 0, Number.NaN], max: [1, 1, 1] } }]),
    /DXF 形状缺少有效/
  );
});
