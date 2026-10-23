import type {
  Issue,
  PlcGenConfig,
  PlcSequenceStep
} from './types.ts';
import {
  createRenderContext,
  formatTime,
  renderGeneratedFile,
  type GenerateInput
} from './st.ts';
import { buildSymbolMap, outputBindings, resolveSymbol, tagRef } from './symbols.ts';

export interface SequenceStepModel {
  stepNo: number;
  name: string;
  id?: string;
  sets: string[];
  resets: string[];
  waits: string[];
  condition: string;
  timeoutMs: number;
  referencedPoints: string[];
}

export interface SequencePlan {
  steps: SequenceStepModel[];
  warnings: Issue[];
}

export interface SequenceGenerateResult {
  content: string;
  steps: number;
  warnings: Issue[];
}

interface ConditionTranslation {
  expression: string;
  references: string[];
  unresolved: string[];
}

const OPERATOR_TOKENS = new Set([
  'AND', 'OR', 'NOT', 'XOR', 'MOD', 'TRUE', 'FALSE'
]);
const POINT_TOKEN = /^%?(?:[IQ]\d+\.\d+|[XY]\d+(?:\.\d+)?|DI\d+(?:\.\d+)?|DQ\d+(?:\.\d+)?)$/i;
const IDENTIFIER_TOKEN = /%?(?:[IQ]\d+\.\d+|[XY]\d+(?:\.\d+)?|DI\d+(?:\.\d+)?|DQ\d+(?:\.\d+)?)|[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_.\u4e00-\u9fff]*/gi;

function issue(code: string, message: string, path?: string): Issue {
  return path ? { code, message, path } : { code, message };
}

function asText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function appendUnique(target: string[], values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    const point = value.trim();
    if (point && !target.includes(point)) target.push(point);
  }
}

function booleanValue(value: boolean | number | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no'].includes(text)) return false;
  return undefined;
}

function actionOf(step: PlcSequenceStep): string {
  return asText(step.action ?? step.type);
}

function isWaitAction(action: string): boolean {
  return ['wait', 'expect', '等待', '确认', '检查'].includes(action);
}

function isResetAction(action: string): boolean {
  return ['reset', 'clear', '复位'].includes(action);
}

function isSetAction(action: string): boolean {
  return ['set', 'write', 'assign', 'coil', '置位', '赋值', '输出'].includes(action);
}

function translateCondition(
  text: string,
  symbols: Map<string, string>,
  warnings: Issue[],
  path: string
): ConditionTranslation {
  const references: string[] = [];
  const unresolved: string[] = [];
  const normalized = text
    .trim()
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(/&/g, ' AND ')
    .replace(/\|/g, ' OR ')
    .replace(/\s+/g, ' ');

  const expression = normalized.replace(IDENTIFIER_TOKEN, (token) => {
    const upper = token.toUpperCase();
    if (OPERATOR_TOKENS.has(upper)) return upper;
    const variable = resolveSymbol(symbols, token);
    if (variable) {
      references.push(token);
      return tagRef(variable);
    }
    if (POINT_TOKEN.test(token)) {
      references.push(token);
      unresolved.push(token);
      warnings.push(issue(
        'SEQUENCE_POINT_UNRESOLVED',
        `步序条件引用的点位 ${token} 未出现在 IO 变量表中，已保留原符号`,
        path
      ));
    }
    return token;
  });

  return { expression, references, unresolved };
}

function waitExpression(
  point: string,
  expect: boolean | undefined,
  symbols: Map<string, string>,
  warnings: Issue[],
  path: string
): string {
  const variable = resolveSymbol(symbols, point);
  if (!variable) {
    warnings.push(issue(
      'SEQUENCE_POINT_UNRESOLVED',
      `步序等待的点位 ${point} 未出现在 IO 变量表中，已保留原符号`,
      path
    ));
    return expect === false ? `NOT ${point}` : point;
  }
  const reference = tagRef(variable);
  return expect === false ? `NOT ${reference}` : reference;
}

function combineAnd(parts: string[]): string {
  if (parts.length === 0) return 'TRUE';
  if (parts.length === 1) return parts[0] ?? 'TRUE';
  return parts.map((part) => (/\sOR\s/.test(part) ? `(${part})` : part)).join(' AND ');
}

