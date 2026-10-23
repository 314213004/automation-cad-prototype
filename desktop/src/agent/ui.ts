import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml
} from '../ui/panels';
import {
  auditSummaryText,
  buildPlanPreview,
  buildReceipt,
  summarizeTurn,
  type Receipt
} from './preview.ts';
import { suggestFailure } from './suggest.ts';
import {
  aggregateDurationText,
  formatDuration,
  runningDurationText,
  stepLabel,
  stepResultText,
  summarizeArguments,
  type AgentProgressEvent
} from './feedback.ts';
import {
  auditArgsText,
  auditCsv,
  auditEntryJson,
  auditExportFileName,
  auditToolNames,
  filterAuditEntries,
  limitAuditEntries,
  type AuditResultFilter
} from './audit-view.ts';
import {
  describePlanStep,
  plan as buildAgentPlan,
  type AgentPlan,
  type PlanStepResult
} from './planner.ts';
import { collectAgentContext, type AgentContext } from './context.ts';

const AGENT_ICON = '<svg viewBox="0 0 16 16"><path d="M8 2.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z"/><path d="M3 13.8c.4-2.5 2.4-4 5-4s4.6 1.5 5 4"/><path d="M2 3.2h1.2M12.8 3.2H14M2 12.8h1.2M12.8 12.8H14"/></svg>';

interface AgentToolInfo {
  name: string;
  description: string;
}

interface AgentHistoryInfo {
  name: string;
  at: string;
  ok: boolean;
}

interface AgentInfo {
  host?: string;
  port?: number;
  url?: string;
  tokenFile?: string;
  toolCount?: number;
  tools?: AgentToolInfo[];
  history?: AgentHistoryInfo[];
  error?: string;
}

let drawer: ReturnType<typeof createDrawer> | null = null;
let refreshButton: HTMLButtonElement | null = null;
let body: HTMLElement | null = null;
let infoState: AgentInfo = {};
let llmState: DesktopAgentLlmConfig | null = null;
let messages: DesktopAgentChatMessage[] = [];
let thinking = false;
let apiKeyDirty = false;
let lastReceipt: Receipt | null = null;
let auditState: DesktopAgentAuditResult | null = null;
let auditLoading = false;
let auditFilterTool = '';
let auditFilterResult: AuditResultFilter = 'all';
let progressSteps: LiveProgress[] = [];
let progressTimer = 0;
let progressMetrics = new Map<string, { elapsedMs: number; ok: boolean; code: string }>();
let cancelRequested = false;
let disposeProgress: (() => void) | null = null;
let activeRunId = '';

interface LiveProgress {
  key: string;
  runId: string;
  index: number;
  total: number;
  tool: string;
  argsSummary: string;
  startedAt: number;
  elapsedMs?: number;
  ok?: boolean;
  code?: string;
  message?: string;
}

interface MultiPlanState {
  input: string;
  plan: AgentPlan;
  results: PlanStepResult[];
  next: number;
  running: boolean;
  feedback: string;
  tone: 'ok' | 'error' | '';
  dismissed: boolean;
}

let multiPlan: MultiPlanState | null = null;

