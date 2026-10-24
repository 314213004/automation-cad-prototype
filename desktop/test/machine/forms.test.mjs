import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { TEMPLATES } from '../../src/machine/templates.ts';
import {
  assertMachineFormConsistency,
  assertMachineFormsConsistent,
  deriveStationRange,
  MACHINE_FORMS,
  pickForm,
  preferredLayout,
  summarizeForm,
  validateMachineForm,
  validateMachineForms
} from '../../src/machine/forms.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import { AgentTools } from '../../src/agent/tools.ts';

const FLOW_LAYOUTS = new Set(['single', 'linear', 'dial', 'parallel', 'cell']);
const PROCESSES = new Set(['screw', 'dispense', 'assembly', 'inspection', 'packaging', 'unknown']);

function pick(text, options = {}) {
  return pickForm(parseMachineBrief(text), TEMPLATES, options);
}

test('形态库恰好 11 种，id 唯一且字段合法', () => {
  assert.equal(MACHINE_FORMS.length, 11);
  assert.equal(new Set(MACHINE_FORMS.map((form) => form.id)).size, 11);
  assert.deepEqual(validateMachineForms(), []);
});

test('11 种形态的 layout 都与 flow.ts 对齐', () => {
  for (const form of MACHINE_FORMS) {
    assert.ok(FLOW_LAYOUTS.has(form.layout), form.id);
  }
});

test('11 种形态的 stationRange 都是 1–12 内自洽整数区间', () => {
  for (const form of MACHINE_FORMS) {
    const [min, max] = form.stationRange;
    assert.ok(Number.isInteger(min) && Number.isInteger(max), form.id);
    assert.ok(min >= 1 && max <= 12 && min <= max, form.id);
  }
});

test('11 种形态的占地系数、工艺适配与理由都不为空', () => {
  for (const form of MACHINE_FORMS) {
    assert.ok(form.footprintScale > 0, form.id);
    assert.ok(form.suits.length > 0, form.id);
    assert.ok(form.suits.every((process) => PROCESSES.has(process)), form.id);
    assert.ok(form.rationale.trim().length > 0, form.id);
  }
});

test('dial 形态有正分度时间，linear/dual 有非负转移时间', () => {
  for (const form of MACHINE_FORMS.filter((entry) => entry.layout === 'dial')) {
    assert.ok(form.indexSeconds > 0, form.id);
  }
  for (const id of ['linear-8', 'linear-12', 'dual-lane', 'cell-4', 'gantry-4', 'hybrid-dial-linear']) {
    const form = MACHINE_FORMS.find((entry) => entry.id === id);
    assert.ok(form);
    assert.ok(form.transferSeconds >= 0, id);
  }
});

test('geometry.kind 与 layout 映射正确', () => {
  const expected = {
    'dial-6': 'dial',
    'dial-8': 'dial',
    'linear-4': 'linear',
    'linear-8': 'linear',
    'gantry-2': 'gantry',
    'dual-lane': 'dual',
    'gantry-4': 'gantry',
    'hybrid-dial-linear': 'hybrid',
    'cell-4': 'cell',
    'linear-12': 'linear',
    'dial-12': 'dial'
  };
  for (const form of MACHINE_FORMS) assert.equal(form.geometry.kind, expected[form.id], form.id);
});

test('validateMachineForm 拒绝倒置的 stationRange', () => {
  const form = { ...MACHINE_FORMS[0], stationRange: [8, 2] };
  assert.ok(validateMachineForm(form).some((error) => /min 不能大于 max/.test(error)));
});

test('validateMachineForm 拒绝重复 id 的整组形态', () => {
  const forms = MACHINE_FORMS.map((form, index) => index === 1 ? { ...form, id: MACHINE_FORMS[0].id } : form);
  assert.ok(validateMachineForms(forms).some((error) => /id 重复/.test(error)));
});

test('validateMachineForm 拒绝 dial 布局配 linear 几何', () => {
  const form = { ...MACHINE_FORMS[0], geometry: { kind: 'linear' } };
  assert.ok(validateMachineForm(form).some((error) => /dial 布局必须使用 dial 几何/.test(error)));
});

