import type { CommandResult } from './commands.ts';
import type { AgentCommandExecutor } from './tools.ts';
import type { LlmClient, LlmMessage, LlmToolCall } from './llm.ts';
import type { AgentAuditRecord } from './audit.ts';
import { describePlan, planReadOnly } from './router.ts';
import {
  emptyAgentContext,
  serializeAgentContext,
  type AgentContext
} from './context.ts';
import { AgentMemory, summarizeToolCall } from './memory.ts';
import { serializeToolResult } from './trim.ts';

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
  /** 每轮对话开始时采集 UI 上下文；失败按空快照处理，不阻断对话。 */
  contextProvider?: () => AgentContext | null | Promise<AgentContext | null>;
}

export type ConfirmWrite = AgentSessionOptions['confirmWrite'];

/** 最近一次回复的通道：在线模型 / 离线规则。UI 用它显示统一回执。 */
export type AgentReplyMode = 'online' | 'offline';

const MUTATING_TOOLS = new Set([
  'import_cad',
  'insert_component',
  'place_component',
  'update_component',
  'remove_component',
  'run_plc_generate',
  'export_files',
  'undo_last',
  'export_cost_report'
]);
const COMMAND_ALIASES: Record<string, string> = {
  run_interference_check: 'run_interference'
};

const SYSTEM_PROMPT = [
  '你是 AutomationCAD 的桌面智能体。',
  '可以使用工具查询元器件、读取工程上下文/BOM、导入 CAD、插入/修改/移除元件、在底板放置元件、执行干涉初筛、生成 PLC 工程、生成成本报告并导出文件、撤销。',
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
  private readonly contextProvider: AgentSessionOptions['contextProvider'];
  private readonly memory = new AgentMemory();
  private messages: LlmMessage[] = [];
  private replyMode: AgentReplyMode = 'online';
  private turnContext: AgentContext = emptyAgentContext();

  constructor(options: AgentSessionOptions) {
    this.llm = options.llm;
    this.bus = options.bus;
    this.confirmWrite = options.confirmWrite;
    this.maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? 6));
    this.historyLimit = Math.max(2, Math.trunc(options.historyLimit ?? 20));
    this.audit = options.audit;
    this.offlineFallback = options.offlineFallback !== false;
    this.contextProvider = options.contextProvider;
  }

  private recordAudit(record: AgentAuditRecord): void {
    if (!this.audit) return;
    try {
      this.audit(record);
    } catch (error) {
      // 审计失败不阻断对话，但必须留下可诊断的告警。
      console.warn('[agent] 审计写入失败', error);
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
    this.turnContext = emptyAgentContext();
    this.memory.clear();
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

  private systemPrompt(): LlmMessage {
    const packed = serializeAgentContext(this.turnContext);
    const memory = this.memory.prompt();
    return {
      role: 'system',
      content: [SYSTEM_PROMPT, packed.text, memory].filter(Boolean).join('\n\n')
    };
  }

  private context(): LlmMessage[] {
    return [
      this.systemPrompt(),
      ...this.messages.map((message) => ({ ...message }))
    ];
  }

  private async executeTool(call: LlmToolCall): Promise<unknown> {
    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.function.arguments);
    } catch (error) {
      this.memory.record(summarizeToolCall(call.function.name, {}, failedTool('INVALID_ARGUMENT', '参数不是合法 JSON')));
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
      } catch (error) {
        const message = `确认对话框失败：${error instanceof Error ? error.message : String(error)}`;
        this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
        this.recordAudit({ tool: name, ok: false, code: 'USER_DENIED', source: 'llm', args, message });
        return { ok: false, code: 'USER_DENIED', message };
      }
      if (!allowed) {
        this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
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
      this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'TOOL_EXECUTION_FAILED' }));
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
    this.memory.record(summarizeToolCall(name, args, result));

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
    const plan = planReadOnly(text, this.turnContext);
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
    this.memory.record(summarizeToolCall(plan.tool, plan.args, result));
    if (!result.ok) {
      return `模型暂不可用，离线规则已调用 ${plan.tool}，但返回失败：${result.error?.message ?? '未知错误'}`;
    }
    const detail = result.data === undefined ? '' : serializeToolResult(result.data).text;
    const summary = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
    const reference = plan.resolvedFrom
      ? `已使用${plan.resolvedFrom === 'selection' ? '选中对象' : plan.resolvedFrom === 'recent' ? '最近操作对象' : '底板对象'}：${plan.resolvedLabel ?? ''}`
      : '';
    return [
      '当前模型不可用，已切换为离线规则路由（只执行只读工具，写操作需要联网确认）。',
      reference,
      `已执行：${describePlan(plan)}`,
      summary ? `结果：${summary}` : ''
    ].filter(Boolean).join('\n');
  }

  async run(userText: string): Promise<string> {
    const text = userText.trim();
    if (!text) throw new Error('请输入要发送给智能体的内容');
    this.replyMode = 'online';
    this.turnContext = emptyAgentContext();
    if (this.contextProvider) {
      try {
        this.turnContext = await this.contextProvider() ?? emptyAgentContext();
      } catch {
        this.turnContext = emptyAgentContext();
      }
    }
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
          content: serializeToolResult(result).text
        });
      }
    }

    const reply = `已达到最大工具调用轮数（${this.maxIterations}），请缩小任务范围`;
    this.push({ role: 'assistant', content: reply });
    return reply;
  }
}
