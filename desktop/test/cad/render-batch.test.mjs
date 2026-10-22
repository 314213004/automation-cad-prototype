import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPartMeta, buildPartMetas, planFrame } from '../../src/cad/render-plan.ts';
import {
  boxProxyGeometry,
  buildRenderOps,
  centerGeometry,
  decimateMesh,
  describeRenderOps
} from '../../src/cad/render-batch.ts';

/** 边长 size、中心在 origin 的立方体：12 个三角面、24 个顶点、带索引 */
function cube(size = 100) {
  const h = size / 2;
  const corners = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]
  ];
  const faces = [
    [0, 3, 2], [0, 2, 1],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7]
  ];
  const positions = new Float32Array(corners.length * 3);
  corners.forEach((corner, index) => {
    positions[index * 3] = corner[0];
    positions[index * 3 + 1] = corner[1];
    positions[index * 3 + 2] = corner[2];
  });
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const length = Math.hypot(positions[i], positions[i + 1], positions[i + 2]) || 1;
    normals[i] = positions[i] / length;
    normals[i + 1] = positions[i + 1] / length;
    normals[i + 2] = positions[i + 2] / length;
  }
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((face, index) => {
    indices[index * 3] = face[0];
    indices[index * 3 + 1] = face[1];
    indices[index * 3 + 2] = face[2];
  });
  return { positions, normals, indices };
}

function shifted(source, dx, dy = 0, dz = 0) {
  const positions = new Float32Array(source.positions.length);
  for (let i = 0; i < source.positions.length; i += 3) {
    positions[i] = source.positions[i] + dx;
    positions[i + 1] = source.positions[i + 1] + dy;
    positions[i + 2] = source.positions[i + 2] + dz;
  }
  return { ...source, positions };
}

/** 大网格：用于触发 LOD 降级（三角面数需超过 skipBelowTriangles） */
function denseMesh(triangles) {
  const positions = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t += 1) {
    const base = t * 9;
    const x = (t % 50) * 2;
    const y = Math.floor(t / 50) * 2;
    positions[base] = x;
    positions[base + 1] = y;
    positions[base + 2] = 0;
    positions[base + 3] = x + 2;
    positions[base + 4] = y;
    positions[base + 5] = 0;
    positions[base + 6] = x;
    positions[base + 7] = y + 2;
    positions[base + 8] = 0;
  }
  return { positions, normals: null, indices: null };
}

test('centerGeometry 把几何平移到原点并保留三角面数', () => {
  const mesh = shifted(cube(100), 500, 0, 0);
  const meta = buildPartMeta({ name: '方钢', positions: mesh.positions, indices: mesh.indices }, 0);
  const centered = centerGeometry(mesh, meta.center);
  assert.equal(centered.triangleCount, 12);
  assert.equal(centered.positions.length, mesh.positions.length);
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < centered.positions.length; i += 3) {
    minX = Math.min(minX, centered.positions[i]);
    maxX = Math.max(maxX, centered.positions[i]);
  }
  assert.ok(Math.abs(minX + 50) < 1e-4, `minX=${minX}`);
  assert.ok(Math.abs(maxX - 50) < 1e-4, `maxX=${maxX}`);
  assert.deepEqual(centered.center, meta.center);
});

test('centerGeometry 保留法线与索引', () => {
  const mesh = cube(20);
  const meta = buildPartMeta({ name: '方块', positions: mesh.positions, indices: mesh.indices }, 0);
  const centered = centerGeometry(mesh, meta.center);
  assert.ok(centered.normals);
  assert.equal(centered.normals.length, centered.positions.length);
  assert.ok(centered.indices);
  assert.equal(centered.indices.length, 36);
  assert.equal(centered.indices[0], 0);
});

test('centerGeometry 不修改入参顶点数组', () => {
  const mesh = cube(10);
  const before = Array.from(mesh.positions);
  centerGeometry(mesh, { x: 3, y: 4, z: 5 });
  assert.deepEqual(Array.from(mesh.positions), before);
});

test('decimateMesh 按比例抽样且结果确定', () => {
  const mesh = denseMesh(3000);
  const a = decimateMesh(mesh, 0.35);
  const b = decimateMesh(mesh, 0.35);
  assert.ok(a.triangleCount > 0);
  assert.ok(a.triangleCount < 3000, `triangleCount=${a.triangleCount}`);
  assert.equal(a.positions.length, a.triangleCount * 9);
  assert.deepEqual(Array.from(a.positions.slice(0, 90)), Array.from(b.positions.slice(0, 90)));
});

