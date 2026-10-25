/**
 * 线号方案：占位符解析/展开、模板校验（空/非法字符/过长…被拒并给原因）、重号去重、方案即规则的校验、
 * 设置持久化、数据源换方案重画、Agent run_electrical_check 读当前图时用该图的方案。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  assignWireNoScheme,
  DEFAULT_WIRE_NO_SCHEME,
  dedupeSuffix,
  describeScheme,
  matchesScheme,
  parseTemplate,
  presetScheme,
  renderTemplate,
  SAFE_NET_ID,
  templateRegex,
  validateDedupe,
  validateTemplate,
  validateWireNoScheme,
  WIRE_NO_CATEGORIES,
  WIRE_NO_TEMPLATE_MAX
} from '../../src/elec/wireno.ts';
import { detectPreset, loadStoredWireScheme, previewWireNumbers, storeWireScheme, WIRE_SCHEME_STORE_KEY } from '../../src/elec/wireno-ui.ts';
import { SAFE_NET } from '../../src/elec/build.ts';
import { checkWireNumbers, runElectricalCheck } from '../../src/elec/check.ts';
import { renderElecDrawing } from '../../src/elec/drawing.ts';
import { ElecSourceTracker } from '../../src/elec/source.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { MATRIX } from './matrix.mjs';

const CASE = JSON.parse(readFileSync(new URL('../../../docs/desktop/eval/machine-case.json', import.meta.url), 'utf8'));
const codes = (findings) => findings.map((item) => item.code);
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function custom(templates, extra = {}) {
  const checked = validateWireNoScheme({ preset: 'custom', templates, ...extra });
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  return checked.scheme;
}

/* ------------------------------------------------------------------ 占位符 */

test('占位符解析：字面量与占位符分段；花括号不配对返回 null', () => {
  assert.deepEqual(parseTemplate('N{page}.{col}'), [{ lit: 'N' }, { ph: 'page' }, { lit: '.' }, { ph: 'col' }]);
  assert.deepEqual(parseTemplate('COM'), [{ lit: 'COM' }]);
  assert.equal(parseTemplate('DI{seq'), null);
  assert.equal(parseTemplate('DI}'), null);
  assert.equal(parseTemplate('{}'), null);
  assert.equal(parseTemplate('{a{b}'), null);
});

test('占位符展开：用户示例 DI1/DI2/COM/L1/L2/N3/N1.2/1.2 与各占位符取值', () => {
  assert.equal(renderTemplate('DI{seq}', { seq: 1 }), 'DI1');
  assert.equal(renderTemplate('DI{seq}', { seq: 2 }), 'DI2');
  assert.equal(renderTemplate('DO{seq}', { seq: 7 }), 'DO7');
  assert.equal(renderTemplate('COM', {}), 'COM');
  assert.equal(renderTemplate('COM{seq}', { seq: 2 }), 'COM2');
  assert.equal(renderTemplate('L{phase}', { phase: '1' }), 'L1');
  assert.equal(renderTemplate('L{phase}', { phase: '2' }), 'L2');
  assert.equal(renderTemplate('N{seq}', { seq: 3 }), 'N3');
  assert.equal(renderTemplate('N{page}.{col}', { page: 1, col: 2 }), 'N1.2');
  assert.equal(renderTemplate('{page}.{col}', { page: 1, col: 2 }), '1.2');
  assert.equal(renderTemplate('{page}{row}{col}', { page: 3, col: 4, row: 'C' }), '3C4');
  assert.equal(renderTemplate('{num}', { num: 101 }), '101');
  assert.equal(renderTemplate('{addr}', { addr: 'I0.3' }), 'I0.3');
  assert.equal(renderTemplate('X{pt}', { pt: 4 }), 'X4');
  assert.equal(renderTemplate('{tag}:{pin}', { tag: 'KM1', pin: 'A1' }), 'KM1:A1');
  assert.equal(renderTemplate('{grp}L{phase}', { grp: '2', phase: '3' }), '2L3');
  assert.equal(renderTemplate('{page}.{col}.{cseq}', { page: 1, col: 3, cseq: 2 }), '1.3.2');
  // {cdot}：同页同列只有一个网络时为空，多个时为 .序号
  assert.equal(renderTemplate('{page}.{col}{cdot}', { page: 1, col: 3, cseq: 1, ccount: 1 }), '1.3');
  assert.equal(renderTemplate('{page}.{col}{cdot}', { page: 1, col: 3, cseq: 2, ccount: 3 }), '1.3.2');
});

