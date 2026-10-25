/**
 * 分页版面：主回路页 / 控制回路页 / PLC 输入页 / PLC 输出页。
 *
 * 每类页都按“数量”排：主回路一路负载占一列（每页 7 路），控制回路按电流路径成块左右排，
 * IO 每页 14 点；放不下就开下一页，母线/电位在页边断开并留出口（交叉引用在出图阶段写）。
 * 版面只产出几何与文字请求，不碰线号、页码——那些要等全部页排完才确定。
 */

import type { Circuit, CircuitDevice } from './circuit.ts';
import { PIN } from './circuit.ts';
import type { ElecBuild, InputColumn, LadderStep, OutputColumn, PowerBranch, SafetyBlock } from './build.ts';
import { SAFE_NET } from './build.ts';
import { PageCanvas, tagGroup } from './canvas.ts';
import { fitText, P, textWidth, type Pt, type TextPrim } from './geometry.ts';
import {
  boxSymbol,
  buzzerSymbol,
  coilSymbol,
  contactSymbol,
  fuseSymbol,
  lampSymbol,
  motorSymbol,
  MOTOR_H,
  multiPoleSymbol,
  sensor2Symbol,
  sensor3Symbol,
  SENSOR3_H,
  solenoidSymbol,
  terminalSymbol,
  TERMINAL_R,
  THREE_POLE_H,
  TWO_PIN_H,
  type Actuator,
  type SymbolGeom
} from './symbols.ts';

export interface LayoutContext {
  build: ElecBuild;
  pages: PageCanvas[];
  device: (tag: string) => CircuitDevice;
  netOf: (pin: string) => string;
  /** 交叉引用：位号 → “/页.列”（出图阶段填） */
  refOf: (tag: string) => string;
}

export function makeContext(build: ElecBuild): LayoutContext {
  const byTag = new Map(build.circuit.devices.map((device) => [device.tag, device]));
  const netOfPin = new Map<string, string>();
  for (const net of build.circuit.nets) for (const pin of net.pins) netOfPin.set(pin, net.id);
  const ctx: LayoutContext = {
    build,
    pages: [],
    device: (tag) => {
      const device = byTag.get(tag);
      if (!device) throw new Error(`版面引用了不存在的元件 ${tag}`);
      return device;
    },
    netOf: (pin) => netOfPin.get(pin) ?? `?${pin}`,
    refOf: (tag) => {
      for (const page of ctx.pages) {
        const ref = page.ref(tag);
        if (ref) return ref;
      }
      return '/?';
    }
  };
  return ctx;
}

/* ------------------------------------------------------------------ 通用：端子 / 竖向串联 */

/** 在 (x, yc) 放一个端子，返回其上下落点 */
function placeTerminal(ctx: LayoutContext, page: PageCanvas, tag: string, x: number, yc: number, numberSide: 'left' | 'right'): { i: Pt; o: Pt } {
  const device = ctx.device(tag);
  const geom = terminalSymbol(tag, x, yc, Boolean(device.terminal?.pe));
  page.place(device, geom);
  const no = String(device.terminal?.no ?? '?');
  const size = 2.1;
  const right: TextPrim = P.text(x + TERMINAL_R + 0.7, yc + 0.75, no, size, 'start', 'it-s', 'text', { owner: tag, role: 'terminal-no' });
  const left: TextPrim = P.text(x - TERMINAL_R - 0.7, yc + 0.75, no, size, 'end', 'it-s', 'text', { owner: tag, role: 'terminal-no' });
  const below: TextPrim = P.text(x + TERMINAL_R + 0.5, yc + 3.2, no, size, 'start', 'it-s', 'text', { owner: tag, role: 'terminal-no' });
  const above: TextPrim = P.text(x + TERMINAL_R + 0.5, yc - 1.6, no, size, 'start', 'it-s', 'text', { owner: tag, role: 'terminal-no' });
  page.label({
    candidates: numberSide === 'right' ? [[right], [left], [below], [above]] : [[left], [right], [below], [above]],
    what: `端子 ${device.terminal?.strip ?? ''}:${no}`
  });
  return { i: geom.pins.i as Pt, o: geom.pins.o as Pt };
}

/** 端子排位号：每组端子旁写一次 -X1 */
function terminalStripTag(page: PageCanvas, x: number, y: number, strip: string): void {
  const size = 2.4;
  const cands: TextPrim[][] = [];
  for (const dy of [0, -3, 3, -6, 6]) {
    cands.push([P.text(x - 2.2, y + dy + 0.9, strip, size, 'end', 'it-s', 'text', { owner: strip, role: 'tag' })]);
    cands.push([P.text(x + 2.2, y + dy + 0.9, strip, size, 'start', 'it-s', 'text', { owner: strip, role: 'tag' })]);
  }
  page.label({ candidates: cands, what: `端子排位号 ${strip}` });
}

function actuatorOf(ctx: LayoutContext, device: CircuitDevice): Actuator {
  if (device.kind !== 'no' && device.kind !== 'nc') return 'none';
  if (device.displayTag) {
    const owner = ctx.build.circuit.devices.find((item) => item.tag === device.displayTag);
    if (owner?.kind === 'thermal') return 'thermal';
    if (owner?.kind === 'nc' && /急停/.test(owner.name)) return 'estop';
    return 'none';
  }
  if (/急停/.test(device.name)) return 'estop';
  return device.field ? 'push' : 'none';
}

function twoPinGeom(ctx: LayoutContext, device: CircuitDevice, x: number, yc: number, pins: [string, string]): SymbolGeom {
  switch (device.kind) {
    case 'coil':
      return coilSymbol(device.tag, x, yc, pins);
    case 'fuse':
      return fuseSymbol(device.tag, x, yc, pins);
    case 'solenoid':
      return solenoidSymbol(device.tag, x, yc, pins);
    case 'lamp':
      return lampSymbol(device.tag, x, yc, pins);
    case 'buzzer':
      return buzzerSymbol(device.tag, x, yc, pins);
    default:
      return contactSymbol(device.tag, device.kind === 'nc' ? 'nc' : 'no', x, yc, pins, actuatorOf(ctx, device));
  }
}

/** 位号下方的短说明 */
function shortRole(ctx: LayoutContext, device: CircuitDevice): string {
  if (device.displayTag) {
    const owner = ctx.build.circuit.devices.find((item) => item.tag === device.displayTag);
    if (owner?.kind === 'thermal') return device.pins.join('-');
    if (owner?.kind === 'contactor') return device.kind === 'coil' ? '线圈' : `自锁 ${device.pins.join('-')}`;
    if (owner?.kind === 'safety') return `安全 ${device.pins.join('-')}`;
    if (owner?.kind === 'coil') return `触点 ${device.pins.join('-')}`;
    if (owner?.kind === 'nc') return `急停 ${device.pins.join('-')}`;
    return device.pins.join('-');
  }
  if (device.kind === 'fuse') return device.spec;
  if (/急停/.test(device.name)) return `急停 ${device.pins.join('-')}`;
  if (device.purpose && device.field) return device.purpose;
  return device.name.replace(/（.*?）|\(.*?\)/g, '').replace(/按钮$/, '');
}