function normalizeTimeout(
  step: PlcSequenceStep,
  stepNo: number,
  defaultTimeoutMs: number,
  warnings: Issue[]
): number {
  const raw = step.timeoutMs ?? step.timeout;
  if (raw === undefined) return defaultTimeoutMs;
  if (Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) return raw;
  warnings.push(issue(
    'SEQUENCE_TIMEOUT_INVALID',
    `步序第 ${stepNo} 步超时 ${String(raw)} 无效，已回落默认 ${defaultTimeoutMs} ms`
  ));
  return defaultTimeoutMs;
}

/** 把联调步序归一化为状态机模型；不做 IO 存在性判断（预检负责拦截）。 */
export function buildSequencePlan(input: GenerateInput): SequencePlan {
  const ctx = createRenderContext(input);
  const config: PlcGenConfig = ctx.config;
  const rawSteps: readonly PlcSequenceStep[] = config.sequence ?? config.steps ?? [];
  const warnings: Issue[] = [];
  if (rawSteps.length === 0) {
    warnings.push(issue('SEQUENCE_EMPTY', '联调步序为空，FC_AutoSequence 仅生成空状态机骨架'));
    return { steps: [], warnings };
  }

  const symbols = buildSymbolMap(config);
  const steps = rawSteps.map((step, index): SequenceStepModel => {
    const stepNo = index + 1;
    const path = `sequence[${index}]`;
    const action = actionOf(step);
    const waitAction = isWaitAction(action);
    const resetAction = isResetAction(action);
    const setAction = isSetAction(action);
    const sets: string[] = [];
    const resets: string[] = [];
    const waits: string[] = [];
    const referencedPoints: string[] = [];

    appendUnique(sets, step.setPoints);
    appendUnique(sets, step.sets);
    appendUnique(resets, step.resetPoints);
    appendUnique(resets, step.resets);
    appendUnique(waits, step.waitPoints);
    appendUnique(waits, step.waits);

    if (waitAction) {
      if (step.point) appendUnique(waits, [step.point]);
      appendUnique(waits, step.points);
    } else if (resetAction) {
      if (step.point) appendUnique(resets, [step.point]);
      appendUnique(resets, step.points);
    } else if (setAction || step.point || step.points) {
      const value = booleanValue(step.value);
      const target = value === false ? resets : sets;
      if (step.point) appendUnique(target, [step.point]);
      appendUnique(target, step.points);
    }

    for (const point of [...sets, ...resets, ...waits]) {
      if (!referencedPoints.includes(point)) referencedPoints.push(point);
    }

    const conditionParts: string[] = [];
    const expected = booleanValue(step.expect);
    if (waits.length > 0) {
      conditionParts.push(combineAnd(waits.map((point) => (
        waitExpression(point, expected, symbols, warnings, `${path}.waitPoints`)
      ))));
    }
    if (step.condition?.trim()) {
      const translated = translateCondition(step.condition, symbols, warnings, `${path}.condition`);
      conditionParts.push(/\sOR\s/.test(translated.expression) ? `(${translated.expression})` : translated.expression);
      for (const ref of translated.references) {
        if (!referencedPoints.includes(ref)) referencedPoints.push(ref);
      }
    }

    const condition = combineAnd(conditionParts);
    if (condition === 'TRUE') {
      warnings.push(issue(
        'SEQUENCE_NO_CONDITION',
        `步序第 ${stepNo} 步没有转移条件，将立即跳到下一步`,
        path
      ));
    }

    for (const point of sets) {
      if (resets.includes(point)) {
        warnings.push(issue(
          'SEQUENCE_POINT_CONFLICT',
          `步序第 ${stepNo} 步同时对点位 ${point} 置位与复位，复位优先生效`,
          path
        ));
      }
    }

    const model: SequenceStepModel = {
      stepNo,
      name: (step.name ?? step.id ?? `步骤 ${stepNo}`).trim() || `步骤 ${stepNo}`,
      sets,
      resets,
      waits,
      condition,
      timeoutMs: normalizeTimeout(step, stepNo, ctx.sequenceTimeoutMs, warnings),
      referencedPoints
    };
    if (step.id?.trim()) model.id = step.id.trim();
    return model;
  });

  return { steps, warnings };
}

function buildOutputRefs(config: PlcGenConfig): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const binding of outputBindings(config)) {
    if (seen.has(binding.row.name)) continue;
    seen.add(binding.row.name);
    refs.push(tagRef(binding.row.name));
  }
  return refs;
}