test('格式正则：由模板生成，含可选的重号后缀', () => {
  const scheme = presetScheme('potential');
  assert.ok(templateRegex('DI{seq}', scheme).test('DI12'));
  assert.ok(templateRegex('DI{seq}', scheme).test('DI12.1'));
  assert.ok(!templateRegex('DI{seq}', scheme).test('DO12'));
  assert.ok(templateRegex('L{phase}', scheme).test('L3'));
  assert.ok(!templateRegex('L{phase}', scheme).test('L4'));
  assert.ok(templateRegex('{page}.{col}{cdot}', scheme).test('1.2'));
  assert.ok(templateRegex('{page}.{col}{cdot}', scheme).test('1.2.3'));
  assert.ok(templateRegex('{num}', DEFAULT_WIRE_NO_SCHEME).test('101'));
  assert.ok(!templateRegex('{num}', DEFAULT_WIRE_NO_SCHEME).test('12'), '起始号 101 → 至少 3 位');
  assert.ok(matchesScheme('2L1', scheme, 'branch'));
  assert.ok(!matchesScheme('2L1', scheme, 'plcIn'));
  assert.ok(!matchesScheme('2L1', DEFAULT_WIRE_NO_SCHEME));
});

/* ------------------------------------------------------------------ 校验 */

test('非法模板被拒并给出原因：空 / 空白 / 非法字符 / 过长 / 未知占位符 / 花括号 / 类别不适用', () => {
  assert.match(validateTemplate('plcIn', ''), /模板为空/);
  assert.match(validateTemplate('plcIn', '   '), /模板为空/);
  assert.match(validateTemplate('plcIn', undefined), /模板为空/);
  assert.match(validateTemplate('plcIn', ' DI{seq}'), /首尾不能有空格/);
  assert.match(validateTemplate('plcIn', 'DI {seq}'), /非法字符「 」/);
  assert.match(validateTemplate('plcIn', '输入{seq}'), /非法字符「输」/);
  assert.match(validateTemplate('plcIn', 'DI<{seq}>'), /非法字符「<」/);
  assert.match(validateTemplate('plcIn', 'D'.repeat(WIRE_NO_TEMPLATE_MAX + 1)), /过长（25 字符，最多 24）/);
  assert.match(validateTemplate('plcIn', 'DI{foo}'), /未知占位符 \{foo\}/);
  assert.match(validateTemplate('plcIn', 'DI{seq'), /花括号不配对/);
  assert.match(validateTemplate('dc24', '24V{seq}'), /母线.*\{seq\}/);
  assert.match(validateTemplate('pe', '{page}.{col}'), /母线.*\{page\}/);
  assert.match(validateTemplate('plcIn', 'L{phase}'), /不能用 \{phase\}/);
  assert.match(validateTemplate('control', 'X{addr}'), /不是 PLC 点，不能用 \{addr\}/);
  assert.match(validateTemplate('control', '{cdot}'), /只有 \{cdot\}/);
  // 合法
  for (const [category, tpl] of [['plcIn', 'DI{seq}'], ['plcOut', 'DO{seq}'], ['plcCommon', 'COM'], ['mainIn', 'L{phase}'], ['neutralBranch', 'N{seq}'], ['control', 'N{page}.{col}'], ['control', '{page}.{col}'], ['plcIn', '{addr}'], ['motor', '{tag}-{pin}']]) {
    assert.equal(validateTemplate(category, tpl), null, `${category} ${tpl}`);
  }
});