/** 两端元件的标注：右侧优先，放不下换左侧（说明行可能含交叉引用，等分页完成后再生成） */
function labelTwoPin(ctx: LayoutContext, page: PageCanvas, device: CircuitDevice, x: number, yc: number, lines: () => string[], maxW = 15): void {
  const tag = device.displayTag ?? device.tag;
  page.label({
    candidates: [],
    resolve: () => {
      const fitted = lines().map((line) => fitText(line, maxW, 2.3));
      const cands: TextPrim[][] = [];
      for (const dy of [-1.5, -4, 1, -6.5, 3.5]) {
        cands.push(tagGroup(device.tag, x + 5.2, yc + dy, tag, fitted));
        cands.push(tagGroup(device.tag, x - 9.5, yc + dy, tag, fitted, 'end'));
      }
      return cands;
    },
    what: `${tag} 位号`
  });
  void ctx;
}

type Element =
  | { kind: 'device'; tag: string; pins: [string, string] }
  | { kind: 'parallel'; items: Array<{ tag: string; pins: [string, string] }> };

interface ChainResult {
  end: Pt;
  bottom: number;
}

const PARALLEL_PITCH = 26;

/**
 * 竖向串联（含并联段）：从 start 出发往下画，现场元件引脚按端子表自动插端子。
 * 返回末端落点。并联段各支路右排，上下汇流母线横跨。
 */
function drawChain(ctx: LayoutContext, page: PageCanvas, start: Pt, elements: readonly Element[], options: { extraLines?: (tag: string) => string[] } = {}): ChainResult {
  const terminalOf = ctx.build.plan.terminalOf;
  const x = start[0];
  let prev: Pt = start;
  let cursor = start[1];
  const column = (cx: number, from: Pt, top: number, item: { tag: string; pins: [string, string] }): { end: Pt; bottom: number } => {
    const device = ctx.device(item.tag);
    let p: Pt = from;
    let y = top;
    const tIn = terminalOf[PIN(item.tag, item.pins[0])];
    if (tIn) {
      const t = placeTerminal(ctx, page, tIn, cx, y + 3.5, 'right');
      page.wire(ctx.netOf(PIN(item.tag, item.pins[0])), p, t.i);
      p = t.o;
      y += 3.5 + TERMINAL_R;
      terminalStripTag(page, cx, y - TERMINAL_R, ctx.device(tIn).terminal?.strip ?? '-X1');
    }
    const yc = y + (tIn ? 3 : 6) + TWO_PIN_H / 2;
    const geom = twoPinGeom(ctx, device, cx, yc, item.pins);
    page.place(device, geom);
    page.wire(ctx.netOf(PIN(item.tag, item.pins[0])), p, geom.pins[item.pins[0]] as Pt);
    labelTwoPin(ctx, page, device, cx, yc, () => [shortRole(ctx, device), ...(options.extraLines?.(item.tag) ?? [])]);
    p = geom.pins[item.pins[1]] as Pt;
    y = yc + TWO_PIN_H / 2;
    const tOut = terminalOf[PIN(item.tag, item.pins[1])];
    if (tOut) {
      const t = placeTerminal(ctx, page, tOut, cx, y + 3.5, 'right');
      page.wire(ctx.netOf(PIN(item.tag, item.pins[1])), p, t.i);
      p = t.o;
      y += 3.5 + TERMINAL_R;
    }
    return { end: p, bottom: y };
  };
  for (const element of elements) {
    if (element.kind === 'device') {
      const result = column(x, prev, cursor, element);
      prev = result.end;
      cursor = result.bottom;
      continue;
    }
    // 并联：上汇流线
    const busTop = cursor + 3.5;
    const firstIn = PIN(element.items[0]?.tag ?? '', element.items[0]?.pins[0] ?? '');
    const netIn = ctx.netOf(firstIn);
    const lastX = x + PARALLEL_PITCH * (element.items.length - 1);
    page.wire(netIn, prev, [x, busTop]);
    page.wire(netIn, [x, busTop], [lastX, busTop]);
    const ends: Array<{ end: Pt; bottom: number }> = element.items.map((item, i) => column(x + PARALLEL_PITCH * i, [x + PARALLEL_PITCH * i, busTop], busTop, item));
    const busBottom = Math.max(...ends.map((item) => item.bottom)) + 3.5;
    const lastItem = element.items[element.items.length - 1] as { tag: string; pins: [string, string] };
    const netOut = ctx.netOf(PIN(lastItem.tag, lastItem.pins[1]));
    ends.forEach((item) => page.wire(netOut, item.end, [item.end[0], busBottom]));
    page.wire(netOut, [x, busBottom], [lastX, busBottom]);
    prev = [x, busBottom];
    cursor = busBottom;
  }
  return { end: prev, bottom: cursor };
}

/** 估算竖向串联高度（不画） */
function chainHeight(ctx: LayoutContext, elements: readonly Element[]): number {
  const terminalOf = ctx.build.plan.terminalOf;
  const col = (item: { tag: string; pins: [string, string] }): number =>
    (terminalOf[PIN(item.tag, item.pins[0])] ? 3.5 + TERMINAL_R + 3 : 6) + TWO_PIN_H + (terminalOf[PIN(item.tag, item.pins[1])] ? 3.5 + TERMINAL_R : 0);
  return elements.reduce((sum, element) => sum + (element.kind === 'device' ? col(element) : 7 + Math.max(...element.items.map(col))), 0);
}

function stepsToElements(ctx: LayoutContext, steps: readonly LadderStep[], coil?: string): Element[] {
  const pinsOf = (tag: string): [string, string] => {
    const device = ctx.device(tag);
    return [device.pins[0] as string, device.pins[1] as string];
  };
  const out: Element[] = steps.map((step) =>
    step.kind === 'series'
      ? { kind: 'device', tag: step.tag, pins: pinsOf(step.tag) }
      : { kind: 'parallel', items: step.tags.map((tag) => ({ tag, pins: pinsOf(tag) })) }
  );
  if (coil) out.push({ kind: 'device', tag: coil, pins: pinsOf(coil) });
  return out;
}

/** 页脚说明（列下方的用途/触点镜像）；内容可能含交叉引用，延后生成 */
function footer(page: PageCanvas, x: number, y: number, lines: () => readonly string[], width: number, owner: string): void {
  const size = 2.1;
  page.label({
    candidates: [],
    resolve: () => {
      const shown = lines().filter(Boolean).slice(0, 5).map((line) => fitText(line, width, size));
      const group = shown.map((line, i) => P.text(x, y + i * 3, line, size, 'middle', 'it-s', 'text', { owner, role: 'footer' }));
      const shifted = shown.map((line, i) => P.text(x, y + 1.5 + i * 3, line, size, 'middle', 'it-s', 'text', { owner, role: 'footer' }));
      return [group, shifted];
    },
    what: `${owner} 页脚说明`,
    area: { x: 11, y: 24, w: 398, h: 216 }
  });
}

