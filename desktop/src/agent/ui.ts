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
  describeAuditEntry,
  summarizeTurn,
  type Receipt
} from './preview.ts';

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
        <button type="button" class="acp-btn" id="agentChatClear">清空</button>
        <span class="acp-pill" id="agentChatStatus">就绪</span>
      </div>
      <div class="acp-note acp-chat-feedback" id="agentChatFeedback" hidden></div>
      <div class="acp-plan-preview is-none" id="agentPlanPreview">
        <div class="acp-plan-title" id="agentPlanTitle">等待输入</div>
        <div class="acp-plan-detail" id="agentPlanDetail">预览不会执行任何命令；输入后会显示将要调用的工具。</div>
        <div class="acp-plan-hint" id="agentPlanHint"></div>
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
    <div class="acp-audit-list" id="agentAuditList"><div class="acp-empty">正在读取审计…</div></div>
    <div class="acp-row">
      <button type="button" class="acp-btn" id="agentAuditRefresh">刷新审计</button>
      <span class="acp-note" id="agentAuditSummary"></span>
    </div>
    <div class="acp-note">审计只记录工具名、结果与脱敏后的参数摘要，最近 50 条。</div>
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

function renderToolCard(call: DesktopAgentToolCall, result: DesktopAgentChatMessage | undefined): string {
  let status = '待执行';
  let tone = 'is-warn';
  let detail = '';
  if (result) {
    let ok = true;
    try {
      const parsed = JSON.parse(result.content ?? '') as unknown;
      ok = !(typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === false);
      detail = summaryText(result.content ?? '', 260);
    } catch {
      detail = summaryText(result.content ?? '', 260);
    }
    status = ok ? '成功' : '失败';
    tone = ok ? 'is-ok' : 'is-error';
  }
  return `
    <div class="acp-chat-tool ${tone}" data-tool-call-id="${escapeHtml(call.id)}">
      <div class="acp-chat-tool-head">
        <span class="acp-pack-name">${escapeHtml(call.function.name)}</span>
        <span class="acp-pill ${tone}">${status}</span>
      </div>
      <div class="acp-pack-meta">参数：${escapeHtml(summaryText(call.function.arguments, 180))}</div>
      ${detail ? `<div class="acp-pack-meta">结果：${escapeHtml(detail)}</div>` : ''}
    </div>`;
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
  const preview = buildPlanPreview(text);
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
}

/** 审计面板：最近 8 条 + 汇总，读不到时给中文原因，不静默空白。 */
function renderAudit(): void {
  const list = body?.querySelector<HTMLElement>('#agentAuditList');
  const count = body?.querySelector<HTMLElement>('#agentAuditCount');
  const summaryElement = body?.querySelector<HTMLElement>('#agentAuditSummary');
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
    return;
  }
  const entries = Array.isArray(auditState.entries) ? auditState.entries.slice(-8).reverse() : [];
  if (count) count.textContent = String(auditState.summary?.total ?? entries.length);
  if (summaryElement) summaryElement.textContent = auditSummaryText(auditState.summary);
  if (entries.length === 0) {
    list.innerHTML = '<div class="acp-empty">还没有工具调用记录。离线问答与模型调用都会写入审计。</div>';
    return;
  }
  list.innerHTML = entries.map((entry) => {
    const row = describeAuditEntry(entry);
    return `<div class="acp-audit-row ${row.tone}">
      <span class="acp-pack-name">${escapeHtml(row.title)}</span>
      <span class="acp-pack-meta">${escapeHtml(row.meta)}</span>
    </div>`;
  }).join('');
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
  if (send) {
    send.disabled = thinking;
    send.textContent = thinking ? '思考中…' : '发送';
  }
  if (clear) clear.disabled = thinking;
  setStatus('agentChatStatus', thinking ? '思考中…' : '就绪');
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
  if (!body || thinking) return;
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
    }
    renderMessages();
    if (!result.ok) {
      chatFeedback(result.message || '智能体请求失败', true);
    } else {
      void loadAudit();
    }
  } catch (error) {
    chatFeedback(`智能体请求失败：${errorMessage(error)}`, true);
  } finally {
    thinking = false;
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
  body?.querySelector<HTMLButtonElement>('#agentLlmSave')?.addEventListener('click', () => { void saveSettings(); });
  body?.querySelector<HTMLButtonElement>('#agentLlmTest')?.addEventListener('click', () => { void testSettings(); });
  body?.querySelector<HTMLButtonElement>('#agentAuditRefresh')?.addEventListener('click', () => { void loadAudit(); });
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
