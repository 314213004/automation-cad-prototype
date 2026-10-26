import test from 'node:test';
import assert from 'node:assert/strict';
import { snapRail, findOverlaps, outOfBounds, autoLayout, inspectLayout, movePlacement, placementSnapshotFingerprint, setPlacementCoordinate } from '../../src/design/layout.ts';
const base = { partId: 'p', model: 'M', w: 35, h: 35 };
test('35mm 导轨吸附取整', () => {
  assert.equal(snapRail(52), 35);
  assert.equal(snapRail(53), 70);
  assert.equal(snapRail(-18), -35);
  assert.throws(() => snapRail(NaN), /有限数值/);
});
test('重叠按冲突对计数，接触不算重叠', () => {
  const items = [{ ...base, id: 'a', x: 0, y: 0 }, { ...base, id: 'b', x: 20, y: 0 }, { ...base, id: 'c', x: 25, y: 20 }, { ...base, id: 'touch', x: 60, y: 0 }];
  assert.equal(findOverlaps(items).length, 3);
  assert.equal(findOverlaps([items[0], items[3]]).length, 0);
});
test('直接输入毫米坐标不吸附网格，拖动仍按35毫米吸附', () => {
  const placement = { ...base, id: 'station:s1', x: 35, y: 70, tag: 'station' };
  const edited = setPlacementCoordinate(setPlacementCoordinate(placement, 'x', 123), 'y', 456);
  assert.equal(edited.x, 123);
  assert.equal(edited.y, 456);
  assert.equal(edited.w, placement.w);
  assert.equal(edited.id, placement.id);
  assert.deepEqual(movePlacement(placement, 123, 124), { ...placement, x: 140, y: 140 });
  assert.throws(() => setPlacementCoordinate(placement, 'x', Infinity), /有限数值/);
});
test('重叠确认指纹覆盖完整 placements 顺序、对象与坐标快照', () => {
  const first = [{ ...base, id: 'a', x: 0, y: 0 }, { ...base, id: 'b', x: 20, y: 0 }];
  const fingerprint = placementSnapshotFingerprint(first);

  assert.equal(placementSnapshotFingerprint(structuredClone(first)), fingerprint);
  assert.notEqual(placementSnapshotFingerprint([{ ...first[0], x: 1 }, first[1]]), fingerprint);
  assert.notEqual(placementSnapshotFingerprint([{ ...first[0], model: '改名' }, first[1]]), fingerprint);
  assert.notEqual(placementSnapshotFingerprint([...first].reverse()), fingerprint);
});
test('越界判定与自动布局', () => {
  const canvas = { width: 700, height: 350 };
  assert.deepEqual(outOfBounds([{ ...base, id: 'a', x: 700, y: 0 }], canvas), ['a']);
  assert.deepEqual(outOfBounds([{ ...base, id: 'b', x: -35, y: 0 }], canvas), ['b']);
  const placements = autoLayout([{ id: 's1', name: '上料', actuators: [], sensors: [] }, { id: 's2', name: '锁附', actuators: [], sensors: [] }], canvas);
  const report = inspectLayout(placements, canvas);
  assert.equal(report.stations, 2);
  assert.equal(report.outOfBounds.length, 0);
  assert.ok(placements.every((item) => item.x % 35 === 0 && item.y % 35 === 0));
});