function serviceAddress(info: AgentInfo): string {
  if (info.host && info.port) return `${info.host}:${info.port}`;
  if (info.url) return info.url.replace(/^https?:\/\//, '');
  return '—';
}

function timeText(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('zh-CN', { hour12: false });
}

function fieldElement(id: string): HTMLInputElement | HTMLTextAreaElement | null {
  return body?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`) ?? null;
}

function setStatus(id: string, text: string, isError = false): void {
  const element = body?.querySelector<HTMLElement>(`#${id}`);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('is-error', isError);
  element.classList.toggle('is-ok', !isError && Boolean(text));
}

function renderShell(): void {
  if (!body) return;
  const tools = Array.isArray(infoState.tools) ? infoState.tools : [];
  const history = Array.isArray(infoState.history) ? infoState.history.slice(-5).reverse() : [];
  const toolCount = infoState.toolCount ?? tools.length;
  body.innerHTML = `
    <div class="acp-section-title">对话 <b id="agentChatCount">0</b></div>
    <div class="acp-chat-log" id="agentChatLog">
      <div class="acp-empty">输入任务后，智能体会按需调用工具。写操作会先弹出确认。</div>
    </div>
    <div class="acp-field">
      <span>消息</span>
      <textarea class="acp-textarea acp-chat-input" id="agentChatInput" rows="3" maxlength="20000" placeholder="例如：搜索 SMC 气缸并插入一个占位件"></textarea>
      <div class="acp-row">
        <button type="button" class="acp-btn acp-btn-primary" id="agentChatSend">发送</button>
        <button type="button" class="acp-btn acp-btn-danger" id="agentChatCancel" hidden>取消执行</button>
        <button type="button" class="acp-btn" id="agentChatClear">清空</button>
        <span class="acp-pill" id="agentChatStatus">就绪</span>
      </div>
      <div class="acp-note acp-chat-feedback" id="agentChatFeedback" hidden></div>
      <div class="acp-progress" id="agentProgress" hidden>
        <div class="acp-progress-head">
          <span>执行进度</span>
          <span class="acp-progress-clock" id="agentProgressClock"></span>
        </div>
        <div class="acp-progress-list" id="agentProgressList"></div>
      </div>
      <div class="acp-plan-preview is-none" id="agentPlanPreview">
        <div class="acp-plan-title" id="agentPlanTitle">等待输入</div>
        <div class="acp-plan-detail" id="agentPlanDetail">预览不会执行任何命令；输入后会显示将要调用的工具。</div>
        <div class="acp-plan-hint" id="agentPlanHint"></div>
      </div>
      <div class="acp-plan-card" id="agentPlanCard" hidden>
        <div class="acp-plan-card-head">
          <span class="acp-plan-card-title" id="agentPlanCardTitle">多步计划</span>
          <span class="acp-pill" id="agentPlanCardMeta"></span>
        </div>
        <div class="acp-plan-list" id="agentPlanList"></div>
        <div class="acp-plan-feedback" id="agentPlanFeedback" hidden></div>
        <div class="acp-plan-actions" id="agentPlanActions">
          <button type="button" class="acp-btn acp-btn-primary" id="agentPlanRunAll">全部执行</button>
          <button type="button" class="acp-btn" id="agentPlanRunStep">逐步执行</button>
          <button type="button" class="acp-btn" id="agentPlanCancel">取消</button>
        </div>
      </div>
    </div>

    <div class="acp-section-title">模型设置 <b>OpenAI 兼容</b></div>
    <div class="acp-field">
      <span>baseUrl</span>
      <input class="acp-input" id="agentLlmBaseUrl" type="url" autocomplete="off" spellcheck="false">
    </div>
    <div class="acp-field">
      <span>model</span>
      <input class="acp-input" id="agentLlmModel" type="text" autocomplete="off" spellcheck="false">
    </div>
    <div class="acp-field">
      <span>apiKey</span>
      <input class="acp-input" id="agentLlmApiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入新密钥；留空保留原值">
    </div>
    <div class="acp-field">
      <span>最大轮数</span>
      <input class="acp-input" id="agentLlmMaxIterations" type="number" min="1" max="50" step="1">
    </div>
    <div class="acp-row">
      <button type="button" class="acp-btn acp-btn-primary" id="agentLlmSave">保存</button>
      <button type="button" class="acp-btn" id="agentLlmTest">测试连接</button>
      <span class="acp-pill" id="agentLlmStatus"></span>
    </div>

    <div class="acp-section-title">本机服务 <b>${toolCount} 个工具</b></div>
    <div class="acp-field">
      <span>token 文件路径（不显示 token）</span>
      <div class="acp-note">${escapeHtml(infoState.tokenFile || '—')}</div>
    </div>
    <div class="acp-note">服务：${escapeHtml(serviceAddress(infoState))} · HTTP JSON-RPC · 仅监听本机</div>

    <div class="acp-section-title">工具列表 <b>${toolCount}</b></div>
    ${tools.length === 0 ? '<div class="acp-empty">尚无工具注册</div>' : tools.map((tool) => `
      <div class="acp-pack-row">
        <div class="acp-pack-main">
          <div>
            <div class="acp-pack-name">${escapeHtml(tool.name)}</div>
            <div class="acp-pack-meta">${escapeHtml(tool.description)}</div>
          </div>
          <span class="acp-pill is-ok">可用</span>
        </div>
      </div>`).join('')}

    <div class="acp-section-title">最近命令 <b>${history.length}/5</b></div>
    ${history.length === 0 ? '<div class="acp-empty">尚无命令历史。工具调用后会在此显示名称、时间与结果。</div>' : history.map((entry) => `
      <div class="acp-pack-row">
        <div class="acp-pack-main">
          <div>
            <div class="acp-pack-name">${escapeHtml(entry.name)}</div>
            <div class="acp-pack-meta">${escapeHtml(timeText(entry.at))}</div>
          </div>
          <span class="acp-pill ${entry.ok ? 'is-ok' : 'is-error'}">${entry.ok ? '成功' : '失败'}</span>
        </div>
      </div>`).join('')}

    <div class="acp-section-title">审计 <b id="agentAuditCount">—</b></div>
    <div class="acp-audit-controls">
      <select class="acp-input acp-audit-select" id="agentAuditToolFilter" aria-label="按工具筛选">
        <option value="">全部工具</option>
      </select>
      <select class="acp-input acp-audit-select" id="agentAuditResultFilter" aria-label="按结果筛选">
        <option value="all">全部结果</option>
        <option value="ok">仅成功</option>
        <option value="fail">仅失败</option>
      </select>
      <button type="button" class="acp-btn" id="agentAuditExport">导出 CSV</button>
    </div>
    <div class="acp-audit-list" id="agentAuditList"><div class="acp-empty">正在读取审计…</div></div>
    <div class="acp-row">
      <button type="button" class="acp-btn" id="agentAuditRefresh">刷新审计</button>
      <span class="acp-note" id="agentAuditSummary"></span>
    </div>
    <div class="acp-note" id="agentAuditHint">审计只记录工具名、结果、耗时与脱敏后的参数；最多显示最近 200 条。</div>
  `;

  bindControls();
  fillConfig();
  renderMessages();
  renderPreview();
  renderAudit();
  updateBusyState();
}

function fillConfig(): void {
  if (!llmState) return;
  const baseUrl = fieldElement('agentLlmBaseUrl');
  const model = fieldElement('agentLlmModel');
  const apiKey = fieldElement('agentLlmApiKey');
  const maxIterations = fieldElement('agentLlmMaxIterations');
  if (baseUrl) baseUrl.value = llmState.baseUrl;
  if (model) model.value = llmState.model;
  if (apiKey) apiKey.value = llmState.apiKey;
  if (maxIterations) maxIterations.value = String(llmState.maxIterations);
  apiKeyDirty = false;
}

function toolResultMap(): Map<string, DesktopAgentChatMessage> {
  const map = new Map<string, DesktopAgentChatMessage>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) map.set(message.tool_call_id, message);
  }
  return map;
}

function summaryText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function argumentsSummary(raw: string): string {
  if (!raw.trim()) return '无参数';
  try {
    const parsed = JSON.parse(raw) as unknown;
    return summarizeArguments(parsed);
  } catch {
    return summarizeArguments(raw);
  }
}

interface ToolOutcome {
  ok: boolean;
  code: string;
  message: string;
  detail: string;
}

