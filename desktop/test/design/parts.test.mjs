import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePartBindings, validatePointConflicts, allocateActuatorPoints, allPoints, designIssueTargetFromPath } from '../../src/design/parts.ts';
const part = { id: 'cyl-1', packId: 'smc', model: 'CQ2-20', category: '气缸', specs: {} };
const stations = [{ id: 's1', name: '工位 1', actuators: [{ id: 'a1', name: '夹紧气缸', kind: 'cylinder', station: '工位 1', model: 'NO-SUCH', extendPoint: 'X0' }], sensors: [{ point: 'x0', station: '工位 1', part: 'a1' }] }];
test('型号不存在返回 PART_NOT_FOUND 中文提示', () => {
  const issues = validatePartBindings(stations, [part]);
  assert.equal(issues[0].code, 'PART_NOT_FOUND');
  assert.match(issues[0].message, /元件库中不存在/);
  assert.equal(issues[0].path, 'stations[0].actuators[0].model');
  assert.deepEqual(designIssueTargetFromPath(issues[0].path), {
    stationIndex: 0, itemType: 'actuator', itemIndex: 0, field: 'model'
  });
  assert.deepEqual(validatePartBindings([{ ...stations[0], actuators: [{ ...stations[0].actuators[0], model: 'CQ2-20', packId: 'smc' }] }], [part]), []);
});
test('点位大小写不敏感重复返回中文错误', () => {
  const issues = validatePointConflicts(stations);
  assert.equal(issues[0].code, 'DUPLICATE_POINT');
  assert.match(issues[0].message, /点位.*重复/);
  assert.equal(issues[0].path, 'stations[0].sensors[0].point');
  assert.deepEqual(designIssueTargetFromPath(issues[0].path), {
    stationIndex: 0, itemType: 'sensor', itemIndex: 0, field: 'point'
  });
});
test('校验路径可解析到后续工位的执行机构点位，拒绝畸形或未知字段', () => {
  assert.deepEqual(designIssueTargetFromPath('stations[12].actuators[3].retractPoint'), {
    stationIndex: 12, itemType: 'actuator', itemIndex: 3, field: 'retractPoint'
  });
  assert.deepEqual(designIssueTargetFromPath('stations[2].actuators[0].point'), {
    stationIndex: 2, itemType: 'actuator', itemIndex: 0, field: 'point'
  });
  assert.equal(designIssueTargetFromPath('stations[0].actuators[0].packId'), null);
  assert.equal(designIssueTargetFromPath('stations[-1].sensors[0].point'), null);
  assert.equal(designIssueTargetFromPath('stations[0].unknown[0].point'), null);
});
test('新增机构按 io 命名规则避让已有点位', () => {
  const allocated = allocateActuatorPoints(0, 0, 'cylinder', allPoints(stations));
  assert.notEqual(allocated.extendPoint, 'X0');
  assert.notEqual(allocated.retractPoint, 'X0');
});
