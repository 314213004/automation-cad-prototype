/**
 * Agent 工具调用纠错（纯函数）
 *
 * 真实模型在长任务里经常输出「看起来像 JSON」的文本：代码围栏、前后解释、
 * 单引号、尾逗号、注释、单位字符串、字符串布尔/整数，甚至截断。本模块只做
 * 可证明安全的修复：结构问题可以修，值的语义绝不猜（`"很多"` 不会被改成 1）。
 *
 * 约束：无 IO、无 DOM、无网络；同一输入永远得到同一结果，便于单测与审计复现。
 */

export type RepairErrorCode = 'NO_JSON' | 'INVALID_JSON' | 'TRUNCATED_JSON' | 'SCHEMA_INVALID';

export interface RepairError {
  code: RepairErrorCode;
  message: string;
  path?: string;
}

export interface RepairedToolCall {
  /** 模型在信封里写出的工具名；普通参数对象没有该字段。 */
  name?: string;
  args: Record<string, unknown>;
}

export interface RepairContext {
  /** 当前 UI 选中对象；仅用于补齐必填 partId，不做其他猜测。 */
  selection?: { id?: string | null } | null;
}

export interface RepairOptions extends RepairContext {
  /** 截断时最多补多少层 `}` / `]`（默认 3）。 */
  maxClosures?: number;
}

export interface RepairToolCallResult {
  ok: boolean;
  call?: RepairedToolCall;
  repairs: string[];
  error?: RepairError;
}

interface JsonExtraction {
  candidate: string;
  start: number;
  end: number;
  balanced: boolean;
}

interface BalanceScan {
  balanced: boolean;
  stack: Array<'{' | '['>;
  inString: boolean;
  escaped: boolean;
}

interface SchemaIssue {
  path: string;
  message: string;
}

const DEFAULT_MAX_CLOSURES = 3;
const NUMBER_WITH_UNIT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m|in|inch|°|deg|%|毫米|厘米|米)$/i;
const INTEGER_STRING = /^[+-]?\d+$/;
const BOOLEAN_STRING = /^(true|false)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  return typeof schema.type === 'string' ? schema.type : undefined;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(schema.properties) ? schema.properties : undefined;
}

function pathJoin(parent: string, key: string): string {
  if (!parent) return key;
  return /^\d+$/.test(key) ? `${parent}[${key}]` : `${parent}.${key}`;
}

function preview(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  } catch {
    // 循环引用等异常值只做字符串化兜底。
  }
  return String(value);
}

/** 只剥离开头的围栏；闭合围栏由 stripFence 的正常分支处理。 */
function stripFence(raw: string): { text: string; changed: boolean; surrounding: boolean } {
  const closed = raw.match(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/);
  if (closed) {
    const index = closed.index ?? 0;
    const outside = `${raw.slice(0, index)}${raw.slice(index + closed[0].length)}`;
    return { text: closed[1] ?? '', changed: true, surrounding: outside.trim().length > 0 };
  }
  const opened = raw.match(/^\s*```[ \t]*(?:json|JSON)?[ \t]*\r?\n?([\s\S]*)$/);
  if (opened) {
    const index = opened.index ?? 0;
    return { text: opened[1] ?? '', changed: true, surrounding: raw.slice(0, index).trim().length > 0 };
  }
  return { text: raw, changed: false, surrounding: false };
}

/**
 * 从任意文本里找第一个平衡的 JSON 对象/数组。
 * 逐字符扫描字符串、转义与 `//` 注释，不用贪婪正则。
 */
function extractFirstJson(text: string): JsonExtraction | null {
  let start = -1;
  let opener: '{' | '[' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{' || char === '[') {
      start = index;
      opener = char;
      break;
    }
  }
  if (start < 0 || !opener) return null;

  const stack: Array<'{' | '['> = [];
  let activeQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (activeQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline - 1;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
      continue;
    }
    if (char === '}' || char === ']') {
      const top = stack[stack.length - 1];
      const matches = (char === '}' && top === '{') || (char === ']' && top === '[');
      if (!matches) {
        return { candidate: text.slice(start, index + 1), start, end: index + 1, balanced: false };
      }
      stack.pop();
      if (stack.length === 0) {
        return { candidate: text.slice(start, index + 1), start, end: index + 1, balanced: true };
      }
    }
  }
  return { candidate: text.slice(start), start, end: text.length, balanced: false };
}

function scanBalance(text: string): BalanceScan {
  const stack: Array<'{' | '['> = [];
  let activeQuote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (activeQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline - 1;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      const top = stack[stack.length - 1];
      if ((char === '}' && top === '{') || (char === ']' && top === '[')) stack.pop();
    }
  }
  return { balanced: stack.length === 0 && !activeQuote, stack, inString: activeQuote !== null, escaped };
}

