/**
 * 多页电气图纸：机型矩阵 + 随机化矩阵 + 定向用例。
 * 全部是几何/拓扑/线号断言，不做 SVG 快照。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MATRIX } from './matrix.mjs';
import { renderElecDrawing, checkPage } from '../../src/elec/drawing.ts';
import { buildElec } from '../../src/elec/build.ts';
import { runErc, PIN } from '../../src/elec/circuit.ts';
import { checkWireNumbers, runElectricalCheck } from '../../src/elec/check.ts';
import { checkTexts } from '../../src/elec/geometry.ts';
import { elecDesignFromMachine, elecDesignFromProject } from '../../src/elec/adapters.ts';
import { BUS_CATEGORIES, presetScheme, templateRegex } from '../../src/elec/wireno.ts';
import { estimateConveyorDrive } from '../../src/machine/conveyor-synth.ts';
import { buildConveyorParts } from '../../src/machine/conveyor-assembly.ts';

const SCHEMATIC = new Set(['power', 'control', 'input', 'output']);
const tagOf = (pin) => pin.slice(0, pin.lastIndexOf(':'));

/** 对一份出图结果做全部通用断言；scheme 缺省为“数字连续”（现行规则，断言逐字保留） */
function assertDrawing(name, drawing, scheme) {
  const errors = drawing.issues.filter((i) => i.severity === 'error');
  assert.deepEqual(errors, [], `${name}: ERC error`);
  assert.deepEqual(drawing.problems, [], `${name}: 图面自检问题\n${drawing.problems.join('\n')}`);
  assert.equal(drawing.deliverable, true, name);
  const { circuit } = drawing.build;
  const canvases = drawing.canvases;

  // 1) 页码连续、每页图号一致、标题栏写“第 n/N 页”
  drawing.pages.forEach((page, i) => {
    assert.equal(page.index, i + 1);
    assert.ok(page.svg.includes(`${drawing.drawingNo} · 第 ${i + 1}/${drawing.pages.length} 页`), `${name} 第 ${i + 1} 页页码`);
    assert.ok(!page.svg.includes('NaN'), `${name} 第 ${i + 1} 页含 NaN`);
    // 独立复检：最终图元文字不压线、不重叠、不出外框
    assert.deepEqual(checkTexts(page.prims, { x: 6, y: 6, w: 408, h: 285 }), [], `${name} 第 ${i + 1} 页文字`);
  });

  // 2) 每个元件引脚恰好画一次（跨页合计）
  const drawn = new Map();
  for (const canvas of canvases) {
    for (const symbol of canvas.symbols) {
      for (const pin of Object.keys(symbol.pins)) {
        const key = PIN(symbol.tag, pin);
        drawn.set(key, (drawn.get(key) ?? 0) + 1);
      }
    }
  }
  for (const device of circuit.devices) {
    for (const pin of device.pins) assert.equal(drawn.get(PIN(device.tag, pin)), 1, `${name}: ${device.tag}:${pin} 画了 ${drawn.get(PIN(device.tag, pin)) ?? 0} 次`);
  }

  // 3) 线号：同网同号、异网异号；与 check.ts 线号规则零发现（含警告）
  const numbers = Object.entries(drawing.wireNumbers);
  assert.equal(new Set(numbers.map(([, no]) => no)).size, numbers.length, `${name}: 线号重复`);
  assert.equal(numbers.length, circuit.nets.length);
  assert.equal(new Set(numbers.map(([, no]) => no.toUpperCase())).size, numbers.length, `${name}: 线号大小写重复`);
  if (!scheme) {
    assert.deepEqual(checkWireNumbers(drawing.document.wires), [], `${name}: 线号规则`);
    assert.equal(runElectricalCheck(drawing.document).counts.error, 0, `${name}: 电气校验 error`);
    for (const [net, no] of numbers) {
      const label = circuit.nets.find((item) => item.id === net)?.label;
      if (label) assert.equal(no, label === '+24V' ? '24V' : label);
      else assert.match(no, /^\d{3,4}$/);
    }
  } else {
    // 方案即规则：出图结果对该方案的 checkWireNumbers 零发现；校验面板/Agent 读到的文档带同一方案
    assert.deepEqual(drawing.wireScheme, scheme, `${name}: 图纸方案`);
    assert.deepEqual(drawing.document.wireScheme, scheme, `${name}: 文档方案`);
    assert.deepEqual(checkWireNumbers(drawing.document.wires, scheme), [], `${name}: 线号规则（${scheme.preset}）`);
    assert.equal(runElectricalCheck(drawing.document).counts.error, 0, `${name}: 电气校验 error`);
    assert.equal(runElectricalCheck(drawing.document).findings.filter((f) => f.code.startsWith('WIRE_NO')).length, 0, `${name}: 电气校验线号发现`);
    // 预设不靠去重后缀
    assert.deepEqual(drawing.wireNoAdjusted, [], `${name}: 预设 ${scheme.preset} 产生了重号`);
    for (const [net, no] of numbers) {
      const category = drawing.wireCategories[net];
      assert.ok(category, `${name}: ${net} 无类别`);
      assert.match(no, templateRegex(scheme.templates[category], scheme), `${name}: ${net}(${category}) 线号 ${no} 不符合模板 ${scheme.templates[category]}`);
      const wire = drawing.document.wires.find((w) => w.net === net);
      assert.equal(wire?.no, no);
      assert.equal(wire?.category, category);
    }
  }
  // 每张原理图页上出现的每个非母线网络，本页都有它的线号文字（数字连续方案下即每个数字线号网络）
  const busNets = new Set(Object.entries(drawing.wireCategories).filter(([, c]) => BUS_CATEGORIES.has(c)).map(([net]) => net));
  for (const canvas of canvases.filter((c) => SCHEMATIC.has(c.kind))) {
    const texts = new Set(canvas.prims.filter((p) => p.t === 'text' && p.role === 'wire-no').map((p) => `${p.owner}|${p.value}`));
    for (const net of new Set(canvas.wires.map((w) => w.net))) {
      const no = drawing.wireNumbers[net];
      // 画了母线但电路里没有元件接它（如无电机时的 PE 母线）：不是网络，没有线号
      if (no === undefined) {
        assert.ok(!circuit.nets.some((item) => item.id === net), `${name}: ${net} 缺线号`);
        continue;
      }
      if (!scheme) assert.equal(busNets.has(net), !/^\d+$/.test(no), `${name}: ${net} 母线判定`);
      if (busNets.has(net)) continue;
      assert.ok(texts.has(`${net}|${no}`), `${name} 第 ${canvas.index} 页缺线号 ${no}`);
    }
  }
  // 导线表、端子表的线号与图面同一份
  for (const row of drawing.wireList) assert.equal(row.no, drawing.wireNumbers[row.net], `${name}: 导线表 ${row.net}`);
  for (const row of drawing.terminals) {
    const net = circuit.nets.find((item) => item.pins.includes(`${row.strip}-${row.no}:i`));
    if (net) assert.equal(row.wireNo, drawing.wireNumbers[net.id], `${name}: 端子 ${row.no} 线号`);
  }
  // 导线表的每一行线号都存在
  const valid = new Set(numbers.map(([, no]) => no));
  for (const row of drawing.wireList) assert.ok(valid.has(row.no), `${name}: 导线表线号 ${row.no}`);

  // 4) 端子：混合网络里的每个现场引脚都经端子；端子号 1..N 连续；端子画在图上
  const fieldTags = new Set(circuit.devices.filter((d) => d.field).map((d) => d.tag));
  const terminalOf = drawing.build.plan.terminalOf;
  for (const net of circuit.nets) {
    const cabinet = net.pins.some((pin) => {
      const device = circuit.devices.find((d) => d.tag === tagOf(pin));
      return device && !device.field && device.kind !== 'terminal';
    });
    for (const pin of net.pins.filter((p) => fieldTags.has(tagOf(p)))) {
      if (cabinet || net.id === 'PE') assert.ok(terminalOf[pin], `${name}: ${pin} 没经端子`);
    }
  }
  const terminalNos = drawing.terminals.map((row) => row.no);
  assert.deepEqual(terminalNos, terminalNos.map((_, i) => i + 1), `${name}: 端子号不连续`);
  for (const row of drawing.terminals) assert.notEqual(row.ref, '?', `${name}: 端子 ${row.no} 未画`);

  // 5) 分页：每页容量
  const plan = drawing.build.plan;
  const count = (kind) => canvases.filter((c) => c.kind === kind).length;
  assert.equal(count('power'), Math.max(1, Math.ceil(plan.branches.length / 7)));
  assert.equal(count('input'), Math.ceil(plan.inputs.length / 14));
  assert.equal(count('output'), Math.ceil(plan.outputs.length / 14));

  // 6) 交叉引用闭合：每个“/页.列”指向的页确实画了这个网络
  for (const canvas of canvases) {
    for (const t of canvas.prims.filter((p) => p.t === 'text' && p.role === 'xref')) {
      const m = /\/(\d+)\.(\d)$/.exec(t.value);
      assert.ok(m, `${name}: 交叉引用格式 ${t.value}`);
      const target = canvases[Number(m[1]) - 1];
      assert.ok(target && target.wires.some((w) => w.net === t.owner), `${name}: ${t.value} 指向的页没有网络 ${t.owner}`);
    }
  }

  // 7) 明细表：每个位号都画在原理图上；端子排一行写明端子数
  const tagTexts = new Set(canvases.flatMap((c) => c.prims.filter((p) => p.t === 'text' && p.role === 'tag').map((p) => p.value)));
  for (const row of drawing.bom) assert.ok(tagTexts.has(row.tag), `${name}: 明细表 ${row.tag} 图上无位号`);
  if (drawing.terminals.length > 0) assert.ok(drawing.bom.find((r) => r.tag === '-X1')?.spec.startsWith(`${drawing.terminals.length} 位`));
}

