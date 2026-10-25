import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConveyorParts, conveyorAssembly, DEFAULT_CONVEYOR } from '../../src/machine/conveyor-assembly.ts';
import { compileOps } from '../../src/parametric/features.ts';

/** 用编译后的实例算子算每件的世界包围盒（与内核导出的坐标一致） */
function boxes(params) {
  const doc = conveyorAssembly(buildConveyorParts(params));
  return compileOps(doc).instances.map((instance) => {
    const box = instance.ops.find((op) => op.op === 'box');
    const cylinder = instance.ops.find((op) => op.op === 'cylinder');
    let sizes = [0, 0, 0];
    if (box) sizes = [box.length ?? 0, box.width ?? 0, box.height ?? 0];
    else if (cylinder) {
      const d = cylinder.diameter ?? 0;
      const h = cylinder.height ?? 0;
      sizes = cylinder.axis === 'x' ? [h, d, d] : cylinder.axis === 'y' ? [d, h, d] : [d, d, h];
    }
    const [sizeX, sizeY, sizeZ] = sizes;
    const d = instance.transform ?? { x: 0, y: 0, z: 0, rz: 0 };
    return { id: instance.id, name: instance.name, min: [d.x - sizeX / 2, d.y - sizeY / 2, d.z - sizeZ / 2], max: [d.x + sizeX / 2, d.y + sizeY / 2, d.z + sizeZ / 2] };
  });
}

function overlapMm3(a, b) {
  const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  return dx > 0 && dy > 0 && dz > 0 ? dx * dy * dz : 0;
}

test('横撑不再插进头尾端板（回归：曾 153600 mm³ 重叠）', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const plates = list.filter((item) => item.name.includes('端板'));
  const crosses = list.filter((item) => item.name.startsWith('横撑'));
  assert.ok(plates.length === 2 && crosses.length >= 3);
  for (const plate of plates) {
    for (const cross of crosses) {
      assert.equal(overlapMm3(plate, cross), 0, `${plate.name} 与 ${cross.name} 仍然重叠`);
    }
  }
});

test('横撑长度足够跨到两侧纵梁中心，装配不悬空', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const rail = list.find((item) => item.name.includes('操作侧'));
  const cross = list.find((item) => item.name.startsWith('横撑'));
  assert.ok(rail && cross);
  const railMid = (rail.min[1] + rail.max[1]) / 2;
  assert.ok(cross.min[1] < railMid, '横撑没伸到驱动侧纵梁中心线');
  assert.ok(cross.max[1] > railMid, '横撑没伸到操作侧纵梁中心线');
});

test('长线体横撑数量随长度增加，且首尾仍让开端板', () => {
  const long = { ...DEFAULT_CONVEYOR, lengthMm: 6000 };
  const list = boxes(long);
  const plates = list.filter((item) => item.name.includes('端板'));
  const crosses = list.filter((item) => item.name.startsWith('横撑'));
  assert.ok(crosses.length >= 10, `6 m 线体横撑只有 ${crosses.length} 根`);
  for (const plate of plates) {
    for (const cross of crosses) {
      assert.equal(overlapMm3(plate, cross), 0);
    }
  }
});

test('横撑不穿回程皮带（回归：曾 64000 mm³ 重叠）', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const belt = list.find((item) => item.name === '皮带回程');
  const crosses = list.filter((item) => item.name.startsWith('横撑'));
  assert.ok(belt && crosses.length > 0);
  for (const cross of crosses) {
    assert.equal(overlapMm3(belt, cross), 0, `${cross.name} 仍然穿过回程皮带`);
  }
});

test('回程皮带下沿与横撑顶面留出间隙，不是刚好相切', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const belt = list.find((item) => item.name === '皮带回程');
  const cross = list.find((item) => item.name.startsWith('横撑'));
  assert.ok(belt && cross);
  assert.ok(cross.max[2] <= belt.min[2], '横撑顶面高过回程皮带下沿');
  assert.ok(belt.min[2] - cross.max[2] >= 2, `间隙只有 ${(belt.min[2] - cross.max[2]).toFixed(1)} mm`);
});

test('滚筒筒体不穿端板（回归：曾 47985 mm³）', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const plates = list.filter((item) => item.name.includes('端板'));
  const pulleys = list.filter((item) => item.name.includes('滚筒'));
  assert.ok(plates.length === 2 && pulleys.length === 2);
  for (const plate of plates) {
    for (const pulley of pulleys) {
      assert.equal(overlapMm3(plate, pulley), 0, `${plate.name} 与 ${pulley.name} 仍然重叠`);
    }
  }
});

test('减速电机箱体不压进纵梁，外侧留安装间隙（回归：曾 128000 mm³）', () => {
  const list = boxes(DEFAULT_CONVEYOR);
  const motor = list.find((item) => item.name === '减速电机');
  const rails = list.filter((item) => item.name.includes('侧纵梁'));
  assert.ok(motor && rails.length === 2);
  for (const rail of rails) {
    assert.equal(overlapMm3(motor, rail), 0, `减速电机压进 ${rail.name}`);
  }
  const nearRail = rails.reduce((a, b) => (Math.abs(a.min[1] - motor.max[1]) < Math.abs(b.min[1] - motor.max[1]) ? a : b));
  assert.ok(nearRail.min[1] - motor.max[1] >= 0, '电机箱体与纵梁之间没有间隙');
});
