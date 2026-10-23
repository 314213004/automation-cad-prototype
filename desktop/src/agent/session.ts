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
import { DATA_POLICY_PROMPT, guardToolResult } from './guard.ts';
import { repairToolCall } from './repair.ts';
import { buildFallbackReply, buildRetryPrompt } from './retry.ts';
import {
  cancellationText,
  summarizeArguments,
  type AgentProgressEvent,
  type CompletedStep
} from './feedback.ts';

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
  /** 工具参数 JSON Schema（name → schema）；用于模型脏输出纠错。 */
  toolSchemas?: Record<string, unknown> | ((name: string) => unknown);
}

export type ConfirmWrite = AgentSessionOptions['confirmWrite'];

export interface AgentRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  /** 由主进程生成，用于 UI 丢弃上一轮迟到的进度事件。 */
  runId?: string;
}

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

class AgentAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'AgentAborted';
  }
}

/** 会话被取消时抛出；completed 只包含已结束的步骤，不含被中断的当前步。 */
export class AgentCancelledError extends Error {
  readonly completedSteps: CompletedStep[];
  readonly currentTool: string | undefined;
  readonly currentToolMayWrite: boolean;

  constructor(completedSteps: CompletedStep[], currentTool?: string, currentToolMayWrite = false) {
    super(cancellationText({ completed: completedSteps, ...(currentTool ? { currentTool } : {}), currentToolMayWrite }));
    this.name = 'AgentCancelledError';
    this.completedSteps = completedSteps.map((item) => ({ ...item }));
    this.currentTool = currentTool;
    this.currentToolMayWrite = currentToolMayWrite;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAborted();
}

/** 只用于中断「等待」；底层命令若已越过不可中断点，按已完成结果处理。 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AgentAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AgentAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

const SYSTEM_PROMPT = [
  '你是 AutomationCAD 的桌面智能体。',
  '可以使用工具查询元器件、读取工程上下文/BOM、导入 CAD、插入/修改/移除元件、在底板放置元件、执行干涉初筛、生成 PLC 工程、生成成本报告并导出文件、撤销。',
  '当用户要求查询、计算、修改、生成或导出时，应直接调用已注册工具，不要只给出操作建议。',
  '只读工具会读取当前文档；缺少显式参数时先调用只读工具或 get_project_context，再根据结果决定能否继续，不要凭猜测填参数。',
  '导入 CAD 时若用户未给路径，先使用上下文或最近操作中的 STEP/IGES 文件路径；确实没有才追问。',
  '生成 BOM 使用 get_bom；只有用户明确要求导出/下载文件时才调用 export_files。',
  '缺少外形尺寸只影响底板绘制与几何校核，不得因此拒绝导出 BOM、PDF 或成本报告；应在结果里提示「N 个件无尺寸」并照常完成导出。',
  '只有会造成元件重叠、覆盖已存在文件或破坏数据时才暂停并请求用户确认；其余情况按用户指令继续执行，不要自行降级为「只给建议」。',
  '电气合规、线号或载流量问题直接调用 run_electrical_check；工具会读取当前电气文档，不要先用 BOM 推断缺少数据。',
  '涉及「怎么操作 / 限制 / 决策依据 / 为什么」时先调用 search_docs 查本地项目文档；答案要引用返回的 source 与 heading。没有命中就明确说查不到，禁止凭空编造。',
  '位号明确时直接调用 update_component / remove_component，由工具校验目标；不要仅凭猜测跳过写操作。',
  '用户说“生成 PLC 程序”并要求落盘时用 run_plc_generate；verify_plc_program 只用于模拟验证。',
  '工具结果会以 JSON 数据块返回；失败时根据错误码向用户解释，不要编造执行结果。',
  '涉及修改装配体或写文件的操作会先请求用户确认。',
  DATA_POLICY_PROMPT
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

type PreparedToolCalls =
  | { ok: true; calls: LlmToolCall[]; repairs: string[] }
  | { ok: false; reason: string; repairs: string[] };

export class AgentSession {
  private readonly llm: LlmClient;
  private readonly bus: AgentCommandExecutor;
  private readonly confirmWrite: ConfirmWrite;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly audit: ((record: AgentAuditRecord) => void) | undefined;
  private readonly offlineFallback: boolean;
  private readonly contextProvider: AgentSessionOptions['contextProvider'];
  private readonly toolSchemas: AgentSessionOptions['toolSchemas'];
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
    this.toolSchemas = options.toolSchemas;
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

  private toolSchema(name: string): Record<string, unknown> | undefined {
    const source = typeof this.toolSchemas === 'function'
      ? this.toolSchemas(name)
      : this.toolSchemas?.[name];
    return isRecord(source) ? source : undefined;
  }

  /** 对模型返回的每个工具调用做结构修复 + schema 校验；任一失败则整轮重试。 */
  private prepareToolCalls(calls: LlmToolCall[]): PreparedToolCalls {
    const repaired: LlmToolCall[] = [];
    const repairs: string[] = [];
    for (const call of calls) {
      const result = repairToolCall(call.function.arguments, this.toolSchema(call.function.name), {
        ...(this.turnContext.selection ? { selection: this.turnContext.selection } : {})
      });
      if (!result.ok || !result.call) {
        const message = result.error?.message ?? '工具参数无法解析';
        return { ok: false, reason: `${call.function.name}: ${message}`, repairs };
      }
      for (const note of result.repairs) repairs.push(`${call.function.name}: ${note}`);
      repaired.push({
        ...call,
        function: { name: call.function.name, arguments: JSON.stringify(result.call.args) }
      });
    }
    return { ok: true, calls: repaired, repairs };
  }