for (const [name, make] of Object.entries(MATRIX)) {
  test(`出图矩阵：${name} —— ERC 0 error、自检 0 问题、可交付，线号/端子/分页/交叉引用全过`, () => {
    assertDrawing(name, renderElecDrawing(make(), { date: '2026-10-25' }));
  });
}

/* ------------------------------------------------------------------ 随机化矩阵 */

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomDesign(seed) {
  const rnd = lcg(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const nMotors = Math.floor(rnd() * 7);
  const motors = Array.from({ length: nMotors }, (_, i) => ({
    id: `m${i}`,
    name: '电机',
    purpose: `轴${i + 1}`,
    starter: pick(['dol', 'dol', 'vfd', 'servo']),
    powerKw: pick([0.09, 0.25, 0.37, 0.75, 1.5, 2.2, 4])
  }));
  const curtains = Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({ id: `c${i}`, name: '安全光栅', purpose: `防护${i + 1}` }));
  const inputs = Array.from({ length: Math.floor(rnd() * 36) }, (_, i) => ({
    id: `i${i}`,
    device: pick(['photoelectric', 'proximity', 'pressure', 'proximity-2w', 'button-no', 'button-nc']),
    purpose: `输入${i + 1}`
  }));
  for (const curtain of curtains) if (rnd() < 0.7) inputs.push({ id: `s-${curtain.id}`, device: 'safety-status', purpose: '光栅状态', safetyOf: curtain.id });
  const outputs = Array.from({ length: Math.floor(rnd() * 26) }, (_, i) => ({ id: `o${i}`, device: pick(['valve', 'valve', 'lamp', 'buzzer', 'relay']), purpose: `输出${i + 1}` }));
  return {
    project: `随机机型 #${seed}`,
    drawingNo: `EL-R-${seed}`,
    source: `随机种子 ${seed}`,
    supply: {},
    plc: { model: 'CPU 1215C DC/DC/DC' },
    psu: { model: 'LRS-350-24', watts: 350 },
    motors,
    inputs,
    outputs,
    safety: { estops: 1 + Math.floor(rnd() * 3), curtains, relay: rnd() < 0.5 },
    startStop: pick(['hardwired', 'plc', 'none']),
    notes: [],
    date: '2026-10-25'
  };
}

