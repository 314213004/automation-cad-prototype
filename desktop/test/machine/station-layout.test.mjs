import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { completeDesign } from '../../src/design/synthesis.ts';
import { geometryForDesign } from '../../src/design/footprint.ts';
import { projectMachineGeometryTopView, renderGeometryTopViewSvg } from '../../src/design/geometry-plan-view.ts';
import { isDesignReviewCurrent, reviewDesign } from '../../src/design/review.ts';
import { initialDraft, stationsFromDesign, withStations } from '../../src/design/wizard-state.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { buildThreeMachine, disposeThreeMachine } from '../../src/machine/geometry-three.ts';
import { geometryToStl } from '../../src/machine/geometry-export.ts';
import { partBounds } from '../../src/machine/geometry.ts';
import { openProject, saveProject } from '../../electron/projects.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';
import { applyStationGeometryLayout, validateStationGeometryLayout, withStationGeometryOffset } from '../../src/machine/station-layout.ts';

const DX = 1234.5;
const DY = -678.25;
const originalDesign = completeDesign(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服'), []);
const originalGeometry = geometryForDesign(originalDesign);
const movedDesign = withStationGeometryOffset(originalDesign, originalGeometry, 'st2', DX, DY);
const movedGeometry = geometryForDesign(movedDesign);

function assertVecClose(actual, expected, tolerance = 0.01) {
  assert.equal(actual.length, expected.length);
  for (let axis = 0; axis < actual.length; axis += 1) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) <= tolerance, `axis ${axis}: ${actual[axis]} != ${expected[axis]}`);
  }
}

function stlVertexBounds(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength >= 84);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  assert.equal(bytes.byteLength, 84 + 50 * triangles);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const offset = 84 + triangle * 50;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = view.getFloat32(offset + 12 + vertex * 12 + axis * 4, true);
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
  }
  return { min, max };
}

function projectVertexToMm(world, scale) {
  // buildThreeMachine maps model Z-up mm to Three Y-up and applies one uniform view scale.
  return [world.x / scale, -world.z / scale, world.y / scale];
}

