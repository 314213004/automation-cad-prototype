/**
 * 成本报告的 Agent 落盘导出（PDF / CSV）。
 *
 * 这里是「一句话出报价单」的纯逻辑层：取数与计算复用 `computeCostReport`，渲染复用
 * `renderCostReportHtml` / `costReportCsv`，文件命名与冲突策略集中在 `planExportName`。
 * 主进程 `export:costFile` IPC 与单测共用同一份命名规则，避免「测试一套、落盘一套」。
 */
import { join, resolve, sep } from 'node:path';
import { computeCostReport, CostToolError, type CostToolDeps } from './agent.ts';
import { costReportCsv, renderCostReportHtml, type CostReportProject } from './report.ts';
import type { CostReport } from './engine.ts';
import { exportTimestamp, sanitizeFileName } from '../shared/filename.ts';

export { sanitizeCostFileName, costExportTimestamp } from '../shared/filename.ts';

export type CostExportFormat = 'pdf' | 'csv';

export interface CostExportSavePayload {
  format: CostExportFormat;
  fileName?: string;
  overwrite: boolean;
  /** CSV 为字符串；PDF 为打印后的字节。 */
  data: string | Uint8Array;
  suggestedName: string;
}

export interface CostExportSaveResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  code?: string;
  message?: string;
}

export interface CostExportDeps extends CostToolDeps {
  /** 项目名（缺省取当前 CAD 文件名，再缺省「机台」）。 */
  projectName?: string;
  /** PDF 打印管线；CSV 导出不会调用。 */
  renderPdf?: (html: string) => Promise<Uint8Array>;
  /** 落盘桥；生产环境走 window.desktop.exportCostFile，单测注入假对象。 */
  saveFile: (payload: CostExportSavePayload) => Promise<CostExportSaveResult>;
  /** 文件名时间戳基准；缺省读取 args.now，再缺省当前时间。 */
  now?: Date | string | number;
}

export interface CostExportSuccess {
  ok: true;
  path: string;
  bytes: number;
  format: CostExportFormat;
  lines: number;
  grand: number;
}

export class CostExportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CostExportError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new CostExportError(code, message);
}

function stripKnownExtension(value: string): string {
  return value.replace(/\.(pdf|csv)$/i, '');
}

export interface PlanExportNameOptions {
  directory: string;
  format: CostExportFormat;
  fileName?: unknown;
  suggestedName?: unknown;
  overwrite?: boolean;
  exists?: (path: string) => boolean;
  /** 最终文件名上限（含扩展名），默认 80。 */
  maxLength?: number;
}

export interface PlannedExportName {
  name: string;
  path: string;
}

/**
 * 计算最终落盘路径。
 *
 * - 文件名只允许纯文件名：非法字符被删除，路径分隔符/`..` 不会逃出 directory；
 * - 扩展名按 format 强制为 `.pdf` / `.csv`；
 * - `overwrite=false` 时自动追加 ` (1)`、` (2)`…；
 * - 最终文件名（含扩展名）不超过 maxLength。
 */
export function planExportName(options: PlanExportNameOptions): PlannedExportName {
  const directory = resolve(options.directory);
  const extension = `.${options.format}`;
  const maxLength = Math.max(extension.length + 1, Math.trunc(options.maxLength ?? 80));
  const maxBase = maxLength - extension.length;
  const overwrite = options.overwrite === true;
  const exists = options.exists ?? (() => false);

  const rawSuggestion = typeof options.suggestedName === 'string' ? options.suggestedName : '';
  const fromSuggestion = sanitizeFileName(stripKnownExtension(rawSuggestion), maxBase);
  const requested = options.fileName === undefined || options.fileName === null
    ? ''
    : sanctionFileNameInput(options.fileName);
  const base = sanitizeFileName(stripKnownExtension(requested), maxBase) || fromSuggestion || '成本报告';

  const withSuffix = (suffix: string): string => {
    const room = Math.max(1, maxBase - suffix.length);
    const head = sanitizeFileName(base, room) || '成本报告';
    return `${head}${suffix}${extension}`;
  };

  let name = withSuffix('');
  if (!overwrite) {
    let index = 1;
    while (exists(join(directory, name))) {
      name = withSuffix(` (${index})`);
      index += 1;
      if (index > 9999) fail('WRITE_FAILED', '同名文件过多，无法生成不冲突的文件名');
    }
  }

  const target = resolve(directory, name);
  if (target !== join(directory, name) || !target.startsWith(directory + sep)) {
    fail('WRITE_FAILED', '文件名不合法：不能写入导出目录之外');
  }
  return { name, path: target };
}

