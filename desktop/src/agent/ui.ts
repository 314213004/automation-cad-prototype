import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml
} from '../ui/panels';

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

function serviceAddress(info: AgentInfo): string {
  if (info.host && info.port) return `${info.host}:${info.port}`;
  if (info.url) return info.url.replace(/^https?:\/\//, '');
  return '—';
}

function timeText(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('zh-CN', { hour12: false });
}

function render(info: AgentInfo): void {
  if (!body) return;
  if (info.error) {
    body.innerHTML = `<div class="acp-status is-on is-error">${escapeHtml(info.error)}</div>
      <div class="acp-note">服务未启动时工具不可调用。请检查主进程日志与 7420 端口占用情况。</div>`;
    return;
  }

  const tools = Array.isArray(info.tools) ? info.tools : [];
  const history = Array.isArray(info.history) ? info.history.slice(-5).reverse() : [];
  const toolCount = info.toolCount ?? tools.length;
  body.innerHTML = `
    <div class="acp-section-title">本机服务 <b>${toolCount} 个工具</b></div>
    <div class="acp-pack-row">
      <div class="acp-pack-main">
        <div>
          <div class="acp-pack-name">${escapeHtml(serviceAddress(info))}</div>
          <div class="acp-pack-meta">HTTP JSON-RPC · Bearer token · 仅监听本机</div>
        </div>
        <span class="acp-pack-count">${toolCount}</span>
      </div>
      <div class="acp-pack-actions">
        <span class="acp-pill">服务地址 / 端口</span>
        <span class="acp-pill">token 文件</span>
      </div>
    </div>
    <div class="acp-field">
      <span>token 文件路径（不显示 token）</span>
      <div class="acp-note">${escapeHtml(info.tokenFile || '—')}</div>
    </div>
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
    <div class="acp-note">本面板只展示工具与命令状态，不提供聊天，也不直接连接 LLM。</div>`;
}

async function refresh(): Promise<void> {
  if (!body) return;
  if (refreshButton) refreshButton.disabled = true;
  body.innerHTML = '<div class="acp-empty">正在读取智能体状态…</div>';
  try {
    if (!window.desktop) throw new Error('智能体面板仅在桌面版可用');
    render(await window.desktop.agent.info() as AgentInfo);
  } catch (error) {
    render({ error: `读取智能体状态失败：${errorMessage(error)}` });
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
  drawer = createDrawer('agentDrawer', '智能体', '工具总线 · 本机服务状态');
  body = drawer.body;
  drawer.footer.innerHTML = '<button type="button" class="acp-btn acp-btn-primary" id="agentRefresh">刷新</button><span class="acp-pill">只读状态</span><span class="acp-pill">不显示 token</span>';
  refreshButton = drawer.footer.querySelector<HTMLButtonElement>('#agentRefresh');
  refreshButton?.addEventListener('click', () => { void refresh(); });
  render({});
}
