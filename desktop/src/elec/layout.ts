/**
 * 原理图版面布局（拓扑驱动）。
 *
 * 关键点：**按网络走**，不是按元件列表排。
 * 从 +24V 出发沿网络找元件；同一个网络上有多个元件通向同一个下一网络，
 * 就画成并联（上下两行），其余是串联（一行）。
 *
 * 输出符号外接矩形 + 连线，并做两两重叠检测；布局有重叠就不允许出图。
 */

import type { Circuit, CircuitDevice } from './circuit.ts';
import { PIN } from './circuit.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedSymbol {
  tag: string;
  displayTag: string;
  kind: CircuitDevice['kind'];
  box: Box;
  left: number;
  right: number;
  y: number;
  label?: string;
}

export interface Wire {
  points: Array<[number, number]>;
  net: string;
}

export interface LayoutResult {
  symbols: PlacedSymbol[];
  wires: Wire[];
  problems: string[];
  rails: { plusX: number; minusX: number; top: number; bottom: number };
}

const WIDTH: Partial<Record<CircuitDevice['kind'], number>> = {
  fuse: 10,
  nc: 12,
  no: 12,
  coil: 24,
  lamp: 14,
  breaker: 34,
  contactor: 34,
  thermal: 34,
  motor: 34,
  sensor: 30,
  plc: 84
};
const GAP = 9;
const widthOf = (kind: CircuitDevice['kind']): number => WIDTH[kind] ?? 14;

export function boxesOverlap(a: Box, b: Box): boolean {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > 0.5 && dy > 0.5;
}

export type Step =
  | { kind: 'device'; device: CircuitDevice }
  | { kind: 'parallel'; devices: CircuitDevice[] };

/**
 * 从某个网络出发推导串并联结构（梯形图一行）。
 * 同一网络 → 同一后继网络 的两条以上支路，就是并联。
 */