function parseToolOutcome(content: string | null | undefined): ToolOutcome {
  const raw = content ?? '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const ok = record.ok !== false;
      const error = typeof record.error === 'object' && record.error !== null
        ? record.error as Record<string, unknown>
        : null;
      const code = typeof record.code === 'string'
        ? record.code
        : error && typeof error.code === 'string'
          ? error.code
          : ok ? 'OK' : 'FAILED';
      const message = typeof record.message === 'string'
        ? record.message
        : error && typeof error.message === 'string'
          ? error.message
          : '';
      return { ok, code, message, detail: summaryText(raw, 260) };
    }
  } catch {
    // 非 JSON 结果按成功展示原文，不臆断错误码。
  }
  return { ok: true, code: 'OK', message: '', detail: summaryText(raw, 260) };
}

function failureSuggestionHtml(input: {
  tool: string;
  args: Record<string, unknown>;
  code: string;
  message?: string;
}): string {
  const suggestion = suggestFailure(input);
  return `<div class="acp-tool-advice">
        <div class="acp-tool-advice-title">建议：${escapeHtml(suggestion.advice)}</div>
        <ul>${suggestion.alternatives.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>`;
}

function renderToolCard(call: DesktopAgentToolCall, result: DesktopAgentChatMessage | undefined): string {
  let status = '待执行';
  let tone = 'is-warn';
  let detail = '';
  let meta = `参数：${argumentsSummary(call.function.arguments)}`;
  let advice = '';
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    args = {};
  }
  if (result) {
    const outcome = parseToolOutcome(result.content);
    const metrics = progressMetrics.get(call.id);
    status = outcome.ok ? '成功' : '失败';
    tone = outcome.ok ? 'is-ok' : 'is-error';
    detail = outcome.detail;
    meta = `参数：${argumentsSummary(call.function.arguments)} · 耗时 ${formatDuration(metrics?.elapsedMs)} · 结果码 ${outcome.code}`;
    if (!outcome.ok) {
      advice = failureSuggestionHtml({
        tool: call.function.name,
        args,
        code: outcome.code,
        ...(outcome.message ? { message: outcome.message } : {})
      });
    }
  }
  return `
    <div class="acp-chat-tool ${tone}" data-tool-call-id="${escapeHtml(call.id)}">
      <div class="acp-chat-tool-head">
        <span class="acp-pack-name">${result ? (tone === 'is-ok' ? '✓ ' : '× ') : ''}${escapeHtml(call.function.name)}</span>
        <span class="acp-pill ${tone}">${status}</span>
      </div>
      <div class="acp-pack-meta">${escapeHtml(meta)}</div>
      ${detail ? `<div class="acp-pack-meta">结果：${escapeHtml(detail)}</div>` : ''}
      ${advice}
    </div>`;
}

function progressKey(event: DesktopAgentProgressEvent): string {
  return `${event.runId}:${event.callId ?? event.index}`;
}

function stopProgressTicker(): void {
  if (!progressTimer) return;
  window.clearInterval(progressTimer);
  progressTimer = 0;
}

function startProgressTicker(): void {
  if (progressTimer) return;
  progressTimer = window.setInterval(() => {
    if (!progressSteps.some((step) => step.elapsedMs === undefined)) {
      stopProgressTicker();
      return;
    }
    renderProgress();
  }, 500);
}

function applyProgress(event: DesktopAgentProgressEvent): void {
  if (!event || typeof event.runId !== 'string' || typeof event.tool !== 'string') return;
  if (activeRunId && activeRunId !== event.runId) return;
  activeRunId = event.runId;
  const key = progressKey(event);
  const existing = progressSteps.find((step) => step.key === key);
  const next: LiveProgress = {
    key,
    runId: event.runId,
    index: event.index,
    total: event.total,
    tool: event.tool,
    argsSummary: event.argsSummary || '无参数',
    startedAt: event.startedAt,
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(event.ok !== undefined ? { ok: event.ok } : {}),
    ...(event.code ? { code: event.code } : {}),
    ...(event.message ? { message: event.message } : {})
  };
  if (existing) Object.assign(existing, next);
  else progressSteps.push(next);
  if (event.phase === 'end' && event.callId) {
    progressMetrics.set(event.callId, {
      elapsedMs: event.elapsedMs ?? 0,
      ok: event.ok === true,
      code: event.code ?? (event.ok ? 'OK' : 'FAILED')
    });
  }
  renderProgress();
  if (progressSteps.some((step) => step.elapsedMs === undefined)) startProgressTicker();
}

function renderProgress(): void {
  const box = body?.querySelector<HTMLElement>('#agentProgress');
  const list = body?.querySelector<HTMLElement>('#agentProgressList');
  const clock = body?.querySelector<HTMLElement>('#agentProgressClock');
  if (!box || !list) return;
  box.hidden = progressSteps.length === 0;
  if (progressSteps.length === 0) {
    list.innerHTML = '';
    if (clock) clock.textContent = '';
    return;
  }
  const running = progressSteps.find((step) => step.elapsedMs === undefined);
  if (clock) {
    clock.textContent = running ? runningDurationText(running.startedAt) : '';
    clock.classList.toggle('is-long', Boolean(running && Date.now() - running.startedAt >= 10_000));
  }
  const completed: number[] = [];
  const cards: string[] = [];
  for (const step of progressSteps) {
    if (step.elapsedMs === undefined) {
      cards.push(`<div class="acp-progress-step is-running" data-tool="${escapeHtml(step.tool)}">
        <div class="acp-progress-step-head">
          <span class="acp-progress-icon">…</span>
          <span class="acp-progress-title">${escapeHtml(stepLabel(step.index, step.total, step.tool))}</span>
          <span class="acp-progress-time">${escapeHtml(runningDurationText(step.startedAt))}</span>
        </div>
        <div class="acp-progress-args">参数：${escapeHtml(step.argsSummary)}</div>
      </div>`);
      continue;
    }
    const ok = step.ok === true;
    const cancelled = step.code === 'CANCELLED';
    completed.push(step.elapsedMs);
    cards.push(`<div class="acp-progress-step ${cancelled ? 'is-warn' : ok ? 'is-ok' : 'is-error'}" data-tool="${escapeHtml(step.tool)}" data-code="${escapeHtml(step.code ?? '')}">
      <div class="acp-progress-step-head">
        <span class="acp-progress-icon">${cancelled ? '!' : ok ? '✓' : '×'}</span>
        <span class="acp-progress-title">${escapeHtml(cancelled
          ? `${step.tool} · 已取消 · 耗时 ${formatDuration(step.elapsedMs)}`
          : stepResultText({ tool: step.tool, ok, elapsedMs: step.elapsedMs, ...(step.code ? { code: step.code } : {}) }))}</span>
      </div>
      <div class="acp-progress-args">参数：${escapeHtml(step.argsSummary)}</div>
      ${step.message ? `<div class="acp-progress-message">${escapeHtml(step.message)}</div>` : ''}
    </div>`);
    if (completed.length > 0 && completed.length % 3 === 0) {
      const aggregate = aggregateDurationText(completed);
      if (aggregate) cards.push(`<div class="acp-progress-aggregate">${escapeHtml(aggregate)}</div>`);
    }
  }
  list.innerHTML = cards.join('');
}