const SEEDS = [1, 7, 42, 99, 123, 256, 777, 1024, 2026, 31337, 65535, 90210];
for (const seed of SEEDS) {
  test(`随机化矩阵：种子 ${seed} —— 可交付且各项断言成立`, () => {
    assertDrawing(`seed ${seed}`, renderElecDrawing(randomDesign(seed), { date: '2026-10-25' }));
  });
}

/* ------------------------------------------------------------------ 线号预设 × 矩阵 */

for (const preset of ['digital', 'potential', 'pagecol']) {
  test(`线号预设「${preset}」× 机型矩阵 + 随机种子 —— 全部可交付、自检 0 问题、同网同号/异网异号、按方案校验零发现`, () => {
    const scheme = presetScheme(preset);
    for (const [name, make] of Object.entries(MATRIX)) {
      assertDrawing(`${preset}/${name}`, renderElecDrawing(make(), { date: '2026-10-25', wireScheme: scheme }), scheme);
    }
    for (const seed of SEEDS) {
      assertDrawing(`${preset}/seed ${seed}`, renderElecDrawing(randomDesign(seed), { date: '2026-10-25', wireScheme: scheme }), scheme);
    }
  });
}

test('线号预设「数字连续」与不传方案逐字一致（默认不改已有输出）', () => {
  for (const [name, make] of Object.entries(MATRIX)) {
    const a = renderElecDrawing(make(), { date: '2026-10-25' });
    const b = renderElecDrawing(make(), { date: '2026-10-25', wireScheme: presetScheme('digital') });
    assert.deepEqual(b.wireNumbers, a.wireNumbers, name);
    assert.deepEqual(b.pages.map((p) => p.svg), a.pages.map((p) => p.svg), name);
  }
});