/** 电位母线名（L1/N/PE/24V/0V）：每页每条母线写一次 */
function railName(page: PageCanvas, net: string, x: number, y: number, text: string): void {
  if (page.fixedLabels.has(net)) return;
  page.fixedLabels.add(net);
  const cands: TextPrim[][] = [];
  for (const dx of [0, 6, 12, 18, 26]) cands.push([P.text(x + dx, y - 1.1, text, 3, 'start', 'it', 'text', { owner: net, role: 'wire-no' })]);
  for (const dx of [0, 6, 12]) cands.push([P.text(x + dx, y + 3.4, text, 3, 'start', 'it', 'text', { owner: net, role: 'wire-no' })]);
  page.label({ candidates: cands, what: `母线 ${text} 名称` });
}

function fixedName(net: string): string {
  return net === '+24V' ? '24V' : net;
}

/* ================================================================== 主回路页 */

const BRANCHES_PER_PAGE = 7;
const BUS_Y: Record<string, number> = { 'BUS-L1': 62, 'BUS-L2': 66, 'BUS-L3': 70, N: 74 };
const PE_Y = 228;
const BRANCH_Y0 = 86;

export function layoutPowerPages(ctx: LayoutContext): void {
  const { plan } = ctx.build;
  const chunks: PowerBranch[][] = [];
  for (let i = 0; i < plan.branches.length; i += BRANCHES_PER_PAGE) chunks.push(plan.branches.slice(i, i + BRANCHES_PER_PAGE));
  if (chunks.length === 0) chunks.push([]);
  chunks.forEach((chunk, pi) => {
    const page = new PageCanvas('power', chunks.length > 1 ? `主回路 AC 380V（${pi + 1}/${chunks.length}）` : '主回路 AC 380V 50Hz');
    ctx.pages.push(page);
    const more = pi < chunks.length - 1;
    const lastSlotRight = 60 + 50 * Math.max(0, chunk.length - 1) + 22;
    const xEnd = more ? 404 : Math.max(lastSlotRight, 120);
    const buses = ['BUS-L1', 'BUS-L2', 'BUS-L3', 'N'];
    const busNet = (bus: string): string => (bus === 'N' ? 'N' : bus);
    if (pi === 0) {
      // 进线：PE / N / L1 L2 L3，总进线断路器 -QF0
      const xs: [number, number, number] = [30, 36, 42];
      const top = 30;
      for (const [net, x] of [['L1', 30], ['L2', 36], ['L3', 42], ['N', 22], ['PE', 16]] as const) page.stub({ net, at: [x, top], side: 'above', kind: 'supply' });
      (['L1', 'L2', 'L3'] as const).forEach((phase, i) => {
        page.wire(phase, [xs[i] as number, top], [xs[i] as number, 36]);
        page.fixedLabels.add(phase);
        page.label({ candidates: [[P.text(xs[i] as number, top - 1.2, phase, 2.8, 'middle', 'it', 'text', { owner: phase, role: 'wire-no' })]], what: `进线 ${phase}` });
      });
      const qf0 = ctx.device(plan.mainBreaker);
      const geom = multiPoleSymbol('breaker', qf0.tag, xs, 36, qf0.pins.slice(0, 3), qf0.pins.slice(3, 6));
      page.place(qf0, geom);
      page.label({ candidates: [tagGroup(qf0.tag, 46, 41, qf0.tag, [fitText(qf0.model, 40, 2.3), fitText(qf0.spec, 40, 2.3)])], what: `${qf0.tag} 位号` });
      buses.slice(0, 3).forEach((bus, i) => {
        const x = xs[i] as number;
        page.wire(bus, [x, 36 + THREE_POLE_H], [x, BUS_Y[bus] as number], [xEnd, BUS_Y[bus] as number]);
      });
      page.wire('N', [22, top], [22, BUS_Y.N as number], [xEnd, BUS_Y.N as number]);
      page.label({ candidates: [[P.text(22, top - 1.2, 'N', 2.8, 'middle', 'it', 'text', { owner: 'N', role: 'wire-no' })]], what: '进线 N' });
      page.fixedLabels.add('N');
      page.wire('PE', [16, top], [16, PE_Y], [xEnd, PE_Y]);
      page.label({ candidates: [[P.text(16, top - 1.2, 'PE', 2.8, 'middle', 'it', 'text', { owner: 'PE', role: 'wire-no' })]], what: '进线 PE' });
      page.fixedLabels.add('PE');
    } else {
      for (const bus of buses) {
        page.wire(busNet(bus), [14, BUS_Y[bus] as number], [xEnd, BUS_Y[bus] as number]);
        page.stub({ net: busNet(bus), at: [14, BUS_Y[bus] as number], side: 'above' });
      }
      page.wire('PE', [14, PE_Y], [xEnd, PE_Y]);
      page.stub({ net: 'PE', at: [14, PE_Y], side: 'above' });
      railName(page, 'N', 30, BUS_Y.N as number, 'N');
      railName(page, 'PE', 30, PE_Y, 'PE');
    }
    if (more) {
      for (const bus of buses) page.stub({ net: busNet(bus), at: [xEnd, BUS_Y[bus] as number], side: 'above' });
      page.stub({ net: 'PE', at: [xEnd, PE_Y], side: 'above' });
    }
    chunk.forEach((branch, k) => drawBranch(ctx, page, branch, 60 + 50 * k));
  });
}