function resetProgress(): void {
  stopProgressTicker();
  progressSteps = [];
  progressMetrics = new Map();
  activeRunId = '';
  renderProgress();
}

async function cancelExecution(): Promise<void> {
  if (!window.desktop || cancelRequested) return;
  const planRunning = multiPlan?.running === true;
  if (!thinking && !planRunning) return;
  cancelRequested = true;
  chatFeedback('正在取消当前工具…');
  updateBusyState();
  try {
    if (planRunning) await window.desktop.agent.plan.cancel();
    else await window.desktop.agent.chat.cancel();
  } catch (error) {
    chatFeedback(`取消失败：${errorMessage(error)}`, true);
    cancelRequested = false;
    updateBusyState();
  }
}

function renderMessages(): void {
  const log = body?.querySelector<HTMLElement>('#agentChatLog');
  const count = body?.querySelector<HTMLElement>('#agentChatCount');
  if (!log) return;
  if (messages.length === 0) {
    log.innerHTML = '<div class="acp-empty">输入任务后，智能体会按需调用工具。写操作会先弹出确认。</div>';
    if (count) count.textContent = '0';
    return;
  }

  const results = toolResultMap();
  const rendered = new Set<string>();
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      blocks.push(`<div class="acp-chat-msg is-user"><div class="acp-chat-role">你</div><div class="acp-chat-bubble">${escapeHtml(message.content ?? '')}</div></div>`);
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        blocks.push(`<div class="acp-chat-msg is-assistant"><div class="acp-chat-role">助手</div><div class="acp-chat-bubble">${escapeHtml(message.content)}</div></div>`);
      }
      for (const call of message.tool_calls ?? []) {
        rendered.add(call.id);
        blocks.push(renderToolCard(call, results.get(call.id)));
      }
      continue;
    }
    if (message.role === 'tool' && message.tool_call_id && !rendered.has(message.tool_call_id)) {
      const id = message.tool_call_id;
      const name = message.name ?? 'tool';
      blocks.push(renderToolCard({ id, type: 'function', function: { name, arguments: '{}' } }, message));
    }
  }
  if (lastReceipt) {
    blocks.push(`<div class="acp-chat-receipt ${lastReceipt.tone}">
      <div class="acp-chat-receipt-head">${escapeHtml(lastReceipt.text)}</div>
      <div class="acp-pack-meta">${escapeHtml(lastReceipt.note)}</div>
    </div>`);
  }
  log.innerHTML = blocks.join('');
  log.scrollTop = log.scrollHeight;
  if (count) count.textContent = String(messages.length);
}

/** 计划预览：只读 / 写操作 / 无法识别 三种底色，绝不触发执行。 */
function renderPreview(): void {
  const box = body?.querySelector<HTMLElement>('#agentPlanPreview');
  if (!box) return;
  const text = fieldElement('agentChatInput')?.value ?? '';
  const context = currentAgentContext();
  const preview = buildPlanPreview(text, context);
  box.classList.remove('is-none', 'is-read', 'is-write');
  box.classList.add(`is-${preview.tone}`);
  const title = body?.querySelector<HTMLElement>('#agentPlanTitle');
  const detail = body?.querySelector<HTMLElement>('#agentPlanDetail');
  const hint = body?.querySelector<HTMLElement>('#agentPlanHint');
  if (title) title.textContent = preview.tone === 'none' ? preview.title : `${preview.title}（${preview.intentLabel}）`;
  if (detail) detail.textContent = preview.detail;
  if (hint) hint.textContent = preview.hint;
  box.dataset.tool = preview.tool ?? '';
  box.dataset.readOnly = preview.readOnly ? '1' : '0';
  box.dataset.offline = preview.offlineAllowed ? '1' : '0';
  box.dataset.resolvedFrom = preview.resolvedFrom ?? '';
  box.dataset.resolvedLabel = preview.resolvedLabel ?? '';
  refreshMultiPlan(text, context);
}

/** 只读采集现有 UI 状态；不新增全局单例，采集失败时返回空上下文。 */
function currentAgentContext(): AgentContext {
  let raw: unknown = null;
  try {
    raw = window.__AgentBridge?.getProjectContext?.() ?? null;
  } catch {
    raw = null;
  }
  return collectAgentContext({ projectContext: () => raw });
}

function isMultiStepText(text: string): boolean {
  return /(?:然后|接着|之后|最后|并且|同时|再|并)/.test(text);
}

