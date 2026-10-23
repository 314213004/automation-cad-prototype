import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { TEMPLATES, templateFor } from '../../src/machine/templates.ts';

const EXPECTED = {
  screw: {
    actuators: { rotary: 1, gripper: 1 },
    sensors: { proximity: 1 }
  },
  dispense: {
    actuators: { rotary: 1 },
    sensors: { pressure: 1 }
  },
  assembly: {
    actuators: { cylinder: 1, gripper: 1 },
    sensors: { proximity: 2 }
  },
  inspection: {
    actuators: { rotary: 1 },
    sensors: { photoelectric: 1, safety: 1 }
  },
  packaging: {
    actuators: { cylinder: 1, gripper: 1 },
    sensors: { photoelectric: 1 }
  }
};

function counts(entries) {
  const result = {};
  for (const entry of entries) result[entry.kind] = (result[entry.kind] ?? 0) + entry.count;
  return result;
}

test('TEMPLATES 直接导出 5 类工艺，且字段完整', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['assembly', 'dispense', 'inspection', 'packaging', 'screw']);
  for (const [key, template] of Object.entries(TEMPLATES)) {
    assert.equal(template.key, key);
    assert.equal(typeof template.label, 'string');
    assert.equal(template.stations, 2);
    assert.ok(Array.isArray(template.actuators) && template.actuators.length > 0);
    assert.ok(Array.isArray(template.sensors) && template.sensors.length > 0);
    assert.ok(Number.isFinite(template.cycleRange.minPerMin));
    assert.ok(template.cycleRange.maxPerMin > template.cycleRange.minPerMin);
    assert.ok(template.rationale.length >= 10);
  }
});

test('五类模板的每工位机构与传感器数量符合工艺约定', () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const template = TEMPLATES[key];
    assert.deepEqual(counts(template.actuators), expected.actuators, key);
    assert.deepEqual(counts(template.sensors), expected.sensors, key);
  }
});

test('未知工艺回落到通用模板，不进入 TEMPLATES 五类', () => {
  const generic = templateFor('unknown');
  assert.equal(generic.label, '通用');
  assert.equal(generic.stations, 2);
  assert.deepEqual(counts(generic.actuators), { cylinder: 1 });
  assert.deepEqual(counts(generic.sensors), { proximity: 1 });
});

test('synthMachine 缺执行机构时按模板补全并写入 assumptions', () => {
  const cases = [
    ['锁螺丝机', 'screw', '锁螺丝'],
    ['点胶机', 'dispense', '点胶'],
    ['装配线', 'assembly', '装配'],
    ['检测机', 'inspection', '检测'],
    ['包装机', 'packaging', '包装']
  ];
  for (const [text, key, label] of cases) {
    const design = synthMachine(parseMachineBrief(`两工位${text}，20 件/分钟`));
    assert.equal(design.config.stations.length, 2, text);
    assert.deepEqual(
      counts(design.config.actuators.map((actuator) => ({ kind: actuator.kind, count: 1 }))),
      Object.fromEntries(Object.entries(EXPECTED[key].actuators).map(([kind, count]) => [kind, count * 2])),
      text
    );
    assert.ok(design.assumptions.some((line) => line.includes(`按 ${label} 模板补全`)), text);
  }
});

test('未给工位时按模板默认 2 工位生成并说明', () => {
  const design = synthMachine(parseMachineBrief('设计一台锁螺丝机，20 件/分钟'));
  assert.equal(design.config.stations.length, 2);
  assert.ok(design.assumptions.some((line) => line.includes('工位数缺省为 2')));
});

test('模板节拍区间合法且五类都有覆盖', () => {
  const seen = new Set();
  for (const template of Object.values(TEMPLATES)) {
    const key = `${template.cycleRange.minPerMin}-${template.cycleRange.maxPerMin}`;
    seen.add(key);
    assert.ok(template.cycleRange.minPerMin > 0);
    assert.ok(template.cycleRange.maxPerMin <= 60);
  }
  assert.ok(seen.size >= 4);
});

test('模板标签与 rationale 可直接展示', () => {
  const labels = Object.values(TEMPLATES).map((template) => template.label);
  assert.deepEqual(labels.sort(), ['包装', '检测', '点胶', '装配', '锁螺丝'].sort());
  for (const template of Object.values(TEMPLATES)) {
    assert.match(template.rationale, /[。；]$/);
  }
});

test('包装模板严格为推料气缸 + 吸盘占位夹爪 + 光电', () => {
  const design = synthMachine(parseMachineBrief('两工位包装机，15 件/分钟'));
  assert.deepEqual(counts(design.config.actuators.map((actuator) => ({ kind: actuator.kind, count: 1 }))), { cylinder: 2, gripper: 2 });
  assert.deepEqual(counts(design.config.sensors.map((sensor) => ({
    kind: sensor.point.includes('-PHT-') ? 'photoelectric' : 'other',
    count: 1
  }))), { photoelectric: 2 });
});

test('显式执行机构优先于模板，不被模板覆盖', () => {
  const design = synthMachine(parseMachineBrief('两工位锁螺丝机，20 件/分钟，两个气缸'));
  assert.equal(design.config.actuators.length, 2);
  assert.ok(design.config.actuators.every((actuator) => actuator.kind === 'cylinder'));
  assert.equal(design.assumptions.some((line) => line.includes('执行机构，按')), false);
});
