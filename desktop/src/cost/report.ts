/**
 * 成本报告（HTML / CSV）渲染层。
 *
 * 与 `computeCost` 共用同一份 `CostReport`，保证面板上看到的金额与报告里写的完全一致。
 * 纯函数：不依赖 DOM、不读文件，便于单测；HTML 可直接交给 `desktop.exportReport` 打印成 PDF。
 */
import type { CostReport, MissingReason } from './engine.ts';

export interface CostReportProject {
  name: string;
  code?: string;
  author?: string;
  date?: string;
  /** 币种代码，缺省 CNY */
  currency?: string;
}

export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  NO_PRICE: '价格簿无此物料',
  NO_PART_ID: 'BOM 缺物料号'
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥'
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] ?? character;
  });
}

function fixed2(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  return value.toFixed(2);
}

/** 金额显示：千分位 + 两位小数，负数保留符号。 */
export function money(value: number): string {
  if (!Number.isFinite(value)) return '0.00';
  const negative = value < 0;
  const [integer, decimals] = fixed2(Math.abs(value)).split('.');
  const grouped = (integer ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}.${decimals ?? '00'}`;
}

/** 带币种符号的金额，如 `¥1,398.64`。 */
export function moneyWithCurrency(value: number, currency = 'CNY'): string {
  return `${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${money(value)}`;
}

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(digits);
}

/** 一行中文摘要，供状态栏与冒烟断言使用。 */
export function describeCost(report: CostReport, currency = 'CNY'): string {
  const { totals, lines, missing, warnings } = report;
  return `成本：合计 ${moneyWithCurrency(totals.grand, currency)} · 明细 ${lines.length} 行 · 缺价 ${missing.length} 项 · 警告 ${warnings.length} 条`;
}

function lineRows(report: CostReport): string {
  if (report.lines.length === 0) {
    return '<tr><td colspan="9" class="empty">没有可计价的物料行</td></tr>';
  }
  return report.lines.map((line, index) => `<tr>
      <td class="num">${index + 1}</td>
      <td class="mono">${escapeHtml(line.partId)}</td>
      <td>${escapeHtml(line.model)}</td>
      <td>${escapeHtml(line.category)}</td>
      <td class="num">${num(line.qty, 0)}</td>
      <td class="num">${money(line.unit)}</td>
      <td class="num">${money(line.subtotal)}</td>
      <td>${escapeHtml(line.priceSource)}</td>
      <td class="num">${line.priceAgeDays}</td>
    </tr>`).join('');
}

function categoryRows(report: CostReport): string {
  if (report.byCategory.length === 0) {
    return '<tr><td colspan="3" class="empty">没有分类小计</td></tr>';
  }
  return report.byCategory.map((entry) => `<tr>
      <td>${escapeHtml(entry.category)}</td>
      <td class="num">${entry.count}</td>
      <td class="num">${money(entry.subtotal)}</td>
    </tr>`).join('');
}

function missingRows(report: CostReport): string {
  if (report.missing.length === 0) {
    return '<tr><td colspan="4" class="empty">全部物料均有价格</td></tr>';
  }
  return report.missing.map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.spec ?? '—')}</td>
      <td class="num">${num(item.qty, 0)}</td>
      <td>${escapeHtml(MISSING_REASON_LABELS[item.reason] ?? item.reason)}</td>
    </tr>`).join('');
}

