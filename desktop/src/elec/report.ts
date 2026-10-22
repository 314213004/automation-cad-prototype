/**
 * 电气校验报告（HTML，可直接 printToPDF）。
 *
 * 与 `runElectricalCheck` 共用同一份结果对象，保证面板上看到的与报告里写的完全一致。
 * 纯函数：便于单测，也不依赖 DOM。
 */
import type { ElecCheckResult, Finding, Severity } from './check.ts';

export interface ElecReportProject {
  name: string;
  code?: string;
  author?: string;
  date?: string;
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: '严重',
  warning: '警告',
  info: '提示'
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

function num(value: number | null | undefined, digits = 1, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

function findingRows(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return '<tr><td colspan="5" class="empty">未发现问题，线号、功率与导线截面校验全部通过</td></tr>';
  }
  return findings.map((item, index) => `<tr>
      <td class="num">${index + 1}</td>
      <td><span class="sev ${item.severity}">${SEVERITY_LABELS[item.severity] ?? item.severity}</span></td>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.message)}<div class="loc">位置：${escapeHtml(item.location)}</div></td>
      <td>${escapeHtml(item.suggestion ?? '—')}</td>
    </tr>`).join('');
}

/** 渲染电气校验报告 HTML（A3 横向，深浅两版共用同一结构）。 */
export function renderElecCheckHtml(project: ElecReportProject, result: ElecCheckResult): string {
  const { summary, counts } = result;
  const breaker = summary.breakerSuggestion;
  const margin = summary.psuMarginRatio;
  const verdict = counts.error > 0
    ? `不通过：${counts.error} 项严重问题必须处理`
    : counts.warning > 0
      ? `有条件通过：${counts.warning} 项警告建议处理`
      : '通过：未发现严重问题';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.name)} · 电气校验报告</title>
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
  .loc { margin-top: .8mm; color: #6d7a83; font-size: 7.5pt; }
  .sev { display: inline-block; padding: .5mm 1.6mm; border-radius: 1mm; font-size: 7.5pt; }
  .sev.error { color: #8c1d18; background: #fde7e5; border: .2mm solid #e5a29c; }
  .sev.warning { color: #7a5412; background: #fff4d6; border: .2mm solid #e6c77a; }
  .sev.info { color: #25547a; background: #e8f2fb; }
  .verdict { margin: 3mm 0 0; padding: 2.5mm 3mm; border-left: 1.2mm solid #1d5c54; background: #f4f9f8; font-size: 10pt; }
  .verdict.bad { border-left-color: #c33f35; background: #fff6f5; color: #8c1d18; }
  .empty { color: #71808a; text-align: center; padding: 5mm; }
  .note { margin-top: 5mm; padding: 3mm; border: .25mm solid #d6dde1; background: #f7fafb; color: #52616b; font-size: 8.5pt; }
  .foot { display: flex; justify-content: space-between; margin-top: 5mm; padding-top: 2mm; border-top: .25mm solid #aebbc3; color: #77858f; font-size: 7.5pt; }
</style>
</head>
<body>
<div class="sheet">
  <h1>${escapeHtml(project.name)} · 电气校验报告</h1>
  <div class="sub">线号合规 · 功率统计 · 导线截面与断路器配合 · AutomationCAD</div>
  <section class="meta">
    <div><span>项目编号</span><b>${escapeHtml(project.code ?? '—')}</b></div>
    <div><span>设计</span><b>${escapeHtml(project.author ?? '—')}</b></div>
    <div><span>日期</span><b>${escapeHtml(project.date ?? new Date().toLocaleDateString('zh-CN'))}</b></div>
    <div><span>问题统计</span><b>严重 ${counts.error} · 警告 ${counts.warning} · 提示 ${counts.info}</b></div>
  </section>
  <div class="verdict${counts.error > 0 ? ' bad' : ''}">${escapeHtml(verdict)}</div>

  <h2>功率统计</h2>
  <table>
    <thead><tr>
      <th>安装容量</th><th>视在功率</th><th>需要系数</th><th>L1 电流</th><th>L2 电流</th><th>L3 电流</th>
      <th>最大相电流</th><th>三相不平衡度</th><th>24V 电流</th><th>24V 余量</th><th>主断路器</th><th>主进线</th>
    </tr></thead>
    <tbody><tr>
      <td class="num">${num(summary.totalKw, 2, ' kW')}</td>
      <td class="num">${num(summary.totalKva, 2, ' kVA')}</td>
      <td class="num">${num(summary.demandFactor, 2)}</td>
      <td class="num">${num(summary.phaseCurrentA.L1, 1, ' A')}</td>
      <td class="num">${num(summary.phaseCurrentA.L2, 1, ' A')}</td>
      <td class="num">${num(summary.phaseCurrentA.L3, 1, ' A')}</td>
      <td class="num">${num(summary.maxPhaseCurrentA, 1, ' A')}</td>
      <td class="num">${num(summary.unbalanceRatio * 100, 1, ' %')}</td>
      <td class="num">${num(summary.dcCurrentA, 1, ' A')}</td>
      <td class="num">${margin === null ? '—' : num(margin * 100, 1, ' %')}</td>
      <td class="mono">${breaker ? `${breaker.ratedA} A` : '—'}</td>
      <td class="mono">${breaker ? `≥${breaker.cableMm2} mm²` : '—'}</td>
    </tr></tbody>
  </table>

  <h2>校验问题明细</h2>
  <table>
    <thead><tr><th style="width:12mm">序号</th><th style="width:18mm">级别</th><th style="width:56mm">规则</th><th>问题描述</th><th style="width:90mm">处理建议</th></tr></thead>
    <tbody>${findingRows(result.findings)}</tbody>
  </table>

  <div class="note">说明：载流量按铜芯导线 30℃、穿管敷设取值；主断路器按最大相电流 1.25 倍就近选标准壳架；24V 电源按负载电流 1.2 倍预留。结果用于设计初筛，定型前须按铭牌参数与现场敷设条件复核。</div>
  <div class="foot"><span>AutomationCAD · 非标自动化整机设计</span><span>报告自动生成 · 请与设计文件一并归档</span></div>
</div>
</body>
</html>`;
}
