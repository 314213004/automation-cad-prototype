/**
 * 原理图渲染：把 Circuit + Layout 变成 A3 单页 SVG。
 *
 * 渲染只做三件事：符号、连线、表格；一旦 ERC 有 error 或布局有重叠，
 * 就在图上打红框列出问题，绝不假装是一张合格的图。
 */

import type { Circuit, CircuitDevice } from './circuit.ts';
import { ercSummary, runErc, type ErcIssue } from './circuit.ts';
import { layoutCircuit, type LayoutResult, type PlacedSymbol } from './layout.ts';

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
  problems: string[];
  /** 出图是否"可交付"：无 error、无重叠 */
  deliverable: boolean;
}

const W = 420;
const H = 297;

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

const line = (x1: number, y1: number, x2: number, y2: number, cls = 'ic'): string =>
  `<line class="${cls}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`;

const text = (x: number, y: number, value: string, cls = 'it-s', size = 3.2, anchor = 'start'): string =>
  `<text class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="${anchor}" style="font-size:${size}px">${esc(value)}</text>`;

const rect = (x: number, y: number, w: number, h: number, cls = 'ic'): string =>
  `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"/>`;

/** 三极元件：三根竖线 + 三个触点 + 机械联动虚线 */
function threePole(symbol: PlacedSymbol): string {
  const xs = [symbol.left, (symbol.left + symbol.right) / 2, symbol.right];
  const yTop = symbol.box.y;
  const yBot = symbol.box.y + symbol.box.h;
  let s = '';
  for (const x of xs) {
    s += line(x, yTop, x, yTop + 6);
    s += line(x, yBot - 6, x, yBot);
  }
  if (symbol.kind === 'breaker') {
    for (const x of xs) {
      s += line(x, yTop + 6, x + 6, yTop + 12);
      s += line(x + 4.4, yTop + 11.4, x + 7.6, yTop + 14.6);
      s += line(x + 7.6, yTop + 11.4, x + 4.4, yTop + 14.6);
      s += line(x + 6, yTop + 12, x, yBot - 6);
    }
  } else if (symbol.kind === 'contactor') {
    for (const x of xs) {
      s += line(x, yTop + 6, x, yTop + 8);
      s += line(x - 2.6, yTop + 8, x + 2.6, yTop + 8);
      s += line(x, yBot - 6, x + 5, yTop + 10);
    }
  } else {
    for (const x of xs) {
      s += rect(x - 5, yTop + 6, 10, 10);
      s += `<path class="ic ic-t" d="M${x - 3.4} ${yTop + 11}q1.7-2.4 3.4 0t3.4 0"/>`;
    }
  }
  s += `<line class="ic ic-d" x1="${xs[0]}" y1="${yTop + 15}" x2="${xs[2]}" y2="${yTop + 15}"/>`;
  return s;
}

function motorSymbol(symbol: PlacedSymbol): string {
  const cx = (symbol.left + symbol.right) / 2;
  const cy = symbol.box.y + 24;
  let s = '';
  for (const x of [symbol.left, cx, symbol.right]) s += line(x, symbol.box.y, x, cy - 13);
  s += `<circle class="ic" cx="${cx}" cy="${cy}" r="13"/>`;
  s += text(cx, cy + 2, 'M', 'it', 8, 'middle');
  s += text(cx, cy - 8.4, '3~', 'it-s', 3.4, 'middle');
  // 圆内星点：表示绕组 Y 接，不与外部三相短接
  s += line(cx - 5, cy - 5, cx, cy + 1, 'ic ic-t');
  s += line(cx + 5, cy - 5, cx, cy + 1, 'ic ic-t');
  s += line(cx, cy - 8, cx, cy + 1, 'ic ic-t');
  s += `<circle class="if" cx="${cx}" cy="${cy + 1}" r="0.7"/>`;
  s += line(cx, cy + 13, cx, symbol.box.y + symbol.box.h - 4);
  s += line(cx - 6, symbol.box.y + symbol.box.h - 4, cx + 6, symbol.box.y + symbol.box.h - 4);
  s += text(cx + 8, symbol.box.y + symbol.box.h - 2.6, 'PE', 'it-s', 2.9);
  return s;
}

