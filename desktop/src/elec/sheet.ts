/**
 * 原理图渲染：把 Circuit + Layout 变成 A3 单页 SVG。
 *
 * 整张图（图框、符号、导线、交点、表格、标题栏）先全部生成为几何图元，
 * 再对整张图做自检（文字压线/重叠/越框、明细表与图面一致、名称与型号一致），
 * 加上版面层的导线连续性检查，一项不过就 deliverable=false、标题栏不写“校验通过”，
 * 并在图上打红框列出问题——绝不假装是一张合格的图。
 */

import type { Circuit } from './circuit.ts';
import { ercSummary, runErc, type ErcIssue } from './circuit.ts';
import { checkTexts, fitText, junctionPoints, P, textWidth, type Prim, type Pt } from './geometry.ts';
import { layoutCircuit, ZONES, type LayoutResult } from './layout.ts';
import { breakerNameMismatch } from './machine-circuit.ts';

export interface SheetOptions {
  project: string;
  drawingNo?: string;
  page?: string;
  designer?: string;
  date?: string;
  notes?: string[];
}

export interface SheetResult {
  svg: string;
  issues: ErcIssue[];
  /** 版面/图面自检问题，形如 `[CODE] 说明` */
  problems: string[];
  /** 出图是否"可交付"：ERC 无 error 且图面自检全过 */
  deliverable: boolean;
  /** 自检所用的完整图元（测试做几何断言用） */
  prims: Prim[];
  /** 导线交点（打点位置） */
  junctions: Pt[];
}

export interface BomRow {
  tag: string;
  name: string;
  model: string;
  spec: string;
  qty: number;
}

const W = 420;
const H = 297;

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const n = (value: number): string => (Math.round(value * 100) / 100).toString();

function primSvg(p: Prim): string {
  switch (p.t) {
    case 'line':
      return `<line class="${p.cls}" x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}"/>`;
    case 'rect':
      return `<rect class="${p.cls}" x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${p.fill ? ` style="fill:${p.fill}"` : ''}/>`;
    case 'circle':
      return p.filled
        ? `<circle class="if" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"/>`
        : `<circle class="${p.cls}" cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(p.r)}"/>`;
    case 'path':
      return `<path class="${p.cls}" d="${p.d}"/>`;
    case 'text':
      return `<text class="${p.cls}" x="${n(p.x)}" y="${n(p.y)}" text-anchor="${p.anchor}" style="font-size:${n(p.size)}px">${esc(p.value)}</text>`;
    default:
      return '';
  }
}

/**
 * 元件明细表：按位号去重。同一物理元件的多个符号（接触器主触头/辅助触点/线圈）
 * 只算一件，名称取主符号（没有 displayTag 的那个）。
 */
export function bomRows(circuit: Circuit): BomRow[] {
  const rows = new Map<string, BomRow>();
  for (const device of circuit.devices) {
    const tag = device.displayTag ?? device.tag;
    const primary = !device.displayTag || device.displayTag === device.tag;
    const existing = rows.get(tag);
    if (!existing) {
      rows.set(tag, { tag, name: device.name, model: device.model, spec: device.spec, qty: 1 });
    } else if (primary) {
      existing.name = device.name;
      existing.model = device.model;
      existing.spec = device.spec;
    }
  }
  return [...rows.values()];
}

/* ------------------------------------------------------------------ 表格 */

const TABLE = { x: 14, y: 222.5, w: 268, bottom: 286 };
const TABLE_COLS: Array<{ key: keyof BomRow; title: string; w: number; align: 'start' | 'end' }> = [
  { key: 'tag', title: '代号', w: 22, align: 'start' },
  { key: 'name', title: '名称', w: 48, align: 'start' },
  { key: 'model', title: '型号', w: 62, align: 'start' },
  { key: 'spec', title: '规格', w: 118, align: 'start' },
  { key: 'qty', title: '数量', w: 18, align: 'end' }
];

function deviceTable(rows: readonly BomRow[]): Prim[] {
  const out: Prim[] = [];
  const hh = 5.6;
  const rh = Math.min(4.6, (TABLE.bottom - TABLE.y - hh) / Math.max(1, rows.length));
  const size = Math.min(2.8, rh * 0.62);
  const h = hh + rows.length * rh;
  const { x, y, w } = TABLE;
  out.push(P.text(x, y - 1.6, '元件明细表', 3.2, 'start', 'it-t', 'table'));
  out.push(P.rect(x, y, w, h, 'table'));
  out.push(P.line(x, y + hh, x + w, y + hh, 'table', 'ic ic-t'));
  let cx = x;
  TABLE_COLS.forEach((col, index) => {
    if (index > 0) out.push(P.line(cx, y, cx, y + h, 'table', 'ic ic-t'));
    const tx = col.align === 'end' ? cx + col.w - 1.6 : cx + 1.6;
    out.push(P.text(tx, y + hh - 1.5, col.title, 2.8, col.align, 'it-s', 'table'));
    rows.forEach((row, r) => {
      const value = fitText(String(row[col.key]), col.w - 3.2, size);
      out.push(P.text(tx, y + hh + r * rh + rh / 2 + size * 0.36, value, size, col.align, 'it-s', 'table'));
    });
    cx += col.w;
  });
  rows.forEach((_, r) => {
    if (r > 0) out.push(P.line(x, y + hh + r * rh, x + w, y + hh + r * rh, 'table', 'ic ic-t'));
  });
  return out;
}

