/**
 * 单轮工具调用去重（P7-N）
 *
 * 设计约束：纯函数 + 会话内小状态，不读写文件、不联网。
 * - 只读工具按 `(tool, canonicalArgs)` 合并；同一轮内第二次及以后直接复用结果。
 * - 写工具永不合并：每次写都必须独立走确认与执行。
 * - 单轮工具调用总数上限默认 12，超出部分返回 `TOO_MANY_TOOL_CALLS`。
 *
 * `canonicalArgs` 的规范化顺序固定为：对象键排序 → 字符串去首尾空白并压缩连续空白
 * → 数字与纯数字字符串统一为最短数值文本（" 1.0 "、"1"、1 等价）。不同参数绝不合并。
 */

import { WRITE_TOOLS } from './router.ts';

export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 12;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 纯数字字符串转成最短数值文本；型号、版本号等混合字符串保持原样。 */
export function normalizeNumericString(value: string): string {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return text;
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  return Object.is(number, -0) ? '0' : String(number);
}

/** 去空白：首尾裁掉，内部连续空白压成一个普通空格。 */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** 递归规范化参数；数组顺序保留，对象键按字典序排序。 */
export function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return normalizeNumericString(String(value));
  }
  if (typeof value === 'string') {
    const text = normalizeText(value);
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
      ? normalizeNumericString(text)
      : text;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeValue(item));
  if (isRecord(value)) {
    const output: UnknownRecord = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      output[normalizeText(key)] = canonicalizeValue(value[key]);
    }
    return output;
  }
  return value;
}

/** 规范化后的稳定 JSON；同一语义参数得到同一字符串。 */
export function canonicalArgs(args: unknown): string {
  try {
    return JSON.stringify(canonicalizeValue(args ?? {})) ?? '{}';
  } catch {
    return '{}';
  }
}

/** 工具调用去重键。 */
export function toolCallKey(tool: string, args: unknown): string {
  return `${normalizeText(tool)}:${canonicalArgs(args)}`;
}

export interface DedupeInput {
  tool: string;
  args?: UnknownRecord;
  /** 参数无法解析时传 false，避免两条坏参数被误判为同一条。 */
  dedupe?: boolean;
  /** 显式覆盖去重键（坏参数场景用调用 ID 保证唯一）。 */
  key?: string;
}

export type DedupeAction = 'execute' | 'reuse' | 'overflow';

export interface DedupeDecision {
  index: number;
  tool: string;
  key: string;
  write: boolean;
  action: DedupeAction;
  /** 同批次内复用时，指向首次调用的下标。 */
  duplicateOf?: number;
  /** 之前批次已完成时，直接携带结果。 */
  result?: unknown;
  /** Map.has 区分「结果就是 undefined」与「还没有结果」。 */
  hasResult: boolean;
}

export interface DedupeStats {
  toolCalls: number;
  executed: number;
  reused: number;
  overflows: number;
}

export interface TurnCallDeduperOptions {
  maxCalls?: number;
  isWrite?: (tool: string) => boolean;
}

/**
 * 一轮对话（多轮模型迭代）内的调用账本。
 *
 * `plan` 可以一次传入模型单次响应里的全部调用，也可以在后续迭代继续调用；
 * 同批次重复项会得到 `duplicateOf`，调用方应在首次调用完成后取结果。
 */
export class TurnCallDeduper {
  private readonly maxCalls: number;
  private readonly isWrite: (tool: string) => boolean;
  private readonly results = new Map<string, unknown>();
  private toolCalls = 0;
  private executed = 0;
  private reused = 0;
  private overflows = 0;

  constructor(options: TurnCallDeduperOptions = {}) {
    this.maxCalls = Math.max(1, Math.trunc(options.maxCalls ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN));
    this.isWrite = options.isWrite ?? ((tool) => WRITE_TOOLS.has(tool));
  }

  /** 为一批调用分配执行/复用/超限动作；不执行任何工具。 */
  plan(inputs: readonly DedupeInput[]): DedupeDecision[] {
    const decisions: DedupeDecision[] = [];
    const batchKeys = new Map<string, number>();
    for (const [index, input] of inputs.entries()) {
      const tool = normalizeText(input.tool) || 'unknown';
      const write = this.isWrite(tool);
      const key = input.key ?? toolCallKey(tool, input.args ?? {});
      const dedupeEnabled = input.dedupe !== false && !write;
      this.toolCalls += 1;

      if (this.toolCalls > this.maxCalls) {
        this.overflows += 1;
        decisions.push({ index, tool, key, write, action: 'overflow', hasResult: false });
        continue;
      }

      if (dedupeEnabled && this.results.has(key)) {
        this.reused += 1;
        decisions.push({
          index,
          tool,
          key,
          write,
          action: 'reuse',
          result: this.results.get(key),
          hasResult: true
        });
        continue;
      }

      if (dedupeEnabled && batchKeys.has(key)) {
        this.reused += 1;
        decisions.push({
          index,
          tool,
          key,
          write,
          action: 'reuse',
          duplicateOf: batchKeys.get(key) as number,
          hasResult: false
        });
        continue;
      }

      if (dedupeEnabled) batchKeys.set(key, index);
      this.executed += 1;
      decisions.push({ index, tool, key, write, action: 'execute', hasResult: false });
    }
    return decisions;
  }

  /** 记录首次执行结果，供后续同轮调用复用。写工具不进入账本。 */
  complete(decision: DedupeDecision, result: unknown): void {
    if (decision.write) return;
    this.results.set(decision.key, result);
  }

  /** 写工具执行后清空结果账本，但保留本轮的调用计数与上限。 */
  invalidateResults(): void {
    this.results.clear();
  }

  /** 直接登记一个已取得的结果（例如 TTL 缓存命中）。 */
  remember(key: string, result: unknown): void {
    this.results.set(key, result);
  }

  hasResult(key: string): boolean {
    return this.results.has(key);
  }

  resultOf(key: string): unknown {
    return this.results.get(key);
  }

  stats(): DedupeStats {
    return {
      toolCalls: this.toolCalls,
      executed: this.executed,
      reused: this.reused,
      overflows: this.overflows
    };
  }

  clear(): void {
    this.results.clear();
    this.toolCalls = 0;
    this.executed = 0;
    this.reused = 0;
    this.overflows = 0;
  }
}

/** 一次性的纯函数封装，便于测试与离线调用方。 */
export function dedupeToolCalls(
  inputs: readonly DedupeInput[],
  options: TurnCallDeduperOptions = {}
): { decisions: DedupeDecision[]; stats: DedupeStats } {
  const deduper = new TurnCallDeduper(options);
  const decisions = deduper.plan(inputs);
  return { decisions, stats: deduper.stats() };
}