test('方案校验：缺的类别按预设补齐；任一项不合法整体拒绝并列出全部原因', () => {
  const partial = validateWireNoScheme({ preset: 'potential', templates: { plcIn: 'X{seq}' } });
  assert.ok(partial.ok);
  assert.equal(partial.scheme.templates.plcIn, 'X{seq}');
  assert.equal(partial.scheme.templates.plcOut, 'DO{seq}');
  assert.equal(partial.scheme.numStart, 101);

  const bad = validateWireNoScheme({ preset: 'nope', templates: { plcIn: '', foo: 'x', control: 'A B' }, numStart: -1, dedupe: 'x' });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  assert.match(text, /未知预设：nope/);
  assert.match(text, /未知线号类别：foo/);
  assert.match(text, /「PLC 数字输入（每点）」模板为空/);
  assert.match(text, /「控制回路中间网络」模板含非法字符/);
  assert.match(text, /起始号/);
  assert.match(text, /重号区分后缀须且只能含一个/);
  assert.equal(validateWireNoScheme(null).ok, false);
  assert.equal(validateWireNoScheme({ preset: 'custom', templates: [] }).ok, false);
  assert.equal(validateDedupe('.{k}'), null);
  assert.equal(validateDedupe('-{a}'), null);
  assert.match(validateDedupe('{k}{a}'), /只能含一个/);
  assert.match(validateDedupe('.{k}1234567'), /过长/);
  assert.match(validateDedupe(''), /为空/);
  assert.equal(dedupeSuffix('.{k}', 2), '.2');
  assert.equal(dedupeSuffix('-{a}', 1), '-a');
  assert.equal(dedupeSuffix('-{a}', 27), '-aa');
  // 三个预设自身全部合法
  for (const preset of ['digital', 'potential', 'pagecol']) assert.ok(validateWireNoScheme(presetScheme(preset)).ok, preset);
});

/* ------------------------------------------------------------------ 去重 */

function fakeCircuit(ids) {
  return { devices: [], nets: ids.map((id) => ({ id, pins: [] })), supply: '3ph-380' };
}

test('模板冲突去重：后出现的网络自动加后缀（.1/.2 或 -a/-b），后缀撞上已有线号继续往后取', () => {
  const info = new Map([
    ['a', { category: 'control' }],
    ['b', { category: 'control' }],
    ['c', { category: 'control' }],
    ['d', { category: 'other' }]
  ]);
  const order = ['a', 'b', 'c', 'd'].map((net, i) => ({ net, page: 1, col: i + 1, row: 'A' }));
  const dot = assignWireNoScheme(fakeCircuit(['a', 'b', 'c', 'd']), info, order, custom({ control: 'K', other: 'K.1' }));
  // d 的模板本身就是 K.1，但 b 先占了 K.1 → d 取 K.1.1
  assert.deepEqual(dot.numbers, { a: 'K', b: 'K.1', c: 'K.2', d: 'K.1.1' });
  assert.deepEqual(dot.adjusted.map((item) => item.net), ['b', 'c', 'd']);
  const alpha = assignWireNoScheme(fakeCircuit(['a', 'b', 'c']), info, order, custom({ control: 'K' }, { dedupe: '-{a}' }));
  assert.deepEqual(alpha.numbers, { a: 'K', b: 'K-a', c: 'K-b' });
  // 大小写不同也算重号（校验按大写归并）
  const ci = assignWireNoScheme(fakeCircuit(['a', 'b']), new Map([['a', { category: 'control' }], ['b', { category: 'other' }]]), order, custom({ control: 'k1', other: 'K1' }));
  assert.deepEqual(ci.numbers, { a: 'k1', b: 'K1.1' });
});

