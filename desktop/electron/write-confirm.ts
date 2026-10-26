import { ipcMain, type BrowserWindow } from 'electron';

/**
 * 写操作确认：主进程 → 渲染进程的页面内卡片，一问一答。
 *
 * 为什么不用 `dialog.showMessageBox`：原生模态框在无人值守 / CDP 远程调试下不可见也点不到，
 * 实测会把智能体（或外部 MCP 客户端）挂在一个隐形窗口上直到超时。
 *
 * 约定：渲染进程用 `agent:confirm-write:reply` 回 `{ id, allow, remember }`；
 * 超过 120 秒、窗口销毁、或回包 id 不匹配都按拒绝处理——绝不默认放行。
 */
export const WRITE_CONFIRM_TIMEOUT_MS = 120_000;

export interface WriteConfirmRequest {
  /** 工具名，页面卡片上做徽标显示。 */
  tool: string;
  /** 工具参数（原样序列化展示；>600 字符截断）。 */
  args: unknown;
  /** 卡片正文，默认「该操作会修改当前装配体。」 */
  detail?: string;
  /** 越权提示（用户说了「别问了」之类），卡片用警告色显示。 */
  bypassNotice?: string;
  /** 卡片标题，区分「智能体」与「外部客户端」。 */
  title?: string;
}

export async function requestWriteConfirmation(
  window: BrowserWindow | null,
  request: WriteConfirmRequest
): Promise<boolean> {
  if (!window || window.isDestroyed()) return false;
  const serialized = JSON.stringify(request.args ?? {});
  const summary = serialized.length > 600 ? `${serialized.slice(0, 600)}…` : serialized;
  const requestId = `cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const answer = new Promise<{ allow: boolean; remember?: boolean }>((resolve) => {
    let settled = false;
    const finish = (value: { allow: boolean; remember?: boolean }): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('agent:confirm-write:reply', onReply);
      clearTimeout(timer);
      resolve(value);
    };
    const onReply = (event: Electron.IpcMainEvent, payload: unknown): void => {
      if (typeof payload !== 'object' || payload === null) return;
      const record = payload as { id?: unknown; allow?: unknown; remember?: unknown };
      if (record.id !== requestId) return;
      if (event.sender !== window.webContents) return;
      finish({ allow: record.allow === true, remember: record.remember === true });
    };
    const timer = setTimeout(() => finish({ allow: false }), WRITE_CONFIRM_TIMEOUT_MS);
    ipcMain.on('agent:confirm-write:reply', onReply);
  });

  window.webContents.send('agent:confirm-write:request', {
    id: requestId,
    tool: request.tool,
    summary,
    detail: request.detail ?? '该操作会修改当前装配体。',
    bypassNotice: request.bypassNotice,
    title: request.title ?? '智能体请求写操作'
  });
  return (await answer).allow;
}