function sanctionFileNameInput(value: unknown): string {
  if (typeof value !== 'string') {
    fail('INVALID_ARGUMENT', 'fileName 必须是字符串');
  }
  return value;
}

function parseFormat(value: unknown): CostExportFormat {
  if (value === 'pdf' || value === 'csv') return value;
  fail('UNSUPPORTED_FORMAT', '导出格式仅支持 pdf 或 csv');
}

function resolveNow(args: Record<string, unknown>, deps: CostExportDeps): Date {
  const raw = deps.now ?? args.now;
  if (raw !== undefined && raw !== null) {
    const date = raw instanceof Date ? raw : new Date(raw as string | number);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function projectOf(name: string, currency: string, now: Date): CostReportProject {
  return {
    name: name || '机台',
    code: 'COST-EST',
    author: 'AutomationCAD',
    date: now.toISOString().slice(0, 10),
    currency
  };
}

function saveFailure(result: CostExportSaveResult): never {
  const code = result.code === 'DENIED' ? 'DENIED' : 'WRITE_FAILED';
  fail(code, result.message?.trim() || '成本报告写入失败，请检查导出目录权限');
}

/**
 * 计算并落盘成本报告。
 *
 * 与 `run_cost_report` 共用 `computeCostReport`；PDF 走 A4 纵向 HTML，CSV 带 UTF-8 BOM。
 * 返回 `{ok:true,path,bytes,format,lines,grand}`，失败抛 `CostExportError`（中文 message）。
 */
export async function buildCostExport(
  args: Record<string, unknown>,
  deps: CostExportDeps
): Promise<CostExportSuccess> {
  if (!isRecord(args)) fail('INVALID_ARGUMENT', '工具入参必须是对象');
  const format = parseFormat(args.format);
  if (args.fileName !== undefined && args.fileName !== null && typeof args.fileName !== 'string') {
    fail('INVALID_ARGUMENT', 'fileName 必须是字符串');
  }
  if (args.overwrite !== undefined && args.overwrite !== null && typeof args.overwrite !== 'boolean') {
    fail('INVALID_ARGUMENT', 'overwrite 必须是布尔值');
  }
  const overwrite = args.overwrite === true;

  let computation;
  try {
    computation = computeCostReport(args, {
      ...(deps.sceneBom !== undefined ? { sceneBom: deps.sceneBom } : {}),
      ...(deps.loadBuiltinPricebook ? { loadBuiltinPricebook: deps.loadBuiltinPricebook } : {})
    });
  } catch (error) {
    if (error instanceof CostToolError) fail(error.code, error.message);
    throw error;
  }

  const { report } = computation;
  const now = resolveNow(args, deps);
  const projectName = deps.projectName?.trim() || '机台';
  const suggestedName = `成本报告-${projectName}-${exportTimestamp(now)}.${format}`;

  let data: string | Uint8Array;
  if (format === 'csv') {
    data = costReportCsv(report);
  } else {
    if (!deps.renderPdf) fail('WRITE_FAILED', 'PDF 渲染管线不可用，请改用 CSV 或重试');
    const html = renderCostReportHtml(projectOf(projectName, computation.pricebook.currency, now), report);
    try {
      data = await deps.renderPdf(html);
    } catch (error) {
      fail('WRITE_FAILED', `PDF 渲染失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!(data instanceof Uint8Array) || data.byteLength === 0) {
      fail('WRITE_FAILED', 'PDF 渲染结果为空');
    }
  }

  let saved: CostExportSaveResult;
  try {
    saved = await deps.saveFile({
      format,
      ...(typeof args.fileName === 'string' && args.fileName.trim() ? { fileName: args.fileName.trim() } : {}),
      overwrite,
      data,
      suggestedName
    });
  } catch (error) {
    fail('WRITE_FAILED', `成本报告写入失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!saved || saved.ok !== true) saveFailure(saved ?? { ok: false });
  if (typeof saved.path !== 'string' || !saved.path.trim()) {
    fail('WRITE_FAILED', '成本报告写入失败：未返回文件路径');
  }
  const bytes = typeof saved.bytes === 'number' && Number.isFinite(saved.bytes) && saved.bytes >= 0
    ? saved.bytes
    : typeof data === 'string'
      ? new TextEncoder().encode(data).byteLength
      : data.byteLength;

  return {
    ok: true,
    path: saved.path,
    bytes,
    format,
    lines: report.lines.length,
    grand: report.totals.grand
  };
}
