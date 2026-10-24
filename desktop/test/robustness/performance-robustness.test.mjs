import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  clearGeometryCache,
  generateMachineGeometry,
  geometryCacheStats
} from '../../src/machine/geometry.ts';
import {
  applyAxisValue,
  buildThreeMachine,
  disposeThreeMachine
} from '../../src/machine/geometry-three.ts';
import { createScene3D } from '../../src/commission/scene3d.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import {
  BOM_MAX_ROWS,
  CAD_FILE_MAX_BYTES,
  STEP_MAX_BYTES,
  assertBomRowCount,
  assertCadFileSize
} from '../../src/shared/input-limits.ts';
import { CadViewer } from '../../src/cad/viewer.ts';
import { SimPlcAdapter } from '../../src/plc/sim.ts';
import { DemoFactoryAdapter } from '../../src/factory/demo.ts';
import {
  activeIntervalCount,
  activeTrackedTimers,
  trackedClearTimeout,
  trackedSetTimeout
} from '../../src/shared/resources.ts';

const design = synthMachine(parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟'));

function bareViewer() {
  const viewer = Object.create(CadViewer.prototype);
  viewer.draftBomRows = [];
  viewer.modelParts = [];
  viewer.parts = [];
  viewer.renderPartList = () => {};
  return viewer;
}

test('性能：几何缓存同一 config 命中并返回同一结果，内容相同的克隆也命中', () => {
  clearGeometryCache();
  const first = generateMachineGeometry(design);
  const before = geometryCacheStats();
  const second = generateMachineGeometry(design);
  const third = generateMachineGeometry(JSON.parse(JSON.stringify(design)));
  const after = geometryCacheStats();
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(after.misses, before.misses);
  assert.equal(after.hits, before.hits + 2);
  assert.ok(after.size >= 1);
});

test('性能：缓存键包含布局选项，不同布局不会错误命中', () => {
  clearGeometryCache();
  const linear = generateMachineGeometry(design, { layout: 'linear' });
  const dial = generateMachineGeometry(design, { layout: 'dial' });
  assert.notEqual(linear, dial);
  assert.equal(linear.layout, 'linear');
  assert.equal(dial.layout, 'dial');
  const stats = geometryCacheStats();
  assert.equal(stats.misses, 2);
});

test('性能：bypassCache 不读写缓存结果', () => {
  clearGeometryCache();
  const cached = generateMachineGeometry(design);
  const stats = geometryCacheStats();
  const bypass = generateMachineGeometry(design, { bypassCache: true });
  assert.notEqual(bypass, cached);
  assert.deepEqual(geometryCacheStats(), stats);
});

test('性能：相同形状共享 BufferGeometry，相同 role/color 共享材质', () => {
  const geometry = generateMachineGeometry(design);
  const machine = buildThreeMachine(geometry);
  const geometries = new Set();
  const materials = new Set();
  machine.root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) materials.add(node.material);
  });
  assert.ok(geometries.size < machine.meshCount);
  assert.ok(materials.size < machine.meshCount);
  disposeThreeMachine(machine);
});

test('性能：applyAxisValue 相同值不重复写变换，返回值可诊断', () => {
  const machine = buildThreeMachine(generateMachineGeometry(design));
  const node = [...machine.actuators.values()].find((entry) => entry.axis.kind === 'rotary');
  assert.ok(node);
  assert.equal(applyAxisValue(node, 0.4), true);
  assert.equal(applyAxisValue(node, 0.4), false);
  assert.equal(applyAxisValue(node, 0.8), true);
  disposeThreeMachine(machine);
});

test('性能：联调场景重复 update 不重复写未变化的执行机构变换', () => {
  let clock = 0;
  const scene = createScene3D({}, demoMachineConfig(), () => clock);
  const actuatorCount = scene.stats().actuators;
  const baseline = scene.stats().transformUpdates;
  const first = Object.fromEntries(
    demoMachineConfig().actuators
      .flatMap((actuator) => [actuator.extendPoint, actuator.gripPoint, actuator.point])
      .filter(Boolean)
      .map((point) => [String(point), true])
  );
  scene.update(first);
  const afterFirst = scene.stats().transformUpdates;
  scene.update(first);
  const afterSecond = scene.stats().transformUpdates;
  assert.ok(afterFirst >= baseline);
  assert.equal(afterSecond, afterFirst, '相同值不应再次写矩阵');
  assert.ok(actuatorCount > 0);
  scene.dispose();
});

test('资源：disposeThreeMachine 对共享几何/材质只释放一次并清空索引', () => {
  const machine = buildThreeMachine(generateMachineGeometry(design));
  const geometries = new Set();
  const materials = new Set();
  machine.root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) materials.add(node.material);
  });
  const disposed = new Map();
  for (const geometry of geometries) {
    geometry.dispose = () => disposed.set(geometry, (disposed.get(geometry) ?? 0) + 1);
  }
  for (const material of materials) {
    material.dispose = () => disposed.set(material, (disposed.get(material) ?? 0) + 1);
  }
  disposeThreeMachine(machine);
  for (const resource of [...geometries, ...materials]) assert.equal(disposed.get(resource), 1);
  assert.equal(machine.actuators.size, 0);
  assert.equal(machine.sensors.size, 0);
  assert.equal(machine.stationGroups.size, 0);
});

