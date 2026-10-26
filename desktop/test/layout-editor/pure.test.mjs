import assert from 'node:assert/strict';
import test from 'node:test';
import { featureSnap, snapAngleDeg, snapToStep, snapTranslation, GRID_STEPS_MM, ANGLE_STEPS_DEG } from '../../src/layout-editor/snap.ts';
import { alignDeltas, distributeDeltas, linearArrayDeltas } from '../../src/layout-editor/align.ts';
import { appendNumericKey, applyNumericEntry, formatDragReadout, parseNumericEntry } from '../../src/layout-editor/numeric.ts';
import { boxGap, measurePicks, pointDistance } from '../../src/layout-editor/measure.ts';
import { bodiesOverlap, detectCollisions, pairKey } from '../../src/layout-editor/collision.ts';

const rect = (minX, maxX, minY, maxY) => ({ minX, maxX, minY, maxY });

test('网格/角度吸附：步长集合与取整、关闭吸附', () => {
  assert.deepEqual([...GRID_STEPS_MM], [1, 5, 10, 50]);
  assert.deepEqual([...ANGLE_STEPS_DEG], [15, 90]);
  assert.equal(snapToStep(123.4, 10), 120);
  assert.equal(snapToStep(-26, 50), -50);
  assert.equal(snapToStep(-24, 50), 0);
  assert.equal(snapToStep(7.3, 0), 7.3);
  assert.equal(snapAngleDeg(52, 15), 45);
  assert.equal(snapAngleDeg(136, 90), 180);
  assert.equal(snapAngleDeg(-136, 90), 180);
  assert.equal(snapAngleDeg(-100, 90), -90);
  assert.throws(() => snapToStep(Number.NaN, 5));
});

test('特征吸附：边优先、最近目标、超出容差不吸附，并给出参考线', () => {
  const moving = rect(0, 100, 0, 50);
  const targets = [{ id: 'st2', label: '工位2', rect: rect(103, 203, 200, 260) }];
  const snap = featureSnap(moving, targets, 5);
  assert.equal(snap.snappedX, true);
  assert.equal(snap.dx, 3); // maxX 100 → 103（左边）
  assert.equal(snap.snappedY, false);
  assert.equal(snap.guides.length, 1);
  assert.deepEqual({ axis: snap.guides[0].axis, value: snap.guides[0].value, from: snap.guides[0].from, to: snap.guides[0].to }, { axis: 'x', value: 103, from: 0, to: 260 });
  assert.equal(featureSnap(moving, targets, 2).snappedX, false);
  const centered = featureSnap(rect(0, 100, 0, 50), [{ id: 'a', label: 'A', rect: rect(-48, 102, 400, 500) }], 3);
  // minX 0 vs -48 太远；center 50 vs 27 太远；maxX 100 vs 102 → dx 2；
  assert.equal(centered.dx, 2);
});

test('平移吸附流水线：锁轴、特征覆盖网格、网格作用于主数据偏移', () => {
  const grid = snapTranslation({ startX: 0, startY: 0, rawX: 37.2, rawY: 12, gridMm: 10, lockY: true });
  assert.deepEqual({ x: grid.x, y: grid.y }, { x: 40, y: 0 });
  assert.deepEqual(grid.source, { x: 'grid', y: 'locked' });
  const feature = snapTranslation({
    startX: 0, startY: 0, rawX: 98.5, rawY: 0, gridMm: 50,
    startRect: rect(0, 100, 0, 50), targets: [{ id: 't', label: 'T', rect: rect(201, 300, 0, 50) }], toleranceMm: 4, lockY: true
  });
  assert.equal(feature.x, 101); // maxX 198.5 → 201 吸到左边，不被 50 网格覆盖
  assert.equal(feature.source.x, 'feature');
  assert.equal(feature.guides[0].targetId, 't');
});

test('对齐：选择集包络 / 以首项为基准，水平与垂直', () => {
  const items = [{ id: 'a', rect: rect(0, 100, 0, 50) }, { id: 'b', rect: rect(150, 200, 30, 90) }, { id: 'c', rect: rect(-20, 10, -10, 10) }];
  const left = alignDeltas(items, 'left');
  assert.deepEqual(left.get('a'), { dx: -20, dy: 0 });
  assert.deepEqual(left.get('b'), { dx: -170, dy: 0 });
  assert.deepEqual(left.get('c'), { dx: 0, dy: 0 });
  const top = alignDeltas(items, 'top', 'first');
  assert.deepEqual(top.get('a'), { dx: 0, dy: 0 });
  assert.deepEqual(top.get('b'), { dx: 0, dy: -40 });
  const center = alignDeltas(items, 'centerY');
  assert.deepEqual(center.get('c'), { dx: 0, dy: 40 }); // 整体 Y -10..90 中线 40
  assert.throws(() => alignDeltas([items[0]], 'left'), /至少需要选中 2 个/);
});

