/**
 * 电气原理图图面回归：几何/文字断言，不是快照。
 * 每一条对应一次用户反馈的「一团糟」里的具体问题（见 MODULE.md「出图自检」）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMachineCircuit, breakerNameFor } from '../../src/elec/machine-circuit.ts';
import { runErc } from '../../src/elec/circuit.ts';
import { layoutCircuit } from '../../src/elec/layout.ts';
import { renderSheet, bomRows } from '../../src/elec/sheet.ts';
import { checkWiring, checkTexts, segHitsBox, shrink, textBox, junctionPoints, P } from '../../src/elec/geometry.ts';
import { selectMotorProtection } from '../../src/elec/protection.ts';

const SPEC = {
  project: '皮带输送线 2400×400',
  drive: { powerKw: 0.04, rpm: 76, ratio: 18.4 },
  sensors: [
    { tag: '-PE1', label: '进料检测', address: 'I0.3' },
    { tag: '-PE2', label: '出料检测', address: 'I0.4' }
  ],
  controls: { estop: true, startStop: true, lamp: true },
  selection: { breaker: 'iC65N 3P C1', contactor: 'LC1D09', thermal: 'LRD01 · 0.1–0.16A', currentA: 0.1, thermalSetA: 0.1 }
};
const OPTS = { project: SPEC.project, drawingNo: 'EL-CV-001', page: '1 / 1', date: '2026-10-25', notes: ['线体 2400×400 mm · 皮带面高 850 mm', '零件 42 件 · 总质量 38.5 kg'] };

const sel = (kw) => {
  const p = selectMotorProtection(kw);
  return { breaker: p.breaker, contactor: p.contactor, thermal: p.thermal, currentA: p.currentA, thermalSetA: p.thermalSetA };
};
const VARIANTS = {
  '1 个传感器、无指示灯': {
    ...SPEC,
    drive: { powerKw: 0.09, rpm: 60, ratio: 23 },
    sensors: [{ tag: '-PE1', label: '工件到位', address: 'I0.3' }],
    controls: { estop: true, startStop: true, lamp: false },
    selection: sel(0.09)
  },
  '3 个传感器、0.75 kW': {
    ...SPEC,
    drive: { powerKw: 0.75, rpm: 30, ratio: 46.7 },
    sensors: [
      { tag: '-PE1', label: '进料检测', address: 'I0.3' },
      { tag: '-PE2', label: '中段检测', address: 'I0.4' },
      { tag: '-PE3', label: '出料检测', address: 'I0.5' }
    ],
    selection: sel(0.75)
  },
  '5 个传感器、2.2 kW、长工程名': {
    ...SPEC,
    project: '五工位分拣线（长项目名称测试用例，看标题栏会不会溢出）',
    drive: { powerKw: 2.2, rpm: 45, ratio: 31 },
    sensors: [1, 2, 3, 4, 5].map((i) => ({ tag: `-PE${i}`, label: `工位${i}检测`, address: `I0.${i + 2}` })),
    selection: sel(2.2)
  }
};

const ownerPrims = (prims, owner, role) => prims.filter((p) => p.owner === owner && (!role || p.role === role));
const sym = (layout, tag) => layout.symbols.find((s) => s.tag === tag);
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

/* ---------------- 1. 主回路相线连续 ---------------- */

