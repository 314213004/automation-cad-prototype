import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPartMeta,
  buildPartMetas,
  chooseLod,
  DEFAULT_LOD_CONFIG,
  describePlan,
  hashGeometry,
  instanceGroupsOf,
  isSphereVisible,
  lodTriangleCount,
  normalizeLodConfig,
  planFrame,
  screenCoverage,
  withinFrameBudget
} from '../../src/cad/render-plan.ts';

/** 生成一个近似立方体的网格：cube(triangles) 不适用，这里用网格面片凑三角面数 */
function gridMesh(triangles, size = 100) {
  const positions = new Float32Array(triangles * 9);
  let filled = 0;
  for (let t = 0; t < triangles; t += 1) {
    const x = ((t % 10) / 10) * size;
    const y = (Math.floor(t / 10) % 10) / 10 * size;
    const z = Math.floor(t / 100) * 0.5;
    positions[filled++] = x;
    positions[filled++] = y;
    positions[filled++] = z;
    positions[filled++] = x + 1;
    positions[filled++] = y;
    positions[filled++] = z;
    positions[filled++] = x;
    positions[filled++] = y + 1;
    positions[filled++] = z;
  }
  return positions;
}

function boxMesh(color) {
  // 12 个三角面、8 个顶点（X/Y/Z 各方向 ±50）
  const positions = new Float32Array([
    -50, -50, -50, 50, -50, -50, 50, 50, -50, -50, 50, -50,
    -50, -50, 50, 50, -50, 50, 50, 50, 50, -50, 50, 50
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0
  ]);
  return { name: '方钢', positions, indices, color };
}

const CAMERA_FAR = { position: { x: 0, y: 0, z: 2000 }, fovDeg: 45 };
const CAMERA_NEAR = { position: { x: 0, y: 0, z: 100 }, fovDeg: 45 };

test('buildPartMeta 按索引计算三角面数', () => {
  const meta = buildPartMeta(boxMesh(), 0);
  assert.equal(meta.triangleCount, 12);
  assert.equal(meta.vertexCount, 8);
});

test('buildPartMeta 无索引时按顶点数推算三角面', () => {
  const positions = gridMesh(4);
  const meta = buildPartMeta({ name: '面片', positions }, 1);
  assert.equal(meta.triangleCount, 4);
  assert.equal(meta.index, 1);
});

test('buildPartMeta 包围球中心与半径来自顶点范围', () => {
  const meta = buildPartMeta(boxMesh(), 0);
  assert.deepEqual(meta.center, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(meta.radius - Math.hypot(100, 100, 100) / 2) < 1e-6);
  assert.ok(Math.abs(meta.diagonal - Math.hypot(100, 100, 100)) < 1e-6);
});

test('空网格三角面为 0 且指纹按序号唯一', () => {
  const empty = new Float32Array(0);
  const a = buildPartMeta({ name: '空件', positions: empty }, 3);
  const b = buildPartMeta({ name: '空件', positions: empty }, 4);
  assert.equal(a.triangleCount, 0);
  assert.equal(a.radius, 0);
  assert.notEqual(a.signature, b.signature);
});

test('hashGeometry 相同点序得到相同指纹', () => {
  const positions = gridMesh(6);
  assert.equal(hashGeometry(positions), hashGeometry(positions.slice()));
});

test('hashGeometry 量化吞掉 1e-5 的浮点噪声', () => {
  const positions = gridMesh(6);
  const noisy = Float32Array.from(positions, (v) => v + 0.00001);
  assert.equal(hashGeometry(positions), hashGeometry(noisy));
});

test('hashGeometry 顶点数不同则指纹不同', () => {
  assert.notEqual(hashGeometry(gridMesh(6)), hashGeometry(gridMesh(7)));
});

test('hashGeometry 索引参与指纹', () => {
  const box = boxMesh();
  const flipped = Uint32Array.from(box.indices);
  [flipped[0], flipped[1]] = [flipped[1], flipped[0]];
  assert.notEqual(hashGeometry(box.positions, box.indices), hashGeometry(box.positions, flipped));
});

test('hashGeometry 传入 origin 后整体平移不影响指纹', () => {
  const positions = gridMesh(6);
  const shifted = Float32Array.from(positions, (v, i) => v + (i % 3 === 0 ? 1000 : 0));
  const origin = { x: 1000, y: 0, z: 0 };
  assert.equal(hashGeometry(positions, null, { x: 0, y: 0, z: 0 }), hashGeometry(shifted, null, origin));
});