test('工位偏移作用于真实 MachineGeometry：整组零件、工位 origin/workPoint、运动枢轴与 bounds/envelope 一致更新', () => {
  assert.equal(movedDesign.stationGeometryLayout.schemaVersion, 2);
  assert.deepEqual(movedDesign.stationGeometryLayout.offsets, [{
    stationIdentity: movedDesign.stationIdentities[1], stationName: originalGeometry.stations[1].name, xMm: DX, yMm: DY
  }]);
  const beforeParts = new Map(originalGeometry.parts.map((part) => [part.id, part]));
  const movedIds = new Set(originalGeometry.parts.filter((part) => part.stationId === 'st2').map((part) => part.id));
  assert.ok(movedIds.size > 5, '测试必须覆盖真实工位组，而不是单独一个零件');
  for (const part of movedGeometry.parts) {
    const before = beforeParts.get(part.id);
    assert.ok(before, part.id);
    assert.deepEqual(part.shape, before.shape, `${part.id} 尺寸/形状不得变化`);
    assert.equal(part.rotationZDeg, before.rotationZDeg, `${part.id} Z 旋转不得变化`);
    if (before.stationId === 'st2') {
      assert.deepEqual(part.center, [before.center[0] + DX, before.center[1] + DY, before.center[2]], `${part.id} 应整体平移`);
    } else {
      assert.deepEqual(part.center, before.center, `${part.id}（其它工位/机架）应保持不变`);
    }
  }

  const beforeStations = new Map(originalGeometry.stations.map((station) => [station.id, station]));
  for (const station of movedGeometry.stations) {
    const before = beforeStations.get(station.id);
    if (station.id === 'st2') {
      assert.deepEqual(station.origin, [before.origin[0] + DX, before.origin[1] + DY, before.origin[2]]);
      assert.deepEqual(station.workPoint, [before.workPoint[0] + DX, before.workPoint[1] + DY, before.workPoint[2]]);
      assert.deepEqual(station.footprint.center, [before.footprint.center[0] + DX, before.footprint.center[1] + DY]);
    } else {
      assert.deepEqual(station.origin, before.origin);
      assert.deepEqual(station.workPoint, before.workPoint);
      assert.deepEqual(station.footprint.center, before.footprint.center);
    }
  }

  const beforeAxes = new Map(originalGeometry.moving.map((axis) => [axis.actuatorId, axis]));
  for (const axis of movedGeometry.moving) {
    const before = beforeAxes.get(axis.actuatorId);
    assert.ok(before, axis.actuatorId);
    assert.equal(axis.strokeMm, before.strokeMm, '行程不得变化');
    assert.deepEqual(axis.axis, before.axis, '运动方向不得变化');
    assert.deepEqual(axis.partIds, before.partIds, '运动件关联不得变化');
    if (axis.stationId === 'st2') assert.deepEqual(axis.pivot, [before.pivot[0] + DX, before.pivot[1] + DY, before.pivot[2]]);
    else assert.deepEqual(axis.pivot, before.pivot);
  }

  const perPart = movedGeometry.parts.map((part) => partBounds(part));
  const expectedMin = [0, 1, 2].map((axis) => Math.min(...perPart.map((box) => box.min[axis])));
  const expectedMax = [0, 1, 2].map((axis) => Math.max(...perPart.map((box) => box.max[axis])));
  assertVecClose(movedGeometry.bounds.min, expectedMin, 0.001);
  assertVecClose(movedGeometry.bounds.max, expectedMax, 0.001);
  assertVecClose(movedGeometry.envelope, expectedMax.map((value, axis) => value - expectedMin[axis]), 0.001);
  assert.ok(movedGeometry.bounds.max[0] > originalGeometry.bounds.max[0]);
  assert.ok(movedGeometry.bounds.min[1] < originalGeometry.bounds.min[1]);
  assert.deepEqual(originalGeometry.parts, [...beforeParts.values()], '生成器缓存快照不得被原地修改');
});

test('Three.js scene 与 mm 标尺俯视读到同一变换，旋转枢轴和部件 world center 对齐', () => {
  const projection = projectMachineGeometryTopView(movedGeometry);
  assert.equal(projection.status, 'ready');
  const svg = renderGeometryTopViewSvg(projection, { selectedStationId: 'st2', showMillimeterRuler: true });
  assert.match(svg, /data-geometry-station-selected="true"/);
  assert.match(svg, /data-mm-grid-step="\d+"/);
  assert.match(svg, /坐标单位为 mm/);

  const machine = buildThreeMachine(movedGeometry);
  try {
    machine.root.updateMatrixWorld(true);
    const plate = movedGeometry.parts.find((part) => part.id === 'st2-plate');
    const plateMesh = machine.stationGroups.get('st2')?.getObjectByName('st2-plate');
    assert.ok(plate && plateMesh);
    assertVecClose(projectVertexToMm(plateMesh.getWorldPosition(new THREE.Vector3()), machine.scale), plate.center, 0.02);
    const rotaryAxis = movedGeometry.moving.find((axis) => axis.stationId === 'st2' && axis.kind === 'rotary');
    assert.ok(rotaryAxis);
    const rotaryNode = machine.actuators.get(rotaryAxis.actuatorId);
    assert.ok(rotaryNode);
    assert.deepEqual(rotaryNode.axis.pivot, rotaryAxis.pivot);
    const table = movedGeometry.parts.find((part) => part.id === rotaryAxis.partIds[0]);
    const tableMesh = rotaryNode.mover?.getObjectByName(table.id);
    assert.ok(table && tableMesh);
    assertVecClose(projectVertexToMm(tableMesh.getWorldPosition(new THREE.Vector3()), machine.scale), table.center, 0.02);
  } finally {
    disposeThreeMachine(machine);
  }
});

