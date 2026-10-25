import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { applyAxisValue, buildThreeMachine } from '../../src/machine/geometry-three.ts';
import { resetActuatorTravelOnKindChange } from '../../src/design/wizard-state.ts';
import {
  GEOMETRY_DIMENSIONS as D,
  chooseLayout,
  footprintsOverlap,
  generateMachineGeometry,
  geometryComponentCounts,
  inferProcess,
  partBounds,
  summarizeGeometry
} from '../../src/machine/geometry.ts';

const SCREW = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
const PROCESS_BRIEFS = {
  screw: '锁螺丝机',
  dispense: '点胶机',
  assembly: '装配机，安全光栅 2 个',
  inspection: '检测机',
  packaging: '包装机',
  unknown: '一台设备'
};

function design(brief = SCREW, options = {}) {
  return synthMachine(parseMachineBrief(brief), options);
}

function partById(geometry, id) {
  const part = geometry.parts.find((item) => item.id === id);
  assert.ok(part, `缺少零件 ${id}`);
  return part;
}

function footprintAabb(fp) {
  const rad = (fp.rotationZDeg * Math.PI) / 180;
  const ex = fp.half[0] * Math.abs(Math.cos(rad)) + fp.half[1] * Math.abs(Math.sin(rad));
  const ey = fp.half[0] * Math.abs(Math.sin(rad)) + fp.half[1] * Math.abs(Math.cos(rad));
  return { minX: fp.center[0] - ex, maxX: fp.center[0] + ex, minY: fp.center[1] - ey, maxY: fp.center[1] + ey };
}

