import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMachineConfig, validateMachineConfig } from '../../src/commission/machine-config.ts';

function minimalConfig(overrides = {}) {
  return {
    id: 'test-machine',
    name: '测试机型',
    stations: ['上料'],
    actuators: [
      {
        id: 'station-1-cylinder',
        name: '上料气缸',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0',
        retractPoint: 'Y4'
      }
    ],
    sensors: [{ point: 'X0', station: '上料', part: 'station-1-cylinder' }],
    ...overrides
  };
}

test('机型配置：合法配置补全默认行程和动作时长', () => {
  const config = validateMachineConfig(minimalConfig());
  assert.equal(config.actuators[0]?.travelMm, 40);
  assert.equal(config.actuators[0]?.durationMs, 400);
  assert.deepEqual(config.stations, ['上料']);
});

test('机型配置：旋转轴默认分度角为 90°，工程师输入值和来源独立持久化', () => {
  const rotary = { id: 'rot-1', name: '分度台', kind: 'rotary', station: '上料', point: 'Y1' };
  const estimated = validateMachineConfig(minimalConfig({ actuators: [rotary], sensors: [] })).actuators[0];
  assert.equal(estimated?.rotationRangeDeg, 90);
  assert.equal(estimated?.rotationRangeSource, undefined);
  assert.equal(estimated?.travelMm, undefined);

  const manual = validateMachineConfig(minimalConfig({
    actuators: [{ ...rotary, rotationRangeDeg: 135.5, rotationRangeSource: 'engineer-input' }],
    sensors: []
  })).actuators[0];
  assert.equal(manual?.rotationRangeDeg, 135.5);
  assert.equal(manual?.rotationRangeSource, 'engineer-input');
});

test('机型配置：旋转角拒绝非有限、低于下限和高于 360°，并拒绝运动来源跨类型', () => {
  const rotary = { id: 'rot-1', name: '分度台', kind: 'rotary', station: '上料' };
  for (const rotationRangeDeg of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.09, 360.1]) {
    assert.throws(() => validateMachineConfig(minimalConfig({
      actuators: [{ ...rotary, rotationRangeDeg }], sensors: []
    })), /旋转分度角/);
  }
  assert.throws(() => validateMachineConfig(minimalConfig({
    actuators: [{ ...rotary, rotationRangeSource: 'engineer-input' }], sensors: []
  })), /必须显式填写 rotationRangeDeg/);
  assert.throws(() => validateMachineConfig(minimalConfig({
    actuators: [{ ...rotary, travelSource: 'engineer-input', travelMm: 40 }], sensors: []
  })), /不能携带直线行程来源/);
  assert.throws(() => validateMachineConfig(minimalConfig({
    actuators: [{ ...minimalConfig().actuators[0], rotationRangeDeg: 90 }]
  })), /非旋转轴不能携带/);
});

test('机型配置：缺少 stations 抛出中文错误', () => {
  assert.throws(() => validateMachineConfig(minimalConfig({ stations: undefined })), /缺少必填参数：机型配置\.stations/);
});

test('机型配置：缺少 actuators 抛出中文错误', () => {
  assert.throws(() => validateMachineConfig(minimalConfig({ actuators: undefined })), /缺少必填参数：机型配置\.actuators/);
});

test('机型配置：点位重复抛出中文错误', () => {
  const value = minimalConfig({
    actuators: [
      {
        id: 'a1',
        name: '气缸 1',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0'
      },
      {
        id: 'a2',
        name: '气缸 2',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0'
      }
    ],
    sensors: []
  });
  assert.throws(() => validateMachineConfig(value), /点位 Y0 重复/);
});

test('机型配置：Y 点与 Q 字节位别名重复时在 IO 收集前报错', () => {
  const value = minimalConfig({
    actuators: [{ id: 'a1', name: '气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0' }],
    sensors: [{ point: 'Q0.0', station: '上料', part: '输出别名' }]
  });
  assert.throws(() => validateMachineConfig(value), /别名冲突/);
});

test('机型配置：执行机构引用未定义工位抛出中文错误', () => {
  const value = minimalConfig();
  value.actuators[0].station = '压装';
  assert.throws(() => validateMachineConfig(value), /未定义工位「压装」/);
});

test('机型配置：传感器引用未定义工位抛出中文错误', () => {
  const value = minimalConfig();
  value.sensors[0].station = '下料';
  assert.throws(() => validateMachineConfig(value), /未定义工位「下料」/);
});

test('机型配置：travelMm 小于等于 0 抛出中文错误', () => {
  const value = minimalConfig();
  value.actuators[0].travelMm = 0;
  assert.throws(() => validateMachineConfig(value), /travelMm 必须大于 0/);
});

test('demo 机型：4 工位、12 执行机构、16 传感器且点位唯一', () => {
  const config = demoMachineConfig();
  assert.equal(config.stations.length, 4);
  assert.equal(config.actuators.length, 12);
  assert.equal(config.sensors.length, 16);
  assert.deepEqual(config.stations, ['上料', '压装', '锁付', '下料']);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'cylinder').length, 4);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'gripper').length, 4);
  assert.equal(config.actuators.filter((actuator) => actuator.kind === 'rotary').length, 4);
  assert.equal(new Set(config.sensors.map((sensor) => sensor.point)).size, 16);
});
