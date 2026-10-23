import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChineseNumber, parseMachineBrief } from '../../src/machine/spec.ts';

test('中文数字：三/四/六/两/十二都能解析', () => {
  assert.equal(parseChineseNumber('三'), 3);
  assert.equal(parseChineseNumber('四'), 4);
  assert.equal(parseChineseNumber('六'), 6);
  assert.equal(parseChineseNumber('两'), 2);
  assert.equal(parseChineseNumber('十二'), 12);
  assert.equal(parseChineseNumber('二十'), 20);
  assert.equal(parseMachineBrief('设计一台三工位锁螺丝机').stations, 3);
  assert.equal(parseMachineBrief('四工位装配线').stations, 4);
  assert.equal(parseMachineBrief('六工位检测机').stations, 6);
});

test('节拍写法一：分钟 20 件', () => {
  assert.equal(parseMachineBrief('三工位，分钟 20 件').cyclePerMin, 20);
  assert.equal(parseMachineBrief('三工位，每分钟 20 件').cyclePerMin, 20);
});

test('节拍写法二：20 件/分钟', () => {
  assert.equal(parseMachineBrief('三工位，20 件/分钟').cyclePerMin, 20);
});

test('节拍写法三：3 秒一件换算为 20 件/分钟', () => {
  assert.equal(parseMachineBrief('三工位，3 秒一件').cyclePerMin, 20);
  assert.equal(parseMachineBrief('三工位，2 秒/件').cyclePerMin, 30);
});

test('节拍也接受 CT 写法', () => {
  assert.equal(parseMachineBrief('两工位 CT 4.5s').cyclePerMin, 13.333);
  assert.equal(parseMachineBrief('节拍 6 秒').cyclePerMin, 10);
});

test('工艺识别覆盖五类', () => {
  assert.equal(parseMachineBrief('设计锁螺丝机').process, 'screw');
  assert.equal(parseMachineBrief('做一台点胶机').process, 'dispense');
  assert.equal(parseMachineBrief('装配线').process, 'assembly');
  assert.equal(parseMachineBrief('视觉检测机').process, 'inspection');
  assert.equal(parseMachineBrief('自动包装线').process, 'packaging');
  assert.equal(parseMachineBrief('今天天气不错').process, 'unknown');
});

test('品牌词表：汇川/台达/西门子/正泰/欧姆龙', () => {
  assert.equal(parseMachineBrief('用汇川伺服').brand, '汇川');
  assert.equal(parseMachineBrief('台达方案').brand, '台达');
  assert.equal(parseMachineBrief('西门子 PLC').brand, '西门子');
  assert.equal(parseMachineBrief('正泰断路器').brand, '正泰');
  assert.equal(parseMachineBrief('欧姆龙光电').brand, '欧姆龙');
});

test('供电识别：220VAC / 380VAC / 24VDC', () => {
  assert.equal(parseMachineBrief('220V 供电').voltage, '220VAC');
  assert.equal(parseMachineBrief('三相 380V').voltage, '380VAC');
  assert.equal(parseMachineBrief('DC24 控制').voltage, '24VDC');
});

test('执行机构词：气缸/夹爪/旋转轴数量', () => {
  const brief = parseMachineBrief('三工位，两个气缸，1 个夹爪，旋转轴 2 个');
  assert.deepEqual(brief.actuators, [
    { kind: 'cylinder', count: 2 },
    { kind: 'gripper', count: 1 },
    { kind: 'rotary', count: 2 }
  ]);
});

test('伺服/步进：带数量时按旋转轴建模，仅给功率时写 notes', () => {
  const counted = parseMachineBrief('两工位，三台伺服，两个步进');
  assert.deepEqual(counted.actuators, [{ kind: 'rotary', count: 5 }]);
  assert.ok(counted.notes.some((note) => note.includes('伺服/步进')));

  const spec = parseMachineBrief('三工位，用 750W 伺服');
  assert.deepEqual(spec.actuators, []);
  assert.ok(spec.notes.some((note) => note.includes('750W')));

  const after = parseMachineBrief('伺服 750W');
  assert.deepEqual(after.actuators, []);
  assert.ok(after.notes.some((note) => note.includes('750W')));

  const mixed = parseMachineBrief('用两台 750W 伺服');
  assert.deepEqual(mixed.actuators, [{ kind: 'rotary', count: 2 }]);
  assert.ok(mixed.notes.some((note) => note.includes('2 台') && note.includes('750W')));
});

test('传感器词：接近/光电/安全光栅/压力', () => {
  const brief = parseMachineBrief('4 个接近开关，2 个光电，1 套安全光栅，压力传感器 3 个');
  assert.deepEqual(brief.sensors, [
    { kind: 'proximity', count: 4 },
    { kind: 'photoelectric', count: 2 },
    { kind: 'safety', count: 1 },
    { kind: 'pressure', count: 3 }
  ]);
});

test('缺省：工艺/工位/节拍分别写进 notes，不阻断', () => {
  const brief = parseMachineBrief('帮我设计一台机器');
  assert.equal(brief.process, 'unknown');
  assert.equal(brief.stations, 2);
  assert.equal(brief.cyclePerMin, null);
  assert.ok(brief.notes.some((note) => note.includes('未识别工艺')));
  assert.ok(brief.notes.some((note) => note.includes('未识别工位数')));
  assert.ok(brief.notes.some((note) => note.includes('未识别节拍')));
});

test('工位数超过 12 时截到 12 并记录 notes', () => {
  const brief = parseMachineBrief('十三工位，20 件/分钟');
  assert.equal(brief.stations, 12);
  assert.ok(brief.notes.some((note) => note.includes('超出 1–12')));
});

test('空文本返回全缺省 brief，不抛错', () => {
  const brief = parseMachineBrief('');
  assert.deepEqual(brief.actuators, []);
  assert.deepEqual(brief.sensors, []);
  assert.equal(brief.brand, null);
  assert.equal(brief.voltage, null);
  assert.ok(brief.notes.length >= 3);
});