test('几何：三工位锁螺丝机按分度转盘布局，零件 id 全局唯一且只含 [a-z0-9-]', () => {
  const geometry = generateMachineGeometry(design(), { layout: 'dial' });
  assert.equal(geometry.kind, 'machine-geometry');
  assert.equal(geometry.units, 'mm');
  assert.equal(geometry.upAxis, 'z');
  assert.equal(geometry.process, 'screw');
  assert.equal(geometry.layout, 'dial');
  assert.equal(geometry.stations.length, 3);
  assert.equal(geometry.moving.length, 6);
  const ids = geometry.parts.map((part) => part.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  assert.ok(ids.includes('dial-plate'));
  assert.ok(ids.includes('dial-indexer'));
  assert.ok(!ids.includes('conveyor-frame'));
});

test('几何：台面 850 mm、工位底板顶面 865 mm，底板宽度 = 槽位之和 + 两侧余量', () => {
  const geometry = generateMachineGeometry(design());
  const top = partById(geometry, 'frame-top');
  assert.deepEqual(top.shape.size.slice(2), [D.topPlateThickness]);
  assert.equal(top.center[2] + top.shape.size[2] / 2, 850);
  assert.equal(geometry.tableHeight, 850);
  for (const station of geometry.stations) {
    assert.equal(station.origin[2], 865);
    const plate = partById(geometry, `${station.id}-plate`);
    const bounds = partBounds(plate);
    assert.equal(Math.round(bounds.max[2] * 1000) / 1000, 865);
    assert.equal(plate.shape.size[1], 300);
    assert.equal(plate.shape.size[2], 15);
    // 锁螺丝模板每工位：旋转轴 170 + 夹爪 130，两侧各 50。
    assert.equal(plate.shape.size[0], 170 + 130 + 2 * D.stationMargin);
  }
  // 立腿高度 = 台面 - 板厚；所有零件都在地面以上。
  const leg = partById(geometry, 'frame-leg-1');
  assert.equal(leg.shape.size[2], 830);
  for (const part of geometry.parts) assert.ok(partBounds(part).min[2] >= -1e-6, part.id);
});

test('几何：气缸缸体 Ø40×(行程+70)、活塞杆缩回位露出 25 mm，伸出到位不撞治具', () => {
  const geometry = generateMachineGeometry(design('两工位装配机，节拍 10 件/分钟'));
  const cylinders = geometry.moving.filter((axis) => axis.kind === 'linear');
  assert.equal(cylinders.length, 2);
  for (const axis of cylinders) {
    const key = axis.actuatorId;
    const body = partById(geometry, `${key}-body`);
    const rod = partById(geometry, `${key}-rod`);
    const tool = partById(geometry, `${key}-tool`);
    const nest = partById(geometry, `${key}-nest`);
    assert.equal(body.shape.type, 'cylinder');
    assert.equal(body.shape.radius, 20);
    assert.equal(body.shape.length, axis.strokeMm + 70);
    const bodyBottom = partBounds(body).min[2];
    const rodBottom = partBounds(rod).min[2];
    assert.equal(Math.round((bodyBottom - rodBottom) * 1000) / 1000, 25);
    const extendedBottom = partBounds(tool).min[2] - axis.strokeMm;
    assert.ok(extendedBottom > partBounds(nest).max[2], `${key} 伸出后 ${extendedBottom} 应高于治具`);
  }
});

test('几何：1–12 工位、全部工艺与布局下工位占地互不重叠，且不压输送线/转盘', () => {
  let checked = 0;
  for (const [process, brief] of Object.entries(PROCESS_BRIEFS)) {
    for (let stations = 1; stations <= 12; stations += 1) {
      const geometry = generateMachineGeometry(design(brief, { stationCount: stations }));
      assert.equal(geometry.process, process);
      const fps = geometry.stations.map((station) => station.footprint);
      for (let i = 0; i < fps.length; i += 1) {
        for (let j = i + 1; j < fps.length; j += 1) {
          assert.equal(footprintsOverlap(fps[i], fps[j]), false, `${process} ${stations} 工位：${fps[i].stationId} 与 ${fps[j].stationId} 重叠`);
          checked += 1;
        }
      }
      const conveyor = geometry.parts.find((part) => part.id === 'conveyor-frame');
      if (conveyor) {
        const box = partBounds(conveyor);
        for (const fp of fps) assert.ok(box.max[1] <= footprintAabb(fp).minY, `${process} ${stations}：输送线压到 ${fp.stationId}`);
      }
      const dial = geometry.parts.find((part) => part.id === 'dial-plate');
      if (dial) {
        for (const fp of fps) {
          // 转盘中心到旋转矩形的最近距离 ≥ 转盘半径。
          const rad = (-fp.rotationZDeg * Math.PI) / 180;
          const vx = dial.center[0] - fp.center[0];
          const vy = dial.center[1] - fp.center[1];
          const lx = vx * Math.cos(rad) - vy * Math.sin(rad);
          const ly = vx * Math.sin(rad) + vy * Math.cos(rad);
          const dist = Math.hypot(Math.max(Math.abs(lx) - fp.half[0], 0), Math.max(Math.abs(ly) - fp.half[1], 0));
          assert.ok(dist >= dial.shape.radius, `${process} ${stations}：转盘侵入 ${fp.stationId}（${dist}）`);
        }
      }
      // 机架台面覆盖全部工位占地。
      const top = partBounds(partById(geometry, 'frame-top'));
      for (const fp of fps) {
        const box = footprintAabb(fp);
        assert.ok(box.minX >= top.min[0] - 1e-6 && box.maxX <= top.max[0] + 1e-6, `${process} ${stations}：${fp.stationId} 超出台面 X`);
        assert.ok(box.minY >= top.min[1] - 1e-6 && box.maxY <= top.max[1] + 1e-6, `${process} ${stations}：${fp.stationId} 超出台面 Y`);
      }
    }
  }
  assert.ok(checked > 300);
});

test('几何：每个执行机构恰有 1 条运动轴，轴向/行程/点位与配置一致，随动件都存在', () => {
  const source = design('四工位装配机，汇川伺服，2 个气缸 2 个夹爪 4 个旋转轴，安全光栅 2 个');
  const geometry = generateMachineGeometry(source);
  assert.equal(geometry.moving.length, source.config.actuators.length);
  const partIds = new Set(geometry.parts.map((part) => part.id));
  const covered = new Set();
  for (const actuator of source.config.actuators) {
    const axes = geometry.moving.filter((axis) => axis.actuatorId === actuator.id);
    assert.equal(axes.length, 1, actuator.id);
    const axis = axes[0];
    assert.ok(Math.abs(Math.hypot(...axis.axis) - 1) < 1e-6, `${actuator.id} 轴向应为单位向量`);
    assert.ok(axis.partIds.length > 0);
    for (const id of axis.partIds) {
      assert.ok(partIds.has(id), id);
      assert.equal(geometry.parts.find((part) => part.id === id)?.moving, true, id);
      covered.add(id);
    }
    assert.equal(axis.durationMs, actuator.durationMs);
    if (actuator.kind === 'cylinder') {
      assert.equal(axis.kind, 'linear');
      assert.deepEqual(axis.axis, [0, 0, -1]);
      assert.equal(axis.strokeMm, actuator.travelMm);
      assert.equal(axis.home, 'retracted');
      assert.deepEqual(axis.points, { extend: actuator.extendPoint, retract: actuator.retractPoint });
    } else if (actuator.kind === 'gripper') {
      assert.equal(axis.kind, 'gripper');
      assert.equal(axis.axis[2], 0);
      assert.equal(axis.home, 'open');
      assert.equal(axis.strokeMm, actuator.travelMm);
      assert.equal(axis.jaws.length, 2);
      assert.deepEqual(axis.jaws.map((jaw) => jaw.sign).sort(), [-1, 1]);
      assert.deepEqual(axis.points, { grip: actuator.gripPoint });
      // 张开位两指内侧间距 = 闭合间隙 + 行程。
      const [left, right] = axis.jaws.map((jaw) => geometry.parts.find((part) => part.id === jaw.partId));
      const gap = Math.hypot(left.center[0] - right.center[0], left.center[1] - right.center[1]) - D.gripperJaw[0];
      assert.ok(Math.abs(gap - (D.gripperClosedGap + actuator.travelMm)) < 1e-6);
    } else {
      assert.equal(axis.kind, 'rotary');
      assert.deepEqual(axis.axis, [0, 0, 1]);
      assert.equal(axis.rangeDeg, 90);
      assert.equal(axis.home, 'zero');
      assert.deepEqual(axis.points, { point: actuator.point });
      const table = geometry.parts.find((part) => part.id === axis.partIds[0]);
      assert.equal(axis.pivot[0], table.center[0]);
      assert.equal(axis.pivot[1], table.center[1]);
    }
  }
  const movingParts = geometry.parts.filter((part) => part.moving).map((part) => part.id);
  assert.deepEqual([...covered].sort(), movingParts.sort());
});

test('几何：执行机构/传感器数量与 bomDraft 一致（BOM/成本联动对账）', () => {
  const briefs = [
    SCREW,
    '两工位点胶机 3 秒一件',
    '四工位装配机，汇川伺服，安全光栅 2 个',
    '六工位检测机',
    '三工位包装机',
    '五工位设备，3 个气缸，2 个光电，1 个压力传感器'
  ];
  const groups = {
    气缸: 'actuator:cylinder',
    夹爪: 'actuator:gripper',
    旋转轴: 'actuator:rotary',
    接近开关: 'sensor:proximity',
    光电传感器: 'sensor:photoelectric',
    压力传感器: 'sensor:pressure',
    安全光栅: 'sensor:safety'
  };
  for (const brief of briefs) {
    const source = design(brief);
    const counts = geometryComponentCounts(generateMachineGeometry(source));
    for (const [name, group] of Object.entries(groups)) {
      const item = source.bomDraft.items.find((row) => row.name === name);
      assert.equal(counts[group], item?.qty ?? 0, `${brief}：${name}`);
    }
  }
});

test('几何：包络等于 bounds 差值，全部零件落在 bounds 内；结构件 BOM 有机架/底板/门架', () => {
  const geometry = generateMachineGeometry(design('四工位检测流水线'));
  assert.equal(geometry.layout, 'linear');
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(geometry.envelope[axis] - (geometry.bounds.max[axis] - geometry.bounds.min[axis])) < 1e-6);
  }
  for (const part of geometry.parts) {
    const box = partBounds(part);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(box.min[axis] >= geometry.bounds.min[axis] - 1e-6 && box.max[axis] <= geometry.bounds.max[axis] + 1e-6, part.id);
    }
  }
  assert.equal(geometry.bounds.min[2], 0);
  const names = geometry.structureBom.map((row) => row.name);
  for (const name of ['机架台面', '机架立腿', '工位底板', '门架立柱', '门架横梁', '皮带输送线']) assert.ok(names.includes(name), name);
  assert.equal(geometry.structureBom.find((row) => row.name === '门架立柱')?.qty, 8);
  // 检测模板每工位 1 安全光栅 → 每工位两根光栅立柱。
  assert.equal(geometry.parts.filter((part) => part.role === 'safety').length, 8);
  const summary = summarizeGeometry(geometry);
  assert.equal(summary.parts, geometry.parts.length);
  assert.equal(summary.movingAxes, 4);
  assert.deepEqual(summary.envelopeMm, geometry.envelope);
});