test('资源：PLC 仿真器连接/断开后显式定时器计数归零', async () => {
  const before = activeIntervalCount();
  const adapter = new SimPlcAdapter();
  await adapter.connect({
    kind: 'sim',
    points: [{ id: 'X0', name: 'X0', dataType: 'bool' }]
  });
  assert.equal(activeIntervalCount(), before + 1);
  await adapter.disconnect();
  assert.equal(activeIntervalCount(), before);
});

test('资源：工厂仿真器连接/断开后显式定时器计数归零', async () => {
  const before = activeIntervalCount();
  const adapter = new DemoFactoryAdapter();
  await adapter.connect({ kind: 'demo' });
  assert.equal(activeIntervalCount(), before + 1);
  await adapter.disconnect();
  assert.equal(activeIntervalCount(), before);
});

test('资源：tracked timeout 触发或清理后都不残留', async () => {
  const baseline = activeTrackedTimers();
  const fired = trackedSetTimeout(() => {}, 1);
  const cleared = trackedSetTimeout(() => {}, 10000);
  assert.equal(activeTrackedTimers(), baseline + 2);
  trackedClearTimeout(cleared);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(activeTrackedTimers(), baseline);
  assert.ok(fired);
});

test('大输入：STEP 200MB 边界允许，超过 1 字节拒绝并给拆分提示', () => {
  assert.doesNotThrow(() => assertCadFileSize('assembly.step', STEP_MAX_BYTES));
  assert.throws(
    () => assertCadFileSize('assembly.step', STEP_MAX_BYTES + 1),
    (error) => error.code === 'STEP_TOO_LARGE' && /200\.0 MB/.test(error.message) && /拆分/.test(error.message)
  );
});

test('大输入：非 STEP 文件 50MB 边界允许，超过拒绝', () => {
  assert.doesNotThrow(() => assertCadFileSize('part.stl', CAD_FILE_MAX_BYTES));
  assert.throws(
    () => assertCadFileSize('part.stl', CAD_FILE_MAX_BYTES + 1),
    (error) => error.code === 'FILE_TOO_LARGE' && /50\.0 MB/.test(error.message)
  );
});

test('大输入：BOM 5000 行允许，5001 行拒绝且错误码稳定', () => {
  assert.doesNotThrow(() => assertBomRowCount(BOM_MAX_ROWS));
  assert.throws(
    () => assertBomRowCount(BOM_MAX_ROWS, 1),
    (error) => error.code === 'BOM_TOO_MANY_ROWS' && /5001 行/.test(error.message)
  );
});

test('幂等：同一 BOM 批次重复追加返回 0，不产生重复行', () => {
  const viewer = bareViewer();
  const rows = [{ name: '伺服电机', spec: '750W', qty: 1, mat: '—', source: 'machine-design' }];
  assert.equal(viewer.appendDraftBomRows(rows, 'batch-a'), 1);
  assert.equal(viewer.appendDraftBomRows(rows, 'batch-a'), 0);
  assert.equal(viewer.getBomRows().length, 1);
});

test('大输入：渲染层追加 BOM 超过 5000 行被拒绝', () => {
  const viewer = bareViewer();
  viewer.modelParts = Array.from({ length: BOM_MAX_ROWS }, (_, index) => ({ name: `P${index}` }));
  assert.throws(
    () => viewer.appendDraftBomRows(
      [{ name: '多出的行', spec: 'X', qty: 1, mat: '—', source: 'machine-design' }],
      'batch-over-limit'
    ),
    /超过 5000 行上限/
  );
  assert.equal(viewer.getBomRows().length, BOM_MAX_ROWS);
});

test('诊断/崩溃源码目录不存在只注释吞异常的 catch', () => {
  for (const file of ['../../src/agent/audit.ts', '../../electron/parametric.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const matches = source.match(/catch(?:\s*\([^)]*\))?\s*\{\s*\/\/[^\n]*\s*\}/g) ?? [];
    assert.equal(matches.length, 0, file);
  }
});

test('资源：联调 3D 场景 dispose 清空索引且可重复调用', () => {
  const scene = createScene3D({}, demoMachineConfig(), () => 0);
  assert.ok(scene.stats().geometryParts > 0);
  scene.dispose();
  const stats = scene.stats();
  assert.equal(stats.geometryParts, 0);
  assert.equal(stats.sensors, 0);
  assert.equal(stats.actuators, 0);
  assert.equal(stats.webgl, false);
  assert.doesNotThrow(() => scene.dispose());
});