function contactSymbol(symbol: PlacedSymbol): string {
  const { left: x0, right: x1, y } = symbol;
  const isNo = symbol.kind === 'no';
  let s = line(x0, y - 4.6, x0, y + 4.6);
  s += isNo ? line(x0, y + 4.6, x1 - 1.4, y - 1.8) : line(x1, y + 1.6, x0 + 0.4, y - 0.8);
  s += line(x1, y - 4.6, x1, y + 4.6);
  return s;
}

function coilSymbol(symbol: PlacedSymbol): string {
  const { left: x0, right: x1, y } = symbol;
  let s = line(x0, y, x0 + 3, y);
  s += rect(x0 + 3, y - 6, x1 - x0 - 6, 12);
  s += line(x0 + 6, y, x1 - 3, y, 'ic ic-t');
  s += line(x1 - 3, y, x1, y);
  return s;
}

function fuseSymbol(symbol: PlacedSymbol): string {
  const { left: x0, right: x1, y } = symbol;
  const cx = (x0 + x1) / 2;
  return rect(cx - 3.4, y - 5, 6.8, 10) + line(cx, y - 5, cx, y + 5);
}

function lampSymbol(symbol: PlacedSymbol): string {
  const cx = (symbol.left + symbol.right) / 2;
  const cy = symbol.y;
  return `<circle class="ic" cx="${cx}" cy="${cy}" r="5"/>` +
    line(cx - 3.4, cy - 3.4, cx + 3.4, cy + 3.4, 'ic ic-t') +
    line(cx + 3.4, cy - 3.4, cx - 3.4, cy + 3.4, 'ic ic-t');
}

function symbolSvg(symbol: PlacedSymbol): string {
  switch (symbol.kind) {
    case 'breaker':
    case 'contactor':
    case 'thermal':
      return threePole(symbol);
    case 'motor':
      return motorSymbol(symbol);
    case 'coil':
      return coilSymbol(symbol);
    case 'fuse':
      return fuseSymbol(symbol);
    case 'lamp':
      return lampSymbol(symbol);
    case 'nc':
    case 'no':
      return contactSymbol(symbol);
    case 'sensor':
      return rect(symbol.box.x, symbol.box.y, symbol.box.w, symbol.box.h) +
        text(symbol.box.x + 2.4, symbol.y - 0.6, symbol.displayTag, 'it', 4.2) +
        text(symbol.box.x + 2.4, symbol.y + 4, symbol.label ?? '', 'it-s', 2.7);
    case 'plc':
      return rect(symbol.box.x, symbol.box.y, symbol.box.w, symbol.box.h);
    default:
      return '';
  }
}