test('几何：确定性；接受 design 或 config；布局可覆盖；工艺按 id 推断', () => {
  const source = design();
  assert.deepEqual(generateMachineGeometry(source), generateMachineGeometry(source));
  assert.deepEqual(
    generateMachineGeometry(source),
    generateMachineGeometry(source.config, { layout: source.form.geometry.kind })
  );
  assert.equal(generateMachineGeometry(source, { layout: 'linear' }).layout, 'linear');
  assert.equal(inferProcess({ id: 'design-dispense-2st' }), 'dispense');
  assert.equal(inferProcess({ id: 'demo-4x3' }), 'unknown');
  assert.equal(chooseLayout('screw', 1), 'single');
  assert.equal(chooseLayout('screw', 8), 'dial');
  assert.equal(chooseLayout('screw', 9), 'linear');
  assert.equal(chooseLayout('inspection', 3), 'linear');
  const single = generateMachineGeometry(design('锁螺丝机', { stationCount: 1 }));
  assert.equal(single.layout, 'single');
  assert.ok(!single.parts.some((part) => part.role === 'transfer'));
  assert.throws(() => generateMachineGeometry({ id: 'x', name: 'x', stations: [], actuators: [], sensors: [] }), /stations/);
});

test('几何：内置 4 工位样机（非合成 id、传感器挂工位名）也能生成', () => {
  const config = demoMachineConfig();
  const geometry = generateMachineGeometry(config);
  assert.equal(geometry.layout, 'linear');
  assert.equal(geometry.stations.length, 4);
  assert.equal(geometry.moving.length, 12);
  const sensorPoints = new Set(geometry.parts.filter((part) => part.role === 'sensor').map((part) => part.sensorPoint));
  assert.equal(sensorPoints.size, 16);
  assert.deepEqual(geometry.stations.map((station) => station.name), config.stations);
});