function drawBranch(ctx: LayoutContext, page: PageCanvas, branch: PowerBranch, c: number): void {
  const xs: [number, number, number] = [c + 7, c + 13, c + 19];
  const labelX = c + 24;
  const labelW = 25;
  const fit = (value: string): string => fitText(value, labelW, 2.3);
  const breaker = ctx.device(branch.breaker);
  const poles = branch.poles;
  // 母线 T 接到断路器
  const sources: string[] = poles === 3 ? ['BUS-L1', 'BUS-L2', 'BUS-L3'] : [`BUS-${branch.phase ?? 'L1'}`, 'N'];
  for (let i = 0; i < poles; i += 1) {
    const bus = sources[i] as string;
    page.wire(bus, [xs[i] as number, BUS_Y[bus] as number], [xs[i] as number, BRANCH_Y0]);
  }
  const bGeom = multiPoleSymbol('breaker', breaker.tag, xs.slice(0, poles), BRANCH_Y0, breaker.pins.slice(0, poles), breaker.pins.slice(poles, poles * 2));
  page.place(breaker, bGeom);
  page.label({ candidates: [tagGroup(breaker.tag, labelX, BRANCH_Y0 + 5, breaker.tag, [fit(breaker.model), fit(breaker.spec)])], what: `${breaker.tag} 位号` });
  let y = BRANCH_Y0 + THREE_POLE_H;
  const outPins = breaker.pins.slice(poles, poles * 2);
  let tops: Pt[] = outPins.map((pin) => bGeom.pins[pin] as Pt);
  const step = (fromPins: string[], toTag: string, toPins: string[]): void => {
    toPins.forEach((pin, i) => {
      const from = tops[i];
      const geomPin = page.symbols.find((s) => s.tag === toTag)?.pins[pin];
      if (from && geomPin) page.wire(ctx.netOf(PIN(toTag, pin)), from, geomPin);
    });
    void fromPins;
  };

  if (branch.kind === 'dol') {
    const km = ctx.device(branch.contactor as string);
    const fr = ctx.device(branch.thermal as string);
    y += 8;
    const kmGeom = multiPoleSymbol('contactor', km.tag, xs, y, km.pins.slice(0, 3), km.pins.slice(3));
    page.place(km, kmGeom);
    step(outPins, km.tag, km.pins.slice(0, 3));
    const ykm = y;
    page.label({ candidates: [], resolve: () => [tagGroup(km.tag, labelX, ykm + 5, km.tag, [fit(km.model), `线圈 ${ctx.refOf(`${km.tag}K`)}`])], what: `${km.tag} 位号` });
    tops = km.pins.slice(3).map((pin) => kmGeom.pins[pin] as Pt);
    const yk = y;
    y += THREE_POLE_H + 8;
    const frGeom = multiPoleSymbol('thermal', fr.tag, xs, y, fr.pins.slice(0, 3), fr.pins.slice(3));
    page.place(fr, frGeom);
    step([], fr.tag, fr.pins.slice(0, 3));
    const yf = y;
    page.label({ candidates: [], resolve: () => [tagGroup(fr.tag, labelX, yf + 5, fr.tag, [fit(fr.model), fit(fr.spec), `95-96 ${ctx.refOf(`${fr.tag}NC`)}`])], what: `${fr.tag} 位号` });
    tops = fr.pins.slice(3).map((pin) => frGeom.pins[pin] as Pt);
    y += THREE_POLE_H;
    void yk;
  } else if (branch.kind === 'vfd' || branch.kind === 'servo') {
    const drive = ctx.device(branch.drive as string);
    y += 8;
    const inPins = branch.kind === 'vfd' ? ['L1', 'L2', 'L3'] : ['L', 'N'];
    const box = { x: xs[0] - 5, y, w: xs[2] - xs[0] + 10, h: 26 };
    const geom = boxSymbol(drive.tag, box, [
      ...inPins.map((pin, i) => ({ pin, at: xs[i] as number, edge: 'top' as const })),
      ...['U', 'V', 'W'].map((pin, i) => ({ pin, at: xs[i] as number, edge: 'bottom' as const }))
    ], [{ x: box.x + box.w / 2, y: box.y + 14.6, value: branch.kind === 'vfd' ? '变频' : '伺服', size: 2.6, anchor: 'middle' }]);
    page.place(drive, geom);
    if (branch.kind === 'servo' && poles === 1) {
      // 单极断路器只断相线，N 直接从 N 母线取
      page.wire('N', [xs[1], BUS_Y.N as number], geom.pins.N as Pt);
    }
    inPins.forEach((pin, i) => {
      if (branch.kind === 'servo' && poles === 1 && pin === 'N') return;
      const from = tops[i];
      if (from) page.wire(ctx.netOf(PIN(drive.tag, pin)), from, geom.pins[pin] as Pt);
    });
    const yd = y;
    const fitD = (value: string): string => fitText(value, 21, 2.3);
    page.label({
      candidates: [],
      resolve: () => [0, 4, -3].map((dy) => tagGroup(drive.tag, box.x + box.w + 2, yd + 5 + dy, drive.tag, [fitD(drive.model), fitD(drive.spec), `控制 ${ctx.refOf(`${drive.tag}C`)}`])),
      what: `${drive.tag} 位号`
    });
    tops = ['U', 'V', 'W'].map((pin) => geom.pins[pin] as Pt);
    y += box.h;
  } else if (branch.kind === 'psu') {
    const psu = ctx.device(branch.psu as string);
    y += 8;
    const box = { x: xs[0] - 5, y, w: xs[1] - xs[0] + 10, h: 22 };
    const geom = boxSymbol(psu.tag, box, [
      { pin: 'L', at: xs[0], edge: 'top' },
      { pin: 'N', at: xs[1], edge: 'top' },
      { pin: '+', at: xs[0], edge: 'bottom' },
      { pin: '-', at: xs[1], edge: 'bottom', label: '−' }
    ], [{ x: box.x + box.w / 2, y: box.y + 12.4, value: 'DC', size: 2.4, anchor: 'middle' }]);
    page.place(psu, geom);
    if (poles === 1) page.wire('N', [xs[1], BUS_Y.N as number], geom.pins.N as Pt);
    ['L', 'N'].forEach((pin, i) => {
      if (poles === 1 && pin === 'N') return;
      const from = tops[i];
      if (from) page.wire(ctx.netOf(PIN(psu.tag, pin)), from, geom.pins[pin] as Pt);
    });
    page.label({ candidates: [tagGroup(psu.tag, labelX, y + 5, psu.tag, [fit(psu.model), fit(psu.spec)])], what: `${psu.tag} 位号` });
    const plus = geom.pins['+'] as Pt;
    const minus = geom.pins['-'] as Pt;
    page.wire('+24V', plus, [plus[0], plus[1] + 18]);
    page.wire('0V', minus, [minus[0], minus[1] + 9]);
    page.stub({ net: '+24V', at: [plus[0], plus[1] + 18], side: 'below', prefix: '24V' });
    page.stub({ net: '0V', at: [minus[0], minus[1] + 9], side: 'right', prefix: '0V' });
    page.fixedLabels.add('+24V');
    page.fixedLabels.add('0V');
    return;
  }

  // 端子 → 电机
  const motor = ctx.device(branch.motor as string);
  const yT = 177;
  const motorTop = 184;
  ['U', 'V', 'W'].forEach((pin, i) => {
    const x = xs[i] as number;
    const t = ctx.build.plan.terminalOf[PIN(motor.tag, pin)];
    const from = tops[i] as Pt;
    if (t) {
      const term = placeTerminal(ctx, page, t, x, yT, 'right');
      page.wire(ctx.netOf(PIN(motor.tag, pin)), from, term.i);
      page.wire(ctx.netOf(PIN(motor.tag, pin)), term.o, [x, motorTop]);
    } else {
      page.wire(ctx.netOf(PIN(motor.tag, pin)), from, [x, motorTop]);
    }
  });
  terminalStripTag(page, xs[0], yT, '-X1');
  const mGeom = motorSymbol(motor.tag, xs, motorTop, motor.pins);
  page.place(motor, mGeom);
  page.label({
    candidates: [tagGroup(motor.tag, labelX, motorTop + 6, motor.tag, [fit(motor.purpose ?? motor.name), fit(motor.model), ...motor.spec.split(' · ').slice(0, 3).map(fit)])],
    what: `${motor.tag} 位号`
  });
  const pe = mGeom.pins.PE as Pt;
  const tPe = ctx.build.plan.terminalOf[PIN(motor.tag, 'PE')];
  const peBottom = motorTop + MOTOR_H;
  void peBottom;
  if (tPe) {
    const term = placeTerminal(ctx, page, tPe, pe[0], pe[1] + 4.6, 'right');
    page.wire('PE', pe, term.i);
    page.wire('PE', term.o, [pe[0], PE_Y]);
  } else {
    page.wire('PE', pe, [pe[0], PE_Y]);
  }
}

