/**
 * 只读工具并行执行（P7-N）
 *
 * 设计约束：
 * - 只并行「无写、无参数依赖」的只读调用，默认并发度 3；
 * - 后一步参数引用前一步结果时，该步自动降级为串行；
 * - 写工具始终单独成批，写与其后的只读调用之间形成屏障，避免读到旧状态；
 * - 任何一步失败不取消已发出的调用，结果按原顺序返回，错误原样保留。
 *
 * 参数依赖只识别显式占位符：`$0`、`${0}`、`{{0.data}}`、`{{step0...}}`、
 * `{{result[0]...}}`、`call_0` 等；只会把「引用更早下标」的步骤降级为串行。
 */

export const DEFAULT_PARALLEL_CONCURRENCY = 3;

export interface BatchStep {
  tool: string;
  args: unknown;
  readOnly: boolean;
  /** 原调用下标；缺省时使用数组下标。依赖占位符按该下标判断前序关系。 */
  index?: number;
}

export type BatchReason = 'read-only' | 'write' | 'dependency' | 'write-barrier';

export interface ExecutionBatch {
  /** 原步骤数组下标，保持原顺序。 */
  indexes: number[];
  concurrent: boolean;
  reason: BatchReason;
}

export interface BatchResult {
  index: number;
  ok: boolean;
  value?: unknown;
  error?: unknown;
}

export interface BatchRunSummary {
  results: BatchResult[];
  maxConcurrency: number;
  failed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectDependencyIndexes(value: unknown, output: Set<number>): void {
  if (typeof value === 'string') {
    const patterns = [
      /\$\{\s*(\d+)\s*\}/g,
      /\$\s*(\d+)\b/g,
      /\{\{\s*(?:step|result|call|tool)?\s*[\[.#:_-]?\s*(\d+)/gi,
      /\b(?:step|result|call|tool)\s*[\[.#:_-]\s*(\d+)/gi
    ];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const index = Number(match[1]);
        if (Number.isInteger(index) && index >= 0) output.add(index);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDependencyIndexes(item, output);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectDependencyIndexes(item, output);
  }
}

/** 参数中显式引用的前序 0 基步骤下标。 */
export function resultDependencyIndexes(args: unknown): number[] {
  const indexes = new Set<number>();
  collectDependencyIndexes(args, indexes);
  return [...indexes].sort((left, right) => left - right);
}

/** 是否引用前序结果；空参数、普通字符串均返回 false。 */
export function hasResultDependency(args: unknown): boolean {
  return resultDependencyIndexes(args).length > 0;
}

/** 该步骤是否依赖它之前的任意步骤。 */
export function dependsOnPrevious(args: unknown, index: number): boolean {
  return resultDependencyIndexes(args).some((dependency) => dependency < index);
}

/**
 * 把一次模型响应拆成执行批：
 * - 连续只读且无依赖 → 同一批并发；
 * - 有依赖 → 单独一批（串行降级）；
 * - 写工具 → 单独一批；同一响应内其后的只读步骤全部串行（写屏障）。
 */
export function planExecutionBatches(steps: readonly BatchStep[]): ExecutionBatch[] {
  const batches: ExecutionBatch[] = [];
  let current: number[] = [];
  let afterWrite = false;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      indexes: current,
      concurrent: current.length > 1,
      reason: 'read-only'
    });
    current = [];
  };

  for (const [index, step] of steps.entries()) {
    if (!step.readOnly) {
      flush();
      batches.push({ indexes: [index], concurrent: false, reason: 'write' });
      afterWrite = true;
      continue;
    }
    if (afterWrite) {
      flush();
      batches.push({ indexes: [index], concurrent: false, reason: 'write-barrier' });
      continue;
    }
    if (dependsOnPrevious(step.args, step.index ?? index)) {
      flush();
      batches.push({ indexes: [index], concurrent: false, reason: 'dependency' });
      continue;
    }
    current.push(index);
  }
  flush();
  return batches;
}

/**
 * 并发执行一批只读调用，结果按输入顺序返回。
 *
 * 不用 `Promise.all`：一个失败不应丢弃其他已发出的结果。这里用固定数量
 * worker 从队列取任务，任一 worker 失败只记录该条，继续处理剩余任务。
 */
export async function runReadOnlyBatch<T>(
  items: readonly T[],
  execute: (item: T, index: number) => Promise<unknown>,
  options: { concurrency?: number } = {}
): Promise<BatchRunSummary> {
  const total = items.length;
  const results: BatchResult[] = Array.from({ length: total }, (_item, index) => ({
    index,
    ok: false
  }));
  const limit = Math.max(1, Math.min(total || 1, Math.trunc(options.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY)));
  let next = 0;
  let active = 0;
  let maxConcurrency = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= total) return;
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
      try {
        results[index] = { index, ok: true, value: await execute(items[index] as T, index) };
      } catch (error) {
        failed += 1;
        results[index] = { index, ok: false, error };
      } finally {
        active -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, total) }, () => worker()));
  return { results, maxConcurrency, failed };
}

/** 顺序执行一批（写步骤、依赖步骤或并发度 1 时使用）。 */
export async function runSequentialBatch<T>(
  items: readonly T[],
  execute: (item: T, index: number) => Promise<unknown>
): Promise<BatchRunSummary> {
  return runReadOnlyBatch(items, execute, { concurrency: 1 });
}