test('六工位转盘锁螺丝 → dial-6', () => {
  const result = pick('六工位转盘锁螺丝机，10 件/分钟');
  assert.equal(result.form.id, 'dial-6');
  assert.equal(result.form.layout, 'dial');
});

test('六工位转盘检测 → dial-8', () => {
  const result = pick('六工位转盘检测机，10 件/分钟');
  assert.equal(result.form.id, 'dial-8');
});

test('四工位装配流水线 → linear-4', () => {
  const result = pick('四工位装配流水线，10 件/分钟');
  assert.equal(result.form.id, 'linear-4');
  assert.equal(result.form.layout, 'linear');
});

test('八工位装配线体 → linear-8', () => {
  const result = pick('八工位装配线体，10 件/分钟');
  assert.equal(result.form.id, 'linear-8');
});

test('两工位点胶 → gantry-2', () => {
  const result = pick('两工位点胶机，18 件/分钟');
  assert.equal(result.form.id, 'gantry-2');
  assert.equal(result.form.layout, 'parallel');
});

test('六工位单元式检测线 → 转盘+直线混合线', () => {
  const result = pick('六工位单元式检测线，20 件/分钟');
  assert.equal(result.form.id, 'hybrid-dial-linear');
  assert.equal(result.form.layout, 'cell');
  assert.equal(result.form.geometry.kind, 'hybrid');
});

test('工位超范围但有达标形态时优先取达标且工位最近的形态', () => {
  const result = pick('十二工位锁螺丝流水线，20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.equal(result.evaluation.meetsTarget, true);
  assert.ok(result.warning);
  assert.match(result.warning, /12 工位/);
  assert.match(result.warning, /4–6 工位/);
});

test('节拍不达标时不硬凑达标，warning 给出产能缺口', () => {
  const result = pick('一工位锁螺丝机，120 件/分钟');
  assert.equal(result.form.id, 'gantry-2');
  assert.equal(result.evaluation.meetsTarget, false);
  assert.ok(result.warning);
  assert.match(result.warning, /缺口 \d+\.\d+ 件\/分钟/);
  assert.match(result.warning, /需要 120 件\/分钟，最佳形态 .* 只能给 \d+\.\d{2} 件\/分钟，差 \d+\.\d{2} 件\/分钟/);
});

test('达标候选存在时优先达标形态并写入 evaluation', () => {
  const result = pick('六工位转盘锁螺丝机，10 件/分钟');
  assert.equal(result.evaluation.meetsTarget, true);
  assert.ok(result.evaluation.throughputPerMin >= 10);
});

test('alternatives 恒为 2 个且不重复当前形态', () => {
  for (const text of [
    '六工位转盘锁螺丝机，10 件/分钟',
    '四工位装配流水线，10 件/分钟',
    '两工位点胶机，18 件/分钟',
    '六工位单元式检测线，20 件/分钟'
  ]) {
    const result = pick(text);
    assert.equal(result.alternatives.length, 2, text);
    assert.equal(new Set(result.alternatives.map((entry) => entry.form.id)).size, 2, text);
    assert.ok(result.alternatives.every((entry) => entry.form.id !== result.form.id), text);
  }
});

test('alternatives 差异文案同时覆盖占地、成本与换型', () => {
  const result = pick('六工位转盘锁螺丝机，10 件/分钟');
  for (const alternative of result.alternatives) {
    assert.match(alternative.difference, /占地/);
    assert.match(alternative.difference, /成本/);
    assert.match(alternative.difference, /换型/);
  }
});

test('summarizeForm 保留 id/name/rationale 与两条备选', () => {
  const summary = summarizeForm(pick('六工位转盘锁螺丝机，10 件/分钟'));
  assert.equal(summary.id, 'dial-6');
  assert.ok(summary.name);
  assert.ok(summary.rationale);
  assert.equal(summary.alternatives.length, 2);
  assert.ok(summary.alternatives.every((entry) => entry.id && entry.name && entry.difference));
});

test('synthMachine 的 cycle.mode 跟随 form.layout，并把形态写入 assumptions', () => {
  const design = synthMachine(parseMachineBrief('六工位转盘锁螺丝机，10 件/分钟'));
  assert.equal(design.form.id, 'dial-6');
  assert.equal(design.cycle.mode, 'dial');
  assert.ok(design.assumptions.some((line) => line.includes('整机形态：六工位转盘机')));
});

test('几何 layout 由 form.geometry 覆盖 chooseLayout 默认猜测（dial/gantry/hybrid/cell）', () => {
  const dial = synthMachine(parseMachineBrief('六工位转盘锁螺丝机，10 件/分钟'));
  assert.equal(generateMachineGeometry(dial).layout, 'dial');
  const gantry = synthMachine(parseMachineBrief('两工位点胶机，18 件/分钟'));
  assert.equal(gantry.form.id, 'gantry-2');
  assert.equal(generateMachineGeometry(gantry).layout, 'gantry');
  const dual = synthMachine(parseMachineBrief('六工位单元式检测线，20 件/分钟'));
  assert.equal(dual.form.id, 'hybrid-dial-linear');
  assert.equal(generateMachineGeometry(dual).layout, 'hybrid');
  const cell = synthMachine(parseMachineBrief('四工位单元式小件装配机，20 件/分钟'));
  assert.equal(cell.form.id, 'cell-4');
  assert.equal(generateMachineGeometry(cell).layout, 'cell');
});

test('preferredLayout 对显式关键词保持可解释', () => {
  assert.equal(preferredLayout(parseMachineBrief('三工位锁螺丝流水线')), 'linear');
  assert.equal(preferredLayout(parseMachineBrief('三工位转盘锁螺丝机')), 'dial');
  assert.equal(preferredLayout(parseMachineBrief('三工位单元式锁螺丝机')), 'cell');
  assert.equal(preferredLayout(parseMachineBrief('三工位锁螺丝机')), 'parallel');
});

test('design_machine 返回 form.id/name/rationale/alternatives', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', {
    brief: '六工位转盘锁螺丝机，10 件/分钟'
  });
  assert.equal(result.ok, true);
  assert.equal(result.design.form.id, 'dial-6');
  assert.equal(typeof result.design.form.name, 'string');
  assert.equal(typeof result.design.form.rationale, 'string');
  assert.equal(result.design.form.alternatives.length, 2);
  assert.equal(result.geometry.layout, 'dial');
});

