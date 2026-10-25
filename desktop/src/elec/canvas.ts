/**
 * 分页出图的单页画布：符号 + 导线 + 待摆放的文字。
 *
 * 文字（位号、说明、线号、端子号、交叉引用）一律走“候选位置 + 碰撞检测”摆放：
 * 先把所有笔画（符号、导线、交点、表格）放进空间索引，再逐条文字按候选顺序找第一个
 * 不压任何笔画/文字、不出绘图区的位置。找不到就记 LABEL_UNPLACED，绝不硬压。
 */

import type { CircuitDevice } from './circuit.ts';
import { P, primHitsBox, textBox, type Box, type Prim, type Pt, type TextPrim, type Wire } from './geometry.ts';
import type { PlacedSymbol } from './layout.ts';
import type { SymbolGeom } from './symbols.ts';

export const PAGE_W = 420;
export const PAGE_H = 297;
/** 内图框 */
export const FRAME: Box = { x: 10, y: 10, w: 400, h: 277 };
/** 电路绘图区（标题行以下、底部说明/标题栏以上） */
export const CONTENT: Box = { x: 11, y: 24, w: 398, h: 214.5 };
export const GRID_COLS = 8;
export const GRID_ROWS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 图框列号（1…8），交叉引用“页.列”用 */
export function columnOf(x: number): number {
  return Math.min(GRID_COLS, Math.max(1, Math.floor((x - FRAME.x) / (FRAME.w / GRID_COLS)) + 1));
}

export type PageKind = 'power' | 'control' | 'input' | 'output' | 'terminals' | 'wires' | 'bom';

export interface LabelRequest {
  /** 候选：每个候选是一组同时摆放的文字（如位号 + 两行说明） */
  candidates: TextPrim[][];
  /** 文字内容要等全部页面排完才知道（交叉引用），用 resolve 生成候选 */
  resolve?: () => TextPrim[][];
  /** 摆不下时的问题描述 */
  what: string;
  /** 允许越出电路绘图区（页脚说明、表格） */
  area?: Box;
  /** 摆不下也不算问题（同一网络的多处线号，至少一处由事后检查兜底） */
  optional?: boolean;
}

/** 网络在本页的出口（电位断点），交叉引用写在旁边 */
export interface Stub {
  net: string;
  at: Pt;
  /** 文字放在出口的哪一侧 */
  side: 'left' | 'right' | 'below' | 'above';
  /** 额外前缀（如“-KS1:Y32”） */
  prefix?: string;
  /** supply：电源进线端（不需要交叉引用） */
  kind?: 'xref' | 'supply';
}

export class PageCanvas {
  index = 0;
  symbols: PlacedSymbol[] = [];
  wires: Wire[] = [];
  /** 符号笔画 + 已摆好的文字 */
  prims: Prim[] = [];
  /** 图框/表格等静态图元（参与碰撞） */
  statics: Prim[] = [];
  labels: LabelRequest[] = [];
  stubs: Stub[] = [];
  problems: string[] = [];
  /** 本页画出的引脚：位号 → 引脚集合 */
  pinsDrawn = new Map<string, Set<string>>();
  /** 只对母线/电源网络画一次网络名（L1/N/PE/24V/0V） */
  fixedLabels = new Set<string>();

  kind: PageKind;
  title: string;

  constructor(kind: PageKind, title: string) {
    this.kind = kind;
    this.title = title;
  }

  place(device: CircuitDevice, geom: SymbolGeom): PlacedSymbol {
    this.prims.push(...geom.prims);
    const symbol: PlacedSymbol = {
      tag: device.tag,
      displayTag: device.displayTag ?? device.tag,
      kind: device.kind,
      box: geom.box,
      left: geom.box.x,
      right: geom.box.x + geom.box.w,
      y: geom.box.y + geom.box.h / 2,
      label: device.spec,
      pins: geom.pins
    };
    this.symbols.push(symbol);
    const set = this.pinsDrawn.get(device.tag) ?? new Set<string>();
    for (const pin of Object.keys(geom.pins)) set.add(pin);
    this.pinsDrawn.set(device.tag, set);
    return symbol;
  }

  wire(net: string, ...points: Pt[]): void {
    const clean: Pt[] = [];
    for (const point of points) {
      const last = clean[clean.length - 1];
      if (!last || Math.hypot(last[0] - point[0], last[1] - point[1]) > 1e-6) clean.push(point);
    }
    if (clean.length >= 2) this.wires.push({ net, points: clean });
  }

  label(request: LabelRequest): void {
    this.labels.push(request);
  }

  stub(stub: Stub): void {
    this.stubs.push(stub);
  }

  /** 符号所在“页.列”（页码在分页完成后才确定） */
  ref(tag: string): string | null {
    const symbol = this.symbols.find((item) => item.tag === tag);
    if (!symbol) return null;
    return `/${this.index}.${columnOf(symbol.box.x + symbol.box.w / 2)}`;
  }
}

/* ------------------------------------------------------------------ 空间索引 */