test('buildPartMeta 对平移后的同款零件给出相同指纹与不同中心', () => {
  const base = boxMesh();
  const shiftedPositions = Float32Array.from(base.positions, (v, i) => v + (i % 3 === 0 ? 500 : 0));
  const a = buildPartMeta(base, 0);
  const b = buildPartMeta({ ...base, positions: shiftedPositions }, 1);
  assert.equal(a.signature, b.signature);
  assert.equal(a.center.x, 0);
  assert.equal(b.center.x, 500);
});

test('世界坐标不同但同款的零件合并实例并保留各自中心', () => {
  const base = boxMesh();
  const shifted = Float32Array.from(base.positions, (v, i) => v + (i % 3 === 0 ? 500 : 0));
  const metas = buildPartMetas([base, { ...base, positions: shifted, name: '方钢2' }]);
  const plan = planFrame(metas, { position: { x: 250, y: 0, z: 900 }, fovDeg: 45 });
  assert.equal(plan.instanceGroups.length, 1);
  assert.equal(plan.drawCalls, 1);
  assert.deepEqual(plan.instanceGroups[0].centers, [{ x: 0, y: 0, z: 0 }, { x: 500, y: 0, z: 0 }]);
});

test('buildPartMetas 保留原始顺序下标', () => {
  const metas = buildPartMetas([boxMesh(), { name: '面片', positions: gridMesh(3) }]);
  assert.deepEqual(metas.map((m) => m.index), [0, 1]);
  assert.deepEqual(metas.map((m) => m.name), ['方钢', '面片']);
});

test('默认 LOD 配置通过自检', () => {
  const config = normalizeLodConfig();
  assert.equal(config.ratios[0], 1);
  assert.ok(config.cullCoverage < config.mediumCoverage);
});

test('简化阈值不小于满精度阈值时中文报错', () => {
  assert.throws(
    () => normalizeLodConfig({ fullCoverage: 0.1, mediumCoverage: 0.2 }),
    /简化阈值必须小于满精度阈值/
  );
});

test('剔除阈值不小于简化阈值时中文报错', () => {
  assert.throws(
    () => normalizeLodConfig({ mediumCoverage: 0.05, cullCoverage: 0.05 }),
    /剔除阈值必须小于简化阈值/
  );
});

test('比例数组首项必须为 1', () => {
  assert.throws(() => normalizeLodConfig({ ratios: [0.9, 0.4, 0.04] }), /三角面比例必须是/);
});

test('比例越界时中文报错', () => {
  assert.throws(() => normalizeLodConfig({ ratios: [1, 1.5, 0.04] }), /必须在 0 到 1 之间/);
});

test('实例合并数量小于 2 时中文报错', () => {
  assert.throws(() => normalizeLodConfig({ minInstanceCount: 1 }), /至少需要 2 个同款零件/);
});

test('满精度阈值必须大于 0', () => {
  assert.throws(() => normalizeLodConfig({ fullCoverage: 0 }), /满精度覆盖率阈值必须大于 0/);
});

test('screenCoverage 近处大件覆盖率高', () => {
  const near = screenCoverage(50, 100, 45);
  const far = screenCoverage(50, 1000, 45);
  assert.ok(near > far);
  assert.ok(Math.abs(near - 1) < 1e-9, '近距离应被钳到 1');
});

test('screenCoverage 非法输入返回 0', () => {
  assert.equal(screenCoverage(0, 100, 45), 0);
  assert.equal(screenCoverage(50, 0, 45), 0);
  assert.equal(screenCoverage(50, 100, 0), 0);
});

test('chooseLod 高覆盖取原始网格，中低覆盖逐级简化', () => {
  const config = DEFAULT_LOD_CONFIG;
  assert.equal(chooseLod(0.9, 50_000, config), 0);
  assert.equal(chooseLod(0.1, 50_000, config), 1);
  assert.equal(chooseLod(0.01, 50_000, config), 2);
});

test('三角面少的小零件不降级', () => {
  assert.equal(chooseLod(0.01, 500, DEFAULT_LOD_CONFIG), 0);
});

test('lodTriangleCount 按比例缩减且至少保留 1 个面', () => {
  assert.equal(lodTriangleCount(10_000, 0), 10_000);
  assert.equal(lodTriangleCount(10_000, 1), 3500);
  assert.equal(lodTriangleCount(10_000, 2), 400);
  assert.equal(lodTriangleCount(1, 2), 1);
  assert.equal(lodTriangleCount(0, 1), 0);
});

test('视锥平面为 null 时不做剔除', () => {
  assert.equal(isSphereVisible(null, { x: 0, y: 0, z: 0 }, 10), true);
});

test('包围球完全在平面外侧时剔除', () => {
  const planes = [{ normal: { x: 0, y: 0, z: 1 }, constant: 0 }];
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: -100 }, 10), false);
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: 100 }, 10), true);
  assert.equal(isSphereVisible(planes, { x: 0, y: 0, z: 5 }, 10), true, '与平面相交不应剔除');
});

