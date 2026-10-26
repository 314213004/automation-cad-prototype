import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { partBounds, generateMachineGeometry } from '../../src/machine/geometry.ts';
import { geometryForDesign } from '../../src/design/footprint.ts';
import { projectMachineGeometryTopView, renderGeometryTopViewSvg } from '../../src/design/geometry-plan-view.ts';

function makeGeometry(parts, stations = [
  { id: 'st1', name: '工位 A', index: 0, origin: [0, 0, 0], rotationZDeg: 0, plateSize: [100, 100, 10], workPoint: [0, 0, 0], footprint: { stationId: 'st1', center: [0, 0], half: [50, 50], rotationZDeg: 0 }, actuatorIds: [], sensorPoints: [] },
  { id: 'st2', name: '工位 B', index: 1, origin: [-200, 100, 0], rotationZDeg: -90, plateSize: [100, 100, 10], workPoint: [-200, 100, 0], footprint: { stationId: 'st2', center: [-200, 100], half: [50, 50], rotationZDeg: -90 }, actuatorIds: [], sensorPoints: [] }
]) {
  const boxes = parts.map((part) => partBounds(part));
  const min = [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis])));
  return {
    schemaVersion: 1,
    kind: 'machine-geometry',
    machineId: 'projection-test',
    name: 'projection test',
    units: 'mm',
    upAxis: 'z',
    geometryFidelity: 'conceptual-estimate',
    process: 'inspection',
    layout: 'linear',
    envelope: max.map((value, axis) => Math.round((value - min[axis]) * 1000) / 1000),
    bounds: { min: min.map((value) => Math.round(value * 1000) / 1000), max: max.map((value) => Math.round(value * 1000) / 1000) },
    tableHeight: 850,
    stations,
    parts,
    moving: [],
    structureBom: [],
    assumptions: [],
    warnings: []
  };
}
function part(id, shape, center, rotationZDeg, stationId) {
  return { id, name: id, role: 'structure', shape, center, rotationZDeg, color: '#555555', material: 'test', bomGroup: 'structure', estimated: true, ...(stationId ? { stationId } : {}) };
}
function assertBoundsClose(actual, expected, message) {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${message} ${key}: ${actual[key]} vs ${expected[key]}`);
}

test('俯视投影按当前 box/cylinder 几何尺寸和世界变换计算毫米 AABB（含正/负旋转）', () => {
  const source = makeGeometry([
    part('box-90', { type: 'box', size: [100, 40, 20] }, [10, -20, 30], 90, 'st1'),
    part('cylinder-x-90', { type: 'cylinder', radius: 5, length: 40, axis: 'x' }, [100, 0, 10], 90, 'st1'),
    part('box-minus-90', { type: 'box', size: [20, 10, 4] }, [-200, 100, 2], -90, 'st2')
  ]);
  const result = projectMachineGeometryTopView(source);
  assert.equal(result.status, 'ready');
  assert.equal(result.units, 'mm');
  assert.equal(result.upAxis, 'z');
  assert.equal(result.source, 'machine-geometry.parts');
  assert.deepEqual(result.bounds, { minX: -205, maxX: 105, minY: -70, maxY: 110 });
  assert.equal(result.widthMm, 310);
  assert.equal(result.depthMm, 180);
  assertBoundsClose(result.parts.find((item) => item.id === 'box-90')?.bounds, { minX: -10, maxX: 30, minY: -70, maxY: 30 }, '90° rotated box');
  assertBoundsClose(result.parts.find((item) => item.id === 'cylinder-x-90')?.bounds, { minX: 95, maxX: 105, minY: -20, maxY: 20 }, '90° horizontal cylinder');
  assertBoundsClose(result.parts.find((item) => item.id === 'box-minus-90')?.bounds, { minX: -205, maxX: -195, minY: 90, maxY: 110 }, '-90° rotated box');
  assert.deepEqual(result.stations.map((item) => [item.id, item.partCount]), [['st1', 2], ['st2', 1]]);
  const svg = renderGeometryTopViewSvg(result);
  assert.match(svg, /aria-label="由 3 个当前参数化几何零件毫米 AABB 导出的俯视包络；世界 X 向右、Y 向上；不含手工 placements"/);
  assert.match(svg, /data-geometry-part-id="box-90"[^>]*x="-10" y="-30" width="40" height="100"/);
  assert.match(svg, /data-geometry-part-id="box-minus-90"[^>]*x="-205" y="-110" width="10" height="20"/);
  assert.match(svg, /data-geometry-station-id="st1"/);
  assert.match(svg, /全部零件毫米 AABB 的并集包络/);
  assert.doesNotMatch(svg, /data-placement=/);
});

test('真实生成几何：投影包络与每个世界空间零件 AABB 的并集一致', () => {
  const design = synthMachine(parseMachineBrief('四工位检测流水线，节拍 20 件/分钟'));
  const geometry = generateMachineGeometry(design, { bypassCache: true });
  const result = projectMachineGeometryTopView(geometry);
  assert.equal(result.status, 'ready');
  const boxes = geometry.parts.map((item) => partBounds(item));
  const expected = {
    minX: Math.min(...boxes.map((box) => box.min[0])),
    maxX: Math.max(...boxes.map((box) => box.max[0])),
    minY: Math.min(...boxes.map((box) => box.min[1])),
    maxY: Math.max(...boxes.map((box) => box.max[1]))
  };
  for (const key of Object.keys(expected)) assert.ok(Math.abs(result.bounds[key] - expected[key]) < 1e-9, `${key} must match geometry part AABBs`);
  assert.equal(result.partCount, geometry.parts.length);
  assert.deepEqual(result.stations.map((item) => item.id), geometry.stations.map((item) => item.id));
  for (const projected of result.parts) {
    const source = geometry.parts.find((item) => item.id === projected.id);
    assert.ok(source, `projected component ${projected.id} must come from geometry.parts`);
    const box = partBounds(source);
    assert.deepEqual(projected.bounds, { minX: box.min[0], maxX: box.max[0], minY: box.min[1], maxY: box.max[1] });
  }
});

test('保存/重开往返：由序列化设计重建的几何投影保持相同', () => {
  const original = synthMachine(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟'));
  const before = projectMachineGeometryTopView(geometryForDesign(original));
  const reopenedDesign = JSON.parse(JSON.stringify(original));
  const after = projectMachineGeometryTopView(geometryForDesign(reopenedDesign));
  assert.equal(before.status, 'ready');
  assert.equal(after.status, 'ready');
  assert.deepEqual(after, before);
});

test('未知、空、单位不符、工位映射断裂或汇总不一致时 fail-closed', () => {
  assert.equal(projectMachineGeometryTopView(null).status, 'blocked');
  const valid = makeGeometry([part('only-part', { type: 'box', size: [10, 20, 30] }, [0, 0, 15], 0, 'st1')], [
    { id: 'st1', name: '工位 A', index: 0, origin: [0, 0, 0], rotationZDeg: 0, plateSize: [10, 20, 1], workPoint: [0, 0, 0], footprint: { stationId: 'st1', center: [0, 0], half: [5, 10], rotationZDeg: 0 }, actuatorIds: [], sensorPoints: [] }
  ]);
  assert.match(projectMachineGeometryTopView({ ...valid, parts: [] }).reason, /零件为空/);
  assert.match(projectMachineGeometryTopView({ ...valid, units: 'cm' }).reason, /单位/);
  assert.match(projectMachineGeometryTopView({ ...valid, parts: [{ ...valid.parts[0], stationId: 'st999' }] }).reason, /stationId/);
  assert.match(projectMachineGeometryTopView({ ...valid, parts: [{ ...valid.parts[0], shape: { type: 'mesh' } }] }).reason, /零件/);
  assert.match(projectMachineGeometryTopView({ ...valid, parts: [{ ...valid.parts[0], mirrorX: true }] }).reason, /未声明的镜像/);
  assert.match(projectMachineGeometryTopView({ ...valid, envelope: [999, 999, 999] }).reason, /bounds\/envelope 不一致/);
});