function primBox(p: Prim): Box {
  switch (p.t) {
    case 'line':
      return { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(p.x2 - p.x1), h: Math.abs(p.y2 - p.y1) };
    case 'rect':
      return { x: p.x, y: p.y, w: p.w, h: p.h };
    case 'circle':
      return { x: p.cx - p.r, y: p.cy - p.r, w: 2 * p.r, h: 2 * p.r };
    case 'path':
      return p.box;
    case 'text':
      return textBox(p);
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

const CELL = 8;

export class PrimIndex {
  private cells = new Map<string, Prim[]>();

  add(p: Prim): void {
    const b = primBox(p);
    // 未填充的大框只登记四条边所在的格子，避免“框里什么都放不进”
    if (p.t === 'rect' && !p.fill && (b.w > CELL * 2 || b.h > CELL * 2)) {
      for (const edge of [
        P.line(b.x, b.y, b.x + b.w, b.y),
        P.line(b.x + b.w, b.y, b.x + b.w, b.y + b.h),
        P.line(b.x, b.y + b.h, b.x + b.w, b.y + b.h),
        P.line(b.x, b.y, b.x, b.y + b.h)
      ]) this.addBox(primBox(edge), p);
      return;
    }
    this.addBox(b, p);
  }

  private addBox(b: Box, p: Prim): void {
    for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx += 1) {
      for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy += 1) {
        const key = `${cx},${cy}`;
        const list = this.cells.get(key);
        if (list) {
          if (list[list.length - 1] !== p) list.push(p);
        } else this.cells.set(key, [p]);
      }
    }
  }

  hits(box: Box): boolean {
    const seen = new Set<Prim>();
    for (let cx = Math.floor(box.x / CELL); cx <= Math.floor((box.x + box.w) / CELL); cx += 1) {
      for (let cy = Math.floor(box.y / CELL); cy <= Math.floor((box.y + box.h) / CELL); cy += 1) {
        for (const p of this.cells.get(`${cx},${cy}`) ?? []) {
          if (seen.has(p)) continue;
          seen.add(p);
          if (p.t === 'text') {
            if (p.value.trim() === '') continue;
            const tb = textBox(p);
            if (tb.x <= box.x + box.w && box.x <= tb.x + tb.w && tb.y <= box.y + box.h && box.y <= tb.y + tb.h) return true;
          } else if (primHitsBox(p, box)) return true;
        }
      }
    }
    return false;
  }
}

function inflate(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d };
}

function inside(b: Box, area: Box): boolean {
  return b.x >= area.x && b.y >= area.y && b.x + b.w <= area.x + area.w && b.y + b.h <= area.y + area.h;
}

/** 文字是否能放在这里（留 0.3 mm 空隙） */
export function fits(index: PrimIndex, texts: readonly TextPrim[], area: Box): boolean {
  for (const t of texts) {
    if (t.value.trim() === '') continue;
    const b = textBox(t);
    if (!inside(b, area)) return false;
    if (index.hits(inflate(b, 0.3))) return false;
  }
  // 组内文字两两不重叠
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = textBox(texts[i] as TextPrim);
      const b = textBox(texts[j] as TextPrim);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return false;
    }
  }
  return true;
}

/** 依次为每条文字请求找位置；成功的文字并入 prims */
export function resolveLabels(page: PageCanvas, extra: readonly Prim[]): void {
  const index = new PrimIndex();
  for (const p of [...page.prims, ...page.statics, ...extra]) index.add(p);
  for (const wire of page.wires) {
    for (let i = 0; i < wire.points.length - 1; i += 1) {
      const a = wire.points[i] as Pt;
      const b = wire.points[i + 1] as Pt;
      index.add(P.line(a[0], a[1], b[0], b[1], 'wire'));
    }
  }
  for (const request of page.labels) {
    const candidates = request.resolve ? request.resolve() : request.candidates;
    const area = request.area ?? CONTENT;
    const hit = candidates.find((group) => fits(index, group, area));
    if (!hit) {
      if (request.optional) continue;
      page.problems.push(`[LABEL_UNPLACED] ${request.what} 找不到不压线的位置`);
      continue;
    }
    for (const t of hit) {
      if (t.value.trim() === '') continue;
      page.prims.push(t);
      index.add(t);
    }
  }
  page.labels = [];
}

/* ------------------------------------------------------------------ 候选生成 */

/** 位号 + 说明行：以 (x, y) 为首行基线，向下排 */
export function tagGroup(owner: string, x: number, y: number, tag: string, lines: readonly string[], anchor: 'start' | 'end' = 'start', tagSize = 3, lineSize = 2.3): TextPrim[] {
  const out: TextPrim[] = [];
  if (tag) out.push(P.text(x, y, tag, tagSize, anchor, 'it', 'text', { owner, role: 'tag' }));
  lines.filter(Boolean).forEach((value, i) => {
    out.push(P.text(x, y + (tag ? tagSize * 0.95 : 0) + i * lineSize * 1.35, value, lineSize, anchor, 'it-s', 'text', { owner, role: 'desc' }));
  });
  return out;
}
