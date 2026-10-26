import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  geometryToBinaryStl,
  triangleNormal,
  unionEnvelope,
  uniquePartNames
} from '../../src/cad/stl-export.ts';

const TRI = [
  0, 0, 0,
  10, 0, 0,
  0, 10, 0
];

test('triangleNormal：右手定则，退化三角形退回 +Z 不写 NaN', () => {
  assert.deepEqual(triangleNormal(0, 0, 0, 10, 0, 0, 0, 10, 0), [0, 0, 1]);
  assert.deepEqual(triangleNormal(0, 0, 0, 1, 1, 1, 2, 2, 2), [0, 0, 1], '共线退化');
  const n = triangleNormal(0, 0, 0, 0, 10, 0, 10, 0, 0);
  assert.ok(Math.abs(n[2] + 1) < 1e-6, '绕序反转 → -Z');
});

test('geometryToBinaryStl：非索引网格 1 个三角形 = 134 字节，法线/顶点写对', () => {
  const stl = geometryToBinaryStl(TRI, null);
  assert.ok(stl);
  assert.equal(stl.byteLength, 84 + 50);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getUint32(80, true), 1);
  assert.equal(view.getFloat32(84, true), 0);
  assert.equal(view.getFloat32(92, true), 1, '法线 z=1');
  assert.equal(view.getFloat32(96, true), 0, '第一个顶点 x');
  assert.equal(view.getFloat32(108, true), 10, '第二个顶点 x=10');
});

test('geometryToBinaryStl：索引网格按索引取顶点', () => {
  const positions = [0, 0, 0, 10, 0, 0, 0, 10, 0, 5, 5, 5];
  const stl = geometryToBinaryStl(positions, [0, 1, 2, 0, 1, 3]);
  assert.ok(stl);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getUint32(80, true), 2);
  assert.equal(view.getFloat32(84 + 50 + 12 + 8 * 4, true), 5, '第二个三角形第三点 x=5');
});

test('geometryToBinaryStl：空几何返回 null（不生成空 STL 文件）', () => {
  assert.equal(geometryToBinaryStl([], null), null);
  assert.equal(geometryToBinaryStl(TRI, []), null);
});

test('geometryToBinaryStl：头部只写 ASCII（高位清零）', () => {
  const stl = geometryToBinaryStl(TRI, null, '示意图网格');
  const header = Buffer.from(stl.buffer, stl.byteOffset, 80).toString('utf8');
  assert.equal(/[^\x00-\x7F]/.test(header), false, '不得留下非 ASCII 字节');
});

test('unionEnvelope：多零件并集，保留 0.1mm', () => {
  const env = unionEnvelope([
    { min: [0, 0, 0], max: [100, 50, 20] },
    { min: [50, 10, 0], max: [180, 60, 30] }
  ]);
  assert.deepEqual(env, [180, 60, 30]);
  assert.equal(unionEnvelope([]), null);
});

test('uniquePartNames：重名加序号，非法字符替换', () => {
  assert.deepEqual(uniquePartNames(['a/b', 'a/b', 'c']), ['a_b', 'a_b-2', 'c']);
  assert.deepEqual(uniquePartNames(['', '']), ['零件', '零件-2']);
});
