/**
 * 图面几何：图元（线/框/圆/弧/文字）+ 出图自检。
 *
 * 版面层和渲染层都只产出图元，自检只看图元本身，不信任任何“我应该画对了”的假设：
 *   - 导线连续性：按几何端点/T 接判连通，再和电路网络逐一比对（断线、短接、孤立线）；
 *   - 引脚落点：每个元件的每个引脚都必须画出来，且有导线落在上面；
 *   - 文字避让：任何文字框不得压到线条、圆、框、其他文字，也不得出图框；
 *   - 导线不得穿过符号本体；符号两两不重叠。
 * 交点打点也由几何算出来（≥3 条支路汇于一点才打点），十字交叉不打点 = 不相连。
 */

import type { Circuit } from './circuit.ts';
import { PIN } from './circuit.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Pt = [number, number];
export type Anchor = 'start' | 'middle' | 'end';
export type Layer = 'frame' | 'symbol' | 'wire' | 'dot' | 'text' | 'table' | 'title';

interface PrimBase {
  layer: Layer;
  cls: string;
  /** 所属元件位号（符号图元/标注），框线为空 */
  owner?: string;
  /** 图元在符号里的角色：lead/blade/hook/linkage/body/tag/pin-no… 供测试做几何断言 */
  role?: string;
}

export interface LinePrim extends PrimBase { t: 'line'; x1: number; y1: number; x2: number; y2: number }
export interface RectPrim extends PrimBase { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string }
export interface CirclePrim extends PrimBase { t: 'circle'; cx: number; cy: number; r: number; filled?: boolean }
export interface PathPrim extends PrimBase { t: 'path'; d: string; box: Box }
export interface TextPrim extends PrimBase { t: 'text'; x: number; y: number; value: string; size: number; anchor: Anchor }
export type Prim = LinePrim | RectPrim | CirclePrim | PathPrim | TextPrim;

export interface Wire {
  points: Pt[];
  net: string;
}

const EPS = 0.05;

/* ------------------------------------------------------------------ 构造 */

type Extra = { owner?: string | undefined; role?: string | undefined };
const meta = (extra: Extra): { owner?: string; role?: string } => ({
  ...(extra.owner !== undefined ? { owner: extra.owner } : {}),
  ...(extra.role !== undefined ? { role: extra.role } : {})
});

export const P = {
  line: (x1: number, y1: number, x2: number, y2: number, layer: Layer = 'symbol', cls = 'ic', extra: Extra = {}): LinePrim =>
    ({ t: 'line', layer, cls, x1, y1, x2, y2, ...meta(extra) }),
  rect: (x: number, y: number, w: number, h: number, layer: Layer = 'symbol', cls = 'ic', extra: Extra & { fill?: string } = {}): RectPrim =>
    ({ t: 'rect', layer, cls, x, y, w, h, ...meta(extra), ...(extra.fill ? { fill: extra.fill } : {}) }),
  circle: (cx: number, cy: number, r: number, layer: Layer = 'symbol', cls = 'ic', extra: Extra & { filled?: boolean } = {}): CirclePrim =>
    ({ t: 'circle', layer, cls, cx, cy, r, ...meta(extra), ...(extra.filled ? { filled: true } : {}) }),
  path: (d: string, box: Box, layer: Layer = 'symbol', cls = 'ic', extra: Extra = {}): PathPrim =>
    ({ t: 'path', layer, cls, d, box, ...meta(extra) }),
  text: (x: number, y: number, value: string, size: number, anchor: Anchor = 'start', cls = 'it-s', layer: Layer = 'text', extra: Extra = {}): TextPrim =>
    ({ t: 'text', layer, cls, x, y, value, size, anchor, ...meta(extra) })
};

/* ------------------------------------------------------------------ 文字度量 */

/** 字宽系数（em）：中日韩全角 1.0，其余按等宽 0.6 估，偏保守 */
function charEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x2e80 || (code >= 0xff00 && code <= 0xffef)) return 1;
  return 0.6;
}

export function textWidth(value: string, size: number): number {
  let em = 0;
  for (const ch of value) em += charEm(ch);
  return em * size;
}

export function textBox(t: Pick<TextPrim, 'x' | 'y' | 'value' | 'size' | 'anchor'>): Box {
  const w = textWidth(t.value, t.size);
  const x = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
  return { x, y: t.y - 0.8 * t.size, w, h: 1.02 * t.size };
}