/** 输入变化时重建计划；执行中保持同一份计划，避免逐步执行被输入事件重置。 */
function refreshMultiPlan(text: string, context: AgentContext): void {
  if (multiPlan && multiPlan.input !== text && !multiPlan.running) multiPlan = null;
  if (!text) {
    if (!multiPlan?.running) multiPlan = null;
    renderMultiPlan();
    return;
  }
  if (!multiPlan) {
    const toolNames = Array.isArray(infoState.tools) && infoState.tools.length > 0
      ? infoState.tools.map((tool) => tool.name)
      : undefined;
    multiPlan = {
      input: text,
      plan: buildAgentPlan(text, { ...(toolNames ? { tools: toolNames } : {}), context }),
      results: [],
      next: 0,
      running: false,
      feedback: '',
      tone: '',
      dismissed: false
    };
  }
  renderMultiPlan();
}

function stepTone(state: MultiPlanState, index: number): { tone: string; icon: string } {
  const result = state.results.find((item) => item.index === index);
  if (result) return result.ok ? { tone: 'is-done', icon: '✓' } : { tone: 'is-fail', icon: '×' };
  if (state.running && state.next === index) return { tone: 'is-running', icon: '…' };
  return { tone: 'is-pending', icon: String(index + 1) };
}

/** 多步计划卡片：只展示与触发执行，规划本身仍是纯函数。 */
function renderMultiPlan(): void {
  const card = body?.querySelector<HTMLElement>('#agentPlanCard');
  if (!card) return;
  const state = multiPlan;
  const show = Boolean(state && !state.dismissed && (
    state.plan.steps.length >= 2 || (state.plan.refused === true && (isMultiStepText(state.input) || (state.plan.warnings?.length ?? 0) > 0))
  ));
  if (!state || !show) {
    card.hidden = true;
    card.dataset.steps = '0';
    return;
  }
  card.hidden = false;
  card.dataset.steps = String(state.plan.steps.length);
  card.dataset.running = state.running ? '1' : '0';
  const writeCount = state.plan.steps.filter((step) => !step.readOnly).length;
  const title = body?.querySelector<HTMLElement>('#agentPlanCardTitle');
  const meta = body?.querySelector<HTMLElement>('#agentPlanCardMeta');
  const list = body?.querySelector<HTMLElement>('#agentPlanList');
  const feedback = body?.querySelector<HTMLElement>('#agentPlanFeedback');
  const runAll = body?.querySelector<HTMLButtonElement>('#agentPlanRunAll');
  const runStep = body?.querySelector<HTMLButtonElement>('#agentPlanRunStep');
  const cancel = body?.querySelector<HTMLButtonElement>('#agentPlanCancel');

  if (title) title.textContent = state.plan.refused ? '多步计划 · 未执行' : `多步计划 · ${state.plan.steps.length} 步`;
  if (meta) {
    meta.textContent = state.plan.refused
      ? '已拒绝'
      : `${state.plan.steps.length} 步 · ${writeCount} 步写 · 置信度 ${(state.plan.confidence * 100).toFixed(0)}%`;
    meta.classList.toggle('is-error', state.plan.refused === true);
  }

  if (list) {
    if (state.plan.refused) {
      const reasons = [
        state.plan.reason ?? '规则未命中',
        ...(state.plan.warnings ?? []),
        ...(state.plan.suggestions ?? []).slice(0, 3).map((item) => `建议：${item}`)
      ];
      list.innerHTML = reasons.map((item) => `<div class="acp-plan-refused">${escapeHtml(item)}</div>`).join('');
    } else {
      list.innerHTML = state.plan.steps.map((step, index) => {
        const status = stepTone(state, index);
        const args = summarizeArguments(step.args);
        const missing = step.missing && step.missing.length > 0
          ? `<span class="acp-plan-missing">缺 ${escapeHtml(step.missing.join('、'))}</span>`
          : '';
        return `<div class="acp-plan-step ${status.tone}" data-step-index="${index + 1}" data-tool="${escapeHtml(step.tool)}">
          <span class="acp-plan-step-icon">${status.icon}</span>
          <span class="acp-plan-step-main">
            <span class="acp-plan-step-head"><b>${index + 1}. ${escapeHtml(step.tool)}</b>${missing}<span class="acp-plan-io">${step.readOnly ? '只读' : '写'}</span></span>
            <span class="acp-plan-step-args">${escapeHtml(args)}</span>
            <span class="acp-plan-step-why">${escapeHtml(step.why)}</span>
            ${step.resolvedFrom ? `<span class="acp-plan-basis">已使用${step.resolvedFrom === 'selection' ? '选中对象' : step.resolvedFrom === 'recent' ? '最近操作对象' : '底板对象'}：${escapeHtml(step.resolvedLabel ?? '')}</span>` : ''}
          </span>
        </div>`;
      }).join('') + (state.plan.warnings ?? []).map((warning) =>
        `<div class="acp-plan-warning">${escapeHtml(warning)}</div>`
      ).join('');
    }
  }

  if (feedback) {
    feedback.hidden = !state.feedback;
    feedback.textContent = state.feedback;
    feedback.classList.toggle('is-error', state.tone === 'error');
    feedback.classList.toggle('is-ok', state.tone === 'ok');
  }

  const refused = state.plan.refused === true;
  const completed = !refused && state.next >= state.plan.steps.length;
  if (runAll) {
    runAll.disabled = state.running || refused || completed;
    runAll.hidden = refused;
  }
  if (runStep) {
    runStep.disabled = state.running || refused || completed;
    runStep.hidden = refused;
    runStep.textContent = state.next === 0 ? '逐步执行' : (completed ? '已完成' : `下一步（${state.next + 1}/${state.plan.steps.length}）`);
  }
  if (cancel) {
    cancel.disabled = false;
    cancel.textContent = refused ? '关闭' : (state.running ? '取消执行' : '取消');
  }
}

