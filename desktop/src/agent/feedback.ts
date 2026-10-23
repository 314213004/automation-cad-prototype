/**
 * 执行反馈的纯函数层（P7-F）
 *
 * 会话、计划执行器与侧栏 UI 共用同一套口径：
 * - 参数摘要在展示前脱敏并截断；
 * - 耗时统一格式化（ms / s / m）；
 * - 取消文案区分「未写入」与「已完成写步骤」，不把未知状态说成安全。
 */

import { maskSecrets, redactValue } from './audit.ts';

export interface CompletedStep {
  /** 1 基步骤号。 */
  step: number;
  tool: string;
  /** 实际调用参数；多轮状态用它恢复目标与未确认操作。 */
  args?: Record<string, unknown>;
  ok: boolean;
  code?: string;
  /** 是否是会修改装配体/文件的工具。 */
  wrote: boolean;
}

export type AgentProgressPhase = 'start' | 'end';

export interface AgentProgressEvent {
  runId: string;
  phase: AgentProgressPhase;
  /** 1 基序号。 */
  index: number;
  total: number;
  tool: string;
  argsSummary: string;
  startedAt: number;
  /** 工具调用 ID；计划步骤使用 plan:<index>。 */
  callId?: string;
  elapsedMs?: number;
  ok?: boolean;
  code?: string;
  message?: string;
  source?: 'chat' | 'plan' | 'recipe';
  /** 结果复用了同轮去重或会话缓存，UI 显示「已复用」。 */
  cacheHit?: boolean;
}

export const LONG_STEP_MS = 10_000;

/** 参数摘要：按字段名脱敏、去换行、截断，空参数显示「无参数」。 */
export function summarizeArguments(args: unknown, limit = 160): string {
  if (args === undefined || args === null) return '无参数';
  if (typeof args === 'object' && !Array.isArray(args) && Object.keys(args as Record<string, unknown>).length === 0) {
    return '无参数';
  }
  let redacted: unknown;
  try {
    redacted = redactValue(args);
  } catch {
    return '[参数无法序列化]';
  }
  let text: string;
  try {
    text = JSON.stringify(redacted);
  } catch {
    return '[参数无法序列化]';
  }
  if (text === undefined || text === '{}') return '无参数';
  text = maskSecrets(text).replace(/\s+/g, ' ');
  const cap = Math.max(1, Math.trunc(limit));
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** 耗时显示；无效值明确显示「—」，不猜 0。 */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (seconds >= 60) return `${minutes + 1}m 00s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** 「正在执行 `tool` · 第 n/N 步」。 */
export function stepLabel(index: number, total: number, tool: string): string {
  const name = tool || 'tool';
  if (Number.isFinite(index) && Number.isFinite(total) && total > 0 && index > 0) {
    const safeTotal = Math.max(1, Math.trunc(total));
    const safeIndex = Math.min(safeTotal, Math.max(1, Math.trunc(index)));
    return `正在执行 \`${name}\` · 第 ${safeIndex}/${safeTotal} 步`;
  }
  return `正在执行 \`${name}\``;
}

/** 执行中的秒表文案；超过 10 秒追加可取消提示。 */
export function runningDurationText(startedAt: number, now = Date.now()): string {
  const elapsed = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const base = `已用时 ${formatDuration(elapsed)}`;
  return elapsed >= LONG_STEP_MS ? `${base} · 仍在执行，可取消` : base;
}

/** 每完成 3 步给一次汇总；不足 3 步或耗时无效时返回空串。 */
export function aggregateDurationText(durations: number[], windowSize = 3): string {
  const size = Math.max(1, Math.trunc(windowSize));
  if (durations.length < size) return '';
  const recent = durations.slice(-size);
  if (recent.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return '';
  const sum = recent.reduce((total, value) => total + value, 0);
  return `连续 ${size} 步汇总耗时 ${formatDuration(sum)}`;
}

/** 完成/失败结果卡片的单行摘要。 */
export function stepResultText(input: {
  tool: string;
  ok: boolean;
  elapsedMs?: number;
  code?: string;
}): string {
  const code = input.code || (input.ok ? 'OK' : 'FAILED');
  return `${input.ok ? '✓' : '×'} ${input.tool} · ${input.ok ? '成功' : '失败'} · 耗时 ${formatDuration(input.elapsedMs)} · 结果码 ${code}`;
}

function completedText(completed: CompletedStep[]): string {
  if (completed.length === 0) return '';
  return completed
    .map((item) => `第 ${item.step} 步 ${item.tool}（${item.ok ? '成功' : `失败 ${item.code ?? ''}`.trim()}）`)
    .join('、');
}

/**
 * 取消文案。只有确认没有写步骤时才说「未写入任何更改」；
 * 当前写工具被中断但结果未知时，必须提示先核对。
 */
export function cancellationText(input: {
  completed: CompletedStep[];
  currentTool?: string;
  currentToolMayWrite?: boolean;
}): string {
  const completed = Array.isArray(input.completed) ? input.completed : [];
  const writes = completed.filter((item) => item.wrote);
  if (writes.length > 0) {
    const list = completedText(completed);
    return `已取消；已完成的步骤：${list}。其中写操作已写入，可用 undo_last 回退可撤销的装配修改。`;
  }
  if (input.currentToolMayWrite) {
    const list = completedText(completed);
    const tail = list ? `；已完成的步骤：${list}` : '';
    return `已取消；当前写操作 ${input.currentTool ?? 'tool'} 已中断，是否写入未能确认，请先核对当前装配体/文件${tail}`;
  }
  const readOnly = completed.length > 0 ? `（已完成 ${completed.length} 步只读查询）` : '';
  return `已取消，未写入任何更改${readOnly}`;
}

/** 判断失败结果是否属于写工具（用于取消文案与审计）。 */
export function isWriteTool(tool: string, mutatingTools: ReadonlySet<string>): boolean {
  return mutatingTools.has(tool);
}
