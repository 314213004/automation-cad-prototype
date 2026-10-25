import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { TEMPLATES } from '../../src/machine/templates.ts';
import {
  assertMachineFormConsistency,
  MACHINE_FORMS,
  pickForm,
  validateMachineForm,
  validateMachineForms
} from '../../src/machine/forms.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { chooseLayout, generateMachineGeometry } from '../../src/machine/geometry.ts';

const NEW_FORMS = ['gantry-4', 'hybrid-dial-linear', 'cell-4', 'linear-12', 'dial-12'];

function formById(id) {
  const form = MACHINE_FORMS.find((entry) => entry.id === id);
  assert.ok(form, id);
  return form;
}

function pick(text, options = {}) {
  return pickForm(parseMachineBrief(text), TEMPLATES, options);
}

function design(text, options = {}) {
  return synthMachine(parseMachineBrief(text), options);
}

function geometryFor(text) {
  return generateMachineGeometry(design(text), { bypassCache: true });
}

function partById(geometry, id) {
  const part = geometry.parts.find((entry) => entry.id === id);
  assert.ok(part, id);
  return part;
}

function dialDiameter(geometry) {
  const plate = partById(geometry, 'dial-plate');
  assert.equal(plate.shape.type, 'cylinder');
  return plate.shape.radius * 2;
}

test('新增 5 种形态字段齐全：suits / rationale / footprintScale / 时间 / geometry', () => {
  for (const id of NEW_FORMS) {
    const form = formById(id);
    assert.ok(form.suits.length > 0, id);
    assert.ok(form.rationale.length >= 20, id);
    assert.ok(form.footprintScale > 0, id);
    assert.ok(form.geometry && typeof form.geometry.kind === 'string', id);
    assert.ok(Number.isFinite(form.indexSeconds ?? form.transferSeconds ?? 0), id);
  }
});

test('新增 5 种形态的 stationRange / default / max 自洽', () => {
  for (const id of NEW_FORMS) {
    const form = formById(id);
    const [min, max] = form.stationRange;
    assert.ok(Number.isInteger(min) && Number.isInteger(max) && min <= max, id);
    assert.ok(form.defaultStations >= min && form.defaultStations <= max, id);
    assert.equal(form.maxStations, max, id);
  }
});

test('新增 5 种形态均为合法形态，整库 12 种通过校验', () => {
  assert.equal(MACHINE_FORMS.length, 12);
  assert.deepEqual(validateMachineForms(), []);
  for (const id of NEW_FORMS) assert.deepEqual(validateMachineForm(formById(id)), [], id);
  for (const form of MACHINE_FORMS) assert.doesNotThrow(() => assertMachineFormConsistency(form));
});

test('新增 5 种形态的 geometry.kind 与声明一致', () => {
  const expected = {
    'gantry-4': 'gantry',
    'hybrid-dial-linear': 'hybrid',
    'cell-4': 'cell',
    'linear-12': 'linear',
    'dial-12': 'dial'
  };
  for (const [id, kind] of Object.entries(expected)) assert.equal(formById(id).geometry.kind, kind, id);
});

test('range 自检拒绝新增形态的越界推荐工位与非整数工位', () => {
  const linear = formById('linear-12');
  assert.ok(validateMachineForm({ ...linear, defaultStations: 7 }).some((error) => /defaultStations/.test(error)));
  assert.ok(validateMachineForm({ ...linear, stationRange: [8, 12.5] }).some((error) => /整数/.test(error)));
  assert.throws(() => assertMachineFormConsistency({ ...linear, defaultStations: 13 }), /defaultStations/);
});

test('gantry-4 声明 4 个独立龙门头', () => {
  const form = formById('gantry-4');
  assert.equal(form.geometry.kind, 'gantry');
  assert.equal(form.geometry.heads, 4);
  assert.equal(form.layout, 'parallel');
});

test('hybrid-dial-linear 声明转盘 4 + 直线 2', () => {
  const form = formById('hybrid-dial-linear');
  assert.equal(form.geometry.dialStations, 4);
  assert.equal(form.geometry.linearStations, 2);
  assert.equal(form.geometry.dialStations + form.geometry.linearStations, 6);
});

test('cell-4 声明 2×2 矩阵与组间并行', () => {
  const form = formById('cell-4');
  assert.equal(form.geometry.rows, 2);
  assert.equal(form.geometry.cols, 2);
  assert.equal(form.geometry.lanes, 2);
});

test('chooseLayout 行为保持不变（新增 kind 不改变默认推断）', () => {
  assert.equal(chooseLayout('screw', 1), 'single');
  assert.equal(chooseLayout('screw', 8), 'dial');
  assert.equal(chooseLayout('screw', 9), 'linear');
  assert.equal(chooseLayout('inspection', 3), 'linear');
  assert.equal(chooseLayout('assembly', 12), 'linear');
});

