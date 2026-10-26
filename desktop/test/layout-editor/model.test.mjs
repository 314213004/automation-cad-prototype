import assert from 'node:assert/strict';
import test from 'node:test';
import { completeDesign } from '../../src/design/synthesis.ts';
import { geometryForDesign } from '../../src/design/footprint.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { partBounds } from '../../src/machine/geometry.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';
import { isDesignReviewCurrent, reviewDesign } from '../../src/design/review.ts';
import { analyzeConceptMotionEnvelopes } from '../../src/design/motion-envelope.ts';
import {
  applyStationGeometryLayout,
  normalizeStationGeometryLayout,
  normalizeStationRotationDeg,
  stationGeometryPose,
  withStationGeometryOffset,
  withStationGeometryPoses
} from '../../src/machine/station-layout.ts';
import {
  applyLayoutSnapshot,
  buildLayoutModel,
  composeGroupTransform,
  describeSelection,
  editableStations,
  layoutSnapshot,
  nextSelection,
  previewGeometry,
  runLayoutChecks,
  sameLayoutSnapshot,
  selectedPartIds,
  writeStationPoses
} from '../../src/layout-editor/model.ts';
import { UnifiedHistory } from '../../src/orbit/history.ts';

const design = completeDesign(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服'), []);
const geometry = geometryForDesign(design);

function close(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('位姿主数据：旋转写 v3、无旋转保持 v2，XY 平移旧接口保留已有旋转', () => {
  const rotated = withStationGeometryPoses(design, geometry, [{ stationId: 'st2', xMm: 100, yMm: -50, rotationZDeg: 90 }]);
  assert.equal(rotated.stationGeometryLayout.schemaVersion, 3);
  assert.deepEqual(rotated.stationGeometryLayout.offsets.map(({ xMm, yMm, rotationZDeg }) => ({ xMm, yMm, rotationZDeg })), [{ xMm: 100, yMm: -50, rotationZDeg: 90 }]);
  const moved = withStationGeometryOffset(rotated, geometryForDesign(rotated), 'st2', 10, 20);
  assert.equal(moved.stationGeometryLayout.offsets[0].rotationZDeg, 90, '只改 XY 不应丢失旋转');
  const flat = withStationGeometryPoses(moved, geometryForDesign(moved), [{ stationId: 'st2', xMm: 10, yMm: 20, rotationZDeg: 0 }]);
  assert.equal(flat.stationGeometryLayout.schemaVersion, 2);
  assert.deepEqual(Object.keys(flat.stationGeometryLayout.offsets[0]).sort(), ['stationIdentity', 'stationName', 'xMm', 'yMm']);
  const zero = withStationGeometryPoses(flat, geometryForDesign(flat), [{ stationId: 'st2', xMm: 0, yMm: 0, rotationZDeg: 0 }]);
  assert.equal(zero.stationGeometryLayout, undefined);
  assert.equal(normalizeStationRotationDeg(270), -90);
  assert.equal(normalizeStationRotationDeg(-180), 180);
  assert.equal(normalizeStationRotationDeg(-0.0001), 0);
  assert.throws(() => normalizeStationGeometryLayout({ schemaVersion: 2, offsets: [{ ...rotated.stationGeometryLayout.offsets[0] }] }, design.config.stations, rotated.stationIdentities), /未知或缺失字段/);
  assert.throws(() => normalizeStationGeometryLayout({ schemaVersion: 3, offsets: [{ ...rotated.stationGeometryLayout.offsets[0], rotationZDeg: 400 }] }, design.config.stations, rotated.stationIdentities), /旋转角/);
});

test('绕 Z 旋转应用到同一份几何：零件中心绕原始工位原点旋转、零件/工位/运动轴方向同步', () => {
  const st2 = geometry.stations.find((station) => station.id === 'st2');
  const rotated = withStationGeometryPoses(design, geometry, [{ stationId: 'st2', xMm: 0, yMm: 0, rotationZDeg: 90 }]);
  const after = geometryForDesign(rotated);
  const afterStation = after.stations.find((station) => station.id === 'st2');
  assert.deepEqual(afterStation.origin, st2.origin);
  assert.equal(afterStation.rotationZDeg, 90);
  for (const part of geometry.parts.filter((item) => item.stationId === 'st2')) {
    const moved = after.parts.find((item) => item.id === part.id);
    const dx = part.center[0] - st2.origin[0];
    const dy = part.center[1] - st2.origin[1];
    close(moved.center[0], st2.origin[0] - dy);
    close(moved.center[1], st2.origin[1] + dx);
    assert.equal(moved.center[2], part.center[2]);
    close(normalizeStationRotationDeg(moved.rotationZDeg - part.rotationZDeg), 90, 1e-6);
  }
  for (const part of geometry.parts.filter((item) => item.stationId !== 'st2')) {
    assert.deepEqual(after.parts.find((item) => item.id === part.id).center, part.center);
  }
  for (const axis of geometry.moving.filter((item) => item.stationId === 'st2')) {
    const next = after.moving.find((item) => item.actuatorId === axis.actuatorId);
    close(next.axis[0], -axis.axis[1], 1e-9);
    close(next.axis[1], axis.axis[0], 1e-9);
    close(Math.hypot(...next.axis), 1, 1e-9);
  }
  // 运动包络仍可计算（旋转后的轴不是阻断条件）
  assert.equal(analyzeConceptMotionEnvelopes(after).status, 'computed');
  // 与零旋转时逐位一致
  const plain = applyStationGeometryLayout(geometryForDesign({ ...design, stationGeometryLayout: undefined }), { schemaVersion: 2, offsets: [] }, rotated.stationIdentities);
  assert.deepEqual(plain.parts.map((part) => part.center), geometry.parts.map((part) => part.center));
});

test('v3 位姿经 store 校验往返（工程 design.json / 草稿同一路径）', () => {
  const rotated = withStationGeometryPoses(design, geometry, [{ stationId: 'st1', xMm: -30, yMm: 40, rotationZDeg: -45 }]);
  const roundTrip = validateMachineDesign(JSON.parse(JSON.stringify(rotated)));
  assert.deepEqual(roundTrip.stationGeometryLayout, rotated.stationGeometryLayout);
  assert.deepEqual(stationGeometryPose(roundTrip, 'st1'), { stationIdentity: rotated.stationIdentities[0], xMm: -30, yMm: 40, rotationZDeg: -45 });
});

test('编辑模型：工位单元、零件归属、属性面板（名称/partId/位置/旋转/包络）', () => {
  const model = buildLayoutModel(design, geometry);
  assert.equal(model.stations.length, 3);
  assert.ok(model.frameRect);
  const st1 = model.stations[0];
  assert.equal(st1.name, design.config.stations[0]);
  assert.equal(st1.partIds.length, geometry.parts.filter((part) => part.stationId === 'st1').length);
  assert.deepEqual(st1.pivot, st1.origin);
  const view = describeSelection(model, [{ kind: 'station', id: 'st1' }]);
  assert.match(view.title, /工位/);
  const labels = view.rows.map((row) => row.label);
  for (const label of ['partId', '位置偏移（主数据）', '旋转 RZ', '尺寸包络']) assert.ok(labels.includes(label), label);
  assert.deepEqual(view.editable, { stationId: 'st1', pose: { xMm: 0, yMm: 0, rotationZDeg: 0 } });
  const framePart = model.parts.find((part) => part.unitId === 'frame');
  const frameView = describeSelection(model, [{ kind: 'part', id: framePart.id }]);
  assert.equal(frameView.editable, null);
  assert.match(frameView.note, /只读/);
});

test('选择：工位模式点零件选整个工位、Ctrl 切换、零件模式、空白清空', () => {
  const model = buildLayoutModel(design, geometry);
  const st2Part = model.parts.find((part) => part.unitId === 'st2');
  const st3Part = model.parts.find((part) => part.unitId === 'st3');
  const framePart = model.parts.find((part) => part.unitId === 'frame');
  let selection = nextSelection(model, [], st2Part.id, { additive: false, mode: 'station' });
  assert.deepEqual(selection, [{ kind: 'station', id: 'st2' }]);
  selection = nextSelection(model, selection, st3Part.id, { additive: true, mode: 'station' });
  assert.deepEqual(editableStations(model, selection), ['st2', 'st3']);
  selection = nextSelection(model, selection, st2Part.id, { additive: true, mode: 'station' });
  assert.deepEqual(selection, [{ kind: 'station', id: 'st3' }]);
  selection = nextSelection(model, selection, framePart.id, { additive: true, mode: 'station' });
  assert.deepEqual(selection[1], { kind: 'part', id: framePart.id });
  assert.deepEqual(editableStations(model, selection), ['st3']);
  assert.equal(selectedPartIds(model, selection).length, model.stations[2].partIds.length + 1);
  assert.deepEqual(nextSelection(model, selection, st2Part.id, { additive: false, mode: 'part' }), [{ kind: 'part', id: st2Part.id }]);
  assert.deepEqual(nextSelection(model, selection, null, { additive: false, mode: 'station' }), []);
});

test('多选整体变换：绕选择中心旋转 + 平移，单个工位退化为纯平移', () => {
  const model = buildLayoutModel(design, geometry);
  const [a, , c] = model.stations;
  const center = [(a.origin[0] + c.origin[0]) / 2, (a.origin[1] + c.origin[1]) / 2];
  const poses = composeGroupTransform([a, c], center, { dx: 10, dy: 0, dRotationZDeg: 180 });
  // 180° 绕中心：a 与 c 互换位置（再 +10）
  close(a.pivot[0] + poses.get(a.id).xMm, c.origin[0] + 10);
  close(c.pivot[0] + poses.get(c.id).xMm, a.origin[0] + 10);
  assert.equal(poses.get(a.id).rotationZDeg, 180);
  const single = composeGroupTransform([a], [a.origin[0], a.origin[1]], { dx: 5, dy: -7, dRotationZDeg: 0 });
  assert.deepEqual(single.get(a.id), { xMm: 5, yMm: -7, rotationZDeg: 0 });
});

test('写回主数据：BOM/配置不变、预览与写回同一路径、review 签名失效', () => {
  const poses = new Map([['st1', { xMm: 50, yMm: 0, rotationZDeg: 0 }], ['st3', { xMm: -50, yMm: 20, rotationZDeg: 15 }]]);
  const next = writeStationPoses(design, poses);
  assert.deepEqual(next.bomDraft, design.bomDraft);
  assert.deepEqual(next.config, design.config);
  assert.deepEqual(next.cost, design.cost);
  assert.equal(next.stationGeometryLayout.offsets.length, 2);
  const preview = previewGeometry(design, poses);
  assert.deepEqual(preview.parts, geometryForDesign(next).parts);
  const review = reviewDesign(design, []);
  assert.equal(isDesignReviewCurrent(review, design, []), true);
  assert.equal(isDesignReviewCurrent(review, next, []), false, '位姿改动后一键校核必须重跑');
  // 撤销快照
  const snapBefore = layoutSnapshot(design);
  const snapAfter = layoutSnapshot(next);
  assert.equal(sameLayoutSnapshot(snapBefore, snapAfter), false);
  const restored = applyLayoutSnapshot(next, snapBefore);
  assert.equal(restored.stationGeometryLayout, undefined);
  assert.deepEqual(applyLayoutSnapshot(restored, snapAfter).stationGeometryLayout, next.stationGeometryLayout);
  const otherDesign = completeDesign(parseMachineBrief('四工位点胶机，节拍 12 件/分钟'), []);
  assert.equal(applyLayoutSnapshot(otherDesign, snapAfter), null, '换方案后旧快照不能写回');
});

test('联动校验：原始摆放无新增干涉；工位压到相邻工位时报包络干涉并标红；超出台面告警', () => {
  const clean = runLayoutChecks(design);
  assert.equal(clean.collisions.pairs.length, 0);
  assert.ok(clean.items.some((item) => item.severity === 'pass' && /包络干涉/.test(item.title)));
  const st1 = geometry.stations.find((station) => station.id === 'st1');
  const st2 = geometry.stations.find((station) => station.id === 'st2');
  const overlapDesign = writeStationPoses(design, new Map([['st1', { xMm: st2.origin[0] - st1.origin[0] - 40, yMm: 0, rotationZDeg: 0 }]]));
  const checks = runLayoutChecks(overlapDesign);
  assert.ok(checks.collisions.pairs.length > 0);
  assert.ok(checks.redUnits.includes('st1') && checks.redUnits.includes('st2'));
  assert.ok(checks.items.some((item) => item.severity === 'error' && /包络干涉/.test(item.title)));
  for (const pair of checks.collisions.pairs) assert.notEqual(pair.aUnit, pair.bUnit);
  const offTable = writeStationPoses(design, new Map([['st3', { xMm: 2000, yMm: 0, rotationZDeg: 0 }]]));
  const offChecks = runLayoutChecks(offTable, { footprintRequirement: { lengthMm: 1800, widthMm: 900 } });
  assert.ok(offChecks.items.some((item) => /超出机架台面/.test(item.title)));
  assert.equal(offChecks.footprint.status, 'exceeds');
  // 校验只读：不改设计
  assert.deepEqual(offTable.bomDraft, design.bomDraft);
  const plate = geometryForDesign(offTable).parts.find((part) => part.stationId === 'st3' && part.role === 'plate');
  assert.ok(partBounds(plate).min[0] > 1000);
});

test('撤销时间线：布局编辑与 3D/原型动作同一条线，合并窗口与 clearLayout', () => {
  const h = new UnifiedHistory({ undo: 1, redo: 0 });
  const s0 = layoutSnapshot(design);
  const d1 = writeStationPoses(design, new Map([['st1', { xMm: 10, yMm: 0, rotationZDeg: 0 }]]));
  const s1 = layoutSnapshot(d1);
  assert.equal(h.recordLayout({ label: '移动 工位1', before: s0, after: s1, at: 0 }), true);
  assert.equal(h.recordLayout({ label: '无效', before: s1, after: s1, at: 10 }), false);
  h.recordOrbit({ label: '3D 底板长', before: {}, after: { base: { length: 300 } }, at: 20 });
  assert.deepEqual(h.snapshot().undoTimeline, ['proto', 'layout', 'orbit']);
  assert.equal(h.nextUndo(), 'orbit');
  h.takeOrbitUndo();
  assert.equal(h.peekLayoutUndo().label, '移动 工位1');
  const undone = h.takeLayoutUndo();
  assert.deepEqual(undone.before, s0);
  assert.deepEqual(h.snapshot().redoTimeline, ['orbit', 'layout']);
  assert.equal(h.nextRedo(), 'layout');
  assert.equal(h.takeLayoutRedo().label, '移动 工位1');
  // 数值输入合并
  const d2 = writeStationPoses(d1, new Map([['st1', { xMm: 20, yMm: 0, rotationZDeg: 0 }]]));
  h.recordLayout({ label: 'X 20', before: s1, after: layoutSnapshot(d2), at: 1000, mergeKey: 'st1:x' });
  h.recordLayout({ label: 'X 25', before: layoutSnapshot(d2), after: layoutSnapshot(writeStationPoses(d1, new Map([['st1', { xMm: 25, yMm: 0, rotationZDeg: 0 }]]))), at: 1500, mergeKey: 'st1:x' });
  assert.equal(h.layoutCounts().undo, 2);
  h.clearLayout();
  assert.deepEqual(h.snapshot().undoTimeline, ['proto']);
  assert.deepEqual(h.layoutCounts(), { undo: 0, redo: 0 });
});

test('拖动计算：锁轴+网格吸附、角度吸附、数值输入精确落点、对齐增量转位姿、精检体积', async () => {
  const { beginDrag, dragFrame, dragToPose, posesFromDeltas } = await import('../../src/layout-editor/drag.ts');
  const { alignDeltas } = await import('../../src/layout-editor/align.ts');
  const { refineLayoutCollisions, boxToRect } = await import('../../src/layout-editor/model.ts');
  const model = buildLayoutModel(design, geometry);
  const start = beginDrag(model, ['st2']);
  assert.deepEqual(start.center, [model.stations[1].origin[0], model.stations[1].origin[1]]);
  assert.ok(start.targets.some((target) => target.id === 'st1'));
  const snapOff = { gridMm: 0, angleDeg: 0, features: false, toleranceMm: 0 };
  const x = dragFrame(start, 'X', { dx: 37.4, dy: 22, dRotationZDeg: 0 }, { ...snapOff, gridMm: 10 });
  assert.deepEqual(x.poses.get('st2'), { xMm: 40, yMm: 0, rotationZDeg: 0 });
  const rz = dragFrame(start, 'RZ', { dx: 0, dy: 0, dRotationZDeg: 50 }, { ...snapOff, angleDeg: 15 });
  assert.deepEqual(rz.poses.get('st2'), { xMm: 0, yMm: 0, rotationZDeg: 45 });
  const typed = dragToPose(start, { xMm: 150, yMm: 0, rotationZDeg: 0 });
  assert.deepEqual(typed.poses.get('st2'), { xMm: 150, yMm: 0, rotationZDeg: 0 });
  // 特征吸附：st2 向左拖到接近 st1 右边时贴边
  const st1 = model.stations[0];
  const st2 = model.stations[1];
  const gap = st2.bounds.min[0] - st1.bounds.max[0];
  const snapped = dragFrame(start, 'X', { dx: -(gap - 3), dy: 0, dRotationZDeg: 0 }, { gridMm: 50, angleDeg: 0, features: true, toleranceMm: 5 });
  assert.equal(snapped.delta.dx, -gap);
  assert.ok(snapped.guides.some((guide) => guide.targetId === 'st1'));
  // 多选整体拖动
  const group = beginDrag(model, ['st1', 'st3']);
  const moved = dragFrame(group, 'XY', { dx: 12, dy: -8, dRotationZDeg: 0 }, snapOff);
  assert.deepEqual(moved.poses.get('st1'), { xMm: 12, yMm: -8, rotationZDeg: 0 });
  assert.deepEqual(moved.poses.get('st3'), { xMm: 12, yMm: -8, rotationZDeg: 0 });
  // 对齐 → 位姿
  const deltas = alignDeltas(model.stations.map((station) => ({ id: station.id, rect: boxToRect(station.bounds) })), 'top');
  const aligned = posesFromDeltas(model, deltas);
  assert.ok([...aligned.values()].every((pose) => pose.rotationZDeg === 0));
  // 精检：压进相邻工位后，至少一对盒-盒精确体积 > 0 且 ≤ AABB 上界
  const overlapDesign = writeStationPoses(design, new Map([['st1', { xMm: st2.origin[0] - st1.origin[0] - 40, yMm: 0, rotationZDeg: 0 }]]));
  const checks = runLayoutChecks(overlapDesign);
  const refined = refineLayoutCollisions(geometryForDesign(overlapDesign), checks.collisions);
  assert.equal(refined.length, checks.collisions.pairs.length);
  for (const item of refined) {
    const pair = checks.collisions.pairs.find((entry) => entry.a === item.a && entry.b === item.b);
    assert.ok(item.volumeMm3 <= pair.aabbOverlapMm3 + 0.01 || item.quality !== 'exact');
  }
  assert.ok(refined.some((item) => item.volumeMm3 > 0));
});
