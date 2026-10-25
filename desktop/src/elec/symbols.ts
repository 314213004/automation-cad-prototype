/**
 * IEC 60617 风格符号（竖向电流路径），全部输出几何图元 + 引脚落点。
 *
 * 约定：引脚在符号本体外接框的上下边（或 PLC 框边）上，导线必须落在引脚点；
 * 端子号用小字写在引脚左侧；位号/说明由版面层写在符号右侧。
 *
 * 触点画法（竖向）：
 *   常开 NO：上引线止于静触点，动触片自下方支点斜向左上，与静触点留缺口；
 *   常闭 NC：静触点带向右的水平钩，动触片自支点斜向右上越过钩端（接触）；
 *   接触器主触点：常开 + 静触点处半圆（接触器功能符）；
 *   断路器：常开 + 静触点处 “×”；热继：方框内阶梯形发热元件；
 *   多极元件的机械联动用虚线，且虚线不进入任何方框。
 */

import { P, type Box, type Prim, type Pt } from './geometry.ts';

export interface SymbolGeom {
  prims: Prim[];
  pins: Record<string, Pt>;
  box: Box;
}

const DASH = 'ic ic-d';
const THIN = 'ic ic-t';

function builder(owner: string) {
  const prims: Prim[] = [];
  return {
    prims,
    line(x1: number, y1: number, x2: number, y2: number, role: string, cls = 'ic'): void {
      prims.push(P.line(x1, y1, x2, y2, 'symbol', cls, { owner, role }));
    },
    poly(points: Pt[], role: string, cls = 'ic'): void {
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i] as Pt;
        const b = points[i + 1] as Pt;
        prims.push(P.line(a[0], a[1], b[0], b[1], 'symbol', cls, { owner, role }));
      }
    },
    rect(x: number, y: number, w: number, h: number, role: string, cls = 'ic'): void {
      prims.push(P.rect(x, y, w, h, 'symbol', cls, { owner, role }));
    },
    circle(cx: number, cy: number, r: number, role: string, cls = 'ic'): void {
      prims.push(P.circle(cx, cy, r, 'symbol', cls, { owner, role }));
    },
    path(d: string, box: Box, role: string, cls = 'ic'): void {
      prims.push(P.path(d, box, 'symbol', cls, { owner, role }));
    },
    text(x: number, y: number, value: string, size: number, anchor: 'start' | 'middle' | 'end', role: string, cls = 'it-s'): void {
      prims.push(P.text(x, y, value, size, anchor, cls, 'text', { owner, role }));
    }
  };
}

/** 端子号字号 */
export const PIN_NO_SIZE = 2.2;

/* ============================================================ 主回路三极 */

export const THREE_POLE_H = 20;

/**
 * 三极元件（断路器/接触器主触头/热继发热元件），三根竖向极，顶部为进线端。
 * pinsIn/pinsOut 对应 1/3/5 与 2/4/6。
 */