test('decimateMesh 比例为 1 时保留全部三角面', () => {
  const mesh = denseMesh(120);
  const result = decimateMesh(mesh, 1);
  assert.equal(result.triangleCount, 120);
});

test('decimateMesh 空几何返回空结果不抛错', () => {
  const result = decimateMesh({ positions: new Float32Array(0), indices: null }, 0.35);
  assert.equal(result.triangleCount, 0);
  assert.equal(result.positions.length, 0);
  assert.equal(result.normals, null);
});

test('decimateMesh 抽样顶点都来自原始网格（无 NaN）', () => {
  const mesh = denseMesh(200);
  const result = decimateMesh(mesh, 0.04);
  assert.ok(result.triangleCount >= 1);
  for (const value of result.positions) assert.ok(Number.isFinite(value));
  const xs = new Set(Array.from(mesh.positions).filter((_, index) => index % 3 === 0));
  for (let i = 0; i < result.positions.length; i += 3) {
    assert.ok(xs.has(result.positions[i]), `x=${result.positions[i]} 不在原网格中`);
  }
});

test('boxProxyGeometry 是 12 面盒且贴合包围盒', () => {
  const mesh = shifted(cube(80), -200, 40, 10);
  const meta = buildPartMeta({ name: '电机', positions: mesh.positions, indices: mesh.indices }, 0);
  const proxy = boxProxyGeometry(meta);
  assert.equal(proxy.triangleCount, 12);
  assert.equal(proxy.positions.length, 12 * 9);
  assert.equal(proxy.normals.length, 12 * 9);
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < proxy.positions.length; i += 3) {
    minX = Math.min(minX, proxy.positions[i]);
    maxX = Math.max(maxX, proxy.positions[i]);
  }
  assert.ok(Math.abs(minX - meta.bbox.min.x) < 1e-4);
  assert.ok(Math.abs(maxX - meta.bbox.max.x) < 1e-4);
});

test('buildRenderOps 把不可见零件放进 hidden', () => {
  const meshes = [cube(100), shifted(cube(100), 5000, 0, 0)];
  const metas = buildPartMetas(meshes.map((mesh, index) => ({ name: `件${index}`, positions: mesh.positions, indices: mesh.indices })));
  const plan = planFrame(metas, {
    position: { x: 0, y: 0, z: 800 },
    fovDeg: 42,
    planes: [{ normal: { x: -1, y: 0, z: 0 }, constant: 300 }]
  });
  const ops = buildRenderOps(plan, metas);
  assert.ok(ops.hidden.length >= 1);
  assert.ok(ops.hidden.includes(1));
  assert.ok(!ops.hidden.includes(0));
});

test('buildRenderOps 同款零件合成一个实例 op 并给出平移矩阵', () => {
  const base = cube(100);
  const meshes = [base, shifted(base, 300, 0, 0), shifted(base, 0, 300, 0)];
  const metas = buildPartMetas(meshes.map((mesh, index) => ({ name: `方钢${index}`, positions: mesh.positions, indices: mesh.indices })));
  const plan = planFrame(metas, { position: { x: 150, y: 150, z: 2500 }, fovDeg: 42 });
  assert.equal(plan.instanceGroups.length, 1);
  const ops = buildRenderOps(plan, metas);
  assert.equal(ops.instanceGroups, 1);
  const instance = ops.ops.find((op) => op.kind === 'instance');
  assert.ok(instance);
  assert.equal(instance.partIndices.length, 3);
  assert.equal(instance.matrices.length, 48);
  // 列主序平移矩阵：第 13/14/15 个 float 是 x/y/z
  for (let i = 0; i < instance.centers.length; i += 1) {
    const offset = i * 16;
    assert.equal(instance.matrices[offset], 1);
    assert.equal(instance.matrices[offset + 5], 1);
    assert.equal(instance.matrices[offset + 10], 1);
    assert.equal(instance.matrices[offset + 15], 1);
    assert.ok(Math.abs(instance.matrices[offset + 12] - instance.centers[i].x) < 1e-4);
    assert.ok(Math.abs(instance.matrices[offset + 13] - instance.centers[i].y) < 1e-4);
    assert.ok(Math.abs(instance.matrices[offset + 14] - instance.centers[i].z) < 1e-4);
  }
});