test('几何：分度转盘超过 6 工位给出布局 warning；占地重叠判定（旋转矩形 / 贴边）', () => {
  const geometry = generateMachineGeometry(design('八工位转盘锁螺丝机'));
  assert.equal(geometry.layout, 'dial');
  assert.ok(geometry.warnings.some((warning) => /直线输送/.test(warning)));
  const a = { stationId: 'a', center: [0, 0], half: [100, 50], rotationZDeg: 0 };
  assert.equal(footprintsOverlap(a, { stationId: 'b', center: [200, 0], half: [100, 50], rotationZDeg: 0 }), false);
  assert.equal(footprintsOverlap(a, { stationId: 'c', center: [150, 0], half: [100, 50], rotationZDeg: 0 }), true);
  // 45° 旋转后 AABB 相交但实体不相交。
  assert.equal(footprintsOverlap(
    { stationId: 'd', center: [0, 0], half: [50, 50], rotationZDeg: 45 },
    { stationId: 'e', center: [72, 72], half: [10, 10], rotationZDeg: 45 }
  ), false);
  assert.equal(footprintsOverlap(
    { stationId: 'd', center: [0, 0], half: [50, 50], rotationZDeg: 45 },
    { stationId: 'f', center: [60, 0], half: [10, 10], rotationZDeg: 0 }
  ), true);
});