function stripLineComments(text: string): { text: string; changed: boolean } {
  let output = '';
  let activeQuote: '"' | "'" | null = null;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (activeQuote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
      output += char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      changed = true;
      const newline = text.indexOf('\n', index + 2);
      if (newline < 0) break;
      index = newline - 1;
      continue;
    }
    output += char;
  }
  return { text: output, changed };
}

function removeTrailingCommas(text: string): { text: string; changed: boolean } {
  let output = '';
  let activeQuote: '"' | "'" | null = null;
  let escaped = false;
  let changed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (activeQuote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === activeQuote) {
        activeQuote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      activeQuote = char;
      output += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead]!)) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') {
        changed = true;
        continue;
      }
    }
    output += char;
  }
  return { text: output, changed };
}

function convertSingleQuotes(text: string): { text: string; changed: boolean } {
  let output = '';
  let changed = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      output += char;
      let escaped = false;
      for (index += 1; index < text.length; index += 1) {
        const inner = text[index]!;
        output += inner;
        if (escaped) escaped = false;
        else if (inner === '\\') escaped = true;
        else if (inner === '"') break;
      }
      continue;
    }
    if (char !== "'") {
      output += char;
      continue;
    }
    changed = true;
    let content = '';
    let closed = false;
    for (index += 1; index < text.length; index += 1) {
      const inner = text[index]!;
      if (inner === '\\') {
        const next = text[index + 1];
        if (next === undefined) break;
        if (next === "'") content += "'";
        else if (next === '"') content += '\\"';
        else content += `\\${next}`;
        index += 1;
        continue;
      }
      if (inner === "'") {
        closed = true;
        break;
      }
      if (inner === '"') content += '\\"';
      else if (inner === '\n') content += '\\n';
      else if (inner === '\r') content += '\\r';
      else content += inner;
    }
    output += `"${content}"`;
    if (!closed) changed = true;
  }
  return { text: output, changed };
}

/** 应用文本级修正；每项只在真的改变文本时记录。 */
function normalizeText(text: string, repairs: string[]): string {
  let working = text;
  const withoutComments = stripLineComments(working);
  if (withoutComments.changed) {
    working = withoutComments.text;
    repairs.push('removed // comments');
  }
  const withoutTrailing = removeTrailingCommas(working);
  if (withoutTrailing.changed) {
    working = withoutTrailing.text;
    repairs.push('removed trailing commas');
  }
  const quoted = convertSingleQuotes(working);
  if (quoted.changed) {
    working = quoted.text;
    repairs.push('converted single quotes to double quotes');
  }
  return working;
}

function closeTruncated(text: string, maxClosures: number): { text: string; layers: number } | null {
  const scan = scanBalance(text);
  if (scan.balanced) return null;
  let suffix = scan.inString ? '"' : '';
  for (let index = scan.stack.length - 1; index >= 0; index -= 1) {
    suffix += scan.stack[index] === '{' ? '}' : ']';
  }
  if (suffix.length === 0) return null;
  if (suffix.length > maxClosures) return { text, layers: suffix.length };
  return { text: `${text}${suffix}`, layers: suffix.length };
}

interface ParsedJson {
  value: unknown;
  repairs: string[];
}