test('等距分布：间隙相等或中心等距，首尾不动', () => {
  const items = [{ id: 'a', rect: rect(0, 100, 0, 1) }, { id: 'b', rect: rect(110, 150, 0, 1) }, { id: 'c', rect: rect(400, 500, 0, 1) }];
  const gap = distributeDeltas(items, 'x', 'gap');
  assert.deepEqual(gap.get('a'), { dx: 0, dy: 0 });
  assert.deepEqual(gap.get('c'), { dx: 0, dy: 0 });
  // span 500 − 宽度 240 = 260 → 间隙 130 → b.minX = 230
  assert.deepEqual(gap.get('b'), { dx: 120, dy: 0 });
  const centers = distributeDeltas(items, 'x', 'center');
  // 中心 50 → 450，b 中心应为 250（原 130）
  assert.deepEqual(centers.get('b'), { dx: 120, dy: 0 });
  assert.throws(() => distributeDeltas(items.slice(0, 2), 'x'), /至少需要选中 3 个/);
});

test('线性阵列排布：按选择顺序等间距、另一轴对齐首项', () => {
  const items = [{ id: 'a', rect: rect(0, 100, 0, 100) }, { id: 'b', rect: rect(500, 600, 30, 130) }, { id: 'c', rect: rect(-300, -200, 0, 100) }];
  const result = linearArrayDeltas(items, 'x', 250);
  assert.deepEqual(result.get('a'), { dx: 0, dy: 0 });
  assert.deepEqual(result.get('b'), { dx: -250, dy: -30 });
  assert.deepEqual(result.get('c'), { dx: 800, dy: 0 });
  assert.throws(() => linearArrayDeltas(items, 'x', 0), /非零/);
});

test('数值输入：相对/绝对、平面两值、错误提示与键盘缓冲', () => {
  const start = { xMm: 10, yMm: 20, rotationZDeg: 30 };
  const delta = parseNumericEntry('150');
  assert.equal(delta.ok, true);
  assert.deepEqual(applyNumericEntry(delta.entry, 'X', start), { ok: true, pose: { xMm: 160, yMm: 20, rotationZDeg: 30 } });
  const abs = parseNumericEntry('=-5.5');
  assert.deepEqual(applyNumericEntry(abs.entry, 'Y', start).pose, { xMm: 10, yMm: -5.5, rotationZDeg: 30 });
  const plane = parseNumericEntry('100, -40');
  assert.deepEqual(applyNumericEntry(plane.entry, 'XY', start).pose, { xMm: 110, yMm: -20, rotationZDeg: 30 });
  assert.equal(applyNumericEntry(delta.entry, 'XY', start).ok, false);
  assert.equal(applyNumericEntry(plane.entry, 'X', start).ok, false);
  assert.deepEqual(applyNumericEntry(parseNumericEntry('-45').entry, 'RZ', start).pose.rotationZDeg, -15);
  assert.equal(parseNumericEntry('abc').ok, false);
  assert.equal(parseNumericEntry('').ok, false);
  assert.equal(parseNumericEntry('1,2,3').ok, false);
  assert.equal(parseNumericEntry('1e9').ok, false);
  let buffer = '';
  for (const key of ['1', '5', '0', 'a', 'Backspace', '0']) buffer = appendNumericKey(buffer, key) ?? buffer;
  assert.equal(buffer, '150');
  assert.equal(appendNumericKey('', 'Enter'), null);
  assert.equal(appendNumericKey('1', '='), '1');
  assert.match(formatDragReadout('X', start, { ...start, xMm: 160 }, '150'), /X Δ150 mm → X 160 mm · 输入：150/);
  assert.match(formatDragReadout('RZ', start, { ...start, rotationZDeg: 45 }), /旋转 Δ15° → RZ 45°/);
});

test('测量：点距、平行面距与包络间隙', () => {
  assert.deepEqual(pointDistance([0, 0, 0], [3, 4, 0]), { delta: [3, 4, 0], distanceMm: 5 });
  const face = measurePicks({ point: [0, 0, 10], normal: [1, 0, 0] }, { point: [120, 50, 30], normal: [-1, 0, 0] });
  assert.equal(face.kind, 'face');
  assert.equal(face.distanceMm, 120);
  const point = measurePicks({ point: [0, 0, 0], normal: [1, 0, 0] }, { point: [0, 3, 4], normal: [0, 1, 0] });
  assert.equal(point.kind, 'point');
  assert.equal(point.distanceMm, 5);
  const gap = boxGap({ min: [0, 0, 0], max: [10, 10, 10] }, { min: [13, 14, 0], max: [20, 20, 10] });
  assert.deepEqual(gap, { gap: [3, 4, -10], separationMm: 5, overlapping: false });
  assert.equal(boxGap({ min: [0, 0, 0], max: [10, 10, 10] }, { min: [5, 5, 5], max: [20, 20, 20] }).overlapping, true);
});