test('几何与运动预览：工程师行程更新气缸/夹爪几何、运动轴，并明确标注仍待复核', () => {
  const base = demoMachineConfig();
  const cylinder = base.actuators.find((item) => item.kind === 'cylinder');
  const gripper = base.actuators.find((item) => item.kind === 'gripper');
  assert.ok(cylinder);
  assert.ok(gripper);
  const config = {
    ...base,
    actuators: base.actuators.map((item) => item.id === cylinder.id
      ? { ...item, travelMm: 125, travelSource: 'engineer-input' }
      : item.id === gripper.id
        ? { ...item, travelMm: 35, travelSource: 'engineer-input' }
        : item)
  };
  const geometry = generateMachineGeometry(config, { layout: 'linear', bypassCache: true });
  const cylinderAxis = geometry.moving.find((axis) => axis.actuatorId === cylinder.id);
  const gripperAxis = geometry.moving.find((axis) => axis.actuatorId === gripper.id);
  assert.equal(cylinderAxis?.strokeMm, 125);
  assert.equal(gripperAxis?.strokeMm, 35);
  assert.equal(partById(geometry, `${cylinder.id}-body`).shape.length, 195);
  const jaws = gripperAxis?.jaws.map((jaw) => partById(geometry, jaw.partId));
  assert.ok(jaws);
  assert.equal(Math.abs(jaws[0].center[0] - jaws[1].center[0]) - D.gripperJaw[0], D.gripperClosedGap + 35);
  assert.ok(geometry.assumptions.some((line) => /直线行程（工程师输入·待复核）/.test(line)));
  assert.ok(geometry.warnings.some((line) => /工程师输入的直线行程尚待复核/.test(line)));
  assert.ok(geometry.warnings.some((line) => /直线行程为方案\/系统估算值（待核验）/.test(line)));
  assert.ok(geometry.parts.every((part) => part.estimated === true), '手工行程不改变整机概念估算占位体的精度标记');

  const preview = buildThreeMachine(geometry);
  const cylinderNode = preview.actuators.get(cylinder.id);
  const gripperNode = preview.actuators.get(gripper.id);
  assert.ok(cylinderNode?.mover);
  assert.ok(gripperNode);
  applyAxisValue(cylinderNode, 1);
  applyAxisValue(gripperNode, 1);
  assert.equal(cylinderNode.mover.position.z, -125);
  assert.deepEqual(gripperNode.jaws.map((jaw) => jaw.group.position.x).sort((a, b) => a - b), [-17.5, 17.5]);
});

test('旋转轴分度角驱动 GeomMovingAxis 和 3D 预览运动，报告来源且保持概念估算边界', () => {
  const base = demoMachineConfig();
  const rotary = base.actuators.find((item) => item.kind === 'rotary');
  assert.ok(rotary);
  const manual = {
    ...base,
    actuators: base.actuators.map((item) => item.id === rotary.id
      ? { ...item, rotationRangeDeg: 137.5, rotationRangeSource: 'engineer-input' }
      : item)
  };
  const geometry = generateMachineGeometry(manual, { layout: 'linear', bypassCache: true });
  const axis = geometry.moving.find((item) => item.actuatorId === rotary.id);
  assert.equal(axis?.rangeDeg, 137.5);
  assert.ok(geometry.assumptions.some((line) => /旋转轴分度角（工程师输入·待复核）/.test(line)));
  assert.ok(geometry.warnings.some((line) => /工程师输入的旋转轴分度角尚待复核/.test(line)));
  assert.ok(geometry.warnings.some((line) => /不代表旋转台型号、安装或制造数据/.test(line)));
  assert.ok(geometry.parts.every((part) => part.estimated === true));

  const preview = buildThreeMachine(geometry);
  const node = preview.actuators.get(rotary.id);
  assert.ok(node?.mover);
  applyAxisValue(node, 137.5);
  assert.equal(node.lastValue, 137.5);
  const appliedAngle = 2 * Math.atan2(node.mover.quaternion.z, node.mover.quaternion.w) * 180 / Math.PI;
  assert.ok(Math.abs(appliedAngle - 137.5) < 1e-6);

  const estimatedGeometry = generateMachineGeometry(base, { layout: 'linear', bypassCache: true });
  const estimatedAxis = estimatedGeometry.moving.find((item) => item.actuatorId === rotary.id);
  assert.equal(estimatedAxis?.rangeDeg, 90);
  assert.ok(estimatedGeometry.assumptions.some((line) => /旋转轴分度角（方案\/系统估算）.*90°/.test(line)));
  assert.ok(estimatedGeometry.warnings.some((line) => /旋转轴分度角为方案\/系统估算值（待核验）/.test(line)));

  for (const range of [0.1, 360]) {
    const edgeConfig = { ...base, actuators: base.actuators.map((item) => item.id === rotary.id
      ? { ...item, rotationRangeDeg: range, rotationRangeSource: 'engineer-input' }
      : item) };
    assert.equal(generateMachineGeometry(edgeConfig, { layout: 'linear', bypassCache: true }).moving.find((item) => item.actuatorId === rotary.id)?.rangeDeg, range);
  }
});

