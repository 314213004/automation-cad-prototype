import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePartBindings, validatePointConflicts, allocateActuatorPoints, allPoints } from '../../src/design/parts.ts';
const part = { id: 'cyl-1', packId: 'smc', model: 'CQ2-20', category: '气缸', specs: {} };
const stations = [{ id: 's1', name: '工位 1', actuators: [{ id: 'a1', name: '夹紧气缸', kind: 'cylinder', station: '工位 1', model: 'NO-SUCH', extendPoint: 'X0' }], sensors: [{ point: 'x0', station: '工位 1', part: 'a1' }] }];
test('型号不存在返回 PART_NOT_FOUND 中文提示', () => {
  const issues = validatePartBindings(stations, [part]);
  assert.equal(issues[0].code, 'PART_NOT_FOUND');
  assert.match(issues[0].message, /元件库中不存在/);
  assert.deepEqual(validatePartBindings([{ ...stations[0], actuators: [{ ...stations[0].actuators[0], model: 'CQ2-20', packId: 'smc' }] }], [part]), []);
});
test('点位大小写不敏感重复返回中文错误', () => {
  const issues = validatePointConflicts(stations);
  assert.equal(issues[0].code, 'DUPLICATE_POINT');
  assert.match(issues[0].message, /点位.*重复/);
});
test('新增机构按 io 命名规则避让已有点位', () => {
  const allocated = allocateActuatorPoints(0, 0, 'cylinder', allPoints(stations));
  assert.notEqual(allocated.extendPoint, 'X0');
  assert.notEqual(allocated.retractPoint, 'X0');
});