test('12 工位转盘直径大于 4 工位，且直径随工位数单调增长', () => {
  const four = generateMachineGeometry(design('四工位转盘锁螺丝机，10 件/分钟'), { bypassCache: true });
  const eight = generateMachineGeometry(design('八工位锁螺丝机，10 件/分钟'), { layout: 'dial', bypassCache: true });
  const ten = generateMachineGeometry(design('十工位锁螺丝机，10 件/分钟'), { layout: 'dial', bypassCache: true });
  const twelve = generateMachineGeometry(design('十二工位锁螺丝机，10 件/分钟'), { layout: 'dial', bypassCache: true });
  assert.equal(four.layout, 'dial');
  assert.ok(dialDiameter(twelve) > dialDiameter(four));
  assert.ok(dialDiameter(eight) < dialDiameter(ten));
  assert.ok(dialDiameter(ten) < dialDiameter(twelve));
});

test('gantry-4 生成 4 组龙门头（立柱/横梁/滑台），按 2×2 排布且各有工位', () => {
  const geometry = geometryFor('四工位大件双龙门点胶机，20 件/分钟');
  assert.equal(geometry.layout, 'gantry');
  const beams = geometry.parts.filter((part) => /^gantry-head-\d+-beam$/.test(part.id));
  const uprights = geometry.parts.filter((part) => /^gantry-head-\d+-upright-[lr]$/.test(part.id));
  const carriages = geometry.parts.filter((part) => /^gantry-head-\d+-carriage$/.test(part.id));
  assert.equal(beams.length, 4);
  assert.equal(uprights.length, 8);
  assert.equal(carriages.length, 4);
  const xs = new Set(geometry.stations.map((station) => Math.round(station.origin[0])));
  const ys = new Set(geometry.stations.map((station) => Math.round(station.origin[1])));
  assert.equal(xs.size, 2);
  assert.equal(ys.size, 2);
});

test('gantry-4 有机架/工位治具/门架/安全围栏，且包络为正', () => {
  const geometry = geometryFor('四工位大件双龙门点胶机，20 件/分钟');
  assert.ok(geometry.parts.some((part) => part.id === 'frame-top'));
  assert.ok(geometry.parts.some((part) => part.role === 'plate'));
  assert.ok(geometry.parts.some((part) => part.role === 'fixture'));
  assert.ok(geometry.parts.some((part) => part.id.startsWith('safety-fence-post-')));
  assert.ok(geometry.parts.some((part) => part.id === 'gantry-head-1-beam'));
  for (const size of geometry.envelope) assert.ok(size > 0);
});

test('hybrid 生成转盘段 + 沿 X 延伸的直线段，转盘完整落在外接包络内', () => {
  const geometry = geometryFor('六工位单元式装配+检测混合线，10 件/分钟');
  assert.equal(geometry.layout, 'hybrid');
  assert.equal(geometry.stations.length, 6);
  const dial = partById(geometry, 'dial-plate');
  const plate = partById(geometry, 'hybrid-conveyor-frame');
  assert.equal(dial.shape.type, 'cylinder');
  assert.ok(dial.shape.radius > 0);
  assert.ok(plate.center[0] > dial.center[0]);
  assert.ok(dial.center[0] - dial.shape.radius >= geometry.bounds.min[0] - 1e-6);
  assert.ok(dial.center[0] + dial.shape.radius <= geometry.bounds.max[0] + 1e-6);
  assert.ok(dial.center[1] - dial.shape.radius >= geometry.bounds.min[1] - 1e-6);
  assert.ok(dial.center[1] + dial.shape.radius <= geometry.bounds.max[1] + 1e-6);
  assert.ok(geometry.stations[5].origin[0] > geometry.stations[0].origin[0]);
});

test('hybrid 有转盘治具/分度器/转接滑台/安全围栏', () => {
  const geometry = geometryFor('六工位单元式装配+检测混合线，10 件/分钟');
  for (const id of ['dial-indexer', 'dial-plate', 'hybrid-transfer', 'hybrid-conveyor-frame']) {
    assert.ok(partById(geometry, id), id);
  }
  assert.ok(geometry.parts.some((part) => /^dial-nest-\d+$/.test(part.id)));
  assert.ok(geometry.parts.some((part) => part.id.startsWith('safety-fence-post-')));
  for (const size of geometry.envelope) assert.ok(size > 0);
});