test('几何入口拒绝非有限、非正及大于 2000 mm 的行程，不再 clamp 到 1 mm', () => {
  const base = demoMachineConfig();
  const cylinder = base.actuators.find((item) => item.kind === 'cylinder');
  assert.ok(cylinder);
  for (const travelMm of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2000.1]) {
    const config = { ...base, actuators: base.actuators.map((item) => item.id === cylinder.id ? { ...item, travelMm } : item) };
    const expected = !Number.isFinite(travelMm) ? /行程必须是有限数/ : travelMm <= 0 ? /travelMm 必须大于 0/ : /行程必须在 0\.1–2000 mm 范围内/;
    assert.throws(() => generateMachineGeometry(config, { bypassCache: true }), expected);
  }
});

test('几何类型切换清除旧运动参数来源，线性轴回到 40 mm、旋转轴回到 90° 估算', () => {
  const base = demoMachineConfig();
  const cylinder = base.actuators.find((item) => item.kind === 'cylinder');
  const gripper = base.actuators.find((item) => item.kind === 'gripper');
  const rotary = base.actuators.find((item) => item.kind === 'rotary');
  assert.ok(cylinder);
  assert.ok(gripper);
  assert.ok(rotary);

  for (const [source, to, oldTravel, oldRotation] of [
    [cylinder, 'gripper', 125, undefined],
    [gripper, 'cylinder', 35, undefined],
    [rotary, 'cylinder', undefined, 135],
    [cylinder, 'rotary', 125, undefined]
  ]) {
    const changed = {
      ...source,
      ...(oldTravel === undefined ? {} : { travelMm: oldTravel, travelSource: 'engineer-input' }),
      ...(oldRotation === undefined ? {} : { rotationRangeDeg: oldRotation, rotationRangeSource: 'engineer-input' })
    };
    changed.kind = to;
    resetActuatorTravelOnKindChange(changed);
    assert.equal(changed.travelMm, undefined);
    assert.equal(changed.travelSource, undefined);
    assert.equal(changed.rotationRangeSource, undefined);
    assert.equal(changed.rotationRangeDeg, to === 'rotary' ? 90 : undefined);
    const config = { ...base, actuators: base.actuators.map((item) => item.id === changed.id ? changed : item) };
    const geometry = generateMachineGeometry(config, { bypassCache: true });
    const axis = geometry.moving.find((item) => item.actuatorId === changed.id);
    if (to === 'rotary') {
      assert.equal(axis?.rangeDeg, 90);
      assert.ok(geometry.warnings.some((warning) => warning.startsWith('旋转轴分度角为方案/系统估算值（待核验）：') && warning.includes(`${changed.station}·${changed.name} 90°`)));
      assert.ok(!geometry.warnings.some((warning) => warning.includes('工程师输入的旋转轴分度角尚待复核') && warning.includes(changed.name)));
    } else {
      assert.equal(axis?.strokeMm, 40);
      assert.ok(geometry.warnings.some((warning) => warning.startsWith('直线行程为方案/系统估算值（待核验）：') && warning.includes(`${changed.station}·${changed.name} 40 mm`)));
      assert.ok(!geometry.warnings.some((warning) => warning.includes('工程师输入的直线行程尚待复核') && warning.includes(changed.name)));
    }
  }
});