/** 超宽就截断并加省略号：表格/标题栏/说明都走这里，保证不出格 */
export function fitText(value: string, maxWidth: number, size: number): string {
  if (textWidth(value, size) <= maxWidth) return value;
  const chars = [...value];
  while (chars.length > 0 && textWidth(`${chars.join('')}…`, size) > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}

/* ------------------------------------------------------------------ 相交 */

export function boxesOverlap(a: Box, b: Box): boolean {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return dx > 0.5 && dy > 0.5;
}

function boxesTouch(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function shrink(box: Box, d: number): Box {
  return { x: box.x + d, y: box.y + d, w: Math.max(0, box.w - 2 * d), h: Math.max(0, box.h - 2 * d) };
}

/** 线段与矩形（含边界）是否相交：Liang–Barsky 裁剪 */
export function segHitsBox(x1: number, y1: number, x2: number, y2: number, b: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - b.x, b.x + b.w - x1, y1 - b.y, b.y + b.h - y1];
  for (let i = 0; i < 4; i += 1) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    if (Math.abs(pi) < 1e-12) {
      if (qi < 0) return false;
    } else {
      const r = qi / pi;
      if (pi < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

function circleHitsBox(c: CirclePrim, b: Box): boolean {
  const nx = Math.max(b.x, Math.min(c.cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(c.cy, b.y + b.h));
  const near = Math.hypot(nx - c.cx, ny - c.cy);
  if (c.filled) return near <= c.r;
  const far = Math.max(
    ...[[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => Math.hypot((x as number) - c.cx, (y as number) - c.cy))
  );
  return near <= c.r && far >= c.r;
}

/** 图元的“笔画”是否压到矩形 */
export function primHitsBox(p: Prim, b: Box): boolean {
  switch (p.t) {
    case 'line':
      return segHitsBox(p.x1, p.y1, p.x2, p.y2, b);
    case 'rect': {
      if (p.fill) return boxesTouch({ x: p.x, y: p.y, w: p.w, h: p.h }, b);
      const { x, y, w, h } = p;
      return segHitsBox(x, y, x + w, y, b) || segHitsBox(x + w, y, x + w, y + h, b) ||
        segHitsBox(x, y + h, x + w, y + h, b) || segHitsBox(x, y, x, y + h, b);
    }
    case 'circle':
      return circleHitsBox(p, b);
    case 'path':
      return boxesTouch(p.box, b);
    case 'text':
      return boxesTouch(textBox(p), b);
    default:
      return false;
  }
}

export function pointOnSeg(p: Pt, a: Pt, b: Pt, eps = EPS): boolean {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-9) return Math.hypot(px - ax, py - ay) <= eps;
  const cross = Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / len;
  if (cross > eps) return false;
  const dot = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len;
  return dot >= -eps && dot <= len + eps;
}

const samePt = (a: Pt, b: Pt): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS;

/* ------------------------------------------------------------------ 导线拓扑 */

export interface Segment {
  a: Pt;
  b: Pt;
  wire: number;
}

export function wireSegments(wires: readonly Wire[]): Segment[] {
  const segs: Segment[] = [];
  wires.forEach((wire, index) => {
    for (let i = 0; i < wire.points.length - 1; i += 1) {
      const a = wire.points[i];
      const b = wire.points[i + 1];
      if (a && b && !samePt(a, b)) segs.push({ a, b, wire: index });
    }
  });
  return segs;
}

/**
 * 交点：某点处汇聚的支路数 ≥3 才是电气连接点（打点）。
 * 线段端点算 1 条支路、线段中段穿过算 2 条、元件引脚算 1 条。
 * 两线十字交叉（都是中段）不算连接，不打点。
 */
export function junctionPoints(wires: readonly Wire[], pins: readonly Pt[] = []): Pt[] {
  const segs = wireSegments(wires);
  const candidates: Pt[] = [];
  for (const seg of segs) {
    for (const p of [seg.a, seg.b]) if (!candidates.some((c) => samePt(c, p))) candidates.push(p);
  }
  const out: Pt[] = [];
  for (const p of candidates) {
    let degree = 0;
    for (const seg of segs) {
      if (samePt(seg.a, p) || samePt(seg.b, p)) degree += 1;
      else if (pointOnSeg(p, seg.a, seg.b)) degree += 2;
    }
    if (pins.some((pin) => samePt(pin, p))) degree += 1;
    if (degree >= 3) out.push(p);
  }
  return out;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r] as number;
    let c = i;
    while (this.parent[c] !== r) {
      const next = this.parent[c] as number;
      this.parent[c] = r;
      c = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

export interface PlacedPins {
  tag: string;
  pins: Record<string, Pt>;
  /** 符号本体（导线不得穿过） */
  box: Box;
}

/**
 * 导线 vs 电路网络：
 *  PIN_NOT_DRAWN   元件引脚在图上不存在（漏画元件/端子）
 *  PIN_UNWIRED     引脚画了，但没有任何导线落在上面
 *  NET_BROKEN      同一网络的引脚在图上不连通（断线）
 *  NET_SHORT       不同网络在图上连到一起（短接）
 *  WIRE_DANGLING   一段导线两头都没接任何引脚
 *  WIRE_THROUGH_SYMBOL 导线穿过符号本体
 */
export function checkWiring(circuit: Circuit, wires: readonly Wire[], placed: readonly PlacedPins[]): string[] {
  const problems: string[] = [];
  const segs = wireSegments(wires);
  const uf = new UnionFind(segs.length);
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const s = segs[i] as Segment;
      const t = segs[j] as Segment;
      if (pointOnSeg(s.a, t.a, t.b) || pointOnSeg(s.b, t.a, t.b) || pointOnSeg(t.a, s.a, s.b) || pointOnSeg(t.b, s.a, s.b)) {
        uf.union(i, j);
      }
    }
  }

  const anchor = new Map<string, Pt>();
  for (const symbol of placed) {
    for (const [name, pt] of Object.entries(symbol.pins)) anchor.set(PIN(symbol.tag, name), pt);
  }

  /** 引脚 → 所在导线连通分量 */
  const compOf = new Map<string, number>();
  for (const device of circuit.devices) {
    for (const pin of device.pins) {
      const key = PIN(device.tag, pin);
      const pt = anchor.get(key);
      if (!pt) {
        problems.push(`[PIN_NOT_DRAWN] ${device.tag} 的引脚 ${pin} 没有画出来`);
        continue;
      }
      const hits = segs.map((seg, index) => (pointOnSeg(pt, seg.a, seg.b) ? index : -1)).filter((index) => index >= 0);
      if (hits.length === 0) {
        problems.push(`[PIN_UNWIRED] ${device.tag} 的引脚 ${pin} 没有导线落点`);
        continue;
      }
      for (const index of hits.slice(1)) uf.union(hits[0] as number, index);
      compOf.set(key, hits[0] as number);
    }
  }

  // 端子两侧同属一个网络：端子本体（小圆）在图上就是导通的
  for (const device of circuit.devices) {
    if (device.kind !== 'terminal') continue;
    const comps = device.pins.map((pin) => compOf.get(PIN(device.tag, pin))).filter((seg): seg is number => seg !== undefined);
    for (const seg of comps.slice(1)) uf.union(comps[0] as number, seg);
  }

  const netsOfComp = new Map<number, Set<string>>();
  for (const net of circuit.nets) {
    const comps = new Map<number, string>();
    for (const pin of net.pins) {
      const seg = compOf.get(pin);
      if (seg === undefined) continue;
      const root = uf.find(seg);
      if (!comps.has(root)) comps.set(root, pin);
      const bucket = netsOfComp.get(root) ?? new Set<string>();
      bucket.add(net.label ?? net.id);
      netsOfComp.set(root, bucket);
    }
    if (comps.size > 1) {
      const sample = [...comps.values()];
      problems.push(`[NET_BROKEN] 网络 ${net.label ?? net.id} 在图上断开：${sample[0]} 与 ${sample[1]} 没有连通`);
    }
  }
  for (const nets of netsOfComp.values()) {
    if (nets.size > 1) problems.push(`[NET_SHORT] 网络 ${[...nets].join(' / ')} 在图上被画成连在一起`);
  }
  const usedRoots = new Set([...compOf.values()].map((seg) => uf.find(seg)));
  const dangling = new Set<number>();
  segs.forEach((_, index) => {
    const root = uf.find(index);
    if (!usedRoots.has(root)) dangling.add(root);
  });
  for (const root of dangling) {
    const seg = segs.find((_, index) => uf.find(index) === root);
    if (seg) problems.push(`[WIRE_DANGLING] (${seg.a[0].toFixed(1)}, ${seg.a[1].toFixed(1)}) 处有一段导线两头都没接元件`);
  }

  for (const seg of segs) {
    for (const symbol of placed) {
      if (segHitsBox(seg.a[0], seg.a[1], seg.b[0], seg.b[1], shrink(symbol.box, 0.4))) {
        problems.push(`[WIRE_THROUGH_SYMBOL] 导线穿过 ${symbol.tag} 的符号本体`);
      }
    }
  }
  return [...new Set(problems)];
}

/* ------------------------------------------------------------------ 文字 */

function describe(p: Prim): string {
  if (p.t === 'text') return `文字“${p.value}”`;
  const who = p.owner ?? (p.layer === 'wire' ? '导线' : p.layer === 'table' ? '表格' : p.layer === 'title' ? '标题栏' : '图框');
  return `${who} 的线条`;
}

/**
 * 文字框不得压到任何笔画/其他文字，也不得出图框。
 * 用笔画而不是符号外接框判：PLC 框里的端子名、电机圆里的 M 都是合法的。
 */
export function checkTexts(prims: readonly Prim[], frame: Box): string[] {
  const problems: string[] = [];
  const texts = prims.map((p, index) => ({ p, index })).filter((item): item is { p: TextPrim; index: number } => item.p.t === 'text' && item.p.value.trim() !== '');
  for (const { p: t, index } of texts) {
    const tb = shrink(textBox(t), 0.1);
    if (tb.x < frame.x || tb.y < frame.y || tb.x + tb.w > frame.x + frame.w || tb.y + tb.h > frame.y + frame.h) {
      problems.push(`[TEXT_OUT_OF_FRAME] 文字“${t.value}”超出图框`);
    }
    prims.forEach((other, j) => {
      if (j === index) return;
      if (other.t === 'text') {
        if (j < index || other.value.trim() === '') return;
        if (boxesTouch(tb, shrink(textBox(other), 0.1))) problems.push(`[TEXT_OVERLAP] 文字“${t.value}”与文字“${other.value}”重叠`);
        return;
      }
      if (primHitsBox(other, tb)) problems.push(`[TEXT_OVERLAP] 文字“${t.value}”压到${describe(other)}`);
    });
  }
  return [...new Set(problems)];
}