export function threePoleSymbol(
  kind: 'breaker' | 'contactor' | 'thermal',
  owner: string,
  xs: readonly [number, number, number],
  y0: number,
  pinsIn: readonly string[],
  pinsOut: readonly string[]
): SymbolGeom {
  const b = builder(owner);
  const pins: Record<string, Pt> = {};
  const yb = y0 + THREE_POLE_H;
  xs.forEach((x, i) => {
    const pin = pinsIn[i];
    const pout = pinsOut[i];
    if (pin) {
      pins[pin] = [x, y0];
      b.text(x - 1.2, y0 + 2.6, pin, PIN_NO_SIZE, 'end', 'pin-no');
    }
    if (pout) {
      pins[pout] = [x, yb];
      b.text(x - 1.2, yb - 0.6, pout, PIN_NO_SIZE, 'end', 'pin-no');
    }
    if (kind === 'thermal') {
      b.line(x, y0, x, y0 + 5, 'lead');
      b.rect(x - 2.5, y0 + 5, 5, 10, 'body');
      b.poly([[x, y0 + 5], [x, y0 + 8], [x - 1.4, y0 + 8], [x - 1.4, y0 + 12], [x, y0 + 12], [x, y0 + 15]], 'element');
      b.line(x, y0 + 15, x, yb, 'lead');
      return;
    }
    b.line(x, y0, x, y0 + 6, 'lead');
    if (kind === 'breaker') {
      b.line(x - 1.1, y0 + 4.9, x + 1.1, y0 + 7.1, 'cross');
      b.line(x - 1.1, y0 + 7.1, x + 1.1, y0 + 4.9, 'cross');
    } else {
      // 接触器功能符：静触点处半圆，向动触片一侧（左）凸出
      b.path(`M${x} ${y0 + 3.6}A1.2 1.2 0 0 0 ${x} ${y0 + 6}`, { x: x - 1.2, y: y0 + 3.6, w: 1.2, h: 2.4 }, 'contactor-arc');
    }
    b.line(x, y0 + 14, x - 3.5, y0 + 5.5, 'blade');
    b.line(x, y0 + 14, x, yb, 'lead');
  });
  if (kind === 'thermal') {
    for (let i = 0; i < 2; i += 1) b.line((xs[i] as number) + 2.5, y0 + 10, (xs[i + 1] as number) - 2.5, y0 + 10, 'linkage', DASH);
  } else {
    // 联动虚线穿过三片动触片的中点
    b.line(xs[0] - 1.65, y0 + 10, xs[2] - 1.65, y0 + 10, 'linkage', DASH);
  }
  return { prims: b.prims, pins, box: { x: xs[0] - 5, y: y0, w: xs[2] - xs[0] + 8, h: THREE_POLE_H } };
}

/* ============================================================ 电机 */

export const MOTOR_R = 10;
export const MOTOR_H = 8 + 2 * MOTOR_R + 3;

/** 三相电机：三根进线全部落到圆周上，圆内只写 M 与 3~；PE 从圆底引出 */
export function motorSymbol(owner: string, xs: readonly [number, number, number], y0: number, pinNames: readonly string[]): SymbolGeom {
  const b = builder(owner);
  const cx = xs[1];
  const cy = y0 + 8 + MOTOR_R;
  const pins: Record<string, Pt> = {};
  const [u, v, w, pe] = [pinNames[0] ?? 'U', pinNames[1] ?? 'V', pinNames[2] ?? 'W', pinNames[3] ?? 'PE'];
  const ang = (40 * Math.PI) / 180;
  const ex = MOTOR_R * Math.sin(ang);
  const ey = MOTOR_R * Math.cos(ang);
  b.poly([[xs[0], y0], [xs[0], y0 + 3], [cx - ex, cy - ey]], 'lead');
  b.line(cx, y0, cx, cy - MOTOR_R, 'lead');
  b.poly([[xs[2], y0], [xs[2], y0 + 3], [cx + ex, cy - ey]], 'lead');
  pins[u] = [xs[0], y0];
  pins[v] = [cx, y0];
  pins[w] = [xs[2], y0];
  b.text(xs[0] + 1, y0 + 2.4, `${u}1`, PIN_NO_SIZE, 'start', 'pin-no');
  b.text(cx + 1, y0 + 2.4, `${v}1`, PIN_NO_SIZE, 'start', 'pin-no');
  b.text(xs[2] + 1, y0 + 2.4, `${w}1`, PIN_NO_SIZE, 'start', 'pin-no');
  b.circle(cx, cy, MOTOR_R, 'body');
  b.text(cx, cy + 1.2, 'M', 6, 'middle', 'inner', 'it');
  b.text(cx, cy + 6.2, '3~', 3, 'middle', 'inner', 'it-s');
  b.line(cx, cy + MOTOR_R, cx, cy + MOTOR_R + 3, 'lead');
  pins[pe] = [cx, cy + MOTOR_R + 3];
  return { prims: b.prims, pins, box: { x: xs[0] - 1, y: y0, w: xs[2] - xs[0] + 2, h: MOTOR_H } };
}