test('模板冲突在整图上：自动加后缀、以 WIRENO_SUFFIXED 警告报告，异网仍异号且按方案校验零发现，图仍可交付', () => {
  // 输入/输出/公共端都写成 IO：大量重号
  const scheme = custom({ plcIn: 'IO', plcOut: 'IO', plcCommon: 'IO' });
  const drawing = renderElecDrawing(MATRIX['screw-6st'](), { date: '2026-10-25', wireScheme: scheme });
  assert.ok(drawing.wireNoAdjusted.length > 10);
  const warn = drawing.issues.find((issue) => issue.code === 'WIRENO_SUFFIXED');
  assert.ok(warn && warn.severity === 'warning', '重号必须报告，不能静默');
  assert.match(warn.message, /IO→IO\.1/);
  const values = Object.values(drawing.wireNumbers);
  assert.equal(new Set(values).size, values.length, '异网异号');
  assert.deepEqual(drawing.problems, []);
  assert.equal(drawing.deliverable, true);
  assert.deepEqual(checkWireNumbers(drawing.document.wires, scheme), []);
  assert.match(drawing.pages[0].svg, /校验通过（\d+ 条提示）/);
});

/* ------------------------------------------------------------------ 方案即规则 */

test('check.ts 按方案判断格式：同一个 1L1 在“数字连续”下不合规，在“电位-类别”的支路类别下合规；跨网同号仍是严重', () => {
  const w = (no, net, category, potential = 'AC380') => ({ no, net, potential, from: `${net}:a`, to: `${net}:b`, ...(category ? { category } : {}) });
  assert.deepEqual(codes(checkWireNumbers([w('1L1', 'n1')])), ['WIRE_NO_FORMAT']);
  assert.deepEqual(codes(checkWireNumbers([w('1L1', 'n1', 'branch')], presetScheme('potential'))), []);
  assert.deepEqual(codes(checkWireNumbers([w('1L1', 'n1', 'plcIn')], presetScheme('potential'))), ['WIRE_NO_FORMAT']);
  assert.deepEqual(codes(checkWireNumbers([w('DI1', 'n1'), w('DI1', 'n2')], presetScheme('potential'))), ['WIRE_NO_CROSS_NET']);
  assert.equal(checkWireNumbers([w('DI1', 'n1'), w('DI1', 'n2')], presetScheme('potential'))[0].severity, 'error');
  assert.deepEqual(codes(checkWireNumbers([w('1.2', 'n1', 'control'), w('1.2.1', 'n2', 'control')], presetScheme('pagecol'))), []);
  assert.deepEqual(codes(checkWireNumbers([w('101', 'n1', 'control')], presetScheme('pagecol'))), ['WIRE_NO_FORMAT']);
  // 相线语义仍查
  assert.deepEqual(codes(checkWireNumbers([w('L1', 'n1', 'mainIn', 'L2')], presetScheme('potential'))), ['WIRE_NO_POTENTIAL_MISMATCH']);
  // 建议文字写方案
  const format = checkWireNumbers([w('X9', 'n1')], presetScheme('potential'))[0];
  assert.match(format.suggestion, /电位-类别/);
  // runElectricalCheck 读文档自带的方案
  assert.equal(runElectricalCheck({ wires: [w('DI1', 'n1', 'plcIn')], wireScheme: presetScheme('potential') }).counts.warning, 0);
  assert.equal(runElectricalCheck({ wires: [w('DI1', 'n1', 'plcIn')] }).counts.warning, 1);
});

test('安全母线网络 id 与 build.ts 一致；描述文字：数字连续保持原句', () => {
  assert.equal(SAFE_NET_ID, SAFE_NET);
  assert.equal(describeScheme(DEFAULT_WIRE_NO_SCHEME), 'L1/L2/L3/N/PE、24V/0V 为固定电位，其余网络 101 起按页→列连续编号，同网同号');
  assert.match(describeScheme(presetScheme('potential')), /DI1.*DO1/);
  assert.match(describeScheme(presetScheme('pagecol')), /如 1\.2 \/ 1\.2\.1/);
  assert.equal(WIRE_NO_CATEGORIES.length, 17);
});

/* ------------------------------------------------------------------ 设置与数据源 */

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), map };
}