test('线号预设「电位-类别」：六工位锁螺丝 —— L1/L11/2L1/N1/+24V/1U/DI1…/DO1…/COM/S1 按类别给号', () => {
  const drawing = renderElecDrawing(MATRIX['screw-6st'](), { date: '2026-10-25', wireScheme: presetScheme('potential') });
  const n = drawing.wireNumbers;
  const { plan } = drawing.build;
  assert.equal(n.L1, 'L1');
  assert.equal(n['BUS-L1'], 'L11');
  assert.equal(n['BUS-L3'], 'L31');
  assert.equal(n.N, 'N');
  assert.equal(n['+24V'], '+24V');
  assert.equal(n['0V'], '0V');
  // 支路：断路器号 + 所取相
  const b1 = plan.branches[1];
  assert.equal(n['B1-L'], `${b1.breaker.replace(/\D/g, '')}L${b1.phase.slice(1)}`);
  assert.equal(n['B0-N'], `N${plan.branches[0].breaker.replace(/\D/g, '')}`);
  // 电机出线 1U/1V/1W
  const motor = plan.branches[1].motor.replace(/\D/g, '');
  assert.deepEqual(['U', 'V', 'W'].map((p) => n[`B1-${p}`]), ['U', 'V', 'W'].map((p) => `${motor}${p}`));
  // PLC 输入/输出按地址顺序：第 k 个点 = DIk / DOk
  plan.inputs.forEach((item, i) => assert.equal(n[`IN-${item.address}`], `DI${i + 1}`, item.address));
  plan.outputs.forEach((item, i) => assert.equal(n[`OUT-${item.address}`], `DO${i + 1}`, item.address));
  // 安全母线 S24 接 PLC 输出组电源 3L+ → 公共端 COM
  assert.equal(n.S24, 'COM');
  assert.equal(drawing.wireCategories.S24, 'plcCommon');
  assert.ok(Object.entries(drawing.wireCategories).some(([net, c]) => c === 'safety' && /^S\d+$/.test(n[net])));
  // 导线表/端子表同号
  assert.ok(drawing.wireList.some((row) => row.no === 'DI1'));
  assert.ok(drawing.terminals.some((row) => row.wireNo === 'DI1'));
});

