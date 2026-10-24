// 诊断与错误摘要：纯函数 + 有界内存环形缓冲，主进程与渲染进程都可安全引用。
// 这里绝不保存用户输入正文；错误信息、上下文和堆栈都会先脱敏并截断。

export interface DiagnosticErrorRecord {
  at: string;
  code: string;
  operation: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface DiagnosisReportInput {
  generatedAt?: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion?: string;
  platform: string;
  arch?: string;
  userDataPath: string;
  webgl: { available: boolean; version?: string | null; renderer?: string | null };
  dataPackVersion: string;
  packCount?: number;
  packMetrics?: PackLoadMetrics;
  packStats?: PackStatsSummary;
  kbDocs: number;
  kbChunks: number;
  kbBytes?: number;
  auditPath?: string;
  auditBytes: number;
  errors?: readonly DiagnosticErrorRecord[];
}

export interface PackLoadMetrics {
  packLoadMs: number;
  loadedPacks: number;
  partsLoaded: number;
  searchMs: number;
  packCount?: number;
}

/** 库统计摘要，与 `npm run packs:stats` 的总计口径一致。 */
export interface PackStatsSummary {
  packs: number;
  parts: number;
  activeParts: number;
  aliases?: number;
  uniqueModels: number;
  categories?: number;
  errors: number;
  warnings: number;
}

export interface DiagnosisReport {
  schemaVersion: 1;
  kind: 'automation-cad-diagnosis';
  generatedAt: string;
  app: {
    version: string;
    electron: string;
    node: string;
    chrome?: string;
    platform: string;
    arch?: string;
  };
  userDataPath: string;
  webgl: { available: boolean; version?: string; renderer?: string };
  dataPack: { version: string; count: number };
  packMetrics: PackLoadMetrics;
  packStats?: PackStatsSummary;
  kb: { docs: number; chunks: number; bytes?: number };
  audit: { path?: string; bytes: number };
  recentErrors: DiagnosticErrorRecord[];
}

export interface CrashReportInput {
  error: unknown;
  operation?: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  occurredAt?: string;
  code?: string;
}

export interface CrashReport {
  schemaVersion: 1;
  kind: 'automation-cad-last-crash';
  at: string;
  operation: string;
  code: string;
  message: string;
  stack: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
}

const SECRET_KEY_PATTERN = /(api[-_]?key|token|password|passwd|secret|authorization|cookie|design[-_]?key)/i;
const MASK = '****';
const ERROR_LIMIT = 100;
const MAX_MESSAGE_CHARS = 1200;
const MAX_STACK_CHARS = 8000;
const errors: DiagnosticErrorRecord[] = [];
let currentOperation = 'startup';

/** 文本脱敏；覆盖项目内常见的 sk-/Bearer/key=value 形式。 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{4}[A-Za-z0-9_-]*/g, (matched) => `${matched.slice(0, 6)}${MASK}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, `$1${MASK}`)
    .replace(/((?:api[-_]?key|token|password|passwd|secret|design[-_]?key)\s*[=:]\s*)["']?[^\s"',;}]+/gi, `$1${MASK}`)
    .replace(/((?:x-design-key|authorization)["']?\s*[:=]\s*)["']?[^\s"',;}]+/gi, `$1${MASK}`);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[截断 ${value.length - limit} 字符]`;
}

/** 递归脱敏与截断；数组最多 20 项，避免诊断文件被大对象撑爆。 */
export function sanitizeForDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[深度截断]';
  if (typeof value === 'string') return truncate(redactSensitiveText(value), MAX_MESSAGE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => sanitizeForDiagnostics(item, depth + 1));
    return value.length > 20 ? [...head, `[其余 ${value.length - 20} 项省略]`] : head;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? MASK : sanitizeForDiagnostics(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function setDiagnosticOperation(operation: string): void {
  currentOperation = operation.trim() || 'unknown';
}

export function currentDiagnosticOperation(): string {
  return currentOperation;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return '未知错误（无法字符串化）';
  }
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string'
    ? truncate(redactSensitiveText(error.stack), MAX_STACK_CHARS)
    : undefined;
}