test('buildRenderOps 合批后 drawCall 少于零件数', () => {
  const base = cube(100);
  const meshes = Array.from({ length: 8 }, (_, index) => shifted(base, index * 200, 0, 0));
  const metas = buildPartMetas(meshes.map((mesh, index) => ({ name: `导轨${index}`, positions: mesh.positions, indices: mesh.indices })));
  const plan = planFrame(metas, { position: { x: 700, y: 0, z: 4000 }, fovDeg: 42 });
  const ops = buildRenderOps(plan, metas);
  assert.equal(plan.parts.length, 8);
  assert.equal(ops.drawCalls, 1);
  assert.ok(ops.drawCalls < plan.parts.length);
});

test('buildRenderOps 统计各级 LOD 数量', () => {
  const dense = denseMesh(4000);
  const metas = buildPartMetas([
    { name: '近件', positions: cube(200).positions, indices: cube(200).indices },
    { name: '远件', positions: dense.positions, indices: null }
  ]);
  const plan = planFrame(metas, { position: { x: 0, y: 0, z: 4000 }, fovDeg: 42 });
  const ops = buildRenderOps(plan, metas);
  assert.equal(ops.lodCounts.reduce((sum, value) => sum + value, 0), plan.parts.length);
  const far = plan.parts.find((part) => part.name === '远件');
  assert.ok(far);
  assert.notEqual(far.lod, 0, '远件应降级');
  assert.ok(ops.lodCounts[far.lod] >= 1);
});

test('buildRenderOps 每个可见零件都有对应绘制指令', () => {
  const base = cube(100);
  const meshes = [base, shifted(base, 400, 0, 0), shifted(denseMesh(3000), 0, 400, 0)];
  const metas = buildPartMetas(meshes.map((mesh, index) => ({ name: `件${index}`, positions: mesh.positions, indices: mesh.indices })));
  const plan = planFrame(metas, { position: { x: 200, y: 200, z: 3000 }, fovDeg: 42 });
  const ops = buildRenderOps(plan, metas);
  const covered = new Set();
  for (const op of ops.ops) {
    if (op.kind === 'instance') for (const index of op.partIndices) covered.add(index);
    else covered.add(op.partIndex);
  }
  for (const part of plan.parts) assert.ok(covered.has(part.index), `零件 ${part.name} 没有绘制指令`);
  assert.equal(ops.triangles, plan.parts.reduce((sum, part) => sum + part.triangles, 0));
});

test('describeRenderOps 输出中文概要', () => {
  const metas = buildPartMetas([
    { name: 'A', positions: cube(100).positions, indices: cube(100).indices },
    { name: 'B', positions: shifted(cube(100), 300).positions, indices: cube(100).indices }
  ]);
  const plan = planFrame(metas, { position: { x: 150, y: 0, z: 2000 }, fovDeg: 42 });
  const text = describeRenderOps(buildRenderOps(plan, metas));
  assert.match(text, /绘制 \d+ 批/);
  assert.match(text, /实例组 \d+/);
  assert.match(text, /LOD \d+\/\d+\/\d+/);
  assert.match(text, /三角面/);
});

test('buildRenderOps 空计划返回空指令表', () => {
  const plan = planFrame([], { position: { x: 0, y: 0, z: 100 }, fovDeg: 42 });
  const ops = buildRenderOps(plan, []);
  assert.deepEqual(ops.ops, []);
  assert.deepEqual(ops.hidden, []);
  assert.equal(ops.drawCalls, 0);
  assert.equal(ops.triangles, 0);
});

test('buildPartMeta 的 bbox 与顶点范围一致（代理盒依赖）', () => {
  const mesh = shifted(cube(60), 12, -34, 56);
  const meta = buildPartMeta({ name: '块', positions: mesh.positions, indices: mesh.indices }, 0);
  assert.ok(Math.abs(meta.bbox.min.x - (12 - 30)) < 1e-4);
  assert.ok(Math.abs(meta.bbox.max.x - (12 + 30)) < 1e-4);
  assert.ok(Math.abs(meta.bbox.min.y - (-34 - 30)) < 1e-4);
  assert.ok(Math.abs(meta.bbox.max.z - (56 + 30)) < 1e-4);
});