test('线号预设「页.列」：每个非母线网络 = 首次出现的 页.列（同页同列多网络 .序号）', () => {
  const drawing = renderElecDrawing(MATRIX['screw-6st'](), { date: '2026-10-25', wireScheme: presetScheme('pagecol') });
  const groups = new Map();
  for (const [net, no] of Object.entries(drawing.wireNumbers)) {
    if (BUS_CATEGORIES.has(drawing.wireCategories[net])) continue;
    const m = /^(\d+)\.(\d)(?:\.(\d+))?$/.exec(no);
    assert.ok(m, `${net} ${no}`);
    const key = `${m[1]}.${m[2]}`;
    groups.set(key, [...(groups.get(key) ?? []), m[3]]);
    // 页.列确是该网络首次画出的页与列
    const canvas = drawing.canvases[Number(m[1]) - 1];
    assert.ok(canvas.wires.some((w) => w.net === net), `${net} 不在第 ${m[1]} 页`);
    const earlier = drawing.canvases.slice(0, Number(m[1]) - 1).some((c) => c.wires.some((w) => w.net === net));
    assert.equal(earlier, false, `${net} 更早页已出现`);
  }
  for (const [key, subs] of groups) {
    if (subs.length === 1) assert.equal(subs[0], undefined, `${key} 只有一个网络不应加序号`);
    else assert.deepEqual(subs.map(Number), subs.map((_, i) => i + 1), `${key} 序号`);
  }
});

/* ------------------------------------------------------------------ 定向用例 */

test('适配器①：输送机工程 —— 电机功率来自阻力模型，传感器按零件名分类，图号由数据给出', () => {
  const params = { lengthMm: 2400, widthMm: 400, beltHeightMm: 850, pulleyDiameterMm: 50, beltThicknessMm: 4, frameSectionMm: 40 };
  const parts = buildConveyorParts(params);
  const design = elecDesignFromProject({ id: 'abc-1234', name: '输送线', process: 'conveyor', parts: parts.length, massKg: 30, partsList: parts.map((p) => ({ file: 'x', name: p.name })), params });
  assert.equal(design.motors.length, 1);
  assert.equal(design.motors[0].starter, 'dol');
  assert.equal(design.motors[0].powerKw, Math.max(0.04, Math.round((estimateConveyorDrive(params).motorW / 1000) * 100) / 100));
  assert.deepEqual(design.inputs.map((i) => [i.device, i.purpose]), [['photoelectric', '进料检测'], ['photoelectric', '出料检测']]);
  assert.equal(design.drawingNo, 'EL-CV-1234');
  assert.equal(design.startStop, 'hardwired');
  // 无估算器的工艺：零件名照样分类，功率缺省并写说明
  const other = elecDesignFromProject({ id: 'z9', name: '自制机', process: 'custom', parts: 3, massKg: null, partsList: [{ file: 'a', name: '主电机' }, { file: 'b', name: '升降气缸' }, { file: 'c', name: '到位接近开关' }] });
  assert.equal(other.motors.length, 1);
  assert.deepEqual(other.outputs.map((o) => o.device).sort(), ['lamp', 'valve']);
  assert.ok(other.notes.some((n) => n.includes('缺省')));
  assert.equal(other.drawingNo, 'EL-GN-Z9');
});

test('适配器②：六工位锁螺丝案例 —— IO 地址与方案 IO 表一致，型号取方案 BOM', () => {
  const doc = JSON.parse(readFileSync(new URL('../../../docs/desktop/eval/machine-case.json', import.meta.url), 'utf8'));
  const design = elecDesignFromMachine({ ...doc.design, bomDraft: doc.bom }, { ioRows: doc.ioMap.rows });
  for (const row of doc.ioMap.rows) {
    const list = row.direction === '输入' ? design.inputs : design.outputs;
    const hit = list.find((item) => item.point === row.point);
    assert.ok(hit, `${row.point} 没进电气设计`);
    assert.equal(hit.address, row.address);
  }
  assert.equal(design.motors.length, 6);
  assert.ok(design.motors.every((m) => m.starter === 'servo' && m.driveModel === 'SV660P 750 W' && m.breakerModel === 'iC65N 1P C6'));
  assert.equal(design.safety.curtains.length, 1);
  assert.equal(design.plc.model, 'CP1E-N40DR-A');
  assert.equal(design.supply.mainBreakerModel, '5SY63 3P C16');
  const drawing = renderElecDrawing(design, { date: '2026-10-25' });
  const a1 = drawing.build.circuit.devices.find((d) => d.tag === '-A1');
  for (const row of doc.ioMap.rows) assert.ok(a1.pins.includes(row.address), `PLC 缺端子 ${row.address}`);
  // 1P 伺服支路断路器只断相线：驱动器 N 直接接 N 母线
  const u1 = drawing.build.circuit.nets.find((n) => n.pins.includes('-U1:N'));
  assert.equal(u1.label, 'N');
});