/* ================================================================== 控制回路页 */

const PLUS_Y = 36;
const ZERO_Y = 222;

interface Block {
  width: number;
  needsSafe: boolean;
  draw: (page: PageCanvas, x: number) => void;
}

export function layoutControlPages(ctx: LayoutContext): void {
  const { plan } = ctx.build;
  const chainEls: Element[] = [
    { kind: 'device', tag: plan.fuse, pins: ['1', '2'] },
    ...plan.chain.map((tag): Element => {
      const device = ctx.device(tag);
      return { kind: 'device', tag, pins: [device.pins[0] as string, device.pins[1] as string] };
    })
  ];
  const safeY = Math.max(96, PLUS_Y + chainHeight(ctx, chainEls) + 8);
  const blocks: Block[] = [];

  // 1) 熔断器 + 急停/安全输出 → 安全母线 S
  blocks.push({
    width: 34,
    needsSafe: true,
    draw: (page, x) => {
      const result = drawChain(ctx, page, [x, PLUS_Y], chainEls, {
        extraLines: (tag) => {
          const device = ctx.device(tag);
          return device.stopFunction && device.displayTag ? [ctx.refOf(device.displayTag)] : [];
        }
      });
      page.wire(SAFE_NET, result.end, [x, safeY]);
    }
  });

  // 2) 起保停：每条电流路径一块
  for (const rung of plan.rungs) {
    const els = stepsToElements(ctx, rung.steps, rung.coil);
    const parallel = Math.max(1, ...rung.steps.map((step) => (step.kind === 'parallel' ? step.tags.length : 1)));
    blocks.push({
      width: 30 + PARALLEL_PITCH * (parallel - 1),
      needsSafe: true,
      draw: (page, x) => {
        const need = chainHeight(ctx, els);
        if (safeY + need + 4 > ZERO_Y) page.problems.push(`[LADDER_TOO_LONG] ${rung.coil} 电流路径 ${els.length} 级，竖向放不下`);
        const result = drawChain(ctx, page, [x, safeY], els);
        page.wire('0V', result.end, [x, ZERO_Y]);
        const coil = ctx.device(rung.coil);
        footer(page, x, ZERO_Y + 5, () => mirrorLines(ctx, coil), 24, rung.coil);
      }
    });
  }

  // 3) 安全继电器
  for (const block of plan.safety) {
    blocks.push(block.kind === 'estop' ? estopBlock(ctx, block) : curtainBlock(ctx, block));
  }

  // 4) PLC 电源
  blocks.push({
    width: 46,
    needsSafe: false,
    draw: (page, x) => {
      const plc = ctx.device(plan.plc);
      const box = { x, y: 118, w: 36, h: 20 };
      const geom = boxSymbol(plc.tag, box, [
        { pin: 'L+', at: x + 7, edge: 'top' },
        { pin: 'M', at: x + 7, edge: 'bottom' }
      ], [
        { x: x + 13, y: 128.4, value: plc.tag, size: 3, role: 'tag' },
        { x: x + 13, y: 132.6, value: fitText('CPU 电源', 21, 2.2), size: 2.2, role: 'desc' }
      ]);
      page.place(plc, geom);
      page.wire('+24V', [x + 7, PLUS_Y], geom.pins['L+'] as Pt);
      page.wire('0V', geom.pins.M as Pt, [x + 7, ZERO_Y]);
      page.label({ candidates: [tagGroup(plc.tag, x + 9, 143, '', [fitText(plc.model, 34, 2.3)]), tagGroup(plc.tag, x + 9, 115, '', [fitText(plc.model, 34, 2.3)])], what: `${plc.tag} 型号` });
    }
  });

  // 分页：从左往右排，放不下开下一页
  const pagesBlocks: Block[][] = [[]];
  let cursor = 24;
  for (const block of blocks) {
    if (cursor + block.width > 404 && (pagesBlocks[pagesBlocks.length - 1] ?? []).length > 0) {
      pagesBlocks.push([]);
      cursor = 30;
    }
    (pagesBlocks[pagesBlocks.length - 1] as Block[]).push(block);
    cursor += block.width;
  }
  const safeUsedLater = ctx.build.plan.outputs.length > 0;
  pagesBlocks.forEach((list, pi) => {
    const page = new PageCanvas('control', pagesBlocks.length > 1 ? `控制回路 DC 24V（${pi + 1}/${pagesBlocks.length}）` : '控制回路 DC 24V');
    ctx.pages.push(page);
    let x = pi === 0 ? 24 : 30;
    let safeRight = -Infinity;
    let safeLeft = Infinity;
    for (const block of list) {
      block.draw(page, x);
      if (block.needsSafe) {
        safeLeft = Math.min(safeLeft, x);
        safeRight = Math.max(safeRight, x);
      }
      x += block.width;
    }
    // 母线
    page.wire('+24V', [14, PLUS_Y], [404, PLUS_Y]);
    page.wire('0V', [14, ZERO_Y], [404, ZERO_Y]);
    page.stub({ net: '+24V', at: [14, PLUS_Y], side: 'above' });
    page.stub({ net: '0V', at: [14, ZERO_Y], side: 'below' });
    railName(page, '+24V', 30, PLUS_Y, '24V');
    railName(page, '0V', 30, ZERO_Y, '0V');
    const safeContinues = pi < pagesBlocks.length - 1 ? pagesBlocks.slice(pi + 1).some((items) => items.some((block) => block.needsSafe)) || safeUsedLater : safeUsedLater;
    if (safeLeft !== Infinity) {
      const left = pi === 0 ? safeLeft : 14;
      const right = Math.max(safeRight, left) + (safeContinues ? 18 : 0);
      if (right > left) page.wire(SAFE_NET, [left, safeY], [right, safeY]);
      if (pi > 0) page.stub({ net: SAFE_NET, at: [14, safeY], side: 'above' });
      if (safeContinues) page.stub({ net: SAFE_NET, at: [right, safeY], side: 'right' });
    }
  });
}

/** 线圈下方的触点镜像：主触点/辅助触点所在“页.列” */
function mirrorLines(ctx: LayoutContext, coil: CircuitDevice): string[] {
  const owner = coil.displayTag ?? coil.tag;
  const lines: string[] = [owner];
  const main = ctx.build.circuit.devices.find((device) => device.tag === owner && device.kind === 'contactor');
  if (main) lines.push(`主 1-6 ${ctx.refOf(main.tag)}`);
  for (const contact of ctx.build.circuit.devices.filter((device) => device.displayTag === owner && (device.kind === 'no' || device.kind === 'nc'))) {
    lines.push(`${contact.pins.join('-')} ${ctx.refOf(contact.tag)}`);
  }
  return lines;
}