/**
 * 记录一个被捕获的异常。所有 catch 分支应至少调用一次，调用方仍负责返回
 * 可操作错误或降级结果，不能用空结果静默吞掉。
 */
export function recordDiagnosticError(
  code: string,
  error: unknown,
  context: Record<string, unknown> = {}
): DiagnosticErrorRecord {
  const stack = errorStack(error);
  const record: DiagnosticErrorRecord = {
    at: new Date().toISOString(),
    code: (code.trim() || 'UNKNOWN').toUpperCase(),
    operation: currentOperation,
    message: truncate(redactSensitiveText(errorMessage(error)), MAX_MESSAGE_CHARS),
    ...(stack ? { stack } : {}),
    ...(Object.keys(context).length > 0
      ? { context: sanitizeForDiagnostics(context) as Record<string, unknown> }
      : {})
  };
  errors.push(record);
  if (errors.length > ERROR_LIMIT) errors.splice(0, errors.length - ERROR_LIMIT);
  try {
    console.error(`[diagnostic] ${JSON.stringify(record)}`);
  } catch {
    // console 本身不可用时不能再次抛错；环形缓冲仍然保留。
  }
  return record;
}

export function recentDiagnosticErrors(limit = 20): DiagnosticErrorRecord[] {
  return errors.slice(-Math.max(0, Math.min(ERROR_LIMIT, Math.trunc(limit)))).map((record) => ({
    ...record,
    ...(record.context ? { context: sanitizeForDiagnostics(record.context) as Record<string, unknown> } : {})
  }));
}

export function clearDiagnosticErrors(): void {
  errors.splice(0, errors.length);
}

function optionalString(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? redactSensitiveText(value.trim()) : undefined;
}

export function buildDiagnosisReport(input: DiagnosisReportInput): DiagnosisReport {
  const webglVersion = optionalString(input.webgl.version);
  const webglRenderer = optionalString(input.webgl.renderer);
  const webgl = {
    available: input.webgl.available === true,
    ...(webglVersion ? { version: webglVersion } : {}),
    ...(webglRenderer ? { renderer: webglRenderer } : {})
  };
  return {
    schemaVersion: 1,
    kind: 'automation-cad-diagnosis',
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    app: {
      version: redactSensitiveText(input.appVersion),
      electron: redactSensitiveText(input.electronVersion),
      node: redactSensitiveText(input.nodeVersion),
      ...(input.chromeVersion ? { chrome: redactSensitiveText(input.chromeVersion) } : {}),
      platform: redactSensitiveText(input.platform),
      ...(input.arch ? { arch: redactSensitiveText(input.arch) } : {})
    },
    userDataPath: redactSensitiveText(input.userDataPath),
    webgl,
    dataPack: {
      version: redactSensitiveText(input.dataPackVersion || 'unknown'),
      count: Math.max(0, Math.trunc(input.packCount ?? 0))
    },
    packMetrics: {
      packLoadMs: Math.max(0, Number(input.packMetrics?.packLoadMs ?? 0)),
      loadedPacks: Math.max(0, Math.trunc(input.packMetrics?.loadedPacks ?? 0)),
      partsLoaded: Math.max(0, Math.trunc(input.packMetrics?.partsLoaded ?? 0)),
      searchMs: Math.max(0, Number(input.packMetrics?.searchMs ?? 0)),
      packCount: Math.max(0, Math.trunc(input.packMetrics?.packCount ?? input.packCount ?? 0))
    },
    ...(input.packStats
      ? {
          packStats: {
            packs: Math.max(0, Math.trunc(input.packStats.packs)),
            parts: Math.max(0, Math.trunc(input.packStats.parts)),
            activeParts: Math.max(0, Math.trunc(input.packStats.activeParts)),
            ...(typeof input.packStats.aliases === 'number' ? { aliases: Math.max(0, Math.trunc(input.packStats.aliases)) } : {}),
            uniqueModels: Math.max(0, Math.trunc(input.packStats.uniqueModels)),
            ...(typeof input.packStats.categories === 'number' ? { categories: Math.max(0, Math.trunc(input.packStats.categories)) } : {}),
            errors: Math.max(0, Math.trunc(input.packStats.errors)),
            warnings: Math.max(0, Math.trunc(input.packStats.warnings))
          }
        }
      : {}),
    kb: {
      docs: Math.max(0, Math.trunc(input.kbDocs)),
      chunks: Math.max(0, Math.trunc(input.kbChunks)),
      ...(typeof input.kbBytes === 'number' ? { bytes: Math.max(0, Math.trunc(input.kbBytes)) } : {})
    },
    audit: {
      ...(input.auditPath ? { path: redactSensitiveText(input.auditPath) } : {}),
      bytes: Math.max(0, Math.trunc(input.auditBytes))
    },
    recentErrors: (input.errors ?? recentDiagnosticErrors(20)).slice(0, 20).map((record) => ({
      ...record,
      message: truncate(redactSensitiveText(record.message), MAX_MESSAGE_CHARS),
      ...(record.stack ? { stack: truncate(redactSensitiveText(record.stack), MAX_STACK_CHARS) } : {}),
      ...(record.context
        ? { context: sanitizeForDiagnostics(record.context) as Record<string, unknown> }
        : {})
    }))
  };
}