/** 保护接地符号（顶点为接线点） */
export function earthSymbol(x: number, y: number): Prim[] {
  const b = builder('PE');
  b.line(x - 4, y, x + 4, y, 'earth');
  b.line(x - 2.6, y + 1.4, x + 2.6, y + 1.4, 'earth');
  b.line(x - 1.2, y + 2.8, x + 1.2, y + 2.8, 'earth');
  b.text(x + 5.2, y + 2.2, 'PE', 2.8, 'start', 'net-label');
  return b.prims;
}

/* ============================================================ 控制回路（竖向两端元件） */

export const TWO_PIN_H = 10;
export type Actuator = 'push' | 'estop' | 'thermal' | 'none';

function pinNumbers(b: ReturnType<typeof builder>, x: number, yc: number, top: string, bottom: string): void {
  b.text(x - 1.2, yc - 5.2, top, PIN_NO_SIZE, 'end', 'pin-no');
  b.text(x - 1.2, yc + 7.2, bottom, PIN_NO_SIZE, 'end', 'pin-no');
}

/** 竖向触点：pins[0] 在上，pins[1] 在下 */
export function contactSymbol(owner: string, kind: 'no' | 'nc', x: number, yc: number, pins: readonly [string, string], actuator: Actuator): SymbolGeom {
  const b = builder(owner);
  const top = yc - TWO_PIN_H / 2;
  const bot = yc + TWO_PIN_H / 2;
  b.line(x, top, x, yc - 3, 'lead');
  b.line(x, yc + 3, x, bot, 'lead');
  let mid: Pt;
  if (kind === 'no') {
    b.line(x, yc + 3, x - 3.5, yc - 3.4, 'blade');
    mid = [x - 1.75, yc - 0.2];
  } else {
    b.line(x, yc - 3, x + 3, yc - 3, 'hook');
    b.line(x, yc + 3, x + 3.6, yc - 3.6, 'blade');
    mid = [x + 1.8, yc - 0.3];
  }
  let left = x - 4;
  const ax = x - 6;
  const ym = mid[1];
  if (actuator !== 'none') {
    b.line(mid[0], ym, ax, ym, 'actuator', DASH);
    if (actuator === 'push') {
      b.poly([[ax + 0.9, ym - 1.6], [ax, ym - 1.6], [ax, ym + 1.6], [ax + 0.9, ym + 1.6]], 'actuator');
      left = ax - 0.5;
    } else if (actuator === 'estop') {
      b.line(ax, ym - 2.2, ax, ym + 2.2, 'actuator');
      b.path(`M${ax} ${ym - 2.2}A2.2 2.2 0 0 0 ${ax} ${ym + 2.2}`, { x: ax - 2.2, y: ym - 2.2, w: 2.2, h: 4.4 }, 'actuator');
      left = ax - 2.7;
    } else {
      b.rect(ax - 3, ym - 1.8, 3, 3.6, 'actuator');
      b.poly([[ax - 1.5, ym - 1.8], [ax - 1.5, ym - 0.5], [ax - 2.3, ym - 0.5], [ax - 2.3, ym + 0.5], [ax - 1.5, ym + 0.5], [ax - 1.5, ym + 1.8]], 'actuator');
      left = ax - 3.5;
    }
  }
  pinNumbers(b, x, yc, pins[0], pins[1]);
  return { prims: b.prims, pins: { [pins[0]]: [x, top], [pins[1]]: [x, bot] }, box: { x: left, y: top, w: x + 4 - left, h: TWO_PIN_H } };
}

export function coilSymbol(owner: string, x: number, yc: number, pins: readonly [string, string]): SymbolGeom {
  const b = builder(owner);
  const top = yc - TWO_PIN_H / 2;
  const bot = yc + TWO_PIN_H / 2;
  b.line(x, top, x, yc - 2.5, 'lead');
  b.rect(x - 4, yc - 2.5, 8, 5, 'body');
  b.line(x, yc + 2.5, x, bot, 'lead');
  pinNumbers(b, x, yc, pins[0], pins[1]);
  return { prims: b.prims, pins: { [pins[0]]: [x, top], [pins[1]]: [x, bot] }, box: { x: x - 4, y: top, w: 8, h: TWO_PIN_H } };
}

