import type { CommandResult } from './commands.ts';
import type { AgentCommandExecutor } from './tools.ts';
import type { LlmClient, LlmMessage, LlmToolCall } from './llm.ts';

export interface AgentSessionOptions {
  llm: LlmClient;
  bus: AgentCommandExecutor;
  confirmWrite(name: string, args: Record<string, unknown>): Promise<boolean>;
  maxIterations?: number;
  historyLimit?: number;
}

export type ConfirmWrite = AgentSessionOptions['confirmWrite'];

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
  private messages: LlmMessage[] = [];

  constructor(options: AgentSessionOptions) {
    this.llm = options.llm;
    this.bus = options.bus;
    this.confirmWrite = options.confirmWrite;
    this.maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? 6));
    this.historyLimit = Math.max(2, Math.trunc(options.historyLimit ?? 20));
  }

  history(): LlmMessage[] {
    return this.messages.map((message) => ({
      ...message,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {})
    }));
  }

  clear(): void {
    this.messages = [];
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
        return { ok: false, code: 'USER_DENIED', message: '用户拒绝执行该工具' };
      }
    }

    let result: CommandResult;
    try {
      result = name === 'undo_last'
        ? await this.bus.undoLast()
        : await this.bus.execute(COMMAND_ALIASES[name] ?? name, args);
    } catch (error) {
      return failedTool('TOOL_EXECUTION_FAILED', error instanceof Error ? error.message : String(error));
    }

    if (name === 'run_interference_check' && result.ok && isRecord(result.data) && Array.isArray(result.data.items)) {
      return {
        ok: true,
        hits: Number(result.data.hits ?? result.data.items.length),
        items: result.data.items.slice(0, 20)
      };
    }
    return result;
  }

  async run(userText: string): Promise<string> {
    const text = userText.trim();
    if (!text) throw new Error('请输入要发送给智能体的内容');
    this.push({ role: 'user', content: text });

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const response = await this.llm.chat(this.context());
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
