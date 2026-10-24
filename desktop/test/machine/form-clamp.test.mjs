import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { TEMPLATES } from '../../src/machine/templates.ts';
import { MACHINE_FORMS, pickForm } from '../../src/machine/forms.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const MAX_FORM_STATIONS = Math.max(...MACHINE_FORMS.map((form) => form.stationRange[1]));
const here = dirname(fileURLToPath(import.meta.url));

function pick(text, options = {}) {
  return pickForm(parseMachineBrief(text), TEMPLATES, options);
}

function covers(form, stations) {
  return form.stationRange[0] <= stations && form.stationRange[1] >= stations;
}

test('12 工位转盘检测 60 件/分钟：选覆盖 12 的 dial-12，并按 12 工位判断不达标', () => {
  const result = pick('十二工位转盘检测机，节拍 60 件/分钟');
  assert.equal(result.form.id, 'dial-12');
  assert.equal(result.form.stationRange[0], 8);
  assert.equal(result.form.stationRange[1], 12);
  assert.equal(result.stations, 12);
  assert.equal(result.evaluation.stationSeconds.length, 12);
  assert.equal(result.evaluation.meetsTarget, false);
  assert.equal(result.evaluation.throughputPerMin < 60, true);
  assert.match(result.warning, /已选 十二工位转盘机 预估 22\.64 件\/分钟/);
  assert.match(result.warning, /缺口 37\.36 件\/分钟/);
  assert.doesNotMatch(result.warning, /无形态覆盖/);
});

test('12 工位检测的 meetsTarget 与夹紧后 12 工位预演结论一致', () => {
  const result = pick('十二工位转盘检测机，节拍 60 件/分钟');
  const expectedThroughput = 60 / (1.5 + 0.7 + 0.45);
  assert.ok(Math.abs(result.evaluation.throughputPerMin - expectedThroughput) < 1e-9);
  assert.equal(result.evaluation.meetsTarget, result.evaluation.throughputPerMin >= 60 - 1e-9);
});

test('12 工位长线装配 10 件/分钟：选覆盖 12 的 linear-12', () => {
  const result = pick('十二工位长线装配，10 件/分钟');
  assert.equal(result.form.id, 'linear-12');
  assert.equal(result.stations, 12);
  assert.equal(result.evaluation.stationSeconds.length, 12);
  assert.equal(result.evaluation.meetsTarget, true);
});

test('14 工位超出所有形态上限：选上限最大者并按 12 工位生成', () => {
  const result = pick('十四工位锁螺丝机，10 件/分钟', { stationCount: 14 });
  assert.equal(result.form.stationRange[1], MAX_FORM_STATIONS);
  assert.equal(result.stations, 12);
  assert.equal(result.evaluation.stationSeconds.length, 12);
  assert.match(result.warning, /无形态覆盖 14 工位/);
  assert.match(result.warning, /支持 8–12 工位/);
  assert.match(result.warning, /需求 14 工位/);
  assert.match(result.warning, /实际按 12 工位预演\/生成/);
});

test('6 工位矩阵：锁螺丝 / 检测转盘 / 装配长线均选覆盖 6 的形态', () => {
  for (const text of [
    '六工位锁螺丝机，20 件/分钟',
    '六工位转盘检测机，10 件/分钟',
    '六工位装配长线体，10 件/分钟'
  ]) {
    const result = pick(text);
    assert.ok(covers(result.form, 6), `${text} → ${result.form.id}`);
    assert.equal(result.stations, 6, text);
  }
});

test('8 工位矩阵：锁螺丝 / 检测 / 装配长线均选覆盖 8 的形态', () => {
  for (const text of [
    '八工位锁螺丝机，20 件/分钟',
    '八工位转盘检测机，10 件/分钟',
    '八工位装配长线体，10 件/分钟'
  ]) {
    const result = pick(text);
    assert.ok(covers(result.form, 8), `${text} → ${result.form.id}`);
    assert.equal(result.stations, 8, text);
  }
});

test('10 工位矩阵：锁螺丝 / 检测 / 装配长线均选覆盖 10 的形态', () => {
  for (const text of [
    '十工位锁螺丝机，20 件/分钟',
    '十工位转盘检测机，10 件/分钟',
    '十工位装配长线体，10 件/分钟'
  ]) {
    const result = pick(text);
    assert.ok(covers(result.form, 10), `${text} → ${result.form.id}`);
    assert.equal(result.stations, 10, text);
  }
});

test('6/8/10 工位所有常见工艺组合都不出现越界预览', () => {
  for (const stations of [6, 8, 10]) {
    for (const process of ['锁螺丝', '点胶', '装配', '检测', '包装']) {
      for (const layout of ['', '转盘', '流水线', '单元式']) {
        const text = `${stations} 工位${layout}${process}机，10 件/分钟`;
        const result = pick(text);
        assert.ok(covers(result.form, stations), `${text} → ${result.form.id}`);
        assert.equal(result.stations, stations, text);
      }
    }
  }
});