/* ------------------------------------------------------------------ 标题栏 / 说明 */

export const STATUS_TEXT = { ok: '校验通过', fail: '有待处理问题' } as const;

function titleBlock(options: SheetOptions, status: string): Prim[] {
  const x = 288;
  const y = 242;
  const w = 122;
  const h = 45;
  const out: Prim[] = [];
  const drawingNo = options.drawingNo ?? 'EL-M-001';
  const L = (x1: number, y1: number, x2: number, y2: number, cls = 'ic ic-t'): void => {
    out.push(P.line(x1, y1, x2, y2, 'title', cls));
  };
  const label = (tx: number, ty: number, value: string): void => {
    out.push(P.text(tx, ty, value, 2.8, 'start', 'it-s', 'title'));
  };
  const value = (tx: number, ty: number, v: string, maxW: number, cls = 'it'): void => {
    out.push(P.text(tx, ty, fitText(v, maxW, 3.4), 3.4, 'start', cls, 'title'));
  };
  out.push(P.rect(x, y, w, h, 'title'));
  L(x, y + 12, x + w, y + 12, 'ic');
  L(x, y + 22, x + w, y + 22);
  L(x, y + 32, x + w, y + 32);
  // 第 2 行：图号 | 页 | 幅面
  L(x + 58, y + 12, x + 58, y + 22);
  L(x + 90, y + 12, x + 90, y + 22);
  // 第 3 行：设计 | 日期
  L(x + 58, y + 22, x + 58, y + 32);
  // 第 4 行：状态 | 比例/单位
  L(x + 80, y + 32, x + 80, y + h);

  const noSize = 3.8;
  const noW = textWidth(drawingNo, noSize);
  out.push(P.text(x + w - 3, y + 8, drawingNo, noSize, 'end', 'it', 'title'));
  out.push(P.text(x + 3, y + 8, fitText(`${options.project} · 电气原理图`, w - noW - 9, 3.8), 3.8, 'start', 'it-b', 'title'));

  label(x + 3, y + 18.4, '图号');
  value(x + 13, y + 18.6, drawingNo, 43);
  label(x + 61, y + 18.4, '页');
  value(x + 67, y + 18.6, options.page ?? '1 / 1', 21);
  label(x + 93, y + 18.4, '幅面');
  value(x + 103, y + 18.6, 'A3', 17);

  label(x + 3, y + 28.4, '设计');
  value(x + 13, y + 28.6, options.designer ?? '软件自动生成', 43, 'it-t');
  label(x + 61, y + 28.4, '日期');
  value(x + 71, y + 28.6, options.date ?? '', 49);

  label(x + 3, y + 40, '状态');
  value(x + 13, y + 40.2, status, 64, 'it-t');
  label(x + 83, y + 37.6, '比例 1:1');
  label(x + 83, y + 42.4, '单位 mm');
  return out;
}

function notesBlock(notes: readonly string[]): Prim[] {
  const out: Prim[] = [];
  if (notes.length === 0) return out;
  const x = 290;
  const maxW = 116;
  const shown = notes.slice(0, 4);
  out.push(P.text(x, 224.6, '说明', 2.9, 'start', 'it-t', 'text', { role: 'notes' }));
  shown.forEach((note, index) => {
    const prefix = `${index + 1}. `;
    const last = index === shown.length - 1 && notes.length > shown.length;
    const body = last ? `${note}（另有 ${notes.length - shown.length} 条略）` : note;
    out.push(P.text(x, 228.6 + index * 3.6, fitText(prefix + body, maxW, 2.5), 2.5, 'start', 'it-s', 'text', { role: 'notes' }));
  });
  return out;
}

/* ------------------------------------------------------------------ 图面一致性 */

function checkBom(circuit: Circuit, rows: readonly BomRow[], drawn: readonly Prim[]): string[] {
  const problems: string[] = [];
  const tags = new Set<string>();
  for (const device of circuit.devices) tags.add(device.displayTag ?? device.tag);
  if (rows.length !== tags.size) problems.push(`[BOM_QTY] 明细表 ${rows.length} 行，但图上有 ${tags.size} 个位号`);
  for (const row of rows) {
    if (row.qty !== 1) problems.push(`[BOM_QTY] ${row.tag} 数量 ${row.qty}：同一位号是一件元件，触点/线圈/极数不另计`);
  }
  const drawnTags = new Set(drawn.filter((p) => p.t === 'text' && p.role === 'tag').map((p) => (p.t === 'text' ? p.value : '')));
  for (const row of rows) {
    if (!drawnTags.has(row.tag)) problems.push(`[BOM_NOT_DRAWN] 明细表里有 ${row.tag}（${row.name}），图上没有画出`);
  }
  for (const device of circuit.devices.filter((item) => item.kind === 'breaker')) {
    const why = breakerNameMismatch(device.name, device.model);
    if (why) problems.push(`[BOM_NAME_MODEL] ${device.tag} ${why}`);
  }
  return problems;
}