test('正式工程 project.json、design.json、整机/逐件 STL 保存后重开仍确定重建相同几何', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-geometry-layout-'));
  const stlData = geometryToStl(movedGeometry);
  const partData = movedGeometry.parts.map((part) => ({
    name: `${part.id}.stl`,
    data: geometryToStl({ ...movedGeometry, parts: [part] })
  }));
  const placements = [{ id: 'station:manual-layout', partId: 'station:manual-layout', model: '仅示意 placements', x: 17, y: 23, w: 100, h: 70, tag: 'station' }];
  const saved = saveProject(dir, {
    name: '工位平移 roundtrip', process: 'screw', parts: movedGeometry.parts.length,
    envelope: movedGeometry.envelope, design: movedDesign, config: movedDesign.config,
    stlData, partData, placements
  });
  assert.equal(saved.ok, true, saved.message);
  const projectDir = join(dir, 'projects', saved.record.id);
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
  const designFile = JSON.parse(readFileSync(join(projectDir, 'design.json'), 'utf8'));
  assert.deepEqual(project.design.stationGeometryLayout, movedDesign.stationGeometryLayout);
  assert.deepEqual(designFile.design.stationGeometryLayout, movedDesign.stationGeometryLayout);
  assert.deepEqual(designFile.placements, placements, '二维示意布局独立保存且不参与几何偏移');
  assert.deepEqual(stlVertexBounds(readFileSync(join(projectDir, 'model.stl'))), stlVertexBounds(stlData));

  const opened = openProject(dir, saved.record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.layoutEditable, true);
  assert.equal(opened.partPaths.length, movedGeometry.parts.length);
  const reopenedDesign = validateMachineDesign(designFile.design);
  const reopenedGeometry = geometryForDesign(reopenedDesign);
  assert.deepEqual(reopenedGeometry.parts.map((part) => [part.id, part.center]), movedGeometry.parts.map((part) => [part.id, part.center]));
  assert.deepEqual(reopenedGeometry.stations, movedGeometry.stations);
  assert.deepEqual(reopenedGeometry.moving, movedGeometry.moving);
  assert.deepEqual(reopenedGeometry.bounds, movedGeometry.bounds);
  assert.deepEqual(reopenedGeometry.envelope, movedGeometry.envelope);
  for (const part of movedGeometry.parts) {
    const savedPart = opened.partPaths.find((entry) => entry.name === `${part.id}.stl`);
    assert.ok(savedPart, `缺少逐件 STL ${part.id}`);
    const expected = geometryToStl({ ...movedGeometry, parts: [part] });
    assert.deepEqual(readFileSync(savedPart.path), Buffer.from(expected), `逐件 STL ${part.id} 应序列化平移后的全局毫米坐标`);
  }
  const frameBefore = originalGeometry.parts.find((part) => part.id === 'frame-top');
  const frameAfter = reopenedGeometry.parts.find((part) => part.id === 'frame-top');
  assert.deepEqual(frameAfter.center, frameBefore.center, '其它非工位机架零件保持不变');
});

