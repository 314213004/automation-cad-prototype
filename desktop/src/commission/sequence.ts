import type { PlcValue } from '../plc/types.ts';

export type StepAction = 'wait' | 'set' | 'expect';

export interface Step {
  id: string;
  name: string;
  precondition?: (values: Record<string, PlcValue>) => string | null;
  action: StepAction;
  point?: string;
  value?: PlcValue;
  timeoutMs?: number;
  expect?: PlcValue;
}

export interface StepResult {
  stepId: string;
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  at: string;
  durationMs: number;
  message?: string;
}

export interface SequenceResult {
  pass: boolean;
  results: StepResult[];
  failure?: StepResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface SequenceIo {
  read(id: string): Promise<PlcValue>;
  write(id: string, value: PlcValue): Promise<void>;
  readAll?(): Promise<Record<string, PlcValue>>;
  onStep?(result: StepResult, step: Step): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_POLL_MS = 50;

function formatValue(value: PlcValue | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function equalValue(left: PlcValue | undefined, right: PlcValue | undefined): boolean {
  return left !== undefined && right !== undefined && left === right;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSequence(
  steps: readonly Step[],
  io: SequenceIo
): Promise<SequenceResult> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = Math.max(10, io.pollMs ?? DEFAULT_POLL_MS);
  const started = now();
  const results: StepResult[] = [];

  const finish = (pass: boolean, failure?: StepResult): SequenceResult => {
    const finished = now();
    return {
      pass,
      results,
      ...(failure ? { failure } : {}),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started
    };
  };

  for (const step of steps) {
    const stepStarted = now();
    let expected = '—';
    let actual = '—';
    let message: string | undefined;
    let pass = false;
    let preconditionSatisfied = true;

    if (step.precondition) {
      expected = '前置条件满足';
      try {
        const values = io.readAll ? await io.readAll() : {};
        const reason = step.precondition(values);
        if (reason) {
          message = `阶段「${step.name}」前置条件不满足：${reason}`;
          actual = reason;
          preconditionSatisfied = false;
        } else {
          actual = '满足';
        }
      } catch (error) {
        message = `阶段「${step.name}」读取前置条件失败：${errorText(error)}`;
        actual = `读取失败：${errorText(error)}`;
        preconditionSatisfied = false;
      }
    }

    if (preconditionSatisfied) {
      if (step.action === 'set') {
        if (!step.point) {
          message = `缺少必填参数：阶段「${step.name}」的点位 id`;
        } else if (step.value === undefined) {
          message = `缺少必填参数：阶段「${step.name}」的写入值`;
        } else {
          expected = `${step.point} = ${formatValue(step.value)}`;
          try {
            await io.write(step.point, step.value);
            const readback = await io.read(step.point);
            actual = `${step.point} = ${formatValue(readback)}`;
            pass = equalValue(readback, step.value);
            if (!pass) {
              message = `阶段「${step.name}」写入回读不一致：点位 ${step.point}，期望 ${formatValue(step.value)}，实际 ${formatValue(readback)}`;
            }
          } catch (error) {
            actual = `${step.point} = 写入失败：${errorText(error)}`;
            message = `阶段「${step.name}」写入点位 ${step.point} 失败：${errorText(error)}`;
          }
        }
      } else {
        if (!step.point) {
          message = `缺少必填参数：阶段「${step.name}」的点位 id`;
        } else if (step.expect === undefined) {
          message = `缺少必填参数：阶段「${step.name}」的期望值`;
        } else {
          expected = `${step.point} = ${formatValue(step.expect)}`;
          const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          const deadline = now() + timeoutMs;
          let lastError = '';
          do {
            try {
              const value = await io.read(step.point);
              actual = `${step.point} = ${formatValue(value)}`;
              if (equalValue(value, step.expect)) {
                pass = true;
                break;
              }
            } catch (error) {
              lastError = errorText(error);
              actual = `${step.point} = 读取失败：${lastError}`;
            }
            if (now() >= deadline) break;
            await sleep(pollMs);
          } while (now() <= deadline);
          if (!pass) {
            message = lastError
              ? `阶段「${step.name}」超时（${timeoutMs}ms）：点位 ${step.point} 期望 ${formatValue(step.expect)}，实际读取失败：${lastError}`
              : `阶段「${step.name}」超时（${timeoutMs}ms）：点位 ${step.point} 期望 ${formatValue(step.expect)}，实际 ${actual}`;
          }
        }
      }
    }

    const result: StepResult = {
      stepId: step.id,
      name: step.name,
      pass,
      expected,
      actual,
      at: new Date(now()).toISOString(),
      durationMs: now() - stepStarted,
      ...(message ? { message } : {})
    };
    results.push(result);
    io.onStep?.(result, step);
    if (!result.pass) return finish(false, result);
  }

  return finish(true);
}
