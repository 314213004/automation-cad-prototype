import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { POWER_VA, summarizeMachineDesign, synthMachine } from '../../src/machine/synth.ts';
import { validateMachineConfig } from '../../src/commission/machine-config.ts';

function basicBrief(text = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服') {
  return parseMachineBrief(text);
}

function sensorKind(point) {
  if (point.includes('-SAFE-')) return 'safety';
  if (point.includes('-PRS-')) return 'pressure';
  if (point.includes('-PHT-')) return 'photoelectric';
  return 'proximity';
}

test('三工位锁螺丝机：6 执行机构、3 传感器、1 条瓶颈警告', () => {
  const design = synthMachine(basicBrief(), { stationCount: 3 });
  assert.equal(design.config.stations.length, 3);
  assert.equal(design.config.actuators.length, 6);
  assert.equal(design.config.sensors.length, 3);
  assert.equal(design.warnings.length, 1);
  assert.match(design.warnings[0], /节拍瓶颈/);
  assert.match(design.warnings[0], /并行工位/);
});

test('工位均分：每个工位至少 1 个动作、至少 1 个检测', () => {
  const design = synthMachine(basicBrief());
  for (const station of design.config.stations) {
    assert.ok(design.config.actuators.some((actuator) => actuator.station === station), station);
    assert.ok(design.config.sensors.some((sensor) => sensor.station === station), station);
  }
  const perStation = new Map();
  for (const actuator of design.config.actuators) {
    perStation.set(actuator.station, (perStation.get(actuator.station) ?? 0) + 1);
  }
  assert.deepEqual([...perStation.values()], [2, 2, 2]);
});

test('点位命名符合 STn-EXT-Ax 约定且全部唯一', () => {
  const design = synthMachine(basicBrief());
  assert.equal(design.points.length, new Set(design.points).size);
  assert.ok(design.points.includes('ST1-EXT-A1') === false);
  assert.ok(design.points.includes('ST1-ROT-A1'));
  assert.ok(design.points.includes('ST1-GRIP-A2'));
  assert.ok(design.points.some((point) => /^ST1-PRX-S1$/.test(point)));
  const allConfigPoints = design.config.actuators.flatMap((actuator) =>
    [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point].filter(Boolean)
  );
  for (const point of allConfigPoints) assert.ok(design.points.includes(point), point);
  for (const sensor of design.config.sensors) assert.ok(design.points.includes(sensor.point), sensor.point);
});

test('节拍换算：20 件/分钟 = 3 秒/件，CT 6 秒 = 10 件/分钟', () => {
  const first = synthMachine(basicBrief());
  assert.equal(first.cycle.perMin, 20);
  assert.equal(first.cycle.secondsPerPiece, 3);
  const second = synthMachine(parseMachineBrief('两工位点胶机，CT 6 秒'));
  assert.equal(second.cycle.perMin, 10);
  assert.equal(second.cycle.secondsPerPiece, 6);
});

test('单工位动作时间超过节拍时给出所需并行工位数', () => {
  const design = synthMachine(parseMachineBrief('一工位锁螺丝机，120 件/分钟，两个旋转轴'));
  assert.ok(design.warnings.some((warning) => /超过目标/.test(warning)));
  assert.ok(design.warnings.some((warning) => /并行工位/.test(warning)));
});

test('缺省工艺/工位/节拍：warnings 明确指出用了哪个缺省值', () => {
  const design = synthMachine(parseMachineBrief('帮我设计一台机器'));
  assert.ok(design.warnings.some((warning) => warning.includes('未识别工艺')));
  assert.ok(design.warnings.some((warning) => warning.includes('缺省值 2 工位')));
  assert.ok(design.warnings.some((warning) => warning.includes('缺省值 10 件/分钟')));
});

test('无效或超范围工位数会保留解析提示并进入 warnings', () => {
  for (const text of ['0 工位锁螺丝机，10 件/分钟', '13 工位锁螺丝机，10 件/分钟']) {
    const design = synthMachine(parseMachineBrief(text));
    assert.ok(design.warnings.some((warning) => /工位数.*(?:无效|超出)/.test(warning)), text);
  }
});