function renderStateMachine(
  plan: SequencePlan,
  config: PlcGenConfig,
  sequenceTimeout: string
): string[] {
  const symbols = buildSymbolMap(config);
  const lines: string[] = [];
  const outputs = buildOutputRefs(config);
  const resetOutputs = outputs.map((reference) => `        ${reference} := FALSE;`);

  lines.push('_AbortEdge(CLK := Abort);', '');
  lines.push('// 中止或安全停止均回到 Step0，空步只保留待机状态。');
  lines.push('IF _AbortEdge.Q OR SafeStop THEN');
  lines.push('    StepNo := STEP_IDLE;');
  lines.push('    SeqTimeout := FALSE;');
  lines.push('    StepErrorCode := 16#0000;');
  lines.push('    _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
  lines.push('END_IF;', '');
  lines.push('CASE StepNo OF');
  lines.push('    STEP_IDLE:');
  lines.push('        // 待机：所有输出复位，等待启动。');
  lines.push(...resetOutputs);
  lines.push('        SeqTimeout := FALSE;');
  lines.push('        StepErrorCode := 16#0000;');
  lines.push('        _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
  lines.push('        IF Start AND NOT SafeStop AND NOT Abort THEN');
  lines.push(`            StepNo := ${plan.steps.length > 0 ? 1 : 'STEP_IDLE'};`);
  lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
  lines.push('        END_IF;');

  if (plan.steps.length === 0) {
    lines.push('        (* 联调步序为空：未生成转移动画分支。 *)');
  }

  for (const step of plan.steps) {
    const next = step.stepNo < plan.steps.length ? step.stepNo + 1 : 0;
    const timeout = formatTime(step.timeoutMs);
    lines.push('');
    lines.push(`    ${step.stepNo}:`);
    lines.push(`        // ${step.name}`);
    for (const point of step.sets) {
      const variable = resolveSymbol(symbols, point);
      if (variable) lines.push(`        ${tagRef(variable)} := TRUE;`);
    }
    for (const point of step.resets) {
      const variable = resolveSymbol(symbols, point);
      if (variable) lines.push(`        ${tagRef(variable)} := FALSE;`);
    }
    lines.push(`        _StepTimer(IN := TRUE, PT := ${timeout});`);
    lines.push(`        IF ${step.condition} THEN`);
    lines.push(`            StepNo := ${next};`);
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        ELSIF _StepTimer.Q THEN');
    lines.push('            StepNo := STEP_ERROR;');
    lines.push('            SeqTimeout := TRUE;');
    lines.push('            StepErrorCode := 16#8101;');
    lines.push('            AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;');
    lines.push('            _StepTimer(IN := FALSE, PT := ' + sequenceTimeout + ');');
    lines.push('        END_IF;');
  }

  lines.push('');
  lines.push('    STEP_ERROR:');
  lines.push('        // StepError：超时锁存，报警字已写入，等待 Abort 复位。');
  lines.push('        SeqTimeout := TRUE;');
  lines.push(...resetOutputs);
  lines.push('    ELSE');
  lines.push('        StepNo := STEP_ERROR;');
  lines.push('        SeqTimeout := TRUE;');
  lines.push('END_CASE;');
  return lines;
}

export function generateSequence(input: GenerateInput): SequenceGenerateResult {
  const ctx = createRenderContext(input);
  const plan = buildSequencePlan(input);
  const body: string[] = [
    'FUNCTION FC_AutoSequence : VOID',
    'VAR_INPUT',
    '    Start : BOOL;',
    '    Abort : BOOL;',
    '    SafeStop : BOOL;',
    'END_VAR',
    'VAR_OUTPUT',
    '    StepNo : INT;',
    '    SeqTimeout : BOOL;',
    '    StepErrorCode : WORD;',
    'END_VAR',
    'VAR_IN_OUT',
    '    AlarmWord : WORD;',
    'END_VAR',
    'VAR',
    '    _StepTimer : TON;',
    '    _AbortEdge : R_TRIG;',
    'END_VAR',
    'VAR CONSTANT',
    '    STEP_IDLE : INT := 0;',
    '    STEP_ERROR : INT := 99;',
    '    ALARM_SEQ_TIMEOUT : WORD := 16#8101;',
    'END_VAR',
    ''
  ];
  body.push(...renderStateMachine(plan, ctx.config, ctx.sequenceTimeout));
  body.push('');
  const content = renderGeneratedFile(ctx, 'src/FC_AutoSequence.st', body.join('\n'));
  return { content, steps: plan.steps.length, warnings: plan.warnings };
}

export const generateAutoSequence = generateSequence;