test('分页：输入 30 点 → 3 张输入页；主回路 15 路 → 3 张主回路页，母线页间断点互指', () => {
  const design = {
    ...MATRIX['x-io30'](),
    motors: Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, name: '电机', starter: 'dol', powerKw: 0.37 })),
    inputs: Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, device: 'proximity', purpose: `点${i}` }))
  };
  const drawing = renderElecDrawing(design, { date: '2026-10-25' });
  assertDrawing('分页', drawing);
  const power = drawing.canvases.filter((c) => c.kind === 'power');
  assert.equal(power.length, 3);
  assert.equal(drawing.canvases.filter((c) => c.kind === 'input').length, 3);
  // 第 2 张主回路页左端的 L1 母线断点指回第 1 页、右端指向第 3 页
  const middle = power[1];
  const xrefs = middle.prims.filter((p) => p.t === 'text' && p.role === 'xref' && p.owner === 'BUS-L1').map((p) => p.value);
  assert.ok(xrefs.some((v) => v.startsWith(`←/${power[0].index}.`)), xrefs.join(','));
  assert.ok(xrefs.some((v) => v.startsWith(`→/${power[2].index}.`)), xrefs.join(','));
});

test('线号：主回路母线在各页同号；经端子进出柜的两侧同号；24V/0V/PE 固定', () => {
  const drawing = renderElecDrawing(MATRIX['x-4motors'](), { date: '2026-10-25' });
  const { circuit } = drawing.build;
  const net = circuit.nets.find((n) => n.pins.includes('-M1:U'));
  const terminal = drawing.build.plan.terminalOf['-M1:U'];
  assert.ok(net.pins.includes(`${terminal}:i`) && net.pins.includes(`${terminal}:o`));
  const row = drawing.terminals.find((r) => r.outside === '-M1:U');
  assert.equal(row.wireNo, drawing.wireNumbers[net.id]);
  const conductors = drawing.wireList.filter((w) => w.net === net.id);
  assert.ok(conductors.length >= 2 && conductors.every((w) => w.no === drawing.wireNumbers[net.id]));
  assert.equal(drawing.wireNumbers['+24V'], '24V');
  assert.equal(drawing.wireNumbers['0V'], '0V');
  assert.equal(drawing.wireNumbers.PE, 'PE');
  // 数字线号从 101 起连续不跳号
  const digits = Object.values(drawing.wireNumbers).filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => a - b);
  assert.equal(digits[0], 101);
  assert.deepEqual(digits, digits.map((_, i) => 101 + i));
});

test('触点镜像与交叉引用：接触器线圈下列出主触点所在页.列，主触点旁写线圈所在页.列', () => {
  const drawing = renderElecDrawing(MATRIX['x-4motors'](), { date: '2026-10-25' });
  const page = (tag) => drawing.canvases.find((c) => c.symbols.some((s) => s.tag === tag));
  const coilPage = page('-KM1K');
  const mainPage = page('-KM1');
  const footer = coilPage.prims.filter((p) => p.t === 'text' && p.role === 'footer').map((p) => p.value);
  assert.ok(footer.some((v) => v.startsWith('主 1-6 /') && v.includes(`/${mainPage.index}.`)), footer.join('|'));
  const desc = mainPage.prims.filter((p) => p.t === 'text' && p.owner === '-KM1' && p.role === 'desc').map((p) => p.value);
  assert.ok(desc.some((v) => v.startsWith(`线圈 /${coilPage.index}.`)), desc.join('|'));
});