export function buildLadder(circuit: Circuit, startNetId: string): Step[] {
  const steps: Step[] = [];
  const netById = new Map(circuit.nets.map((net) => [net.id, net]));
  const deviceByPin = new Map<string, CircuitDevice>();
  for (const device of circuit.devices) {
    for (const pin of device.pins) deviceByPin.set(PIN(device.tag, pin), device);
  }
  const visit = (netId: string, depth: number): void => {
    if (depth > 12) return;
    const net = netById.get(netId);
    if (!net) return;
    const outgoing = new Map<string, CircuitDevice[]>();
    for (const pin of net.pins) {
      const device = deviceByPin.get(pin);
      if (!device || !['fuse', 'nc', 'no', 'coil'].includes(device.kind)) continue;
      const other = device.pins.find((name) => PIN(device.tag, name) !== pin);
      if (!other) continue;
      const otherPin = PIN(device.tag, other);
      const nextNet = circuit.nets.find((candidate) => candidate.pins.includes(otherPin));
      if (!nextNet) continue;
      const bucket = outgoing.get(nextNet.id) ?? [];
      if (!bucket.some((item) => item.tag === device.tag)) bucket.push(device);
      outgoing.set(nextNet.id, bucket);
    }
    for (const [nextNetId, devices] of outgoing) {
      if (devices.length > 1) steps.push({ kind: 'parallel', devices });
      else if (devices[0]) steps.push({ kind: 'device', device: devices[0] });
      const hasCoil = devices.some((device) => device.kind === 'coil');
      if (!hasCoil) visit(nextNetId, depth + 1);
    }
  };
  // 并联后两条支路会汇到同一网络，走一遍就够了
  visit(startNetId, 0);
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = step.kind === 'device' ? step.device.tag : step.devices.map((d) => d.tag).join('+');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function layoutCircuit(circuit: Circuit, options: { frame?: Box } = {}): LayoutResult {
  const frame = options.frame ?? { x: 10, y: 10, w: 400, h: 277 };
  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const problems: string[] = [];

  const mainX = [68, 84, 100];
  /* ---------- 主回路 ---------- */
  let mainY = 44;
  for (const kind of ['breaker', 'contactor', 'thermal'] as const) {
    const device = circuit.devices.find((item) => item.kind === kind);
    if (!device) continue;
    symbols.push({
      tag: device.tag,
      displayTag: device.displayTag ?? device.tag,
      kind,
      box: { x: mainX[0]! - 14, y: mainY, w: mainX[2]! + 14 - (mainX[0]! - 14), h: 28 },
      left: mainX[0]!,
      right: mainX[2]!,
      y: mainY + 14,
      label: device.model
    });
    mainY += 32;
  }
  const motor = circuit.devices.find((item) => item.kind === 'motor');
  if (motor) {
    symbols.push({
      tag: motor.tag,
      displayTag: motor.tag,
      kind: 'motor',
      box: { x: mainX[0]! - 6, y: mainY + 8, w: mainX[2]! + 12 - (mainX[0]! - 6), h: 44 },
      left: mainX[0]!,
      right: mainX[2]!,
      y: mainY + 30,
      label: motor.model
    });
  }

  /* ---------- 控制回路：拓扑驱动 ---------- */
  const plusX = 204;
  const minusX = 400;
  const top = 58;
  const bottom = 196;
  const ladder = buildLadder(circuit, '+24V');

  let cursorX = plusX + 12;
  let rowY = 74;
  let prevRight = plusX;
  let prevY = rowY;

  const connect = (nextLeft: number, nextY: number, net: string): void => {
    if (nextY === prevY) {
      wires.push({ net, points: [[prevRight, prevY], [nextLeft, nextY]] });
    } else {
      const mid = (prevRight + nextLeft) / 2;
      wires.push({ net, points: [[prevRight, prevY], [mid, prevY], [mid, nextY], [nextLeft, nextY]] });
    }
    prevRight = nextLeft;
    prevY = nextY;
  };

  for (const step of ladder) {
    if (step.kind === 'device') {
      const device = step.device;
      const width = widthOf(device.kind);
      if (cursorX + width > minusX - 20) {
        rowY += 34;
        cursorX = plusX + 12;
        prevRight = plusX;
        prevY = rowY;
      }
      const symbol: PlacedSymbol = {
        tag: device.tag,
        displayTag: device.displayTag ?? device.tag,
        kind: device.kind,
        box: { x: cursorX, y: rowY - 8, w: width, h: 16 },
        left: cursorX,
        right: cursorX + width,
        y: rowY,
        label: device.spec
      };
      connect(symbol.left, symbol.y, device.tag);
      symbols.push(symbol);
      prevRight = symbol.right;
      prevY = symbol.y;
      cursorX = symbol.right + GAP;
      continue;
    }

    /* 并联：两条支路上下分列 */
    const width = Math.max(...step.devices.map((device) => widthOf(device.kind)));
    const upperY = rowY - 10;
    const lowerY = rowY + 10;
    const left = cursorX;
    const right = cursorX + width;
    connect(left, rowY, 'parallel');
    wires.push({ net: 'parallel', points: [[left, upperY], [left, lowerY]] });
    step.devices.forEach((device, index) => {
      const y = index === 0 ? upperY : lowerY;
      const symbol: PlacedSymbol = {
        tag: device.tag,
        displayTag: device.displayTag ?? device.tag,
        kind: device.kind,
        box: { x: left, y: y - 7.6, w: width, h: 15.2 },
        left,
        right,
        y,
        label: device.spec
      };
      symbols.push(symbol);
      wires.push({ net: 'parallel', points: [[symbol.right, y], [right, y]] });
    });
    wires.push({ net: 'parallel', points: [[right, upperY], [right, lowerY]] });
    prevRight = right;
    prevY = rowY;
    cursorX = right + GAP;
  }
  wires.push({ net: 'end', points: [[prevRight, prevY], [minusX, prevY]] });

  /* ---------- 传感器 / PLC / 指示灯 ---------- */
  const plc = circuit.devices.find((item) => item.kind === 'plc');
  if (plc) {
    symbols.push({
      tag: plc.tag,
      displayTag: plc.tag,
      kind: 'plc',
      box: { x: plusX, y: rowY + 34, w: widthOf('plc'), h: 62 },
      left: plusX,
      right: plusX + widthOf('plc'),
      y: rowY + 65,
      label: plc.model
    });
  }
  let sensorY = rowY + 34 + 8;
  for (const sensor of circuit.devices.filter((item) => item.kind === 'sensor')) {
    symbols.push({
      tag: sensor.tag,
      displayTag: sensor.displayTag ?? sensor.tag,
      kind: 'sensor',
      box: { x: 300, y: sensorY - 6, w: widthOf('sensor'), h: 14 },
      left: 300,
      right: 300 + widthOf('sensor'),
      y: sensorY,
      label: sensor.spec
    });
    sensorY += 22;
  }
  const lamp = circuit.devices.find((item) => item.kind === 'lamp');
  if (lamp) {
    symbols.push({
      tag: lamp.tag,
      displayTag: lamp.tag,
      kind: 'lamp',
      box: { x: 352, y: sensorY - 6, w: widthOf('lamp'), h: 14 },
      left: 352,
      right: 352 + widthOf('lamp'),
      y: sensorY,
      label: ''
    });
  }

  /* ---------- 结构检查 ---------- */
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = symbols[i];
      const b = symbols[j];
      if (a && b && boxesOverlap(a.box, b.box)) problems.push(`符号重叠：${a.tag} 与 ${b.tag}`);
    }
    const symbol = symbols[i];
    if (symbol) {
      const box = symbol.box;
      if (box.x < frame.x || box.y < frame.y || box.x + box.w > frame.x + frame.w || box.y + box.h > frame.y + frame.h) {
        problems.push(`符号超出图框：${symbol.tag}`);
      }
    }
  }

  return { symbols, wires, problems, rails: { plusX, minusX, top, bottom } };
}