function estopBlock(ctx: LayoutContext, block: SafetyBlock): Block {
  const relay = ctx.device(block.relay);
  const offsets = { A1: 0, S11: 10, S12: 24, S21: 44, S22: 58, S33: 78, S34: 92 } as const;
  return {
    width: 122,
    needsSafe: false,
    draw: (page, x) => {
      const x0 = x + 4;
      const boxY = 172;
      const box = { x: x0 - 4, y: boxY, w: 100, h: 20 };
      const terms = (Object.entries(offsets) as Array<[string, number]>).map(([pin, dx]) => ({ pin, at: x0 + dx, edge: 'top' as const }));
      const bottom = [{ pin: 'A2', at: x0, edge: 'bottom' as const }, ...(relay.pins.includes('Y32') ? [{ pin: 'Y32', at: x0 + 10, edge: 'bottom' as const }] : [])];
      const geom = boxSymbol(relay.tag, box, [...terms, ...bottom], [
        { x: x0 + 22, y: boxY + 11.4, value: relay.tag, size: 3, role: 'tag' },
        { x: x0 + 36, y: boxY + 11.4, value: fitText(`${relay.model} · 急停`, 52, 2.3), size: 2.3, role: 'desc' }
      ]);
      page.place(relay, geom);
      page.wire('+24V', [x0, PLUS_Y], geom.pins.A1 as Pt);
      page.wire('0V', geom.pins.A2 as Pt, [x0, ZERO_Y]);
      const loop = (from: 'S11' | 'S21' | 'S33', to: 'S12' | 'S22' | 'S34', tags: string[], pins: [string, string]): void => {
        const els: Element[] = tags.map((tag) => ({ kind: 'device', tag, pins }));
        const h = chainHeight(ctx, els);
        const top = boxY - h - 6;
        if (top < PLUS_Y + 8) page.problems.push(`[LADDER_TOO_LONG] ${relay.tag} ${from}-${to} 回路 ${tags.length} 个触点，竖向放不下`);
        const fx = x0 + offsets[from];
        const tx = x0 + offsets[to];
        const firstNet = ctx.netOf(PIN(relay.tag, from));
        page.wire(firstNet, geom.pins[from] as Pt, [fx, top], [tx, top]);
        const result = drawChain(ctx, page, [tx, top], els);
        page.wire(ctx.netOf(PIN(relay.tag, to)), result.end, geom.pins[to] as Pt);
      };
      loop('S11', 'S12', block.channels[0] ?? [], ['11', '12']);
      loop('S21', 'S22', block.channels[1] ?? [], ['21', '22']);
      loop('S33', 'S34', [block.reset], ['13', '14']);
      if (relay.pins.includes('Y32')) {
        const y32 = geom.pins.Y32 as Pt;
        page.wire(ctx.netOf(PIN(relay.tag, 'Y32')), y32, [y32[0], y32[1] + 12]);
        page.stub({ net: ctx.netOf(PIN(relay.tag, 'Y32')), at: [y32[0], y32[1] + 12], side: 'right', prefix: 'Y32' });
      }
      footer(page, x0 + 46, ZERO_Y + 5, () => [`安全输出 13-14 ${ctx.refOf(`${relay.tag}Q`)}`], 60, relay.tag);
    }
  };
}

function curtainBlock(ctx: LayoutContext, block: SafetyBlock): Block {
  const relay = ctx.device(block.relay);
  const curtain = ctx.device(block.curtain as string);
  const offsets = { A1: 0, S12: 14, S22: 28, S33: 48, S34: 62 } as const;
  return {
    width: 106,
    needsSafe: false,
    draw: (page, x) => {
      const x0 = x + 4;
      const boxY = 172;
      const box = { x: x0 - 4, y: boxY, w: 70, h: 20 };
      const terms = (Object.entries(offsets) as Array<[string, number]>).map(([pin, dx]) => ({ pin, at: x0 + dx, edge: 'top' as const }));
      const bottom = [{ pin: 'A2', at: x0, edge: 'bottom' as const }, ...(relay.pins.includes('Y32') ? [{ pin: 'Y32', at: x0 + 14, edge: 'bottom' as const }] : [])];
      const geom = boxSymbol(relay.tag, box, [...terms, ...bottom], [
        { x: x0 + 22, y: boxY + 11.4, value: relay.tag, size: 3, role: 'tag' },
        { x: x0 + 36, y: boxY + 11.4, value: fitText(`${relay.model} · 光栅`, 24, 2.3), size: 2.3, role: 'desc' }
      ]);
      page.place(relay, geom);
      page.wire('+24V', [x0, PLUS_Y], geom.pins.A1 as Pt);
      page.wire('0V', geom.pins.A2 as Pt, [x0, ZERO_Y]);
      // 光栅接收器框：上 +/−，下 OSSD1/OSSD2
      const cBox = { x: x0 + 8, y: 92, w: 26, h: 18 };
      const cGeom = boxSymbol(curtain.tag, cBox, [
        { pin: '+', at: x0 + 14, edge: 'top' },
        { pin: '-', at: x0 + 28, edge: 'top', label: '−' },
        { pin: 'OSSD1', at: x0 + 14, edge: 'bottom', label: 'O1' },
        { pin: 'OSSD2', at: x0 + 28, edge: 'bottom', label: 'O2' }
      ], [{ x: cBox.x + cBox.w / 2, y: cBox.y + 10.2, value: '光栅', size: 2.4, anchor: 'middle' }]);
      page.place(curtain, cGeom);
      page.label({
        candidates: [tagGroup(curtain.tag, cBox.x + cBox.w + 2, cBox.y + 4, curtain.tag, [fitText(curtain.purpose ?? curtain.name, 26, 2.3), fitText(curtain.model, 26, 2.3)])],
        what: `${curtain.tag} 位号`
      });
      const term = (pin: string, at: Pt, down: boolean): Pt => {
        const t = ctx.build.plan.terminalOf[PIN(curtain.tag, pin)];
        if (!t) return at;
        const yc = down ? at[1] + 4.6 : at[1] - 4.6;
        const tt = placeTerminal(ctx, page, t, at[0], yc, 'right');
        page.wire(ctx.netOf(PIN(curtain.tag, pin)), at, down ? tt.i : tt.o);
        return down ? tt.o : tt.i;
      };
      const plus = term('+', cGeom.pins['+'] as Pt, false);
      page.wire('+24V', plus, [plus[0], PLUS_Y]);
      const minus = term('-', cGeom.pins['-'] as Pt, false);
      const rx = x0 + 84;
      page.wire('0V', minus, [minus[0], 84], [rx, 84], [rx, ZERO_Y]);
      for (const [pin, to] of [['OSSD1', 'S12'], ['OSSD2', 'S22']] as const) {
        const p = term(pin, cGeom.pins[pin] as Pt, true);
        page.wire(ctx.netOf(PIN(curtain.tag, pin)), p, geom.pins[to] as Pt);
      }
      terminalStripTag(page, x0 + 14, cBox.y - 4.6, '-X1');
      // 复位
      const els: Element[] = [{ kind: 'device', tag: block.reset, pins: ['13', '14'] }];
      const top = boxY - chainHeight(ctx, els) - 6;
      page.wire(ctx.netOf(PIN(relay.tag, 'S33')), geom.pins.S33 as Pt, [x0 + offsets.S33, top], [x0 + offsets.S34, top]);
      const result = drawChain(ctx, page, [x0 + offsets.S34, top], els);
      page.wire(ctx.netOf(PIN(relay.tag, 'S34')), result.end, geom.pins.S34 as Pt);
      if (relay.pins.includes('Y32')) {
        const y32 = geom.pins.Y32 as Pt;
        page.wire(ctx.netOf(PIN(relay.tag, 'Y32')), y32, [y32[0], y32[1] + 12]);
        page.stub({ net: ctx.netOf(PIN(relay.tag, 'Y32')), at: [y32[0], y32[1] + 12], side: 'right', prefix: 'Y32' });
      }
      footer(page, x0 + 31, ZERO_Y + 5, () => [`安全输出 13-14 ${ctx.refOf(`${relay.tag}Q`)}`], 56, relay.tag);
    }
  };
}