test('功率按固定表求和，且假设声明为估算', () => {
  const brief = parseMachineBrief('两工位，两个气缸，1 个夹爪，1 个旋转轴，3 个接近开关，1 套安全光栅');
  const design = synthMachine(brief, { cyclePerMin: 10 });
  const expected =
    2 * POWER_VA.cylinder +
    1 * POWER_VA.gripper +
    1 * POWER_VA.rotary +
    3 * POWER_VA.sensor +
    1 * POWER_VA.safety;
  assert.equal(design.power.va, expected);
  assert.equal(design.power.byGroup.reduce((sum, group) => sum + group.va, 0), expected);
  assert.ok(design.assumptions.some((line) => line.includes('固定估算表')));
  assert.ok(design.assumptions.some((line) => line.includes('粗略估算')));
});

test('伺服功率按 750 VA/轴计入，不再重复计旋转轴 200 VA', () => {
  const design = synthMachine(basicBrief());
  assert.deepEqual(design.power.byGroup.find((group) => group.name === '伺服'), { name: '伺服', va: 3 * POWER_VA.servo });
  assert.equal(design.power.byGroup.some((group) => group.name === '旋转轴'), false);
});

test('BOM 草案按执行机构/传感器/电气分组并带数量', () => {
  const design = synthMachine(basicBrief());
  assert.ok(design.bomDraft.items.length >= 5);
  assert.ok(design.bomDraft.items.some((item) => item.kind === 'actuator' && item.name === '旋转轴' && item.qty === 3));
  assert.ok(design.bomDraft.items.some((item) => item.kind === 'sensor' && item.name === '接近开关' && item.qty === 3));
  assert.ok(design.bomDraft.items.some((item) => item.kind === 'electrical'));
  for (const item of design.bomDraft.items) assert.ok(item.qty > 0, item.name);
});

test('显式执行机构数量不足时补齐并警告', () => {
  const brief = parseMachineBrief('三工位，1 个气缸，1 个接近开关');
  const design = synthMachine(brief, { cyclePerMin: 10 });
  assert.equal(design.config.actuators.length, 3);
  assert.ok(design.warnings.some((warning) => warning.includes('执行机构数量不足')));
  assert.ok(design.warnings.some((warning) => warning.includes('传感器数量不足')));
});

test('工位数超出 1–12 时 synthMachine 抛出中文错误', () => {
  const brief = basicBrief();
  assert.throws(() => synthMachine(brief, { stationCount: 0 }), /1–12/);
  assert.throws(() => synthMachine(brief, { stationCount: 13 }), /1–12/);
  assert.throws(() => synthMachine(brief, { stationCount: 2.5 }), /1–12/);
});

test('节拍非正数时抛出中文错误', () => {
  assert.throws(() => synthMachine(basicBrief(), { cyclePerMin: 0 }), /节拍必须大于 0/);
  assert.throws(() => synthMachine(basicBrief(), { cyclePerMin: Number.NaN }), /节拍必须大于 0/);
});

test('生成的 config 能通过 validateMachineConfig，且 id 稳定', () => {
  const first = synthMachine(basicBrief());
  const second = synthMachine(basicBrief());
  assert.doesNotThrow(() => validateMachineConfig(first.config));
  assert.equal(first.config.id, second.config.id);
  assert.equal(first.config.stations.length, 3);
  assert.equal(new Set(first.config.actuators.map((actuator) => actuator.id)).size, first.config.actuators.length);
});

test('摘要 ≤600 字且包含工位/机构/传感器/节拍/功率/风险', () => {
  const design = synthMachine(basicBrief());
  const summary = summarizeMachineDesign(design);
  assert.ok(summary.length <= 600, `length=${summary.length}`);
  assert.match(summary, /工位：3/);
  assert.match(summary, /执行机构：6/);
  assert.match(summary, /传感器：3/);
  assert.match(summary, /20 件\/分钟/);
  assert.match(summary, /功率：约 \d+ VA/);
  assert.match(summary, /风险：/);
});

test('传感器类型按点位编码统计（配置本身不存 kind）', () => {
  const design = synthMachine(basicBrief());
  const kinds = design.config.sensors.map((sensor) => sensorKind(sensor.point));
  assert.equal(kinds.filter((kind) => kind === 'proximity').length, 3);
  assert.equal(kinds.filter((kind) => kind === 'pressure').length, 0);
});