function warningList(report: CostReport): string {
  if (report.warnings.length === 0) return '<div class="empty-inline">无告警</div>';
  return `<ul class="warns">${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

/** 渲染成本报告 HTML（A4 纵向）。 */
export function renderCostReportHtml(project: CostReportProject, report: CostReport): string {
  const currency = project.currency ?? 'CNY';
  const { totals, labor, extras, lines, missing } = report;
  const verdict = `合计 ${moneyWithCurrency(totals.grand, currency)} · 明细 ${lines.length} 行 · 缺价 ${missing.length} 项`;
  const verdictClass = missing.length > 0 ? ' bad' : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.name)} · 机台成本报告</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #17202a; background: #fff; font: 10pt/1.45 "Microsoft YaHei", "Noto Sans SC", sans-serif; }
  .sheet { width: 210mm; min-height: 297mm; padding: 14mm 15mm; }
  h1 { margin: 0 0 2mm; font-size: 19pt; letter-spacing: .03em; }
  h2 { margin: 6mm 0 2.5mm; padding-bottom: 1.5mm; border-bottom: .5mm solid #1d5c54; color: #14534c; font-size: 12pt; }
  .sub { color: #5c6872; font-size: 9pt; }
  .meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2mm; margin: 4mm 0 2mm; }
  .meta div { border: .25mm solid #c9d1d7; padding: 2.5mm 3mm; background: #f7fafb; }
  .meta span { display: block; color: #71808a; font-size: 8pt; }
  .meta b { font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  th { background: #e8f2f0; color: #14534c; text-align: left; }
  th, td { border: .25mm solid #bac5cc; padding: 1.6mm 2.2mm; vertical-align: top; }
  tr:nth-child(even) td { background: #fafcfc; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: Consolas, "Cascadia Mono", monospace; }
  .total-row td { font-weight: 700; background: #eef6f4; }
  .verdict { margin: 3mm 0 0; padding: 2.5mm 3mm; border-left: 1.2mm solid #1d5c54; background: #f4f9f8; font-size: 10pt; }
  .verdict.bad { border-left-color: #c9a227; background: #fffbea; color: #6b5410; }
  .empty { color: #71808a; text-align: center; padding: 4mm; }
  .empty-inline { color: #71808a; padding: 1mm 0; }
  .warns { margin: 0; padding-left: 5mm; color: #7a5412; }
  .note { margin-top: 5mm; padding: 3mm; border: .25mm solid #d6dde1; background: #f7fafb; color: #52616b; font-size: 8.5pt; }
  .foot { display: flex; justify-content: space-between; margin-top: 5mm; padding-top: 2mm; border-top: .25mm solid #aebbc3; color: #77858f; font-size: 7.5pt; }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(project.name)} · 机台成本报告</h1>
  <div class="sub">硬件 · 辅材 · 人工 · 加成与税金 · AutomationCAD</div>
  <section class="meta">
    <div><span>项目编号</span><b>${escapeHtml(project.code ?? '—')}</b></div>
    <div><span>设计</span><b>${escapeHtml(project.author ?? '—')}</b></div>
    <div><span>日期</span><b>${escapeHtml(project.date ?? new Date().toLocaleDateString('zh-CN'))}</b></div>
    <div><span>币种</span><b>${escapeHtml(currency)}</b></div>
  </section>
  <div class="verdict${verdictClass}">${escapeHtml(verdict)}</div>

  <h2>总价构成</h2>
  <table>
    <thead><tr><th style="width:52mm">项目</th><th style="width:34mm">金额</th><th>说明</th></tr></thead>
    <tbody>
      <tr><td>硬件</td><td class="num">${money(totals.hardware)}</td><td>BOM 明细合计（不含加成与税）</td></tr>
      <tr><td>辅材</td><td class="num">${money(totals.extras)}</td><td>导轨 ${money(extras.dinRail)} · 线槽 ${money(extras.duct)} · 线缆 ${money(extras.wire)}</td></tr>
      <tr><td>人工</td><td class="num">${money(totals.labor)}</td><td>接线 ${money(labor.wiring)} · 端子 ${money(labor.terminals)} · 装配 ${money(labor.assembly)}</td></tr>
      <tr><td>小计</td><td class="num">${money(totals.subtotal)}</td><td>硬件 + 辅材 + 人工</td></tr>
      <tr><td>加成</td><td class="num">${money(totals.markup)}</td><td>按小计计取</td></tr>
      <tr><td>税金</td><td class="num">${money(totals.tax)}</td><td>按小计 + 加成计取</td></tr>
      <tr><td>运费</td><td class="num">${money(totals.freight)}</td><td>固定金额</td></tr>
      <tr class="total-row"><td>合计</td><td class="num">${money(totals.grand)}</td><td>对外报价基数（${escapeHtml(currency)}）</td></tr>
    </tbody>
  </table>

  <h2>硬件明细</h2>
  <table>
    <thead><tr>
      <th style="width:10mm">#</th><th style="width:30mm">物料号</th><th>型号</th><th style="width:22mm">分类</th>
      <th style="width:13mm">数量</th><th style="width:20mm">单价</th><th style="width:22mm">小计</th>
      <th style="width:24mm">价格来源</th><th style="width:14mm">价格天数</th>
    </tr></thead>
    <tbody>${lineRows(report)}</tbody>
  </table>

  <h2>分类小计</h2>
  <table>
    <thead><tr><th>分类</th><th style="width:20mm">行数</th><th style="width:30mm">金额</th></tr></thead>
    <tbody>${categoryRows(report)}</tbody>
  </table>

  <h2>缺价清单</h2>
  <table>
    <thead><tr><th>名称</th><th style="width:34mm">规格</th><th style="width:16mm">数量</th><th style="width:40mm">原因</th></tr></thead>
    <tbody>${missingRows(report)}</tbody>
  </table>

  <h2>告警</h2>
  ${warningList(report)}

  <div class="note">价格说明：单价来自所选价格簿（含阶梯价与本次手工改价），示例条目已排除；价格超过时效阈值时会在「告警」中列出。本报告为设计阶段估算，不构成正式报价；定型前须以采购/财务确认的价目表替换。</div>
  <div class="foot"><span>AutomationCAD · 非标自动化整机设计</span><span>报告自动生成 · 请与 BOM 一并归档</span></div>
</div>
</body>
</html>`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 成本 CSV（UTF-8 BOM，Excel 直接双击不乱码）。
 *
 * 结构：明细表 + 汇总块 + 缺价块 + 告警块，块之间空行分隔，便于人工查看也便于脚本切块。
 */
export function costReportCsv(report: CostReport): string {
  const rows: string[] = [];
  rows.push('明细');
  rows.push(['序号', '物料号', '型号', '分类', '数量', '单价', '小计', '价格来源', '价格天数'].map(csvCell).join(','));
  report.lines.forEach((line, index) => {
    rows.push([
      index + 1,
      line.partId,
      line.model,
      line.category,
      line.qty,
      fixed2(line.unit),
      fixed2(line.subtotal),
      line.priceSource,
      line.priceAgeDays
    ].map(csvCell).join(','));
  });
  if (report.lines.length === 0) rows.push('（无明细）');

  rows.push('');
  rows.push('汇总');
  rows.push(['项目', '金额'].map(csvCell).join(','));
  const summary: Array<[string, number]> = [
    ['硬件', report.totals.hardware],
    ['辅材', report.totals.extras],
    ['人工', report.totals.labor],
    ['小计', report.totals.subtotal],
    ['加成', report.totals.markup],
    ['税金', report.totals.tax],
    ['运费', report.totals.freight],
    ['合计', report.totals.grand]
  ];
  for (const [label, value] of summary) rows.push([label, fixed2(value)].map(csvCell).join(','));

  rows.push('');
  rows.push('缺价');
  rows.push(['名称', '规格', '数量', '原因'].map(csvCell).join(','));
  if (report.missing.length === 0) rows.push('（无缺价）');
  for (const item of report.missing) {
    rows.push([item.name, item.spec ?? '', item.qty, MISSING_REASON_LABELS[item.reason] ?? item.reason].map(csvCell).join(','));
  }

  rows.push('');
  rows.push('告警');
  rows.push(['内容'].map(csvCell).join(','));
  if (report.warnings.length === 0) rows.push('（无告警）');
  for (const warning of report.warnings) rows.push(csvCell(warning));

  return `\uFEFF${rows.join('\r\n')}`;
}