test('主回路：QF1→KM1→FR1→M1 每相导线首尾相接，ERC 不再报 PHASE_PATH_SUSPECT', () => {
  const circuit = buildMachineCircuit(SPEC);
  assert.deepEqual(runErc(circuit), [], '合格输入应当零 ERC 问题（含 warning）');
  const layout = layoutCircuit(circuit);
  for (const [from, to] of [['-QF1', '-KM1'], ['-KM1', '-FR1']]) {
    const a = sym(layout, from);
    const b = sym(layout, to);
    for (const [pout, pin] of [['2', '1'], ['4', '3'], ['6', '5']]) {
      const p = a.pins[pout];
      const q = b.pins[pin];
      assert.ok(near(p[0], q[0]), `${from}:${pout} 与 ${to}:${pin} 不在同一竖线`);
      const hit = layout.wires.some((w) => w.points.length === 2 && near(w.points[0][0], p[0]) && near(w.points[0][1], p[1]) && near(w.points[1][1], q[1]));
      assert.ok(hit, `${from}:${pout} → ${to}:${pin} 之间缺导线（断口）`);
    }
  }
  const fr = sym(layout, '-FR1');
  const m = sym(layout, '-M1');
  for (const [pout, pin] of [['2', 'U'], ['4', 'V'], ['6', 'W']]) {
    const hit = layout.wires.some((w) => near(w.points[0][1], fr.pins[pout][1]) && near(w.points.at(-1)[0], m.pins[pin][0]) && near(w.points.at(-1)[1], m.pins[pin][1]));
    assert.ok(hit, `-FR1:${pout} → -M1:${pin} 缺导线`);
  }
});

test('ERC：相线绕过接触器、或走不到电机，会报 PHASE_PATH_SUSPECT', () => {
  const base = buildMachineCircuit(SPEC);
  // L2：QF1:4 直接接到 FR1:3，跳过 KM1
  const bypass = {
    ...base,
    devices: base.devices.map((d) => (d.tag === '-KM1' ? { ...d, pins: ['1', '5', '2', '6'] } : d)),
    nets: base.nets
      .filter((net) => net.id !== 'N-KM-4')
      .map((net) => (net.id === 'N-QF-4' ? { ...net, pins: ['-QF1:4', '-FR1:3'] } : net))
  };
  const warn = runErc(bypass).filter((i) => i.code === 'PHASE_PATH_SUSPECT');
  assert.ok(warn.some((i) => i.message.includes('L2') && i.message.includes('接触器')), JSON.stringify(warn));
  // L3：FR1:6 不接电机
  const open = { ...base, nets: base.nets.map((net) => (net.id === 'N-FR-6' ? { ...net, pins: ['-FR1:6'] } : net)) };
  assert.ok(runErc(open).some((i) => i.code === 'PHASE_PATH_SUSPECT' && i.message.includes('L3')));
});

test('图面自检：导线断口/端点偏移/相间短接都会被抓到', () => {
  const circuit = buildMachineCircuit(SPEC);
  const layout = layoutCircuit(circuit);
  assert.deepEqual(layout.problems, []);
  const km = sym(layout, '-KM1');
  // 删掉 KM1:4 → FR1:3 这段线
  const gap = layout.wires.filter((w) => !(near(w.points[0][0], km.pins['4'][0]) && near(w.points[0][1], km.pins['4'][1])));
  assert.equal(gap.length, layout.wires.length - 1);
  const p1 = checkWiring(circuit, gap, layout.symbols);
  assert.ok(p1.some((p) => p.startsWith('[PIN_UNWIRED] -KM1') || p.startsWith('[NET_BROKEN]')), p1.join('\n'));
  // 端点偏 1.5 mm（基线图里“段与段之间有空隙”就是这种）
  const shifted = layout.wires.map((w) =>
    near(w.points[0][0], km.pins['4'][0]) && near(w.points[0][1], km.pins['4'][1])
      ? { ...w, points: [[w.points[0][0], w.points[0][1] + 1.5], w.points[1]] }
      : w
  );
  assert.ok(checkWiring(circuit, shifted, layout.symbols).some((p) => p.includes('-KM1 的引脚 4')));
  // L1、L2 之间加一根横线 → 短接
  const qf = sym(layout, '-QF1');
  const short = [...layout.wires, { net: 'bad', points: [[qf.pins['1'][0], qf.pins['1'][1] - 3], [qf.pins['3'][0], qf.pins['3'][1] - 3]] }];
  assert.ok(checkWiring(circuit, short, layout.symbols).some((p) => p.startsWith('[NET_SHORT]')));
});

/* ---------------- 2. 电机 ---------------- */

