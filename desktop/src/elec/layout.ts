/**
 * 原理图版面布局（拓扑驱动，IEC 竖向电流路径）。
 *
 * 图幅分区（A3 横向，单位 mm）：
 *   左：主回路，三相竖向 L1/L2/L3 → 断路器 → 接触器 → 热继 → 电机 → PE；
 *   右：控制回路，上 +24V、下 0V 两条水平母线，中间竖向电流路径：
 *       A 区：起保停梯形（按网络拓扑推导串并联：同一网络有两条以上支路通向同一后继网络即并联）；
 *       B 区：IO —— +24V 下方再走一条 0V(M) 母线，传感器 BN/BU 上接两条母线、BK 下接 PLC 输入，
 *             PLC 输出下接指示灯再回 0V。
 *
 * 版面只产出几何（符号图元 + 引脚落点 + 导线），并当场自检：
 * 导线连续性/短接/引脚落点/导线穿符号/符号重叠/越框/漏画元件。有问题就进 problems，渲染层据此拒绝“校验通过”。
 */

import type { Circuit, CircuitDevice } from './circuit.ts';
import { PIN } from './circuit.ts';
import { boxesOverlap, checkWiring, P, type Box, type Prim, type Pt, type Wire } from './geometry.ts';
import {
  coilSymbol,
  contactSymbol,
  earthSymbol,
  fuseSymbol,
  lampSymbol,
  motorSymbol,
  MOTOR_H,
  plcSymbol,
  sensorSymbol,
  SENSOR_H,
  threePoleSymbol,
  THREE_POLE_H,
  TWO_PIN_H,
  type Actuator,
  type SymbolGeom
} from './symbols.ts';

export { boxesOverlap };
export type { Box, Wire };

export interface PlacedSymbol {
  tag: string;
  displayTag: string;
  kind: CircuitDevice['kind'];
  box: Box;
  left: number;
  right: number;
  y: number;
  label?: string;
  pins: Record<string, Pt>;
}

export interface LayoutResult {
  symbols: PlacedSymbol[];
  wires: Wire[];
  /** 符号笔画 + 位号/说明文字（不含导线、不含图框表格） */
  prims: Prim[];
  problems: string[];
  rails: { plusY: number; zeroY: number; mY: number | null; left: number; right: number };
}

/** 图面分区（mm）——渲染层的图框/表格/标题栏按同一套数字摆 */
export const ZONES = {
  frame: { x: 10, y: 10, w: 400, h: 277 } as Box,
  drawTop: 28,
  drawBottom: 214,
  main: { left: 14, right: 150 },
  ctrl: { left: 158, right: 404 },
  /** 控制回路母线 */
  plusY: 50,
  mY: 57,
  zeroY: 208,
  ladderX: 172,
  ladderPitchX: 24,
  ioLeft: 230,
  /** 最右一列右侧还要写位号/说明，且不能碰 0V 回线 */
  ioRight: 380
};

const LABEL_TAG = 4;
const LABEL_SMALL = 2.6;

export type Step =
  | { kind: 'device'; device: CircuitDevice; inPin: string; outPin: string }
  | { kind: 'parallel'; devices: CircuitDevice[]; pins: Array<{ inPin: string; outPin: string }> };

/**
 * 从某个网络出发推导串并联结构（梯形图一条电流路径）。
 * 同一网络 → 同一后继网络 的两条以上支路，就是并联。
 */