test('平移改变 review source signature；无偏移旧 MachineDesign v1 仍兼容', () => {
  const sceneParts = [{ name: '导入 CAD 件', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(originalDesign, sceneParts);
  assert.equal(isDesignReviewCurrent(review, originalDesign, sceneParts), true);
  assert.equal(isDesignReviewCurrent(review, movedDesign, sceneParts), false);

  const legacyV1 = {
    ...originalDesign,
    stationGeometryLayout: { schemaVersion: 1, offsets: [{ stationId: 'st2', stationName: originalGeometry.stations[1].name, stationIndex: 1, xMm: DX, yMm: DY }] }
  };
  delete legacyV1.stationIdentities;
  const restored = validateMachineDesign(JSON.parse(JSON.stringify(legacyV1)));
  assert.equal(restored.stationGeometryLayout, undefined);
  assert.match(restored.stationGeometryWarning, /旧版工位偏移.*已安全清除/);
  assert.equal(restored.stationIdentities.length, legacyV1.config.stations.length);
  assert.deepEqual(geometryForDesign(restored).parts.map((part) => [part.id, part.center]), originalGeometry.parts.map((part) => [part.id, part.center]));
  const dir = mkdtempSync(join(tmpdir(), 'legacy-machine-design-v1-'));
  const saved = saveProject(dir, { name: '旧版有偏移工程', process: 'screw', parts: originalGeometry.parts.length, design: legacyV1, config: legacyV1.config, placements: [] });
  assert.equal(saved.ok, true, saved.message);
  const opened = openProject(dir, saved.record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.layoutEditable, true);
  assert.equal(Object.hasOwn(opened.record.design, 'stationGeometryLayout'), false);
  assert.match(opened.record.design.stationGeometryWarning, /已安全清除/);
  assert.deepEqual(geometryForDesign(opened.record.design).parts.map((part) => [part.id, part.center]), originalGeometry.parts.map((part) => [part.id, part.center]));
});

test('v2 偏移严格校验身份键和坐标，内部 stN 错配时 fail-closed', () => {
  const layout = movedDesign.stationGeometryLayout;
  const stationNames = originalGeometry.stations.map((station) => station.name);
  const identities = movedDesign.stationIdentities;
  assert.throws(() => validateStationGeometryLayout({ ...layout, unexpected: true }, stationNames, identities), /严格工位偏移对象/);
  assert.throws(() => validateStationGeometryLayout({ schemaVersion: 2, offsets: [{ ...layout.offsets[0], xMm: Number.NaN }] }, stationNames, identities), /身份或 X\/Y 毫米坐标无效/);
  assert.throws(() => validateStationGeometryLayout({ schemaVersion: 2, offsets: [{ ...layout.offsets[0] }, { ...layout.offsets[0] }] }, stationNames, identities), /身份重复/);
  assert.throws(() => withStationGeometryOffset(originalDesign, originalGeometry, 'st9', 1, 2), /无法确认工位/);
  const unmapped = { ...originalGeometry, parts: originalGeometry.parts.map((part) => part.id === 'st2-plate' ? { ...part, stationId: 'st99' } : part) };
  assert.throws(() => applyStationGeometryLayout(unmapped, layout, identities), /stationId 未映射/);
  const invalidOrigin = { ...originalGeometry, stations: originalGeometry.stations.map((station) => station.id === 'st2' ? { ...station, origin: [Number.NaN, station.origin[1], station.origin[2]] } : station) };
  assert.throws(() => applyStationGeometryLayout(invalidOrigin, layout, identities), /可信的 ID\/index 映射/);
});

test('重排与改名按稳定身份保留偏移，当前 stN 和运动轴枢轴正确重映射', () => {
  const shiftedFirst = withStationGeometryOffset(originalDesign, originalGeometry, 'st1', DX, DY);
  const stableId = shiftedFirst.stationIdentities[0];
  const draft = { ...initialDraft(), design: shiftedFirst, stations: stationsFromDesign(shiftedFirst) };
  const reorderedStations = [...draft.stations].reverse();
  reorderedStations[2].name = '复核工位 A';
  const reordered = withStations(draft, reorderedStations);
  assert.deepEqual(reordered.design.stationGeometryLayout.offsets.map((item) => item.stationIdentity), [stableId]);
  assert.equal(reordered.design.stationGeometryLayout.offsets[0].stationName, '复核工位 A');
  assert.deepEqual(reordered.design.stationIdentities, reorderedStations.map((station) => station.id));
  const geometry = geometryForDesign(reordered.design);
  const target = geometry.stations.find((station) => reordered.design.stationIdentities[station.index] === stableId);
  assert.equal(target.id, 'st3', '旧 st1 工位重排后应映射到新的内部 st3');
  const unshifted = geometryForDesign({ ...reordered.design, stationGeometryLayout: undefined });
  const before = unshifted.parts.find((part) => part.stationId === 'st3' && part.role === 'plate');
  const after = geometry.parts.find((part) => part.stationId === 'st3' && part.role === 'plate');
  assert.deepEqual(after.center, [before.center[0] + DX, before.center[1] + DY, before.center[2]]);
  const baseAxis = unshifted.moving.find((axis) => axis.stationId === 'st3');
  const movedAxis = geometry.moving.find((axis) => axis.actuatorId === baseAxis.actuatorId);
  assert.ok(movedAxis);
  assert.equal(movedAxis.stationId, 'st3');
  assert.deepEqual(movedAxis.pivot, [baseAxis.pivot[0] + DX, baseAxis.pivot[1] + DY, baseAxis.pivot[2]]);
  const identityBaseline = { ...originalDesign, stationIdentities: [...shiftedFirst.stationIdentities] };
  delete identityBaseline.stationGeometryLayout;
  const review = reviewDesign(identityBaseline, []);
  assert.equal(isDesignReviewCurrent(review, reordered.design), false);
  const identityOnlyChange = { ...identityBaseline, stationIdentities: identityBaseline.stationIdentities.map((identity, index) => index === 0 ? `${identity}:changed` : identity) };
  assert.equal(isDesignReviewCurrent(review, identityOnlyChange), false, '映射变化必须使旧 review 失效，即使几何和偏移未变');
});

test('删除工位只清掉该稳定身份的偏移；重复/复制身份不猜哪一份是原站', () => {
  const once = withStationGeometryOffset(originalDesign, originalGeometry, 'st1', DX, DY);
  const twice = withStationGeometryOffset(once, originalGeometry, 'st2', 40, 50);
  const originalIds = [...twice.stationIdentities];
  const draft = { ...initialDraft(), design: twice, stations: stationsFromDesign(twice) };
  const withoutSecond = [...draft.stations];
  withoutSecond.splice(1, 1);
  const deleted = withStations(draft, withoutSecond);
  assert.deepEqual(deleted.design.stationGeometryLayout.offsets.map((item) => item.stationIdentity), [originalIds[0]]);
  assert.match(deleted.stationIdentityNotice, /清除 1 个/);
  const deletedGeometry = geometryForDesign(deleted.design);
  const deletedBaseline = geometryForDesign({ ...deleted.design, stationGeometryLayout: undefined });
  const retainedPlate = deletedGeometry.parts.find((part) => part.stationId === 'st1' && part.role === 'plate');
  const basePlate = deletedBaseline.parts.find((part) => part.stationId === 'st1' && part.role === 'plate');
  assert.deepEqual(retainedPlate.center, [basePlate.center[0] + DX, basePlate.center[1] + DY, basePlate.center[2]]);

  const copied = [...draft.stations, { ...draft.stations[0], name: '复制工位' }];
  const repaired = withStations(draft, copied);
  assert.equal(new Set(repaired.stations.map((station) => station.id)).size, repaired.stations.length);
  assert.match(repaired.stationIdentityNotice, /复制工位共用了同一身份/);
  assert.deepEqual(repaired.design.stationGeometryLayout.offsets.map((item) => item.stationIdentity), [originalIds[1]]);
});

test('v1 工位偏移迁移不按序号/名称猜测；无身份 v2 偏移也全部安全清除', () => {
  const oldV1 = {
    ...originalDesign,
    stationGeometryLayout: { schemaVersion: 1, offsets: [{ stationId: 'st1', stationName: originalGeometry.stations[0].name, stationIndex: 0, xMm: DX, yMm: DY }] }
  };
  delete oldV1.stationIdentities;
  const normalizedV1 = validateMachineDesign(oldV1);
  assert.equal(normalizedV1.stationGeometryLayout, undefined);
  assert.match(normalizedV1.stationGeometryWarning, /不按名称或序号|旧版工位偏移/);
  const noMapV2 = validateMachineDesign({
    ...originalDesign,
    stationGeometryLayout: { schemaVersion: 2, offsets: [{ stationIdentity: 'station:unknown', stationName: '工位1', xMm: DX, yMm: DY }] }
  });
  assert.equal(noMapV2.stationGeometryLayout, undefined);
  assert.match(noMapV2.stationGeometryWarning, /身份映射缺失/);
  assert.deepEqual(geometryForDesign(noMapV2).parts.map((part) => part.center), originalGeometry.parts.map((part) => part.center));
});