test('cell-4 生成 2×2 矩阵，组间距为正且工位互不重叠', () => {
  const geometry = geometryFor('四工位单元式小件装配机，20 件/分钟');
  assert.equal(geometry.layout, 'cell');
  assert.equal(geometry.stations.length, 4);
  const xs = [...new Set(geometry.stations.map((station) => Math.round(station.origin[0])))].sort((a, b) => a - b);
  const ys = [...new Set(geometry.stations.map((station) => Math.round(station.origin[1])))].sort((a, b) => a - b);
  assert.equal(xs.length, 2);
  assert.equal(ys.length, 2);
  assert.ok((xs[1] ?? 0) - (xs[0] ?? 0) > 0);
  assert.ok((ys[1] ?? 0) - (ys[0] ?? 0) > 0);
  assert.ok(geometry.parts.some((part) => part.id.startsWith('safety-fence-post-')));
});

test('cell-4 有机架/工位底板/门架/治具/安全围栏，且不生成转盘', () => {
  const geometry = geometryFor('四工位单元式小件装配机，20 件/分钟');
  assert.ok(geometry.parts.some((part) => part.id === 'frame-top'));
  assert.equal(geometry.parts.filter((part) => part.role === 'plate').length, 4);
  assert.equal(geometry.parts.filter((part) => /^st\d+-beam$/.test(part.id)).length, 4);
  assert.ok(geometry.parts.some((part) => part.role === 'fixture'));
  assert.ok(geometry.parts.some((part) => part.id.startsWith('safety-fence-post-')));
  assert.equal(geometry.parts.some((part) => part.id === 'dial-plate'), false);
});

test('同布局占地系数随工位数单调增长：dial / linear / gantry / cell', () => {
  assert.ok(formById('dial-6').footprintScale < formById('dial-8').footprintScale);
  assert.ok(formById('dial-8').footprintScale < formById('dial-12').footprintScale);
  assert.ok(formById('linear-4').footprintScale < formById('linear-8').footprintScale);
  assert.ok(formById('linear-8').footprintScale < formById('linear-12').footprintScale);
  assert.ok(formById('gantry-2').footprintScale < formById('gantry-4').footprintScale);
  assert.ok(formById('cell-4').footprintScale < formById('dual-lane').footprintScale);
  assert.ok(formById('cell-4').footprintScale < formById('hybrid-dial-linear').footprintScale);
});

const REGRESSIONS = [
  ['四工位大件双龙门点胶机，20 件/分钟', 'gantry-4', 'gantry'],
  ['四工位大件龙门锁螺丝机，10 件/分钟', 'gantry-4', 'gantry'],
  ['六工位单元式装配+检测混合线，10 件/分钟', 'hybrid-dial-linear', 'hybrid'],
  ['四工位单元式小件装配机，20 件/分钟', 'cell-4', 'cell'],
  ['十工位装配长线体，10 件/分钟', 'linear-12', 'linear'],
  ['十二工位装配长线体，10 件/分钟', 'linear-12', 'linear'],
  ['十工位转盘检测机，10 件/分钟', 'dial-12', 'dial'],
  ['十二工位转盘检测机，20 件/分钟', 'dial-12', 'dial']
];

for (const [brief, expectedId, expectedKind] of REGRESSIONS) {
  test(`选型回归：${brief} → ${expectedId}，达标且几何一致`, () => {
    const result = pick(brief);
    assert.equal(result.form.id, expectedId, result.warning ?? '');
    assert.equal(result.form.geometry.kind, expectedKind);
    assert.ok(result.stations >= result.form.stationRange[0] && result.stations <= result.form.stationRange[1]);
    assert.equal(result.evaluation.meetsTarget, true, result.warning ?? '');
    if (result.warning) assert.match(result.warning, /缺口|非标设计/);
    const generated = geometryFor(brief);
    assert.equal(generated.layout, expectedKind);
    assert.equal(generated.stations.length, result.stations);
    for (const size of generated.envelope) assert.ok(size > 0, `${brief} 包络 ${generated.envelope}`);
    if (expectedId === 'dial-12') assert.ok(dialDiameter(generated) >= 1400);
  });
}

test('达标缺口场景：warning 明确写目标、实际产能与缺口', () => {
  const result = pick('四工位转盘检测机，200 件/分钟');
  assert.equal(result.evaluation.meetsTarget, false);
  assert.ok(result.warning);
  assert.match(result.warning, /需要 200 件\/分钟/);
  assert.match(result.warning, /缺口 \d+\.\d+ 件\/分钟/);
});

test('8 条回归 brief 覆盖新增的 5 种形态', () => {
  const ids = new Set(REGRESSIONS.map(([, id]) => id));
  assert.deepEqual([...ids].sort(), [...NEW_FORMS].sort());
  assert.equal(REGRESSIONS.length, 8);
});