/* ================================================================== IO 页 */

export const IO_PER_PAGE = 14;
const IO_PITCH = 24.5;
const IO_X0 = 74;
const PLC_TOP = 40;
const PLC_BOTTOM = 54;
const IO_PLUS_Y = 196;
const IO_ZERO_Y = 204;

function plcFragment(ctx: LayoutContext, page: PageCanvas, columns: Array<{ pin: string; x: number }>, extra: Array<{ pin: string; x: number; edge: 'top' | 'bottom' }>, rightX: number, title: string): SymbolGeom {
  const plc = ctx.device(ctx.build.plan.plc);
  const box = { x: 16, y: PLC_TOP, w: rightX - 16, h: PLC_BOTTOM - PLC_TOP };
  const geom = boxSymbol(plc.tag, box, [
    ...extra.map((item) => ({ pin: item.pin, at: item.x, edge: item.edge })),
    ...columns.map((item) => ({ pin: item.pin, at: item.x, edge: 'bottom' as const }))
  ], [
    { x: 18, y: PLC_TOP + 5.6, value: plc.tag, size: 3, role: 'tag' },
    { x: 18, y: PLC_TOP + 9.6, value: fitText(plc.model, 30, 2.2), size: 2.2, role: 'desc' },
    { x: 18, y: PLC_TOP + 12.8, value: title, size: 2.2, role: 'desc' }
  ]);
  page.place(plc, geom);
  return geom;
}

export function layoutInputPages(ctx: LayoutContext): void {
  const { plan } = ctx.build;
  const chunks: InputColumn[][] = [];
  for (let i = 0; i < plan.inputs.length; i += IO_PER_PAGE) chunks.push(plan.inputs.slice(i, i + IO_PER_PAGE));
  chunks.forEach((chunk, pi) => {
    const page = new PageCanvas('input', `PLC 数字量输入（${chunk[0]?.address}…${chunk[chunk.length - 1]?.address}）`);
    ctx.pages.push(page);
    const xs = chunk.map((_, i) => IO_X0 + IO_PITCH * i);
    const rightX = (xs[xs.length - 1] ?? IO_X0) + 12;
    const common = pi === 0;
    const geom = plcFragment(ctx, page, chunk.map((col, i) => ({ pin: col.address, x: xs[i] as number })), common ? [{ pin: '1M', x: 62, edge: 'bottom' }] : [], rightX, '数字量输入');
    const railEnd = Math.max(rightX, 120);
    const usesPlus = chunk.some((col) => col.kind !== 'status') || (common && plan.inputCommon === '+24V');
    const usesZero = chunk.some((col) => col.kind === 'sensor3') || (common && plan.inputCommon === '0V');
    if (usesPlus) {
      page.wire('+24V', [14, IO_PLUS_Y], [railEnd, IO_PLUS_Y]);
      page.stub({ net: '+24V', at: [14, IO_PLUS_Y], side: 'above' });
      railName(page, '+24V', 30, IO_PLUS_Y, '24V');
    }
    if (usesZero) {
      page.wire('0V', [14, IO_ZERO_Y], [railEnd, IO_ZERO_Y]);
      page.stub({ net: '0V', at: [14, IO_ZERO_Y], side: 'below' });
      railName(page, '0V', 30, IO_ZERO_Y, '0V');
    }
    if (common) {
      const y = plan.inputCommon === '+24V' ? IO_PLUS_Y : IO_ZERO_Y;
      page.wire(plan.inputCommon, geom.pins['1M'] as Pt, [62, y]);
    }
    chunk.forEach((col, i) => drawInputColumn(ctx, page, col, xs[i] as number, geom.pins[col.address] as Pt));
  });
}

function drawInputColumn(ctx: LayoutContext, page: PageCanvas, col: InputColumn, x: number, pin: Pt): void {
  const { terminalOf } = ctx.build.plan;
  const signalNet = `IN-${col.address}`;
  const footLines = [col.purpose, col.point ?? ''];
  if (col.kind === 'status') {
    const end: Pt = [x, pin[1] + 30];
    page.wire(signalNet, pin, end);
    page.stub({ net: signalNet, at: end, side: 'below', prefix: `${col.tag}:Y32` });
    footer(page, x, IO_ZERO_Y + 8, () => footLines, IO_PITCH - 2, `in-${col.address}`);
    return;
  }
  const device = ctx.device(col.tag);
  const sigPin = col.kind === 'sensor3' ? 'OUT' : col.kind === 'sensor2' ? '-' : (device.pins[0] as string);
  const tSig = terminalOf[PIN(col.tag, sigPin)];
  let p: Pt = pin;
  if (tSig) {
    const t = placeTerminal(ctx, page, tSig, x, 66, 'right');
    page.wire(signalNet, p, t.i);
    p = t.o;
    terminalStripTag(page, x, 66, '-X1');
  }
  const top = 92;
  if (col.kind === 'sensor3') {
    const geom = sensor3Symbol(col.tag, x, top);
    page.place(device, geom);
    page.wire(signalNet, p, geom.pins.OUT as Pt);
    page.label({ candidates: [tagGroup(col.tag, x + 8.2, top + 5, col.tag, [fitText(device.spec.split('·')[0]?.trim() ?? '', 12, 2.3)]), tagGroup(col.tag, x + 8.2, top + 9, col.tag, [])], what: `${col.tag} 位号` });
    for (const [name, net, yc, side, rail] of [['+', '+24V', 140, 'left', IO_PLUS_Y], ['-', '0V', 152, 'right', IO_ZERO_Y]] as const) {
      const at = geom.pins[name] as Pt;
      const t = terminalOf[PIN(col.tag, name)];
      if (t) {
        const tt = placeTerminal(ctx, page, t, at[0], yc, side);
        page.wire(net, at, tt.i);
        page.wire(net, tt.o, [at[0], rail]);
      } else page.wire(net, at, [at[0], rail]);
    }
  } else {
    const yc = top + 6;
    let geom: SymbolGeom;
    let bottomPin: string;
    if (col.kind === 'sensor2') {
      geom = sensor2Symbol(col.tag, x, top);
      bottomPin = '+';
    } else {
      geom = twoPinGeom(ctx, device, x, yc, [device.pins[0] as string, device.pins[1] as string]);
      bottomPin = device.pins[1] as string;
    }
    page.place(device, geom);
    page.wire(signalNet, p, geom.pins[sigPin] as Pt);
    page.label({
      candidates: [tagGroup(col.tag, x + 6.6, top + 4.5, col.tag, [fitText(col.kind === 'sensor2' ? '两线' : shortRole(ctx, device), 12, 2.3)]), tagGroup(col.tag, x + 6.6, top + 9, col.tag, [])],
      what: `${col.tag} 位号`
    });
    const at = geom.pins[bottomPin] as Pt;
    const net = ctx.netOf(PIN(col.tag, bottomPin));
    const rail = net === '0V' ? IO_ZERO_Y : IO_PLUS_Y;
    const t = terminalOf[PIN(col.tag, bottomPin)];
    if (t) {
      const tt = placeTerminal(ctx, page, t, at[0], 140, 'right');
      page.wire(net, at, tt.i);
      page.wire(net, tt.o, [at[0], rail]);
    } else page.wire(net, at, [at[0], rail]);
  }
  footer(page, x, IO_ZERO_Y + 8, () => footLines, IO_PITCH - 2, `in-${col.address}`);
}