async function runMultiPlan(mode: 'all' | 'step'): Promise<void> {
  const state = multiPlan;
  if (!state || state.running || thinking || state.plan.refused || !window.desktop) return;
  if (state.next >= state.plan.steps.length) return;
  state.running = true;
  state.feedback = '';
  state.tone = '';
  cancelRequested = false;
  resetProgress();
  renderMultiPlan();
  updateBusyState();
  try {
    const result = await window.desktop.agent.plan.execute({
      plan: state.plan,
      startAt: state.next,
      ...(mode === 'step' ? { maxSteps: 1 } : {})
    });
    const merged = new Map(state.results.map((item) => [item.index, item]));
    for (const item of result.results ?? []) merged.set(item.index, item);
    state.results = [...merged.values()].sort((left, right) => left.index - right.index);

    if (result.refused) {
      state.feedback = result.summary || '计划已拒绝';
      state.tone = 'error';
    } else if (result.cancelled) {
      state.feedback = result.summary || '已取消，未写入任何更改';
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'error';
      chatFeedback(state.feedback, true);
    } else if (!result.ok) {
      const failed = result.results?.find((item) => !item.ok);
      state.next = typeof result.failedIndex === 'number' ? result.failedIndex : state.next;
      state.feedback = failed
        ? `第 ${failed.step} 步 ${failed.tool} 失败（${failed.code}）${failed.message ? `：${failed.message}` : ''}；后续步骤已停止`
        : (result.summary || '计划执行失败');
      if (failed) {
        const advice = suggestFailure({
          code: failed.code,
          ...(failed.message ? { message: failed.message } : {}),
          tool: failed.tool
        });
        state.feedback += `；建议：${advice.advice}`;
        if (advice.alternatives.length > 0) state.feedback += `；可选：${advice.alternatives.slice(0, 2).join(' / ')}`;
      }
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'error';
      chatFeedback(state.feedback, true);
    } else {
      const lastIndex = result.results?.reduce((max, item) => Math.max(max, item.index), -1) ?? -1;
      state.next = Math.max(state.next, lastIndex + 1);
      state.feedback = result.summary || `已完成 ${state.next}/${state.plan.steps.length} 步`;
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'ok';
      if (state.next >= state.plan.steps.length) chatFeedback('');
    }
  } catch (error) {
    state.feedback = `计划执行失败：${errorMessage(error)}`;
    state.tone = 'error';
    chatFeedback(state.feedback, true);
  } finally {
    state.running = false;
    cancelRequested = false;
    renderMultiPlan();
    updateBusyState();
    void loadAudit();
  }
}

async function cancelMultiPlan(): Promise<void> {
  if (!multiPlan) return;
  if (multiPlan.running) {
    if (!cancelRequested) {
      cancelRequested = true;
      multiPlan.feedback = '正在取消当前工具…';
      multiPlan.tone = 'error';
      renderMultiPlan();
      updateBusyState();
      try {
        await window.desktop?.agent.plan.cancel();
      } catch (error) {
        chatFeedback(`取消失败：${errorMessage(error)}`, true);
        cancelRequested = false;
        updateBusyState();
      }
    }
    return;
  }
  multiPlan.dismissed = true;
  multiPlan.feedback = '';
  multiPlan.tone = '';
  renderMultiPlan();
}

/** 审计面板：筛选 + 时间倒序 + 最近 200 条 + 单条 JSON + CSV 导出。 */
function auditEntriesForView(): DesktopAgentAuditEntry[] {
  const all = Array.isArray(auditState?.entries) ? auditState.entries : [];
  return filterAuditEntries(all, { result: auditFilterResult, ...(auditFilterTool ? { tool: auditFilterTool } : {}) });
}