export function formatDiagnosisReport(report: DiagnosisReport): string {
  const webgl = report.webgl.available
    ? `可用${report.webgl.version ? ` (${report.webgl.version})` : ''}`
    : '不可用（将使用降级面板）';
  return [
    'AutomationCAD 诊断报告',
    `版本：应用 ${report.app.version} · Electron ${report.app.electron} · Node ${report.app.node} · ${report.app.platform}`,
    `userData：${report.userDataPath}`,
    `WebGL：${webgl}`,
    `数据包：${report.dataPack.version}（${report.dataPack.count} 个）`,
    `包加载：已加载 ${report.packMetrics.loadedPacks}/${report.packMetrics.packCount} · 零件 ${report.packMetrics.partsLoaded} · 加载 ${report.packMetrics.packLoadMs} ms · 搜索 ${report.packMetrics.searchMs} ms`,
    ...(report.packStats
      ? [`包统计：${report.packStats.packs} 个包 · ${report.packStats.parts} 条（实型号 ${report.packStats.activeParts}）· 唯一型号 ${report.packStats.uniqueModels} · 分类 ${report.packStats.categories ?? 0} · 错误 ${report.packStats.errors} · 警告 ${report.packStats.warnings}`]
      : []),
    `知识库：${report.kb.docs} 份文档 / ${report.kb.chunks} 段`,
    `审计文件：${report.audit.path ?? '(未配置)'} · ${report.audit.bytes} 字节`,
    `最近错误：${report.recentErrors.length} 条`
  ].join('\n');
}

export function buildCrashReport(input: CrashReportInput): CrashReport {
  const operation = input.operation?.trim() || currentOperation || 'unknown';
  return {
    schemaVersion: 1,
    kind: 'automation-cad-last-crash',
    at: input.occurredAt ?? new Date().toISOString(),
    operation: redactSensitiveText(operation),
    code: redactSensitiveText(input.code?.trim() || 'UNCAUGHT_EXCEPTION'),
    message: truncate(redactSensitiveText(errorMessage(input.error)), MAX_MESSAGE_CHARS),
    stack: errorStack(input.error) ?? '(无堆栈)',
    appVersion: redactSensitiveText(input.appVersion),
    electronVersion: redactSensitiveText(input.electronVersion),
    nodeVersion: redactSensitiveText(input.nodeVersion),
    platform: redactSensitiveText(input.platform)
  };
}
