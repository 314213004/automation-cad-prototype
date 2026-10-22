import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { MachineMotion, createScene3D } from '../../src/commission/scene3d.ts';

const config = demoMachineConfig();
const cylinder = config.actuators.find((actuator) => actuator.kind === 'cylinder' && actuator.extendPoint === 'Y0');
const gripper = config.actuators.find((actuator) => actuator.kind === 'gripper');
const rotary = config.actuators.find((actuator) => actuator.kind === 'rotary');

test('3D 运动：气缸伸展/缩回按 durationMs 插值并保持目标', () => {
  let clock = 0;
  const motion = new MachineMotion(config, () => clock);
  assert.ok(cylinder);
  motion.update({ Y0: true }, clock);
  assert.equal(motion.getActuator(cylinder.id)?.target, 1);
  clock = 200;
  motion.advance(clock);
  const halfway = motion.getActuator(cylinder.id)?.value ?? 0;
  assert.ok(halfway > 0 && halfway < 1);
  clock = 400;
  motion.advance(clock);
  assert.equal(motion.getActuator(cylinder.id)?.value, 1);
  motion.update({}, clock);
  assert.equal(motion.getActuator(cylinder.id)?.target, 1);
  motion.update({ Y4: true }, clock);
  assert.equal(motion.getActuator(cylinder.id)?.target, 0);
});

test('3D 运动：夹爪闭合与旋转 90° 目标值', () => {
  let clock = 0;
  const motion = new MachineMotion(config, () => clock);
  assert.ok(gripper);
  assert.ok(rotary);
  motion.update({ Y8: true, Y12: true }, clock);
  assert.equal(motion.getActuator(gripper.id)?.target, 1);
  assert.equal(motion.getActuator(rotary.id)?.target, 90);
  clock = 1000;
  motion.advance(clock);
  assert.equal(motion.getActuator(gripper.id)?.value, 1);
  assert.equal(motion.getActuator(rotary.id)?.value, 90);
  motion.update({ Y8: false, Y12: false }, clock);
  assert.equal(motion.getActuator(gripper.id)?.target, 0);
  assert.equal(motion.getActuator(rotary.id)?.target, 0);
});

test('3D 运动：传感器按各自点位亮灭', () => {
  const motion = new MachineMotion(config, () => 0);
  motion.update({ X0: true, X1: false, X15: true }, 0);
  assert.equal(motion.isSensorOn('X0'), true);
  assert.equal(motion.isSensorOn('X1'), false);
  assert.equal(motion.isSensorOn('X15'), true);
  motion.update({ X0: false, X15: false }, 0);
  assert.equal(motion.isSensorOn('X0'), false);
  assert.equal(motion.isSensorOn('X15'), false);
});

test('3D 场景：stats 部件数等于 4 个基座 + 12 个执行机构', () => {
  let clock = 0;
  const scene = createScene3D({}, config, () => clock);
  const stats = scene.stats();
  assert.equal(stats.stations, 4);
  assert.equal(stats.actuators, 12);
  assert.equal(stats.sensors, 16);
  assert.equal(stats.parts, 16);
  assert.ok(cylinder);
  scene.update({ Y0: true, Y8: true, Y12: true, X0: true });
  assert.equal(scene.motionState(cylinder.id)?.target, 1);
  assert.equal(scene.sensorOn('X0'), true);
  assert.equal(scene.stats().ticks, 1);
});