/** 解析一段候选 JSON；失败时返回 null，并由调用方决定错误码。 */
function parseCandidate(candidate: string, maxClosures: number): ParsedJson | null {
  const repairs: string[] = [];
  const normalized = normalizeText(candidate, repairs);
  try {
    return { value: JSON.parse(normalized) as unknown, repairs };
  } catch {
    const closed = closeTruncated(normalized, maxClosures);
    if (!closed) return null;
    if (closed.text === normalized) return null;
    try {
      const value = JSON.parse(closed.text) as unknown;
      repairs.push(`completed truncated JSON (${closed.layers} layer${closed.layers === 1 ? '' : 's'})`);
      return { value, repairs };
    } catch {
      return null;
    }
  }
}

function scalarCoerce(value: unknown, schema: Record<string, unknown>, repairs: string[]): unknown {
  const type = schemaType(schema);
  if (typeof value !== 'string') return value;
  if (type === 'boolean' && BOOLEAN_STRING.test(value.trim())) {
    const boolean = value.trim().toLowerCase() === 'true';
    repairs.push(`converted "${value}" to ${boolean} (boolean)`);
    return boolean;
  }
  if (type === 'integer' && INTEGER_STRING.test(value.trim())) {
    const integer = Number(value.trim());
    repairs.push(`converted "${value}" to ${integer} (integer)`);
    return integer;
  }
  if (type === 'number') {
    const match = value.trim().match(NUMBER_WITH_UNIT);
    if (match) {
      const numeric = Number(value.trim().slice(0, value.trim().length - match[1]!.length).trim());
      if (Number.isFinite(numeric)) {
        repairs.push(`converted "${value}" to ${numeric} (number)`);
        return numeric;
      }
    }
  }
  return value;
}

/**
 * 按 schema 做安全修正：类型转换只接受明确格式，必填 partId 只从选中对象补。
 * 未知字段在 `additionalProperties:false` 下删除并记录，不静默通过。
 */
function applySchemaFixes(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  repairs: string[],
  context: RepairContext
): unknown {
  const type = schemaType(schema);
  if (type === 'object' || schemaProperties(schema)) {
    if (!isRecord(value)) return value;
    const properties = schemaProperties(schema);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (properties && Object.hasOwn(properties, key)) {
        const childSchema = asSchema(properties[key]);
        output[key] = childSchema
          ? applySchemaFixes(item, childSchema, pathJoin(path, key), repairs, context)
          : item;
      } else if (schema.additionalProperties === false) {
        repairs.push(`removed unknown field ${pathJoin(path, key)}`);
      } else {
        output[key] = item;
      }
    }
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
    if (required.includes('partId') && !Object.hasOwn(output, 'partId')) {
      const selectionId = context.selection?.id;
      if (typeof selectionId === 'string' && selectionId.trim()) {
        output.partId = selectionId.trim();
        repairs.push('filled from selection');
      }
    }
    return output;
  }
  if (type === 'array') {
    const itemSchema = asSchema(schema.items);
    if (!Array.isArray(value) || !itemSchema) return value;
    return value.map((item, index) => applySchemaFixes(item, itemSchema, pathJoin(path, String(index)), repairs, context));
  }
  return scalarCoerce(value, schema, repairs);
}

function typeLabel(type: string): string {
  if (type === 'integer') return '整数';
  if (type === 'number') return '数字';
  if (type === 'string') return '字符串';
  if (type === 'boolean') return '布尔值';
  if (type === 'array') return '数组';
  if (type === 'object') return '对象';
  return type;
}

function typeMatches(value: unknown, type: string): boolean {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'null') return value === null;
  return true;
}