test('电机：U/V/W 三根进线都落到圆周上，M 与 3~ 在圆内且不压线', () => {
  const layout = layoutCircuit(buildMachineCircuit(SPEC));
  const circle = ownerPrims(layout.prims, '-M1', 'body').find((p) => p.t === 'circle');
  assert.ok(circle);
  const leads = ownerPrims(layout.prims, '-M1', 'lead').filter((p) => p.t === 'line');
  const onCircle = leads.filter((l) => near(Math.hypot(l.x2 - circle.cx, l.y2 - circle.cy), circle.r, 0.01));
  assert.equal(onCircle.length, 3, '三根相线都必须接到圆上');
  const m = sym(layout, '-M1');
  for (const pin of ['U', 'V', 'W']) {
    const [x, y] = m.pins[pin];
    assert.ok(leads.some((l) => near(l.x1, x) && near(l.y1, y)), `${pin} 引脚没有引线进圆`);
  }
  const inner = ownerPrims(layout.prims, '-M1', 'inner');
  assert.deepEqual(inner.map((t) => t.value).sort(), ['3~', 'M']);
  for (const t of inner) {
    const b = textBox(t);
    for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
      assert.ok(Math.hypot(x - circle.cx, y - circle.cy) < circle.r, `“${t.value}”出圆`);
    }
    for (const l of layout.prims.filter((p) => p.t === 'line' && p.owner === '-M1')) {
      assert.equal(segHitsBox(l.x1, l.y1, l.x2, l.y2, b), false, `“${t.value}”压到电机线`);
    }
  }
});

/* ---------------- 3. 三极符号 ---------------- */

test('三极符号：断路器带 ×、接触器带半圆，动触片斜向；热继联动虚线不进方框', () => {
  const layout = layoutCircuit(buildMachineCircuit(SPEC));
  assert.equal(ownerPrims(layout.prims, '-QF1', 'cross').length, 6);
  assert.equal(ownerPrims(layout.prims, '-KM1', 'contactor-arc').length, 3);
  for (const tag of ['-QF1', '-KM1']) {
    const blades = ownerPrims(layout.prims, tag, 'blade');
    assert.equal(blades.length, 3);
    for (const b of blades) assert.ok(b.x1 !== b.x2 && b.y1 !== b.y2, `${tag} 动触片应为斜线`);
    // 上下引线不得是横杠
    for (const l of ownerPrims(layout.prims, tag, 'lead')) assert.ok(near(l.x1, l.x2), `${tag} 引线应竖直`);
  }
  const boxes = ownerPrims(layout.prims, '-FR1', 'body').filter((p) => p.t === 'rect');
  assert.equal(boxes.length, 3);
  const links = ownerPrims(layout.prims, '-FR1', 'linkage');
  assert.ok(links.length >= 1);
  for (const l of links) for (const r of boxes) {
    assert.equal(segHitsBox(l.x1, l.y1, l.x2, l.y2, shrink({ x: r.x, y: r.y, w: r.w, h: r.h }, 0.2)), false, '联动虚线压进热元件方框');
  }
});

/* ---------------- 4. 控制回路触点 ---------------- */

test('常开/常闭可区分：常闭带静触点钩、动触片越过钩端；常开无钩、触片向另一侧留缺口', () => {
  const layout = layoutCircuit(buildMachineCircuit(SPEC));
  for (const tag of ['-SB1', '-SB3', '-FR1NC']) {
    const s = sym(layout, tag);
    const x = Object.values(s.pins)[0][0];
    const hook = ownerPrims(layout.prims, tag, 'hook');
    const blade = ownerPrims(layout.prims, tag, 'blade')[0];
    assert.equal(hook.length, 1, `${tag} 常闭缺静触点钩`);
    assert.ok(blade.x2 > hook[0].x2 - 0.01 && blade.y2 < hook[0].y1, `${tag} 动触片没越过钩端`);
    assert.ok(blade.x2 > x, `${tag} 触片方向错`);
  }
  for (const tag of ['-SB2', '-KM1A']) {
    const x = Object.values(sym(layout, tag).pins)[0][0];
    assert.equal(ownerPrims(layout.prims, tag, 'hook').length, 0, `${tag} 常开不应有钩`);
    assert.ok(ownerPrims(layout.prims, tag, 'blade')[0].x2 < x, `${tag} 常开触片方向错`);
  }
  // 操作件：急停蘑菇头、按钮推杆、热继常闭带热驱动；自锁触点无操作件
  assert.ok(ownerPrims(layout.prims, '-SB1', 'actuator').some((p) => p.t === 'path'));
  assert.ok(ownerPrims(layout.prims, '-SB2', 'actuator').length > 0);
  assert.ok(ownerPrims(layout.prims, '-FR1NC', 'actuator').some((p) => p.t === 'rect'));
  assert.equal(ownerPrims(layout.prims, '-KM1A', 'actuator').length, 0);
});