function formById(id) {
  const form = MACHINE_FORMS.find((entry) => entry.id === id);
  assert.ok(form, id);
  return form;
}

test('gantry-2 工位区间 [1,2]，推荐 2，硬上限 2', () => {
  const form = formById('gantry-2');
  assert.deepEqual(form.stationRange, [1, 2]);
  assert.equal(form.defaultStations, 2);
  assert.equal(form.maxStations, 2);
});

test('dial-6 工位区间 [2,6]，推荐 6，硬上限 6', () => {
  const form = formById('dial-6');
  assert.deepEqual(form.stationRange, [2, 6]);
  assert.equal(form.defaultStations, 6);
  assert.equal(form.maxStations, 6);
});

test('dial-8 工位区间 [6,8]，推荐 8，硬上限 8', () => {
  const form = formById('dial-8');
  assert.deepEqual(form.stationRange, [6, 8]);
  assert.equal(form.defaultStations, 8);
  assert.equal(form.maxStations, 8);
});

test('linear-4 工位区间 [2,4]，推荐 4，硬上限 4', () => {
  const form = formById('linear-4');
  assert.deepEqual(form.stationRange, [2, 4]);
  assert.equal(form.defaultStations, 4);
  assert.equal(form.maxStations, 4);
});

test('linear-8 工位区间 [5,8]，推荐 8，硬上限 8', () => {
  const form = formById('linear-8');
  assert.deepEqual(form.stationRange, [5, 8]);
  assert.equal(form.defaultStations, 8);
  assert.equal(form.maxStations, 8);
});

test('dual-lane 工位区间 [4,6]，推荐 6，硬上限 6', () => {
  const form = formById('dual-lane');
  assert.deepEqual(form.stationRange, [4, 6]);
  assert.equal(form.defaultStations, 6);
  assert.equal(form.maxStations, 6);
});

test('11 种形态的 defaultStations 都在区间内，maxStations 等于区间上限', () => {
  assert.doesNotThrow(() => assertMachineFormsConsistent());
  for (const form of MACHINE_FORMS) {
    assert.ok(form.stationRange[0] <= form.defaultStations, form.id);
    assert.ok(form.defaultStations <= form.stationRange[1], form.id);
    assert.equal(form.maxStations, form.stationRange[1], form.id);
  }
  assert.deepEqual(deriveStationRange(2, 6), [2, 6]);
});

