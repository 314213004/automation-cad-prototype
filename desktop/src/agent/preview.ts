/**
 * 只读问答的视图模型（P7-A-2）
 *
 * 三件事，全部纯函数、无 DOM / Electron 依赖，可直接单测：
 * - `buildPlanPreview`：把中文指令翻译成「将要调用的工具」给用户看一眼，不执行；
 * - `buildReceipt` / `summarizeTurn`：在线模型与离线规则共用一张回执，口径一致；
 * - `describeAuditEntry` / `auditSummaryText`：审计面板的行文案。
 *
 * 约束：预览只做展示，任何情况下都不得触发工具执行；写操作在预览里必须显式
 * 标成「写操作 · 需联网确认」，避免用户以为离线也能插零件。
 */

import type { AgentAuditEntry, AuditSummary } from './audit.ts';
import {
  INTENT_LABELS,
  READ_ONLY_TOOLS,
  describePlan,
  planTool,
  routeIntent,
  type IntentKind
} from './router.ts';

export type PreviewTone = 'read' | 'write' | 'none';

export interface PlanPreview {
  tone: PreviewTone;
  /** 一行标题，例如「只读 · list_components」 */
  title: string;
  /** 具体计划，例如「按类别「接触器」列出元件库条目（list_components {"category":"接触器"}）」 */
  detail: string;
  /** 给用户的操作提示（离线能不能用、写操作会不会弹确认） */
  hint: string;
  intent: IntentKind;
  intentLabel: string;
  tool: string | null;
  args: Record<string, unknown>;
  readOnly: boolean;
  /** 是否允许离线通道直接执行（只有只读工具为 true） */
  offlineAllowed: boolean;
  /** 写操作缺的必要参数，预览里直接点出来，省一次失败往返 */
  missing: string[];
}

const EMPTY_PREVIEW: PlanPreview = {
  tone: 'none',
  title: '等待输入',
  detail: '尚未输入指令',
  hint: '预览不会执行任何命令；输入后会显示将要调用的工具。',
  intent: 'out_of_scope',
  intentLabel: INTENT_LABELS.out_of_scope,
  tool: null,
  args: {},
  readOnly: false,
  offlineAllowed: false,
  missing: []
};

/** 规则预览：只读计划标「只读 · 可离线」，写计划标「写操作 · 需联网确认」。 */
export function buildPlanPreview(text: string): PlanPreview {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ...EMPTY_PREVIEW };

  const match = routeIntent(trimmed);
  const plan = planTool(trimmed);
  const intentLabel = INTENT_LABELS[match.intent];

  if (!plan) {
    return {
      ...EMPTY_PREVIEW,
      intent: match.intent,
      intentLabel,
      title: `无法套用工具 · ${intentLabel}`,
      detail: '规则里没有匹配到可执行工具，模型可用时会交给模型判断。',
      hint: '可直接问：元件清单、BOM、成本、电气校验、干涉检查。写操作（插入/导入/撤销/导出）需联网确认。'
    };
  }

  // planTool 已经保证 readOnly 与白名单一致，这里再核对一次，防止将来加工具时漏标。
  const readOnly = plan.readOnly && READ_ONLY_TOOLS.has(plan.tool);
  const tone: PreviewTone = readOnly ? 'read' : 'write';
  const title = `${readOnly ? '只读' : '写操作'} · ${plan.tool}`;
  const detail = describePlan(plan);

  let hint: string;
  if (readOnly) {
    hint = '断网时仍可执行：离线通道只跑只读工具，不会改文档。';
  } else if (plan.missing.length > 0) {
    hint = `写操作需要联网并在弹窗中确认；还缺参数：${plan.missing.join('、')}。`;
  } else {
    hint = '写操作需要联网并在弹窗中确认，离线通道不执行。';
  }

  return {
    tone,
    title,
    detail,
    hint,
    intent: match.intent,
    intentLabel,
    tool: plan.tool,
    args: { ...plan.args },
    readOnly,
    offlineAllowed: readOnly,
    missing: [...plan.missing]
  };
}

export type ReplyMode = 'online' | 'offline';

export interface TurnSummary {
  toolCalls: number;
  failures: number;
}

/** 统计一轮回复里的工具调用与失败数（只认 tool 角色消息的 JSON 结果）。 */
export function summarizeTurn(
  messages: Array<{ role: string; content?: string | null }>
): TurnSummary {
  let toolCalls = 0;
  let failures = 0;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    toolCalls += 1;
    try {
      const parsed = JSON.parse(message.content ?? '') as unknown;
      if (typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === false) {
        failures += 1;
      }
    } catch {
      // 非 JSON 结果不计失败，避免把文本回执误判成错误。
    }
  }
  return { toolCalls, failures };
}

export interface Receipt {
  mode: ReplyMode;
  modeLabel: string;
  /** 成功/降级用不同底色：离线是告警色，不是错误 */
  tone: 'is-ok' | 'is-warn';
  text: string;
  note: string;
}

function elapsedText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 在线/离线统一回执：同一套字段，只有通道与提示不同。 */
export function buildReceipt(input: {
  mode: ReplyMode;
  elapsedMs: number;
  toolCalls?: number;
  failures?: number;
}): Receipt {
  const mode: ReplyMode = input.mode === 'offline' ? 'offline' : 'online';
  const toolCalls = Number.isFinite(input.toolCalls) ? Math.max(0, Math.trunc(input.toolCalls ?? 0)) : 0;
  const failures = Number.isFinite(input.failures) ? Math.max(0, Math.trunc(input.failures ?? 0)) : 0;
  const parts = [
    mode === 'offline' ? '离线规则' : '在线模型',
    `耗时 ${elapsedText(input.elapsedMs)}`,
    `工具 ${toolCalls} 次`
  ];
  if (failures > 0) parts.push(`失败 ${failures} 次`);
  return {
    mode,
    modeLabel: mode === 'offline' ? '离线规则' : '在线模型',
    tone: mode === 'offline' ? 'is-warn' : 'is-ok',
    text: parts.join(' · '),
    note: mode === 'offline'
      ? '模型不可用，已降级为离线规则：只执行只读工具，写操作需要联网确认。'
      : '模型可用；写操作会先弹出确认再执行。'
  };
}

const SOURCE_LABELS: Record<string, string> = {
  llm: '在线模型',
  offline: '离线规则',
  rpc: '本机 RPC',
  mcp: 'MCP'
};

export interface AuditRow {
  tone: 'is-ok' | 'is-error';
  title: string;
  meta: string;
}

function timeText(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 审计面板一行：工具 · 结果，第二行放来源/时间/错误码。 */
export function describeAuditEntry(entry: AgentAuditEntry): AuditRow {
  const source = entry.source ? (SOURCE_LABELS[entry.source] ?? entry.source) : '未知来源';
  const meta = [timeText(entry.at), source, entry.code ? `错误码 ${entry.code}` : '']
    .filter(Boolean)
    .join(' · ');
  return {
    tone: entry.ok ? 'is-ok' : 'is-error',
    title: `${entry.tool} · ${entry.ok ? '成功' : '失败'}`,
    meta
  };
}

/** 审计汇总一行；空审计要有明确文案，不能显示空白。 */
export function auditSummaryText(summary: AuditSummary | null | undefined): string {
  if (!summary || summary.total === 0) return '暂无审计记录';
  const failures = summary.failed > 0 ? ` · 失败 ${summary.failed}` : '';
  const last = summary.lastAt ? ` · 最近 ${timeText(summary.lastAt)}` : '';
  return `共 ${summary.total} 条${failures}${last}`;
}