test('自锁并联：SB2 与 KM1 13/14 并排成两列，上下汇流点打点，十字交叉不打点', () => {
  const circuit = buildMachineCircuit(SPEC);
  const sheet = renderSheet(circuit, OPTS);
  const layout = layoutCircuit(circuit);
  const sb2 = sym(layout, '-SB2');
  const aux = sym(layout, '-KM1A');
  assert.ok(near(sb2.y, aux.y) && aux.pins['13'][0] - sb2.pins['13'][0] >= 15, '并联两支路应同高并排');
  const x0 = sb2.pins['13'][0];
  const has = (x, y) => sheet.junctions.some(([jx, jy]) => near(jx, x) && near(jy, y));
  assert.ok(has(x0, sb2.pins['13'][1] - 3.5), '并联上汇流点缺打点');
  assert.ok(has(x0, sb2.pins['14'][1] + 3.5), '并联下汇流点缺打点');
  // 传感器 BN 线穿过 0V(M) 母线：十字交叉，不得打点
  const pe1 = sym(layout, '-PE1');
  assert.ok(layout.rails.mY !== null);
  assert.equal(has(pe1.pins['+'][0], layout.rails.mY), false);
  // BU 线落在 M 母线上：T 接，必须打点
  assert.ok(has(pe1.pins['-'][0], layout.rails.mY));
  // 纯几何：十字交叉不算连接
  assert.deepEqual(junctionPoints([{ net: 'a', points: [[0, 5], [10, 5]] }, { net: 'b', points: [[5, 0], [5, 10]] }]), []);
});

test('位号/端子号不压符号与导线：整张图文字自检为零', () => {
  const sheet = renderSheet(buildMachineCircuit(SPEC), OPTS);
  assert.deepEqual(checkTexts(sheet.prims, { x: 10, y: 10, w: 400, h: 277 }), []);
  // 自检真的会抓：把 -FU1 位号挪到熔断器身上
  const fu = sheet.prims.find((p) => p.t === 'rect' && p.owner === '-FU1');
  const bad = [...sheet.prims, P.text(fu.x, fu.y + fu.h / 2, '-FU1', 4, 'start', 'it')];
  assert.ok(checkTexts(bad, { x: 10, y: 10, w: 400, h: 277 }).some((p) => p.includes('-FU1')));
});

/* ---------------- 5. 指示灯 / PLC / 传感器 ---------------- */

test('指示灯 HL1 画在 Q0.0 与 0V 之间；PLC 是带端子的框，L+/M/I/Q 都落在框边并接线', () => {
  const circuit = buildMachineCircuit(SPEC);
  const layout = layoutCircuit(circuit);
  const hl = sym(layout, '-HL1');
  assert.ok(hl, '图上没有 -HL1');
  assert.ok(ownerPrims(layout.prims, '-HL1', 'body').some((p) => p.t === 'circle'));
  assert.ok(layout.prims.some((p) => p.t === 'text' && p.role === 'tag' && p.value === '-HL1'));
  const plc = sym(layout, '-PLC');
  const frame = ownerPrims(layout.prims, '-PLC', 'body').find((p) => p.t === 'rect');
  assert.ok(frame, 'PLC 没有框');
  for (const pin of ['L+', 'M', 'I0.3', 'I0.4', 'Q0.0']) {
    const [x, y] = plc.pins[pin];
    assert.ok(x > frame.x && x < frame.x + frame.w && (near(y, frame.y) || near(y, frame.y + frame.h)), `${pin} 不在 PLC 框边上`);
    assert.ok(layout.prims.some((p) => p.t === 'text' && p.owner === '-PLC' && p.value === pin), `${pin} 端子名缺失`);
  }
  // 导线拓扑：L+ 接 +24V、M 接 0V、Q0.0→HL1→0V、传感器三线，全部由 checkWiring 按网络验证
  assert.deepEqual(checkWiring(circuit, layout.wires, layout.symbols), []);
  assert.ok(hl.pins['1'][1] > plc.pins['Q0.0'][1] && near(hl.pins['1'][0], plc.pins['Q0.0'][0]));
});