test('碰撞：OBB 旋转矩形分离轴、贴合不算、同单元忽略、基线去重', () => {
  const body = (id, unitId, center, half, rotationZDeg = 0) => ({ id, name: id, unitId, center, half, rotationZDeg, moving: false });
  // 两个 45° 旋转的方块：AABB 重叠但 OBB 分离
  const a = body('a', 'st1', [0, 0, 0], [10, 10, 10], 45);
  const b = body('b', 'st2', [26, 0, 0], [10, 10, 10], 45);
  assert.equal(bodiesOverlap(a, b), true); // 中心距 26 < 2×14.14 → 重叠
  const c = body('c', 'st2', [29, 0, 0], [10, 10, 10], 45);
  assert.equal(bodiesOverlap(a, c), false);
  const d = body('d', 'st2', [15, 15, 0], [10, 10, 10], 45); // 沿对角方向：AABB 重叠，OBB 分离
  assert.equal(bodiesOverlap(a, d), false);
  const touching = body('t', 'st2', [20, 0, 0], [10, 10, 10]);
  assert.equal(bodiesOverlap(body('s', 'st1', [0, 0, 0], [10, 10, 10]), touching), false);
  const same = body('s2', 'st1', [1, -1, 0], [5, 5, 5]);
  const report = detectCollisions([a, b, c, d, same]);
  assert.deepEqual(report.pairs.map((pair) => pairKey(pair.a, pair.b)), ['a|b']);
  assert.deepEqual(report.unitIds, ['st1', 'st2']);
  assert.equal(report.pairs[0].method, 'obb');
  const withBaseline = detectCollisions([a, b], { baseline: new Set(['a|b']) });
  assert.equal(withBaseline.pairs.length, 0);
  assert.equal(withBaseline.baselineSkipped, 1);
  const focused = detectCollisions([a, b, body('x', 'st3', [0, 0, 0], [5, 5, 5]), body('y', 'frame', [0, 0, 0], [5, 5, 5])], { focusUnits: new Set(['st3']) });
  assert.deepEqual(focused.pairs.map((pair) => pairKey(pair.a, pair.b)).sort(), ['a|x', 'x|y']);
});

test('松手后精检：盒-盒精确体积、旋转盒多边形求交、竖直圆柱近似、水平圆柱上界', async () => {
  const { refineCollision, convexIntersection } = await import('../../src/layout-editor/collision.ts');
  const box = (id, center, half, rotationZDeg = 0) => ({ id, name: id, unitId: id, center, half, rotationZDeg, moving: false, profile: { kind: 'rect' }, horizontalCylinder: false });
  const exact = refineCollision(box('a', [0, 0, 0], [10, 10, 10]), box('b', [15, 0, 5], [10, 10, 10]));
  assert.equal(exact.quality, 'exact');
  assert.equal(exact.volumeMm3, 5 * 20 * 15);
  // 正方形与其 45° 旋转（同心同尺寸）：交为正八边形，面积 = 8(√2−1)·h²（h=半边长）
  const rotated = refineCollision(box('a', [0, 0, 0], [10, 10, 1]), box('b', [0, 0, 0], [10, 10, 1], 45));
  const octagon = 8 * (Math.SQRT2 - 1) * 100 * 2;
  assert.ok(Math.abs(rotated.volumeMm3 - octagon) < 0.01, `${rotated.volumeMm3} vs ${octagon}`);
  const cyl = { ...box('c', [0, 0, 0], [5, 5, 10]), profile: { kind: 'circle', radius: 5 } };
  const inside = refineCollision(cyl, box('d', [0, 0, 0], [50, 50, 50]));
  assert.equal(inside.quality, 'polygon-approx');
  const ideal = Math.PI * 25 * 20;
  assert.ok(inside.volumeMm3 >= ideal && inside.volumeMm3 < ideal * 1.004);
  const horizontal = refineCollision({ ...box('e', [0, 0, 0], [20, 5, 5]), horizontalCylinder: true }, box('f', [0, 0, 0], [50, 50, 50]));
  assert.equal(horizontal.quality, 'upper-bound');
  assert.equal(refineCollision(box('a', [0, 0, 0], [1, 1, 1]), box('b', [5, 0, 0], [1, 1, 1])).volumeMm3, 0);
  assert.equal(convexIntersection([[0, 0], [1, 0], [1, 1], [0, 1]], [[2, 2], [3, 2], [3, 3], [2, 3]]).length, 0);
});