export function layoutOutputPages(ctx: LayoutContext): void {
  const { plan } = ctx.build;
  const chunks: OutputColumn[][] = [];
  for (let i = 0; i < plan.outputs.length; i += IO_PER_PAGE) chunks.push(plan.outputs.slice(i, i + IO_PER_PAGE));
  chunks.forEach((chunk, pi) => {
    const page = new PageCanvas('output', `PLC 数字量输出（${chunk[0]?.address}…${chunk[chunk.length - 1]?.address}）`);
    ctx.pages.push(page);
    const xs = chunk.map((_, i) => IO_X0 + IO_PITCH * i);
    const rightX = (xs[xs.length - 1] ?? IO_X0) + 12;
    const first = pi === 0;
    const geom = plcFragment(ctx, page, chunk.map((col, i) => ({ pin: col.address, x: xs[i] as number })), first ? [{ pin: '3L+', x: 54, edge: 'top' }, { pin: '3M', x: 62, edge: 'bottom' }] : [], rightX, '数字量输出');
    const railEnd = Math.max(rightX, 120);
    page.wire('0V', [14, IO_ZERO_Y], [railEnd, IO_ZERO_Y]);
    page.stub({ net: '0V', at: [14, IO_ZERO_Y], side: 'below' });
    railName(page, '0V', 30, IO_ZERO_Y, '0V');
    if (first) {
      const p = geom.pins['3L+'] as Pt;
      page.wire(SAFE_NET, p, [p[0], 30], [14, 30]);
      page.stub({ net: SAFE_NET, at: [14, 30], side: 'above' });
      page.wire('0V', geom.pins['3M'] as Pt, [62, IO_ZERO_Y]);
    }
    chunk.forEach((col, i) => drawOutputColumn(ctx, page, col, xs[i] as number, geom.pins[col.address] as Pt));
  });
}

function drawOutputColumn(ctx: LayoutContext, page: PageCanvas, col: OutputColumn, x: number, pin: Pt): void {
  const { terminalOf } = ctx.build.plan;
  const foot = [col.purpose, col.point ?? ''];
  if (col.kind === 'drive') {
    const tag = col.tags[0] as string;
    const device = ctx.device(tag);
    const [run, com] = device.pins as [string, string];
    const box = { x: x - 6, y: 90, w: 12, h: 18 };
    const geom = boxSymbol(tag, box, [{ pin: run, at: x, edge: 'top' }, { pin: com, at: x, edge: 'bottom' }]);
    page.place(device, geom);
    page.wire(ctx.netOf(PIN(tag, run)), pin, geom.pins[run] as Pt);
    page.wire('0V', geom.pins[com] as Pt, [x, IO_ZERO_Y]);
    page.label({
      candidates: [],
      resolve: () => [
        ...[96, 104, 88, 114].map((y) => tagGroup(tag, x + 7.6, y, device.displayTag ?? tag, [`主 ${ctx.refOf(device.displayTag ?? tag)}`])),
        ...[96, 114].map((y) => tagGroup(tag, x - 7.6, y, device.displayTag ?? tag, [`主 ${ctx.refOf(device.displayTag ?? tag)}`], 'end'))
      ],
      what: `${tag} 位号`
    });
    footer(page, x, IO_ZERO_Y + 8, () => foot, IO_PITCH - 2, `out-${col.address}`);
    return;
  }
  if (col.kind === 'coil') {
    const els: Element[] = col.tags.map((tag) => {
      const device = ctx.device(tag);
      return { kind: 'device', tag, pins: [device.pins[0] as string, device.pins[1] as string] };
    });
    const result = drawChain(ctx, page, pin, els, {
      extraLines: (tag) => {
        const device = ctx.device(tag);
        const owner = device.displayTag ? ctx.build.circuit.devices.find((item) => item.tag === device.displayTag) : undefined;
        return owner?.kind === 'thermal' ? [ctx.refOf(owner.tag)] : [];
      }
    });
    page.wire('0V', result.end, [x, IO_ZERO_Y]);
    const coil = ctx.device(col.tags[col.tags.length - 1] as string);
    footer(page, x, IO_ZERO_Y + 8, () => [...foot.filter(Boolean), ...mirrorLines(ctx, coil).slice(1)], IO_PITCH - 2, `out-${col.address}`);
    return;
  }
  const tag = col.tags[0] as string;
  const device = ctx.device(tag);
  let p: Pt = pin;
  const tIn = terminalOf[PIN(tag, '1')];
  if (tIn) {
    const t = placeTerminal(ctx, page, tIn, x, 66, 'right');
    page.wire(ctx.netOf(PIN(tag, '1')), p, t.i);
    p = t.o;
    terminalStripTag(page, x, 66, '-X1');
  }
  const yc = 104;
  const geom = twoPinGeom(ctx, device, x, yc, ['1', '2']);
  page.place(device, geom);
  page.wire(ctx.netOf(PIN(tag, '1')), p, geom.pins['1'] as Pt);
  page.label({ candidates: [tagGroup(tag, x + 5.6, yc - 1, tag, [fitText(device.name, 13, 2.3)]), tagGroup(tag, x + 5.6, yc + 4, tag, [])], what: `${tag} 位号` });
  const out = geom.pins['2'] as Pt;
  const tOut = terminalOf[PIN(tag, '2')];
  if (tOut) {
    const t = placeTerminal(ctx, page, tOut, x, 140, 'right');
    page.wire('0V', out, t.i);
    page.wire('0V', t.o, [x, IO_ZERO_Y]);
  } else page.wire('0V', out, [x, IO_ZERO_Y]);
  footer(page, x, IO_ZERO_Y + 8, () => foot, IO_PITCH - 2, `out-${col.address}`);
}

export { fixedName, SENSOR3_H, textWidth };
export type { Circuit };
