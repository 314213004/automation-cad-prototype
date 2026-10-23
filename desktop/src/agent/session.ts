import type { CommandResult } from './commands.ts';
import type { AgentCommandExecutor } from './tools.ts';
import type { LlmClient, LlmMessage, LlmToolCall } from './llm.ts';
import type { AgentAuditRecord } from './audit.ts';
import { describePlan, planReadOnly } from './router.ts';

export interface AgentSessionOptions {
  llm: LlmClient;
  bus: AgentCommandExecutor;
  confirmWrite(name: string, args: Record<string, unknown>): Promise<boolean>;
  maxIterations?: number;
  historyLimit?: number;
  /** 审计回调：主进程写 agent-audit.jsonl；不传则不记录。 */
  audit?: (record: AgentAuditRecord) => void;
  /** 模型不可用时是否走离线规则路由（只读工具）；默认开启。 */
  offlineFallback?: boolean;
}

export type ConfirmWrite = AgentSessionOptions['confirmWrite'];

/** 最近一次回复的通道：在线模型 / 离线规则。UI 用它显示统一回执。 */
export type AgentReplyMode = 'online' | 'offline';

const MUTATING_TOOLS = new Set(['import_cad', 'insert_component', 'undo_last', 'export_cost_report']);
const COMMAND_ALIASES: Record<string, string> = {
  run_interference_check: 'run_interference'
};

const SYSTEM_PROMPT = [
  '你是 AutomationCAD 的桌面智能体。',
  '可以使用工具查询元器件、读取 BOM、导入 CAD、插入占位件、执行干涉初筛、生成成本报告并导出文件、撤销。',
  '工具结果会以 JSON 返回；失败时根据错误码向用户解释，不要编造执行结果。',
  '涉及修改装配体或写文件的操作会先请求用户确认。'
].join('');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('工具参数必须是 JSON 对象');
  return parsed;
}