test('设置持久化：保存/读回；不合法或无法解析退回“数字连续”并给出原因；预览与预设识别', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadStoredWireScheme(storage), { scheme: DEFAULT_WIRE_NO_SCHEME });
  assert.deepEqual(loadStoredWireScheme(null), { scheme: DEFAULT_WIRE_NO_SCHEME });
  storeWireScheme(storage, presetScheme('potential'));
  assert.deepEqual(loadStoredWireScheme(storage).scheme, presetScheme('potential'));
  storage.setItem(WIRE_SCHEME_STORE_KEY, JSON.stringify({ preset: 'custom', templates: { plcIn: '' } }));
  const bad = loadStoredWireScheme(storage);
  assert.deepEqual(bad.scheme, DEFAULT_WIRE_NO_SCHEME);
  assert.match(bad.warning, /模板为空/);
  storage.setItem(WIRE_SCHEME_STORE_KEY, '{');
  assert.match(loadStoredWireScheme(storage).warning, /无法解析/);

  const preview = previewWireNumbers(presetScheme('potential'));
  assert.deepEqual(preview.plcIn, ['DI1', 'DI2', 'DI3']);
  assert.deepEqual(preview.plcOut, ['DO1', 'DO2', 'DO3']);
  assert.deepEqual(preview.mainIn, ['L1', 'L2', 'L3']);
  assert.deepEqual(preview.plcCommon, ['COM']);
  assert.deepEqual(preview.dc24, ['+24V']);
  assert.deepEqual(previewWireNumbers(DEFAULT_WIRE_NO_SCHEME).control, ['101', '102', '103']);
  assert.equal(detectPreset(presetScheme('pagecol')), 'pagecol');
  assert.equal(detectPreset({ ...presetScheme('pagecol'), templates: { ...presetScheme('pagecol').templates, plcIn: 'DI{seq}' } }), 'custom');
});

test('数据源换方案：缓存作废按新方案重画；Agent run_electrical_check 读当前图时用该图的方案，零线号发现', async () => {
  const sources = new ElecSourceTracker(renderElecDrawing, () => '2026-10-25');
  sources.useMachine(CASE.design.config, CASE.design);
  const before = sources.drawing();
  assert.equal(before.wireNumbers.S24, '132');
  sources.setWireScheme(presetScheme('potential'));
  assert.equal(sources.wireScheme().preset, 'potential');
  const drawing = sources.drawing();
  assert.notEqual(drawing, before);
  assert.equal(drawing.wireNumbers['IN-I0.0'], 'DI1');
  assert.equal(sources.drawing(), drawing, '同方案复用缓存');

  const root = mkdtempSync(join(tmpdir(), 'cad-wireno-'));
  roots.push(root);
  const bridge = {
    async call(method) {
      if (method === 'getElecDocument') return JSON.parse(JSON.stringify({ ok: true, document: drawing.document, source: { kind: 'machine' } }));
      return { ok: false, message: method };
    }
  };
  const bus = createAgentCommandBus({ listParts: () => [] }, bridge, { userDataRoot: root, exportsRoot: join(root, 'exports') });
  const result = await bus.execute('run_electrical_check', {});
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.data.findings.filter((f) => f.code.startsWith('WIRE_NO')), []);
  // 同一份线号若丢掉方案按缺省“数字连续”判，就会报格式问题——证明确实用了图的方案
  const stripped = { ...drawing.document };
  delete stripped.wireScheme;
  assert.ok(runElectricalCheck(stripped).findings.some((f) => f.code === 'WIRE_NO_FORMAT'));
  // 不合法的方案被拒
  const rejected = await bus.execute('run_electrical_check', { wires: [{ no: 'DI1', net: 'n' }], wireScheme: { preset: 'custom', templates: { plcIn: '' } } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_ARGUMENT');
  assert.match(rejected.error.message, /wireScheme 不合法：.*模板为空/);
});

test('extension：翻页条注入「线号格式」入口，读写 localStorage 方案并重画当前页；原型文件不引用', () => {
  const source = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  assert.match(source, /data-elec-wireno/);
  assert.match(source, /openWireSchemeDialog\(/);
  assert.match(source, /loadStoredWireScheme\(storage\)/);
  assert.match(source, /storeWireScheme\(window\.localStorage, scheme\)/);
  assert.match(source, /elecSources\.setWireScheme\(scheme\)/);
  assert.match(source, /showElecDrawing\(drawing, pageIndex\)/);
});