test('漏画元件：明细表里有、图上没画（或引脚没落点）→ 不可交付', () => {
  const base = buildMachineCircuit(SPEC);
  const extra = {
    ...base,
    devices: [...base.devices, { tag: '-HL9', kind: 'lamp', name: '故障灯', model: 'XB2', spec: '24V', pins: ['1', '2'] }],
    nets: base.nets.map((net) => (net.label === '+24V' ? { ...net, pins: [...net.pins, '-HL9:1'] } : net.label === '0V' ? { ...net, pins: [...net.pins, '-HL9:2'] } : net))
  };
  const sheet = renderSheet(extra, OPTS);
  assert.equal(sheet.deliverable, false);
  for (const code of ['[DEVICE_NOT_PLACED] -HL9', '[PIN_NOT_DRAWN] -HL9', '[BOM_NOT_DRAWN] 明细表里有 -HL9']) {
    assert.ok(sheet.problems.some((p) => p.startsWith(code)), `缺 ${code}：\n${sheet.problems.join('\n')}`);
  }
  assert.ok(!sheet.svg.includes('校验通过'), '有问题时标题栏不得写“校验通过”');
  assert.ok(sheet.svg.includes('有待处理问题') && sheet.svg.includes('出图前校验'));
});

/* ---------------- 6. 明细表 ---------------- */

test('明细表按位号去重：-KM1/-FR1 各 1 件，名称取主符号；断路器名称与型号系列一致', () => {
  const circuit = buildMachineCircuit(SPEC);
  const rows = bomRows(circuit);
  const tags = rows.map((r) => r.tag);
  assert.equal(new Set(tags).size, tags.length);
  assert.ok(rows.every((r) => r.qty === 1), JSON.stringify(rows.map((r) => [r.tag, r.qty])));
  assert.equal(rows.find((r) => r.tag === '-KM1').name, '交流接触器');
  assert.equal(rows.find((r) => r.tag === '-FR1').name, '热过载继电器');
  assert.ok(!tags.includes('-KM1A') && !tags.includes('-FR1NC'));
  assert.equal(rows.find((r) => r.tag === '-QF1').name, '微型断路器');
  assert.equal(breakerNameFor('GV2ME08'), '电机保护断路器');
  assert.equal(breakerNameFor('iC65N 3P C1'), '微型断路器');

  const sheet = renderSheet(circuit, OPTS);
  const qtyCells = sheet.prims.filter((p) => p.t === 'text' && p.layer === 'table' && p.anchor === 'end' && p.value !== '数量');
  assert.equal(qtyCells.length, rows.length);
  assert.ok(qtyCells.every((p) => p.value === '1'));

  const wrongName = { ...circuit, devices: circuit.devices.map((d) => (d.tag === '-QF1' ? { ...d, name: '电机保护断路器' } : d)) };
  const bad = renderSheet(wrongName, OPTS);
  assert.equal(bad.deliverable, false);
  assert.ok(bad.problems.some((p) => p.startsWith('[BOM_NAME_MODEL] -QF1')));
});

/* ---------------- 7. 标题栏 / 说明 / 图幅 ---------------- */

