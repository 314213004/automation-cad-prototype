import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { TEMPLATES } from '../../src/machine/templates.ts';
import { MACHINE_FORMS, pickForm } from '../../src/machine/forms.ts';
import { evaluateFlow } from '../../src/machine/flow.ts';

function pick(text, options = {}) {
  return pickForm(parseMachineBrief(text), TEMPLATES, options);
}

function assertSelectedMeets(result, label) {
  assert.equal(result.evaluation.meetsTarget, true, `${label}: ${result.form.id} 未达标`);
}

test('四工位锁螺丝 20 件/分钟：选中覆盖 4 工位且达标的 dual-lane', () => {
  const result = pick('四工位锁螺丝机，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.equal(result.form.layout, 'cell');
  assertSelectedMeets(result, '4/20');
});

test('六工位锁螺丝 20 件/分钟：选中覆盖 6 工位且达标的 dual-lane', () => {
  const result = pick('六工位锁螺丝机，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.equal(result.form.layout, 'cell');
  assertSelectedMeets(result, '6/20');
});

test('八工位锁螺丝 20 件/分钟：无覆盖达标形态时先取达标且工位最近的形态', () => {
  const result = pick('八工位锁螺丝机，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assertSelectedMeets(result, '8/20');
  assert.match(result.warning, /4–6 工位/);
  assert.match(result.warning, /8 工位/);
});

for (const stations of [4, 6, 8]) {
  for (const target of [10, 20, 40]) {
    test(`${stations} 工位 / ${target} 件/分钟组合必选达标形态`, () => {
      const result = pick(`${stations} 工位锁螺丝机，${target} 件/分钟`);
      assertSelectedMeets(result, `${stations}/${target}`);
    });
  }
}

test('布局偏好不是硬过滤：六工位转盘 20 件/分钟仍按产能选 dual-lane', () => {
  const result = pick('六工位转盘锁螺丝机，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.notEqual(result.form.layout, 'dial');
  assertSelectedMeets(result, 'dial-preference/20');
});

test('布局偏好只做 tie-breaker：六工位锁螺丝流水线 10 件/分钟同分优先 linear', () => {
  const result = pick('六工位锁螺丝流水线，10 件/分钟');
  assert.equal(result.form.id, 'linear-8');
  assert.equal(result.form.layout, 'linear');
  assertSelectedMeets(result, 'linear-preference/10');
});

test('工艺适配置于布局/占地之前：六工位检测 10 件/分钟选 dial-8 而非 dial-6', () => {
  const result = pick('六工位检测机，10 件/分钟');
  assert.equal(result.form.id, 'dial-8');
  assertSelectedMeets(result, 'inspection/10');
});

test('fallback 先取达标且工位最近：八工位 20 件/分钟不选更远的 gantry-2', () => {
  const result = pick('八工位锁螺丝机，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.notEqual(result.form.id, 'gantry-2');
});

test('fallback 在无覆盖达标形态时仍不会选不达标形态：十二工位 20 件/分钟', () => {
  const result = pick('十二工位锁螺丝流水线，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assertSelectedMeets(result, '12/20');
});

test('所有形态都不达标时 warning 写清目标、最佳形态实际产能与差值', () => {
  const result = pick('六工位锁螺丝机，120 件/分钟');
  assert.equal(result.evaluation.meetsTarget, false);
  assert.match(
    result.warning,
    /需要 120 件\/分钟，最佳形态 双工位龙门机 只能给 100\.00 件\/分钟，差 20\.00 件\/分钟/
  );
  assert.match(result.warning, /已选 六工位转盘机 预估 14\.29 件\/分钟/);
});

test('无达标形态且工位不覆盖时，warning 同时给出最佳产能与所选形态缺口', () => {
  const result = pick('一工位锁螺丝机，120 件/分钟');
  assert.equal(result.form.id, 'gantry-2');
  assert.equal(result.evaluation.meetsTarget, false);
  assert.match(result.warning, /需要 120 件\/分钟，最佳形态 双轨并行线 只能给 31\.75 件\/分钟/);
  assert.match(result.warning, /已选 双工位龙门机 预估 18\.87 件\/分钟/);
});

test('工位覆盖是硬约束：六工位 10 件/分钟不会因为 gantry-2 更小而被选中', () => {
  const result = pick('六工位锁螺丝机，10 件/分钟');
  assert.equal(result.form.id, 'dial-6');
  assert.ok(result.form.stationRange[0] <= 6 && result.form.stationRange[1] >= 6);
  assert.notEqual(result.form.id, 'gantry-2');
});

test('双轨 cell 可被显式单元式需求选中，并按两条轨道预演', () => {
  const result = pick('六工位单元式检测线，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.equal(result.form.layout, 'cell');
  assert.equal(result.evaluation.notes.some((note) => /2 条轨道并行/.test(note)), true);
});

test('cell 的 lanes 参数只缩放节拍，不改变单工位时间', () => {
  const base = {
    layout: 'cell',
    stations: 4,
    transferSeconds: 0.6,
    targetPerMin: 20,
    ops: [
      { id: 'a', name: '锁螺丝', seconds: 3.18, station: 0 },
      { id: 'b', name: '锁螺丝', seconds: 3.18, station: 1 },
      { id: 'c', name: '锁螺丝', seconds: 3.18, station: 2 },
      { id: 'd', name: '锁螺丝', seconds: 3.18, station: 3 }
    ]
  };
  const oneLane = evaluateFlow(base);
  const twoLanes = evaluateFlow({ ...base, lanes: 2 });
  assert.equal(twoLanes.stationSecondsMax, oneLane.stationSecondsMax);
  assert.ok(Math.abs(twoLanes.cycleSeconds * 2 - oneLane.cycleSeconds) < 1e-9);
  assert.equal(twoLanes.meetsTarget, true);
});

test('形态库仍为 6 种，排序修复不引入隐式形态', () => {
  assert.equal(MACHINE_FORMS.length, 6);
});