export function buildLadder(circuit: Circuit, startNetId: string): Step[] {
  const steps: Step[] = [];
  const netById = new Map(circuit.nets.map((net) => [net.id, net]));
  const deviceByPin = new Map<string, CircuitDevice>();
  for (const device of circuit.devices) {
    for (const pin of device.pins) deviceByPin.set(PIN(device.tag, pin), device);
  }
  const seenDevices = new Set<string>();
  const visit = (netId: string, depth: number): void => {
    if (depth > 16) return;
    const net = netById.get(netId);
    if (!net) return;
    const outgoing = new Map<string, Array<{ device: CircuitDevice; inPin: string; outPin: string }>>();
    for (const pin of net.pins) {
      const device = deviceByPin.get(pin);
      if (!device || !['fuse', 'nc', 'no', 'coil'].includes(device.kind) || seenDevices.has(device.tag)) continue;
      const inPin = pin.slice(device.tag.length + 1);
      const other = device.pins.find((name) => name !== inPin);
      if (!other) continue;
      const nextNet = circuit.nets.find((candidate) => candidate.pins.includes(PIN(device.tag, other)));
      if (!nextNet) continue;
      const bucket = outgoing.get(nextNet.id) ?? [];
      bucket.push({ device, inPin, outPin: other });
      outgoing.set(nextNet.id, bucket);
    }
    for (const [nextNetId, items] of outgoing) {
      for (const item of items) seenDevices.add(item.device.tag);
      if (items.length > 1) {
        steps.push({ kind: 'parallel', devices: items.map((item) => item.device), pins: items.map(({ inPin, outPin }) => ({ inPin, outPin })) });
      } else if (items[0]) {
        steps.push({ kind: 'device', device: items[0].device, inPin: items[0].inPin, outPin: items[0].outPin });
      }
      if (!items.some((item) => item.device.kind === 'coil')) visit(nextNetId, depth + 1);
    }
  };
  if (startNetId === '+24V') {
    for (const net of circuit.nets.filter((item) => item.label === '+24V')) visit(net.id, 0);
  } else {
    visit(startNetId, 0);
  }
  return steps;
}

/** 位号下方那行短说明 */
function shortRole(device: CircuitDevice, circuit: Circuit): string {
  if (device.displayTag) {
    const owner = circuit.devices.find((item) => item.tag === device.displayTag);
    if (device.kind === 'no') return `自锁 ${device.pins.join('-')}`;
    if (device.kind === 'nc' && owner?.kind === 'thermal') return `过载 ${device.pins.join('-')}`;
    if (device.kind === 'coil') return `线圈 ${device.spec.split('·')[0]?.trim() ?? ''}`.trim();
    return device.name;
  }
  if (device.kind === 'fuse') return device.spec;
  return device.name.replace(/（.*?）|\(.*?\)/g, '').replace(/按钮$/, '').replace(/灯$/, '');
}

function actuatorOf(device: CircuitDevice, circuit: Circuit): Actuator {
  if (device.kind !== 'no' && device.kind !== 'nc') return 'none';
  if (device.displayTag) {
    const owner = circuit.devices.find((item) => item.tag === device.displayTag);
    return owner?.kind === 'thermal' ? 'thermal' : 'none';
  }
  return /急停/.test(device.name) ? 'estop' : 'push';
}

