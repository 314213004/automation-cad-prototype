import { BOM_HEADERS, type BomRow } from './bom';
import type { InterferenceHit } from '../mech/interference';
import type { StressResult } from '../mech/stress';

export interface ReportStressConclusion {
  name: string;
  result: StressResult;
}

export interface ReportData {
  project: {
    name: string;
    code?: string;
    author?: string;
    date?: string;
  };
  bom: readonly BomRow[];
  interference: readonly InterferenceHit[];
  stress: readonly ReportStressConclusion[];
  note?: string;
}

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

export function renderReportHtml(data: ReportData): string {
  const project = data.project;
  const severityLabel: Record<string, string> = { error: '严重', warning: '警告', info: '提示' };
  const bomRows = data.bom.map((row) => `<tr>
    <td class="num">${escapeHtml(row.index)}</td><td>${escapeHtml(row.name)}</td><td class="mono">${escapeHtml(row.model)}</td>
    <td class="num">${escapeHtml(row.quantity)}</td><td>${escapeHtml(row.material)}</td><td>${escapeHtml(row.note ?? '')}</td>
  </tr>`).join('');
  const hitRows = data.interference.length > 0
    ? data.interference.map((hit, index) => `<tr>
        <td class="num">${index + 1}</td><td><span class="sev ${hit.severity}">${severityLabel[hit.severity] ?? hit.severity}</span></td>
        <td>${escapeHtml(hit.a)} ↔ ${escapeHtml(hit.b)}</td>
        <td class="mono">${hit.overlap.map((value) => value.toFixed(2)).join(' × ')} mm</td>
        <td class="mono">${hit.volumeApprox.toFixed(1)} mm³</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">未发现包围盒级干涉</td></tr>';
  const stressCards = data.stress.length > 0
    ? data.stress.map(({ name, result }) => `<article class="stress-card ${result.pass ? 'pass' : 'fail'}">
        <header><b>${escapeHtml(name)}</b><span>${result.pass ? '通过' : '不通过'}</span></header>
        <p>${escapeHtml(result.verdict)}</p>
        <code>${escapeHtml(result.formula)}</code>
        <dl>${result.outputs.map((output) => `<div><dt>${escapeHtml(output.label)}</dt><dd>${escapeHtml(output.value)} ${escapeHtml(output.unit)}</dd></div>`).join('')}</dl>
      </article>`).join('')
    : '<p class="empty">尚未运行受力分析。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.name)} · 机械校核报告</title>
<style>
  @page { size: A3 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #17202a; background: #fff; font: 10pt/1.45 "Microsoft YaHei", "Noto Sans SC", sans-serif; }
  .sheet { width: 420mm; min-height: 297mm; padding: 12mm 14mm; }
  h1 { margin: 0 0 2mm; font-size: 22pt; letter-spacing: .04em; }
  h2 { margin: 7mm 0 2.5mm; padding-bottom: 1.5mm; border-bottom: .5mm solid #1d5c54; color: #14534c; font-size: 13pt; }
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
  .sev { display: inline-block; padding: .5mm 1.6mm; border-radius: 1mm; font-size: 7.5pt; }
  .sev.error { color: #8c1d18; background: #fde7e5; border: .2mm solid #e5a29c; }
  .sev.warning { color: #7a5412; background: #fff4d6; border: .2mm solid #e6c77a; }
  .sev.info { color: #25547a; background: #e8f2fb; }
  .stress-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4mm; }
  .stress-card { border: .3mm solid #c9d1d7; border-top: 1.2mm solid #2c8a7e; padding: 3mm; break-inside: avoid; }
  .stress-card.fail { border-top-color: #c33f35; background: #fff8f7; }
  .stress-card header { display: flex; align-items: center; justify-content: space-between; }
  .stress-card header span { color: #187a6e; font-weight: 700; }
  .stress-card.fail header span { color: #b32c23; }
  .stress-card p { margin: 2mm 0; font-size: 9pt; }
  .stress-card code { display: block; padding: 2mm; background: #f2f5f6; color: #33414b; font-size: 7.5pt; line-height: 1.55; word-break: break-all; }
  .stress-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1mm 2mm; margin: 2mm 0 0; }
  .stress-card dl div { display: flex; justify-content: space-between; gap: 2mm; border-bottom: .2mm dotted #c9d1d7; }
  .stress-card dt { color: #66747e; font-size: 7.5pt; }
  .stress-card dd { margin: 0; font: 8pt Consolas, monospace; }
  .empty { color: #71808a; text-align: center; padding: 5mm; }
  .note { margin-top: 5mm; padding: 3mm; border: .25mm solid #d6dde1; background: #f7fafb; color: #52616b; font-size: 8.5pt; }
  .foot { display: flex; justify-content: space-between; margin-top: 5mm; padding-top: 2mm; border-top: .25mm solid #aebbc3; color: #77858f; font-size: 7.5pt; }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(project.name)} · 机械校核报告</h1>
  <div class="sub">A3 横向 · 包围盒级干涉初筛 · 公式化受力校核 · AutomationCAD</div>
  <section class="meta">
    <div><span>项目编号</span><b>${escapeHtml(project.code ?? '—')}</b></div>
    <div><span>设计</span><b>${escapeHtml(project.author ?? '—')}</b></div>
    <div><span>日期</span><b>${escapeHtml(project.date ?? new Date().toLocaleDateString('zh-CN'))}</b></div>
    <div><span>导出时间</span><b>${escapeHtml(new Date().toLocaleString('zh-CN'))}</b></div>
  </section>
  <h2>BOM 明细</h2>
  <table>
    <thead><tr>${BOM_HEADERS.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
    <tbody>${bomRows || `<tr><td colspan="6" class="empty">BOM 为空</td></tr>`}</tbody>
  </table>
  <h2>干涉检查（包围盒级）</h2>
  <table>
    <thead><tr><th>序号</th><th>级别</th><th>零件对</th><th>三轴重叠</th><th>近似重叠体积</th></tr></thead>
    <tbody>${hitRows}</tbody>
  </table>
  <h2>受力结论</h2>
  <div class="stress-grid">${stressCards}</div>
  <div class="note">${escapeHtml(data.note ?? '说明：干涉结果为轴对齐包围盒初筛，相切（重叠为 0）不计入；精检需在 CAD 内核中按三角面/B-rep 复算。受力计算按线弹性、小变形与给定许用条件估算。')}</div>
  <div class="foot"><span>AutomationCAD · 非标自动化整机设计</span><span>报告自动生成 · 请与设计文件一并归档</span></div>
</div>
</body>
</html>`;
}