function setAuditHint(text: string, isError = false): void {
  const hint = body?.querySelector<HTMLElement>('#agentAuditHint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('is-error', isError);
}

function renderAudit(): void {
  const list = body?.querySelector<HTMLElement>('#agentAuditList');
  const count = body?.querySelector<HTMLElement>('#agentAuditCount');
  const summaryElement = body?.querySelector<HTMLElement>('#agentAuditSummary');
  const toolSelect = body?.querySelector<HTMLSelectElement>('#agentAuditToolFilter');
  const resultSelect = body?.querySelector<HTMLSelectElement>('#agentAuditResultFilter');
  if (!list) return;
  if (auditLoading) {
    list.innerHTML = '<div class="acp-empty">正在读取审计…</div>';
    return;
  }
  if (!auditState) {
    list.innerHTML = '<div class="acp-empty">审计尚未读取</div>';
    return;
  }
  if (!auditState.ok) {
    list.innerHTML = `<div class="acp-note is-error">读取审计失败：${escapeHtml(auditState.message ?? '未知错误')}</div>`;
    if (count) count.textContent = '—';
    if (summaryElement) summaryElement.textContent = '';
    setAuditHint('读取审计失败，未展示任何记录。', true);
    return;
  }
  const all = Array.isArray(auditState.entries) ? auditState.entries : [];
  const tools = auditToolNames(all);
  if (auditFilterTool && !tools.includes(auditFilterTool)) auditFilterTool = '';
  if (toolSelect) {
    toolSelect.innerHTML = '<option value="">全部工具</option>' +
      tools.map((tool) => `<option value="${escapeHtml(tool)}">${escapeHtml(tool)}</option>`).join('');
    toolSelect.value = auditFilterTool;
  }
  if (resultSelect) resultSelect.value = auditFilterResult;
  if (count) count.textContent = String(auditState.total ?? auditState.summary?.total ?? all.length);
  if (summaryElement) summaryElement.textContent = auditSummaryText(auditState.summary);

  const filtered = auditEntriesForView();
  const limited = limitAuditEntries(filtered, 200);
  const dropped = (auditState.dropped ?? 0) + limited.dropped;
  const filterText = auditFilterTool || auditFilterResult !== 'all' ? `筛选后 ${filtered.length} 条` : `最近 ${limited.entries.length} 条`;
  if (dropped > 0) {
    setAuditHint(`已显示${filterText}；超过 200 条上限，更早 ${dropped} 条已丢弃（审计文件仍保留）。`);
  } else {
    setAuditHint(`审计只记录工具名、结果、耗时与脱敏后的参数；当前${filterText}。`);
  }
  if (limited.entries.length === 0) {
    list.innerHTML = all.length === 0
      ? '<div class="acp-empty">还没有工具调用记录。离线问答与模型调用都会写入审计。</div>'
      : '<div class="acp-empty">当前筛选条件下没有记录。</div>';
    return;
  }
  list.innerHTML = limited.entries.map((entry) => {
    const ok = entry.ok === true;
    const code = entry.code ?? (ok ? 'OK' : 'FAILED');
    return `<details class="acp-audit-row ${ok ? 'is-ok' : 'is-error'}">
      <summary>
        <span class="acp-audit-time">${escapeHtml(timeText(entry.at))}</span>
        <span class="acp-audit-tool">${escapeHtml(entry.tool)}</span>
        <span class="acp-audit-args">${escapeHtml(auditArgsText(entry))}</span>
        <span class="acp-audit-code">${escapeHtml(code)}</span>
        <span class="acp-audit-elapsed">${escapeHtml(formatDuration(entry.elapsedMs))}</span>
      </summary>
      <pre class="acp-audit-json">${escapeHtml(auditEntryJson(entry))}</pre>
    </details>`;
  }).join('');
}

async function exportAuditCsv(): Promise<void> {
  if (!window.desktop) return;
  const entries = auditEntriesForView();
  if (entries.length === 0) {
    setAuditHint('当前筛选结果为空，没有可导出的审计记录。', true);
    return;
  }
  try {
    const result = await window.desktop.exportFile(auditExportFileName(), auditCsv(entries));
    if (result.canceled) setAuditHint('已取消导出，未写入文件。');
    else setAuditHint(`已导出 ${entries.length} 条审计记录：${result.path ?? auditExportFileName()}`);
  } catch (error) {
    setAuditHint(`导出失败：${errorMessage(error)}`, true);
  }
}

async function loadAudit(): Promise<void> {
  if (!window.desktop) return;
  auditLoading = true;
  renderAudit();
  try {
    auditState = await window.desktop.agent.audit.read();
  } catch (error) {
    auditState = { ok: false, message: errorMessage(error) };
  } finally {
    auditLoading = false;
    renderAudit();
  }
}

function updateBusyState(): void {
  const send = body?.querySelector<HTMLButtonElement>('#agentChatSend');
  const clear = body?.querySelector<HTMLButtonElement>('#agentChatClear');
  const cancel = body?.querySelector<HTMLButtonElement>('#agentChatCancel');
  const busy = thinking || multiPlan?.running === true;
  if (send) {
    send.disabled = busy;
    send.textContent = thinking ? '思考中…' : '发送';
  }
  if (clear) clear.disabled = busy;
  if (cancel) {
    cancel.hidden = !busy;
    cancel.disabled = cancelRequested;
    cancel.textContent = cancelRequested ? '取消中…' : '取消执行';
  }
  setStatus('agentChatStatus', busy ? (cancelRequested ? '取消中…' : '执行中…') : '就绪');
}

function chatFeedback(message: string, isError = false): void {
  const element = body?.querySelector<HTMLElement>('#agentChatFeedback');
  if (!element) return;
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

/** 取最后一条用户消息之后的对话，用于统计本轮工具调用次数。 */
function lastTurnMessages(): Array<{ role: string; content?: string | null }> {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      start = index;
      break;
    }
  }
  return messages.slice(start).map((message) => ({ role: message.role, content: message.content }));
}

async function sendMessage(): Promise<void> {
  if (!body || thinking || multiPlan?.running) return;
  const input = fieldElement('agentChatInput');
  const text = input?.value.trim() ?? '';
  if (!text) return;
  if (!window.desktop) {
    chatFeedback('智能体对话仅在桌面版可用。', true);
    return;
  }
  thinking = true;
  chatFeedback('');
  if (input) input.value = '';
  cancelRequested = false;
  resetProgress();
  renderPreview();
  updateBusyState();
  const started = Date.now();
  try {
    const result = await window.desktop.agent.chat.send(text);
    messages = Array.isArray(result.messages) ? result.messages : messages;
    if (result.ok) {
      const turn = summarizeTurn(lastTurnMessages());
      lastReceipt = buildReceipt({
        mode: result.mode === 'offline' ? 'offline' : 'online',
        elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : Date.now() - started,
        toolCalls: turn.toolCalls,
        failures: turn.failures
      });
    } else if (result.cancelled) {
      lastReceipt = null;
      chatFeedback(result.message || '已取消，未写入任何更改', true);
      void loadAudit();
    }
    renderMessages();
    if (!result.ok && !result.cancelled) {
      chatFeedback(result.message || '智能体请求失败', true);
    } else if (result.ok) {
      void loadAudit();
    }
  } catch (error) {
    chatFeedback(`智能体请求失败：${errorMessage(error)}`, true);
  } finally {
    thinking = false;
    cancelRequested = false;
    updateBusyState();
  }
}

async function clearMessages(): Promise<void> {
  if (!window.desktop) return;
  try {
    const result = await window.desktop.agent.chat.clear();
    messages = Array.isArray(result.messages) ? result.messages : [];
    lastReceipt = null;
    renderMessages();
    chatFeedback('');
  } catch (error) {
    chatFeedback(`清空失败：${errorMessage(error)}`, true);
  }
}