function validateSchema(value: unknown, schema: Record<string, unknown>, path: string): SchemaIssue | null {
  const type = schemaType(schema);
  if (type && !typeMatches(value, type)) {
    const label = path ? `参数 ${path}` : '工具参数';
    return { path, message: `${label} 应为${typeLabel(type)}，收到 ${preview(value)}` };
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    const matched = allowed.some((item) => Object.is(item, value) || (typeof item !== 'object' && String(item) === String(value)));
    if (!matched) {
      const label = path ? `参数 ${path}` : '工具参数';
      return { path, message: `${label} 应为 ${allowed.map((item) => String(item)).join('|')} 之一，收到 ${preview(value)}` };
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      const label = path ? `参数 ${path}` : '工具参数';
      return { path, message: `${label} 应不小于 ${schema.minimum}，收到 ${preview(value)}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      const label = path ? `参数 ${path}` : '工具参数';
      return { path, message: `${label} 应不大于 ${schema.maximum}，收到 ${preview(value)}` };
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      const label = path ? `参数 ${path}` : '工具参数';
      return { path, message: `${label} 长度应不小于 ${schema.minLength}，收到 ${preview(value)}` };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      const label = path ? `参数 ${path}` : '工具参数';
      return { path, message: `${label} 长度应不大于 ${schema.maxLength}，收到 ${preview(value)}` };
    }
  }

  if (isRecord(value)) {
    const properties = schemaProperties(schema);
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) {
        return { path: pathJoin(path, key), message: `缺少必填参数 ${pathJoin(path, key)}` };
      }
    }
    if (properties) {
      for (const [key, childSchemaValue] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const childSchema = asSchema(childSchemaValue);
        if (!childSchema) continue;
        const issue = validateSchema(value[key], childSchema, pathJoin(path, key));
        if (issue) return issue;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (properties && Object.hasOwn(properties, key)) continue;
        return { path: pathJoin(path, key), message: `参数 ${pathJoin(path, key)} 不被允许` };
      }
    }
  }

  if (Array.isArray(value) && asSchema(schema.items)) {
    const itemSchema = asSchema(schema.items)!;
    for (let index = 0; index < value.length; index += 1) {
      const issue = validateSchema(value[index], itemSchema, pathJoin(path, String(index)));
      if (issue) return issue;
    }
  }
  return null;
}

/** 公开的 schema 校验入口，供会话层和测试复用。 */
export function validateToolArguments(
  value: unknown,
  schema: unknown
): { ok: true } | { ok: false; path?: string; message: string } {
  const schemaRecord = asSchema(schema);
  if (!schemaRecord) return { ok: true };
  const issue = validateSchema(value, schemaRecord, '');
  if (issue) {
    return issue.path ? { ok: false, path: issue.path, message: issue.message } : { ok: false, message: issue.message };
  }
  return { ok: true };
}

interface UnwrappedCall {
  value: unknown;
  name?: string;
  repairs: string[];
}

function maybeUnwrap(value: Record<string, unknown>, schema: Record<string, unknown> | undefined): UnwrappedCall | null {
  const functionValue = isRecord(value.function) ? value.function : undefined;
  const nameValue = functionValue?.name ?? value.name ?? value.tool;
  const name = typeof nameValue === 'string' && nameValue.trim() ? nameValue.trim() : undefined;
  // 没有 name/tool/function 的普通参数对象不能当成信封，否则 `{arguments: ...}` 会被误拆。
  if (!name && !functionValue) return null;
  const argumentEntries: Array<[string, unknown]> = [];
  if (functionValue && Object.hasOwn(functionValue, 'arguments')) argumentEntries.push(['arguments', functionValue.arguments]);
  for (const key of ['arguments', 'args', 'parameters', 'input']) {
    if (Object.hasOwn(value, key)) argumentEntries.push([key, value[key]]);
  }
  if (argumentEntries.length === 0) return null;
  const properties = schema ? schemaProperties(schema) : undefined;
  const conflicts = argumentEntries.some(([key]) => properties && Object.hasOwn(properties, key));
  if (conflicts) return null;

  let current: unknown = argumentEntries[0]![1];
  const repairs = ['unwrapped tool call envelope'];
  if (typeof current === 'string') {
    const text = current;
    try {
      current = JSON.parse(text) as unknown;
    } catch {
      const parsed = parseCandidate(text, DEFAULT_MAX_CLOSURES);
      if (!parsed) return null;
      current = parsed.value;
      repairs.push(...parsed.repairs);
    }
  }
  return { value: current, ...(name ? { name } : {}), repairs };
}

/**
 * 修复单次工具调用参数。
 *
 * 参数 `schema` 可为 undefined（例如工具未注册）；此时只做结构修复，不猜字段。
 * `ctx.selection.id` 只用于补齐必填 `partId`。
 */
export function repairToolCall(raw: string, schema: unknown, ctx: RepairOptions = {}): RepairToolCallResult {
  const repairs: string[] = [];
  if (typeof raw !== 'string') {
    return {
      ok: false,
      repairs,
      error: { code: 'INVALID_JSON', message: '工具参数必须是字符串' }
    };
  }
  if (!raw.trim()) {
    return {
      ok: false,
      repairs,
      error: { code: 'NO_JSON', message: '工具参数为空' }
    };
  }

  const fenced = stripFence(raw);
  if (fenced.changed) repairs.push('stripped code fence');
  if (fenced.surrounding) repairs.push('stripped surrounding text');
  const extraction = extractFirstJson(fenced.text);
  if (!extraction) {
    return {
      ok: false,
      repairs,
      error: { code: 'NO_JSON', message: '没有找到 JSON 对象' }
    };
  }
  const before = fenced.text.slice(0, extraction.start).trim();
  const after = fenced.text.slice(extraction.end).trim();
  if (before || after) repairs.push('stripped surrounding text');
  if (extraction.balanced) {
    const remainder = fenced.text.slice(extraction.end);
    if (/\{/.test(remainder) || /\[/.test(remainder)) {
      repairs.push('kept first of multiple JSON values');
    }
  }

  const maxClosures = typeof ctx.maxClosures === 'number' && Number.isFinite(ctx.maxClosures)
    ? Math.max(0, Math.trunc(ctx.maxClosures))
    : DEFAULT_MAX_CLOSURES;
  const parsed = parseCandidate(extraction.candidate, maxClosures);
  if (!parsed) {
    if (!extraction.balanced || !scanBalance(extraction.candidate).balanced) {
      return {
        ok: false,
        repairs,
        error: {
          code: 'TRUNCATED_JSON',
          message: 'JSON 在结尾处不完整，补全所需层级超过限制或无法补全'
        }
      };
    }
    return {
      ok: false,
      repairs,
      error: { code: 'INVALID_JSON', message: 'JSON 格式不合法，无法安全修复' }
    };
  }
  repairs.push(...parsed.repairs);

  let value: unknown = parsed.value;
  let callName: string | undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        ok: false,
        repairs,
        error: { code: 'INVALID_JSON', message: '工具参数数组为空' }
      };
    }
    if (value.length > 1) repairs.push('kept first of multiple tool calls');
    value = value[0];
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      repairs,
      error: { code: 'INVALID_JSON', message: '工具参数必须是 JSON 对象' }
    };
  }

  const schemaRecord = asSchema(schema);
  const unwrapped = maybeUnwrap(value, schemaRecord);
  if (unwrapped) {
    value = unwrapped.value;
    callName = unwrapped.name;
    repairs.push(...unwrapped.repairs);
    if (!isRecord(value)) {
      return {
        ok: false,
        repairs,
        error: { code: 'INVALID_JSON', message: '工具调用信封里的 arguments 必须是 JSON 对象' }
      };
    }
  }

  const fixed = schemaRecord
    ? applySchemaFixes(value, schemaRecord, '', repairs, ctx)
    : value;
  if (!isRecord(fixed)) {
    return {
      ok: false,
      repairs,
      error: { code: 'SCHEMA_INVALID', message: '工具参数必须是 JSON 对象' }
    };
  }

  const validation = validateToolArguments(fixed, schemaRecord);
  if (!validation.ok) {
    return {
      ok: false,
      repairs,
      error: {
        code: 'SCHEMA_INVALID',
        message: validation.message,
        ...(validation.path ? { path: validation.path } : {})
      }
    };
  }

  return {
    ok: true,
    repairs,
    call: { args: fixed, ...(callName ? { name: callName } : {}) }
  };
}