test('任何 1–12 工位需求下，选中形态上限都不小于生成工位数', () => {
  for (let stations = 1; stations <= 12; stations += 1) {
    for (const process of ['锁螺丝', '点胶', '装配', '检测', '包装']) {
      const result = pick(`${stations} 工位${process}机，10 件/分钟`);
      assert.ok(result.stations <= result.form.stationRange[1], `${stations} 工位 ${process}`);
      assert.ok(result.stations >= result.form.stationRange[0], `${stations} 工位 ${process}`);
    }
  }
});

test('synthMachine 的 config.stations.length 与夹紧后预演工位数一致', () => {
  for (let stations = 1; stations <= 12; stations += 1) {
    const design = synthMachine(parseMachineBrief(`${stations} 工位检测机，10 件/分钟`));
    const result = pick(`${stations} 工位检测机，10 件/分钟`);
    assert.equal(design.config.stations.length, result.stations, `${stations} 工位`);
    assert.ok(design.config.stations.length <= design.form.maxStations, `${stations} 工位`);
  }
});

test('12 工位检测生成 12 工位配置，不出现 4 工位形态承接 12 工位', () => {
  const brief = parseMachineBrief('十二工位转盘检测机，20 件/分钟');
  const design = synthMachine(brief);
  assert.equal(design.form.id, 'dial-12');
  assert.equal(design.config.stations.length, 12);
  assert.equal(design.config.stations.length, design.form.maxStations);
  assert.equal(design.cycle.mode, 'dial');
});

test('无覆盖时 pickForm.stations 夹紧到上限，且不会大于所选形态上限', () => {
  const result = pick('十四工位锁螺丝机，10 件/分钟', { stationCount: 14 });
  assert.equal(result.stations, Math.min(14, result.form.maxStations));
  assert.ok(result.stations <= result.form.maxStations);
});

test('夹紧后的预演产能不再是需求工位数放大后的虚高值', () => {
  const result = pick('十二工位转盘检测机，节拍 60 件/分钟');
  assert.ok(result.evaluation.throughputPerMin < 30);
  assert.equal(result.evaluation.stationSeconds.length, 12);
});

test('小形态不会按大需求虚高：gantry-4 的 12 工位预演最多只到 4 工位', () => {
  const result = pick('十二工位转盘检测机，节拍 60 件/分钟');
  const gantry = MACHINE_FORMS.find((form) => form.id === 'gantry-4');
  assert.ok(gantry);
  assert.equal(gantry.stationRange[1], 4);
  assert.notEqual(result.form.id, 'gantry-4');
  assert.ok(result.evaluation.throughputPerMin < 60);
});

test('有覆盖形态时不输出「无形态覆盖」warning', () => {
  for (const text of [
    '六工位锁螺丝机，20 件/分钟',
    '八工位锁螺丝机，20 件/分钟',
    '十二工位转盘检测机，60 件/分钟'
  ]) {
    const result = pick(text);
    assert.doesNotMatch(result.warning ?? '', /无形态覆盖/, text);
  }
});

test('无覆盖时才强制输出「无形态覆盖 N 工位」warning', () => {
  const result = pick('十四工位锁螺丝机，10 件/分钟', { stationCount: 14 });
  assert.match(result.warning, /无形态覆盖 14 工位/);
  assert.match(result.warning, /支持 8–12 工位/);
  assert.match(result.warning, /需求 14 工位/);
});

test('覆盖范围内的需求不会被夹紧：6/8/10/12 工位预演长度等于需求', () => {
  for (const stations of [6, 8, 10, 12]) {
    const result = pick(`${stations} 工位装配长线体，10 件/分钟`);
    assert.equal(result.stations, stations, `${stations} 工位`);
    assert.equal(result.evaluation.stationSeconds.length, stations, `${stations} 工位`);
    assert.ok(result.form.stationRange[0] <= stations && result.form.stationRange[1] >= stations);
  }
});

test('选型结果与 synthMachine 生成工位数在所有常见工位/工艺下一致且不超上限', () => {
  for (const stations of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
    for (const process of ['锁螺丝', '装配', '检测']) {
      const brief = parseMachineBrief(`${stations} 工位${process}机，10 件/分钟`);
      const result = pickForm(brief, TEMPLATES);
      const design = synthMachine(brief);
      assert.equal(design.config.stations.length, result.stations, `${stations}/${process}`);
      assert.equal(design.form.id, result.form.id, `${stations}/${process}`);
      assert.ok(design.config.stations.length <= design.form.maxStations, `${stations}/${process}`);
    }
  }
});

test('方案卡在缺价时显示「N 项缺价，合计为不完全统计」文案', () => {
  const ui = readFileSync(resolve(here, '..', '..', 'src', 'agent', 'ui.ts'), 'utf8');
  assert.match(ui, /项缺价，合计为不完全统计/);
  assert.match(ui, /missingCount !== null && missingCount > 0/);
});

test('解析器把 14 工位夹到 12 时，synthMachine 在 assumptions 写明实际生成工位数', () => {
  const design = synthMachine(parseMachineBrief('十四工位锁螺丝机，10 件/分钟'));
  assert.equal(design.config.stations.length, 12);
  assert.ok(design.assumptions.some((line) => /超出 1–12.*实际按 12 工位生成/.test(line)));
});