test('标题栏：日期、状态（两种文字）都不压格线；说明全部显示，超过 4 条注明省略', () => {
  const sheet = renderSheet(buildMachineCircuit(SPEC), OPTS);
  const titleLines = sheet.prims.filter((p) => p.layer === 'title' && (p.t === 'line' || p.t === 'rect'));
  const titleTexts = sheet.prims.filter((p) => p.layer === 'title' && p.t === 'text');
  const date = titleTexts.find((t) => t.value === '2026-10-25');
  assert.ok(date);
  for (const t of titleTexts) {
    const b = shrink(textBox(t), 0.1);
    for (const l of titleLines) {
      const hit = l.t === 'line' ? segHitsBox(l.x1, l.y1, l.x2, l.y2, b)
        : [[l.x, l.y, l.x + l.w, l.y], [l.x + l.w, l.y, l.x + l.w, l.y + l.h], [l.x, l.y + l.h, l.x + l.w, l.y + l.h], [l.x, l.y, l.x, l.y + l.h]].some(([a, c, d, e]) => segHitsBox(a, c, d, e, b));
      assert.equal(hit, false, `标题栏文字“${t.value}”压线`);
    }
  }
  for (const note of OPTS.notes) assert.ok(sheet.svg.includes(note), `说明缺：${note}`);
  const many = renderSheet(buildMachineCircuit(SPEC), { ...OPTS, notes: ['一', '二', '三', '四', '五', '六'] });
  assert.ok(many.svg.includes('1. 一') && many.svg.includes('4. 四') && many.svg.includes('另有 2 条略'));
});

test('图幅利用：主回路纵向铺开、控制回路占满右侧，不再挤在左上角', () => {
  const layout = layoutCircuit(buildMachineCircuit(SPEC));
  const main = layout.symbols.filter((s) => ['breaker', 'contactor', 'thermal', 'motor'].includes(s.kind));
  const ctrl = layout.symbols.filter((s) => !['breaker', 'contactor', 'thermal', 'motor'].includes(s.kind));
  const span = (list, f) => Math.max(...list.map((s) => f(s) + (f === xOf ? s.box.w : s.box.h))) - Math.min(...list.map(f));
  const xOf = (s) => s.box.x;
  const yOf = (s) => s.box.y;
  assert.ok(span(main, yOf) > 140, `主回路纵向只占 ${span(main, yOf)} mm`);
  assert.ok(span(ctrl, yOf) > 140, `控制回路纵向只占 ${span(ctrl, yOf)} mm`);
  assert.ok(span(ctrl, xOf) > 160, `控制回路横向只占 ${span(ctrl, xOf)} mm`);
});

/* ---------------- 8. 其他输入 ---------------- */

for (const [name, spec] of Object.entries(VARIANTS)) {
  test(`其他输入：${name} —— ERC 零问题、图面自检全过、可交付`, () => {
    const circuit = buildMachineCircuit(spec);
    assert.deepEqual(runErc(circuit), []);
    const sheet = renderSheet(circuit, { ...OPTS, project: spec.project });
    assert.deepEqual(sheet.problems, []);
    assert.equal(sheet.deliverable, true);
    const layout = layoutCircuit(circuit);
    for (const s of spec.sensors) assert.ok(sym(layout, s.tag), `${s.tag} 未画`);
    assert.equal(Boolean(sym(layout, '-HL1')), spec.controls.lamp);
    // 无指示灯时 PLC 不应留一个悬空的 Q0.0
    assert.equal(circuit.devices.find((d) => d.kind === 'plc').pins.includes('Q0.0'), spec.controls.lamp);
  });
}

test('IO 超出单页容量时如实报 IO_TOO_DENSE，不硬挤', () => {
  const spec = { ...SPEC, sensors: Array.from({ length: 9 }, (_, i) => ({ tag: `-PE${i + 1}`, label: `检测${i + 1}`, address: `I${Math.floor(i / 8)}.${i % 8}` })) };
  const sheet = renderSheet(buildMachineCircuit(spec), OPTS);
  assert.equal(sheet.deliverable, false);
  assert.ok(sheet.problems.some((p) => p.startsWith('[IO_TOO_DENSE]')));
});
