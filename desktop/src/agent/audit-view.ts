/**
 * 审计面板的纯函数视图层（P7-F）
 *
 * 列表筛选、时间倒序、200 条上限、CSV 导出、单条完整 JSON 与凭据掩码都在这里，
 * UI 只负责 DOM；因此筛选/导出规则可直接单测。
 */

import { maskSecrets, redactValue, type AgentAuditEntry } from './audit.ts';
import { formatDuration, summarizeArguments } from './feedback.ts';
import { exportTimestamp, sanitizeFileName } from '../shared/filename.ts';

export const AUDIT_DISPLAY_LIMIT = 200;

export type AuditResultFilter = 'all' | 'ok' | 'fail';

export interface AuditFilter {
  tool?: string;
  result?: AuditResultFilter;
}

function timeValue(at: string): number {
  const value = new Date(at).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** 时间倒序；同一时间保持原顺序（稳定）。 */
export function sortAuditEntries(entries: AgentAuditEntry[]): AgentAuditEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => timeValue(right.entry.at) - timeValue(left.entry.at) || left.index - right.index)
    .map((item) => item.entry);
}

export function filterAuditEntries(entries: AgentAuditEntry[], filter: AuditFilter = {}): AgentAuditEntry[] {
  const tool = typeof filter.tool === 'string' ? filter.tool.trim() : '';
  const result = filter.result ?? 'all';
  return sortAuditEntries(entries.filter((entry) => {
    if (tool && entry.tool !== tool) return false;
    if (result === 'ok' && !entry.ok) return false;
    if (result === 'fail' && entry.ok) return false;
    return true;
  }));
}

/** 工具筛选下拉的候选，按首次出现顺序去重。 */
export function auditToolNames(entries: AgentAuditEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of sortAuditEntries(entries)) {
    if (typeof entry.tool === 'string' && entry.tool && !seen.has(entry.tool)) seen.add(entry.tool);
  }
  return [...seen];
}

/** 取最近 max 条（时间倒序），并如实回报丢弃数量。 */
export function limitAuditEntries(
  entries: AgentAuditEntry[],
  max = AUDIT_DISPLAY_LIMIT
): { entries: AgentAuditEntry[]; total: number; dropped: number } {
  const sorted = sortAuditEntries(entries);
  const limit = Math.max(0, Math.trunc(max));
  return {
    entries: sorted.slice(0, limit),
    total: sorted.length,
    dropped: Math.max(0, sorted.length - limit)
  };
}

/** 单条完整 JSON：整条递归脱敏（含 message 里的裸密钥），缩进展示。 */
export function auditEntryJson(entry: AgentAuditEntry): string {
  try {
    const safe = redactValue(entry) as Record<string, unknown>;
    return JSON.stringify(safe, null, 2);
  } catch {
    return '{"error":"审计记录无法序列化"}';
  }
}

export function auditArgsText(entry: AgentAuditEntry): string {
  return summarizeArguments(entry.args ?? {}, 120);
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** 当前筛选结果的 CSV；列固定，参数摘要与完整消息都已脱敏。 */
export function auditCsv(entries: AgentAuditEntry[]): string {
  const header = ['时间', '工具', '参数摘要', '结果码', '结果', '耗时', '来源', '消息'];
  const rows = sortAuditEntries(entries).map((entry) => [
    entry.at,
    entry.tool,
    auditArgsText(entry),
    entry.code ?? (entry.ok ? 'OK' : 'FAILED'),
    entry.ok ? '成功' : '失败',
    formatDuration(entry.elapsedMs),
    entry.source ?? '',
    maskSecrets(entry.message ?? '')
  ]);
  return `\ufeff${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** 导出文件名复用统一净化；调用方仍由主进程校验扩展名。 */
export function auditExportFileName(now: Date | string | number = new Date()): string {
  return sanitizeFileName(`agent-audit-${exportTimestamp(now)}.csv`, 80) || 'agent-audit.csv';
}