test('自检会抓：删掉一段导线 → 本页 NET_BROKEN/PIN_UNWIRED；挪走线号 → WIRENO_MISSING', () => {
  const drawing = renderElecDrawing(MATRIX['conveyor-m'](), { date: '2026-10-25' });
  const { circuit } = drawing.build;
  const control = drawing.canvases.find((c) => c.kind === 'control');
  assert.deepEqual(checkPage(control, circuit, drawing.wireNumbers), []);
  const original = control.wires;
  control.wires = original.filter((w) => !(w.net === 'HW-1'));
  const broken = checkPage(control, circuit, drawing.wireNumbers);
  assert.ok(broken.some((p) => p.startsWith('[PIN_UNWIRED]') || p.startsWith('[NET_BROKEN]')), broken.join('\n'));
  control.wires = original;
  const prims = control.prims;
  control.prims = prims.filter((p) => !(p.role === 'wire-no' && p.owner === 'HW-2'));
  assert.ok(checkPage(control, circuit, drawing.wireNumbers).some((p) => p.startsWith('[WIRENO_MISSING]')));
  control.prims = prims;
});

test('没有急停：受控负载 ERC 报 NO_STOP，图纸不可交付并标“有待处理问题”', () => {
  const design = { ...MATRIX['x-no-startstop'](), safety: { estops: 0, curtains: [], relay: false } };
  const drawing = renderElecDrawing(design, { date: '2026-10-25' });
  assert.ok(drawing.issues.some((i) => i.code === 'NO_STOP' && i.severity === 'error'));
  assert.equal(drawing.deliverable, false);
  assert.ok(drawing.pages[0].svg.includes('有待处理问题') && drawing.pages[0].svg.includes('出图前校验'));
});

test('ERC：直启电机缺热继/伺服经驱动器不要求接触器；PLC 输出驱动的线圈必须经急停切断', () => {
  const build = buildElec(MATRIX['x-4motors']());
  assert.deepEqual(runErc(build.circuit).filter((i) => i.severity === 'error'), []);
  // 把 FR1 的常闭触点从线圈回路里短接掉 → THERMAL_NO_TRIP
  const c = build.circuit;
  const bypass = {
    ...c,
    nets: c.nets
      .filter((n) => !n.pins.includes('-FR1NC:96'))
      .map((n) => (n.pins.includes('-FR1NC:95') ? { ...n, pins: [...n.pins.filter((p) => p !== '-FR1NC:95'), '-KM1K:A1'] } : n))
      .concat([{ id: 'DUMMY', pins: ['-FR1NC:95', '-FR1NC:96'] }])
  };
  assert.ok(runErc(bypass).some((i) => i.code === 'THERMAL_NO_TRIP'), JSON.stringify(runErc(bypass)));
});

test('起停方式只看数据：plc 方式自动补起/停按钮进 PLC，hardwired 无直启电机时退化为 plc 并提示', () => {
  const plcMode = buildElec({ ...MATRIX['x-no-startstop'](), startStop: 'plc' });
  assert.deepEqual(plcMode.design.inputs.filter((i) => i.role).map((i) => i.role).sort(), ['start', 'stop']);
  const degraded = buildElec({ ...MATRIX['x-no-startstop'](), startStop: 'hardwired' });
  assert.equal(degraded.design.startStop, 'plc');
  assert.ok(degraded.issues.some((i) => i.code === 'STARTSTOP_NO_DOL'));
  const none = buildElec(MATRIX['x-no-startstop']());
  assert.equal(none.design.inputs.filter((i) => i.role === 'start' || i.role === 'stop').length, 0);
  assert.equal(none.circuit.devices.filter((d) => /启动|停止/.test(d.name)).length, 0);
});

test('extension 不再有机型特判：不认零件名、不写死图号、不直接调输送机估算', () => {
  const source = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  for (const banned of ['EL-CV-001', "includes('进料')", "includes('出料')", 'estimateConveyorDrive', 'buildMachineCircuit']) {
    assert.ok(!source.includes(banned), `extension.ts 仍含 ${banned}`);
  }
  assert.ok(source.includes('renderElecDrawing'));
});