function titleBlock(options: SheetOptions, deliverable: boolean): string {
  const x = 288;
  const y = 237;
  const w = 122;
  const h = 50;
  const drawingNo = options.drawingNo ?? 'EL-M-001';
  let s = '<g>';
  s += rect(x, y, w, h);
  s += line(x, y + 15, x + w, y + 15);
  s += line(x, y + 29, x + w, y + 29);
  s += line(x, y + 39, x + w, y + 39);
  s += line(x + 62, y + 15, x + 62, y + 29, 'ic ic-t');
  s += line(x + 46, y + 29, x + 46, y + 39, 'ic ic-t');
  s += line(x + 78, y + 29, x + 78, y + 39, 'ic ic-t');
  s += text(x + 4, y + 10, `${options.project} · 电气原理图`, 'it-b', 4.2);
  s += text(x + w - 4, y + 10, drawingNo, 'it', 4.4, 'end');
  s += text(x + 4, y + 21, '图号', 'it-s', 3.2);
  s += text(x + 20, y + 21.4, drawingNo, 'it', 4);
  s += text(x + 66, y + 21, '页', 'it-s', 3.2);
  s += text(x + 78, y + 21.4, options.page ?? '1 / 1', 'it', 4);
  s += text(x + 4, y + 26, '比例', 'it-s', 3.2);
  s += text(x + 20, y + 26.4, '1:1', 'it', 4);
  s += text(x + 66, y + 26, '幅面', 'it-s', 3.2);
  s += text(x + 78, y + 26.4, 'A3', 'it', 4);
  s += text(x + 4, y + 35, '设计', 'it-s', 3.2);
  s += text(x + 20, y + 35.4, options.designer ?? '软件自动生成', 'it-t', 3.6);
  s += text(x + 50, y + 35, '日期', 'it-s', 3.2);
  s += text(x + 62, y + 35.4, options.date ?? '', 'it', 3.6);
  s += text(x + 4, y + 45, '状态', 'it-s', 3.2);
  s += text(x + 20, y + 45.4, deliverable ? '校验通过' : '有待处理问题', 'it-t', 3.6);
  s += text(x + 82, y + 45, '单位', 'it-s', 3.2);
  s += text(x + 96, y + 45.4, 'mm', 'it', 3.6);
  s += '</g>';
  return s;
}

function deviceTable(circuit: Circuit): string {
  const rows = new Map<string, { tag: string; name: string; qty: number; model: string }>();
  for (const device of circuit.devices) {
    const tag = device.displayTag ?? device.tag;
    const existing = rows.get(tag);
    if (existing) existing.qty += 1;
    else rows.set(tag, { tag, name: device.name, qty: 1, model: device.model });
  }
  const list = [...rows.values()];
  const x = 14;
  const w = 166;
  const hh = 6;
  const bottom = 286;
  const rh = Math.min(4.72, (bottom - 226 - hh) / Math.max(1, list.length));
  const y = bottom - (hh + list.length * rh);
  let s = text(x, y - 2.6, '元件明细表', 'it-t', 4.2);
  s += rect(x, y, w, hh + list.length * rh);
  s += line(x, y + hh, x + w, y + hh, 'ic ic-t');
  s += text(x + 3, y + 4.2, '代号', 'it-s', 3);
  s += text(x + 44, y + 4.2, '名称', 'it-s', 3);
  s += text(x + w - 4, y + 4.2, '数量', 'it-s', 3, 'end');
  list.forEach((row, index) => {
    const ry = y + hh + index * rh;
    if (index > 0) s += line(x, ry, x + w, ry, 'ic ic-t');
    s += text(x + 3, ry + 3.4, row.tag, 'it-s', 3);
    s += text(x + 44, ry + 3.4, row.name, 'it-s', 3);
    s += text(x + w - 4, ry + 3.4, String(row.qty), 'it-s', 3, 'end');
  });
  return s;
}

function issuePanel(issues: ErcIssue[], problems: string[]): string {
  const all = [
    ...issues.filter((issue) => issue.severity === 'error').map((issue) => `[${issue.code}] ${issue.message}`),
    ...problems.map((problem) => `[LAYOUT] ${problem}`)
  ].slice(0, 7);
  if (all.length === 0) return '';
  const x = 14;
  const y = 196;
  const w = 166;
  const h = 8 + all.length * 4.6;
  let s = `<rect class="ic" x="${x}" y="${y}" width="${w}" height="${h}" style="stroke:#c0392b"/>`;
  s += text(x + 3, y + 6, `出图前校验：${all.length} 项待处理`, 'it-t', 3.8);
  all.forEach((item, index) => {
    s += text(x + 3, y + 11 + index * 4.6, item.slice(0, 62), 'it-s', 2.9);
  });
  return s;
}