function issuePanel(lines: string[]): Prim[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, 8);
  const x = 14;
  const w = 136;
  const h = 7 + shown.length * 4;
  const y = ZONES.drawBottom - h;
  const out: Prim[] = [P.rect(x, y, w, h, 'frame', 'ic', { fill: '#fff' })];
  out.push(P.text(x + 2.5, y + 5, `出图前校验：${lines.length} 项待处理`, 3.4, 'start', 'it-t', 'frame'));
  shown.forEach((item, index) => {
    out.push(P.text(x + 2.5, y + 9.4 + index * 4, fitText(item, w - 5, 2.5), 2.5, 'start', 'it-s', 'frame'));
  });
  return out;
}

export function renderSheet(circuit: Circuit, options: SheetOptions): SheetResult {
  const issues = runErc(circuit);
  const layout: LayoutResult = layoutCircuit(circuit);
  const summary = ercSummary(issues);
  const rows = bomRows(circuit);

  const prims: Prim[] = [];
  prims.push(P.rect(6, 6, W - 12, H - 12, 'frame'));
  prims.push(P.rect(10, 10, W - 20, H - 20, 'frame'));
  const drawingNo = options.drawingNo ?? 'EL-M-001';
  const rightNote = `${drawingNo} · 由机型参数生成`;
  const rightW = textWidth(rightNote, 3);
  prims.push(P.text(W - 14, 19.6, rightNote, 3, 'end', 'it-s', 'frame'));
  prims.push(P.text(14, 20, fitText(`${options.project} · 电气原理图`, W - 28 - rightW - 8, 5), 5, 'start', 'it-t', 'frame'));

  prims.push(P.text(ZONES.main.left, 32, '主回路 · AC 380V 50Hz', 3.8, 'start', 'it-t', 'frame'));
  prims.push(P.line(ZONES.main.left, 34.5, ZONES.main.right - 2, 34.5, 'frame', 'ic ic-t'));
  prims.push(P.text(ZONES.ctrl.left, 32, '控制回路 · DC 24V', 3.8, 'start', 'it-t', 'frame'));
  prims.push(P.line(ZONES.ctrl.left, 34.5, ZONES.ctrl.right, 34.5, 'frame', 'ic ic-t'));
  prims.push(P.line(ZONES.main.right + 3, ZONES.drawTop + 2, ZONES.main.right + 3, ZONES.drawBottom, 'frame', 'ic ic-t ic-d'));
  prims.push(P.line(10, 218, W - 10, 218, 'frame', 'ic ic-t'));

  for (const wire of layout.wires) {
    for (let i = 0; i < wire.points.length - 1; i += 1) {
      const a = wire.points[i] as Pt;
      const b = wire.points[i + 1] as Pt;
      prims.push(P.line(a[0], a[1], b[0], b[1], 'wire', 'ic', { owner: wire.net }));
    }
  }
  prims.push(...layout.prims);
  const pinPoints = layout.symbols.flatMap((symbol) => Object.values(symbol.pins));
  const junctions = junctionPoints(layout.wires, pinPoints);
  for (const [x, y] of junctions) prims.push(P.circle(x, y, 0.75, 'dot', 'if', { filled: true }));

  prims.push(...deviceTable(rows));
  prims.push(...notesBlock(options.notes ?? []));

  // 状态栏两种文字都要放得下：先按较长的“有待处理问题”排一遍做自检
  const probe = [...prims, ...titleBlock(options, STATUS_TEXT.fail)];
  const problems = [
    ...layout.problems,
    ...checkTexts(probe, ZONES.frame),
    ...checkBom(circuit, rows, layout.prims)
  ];
  const deliverable = summary.errors === 0 && problems.length === 0;
  const status = deliverable
    ? summary.warnings > 0 ? `${STATUS_TEXT.ok}（${summary.warnings} 条提示）` : STATUS_TEXT.ok
    : STATUS_TEXT.fail;
  prims.push(...titleBlock(options, status));

  const panelLines = [
    ...issues.filter((issue) => issue.severity === 'error').map((issue) => `[${issue.code}] ${issue.message}`),
    ...problems
  ];
  const panel = issuePanel(panelLines);

  const out: string[] = [];
  out.push('<defs><pattern id="elGrid" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M4 0H0V4" class="ic-grid"/></pattern></defs>');
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#elGrid)"/>`);
  for (const p of [...prims, ...panel]) out.push(primSvg(p));

  return {
    svg: out.join(''),
    issues,
    problems,
    deliverable,
    prims,
    junctions
  };
}