export function fuseSymbol(owner: string, x: number, yc: number, pins: readonly [string, string]): SymbolGeom {
  const b = builder(owner);
  const top = yc - TWO_PIN_H / 2;
  const bot = yc + TWO_PIN_H / 2;
  b.rect(x - 1.5, yc - 3.6, 3, 7.2, 'body');
  b.line(x, top, x, bot, 'element');
  pinNumbers(b, x, yc, pins[0], pins[1]);
  return { prims: b.prims, pins: { [pins[0]]: [x, top], [pins[1]]: [x, bot] }, box: { x: x - 1.5, y: top, w: 3, h: TWO_PIN_H } };
}

export function lampSymbol(owner: string, x: number, yc: number, pins: readonly [string, string]): SymbolGeom {
  const b = builder(owner);
  const top = yc - TWO_PIN_H / 2;
  const bot = yc + TWO_PIN_H / 2;
  const r = 3.5;
  const d = r * Math.SQRT1_2;
  b.line(x, top, x, yc - r, 'lead');
  b.circle(x, yc, r, 'body');
  b.line(x - d, yc - d, x + d, yc + d, 'cross', THIN);
  b.line(x + d, yc - d, x - d, yc + d, 'cross', THIN);
  b.line(x, yc + r, x, bot, 'lead');
  pinNumbers(b, x, yc, `X${pins[0]}`, `X${pins[1]}`);
  return { prims: b.prims, pins: { [pins[0]]: [x, top], [pins[1]]: [x, bot] }, box: { x: x - r, y: top, w: 2 * r, h: TWO_PIN_H } };
}

/* ============================================================ 三线制传感器 / PLC */

export const SENSOR_W = 12;
export const SENSOR_H = 12;

/** 三线制传感器：BN(+)、BU(−) 在上，BK(OUT) 在下 */
export function sensorSymbol(owner: string, x: number, yTop: number): SymbolGeom {
  const b = builder(owner);
  b.rect(x - SENSOR_W / 2, yTop, SENSOR_W, SENSOR_H, 'body');
  const cy = yTop + SENSOR_H / 2;
  b.poly([[x, cy - 3], [x + 3, cy], [x, cy + 3], [x - 3, cy], [x, cy - 3]], 'element');
  b.text(x - 3.8, yTop - 1.4, 'BN', PIN_NO_SIZE, 'end', 'pin-no');
  b.text(x + 3.8, yTop - 1.4, 'BU', PIN_NO_SIZE, 'start', 'pin-no');
  b.text(x + 1.2, yTop + SENSOR_H + 3, 'BK', PIN_NO_SIZE, 'start', 'pin-no');
  return {
    prims: b.prims,
    pins: { '+': [x - 3, yTop], '-': [x + 3, yTop], OUT: [x, yTop + SENSOR_H] },
    box: { x: x - SENSOR_W / 2, y: yTop, w: SENSOR_W, h: SENSOR_H }
  };
}

export interface PlcTerminal {
  pin: string;
  x: number;
  edge: 'top' | 'bottom';
}

/** PLC：一个框，端子落在上/下边，端子名写在框内 */
export function plcSymbol(owner: string, box: Box, terminals: readonly PlcTerminal[], title: string, model: string): SymbolGeom {
  const b = builder(owner);
  b.rect(box.x, box.y, box.w, box.h, 'body');
  const pins: Record<string, Pt> = {};
  for (const term of terminals) {
    if (term.edge === 'top') {
      pins[term.pin] = [term.x, box.y];
      b.text(term.x, box.y + 3.6, term.pin, 2.4, 'middle', 'pin-no');
    } else {
      pins[term.pin] = [term.x, box.y + box.h];
      b.text(term.x, box.y + box.h - 1.4, term.pin, 2.4, 'middle', 'pin-no');
    }
  }
  b.text(box.x + 2.5, box.y + box.h / 2 + 1.2, title, 3.8, 'start', 'tag', 'it');
  b.text(box.x + 2.5, box.y + box.h / 2 + 5, model, 2.5, 'start', 'desc');
  return { prims: b.prims, pins, box };
}