test('planFrame 远距离相机剔除小零件', () => {
  const metas = buildPartMetas([boxMesh()]);
  const far = planFrame(metas, { position: { x: 0, y: 0, z: 200_000 }, fovDeg: 45 });
  assert.equal(far.parts.length, 0);
  assert.deepEqual(far.culled, ['方钢']);
});

test('planFrame 近距离零件可见且 LOD 为 0（面数少不降级）', () => {
  const metas = buildPartMetas([boxMesh()]);
  const plan = planFrame(metas, CAMERA_NEAR);
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0].lod, 0);
  assert.equal(plan.parts[0].triangles, 12);
});

test('planFrame 视锥平面剔除画面外零件', () => {
  const metas = buildPartMetas([boxMesh()]);
  const planes = [{ normal: { x: 0, y: 0, z: 1 }, constant: -500 }];
  const plan = planFrame(metas, { ...CAMERA_NEAR, planes });
  assert.equal(plan.parts.length, 0);
  assert.equal(plan.culled.length, 1);
});

test('planFrame 大网格远距离降级并减少三角面', () => {
  const positions = gridMesh(20_000);
  const metas = buildPartMetas([{ name: '大面片', positions }]);
  const plan = planFrame(metas, CAMERA_FAR);
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0].lod, 1);
  assert.ok(plan.visibleTriangles < plan.sourceTriangles);
  assert.equal(plan.visibleTriangles, lodTriangleCount(20_000, 1));
});

test('同指纹同色零件合并为实例组并降低 drawCall', () => {
  const metas = buildPartMetas([boxMesh(), boxMesh(), boxMesh()]);
  const plan = planFrame(metas, CAMERA_NEAR);
  assert.equal(plan.naiveDrawCalls, 3);
  assert.equal(plan.instanceGroups.length, 1);
  assert.equal(plan.instanceGroups[0].count, 3);
  assert.equal(plan.drawCalls, 1);
  assert.equal(plan.instanceGroups[0].triangles, 36);
});

test('颜色不同不合并实例', () => {
  const metas = buildPartMetas([boxMesh([1, 0, 0]), boxMesh([0, 0, 1])]);
  const plan = planFrame(metas, CAMERA_NEAR);
  assert.equal(plan.instanceGroups.length, 0);
  assert.equal(plan.drawCalls, 2);
});

test('同款零件只有一个时不建实例组', () => {
  const metas = buildPartMetas([boxMesh()]);
  const plan = planFrame(metas, CAMERA_NEAR);
  assert.equal(plan.instanceGroups.length, 0);
  assert.equal(plan.drawCalls, 1);
});

test('实例只合并 LOD0 零件（简化网格形状不同）', () => {
  const big = gridMesh(20_000);
  const metas = buildPartMetas([
    { name: '大面片A', positions: big },
    { name: '大面片B', positions: big }
  ]);
  const plan = planFrame(metas, CAMERA_FAR);
  assert.equal(plan.parts.every((p) => p.lod !== 0), true);
  const groups = instanceGroupsOf(plan.parts);
  assert.equal(groups.length, 0);
});

test('无三角面的零件被跳过并给出中文提示', () => {
  const metas = buildPartMetas([{ name: '坏件', positions: new Float32Array(0) }]);
  const plan = planFrame(metas, CAMERA_NEAR);
  assert.equal(plan.parts.length, 0);
  assert.match(plan.warnings.join('|'), /坏件.*没有三角面/);
});

test('全部不可见时给出中文告警', () => {
  const metas = buildPartMetas([boxMesh()]);
  const plan = planFrame(metas, { position: { x: 0, y: 0, z: 300_000 }, fovDeg: 45 });
  assert.match(plan.warnings.join('|'), /所有零件都不可见/);
});

test('describePlan 输出中文统计且含实例信息', () => {
  const metas = buildPartMetas([boxMesh(), boxMesh(), boxMesh()]);
  const plan = planFrame(metas, CAMERA_NEAR);
  const text = describePlan(plan, 120);
  assert.match(text, /可见 3\/3 个零件/);
  assert.match(text, /drawCall 1/);
  assert.match(text, /实例组 1/);
  assert.match(text, /耗时 120\.0ms 达标/);
});

test('withinFrameBudget 以 3 秒为默认预算', () => {
  assert.equal(withinFrameBudget(2999), true);
  assert.equal(withinFrameBudget(3000), true);
  assert.equal(withinFrameBudget(3001), false);
  assert.equal(withinFrameBudget(Number.NaN), false);
});