async function saveSettings(): Promise<void> {
  if (!window.desktop) return;
  const baseUrl = fieldElement('agentLlmBaseUrl')?.value.trim() ?? '';
  const model = fieldElement('agentLlmModel')?.value.trim() ?? '';
  const apiKey = fieldElement('agentLlmApiKey')?.value ?? '';
  const maxIterations = Number(fieldElement('agentLlmMaxIterations')?.value ?? '');
  const payload: Record<string, unknown> = { baseUrl, model, maxIterations };
  if (apiKeyDirty) payload.apiKey = apiKey;
  const button = body?.querySelector<HTMLButtonElement>('#agentLlmSave');
  if (button) button.disabled = true;
  setStatus('agentLlmStatus', '保存中…');
  try {
    llmState = await window.desktop.agent.saveLlmConfig(payload);
    fillConfig();
    messages = [];
    renderMessages();
    setStatus('agentLlmStatus', '已保存，对话已重置');
  } catch (error) {
    setStatus('agentLlmStatus', `保存失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function testSettings(): Promise<void> {
  if (!window.desktop) return;
  const baseUrl = fieldElement('agentLlmBaseUrl')?.value.trim() ?? '';
  const model = fieldElement('agentLlmModel')?.value.trim() ?? '';
  const apiKey = fieldElement('agentLlmApiKey')?.value ?? '';
  const maxIterations = Number(fieldElement('agentLlmMaxIterations')?.value ?? '');
  const payload: Record<string, unknown> = { baseUrl, model, maxIterations };
  if (apiKeyDirty) payload.apiKey = apiKey;
  const button = body?.querySelector<HTMLButtonElement>('#agentLlmTest');
  if (button) button.disabled = true;
  setStatus('agentLlmStatus', '测试中…');
  try {
    const result = await window.desktop.agent.testLlm(payload);
    setStatus('agentLlmStatus', result.message, !result.ok);
  } catch (error) {
    setStatus('agentLlmStatus', `测试失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindControls(): void {
  body?.querySelector<HTMLButtonElement>('#agentChatSend')?.addEventListener('click', () => { void sendMessage(); });
  body?.querySelector<HTMLButtonElement>('#agentChatClear')?.addEventListener('click', () => { void clearMessages(); });
  body?.querySelector<HTMLButtonElement>('#agentPlanRunAll')?.addEventListener('click', () => { void runMultiPlan('all'); });
  body?.querySelector<HTMLButtonElement>('#agentPlanRunStep')?.addEventListener('click', () => { void runMultiPlan('step'); });
  body?.querySelector<HTMLButtonElement>('#agentPlanCancel')?.addEventListener('click', () => { void cancelMultiPlan(); });
  body?.querySelector<HTMLButtonElement>('#agentChatCancel')?.addEventListener('click', () => { void cancelExecution(); });
  body?.querySelector<HTMLButtonElement>('#agentLlmSave')?.addEventListener('click', () => { void saveSettings(); });
  body?.querySelector<HTMLButtonElement>('#agentLlmTest')?.addEventListener('click', () => { void testSettings(); });
  body?.querySelector<HTMLButtonElement>('#agentAuditRefresh')?.addEventListener('click', () => { void loadAudit(); });
  body?.querySelector<HTMLButtonElement>('#agentAuditExport')?.addEventListener('click', () => { void exportAuditCsv(); });
  body?.querySelector<HTMLSelectElement>('#agentAuditToolFilter')?.addEventListener('change', (event) => {
    auditFilterTool = (event.target as HTMLSelectElement).value;
    renderAudit();
  });
  body?.querySelector<HTMLSelectElement>('#agentAuditResultFilter')?.addEventListener('change', (event) => {
    auditFilterResult = (event.target as HTMLSelectElement).value as AuditResultFilter;
    renderAudit();
  });
  body?.querySelector<HTMLTextAreaElement>('#agentChatInput')?.addEventListener('input', () => { renderPreview(); });
  body?.querySelector<HTMLInputElement>('#agentLlmApiKey')?.addEventListener('input', () => { apiKeyDirty = true; });
  body?.querySelector<HTMLTextAreaElement>('#agentChatInput')?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendMessage();
    }
  });
}

async function refresh(): Promise<void> {
  if (!body) return;
  if (refreshButton) refreshButton.disabled = true;
  body.innerHTML = '<div class="acp-empty">正在读取智能体状态…</div>';
  try {
    if (!window.desktop) throw new Error('智能体面板仅在桌面版可用');
    const [info, config, chat] = await Promise.all([
      window.desktop.agent.info() as Promise<AgentInfo>,
      window.desktop.agent.getLlmConfig(),
      window.desktop.agent.chat.history()
    ]);
    infoState = info;
    llmState = config;
    messages = Array.isArray(chat.messages) ? chat.messages : [];
    renderShell();
    void loadAudit();
  } catch (error) {
    infoState = { error: `读取智能体状态失败：${errorMessage(error)}` };
    body.innerHTML = `<div class="acp-status is-on is-error">${escapeHtml(infoState.error ?? '')}</div>
      <div class="acp-note">请检查主进程日志与 7420 端口占用情况。密钥只保存在本机 userData 中。</div>`;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

export function initAgentPanel(): void {
  if (drawer) return;
  ensurePanelStyles();
  disposeProgress?.();
  disposeProgress = window.desktop?.agent.onProgress?.(applyProgress) ?? null;
  buildEntryButton('agentEntryButton', '智能体', AGENT_ICON, () => {
    if (!drawer) return;
    drawer.open();
    void refresh();
  });
  drawer = createDrawer('agentDrawer', '智能体', '对话 · 工具调用 · 模型设置');
  body = drawer.body;
  drawer.footer.innerHTML = '<button type="button" class="acp-btn acp-btn-primary" id="agentRefresh">刷新</button><span class="acp-pill">LLM 工具调用</span><span class="acp-pill">密钥仅主进程</span>';
  refreshButton = drawer.footer.querySelector<HTMLButtonElement>('#agentRefresh');
  refreshButton?.addEventListener('click', () => { void refresh(); });
  renderShell();
}