export function renderSheet(circuit: Circuit, options: SheetOptions): SheetResult {
  const issues = runErc(circuit);
  const layout: LayoutResult = layoutCircuit(circuit);
  const summary = ercSummary(issues);
  const deliverable = summary.errors === 0 && layout.problems.length === 0;

  const out: string[] = [];
  out.push('<defs><pattern id="elGrid" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M4 0H0V4" class="ic-grid"/></pattern></defs>');
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#elGrid)"/>`);
  out.push(rect(6, 6, W - 12, H - 12));
  out.push(rect(10, 10, W - 20, H - 20));

  out.push(text(14, 20, `${options.project} · 电气原理图`, 'it-t', 5));
  out.push(text(W - 16, 20, `${options.drawingNo ?? 'EL-M-001'} · 由机型参数生成`, 'it-s', 3.2, 'end'));

  /* 主回路标题与三相母线 */
  out.push(text(26, 32, '主回路 · AC 380V 50Hz', 'it-t', 4.2));
  out.push(line(26, 35, 130, 35, 'ic ic-t'));
  const mainSymbols = layout.symbols.filter((symbol) => ['breaker', 'contactor', 'thermal', 'motor'].includes(symbol.kind));
  const xs = [68, 84, 100];
  if (mainSymbols.length > 0) {
    xs.forEach((x, index) => {
      out.push(text(x, 40, `L${index + 1}`, 'it', 4, 'middle'));
    });
  }
  for (const symbol of mainSymbols) {
    out.push(symbolSvg(symbol));
    out.push(text(symbol.box.x - 2, symbol.box.y + 4, symbol.displayTag, 'it', 4.6, 'end'));
    out.push(text(symbol.box.x - 2, symbol.box.y + 9, symbol.label ?? '', 'it-s', 2.9, 'end'));
  }

  /* 控制回路标题与母线 */
  out.push(text(204, 32, '控制回路 · DC 24V', 'it-t', 4.2));
  out.push(line(204, 35, 400, 35, 'ic ic-t'));
  out.push(line(layout.rails.plusX, layout.rails.top, layout.rails.plusX, layout.rails.bottom, 'ic ic-b'));
  out.push(line(layout.rails.minusX, layout.rails.top, layout.rails.minusX, layout.rails.bottom, 'ic ic-b'));
  out.push(text(layout.rails.plusX, layout.rails.top - 4, '+24V', 'it', 4, 'middle'));
  out.push(text(layout.rails.minusX, layout.rails.top - 4, '0V', 'it', 4, 'middle'));

  /* 连线（先画线，符号压在上面） */
  for (const wire of layout.wires) {
    for (let index = 0; index < wire.points.length - 1; index += 1) {
      const a = wire.points[index];
      const b = wire.points[index + 1];
      if (!a || !b) continue;
      out.push(line(a[0], a[1], b[0], b[1]));
    }
  }

  // PLC 引脚 / 传感器三线 / 指示灯：按电路数据补画，不靠肉眼摆
  const plcSymbol = layout.symbols.find((symbol) => symbol.kind === 'plc');
  const sensorSymbols = layout.symbols.filter((symbol) => symbol.kind === 'sensor');
  if (plcSymbol) {
    const plcDevice = circuit.devices.find((device) => device.kind === 'plc');
    out.push(text(plcSymbol.box.x + 4, plcSymbol.box.y + 8, plcSymbol.displayTag, 'it', 4.6));
    out.push(text(plcSymbol.box.x + 4, plcSymbol.box.y + 13, plcDevice?.model ?? '', 'it-s', 2.9));
    out.push(line(plcSymbol.box.x, plcSymbol.box.y + 17, plcSymbol.box.x + plcSymbol.box.w, plcSymbol.box.y + 17, 'ic ic-t'));
    // L+ / M
    out.push(line(layout.rails.plusX, plcSymbol.box.y + 26, plcSymbol.box.x + 12, plcSymbol.box.y + 26));
    out.push(`<circle class="if" cx="${plcSymbol.box.x + 12}" cy="${plcSymbol.box.y + 26}" r="0.8"/>`);
    out.push(text(plcSymbol.box.x + 14, plcSymbol.box.y + 25, 'L+', 'it-s', 2.9));
    out.push(line(plcSymbol.box.x + 40, plcSymbol.box.y + plcSymbol.box.h, plcSymbol.box.x + 40, 192));
    out.push(line(plcSymbol.box.x + 40, 192, layout.rails.minusX, 192));
    out.push(`<circle class="if" cx="${layout.rails.minusX}" cy="192" r="0.8"/>`);
    out.push(text(plcSymbol.box.x + 38, plcSymbol.box.y + plcSymbol.box.h - 3, 'M', 'it-s', 2.9, 'end'));
  }

  sensorSymbols.forEach((symbol, index) => {
    const device = circuit.devices.find((item) => item.tag === symbol.tag);
    const address = device?.pins.find((pin) => pin.startsWith('I')) ?? `I0.${index + 3}`;
    out.push(text(symbol.box.x + 2.6, symbol.y - 1, symbol.displayTag, 'it', 4.2));
    out.push(text(symbol.box.x + 2.6, symbol.y + 4, device?.spec ?? '', 'it-s', 2.6));
    // 三线：+24V / 0V / OUT → PLC
    out.push(line(symbol.box.x + 8, symbol.box.y, symbol.box.x + 8, symbol.box.y - 6, 'ic ic-t'));
    out.push(text(symbol.box.x + 9.4, symbol.box.y - 3, '+24V', 'it-s', 2.5));
    out.push(line(symbol.box.x + 20, symbol.box.y + symbol.box.h, symbol.box.x + 20, symbol.box.y + symbol.box.h + 6, 'ic ic-t'));
    out.push(text(symbol.box.x + 21.4, symbol.box.y + symbol.box.h + 4, '0V', 'it-s', 2.5));
    if (plcSymbol) {
      const pinY = symbol.box.y + symbol.box.h / 2;
      out.push(line(plcSymbol.box.x + plcSymbol.box.w, pinY, symbol.box.x, pinY));
      out.push(`<circle class="if" cx="${symbol.box.x}" cy="${pinY}" r="0.7"/>`);
      out.push(text(plcSymbol.box.x + plcSymbol.box.w - 2, pinY - 1.6, address, 'it-s', 2.6, 'end'));
    }
  });

  const lampSymbol = layout.symbols.find((symbol) => symbol.kind === 'lamp');
  if (plcSymbol && lampSymbol) {
    out.push(line(plcSymbol.box.x + plcSymbol.box.w, lampSymbol.y, lampSymbol.left, lampSymbol.y));
    out.push(`<circle class="if" cx="${lampSymbol.left}" cy="${lampSymbol.y}" r="0.7"/>`);
    out.push(line(lampSymbol.right, lampSymbol.y, layout.rails.minusX, lampSymbol.y));
    out.push(`<circle class="if" cx="${layout.rails.minusX}" cy="${lampSymbol.y}" r="0.7"/>`);
    out.push(text(plcSymbol.box.x + plcSymbol.box.w - 2, lampSymbol.y - 1.6, 'Q0.0', 'it-s', 2.6, 'end'));
  }

  for (const symbol of layout.symbols) {
    if (['breaker', 'contactor', 'thermal', 'motor', 'plc', 'sensor', 'lamp'].includes(symbol.kind)) continue;
    out.push(symbolSvg(symbol));
    if (symbol.kind !== 'plc') {
      out.push(text(symbol.box.x + symbol.box.w / 2, symbol.y - 5, symbol.displayTag, 'it', 4.2, 'middle'));
    }
  }

  out.push(deviceTable(circuit));
  out.push(issuePanel(issues, layout.problems));
  out.push(titleBlock(options, deliverable));

  const notes = (options.notes ?? []).slice(0, 3);
  notes.forEach((note, index) => {
    out.push(text(186, 236 + index * 4.6, note, 'it-s', 3));
  });

  return {
    svg: out.join(''),
    issues,
    problems: layout.problems,
    deliverable
  };
}
