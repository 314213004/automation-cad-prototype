import { BOM_HEADERS, type BomRow } from './bom.ts';
import type { InterferenceHit } from '../mech/interference';
import type { StressResult } from '../mech/stress';
import type { CommissionReport } from '../commission/types.ts';
import type { ProjectGeometryReview } from '../design/geometry-review.ts';

export interface ReportStationCycleRow {
  stationName: string;
  seconds: number | null;
  sourceLabel: string;
  verificationLabel: string;
  state: 'pending-measurement' | 'invalid' | 'not-entered';
  bottleneck: boolean;
}

export interface ReportStationCycle {
  calculationSource: 'engineer-input' | 'model-estimate';
  calculationSourceLabel: string;
  inputStatusLabel: string;
  throughputPerMin: number;
  cycleSeconds: number;
  targetPerMin: number;
  bottleneckLabel: string;
  explanation: string;
  stations: readonly ReportStationCycleRow[];
}

export interface ReportStressConclusion {
  name: string;
  result: StressResult;
}

export interface ReportEngineeringNotes {
  assumptions: readonly string[];
  warnings: readonly string[];
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
  commission?: CommissionReport;
  stationCycle?: ReportStationCycle;
  engineeringNotes?: ReportEngineeringNotes;
  geometryReview?: ProjectGeometryReview;
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
  const hitRows = data.geometryReview?.status === 'not-executed'
    ? '<tr><td colspan="5" class="empty">未执行/未验证：当前没有可检查的 CAD 几何；不得解释为无干涉或校核通过</td></tr>'
    : data.interference.length > 0
    ? data.interference.map((hit, index) => `<tr>
        <td class="num">${index + 1}</td><td><span class="sev ${hit.severity}">${severityLabel[hit.severity] ?? hit.severity}</span></td>
        <td>${escapeHtml(hit.a)} ↔ ${escapeHtml(hit.b)}</td>
        <td class="mono">${hit.overlap.map((value) => value.toFixed(2)).join(' × ')} mm</td>
        <td class="mono">${hit.volumeApprox.toFixed(1)} mm³</td>
      </tr>`).join('')
    : data.geometryReview?.status === 'aabb-screened'
      ? '<tr><td colspan="5" class="empty">本次包围盒级初筛未发现干涉；不等同于 B-rep 精检或工程签核</td></tr>'
      : '<tr><td colspan="5" class="empty">未发现包围盒级干涉</td></tr>';
  const geometryReviewSection = data.geometryReview
    ? data.geometryReview.status === 'not-executed'
      ? '<section class="geometry-review-state unverified" role="note"><b>3D/干涉校核未执行/未验证 · 概念版</b><p>当前没有可检查的 CAD 几何。未执行不能解释为无干涉、校核通过或型号级实体验证；向导生成的 STL 仅为概念估算占位体。导出文件不代表验收或发布。</p></section>'
      : `<section class="geometry-review-state screened" role="note"><b>初步版：仅完成包围盒级干涉初筛（${data.geometryReview.partCount} 件）</b><p>来源：${escapeHtml(data.geometryReview.sourceName ?? '当前主视口几何')}。此结果不代表 B-rep 精检、型号级 CAD 验证或工程签核；导出文件不代表验收或发布。</p></section>`
    : '';
  const engineeringNotesSection = data.engineeringNotes
    ? `<h2>CAD 几何假设与工程警告</h2>
  <p class="engineering-notes-lead">几何精度：概念估算占位体；选型型号未必已反映在三维包络中。安装与制造前请按厂商样本或实际模型复核。</p>
  <div class="engineering-notes-grid">
    <section><h3>设计假设</h3><ul>${data.engineeringNotes.assumptions.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul></section>
    <section class="engineering-warnings"><h3>需复核警告</h3><ul>${data.engineeringNotes.warnings.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul></section>
  </div>`
    : '';
  const stressCards = data.stress.length > 0
    ? data.stress.map(({ name, result }) => `<article class="stress-card ${result.pass ? 'pass' : 'fail'}">
        <header><b>${escapeHtml(name)}</b><span>${result.pass ? '通过' : '不通过'}</span></header>
        <p>${escapeHtml(result.verdict)}</p>
        <code>${escapeHtml(result.formula)}</code>
        <dl>${result.outputs.map((output) => `<div><dt>${escapeHtml(output.label)}</dt><dd>${escapeHtml(output.value)} ${escapeHtml(output.unit)}</dd></div>`).join('')}</dl>
      </article>`).join('')
    : '<p class="empty">尚未运行受力分析。</p>';
  const stationCycleSection = data.stationCycle
    ? `<h2>工位周期输入与产能依据</h2>
  <section class="cycle-meta">
    <div><span>产能依据</span><b>${escapeHtml(data.stationCycle.calculationSourceLabel)}</b></div>
    <div><span>输入状态</span><b>${escapeHtml(data.stationCycle.inputStatusLabel)}</b></div>
    <div><span>整机节拍</span><b>${Number.isFinite(data.stationCycle.cycleSeconds) ? data.stationCycle.cycleSeconds.toFixed(2) : '—'} 秒/件</b></div>
    <div><span>计算产能</span><b>${Number.isFinite(data.stationCycle.throughputPerMin) ? data.stationCycle.throughputPerMin.toFixed(2) : '—'} 件/分钟</b></div>
    <div><span>目标产能</span><b>${Number.isFinite(data.stationCycle.targetPerMin) ? escapeHtml(data.stationCycle.targetPerMin) : '—'} 件/分钟</b></div>
  </section>
  <p class="cycle-explanation">${escapeHtml(data.stationCycle.explanation)}</p>
  <p class="cycle-bottleneck"><b>${escapeHtml(data.stationCycle.bottleneckLabel)}</b></p>
  <table class="cycle-table">
    <thead><tr><th>工位</th><th>完整周期（秒/件）</th><th>输入来源</th><th>验证状态与计算用途</th></tr></thead>
    <tbody>${data.stationCycle.stations.map((station) => {
      const seconds = station.seconds === null
        ? '—'
        : Number.isFinite(station.seconds)
          ? station.seconds.toFixed(2)
          : '无效值（非有限数）';
      const severity = station.state === 'pending-measurement' ? 'info' : 'warning';
      return `<tr class="${station.bottleneck ? 'cycle-bottleneck-row' : ''}">
        <td>${escapeHtml(station.stationName)}${station.bottleneck ? ' <span class="sev warning">瓶颈</span>' : ''}</td>
        <td class="mono">${escapeHtml(seconds)}</td>
        <td>${escapeHtml(station.sourceLabel)}</td>
        <td><span class="sev ${severity}">${escapeHtml(station.verificationLabel)}</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" class="empty">无工位周期输入</td></tr>'}</tbody>
  </table>`
    : '';
  const commissionRows = data.commission
    ? data.commission.powerUp.results.map((result) => `<tr>
        <td>${escapeHtml(result.name)}</td><td><span class="sev ${result.pass ? 'info' : 'error'}">${result.pass ? '通过' : '失败'}</span></td>
        <td class="mono">${escapeHtml(result.expected)}</td><td class="mono">${escapeHtml(result.actual)}</td><td class="num">${result.durationMs} ms</td>
      </tr>`).join('')
    : '';
  const commissionCaseRows = data.commission && data.commission.cases.length > 0
    ? data.commission.cases.flatMap((testCase) => testCase.results.map((result) => `<tr>
        <td>${escapeHtml(testCase.name)}</td><td>${escapeHtml(result.name)}</td>
        <td><span class="sev ${result.pass ? 'info' : 'error'}">${result.pass ? '通过' : '失败'}</span></td>
        <td class="mono">${escapeHtml(result.expected)}</td><td class="mono">${escapeHtml(result.actual)}</td><td class="num">${result.durationMs} ms</td>
      </tr>`)).join('')
    : '<tr><td colspan="6" class="empty">尚未运行联调用例</td></tr>';
  const commissionSection = data.commission
    ? `<h2>通电联调</h2>
  <section class="meta">
    <div><span>PLC 适配器</span><b>${escapeHtml(data.commission.plcKind ?? '—')}</b></div>
    <div><span>连接状态</span><b>${escapeHtml(data.commission.plcStatus)}</b></div>
    <div><span>上电流程</span><b>${data.commission.powerUp.pass ? '全部通过' : '未通过 / 未执行'}</b></div>
    <div><span>用例结果</span><b>${data.commission.cases.filter((testCase) => testCase.pass).length} / ${data.commission.cases.length || 3} 通过</b></div>
  </section>
  <h3 class="report-h3">上电顺序检查</h3>
  <table>
    <thead><tr><th>阶段</th><th>结果</th><th>期望</th><th>实际</th><th>耗时</th></tr></thead>
    <tbody>${commissionRows || '<tr><td colspan="5" class="empty">尚未执行上电流程</td></tr>'}</tbody>
  </table>
  <h3 class="report-h3">联调用例明细</h3>
  <table>
    <thead><tr><th>用例</th><th>阶段</th><th>结果</th><th>期望</th><th>实际</th><th>耗时</th></tr></thead>
    <tbody>${commissionCaseRows}</tbody>
  </table>`
    : '';

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
  .cycle-meta { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2mm; margin: 3mm 0 2mm; }
  .cycle-meta div { border: .25mm solid #c9d1d7; padding: 2mm 2.5mm; background: #f7fafb; }
  .cycle-meta span { display: block; color: #71808a; font-size: 7.5pt; }
  .cycle-meta b { font-size: 9pt; }
  .cycle-explanation,.cycle-bottleneck { margin: 1.5mm 0; font-size: 8.5pt; }
  .cycle-explanation { color: #52616b; }
  .cycle-bottleneck { color: #14534c; }
  .cycle-table { margin: 2mm 0 4mm; }
  .cycle-bottleneck-row td { background: #fff4d6 !important; }
  .engineering-notes-lead { margin: 2mm 0; padding: 2mm 3mm; border-left: 1mm solid #c58a19; background: #fff8e8; }
  .engineering-notes-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .engineering-notes-grid section { border: .25mm solid #c9d1d7; padding: 2mm 3mm; break-inside: avoid; }
  .engineering-notes-grid h3 { margin: 0 0 1mm; font-size: 9pt; }
  .engineering-notes-grid ul { margin: 0; padding-left: 5mm; font-size: 8pt; }
  .engineering-warnings { background: #fff8f7; border-color: #e6b4ad !important; }
  .geometry-review-state { margin: 4mm 0; padding: 3mm 4mm; border: .4mm solid #c58a19; background: #fff8e8; break-inside: avoid; }
  .geometry-review-state b { display: block; font-size: 11pt; }
  .geometry-review-state p { margin: 1.5mm 0 0; }
  .geometry-review-state.unverified { border-color: #bd665d; background: #fff3f1; color: #78251e; }
  .geometry-review-state.screened { border-color: #c58a19; background: #fff8e8; color: #66470f; }
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
  .report-h3 { margin: 5mm 0 2mm; color: #33414b; font-size: 10pt; }
  .empty { color: #71808a; text-align: center; padding: 5mm; }
  .note { margin-top: 5mm; padding: 3mm; border: .25mm solid #d6dde1; background: #f7fafb; color: #52616b; font-size: 8.5pt; }
  .foot { display: flex; justify-content: space-between; margin-top: 5mm; padding-top: 2mm; border-top: .25mm solid #aebbc3; color: #77858f; font-size: 7.5pt; }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(project.name)} · 设计与联调报告</h1>
  <div class="sub">A3 横向 · 包围盒级干涉初筛 · 公式化受力校核 · 通电联调 · AutomationCAD</div>
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
  ${engineeringNotesSection}
  ${geometryReviewSection}
  ${stationCycleSection}
  <h2>干涉检查（包围盒级）</h2>
  <table>
    <thead><tr><th>序号</th><th>级别</th><th>零件对</th><th>三轴重叠</th><th>近似重叠体积</th></tr></thead>
    <tbody>${hitRows}</tbody>
  </table>
  <h2>受力结论</h2>
  <div class="stress-grid">${stressCards}</div>
  ${commissionSection}
  <div class="note">${escapeHtml(data.note ?? '说明：干涉结果为轴对齐包围盒初筛，相切（重叠为 0）不计入；精检需在 CAD 内核中按三角面/B-rep 复算。受力计算按线弹性、小变形与给定许用条件估算。')}</div>
  <div class="foot"><span>AutomationCAD · 非标自动化整机设计</span><span>报告自动生成 · 请与设计文件一并归档</span></div>
</div>
</body>
</html>`;
}
