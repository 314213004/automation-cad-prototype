import test from 'node:test';
import assert from 'node:assert/strict';
import { snapRail, findOverlaps, outOfBounds, autoLayout, inspectLayout } from '../../src/design/layout.ts';
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