function failedTool(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

export class AgentSession {
  private readonly llm: LlmClient;
  private readonly bus: AgentCommandExecutor;
  private readonly confirmWrite: ConfirmWrite;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly audit: ((record: AgentAuditRecord) => void) | undefined;
  private readonly offlineFallback: boolean;
  private messages: LlmMessage[] = [];
  private replyMode: AgentReplyMode = 'online';

  constructor(options: AgentSessionOptions) {
    this.llm = options.llm;
    this.bus = options.bus;
    this.confirmWrite = options.confirmWrite;
    this.maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? 6));
    this.historyLimit = Math.max(2, Math.trunc(options.historyLimit ?? 20));
    this.audit = options.audit;
    this.offlineFallback = options.offlineFallback !== false;
  }

  private recordAudit(record: AgentAuditRecord): void {
    if (!this.audit) return;
    try {
      this.audit(record);
    } catch {
      // 审计失败不影响对话。
    }
  }

  history(): LlmMessage[] {
    return this.messages.map((message) => ({
      ...message,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {})
    }));
  }

  clear(): void {
    this.messages = [];
    this.replyMode = 'online';
  }

  /** 最近一次 `run()` 走的是哪条通道；离线降级时返回 'offline'。 */
  mode(): AgentReplyMode {
    return this.replyMode;
  }

  private push(message: LlmMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.historyLimit) {
      this.messages.splice(0, this.messages.length - this.historyLimit);
    }
  }

  private context(): LlmMessage[] {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.messages.map((message) => ({ ...message }))
    ];
  }

  private async executeTool(call: LlmToolCall): Promise<unknown> {
    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.function.arguments);
    } catch (error) {
      this.recordAudit({
        tool: call.function.name,
        ok: false,
        code: 'INVALID_ARGUMENT',
        source: 'llm',
        message: error instanceof Error ? error.message : String(error)
      });
      return failedTool('INVALID_ARGUMENT', `工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }

    const name = call.function.name;
    if (MUTATING_TOOLS.has(name)) {
      let allowed = false;
      try {
        allowed = await this.confirmWrite(name, args);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        this.recordAudit({ tool: name, ok: false, code: 'USER_DENIED', source: 'llm', args });
        return { ok: false, code: 'USER_DENIED', message: '用户拒绝执行该工具' };
      }
    }

    let result: CommandResult;
    try {
      result = name === 'undo_last'
        ? await this.bus.undoLast()
        : await this.bus.execute(COMMAND_ALIASES[name] ?? name, args);
    } catch (error) {
      this.recordAudit({
        tool: name,
        ok: false,
        code: 'TOOL_EXECUTION_FAILED',
        source: 'llm',
        args,
        message: error instanceof Error ? error.message : String(error)
      });
      return failedTool('TOOL_EXECUTION_FAILED', error instanceof Error ? error.message : String(error));
    }

    this.recordAudit({
      tool: name,
      ok: result.ok,
      source: 'llm',
      args,
      ...(result.ok ? {} : { code: result.error?.code ?? 'COMMAND_FAILED' })
    });

    if (name === 'run_interference_check' && result.ok && isRecord(result.data) && Array.isArray(result.data.items)) {
      return {
        ok: true,
        hits: Number(result.data.hits ?? result.data.items.length),
        items: result.data.items.slice(0, 20)
      };
    }
    return result;
  }

  /**
   * 模型不可用（断网/超时/未配密钥）时的离线通道：只走规则路由的只读工具。
   * 写操作一律不执行，只回一句“需要联网确认”，避免离线状态下误改文档。
   */
  private async runOffline(text: string): Promise<string | null> {
    if (!this.offlineFallback) return null;
    const plan = planReadOnly(text);
    if (!plan) return null;
    let result: CommandResult;
    try {
      result = plan.tool === 'undo_last' ? await this.bus.undoLast() : await this.bus.execute(plan.tool, plan.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordAudit({ tool: plan.tool, ok: false, code: 'OFFLINE_FAILED', source: 'offline', args: plan.args, message });
      return `模型暂不可用，已按离线规则尝试 ${plan.tool}，但执行失败：${message}`;
    }
    this.recordAudit({
      tool: plan.tool,
      ok: result.ok,
      source: 'offline',
      args: plan.args,
      ...(result.ok ? {} : { code: result.error?.code ?? 'COMMAND_FAILED' })
    });
    if (!result.ok) {
      return `模型暂不可用，离线规则已调用 ${plan.tool}，但返回失败：${result.error?.message ?? '未知错误'}`;
    }
    const detail = result.data === undefined ? '' : JSON.stringify(result.data);
    const summary = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
    return [
      '当前模型不可用，已切换为离线规则路由（只执行只读工具，写操作需要联网确认）。',
      `已执行：${describePlan(plan)}`,
      summary ? `结果：${summary}` : ''
    ].filter(Boolean).join('\n');
  }

  async run(userText: string): Promise<string> {
    const text = userText.trim();
    if (!text) throw new Error('请输入要发送给智能体的内容');
    this.replyMode = 'online';
    this.push({ role: 'user', content: text });

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      let response;
      try {
        response = await this.llm.chat(this.context());
      } catch (error) {
        const offline = await this.runOffline(text);
        if (offline) {
          this.replyMode = 'offline';
          this.push({ role: 'assistant', content: offline });
          return offline;
        }
        throw error;
      }
      if (response.toolCalls.length === 0) {
        const reply = response.content.trim();
        this.push({ role: 'assistant', content: reply });
        return reply;
      }

      this.push({
        role: 'assistant',
        content: response.content.trim() || null,
        tool_calls: response.toolCalls.map((call) => ({
          ...call,
          function: { ...call.function }
        }))
      });

      for (const call of response.toolCalls) {
        const result = await this.executeTool(call);
        this.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(result)
        });
      }
    }

    const reply = `已达到最大工具调用轮数（${this.maxIterations}），请缩小任务范围`;
    this.push({ role: 'assistant', content: reply });
    return reply;
  }
}