export function layoutCircuit(circuit: Circuit, options: { frame?: Box } = {}): LayoutResult {
  const frame = options.frame ?? ZONES.frame;
  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const prims: Prim[] = [];
  const problems: string[] = [];

  const place = (device: CircuitDevice, geom: SymbolGeom, labelAt: Pt | null, lines: string[] = []): PlacedSymbol => {
    const displayTag = device.displayTag ?? device.tag;
    prims.push(...geom.prims);
    if (labelAt) {
      prims.push(P.text(labelAt[0], labelAt[1], displayTag, LABEL_TAG, 'start', 'it', 'text', { owner: device.tag, role: 'tag' }));
      lines.filter(Boolean).forEach((value, index) => {
        prims.push(P.text(labelAt[0], labelAt[1] + 3.6 + index * 3.4, value, LABEL_SMALL, 'start', 'it-s', 'text', { owner: device.tag, role: 'desc' }));
      });
    }
    const symbol: PlacedSymbol = {
      tag: device.tag,
      displayTag,
      kind: device.kind,
      box: geom.box,
      left: geom.box.x,
      right: geom.box.x + geom.box.w,
      y: geom.box.y + geom.box.h / 2,
      label: device.spec,
      pins: geom.pins
    };
    symbols.push(symbol);
    return symbol;
  };
  const wire = (net: string, ...points: Pt[]): void => {
    wires.push({ net, points });
  };

  /* ================= 主回路 ================= */
  const xs: [number, number, number] = [46, 62, 78];
  const labelX = xs[2] + 8;
  const chain = (['breaker', 'contactor', 'thermal'] as const)
    .map((kind) => circuit.devices.find((item) => item.kind === kind))
    .filter((item): item is CircuitDevice => Boolean(item));
  const motor = circuit.devices.find((item) => item.kind === 'motor');
  if (chain.length > 0 || motor) {
    const supplyTop = 44;
    const earthH = 4 + 3;
    const used = chain.length * THREE_POLE_H + (motor ? MOTOR_H + earthH : 0);
    const gaps = chain.length + (motor ? 1 : 0);
    const gap = Math.max(6, Math.min(18, (ZONES.drawBottom - 6 - supplyTop - used) / Math.max(1, gaps)));
    let y = supplyTop + gap;
    let prev: Pt[] = xs.map((x) => [x, supplyTop] as Pt);
    xs.forEach((x, index) => prims.push(P.text(x, supplyTop - 2, `L${index + 1}`, 3.6, 'middle', 'it', 'text', { role: 'net-label' })));
    for (const device of chain) {
      const pinsIn = device.pins.slice(0, 3);
      const pinsOut = device.pins.slice(3, 6);
      const geom = threePoleSymbol(device.kind as 'breaker' | 'contactor' | 'thermal', device.tag, xs, y, pinsIn, pinsOut);
      place(device, geom, [labelX, y + 6.5], [device.model, device.spec]);
      xs.forEach((x, index) => wire(`${device.tag}-in${index}`, prev[index] as Pt, [x, y]));
      prev = xs.map((x) => [x, y + THREE_POLE_H] as Pt);
      y += THREE_POLE_H + gap;
    }
    if (motor) {
      const geom = motorSymbol(motor.tag, xs, y, motor.pins);
      place(motor, geom, [labelX, y + 12], [motor.model, motor.spec]);
      xs.forEach((x, index) => wire(`${motor.tag}-in${index}`, prev[index] as Pt, [x, y]));
      const pePin = motor.pins[3];
      const pe = pePin ? geom.pins[pePin] : undefined;
      if (pe) {
        wire('PE', pe, [pe[0], pe[1] + 4]);
        prims.push(...earthSymbol(pe[0], pe[1] + 4));
      }
    }
  }

  /* ================= 控制回路 A 区：起保停 ================= */
  const { plusY, zeroY } = ZONES;
  const ladder = buildLadder(circuit, '+24V');
  const x0 = ZONES.ladderX;
  if (ladder.length > 0) {
    const units = ladder.map((step) => (step.kind === 'parallel' ? 1.7 : 1));
    const total = units.reduce((sum, value) => sum + value, 0);
    const unitH = Math.min(30, (zeroY - plusY) / total);
    if (unitH < TWO_PIN_H + 6) problems.push(`[LADDER_TOO_LONG] 控制回路串联元件过多（${ladder.length} 级），竖向放不下`);
    let cursor = plusY;
    let prev: Pt = [x0, plusY];
    const placeTwoPin = (device: CircuitDevice, x: number, yc: number, pins: [string, string], labelX2: number): PlacedSymbol => {
      let geom: SymbolGeom;
      if (device.kind === 'coil') geom = coilSymbol(device.tag, x, yc, pins);
      else if (device.kind === 'fuse') geom = fuseSymbol(device.tag, x, yc, pins);
      else geom = contactSymbol(device.tag, device.kind === 'nc' ? 'nc' : 'no', x, yc, pins, actuatorOf(device, circuit));
      return place(device, geom, [labelX2, yc - 0.6], [shortRole(device, circuit)]);
    };
    ladder.forEach((step, index) => {
      const h = unitH * (units[index] ?? 1);
      const yc = cursor + h / 2;
      if (step.kind === 'device') {
        const symbol = placeTwoPin(step.device, x0, yc, [step.inPin, step.outPin], x0 + 6);
        const top = symbol.pins[step.inPin] as Pt;
        wire(`ladder-${index}`, prev, top);
        prev = symbol.pins[step.outPin] as Pt;
      } else {
        const yb1 = yc - TWO_PIN_H / 2 - 3.5;
        const yb2 = yc + TWO_PIN_H / 2 + 3.5;
        const cols = step.devices.map((_, i) => x0 + i * ZONES.ladderPitchX);
        const last = cols[cols.length - 1] as number;
        wire(`ladder-${index}-in`, prev, [x0, yb1]);
        wire(`ladder-${index}-bridge-top`, [x0, yb1], [last, yb1]);
        wire(`ladder-${index}-bridge-bot`, [x0, yb2], [last, yb2]);
        step.devices.forEach((device, i) => {
          const x = cols[i] as number;
          const pins = step.pins[i] as { inPin: string; outPin: string };
          const symbol = placeTwoPin(device, x, yc, [pins.inPin, pins.outPin], x + 6);
          wire(`ladder-${index}-${i}-top`, [x, yb1], symbol.pins[pins.inPin] as Pt);
          wire(`ladder-${index}-${i}-bot`, symbol.pins[pins.outPin] as Pt, [x, yb2]);
        });
        prev = [x0, yb2];
      }
      cursor += h;
    });
    wire('ladder-end', prev, [x0, zeroY]);
  }

  /* ================= 控制回路 B 区：PLC / 传感器 / 输出 ================= */
  const plc = circuit.devices.find((item) => item.kind === 'plc');
  let mY: number | null = null;
  const netOf = (pin: string) => circuit.nets.find((net) => net.pins.includes(pin));
  const peerOf = (pin: string, kind: CircuitDevice['kind']): { device: CircuitDevice; pin: string } | null => {
    const net = netOf(pin);
    for (const other of net?.pins ?? []) {
      if (other === pin) continue;
      const tag = other.slice(0, other.lastIndexOf(':'));
      const device = circuit.devices.find((item) => item.tag === tag && item.kind === kind);
      if (device) return { device, pin: other.slice(tag.length + 1) };
    }
    return null;
  };
  if (plc) {
    type Col = { pin: string; edge: 'top' | 'bottom'; role: 'L+' | 'M' | 'in' | 'out' };
    const cols: Col[] = [];
    if (plc.pins.includes('L+')) cols.push({ pin: 'L+', edge: 'top', role: 'L+' });
    if (plc.pins.includes('M')) cols.push({ pin: 'M', edge: 'top', role: 'M' });
    for (const pin of plc.pins.filter((name) => /^I/.test(name))) cols.push({ pin, edge: 'top', role: 'in' });
    for (const pin of plc.pins.filter((name) => /^Q/.test(name))) cols.push({ pin, edge: 'bottom', role: 'out' });
    /* 列距按列的需要分配：L+/M 只是一根线，窄；传感器/输出右侧要写位号说明，宽。
       先按最小列距排，富余的按比例放大（最多 1.35 倍），再整体居中。 */
    const need = (col: Col): number => (col.role === 'L+' || col.role === 'M' ? 12 : 22);
    const gaps = cols.slice(0, -1).map(need);
    const minSpan = gaps.reduce((sum, value) => sum + value, 0);
    const span = ZONES.ioRight - ZONES.ioLeft;
    const scale = minSpan > 0 ? Math.min(1.35, span / minSpan) : 1;
    if (scale < 1) problems.push(`[IO_TOO_DENSE] PLC 端子 ${cols.length} 个，单页放不下（需 ${minSpan} mm，可用 ${span} mm）`);
    const start = ZONES.ioLeft + Math.max(0, (span - minSpan * scale) / 2);
    const colX: number[] = [];
    cols.forEach((_, index) => colX.push(index === 0 ? start : (colX[index - 1] as number) + (gaps[index - 1] as number) * scale));
    const sensorTop = 78;
    const plcLeft = (colX[0] ?? start) - 8;
    const plcBox: Box = { x: plcLeft, y: 120, w: Math.max((colX[colX.length - 1] ?? start) + 8 - plcLeft, 44), h: 22 };
    const plcGeom = plcSymbol(plc.tag, plcBox, cols.map((col, index) => ({ pin: col.pin, x: colX[index] as number, edge: col.edge })), plc.displayTag ?? plc.tag, plc.model);
    place(plc, plcGeom, null);

    const mCol = cols.findIndex((col) => col.role === 'M');
    const firstSensorCol = cols.findIndex((col) => col.role === 'in');
    const mStart = mCol >= 0 ? (colX[mCol] as number) : firstSensorCol >= 0 ? (colX[firstSensorCol] as number) + 3 : null;
    if (mStart !== null) {
      mY = ZONES.mY;
      wire('0V-M', [mStart, mY], [ZONES.ctrl.right, mY], [ZONES.ctrl.right, zeroY]);
      prims.push(P.text(mStart + 1.5, mY - 1.6, '0V', 2.8, 'start', 'it-s', 'text', { role: 'net-label' }));
    }

    cols.forEach((col, index) => {
      const x = colX[index] as number;
      const pinPt = plcGeom.pins[col.pin] as Pt;
      if (col.role === 'L+') {
        wire('+24V-L+', [x, plusY], pinPt);
      } else if (col.role === 'M' && mY !== null) {
        wire('0V-M', [x, mY], pinPt);
      } else if (col.role === 'in') {
        const peer = peerOf(PIN(plc.tag, col.pin), 'sensor');
        if (!peer) return;
        const sensor = peer.device;
        const geom = sensorSymbol(sensor.tag, x, sensorTop);
        const labelLines = [sensor.purpose ?? '', sensor.spec].filter(Boolean);
        place(sensor, geom, [x + 1.8, sensorTop + SENSOR_H + 9], labelLines);
        const plus = geom.pins['+'] as Pt;
        const minus = geom.pins['-'] as Pt;
        wire(`${sensor.tag}+`, [plus[0], plusY], plus);
        if (mY !== null) wire(`${sensor.tag}-`, [minus[0], mY], minus);
        wire(`${sensor.tag}OUT`, geom.pins.OUT as Pt, pinPt);
      } else if (col.role === 'out') {
        const peer = peerOf(PIN(plc.tag, col.pin), 'lamp');
        if (!peer) return;
        const lamp = peer.device;
        const other = lamp.pins.find((name) => name !== peer.pin) ?? '2';
        const yc = 165;
        const geom = lampSymbol(lamp.tag, x, yc, [peer.pin, other]);
        place(lamp, geom, [x + 6, yc - 0.6], [shortRole(lamp, circuit)]);
        wire(`${lamp.tag}-in`, pinPt, geom.pins[peer.pin] as Pt);
        wire(`${lamp.tag}-out`, geom.pins[other] as Pt, [x, zeroY]);
      }
    });
  }

  /* 母线：在所有支路都落位之后画，起止点由实际支路决定 */
  const usesControl = ladder.length > 0 || Boolean(plc);
  if (usesControl) {
    wire('+24V', [ZONES.ctrl.left, plusY], [ZONES.ctrl.right - 4, plusY]);
    wire('0V', [ZONES.ctrl.left, zeroY], [ZONES.ctrl.right, zeroY]);
    prims.push(P.text(ZONES.ctrl.left, plusY - 2, '+24V', 3.6, 'start', 'it', 'text', { role: 'net-label' }));
    prims.push(P.text(ZONES.ctrl.left, zeroY - 2, '0V', 3.6, 'start', 'it', 'text', { role: 'net-label' }));
  }

  /* ================= 自检 ================= */
  const placedTags = new Set(symbols.map((symbol) => symbol.tag));
  for (const device of circuit.devices) {
    if (!placedTags.has(device.tag)) problems.push(`[DEVICE_NOT_PLACED] ${device.tag}（${device.name}）没有画到图上`);
  }
  for (let i = 0; i < symbols.length; i += 1) {
    const a = symbols[i] as PlacedSymbol;
    for (let j = i + 1; j < symbols.length; j += 1) {
      const b = symbols[j] as PlacedSymbol;
      if (boxesOverlap(a.box, b.box)) problems.push(`[SYMBOL_OVERLAP] 符号重叠：${a.tag} 与 ${b.tag}`);
    }
    const box = a.box;
    if (box.x < frame.x || box.y < frame.y || box.x + box.w > frame.x + frame.w || box.y + box.h > frame.y + frame.h) {
      problems.push(`[SYMBOL_OUT_OF_FRAME] 符号超出图框：${a.tag}`);
    }
  }
  problems.push(...checkWiring(circuit, wires, symbols));

  return {
    symbols,
    wires,
    prims,
    problems,
    rails: { plusY, zeroY, mY, left: ZONES.ctrl.left, right: ZONES.ctrl.right }
  };
}