  /** 重试上下文：把上一次无效输出作为普通 assistant 文本回灌，再追加纠错指令。 */
  private retryContext(reason: string, invalid: LlmToolCall[]): LlmMessage[] {
    const summary = invalid
      .map((call) => `${call.function.name} ${call.function.arguments}`)
      .join('\n')
      .slice(0, 800);
    return [
      ...this.context(),
      { role: 'assistant', content: `上次工具调用输出：\n${summary}` },
      { role: 'user', content: buildRetryPrompt(reason) }
    ];
  }

  private respondFallback(userText: string, reason: string): string {
    const reply = buildFallbackReply(reason, userText);
    this.push({ role: 'assistant', content: reply });
    return reply;
  }

  private emitProgress(
    onProgress: AgentRunOptions['onProgress'],
    event: AgentProgressEvent
  ): void {
    if (!onProgress) return;
    try {
      onProgress(event);
    } catch {
      // 进度展示失败不能影响工具执行。
    }
  }

  private async executeTool(
    call: LlmToolCall,
    context: {
      runId: string;
      index: number;
      total: number;
      completed: CompletedStep[];
      signal?: AbortSignal;
      onProgress?: AgentRunOptions['onProgress'];
    }
  ): Promise<unknown> {
    const name = call.function.name;
    const startedAt = Date.now();
    let args: Record<string, unknown> = {};
    try {
      args = parseArguments(call.function.arguments);
    } catch (error) {
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'start',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary: summarizeArguments(call.function.arguments),
        startedAt,
        callId: call.id,
        source: 'chat'
      });
      const message = `工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
      this.memory.record(summarizeToolCall(name, {}, failedTool('INVALID_ARGUMENT', '参数不是合法 JSON')));
      this.recordAudit({
        tool: name,
        ok: false,
        code: 'INVALID_ARGUMENT',
        source: 'llm',
        message,
        elapsedMs: Date.now() - startedAt
      });
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'end',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary: summarizeArguments(call.function.arguments),
        startedAt,
        callId: call.id,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        code: 'INVALID_ARGUMENT',
        message,
        source: 'chat'
      });
      context.completed.push({ step: context.index, tool: name, ok: false, code: 'INVALID_ARGUMENT', wrote: false });
      return failedTool('INVALID_ARGUMENT', message);
    }

    const argsSummary = summarizeArguments(args);
    this.emitProgress(context.onProgress, {
      runId: context.runId,
      phase: 'start',
      index: context.index,
      total: context.total,
      tool: name,
      argsSummary,
      startedAt,
      callId: call.id,
      source: 'chat'
    });

    const finish = (ok: boolean, code: string, message?: string): void => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.recordAudit({
        tool: name,
        ok,
        source: 'llm',
        args,
        elapsedMs,
        ...(code !== 'OK' ? { code } : {}),
        ...(message ? { message } : {})
      });
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'end',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary,
        startedAt,
        callId: call.id,
        elapsedMs,
        ok,
        code,
        ...(message ? { message } : {}),
        source: 'chat'
      });
      if (code !== 'CANCELLED') {
        context.completed.push({
          step: context.index,
          tool: name,
          ok,
          code,
          wrote: ok && MUTATING_TOOLS.has(name)
        });
      }
    };

    try {
      throwIfAborted(context.signal);
      if (MUTATING_TOOLS.has(name)) {
        let allowed = false;
        try {
          allowed = await withAbort(this.confirmWrite(name, args), context.signal);
        } catch (error) {
          if (error instanceof AgentAborted) {
            finish(false, 'CANCELLED', '已取消');
            throw new AgentCancelledError(context.completed, name, false);
          }
          const message = `确认对话框失败：${error instanceof Error ? error.message : String(error)}`;
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
          finish(false, 'USER_DENIED', message);
          return { ok: false, code: 'USER_DENIED', message };
        }
        if (!allowed) {
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
          finish(false, 'USER_DENIED', '用户拒绝执行该工具');
          return { ok: false, code: 'USER_DENIED', message: '用户拒绝执行该工具' };
        }
      }

      if (context.signal?.aborted) {
        finish(false, 'CANCELLED', '已取消');
        throw new AgentCancelledError(context.completed, name, false);
      }
      const command = COMMAND_ALIASES[name] ?? name;
      const result = await withAbort(
        name === 'undo_last'
          ? this.bus.undoLast(context.signal)
          : this.bus.execute(command, args, context.signal),
        context.signal
      );
      this.memory.record(summarizeToolCall(name, args, result));
      const code = result.ok ? 'OK' : (result.error?.code ?? 'COMMAND_FAILED');
      finish(result.ok, code, result.ok ? undefined : result.error?.message);

      if (name === 'run_interference_check' && result.ok && isRecord(result.data) && Array.isArray(result.data.items)) {
        return {
          ok: true,
          hits: Number(result.data.hits ?? result.data.items.length),
          items: result.data.items.slice(0, 20)
        };
      }
      return result;
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      if (error instanceof AgentAborted) {
        finish(false, 'CANCELLED', '已取消');
        throw new AgentCancelledError(context.completed, name, MUTATING_TOOLS.has(name));
      }
      const message = error instanceof Error ? error.message : String(error);
      this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'TOOL_EXECUTION_FAILED' }));
      finish(false, 'TOOL_EXECUTION_FAILED', message);
      return failedTool('TOOL_EXECUTION_FAILED', message);
    }
  }

  /**
   * 模型不可用（断网/超时/未配密钥）时的离线通道：只走规则路由的只读工具。
   * 写操作一律不执行，只回一句“需要联网确认”，避免离线状态下误改文档。
   */
  private async runOffline(
    text: string,
    options: AgentRunOptions,
    completed: CompletedStep[]
  ): Promise<string | null> {
    if (!this.offlineFallback) return null;
    const plan = planReadOnly(text, this.turnContext);
    if (!plan) return null;
    const startedAt = Date.now();
    const runId = options.runId ?? 'offline';
    const argsSummary = summarizeArguments(plan.args);
    this.emitProgress(options.onProgress, {
      runId,
      phase: 'start',
      index: 1,
      total: 1,
      tool: plan.tool,
      argsSummary,
      startedAt,
      source: 'chat'
    });
    let result: CommandResult;
    try {
      throwIfAborted(options.signal);
      result = await withAbort(
        plan.tool === 'undo_last'
          ? this.bus.undoLast(options.signal)
          : this.bus.execute(plan.tool, plan.args, options.signal),
        options.signal
      );
    } catch (error) {
      if (error instanceof AgentAborted) {
        this.emitProgress(options.onProgress, {
          runId,
          phase: 'end',
          index: 1,
          total: 1,
          tool: plan.tool,
          argsSummary,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          code: 'CANCELLED',
          message: '已取消',
          source: 'chat'
        });
        throw new AgentCancelledError(completed, plan.tool, MUTATING_TOOLS.has(plan.tool));
      }
      const message = error instanceof Error ? error.message : String(error);
      this.recordAudit({
        tool: plan.tool,
        ok: false,
        code: 'OFFLINE_FAILED',
        source: 'offline',
        args: plan.args,
        message,
        elapsedMs: Date.now() - startedAt
      });
      return `模型暂不可用，已按离线规则尝试 ${plan.tool}，但执行失败：${message}`;
    }
    const code = result.ok ? 'OK' : (result.error?.code ?? 'COMMAND_FAILED');
    this.recordAudit({
      tool: plan.tool,
      ok: result.ok,
      source: 'offline',
      args: plan.args,
      elapsedMs: Date.now() - startedAt,
      ...(result.ok ? {} : { code })
    });
    this.emitProgress(options.onProgress, {
      runId,
      phase: 'end',
      index: 1,
      total: 1,
      tool: plan.tool,
      argsSummary,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      ok: result.ok,
      code,
      ...(result.ok ? {} : { message: result.error?.message ?? '未知错误' }),
      source: 'chat'
    });
    completed.push({ step: 1, tool: plan.tool, ok: result.ok, code, wrote: result.ok && MUTATING_TOOLS.has(plan.tool) });
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

  async run(userText: string, options: AgentRunOptions = {}): Promise<string> {
    const text = userText.trim();
    if (!text) throw new Error('请输入要发送给智能体的内容');
    const runId = options.runId ?? `chat-${Date.now()}`;
    const completed: CompletedStep[] = [];
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

    let retryUsed = false;
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (options.signal?.aborted) throw new AgentCancelledError(completed);
      let response;
      try {
        response = await withAbort(this.llm.chat(this.context()), options.signal);
      } catch (error) {
        if (error instanceof AgentAborted || options.signal?.aborted) throw new AgentCancelledError(completed);
        const offline = await this.runOffline(text, { ...options, runId }, completed);
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

      const originalCalls = response.toolCalls;
      const checked = this.prepareToolCalls(originalCalls);
      let calls: LlmToolCall[];
      if (!checked.ok) {
        const reason = checked.reason;
        const toolNames = originalCalls.map((call) => call.function.name).join(',');
        this.recordAudit({
          tool: toolNames,
          ok: false,
          code: 'TOOL_CALL_INVALID',
          source: 'llm',
          message: reason,
          reason,
          retries: retryUsed ? 1 : 0
        });
        if (retryUsed) {
          this.recordAudit({
            tool: toolNames,
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: reason,
            reason,
            retries: 1
          });
          return this.respondFallback(text, reason);
        }

        retryUsed = true;
        let retryResponse;
        try {
          retryResponse = await withAbort(this.llm.chat(this.retryContext(reason, originalCalls)), options.signal);
        } catch (error) {
          if (error instanceof AgentAborted || options.signal?.aborted) throw new AgentCancelledError(completed);
          const offline = await this.runOffline(text, { ...options, runId }, completed);
          if (offline) {
            this.replyMode = 'offline';
            this.push({ role: 'assistant', content: offline });
            return offline;
          }
          throw error;
        }
        if (retryResponse.toolCalls.length === 0) {
          const reply = retryResponse.content.trim();
          if (reply) {
            this.recordAudit({
              tool: toolNames,
              ok: true,
              code: 'TOOL_CALL_RETRY_TEXT',
              source: 'llm',
              message: reason,
              reason,
              retries: 1
            });
            this.push({ role: 'assistant', content: reply });
            return reply;
          }
          this.recordAudit({
            tool: toolNames,
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: reason,
            reason,
            retries: 1
          });
          return this.respondFallback(text, reason);
        }

        const retried = this.prepareToolCalls(retryResponse.toolCalls);
        if (!retried.ok) {
          this.recordAudit({
            tool: retryResponse.toolCalls.map((call) => call.function.name).join(','),
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: retried.reason,
            reason: retried.reason,
            retries: 1
          });
          return this.respondFallback(text, retried.reason);
        }
        this.recordAudit({
          tool: retryResponse.toolCalls.map((call) => call.function.name).join(','),
          ok: true,
          code: 'TOOL_CALL_RETRY_OK',
          source: 'llm',
          message: reason,
          reason,
          retries: 1,
          ...(retried.repairs.length > 0 ? { repairs: retried.repairs } : {})
        });
        response = retryResponse;
        calls = retried.calls;
      } else {
        calls = checked.calls;
        if (checked.repairs.length > 0) {
          this.recordAudit({
            tool: calls.map((call) => call.function.name).join(','),
            ok: true,
            code: 'TOOL_CALL_REPAIRED',
            source: 'llm',
            message: checked.repairs.join('; '),
            repairs: checked.repairs,
            retries: 0
          });
        }
      }

      this.push({
        role: 'assistant',
        content: response.content.trim() || null,
        tool_calls: calls.map((call) => ({
          ...call,
          function: { ...call.function }
        }))
      });

      const total = calls.length;
      for (const [index, call] of calls.entries()) {
        if (options.signal?.aborted) throw new AgentCancelledError(completed);
        const result = await this.executeTool(call, {
          runId,
          index: index + 1,
          total,
          completed,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {})
        });
        this.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: guardToolResult(serializeToolResult(result).text, call.function.name).text
        });
      }
      if (options.signal?.aborted) throw new AgentCancelledError(completed);
    }

    const reply = `已达到最大工具调用轮数（${this.maxIterations}），请缩小任务范围`;
    this.push({ role: 'assistant', content: reply });
    return reply;
  }
}
