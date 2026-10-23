import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { applyAxisValue, buildThreeMachine } from '../../src/machine/geometry-three.ts';
import { createScene3D } from '../../src/commission/scene3d.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';

const design = synthMachine(parseMachineBrief('两工位装配机，节拍 10 件/分钟'));

function worldBox(object) {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object);
}

test('three 场景树：网格数 = 零件数，每个执行机构/传感器都有节点，缩放把最长边压到 targetSpan', () => {
  const geometry = generateMachineGeometry(design);
  const machine = buildThreeMachine(geometry, { targetSpan: 6 });
  assert.equal(machine.meshCount, geometry.parts.length);
  assert.equal(machine.actuators.size, design.config.actuators.length);
  assert.equal(machine.sensors.size, design.config.sensors.length);
  assert.equal(machine.stationGroups.size, 2);
  const size = worldBox(machine.root).getSize(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - 6) < 0.05, `span=${size.toArray()}`);
  // Z 向上 → Y 向上：场景高度对应几何 Z 包络。
  assert.ok(Math.abs(size.y - geometry.envelope[2] * machine.scale) < 0.05);
});

test('three 动画：气缸伸出平移 = 行程、夹爪每指移动半行程、旋转台转 90°', () => {
  const geometry = generateMachineGeometry(design);
  const machine = buildThreeMachine(geometry);
  const cylinder = [...machine.actuators.values()].find((node) => node.axis.kind === 'linear');
  const gripper = [...machine.actuators.values()].find((node) => node.axis.kind === 'gripper');
  assert.ok(cylinder && gripper);
  applyAxisValue(cylinder, 1);
  assert.deepEqual(cylinder.mover.position.toArray(), [0, 0, -cylinder.axis.strokeMm]);
  applyAxisValue(cylinder, 0);
  assert.deepEqual(cylinder.mover.position.toArray().map((value) => Math.abs(value)), [0, 0, 0]);
  applyAxisValue(gripper, 1);
  const offsets = gripper.jaws.map((jaw) => jaw.group.position.length());
  for (const offset of offsets) assert.ok(Math.abs(offset - gripper.axis.strokeMm / 2) < 1e-9);
  const [left, right] = gripper.jaws.map((jaw) => jaw.group.position.clone().dot(new THREE.Vector3(...gripper.axis.axis)));
  assert.ok(left * right < 0, '两指反向');

  const rotaryGeometry = generateMachineGeometry(synthMachine(parseMachineBrief('两工位点胶机')));
  const rotaryMachine = buildThreeMachine(rotaryGeometry);
  const rotary = [...rotaryMachine.actuators.values()].find((node) => node.axis.kind === 'rotary');
  assert.ok(rotary);
  const fixture = rotary.mover.children.find((child) => child.name.endsWith('-fixture'));
  const before = worldBox(fixture).getCenter(new THREE.Vector3());
  applyAxisValue(rotary, 90);
  const after = worldBox(fixture).getCenter(new THREE.Vector3());
  assert.ok(before.distanceTo(after) > 0.01, '治具应随台面转动');
  const angle = 2 * Math.acos(Math.min(1, Math.abs(rotary.mover.quaternion.w)));
  assert.ok(Math.abs(angle - Math.PI / 2) < 1e-6);
});

test('联调 3D：场景改用参数化几何，stats 暴露零件数/包络/布局，点位驱动随动件', () => {
  const scene = createScene3D({}, design.config, () => 0);
  const stats = scene.stats();
  const geometry = scene.machineGeometry();
  assert.ok(geometry);
  assert.equal(stats.geometryParts, geometry.parts.length);
  assert.deepEqual(stats.envelopeMm, geometry.envelope);
  assert.equal(stats.layout, 'dial');
  assert.equal(stats.parts, 2 + design.config.actuators.length);
  const cylinder = design.config.actuators.find((actuator) => actuator.kind === 'cylinder');
  scene.update({ [cylinder.extendPoint]: true });
  // 无 WebGL 时 update 直接落到目标位。
  assert.equal(scene.motionState(cylinder.id)?.value, 1);

  const demo = createScene3D({}, demoMachineConfig(), () => 0).stats();
  assert.equal(demo.parts, 16);
  assert.ok(demo.geometryParts > 100);
  assert.equal(demo.layout, 'linear');
});
