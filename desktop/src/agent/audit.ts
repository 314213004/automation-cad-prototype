/**
 * 智能体审计（P7-A）
 *
 * 每次工具调用落一行 JSON（NDJSON）：时间、工具、结果码、参数摘要。
 * 这里刻意不碰文件系统：写入由主进程注入（appendFileSync），模块本身纯函数，
 * 便于单测「凭据掩码」这类最容易出错的地方。
 */

export interface AgentAuditRecord {
  tool: string;
  ok: boolean;
  code?: string;
  /** 调用来源：模型工具调用 / 离线规则路由 / 外部 RPC / MCP */
  source?: 'llm' | 'offline' | 'rpc' | 'mcp' | 'plan' | 'recipe';
  args?: Record<string, unknown>;
  message?: string;
  /** 工具执行耗时（毫秒）；旧记录没有该字段时按「—」展示。 */
  elapsedMs?: number;
  /** 本次调用因参数修复失败而重试的次数（0 = 未重试）。 */
  retries?: number;
  /** 重试原因（失败时的首个 schema/解析错误）。 */
  reason?: string;
  /** 实际应用的参数修复项，按发生顺序。 */
  repairs?: string[];
  /** 策略事件命中的用户原短语（如 BYPASS_ATTEMPT）。 */
  phrase?: string;
}

export interface AgentAuditEntry extends AgentAuditRecord {
  at: string;
  args?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|token|password|passwd|secret|authorization|cookie|design[-_]?key)/i;
const MASK = '****';

/** 把裸文本里的密钥抹掉：sk-xxx、Bearer xxx、key=xxx、X-Design-Key: xxx。 */
export function maskSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{4}[A-Za-z0-9_-]*/g, (matched) => `${matched.slice(0, 6)}${MASK}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${MASK}`)
    .replace(/((?:api[-_]?key|token|password|passwd|secret|design[-_]?key)\s*[=:]\s*)["']?[^\s"',;}]+/gi, `$1${MASK}`)
    .replace(/((?:x-design-key|authorization)["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi, `$1${MASK}`);
}

/** 按字段名递归脱敏；数组只保留前 20 项，避免审计行被大参数撑爆。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[深度截断]';
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => redactValue(item, depth + 1));
    return value.length > 20 ? [...head, `[其余 ${value.length - 20} 项省略]`] : head;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? MASK : redactValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

export function formatAuditLine(record: AgentAuditRecord, at: Date = new Date()): string {
  const entry: AgentAuditEntry = {
    at: at.toISOString(),
    tool: record.tool,
    ok: record.ok,
    ...(record.code ? { code: record.code } : {}),
    ...(record.source ? { source: record.source } : {}),
    ...(typeof record.elapsedMs === 'number' && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0
      ? { elapsedMs: Math.round(record.elapsedMs) }
      : {}),
    ...(typeof record.retries === 'number' && Number.isInteger(record.retries) && record.retries >= 0
      ? { retries: record.retries }
      : {}),
    ...(record.reason ? { reason: maskSecrets(record.reason) } : {}),
    ...(Array.isArray(record.repairs) && record.repairs.length > 0
      ? { repairs: record.repairs.map((item) => maskSecrets(item)) }
      : {}),
    ...(record.phrase ? { phrase: maskSecrets(record.phrase) } : {}),
    ...(record.message ? { message: maskSecrets(record.message) } : {}),
    ...(record.args ? { args: redactValue(record.args) as Record<string, unknown> } : {})
  };
  return JSON.stringify(entry);
}

export interface AuditLogOptions {
  /** 每行写一次的副作用；主进程传 appendFileSync，测试传数组 push。 */
  write: (line: string) => void;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface AuditLog {
  record: (record: AgentAuditRecord) => void;
  entries: AgentAuditEntry[];
}

/** 审计写入不允许影响主流程：写失败只回调，不抛。 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
  const entries: AgentAuditEntry[] = [];
  const now = options.now ?? (() => new Date());
  return {
    entries,
    record(record: AgentAuditRecord): void {
      const at = now();
      try {
        const line = formatAuditLine(record, at);
        options.write(line);
        entries.push(JSON.parse(line) as AgentAuditEntry);
      } catch (error) {
        options.onError?.(error);
      }
    }
  };
}

export function parseAuditLines(text: string): AgentAuditEntry[] {
  const entries: AgentAuditEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AgentAuditEntry;
      if (parsed && typeof parsed.tool === 'string' && typeof parsed.at === 'string') entries.push(parsed);
    } catch {
      // 损坏行跳过，不因一行脏数据丢掉整份审计。
    }
  }
  return entries;
}

export interface AuditSummary {
  total: number;
  failed: number;
  tools: Record<string, number>;
  lastAt: string | null;
}

export function summarizeAudit(entries: AgentAuditEntry[]): AuditSummary {
  const tools: Record<string, number> = {};
  let failed = 0;
  for (const entry of entries) {
    tools[entry.tool] = (tools[entry.tool] ?? 0) + 1;
    if (!entry.ok) failed += 1;
  }
  return {
    total: entries.length,
    failed,
    tools,
    lastAt: entries.length > 0 ? entries[entries.length - 1]!.at : null
  };
}