test('运行时自检拒绝越界 defaultStations 与不一致 maxStations', () => {
  assert.throws(
    () => assertMachineFormConsistency({ ...formById('dial-6'), defaultStations: 7 }),
    /defaultStations 必须落在 stationRange 2–6 内/
  );
  assert.throws(
    () => assertMachineFormConsistency({ ...formById('dial-6'), maxStations: 8 }),
    /maxStations 必须等于 stationRange 上限 6/
  );
});

test('三工位点胶 brief 选到覆盖 3 工位的形态，且不是 gantry-2', () => {
  const result = pick('三工位点胶机，节拍 15 件/分钟');
  assert.ok(result.form.stationRange[0] <= 3 && result.form.stationRange[1] >= 3);
  assert.notEqual(result.form.id, 'gantry-2');
  assert.equal(result.form.id, 'dial-6');
});

test('四工位装配线 brief 选到覆盖 4 工位的形态，且不是 gantry-2', () => {
  const result = pick('四工位装配线，节拍 12 件/分钟');
  assert.ok(result.form.stationRange[0] <= 4 && result.form.stationRange[1] >= 4);
  assert.notEqual(result.form.id, 'gantry-2');
  assert.equal(result.form.id, 'linear-4');
});

test('五工位装配线 brief 选到覆盖 5 工位的形态，且不是 gantry-2', () => {
  const result = pick('五工位装配线，节拍 12 件/分钟');
  assert.ok(result.form.stationRange[0] <= 5 && result.form.stationRange[1] >= 5);
  assert.notEqual(result.form.id, 'gantry-2');
  assert.equal(result.form.id, 'linear-8');
});

test('六工位锁螺丝 brief 选到覆盖 6 工位的形态，且不是 gantry-2', () => {
  const result = pick('六工位锁螺丝机，节拍 20 件/分钟');
  assert.ok(result.form.stationRange[0] <= 6 && result.form.stationRange[1] >= 6);
  assert.ok(['dial-6', 'dual-lane'].includes(result.form.id));
  assert.notEqual(result.form.id, 'gantry-2');
});

test('八工位装配线体 brief 选到覆盖 8 工位的形态，且不是 gantry-2', () => {
  const result = pick('八工位装配线体，节拍 12 件/分钟');
  assert.ok(result.form.stationRange[0] <= 8 && result.form.stationRange[1] >= 8);
  assert.notEqual(result.form.id, 'gantry-2');
  assert.equal(result.form.id, 'linear-8');
});

test('gantry-2 永不被选给 3–12 工位需求', () => {
  for (let stations = 3; stations <= 12; stations += 1) {
    const result = pick(`${stations} 工位锁螺丝机，节拍 10 件/分钟`);
    assert.notEqual(result.form.id, 'gantry-2', `${stations} 工位`);
    assert.ok(result.form.stationRange[1] >= 2, `${stations} 工位`);
  }
});

test('无覆盖但有达标形态时 warning 写明实际范围、需求值与生成依据', () => {
  const result = pick('十二工位锁螺丝流水线，节拍 20 件/分钟');
  assert.equal(result.form.id, 'dual-lane');
  assert.ok(result.warning);
  assert.match(result.warning, /该形态支持 4–6 工位/);
  assert.match(result.warning, /需求 12 工位/);
  assert.match(result.warning, /已按 4\/6 生成/);
  assert.match(result.warning, /请确认是否需要非标设计/);
});

test('design_machine 返回的 form 含一致性字段', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', { brief: '六工位锁螺丝机，节拍 10 件/分钟' });
  assert.equal(result.ok, true);
  const form = result.design.form;
  assert.equal(form.id, 'dial-6');
  assert.equal(typeof form.name, 'string');
  assert.equal(form.layout, 'dial');
  assert.deepEqual(form.stationRange, [2, 6]);
  assert.equal(form.defaultStations, 6);
  assert.equal(typeof form.rationale, 'string');
  assert.equal(form.alternatives.length, 2);
});
