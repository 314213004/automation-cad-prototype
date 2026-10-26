// FreeCAD 后台作业协议：内核无关 JSON，与 build123d sidecar 的 ops 协议同一风格。
// 纯函数层：无 DOM、无 node:fs、无 child_process；主进程运行器与单测共用。
import { sha256Hex } from '../plcgen/hash.ts';
import { validateHoleSpecs, type DrawingHoleSpec } from './holes.ts';

export type { DrawingHoleSpec } from './holes.ts';

export const DRAWING_JOB_PROTOCOL = 'automationcad.drawing-job/1';
export const DRAWING_RESULT_PROTOCOL = 'automationcad.drawing-result/1';
/** 与 spike/freecad/techdraw_job.py 的 SCRIPT_VERSION 保持一致；变更会使已出图纸全部过期。 */
export const TECHDRAW_SCRIPT_VERSION = '1.1.0';
export const DRAWING_PROGRESS_PREFIX = '@@ACAD ';

export const DRAWING_FORMATS = ['pdf', 'dxf', 'svg', 'fcstd'] as const;
export type DrawingFormat = typeof DRAWING_FORMATS[number];
export const DRAWING_PAPERS = ['auto', 'A4', 'A3'] as const;
export type DrawingPaper = typeof DRAWING_PAPERS[number];

export const MAX_DRAWING_PARTS = 50;
const SCALE_PATTERN = /^(auto|\d+(\.\d+)?:\d+(\.\d+)?)$/;
const FILE_STEM_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DrawingJobPart {
  /** 图纸身份：同 partId 的多个实例共用一张图 */
  partId: string;
  /** 输出文件名主干（主进程按 partKey 生成，只含安全字符） */
  fileStem: string;
  name: string;
  material: string;
  drawingNo: string;
  quantity: number;
  /** 输入 STEP 的绝对路径（主进程临时目录内） */
  step: string;
  scale?: string;
  paper?: DrawingPaper;
  /**
   * 可选（协议 /1 向后兼容扩展）：特征树里的孔语义。缺省 = 旧主进程/外部 STEP，脚本按圆柱面几何识别兜底；
   * 空数组 = 特征树声明无孔（脚本仍会把几何里多出的孔按「几何识别」补上并给出警告）。
   */
  holes?: DrawingHoleSpec[];
}

export interface DrawingJobOptions {
  formats: DrawingFormat[];
  paper: DrawingPaper;
  scale: string;
  iso: boolean;
  hiddenLines: boolean;
  hlrTimeoutSec: number;
}

export interface DrawingTitleBlock {
  designer: string;
  company: string;
  date: string;
}

export interface DrawingJob {
  protocol: typeof DRAWING_JOB_PROTOCOL;
  jobId: string;
  kind: 'techdraw';
  outputDir: string;
  options: DrawingJobOptions;
  titleBlock: DrawingTitleBlock;
  parts: DrawingJobPart[];
}

export interface DrawingPartResult {
  partId: string;
  ok: boolean;
  files: Partial<Record<DrawingFormat, string>>;
  warnings: string[];
  error?: string;
  paper?: string;
  scale?: string;
  bbox?: [number, number, number];
  dimensions?: { length: number; width: number; height: number };
  views?: string[];
  pdfFallback?: boolean;
  elapsedMs?: number;
  holes?: DrawingHoleSummary;
}

/** 结果里的孔标注摘要（脚本 1.1.0 起）：来源、合并后的标注文本、孔位尺寸方式、剖视。 */
export interface DrawingHoleSummary {
  source: 'features' | 'geometry' | 'mixed' | 'none';
  callouts: string[];
  /** dims = 视图上标孔位尺寸；table = 过密退化为孔位表；none = 无孔 */
  mode: 'dims' | 'table' | 'none';
  section?: string;
}

export interface DrawingJobResult {
  ok: boolean;
  jobId: string | null;
  freecadVersion?: string;
  scriptVersion?: string;
  error?: string;
  parts: DrawingPartResult[];
  elapsedMs?: number;
}

export type DrawingProgressEvent =
  | { event: 'part-start'; index: number; total: number; partId: string }
  | { event: 'part-done'; index: number; total: number; partId: string; ok: boolean }
  | { event: 'done'; ok: boolean };

export interface BuildDrawingJobInput {
  jobId: string;
  outputDir: string;
  parts: DrawingJobPart[];
  options?: Partial<DrawingJobOptions>;
  titleBlock?: Partial<DrawingTitleBlock>;
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** 本地日期 YYYY-MM-DD（标题栏日期按用户时区，不用 UTC）。 */
export function localDate(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function defaultDrawingOptions(): DrawingJobOptions {
  return { formats: ['pdf', 'dxf', 'svg'], paper: 'auto', scale: 'auto', iso: true, hiddenLines: true, hlrTimeoutSec: 60 };
}

export function normalizeDrawingOptions(value: unknown): DrawingJobOptions {
  const base = defaultDrawingOptions();
  if (!isRecord(value)) return base;
  const formats = Array.isArray(value.formats)
    ? [...new Set(value.formats.filter((item): item is DrawingFormat =>
      typeof item === 'string' && (DRAWING_FORMATS as readonly string[]).includes(item)))]
    : base.formats;
  const paper = typeof value.paper === 'string' && (DRAWING_PAPERS as readonly string[]).includes(value.paper)
    ? value.paper as DrawingPaper
    : base.paper;
  const scale = typeof value.scale === 'string' && SCALE_PATTERN.test(value.scale.trim()) ? value.scale.trim() : base.scale;
  const timeout = typeof value.hlrTimeoutSec === 'number' && Number.isFinite(value.hlrTimeoutSec)
    ? Math.min(600, Math.max(5, Math.round(value.hlrTimeoutSec)))
    : base.hlrTimeoutSec;
  return {
    formats: formats.length > 0 ? formats : base.formats,
    paper,
    scale,
    iso: value.iso !== false,
    hiddenLines: value.hiddenLines !== false,
    hlrTimeoutSec: timeout
  };
}

export function buildDrawingJob(input: BuildDrawingJobInput): DrawingJob {
  const titleBlock: DrawingTitleBlock = {
    designer: cleanText(input.titleBlock?.designer, 40),
    company: cleanText(input.titleBlock?.company, 60),
    date: typeof input.titleBlock?.date === 'string' && DATE_PATTERN.test(input.titleBlock.date)
      ? input.titleBlock.date
      : localDate(input.now)
  };
  const job: DrawingJob = {
    protocol: DRAWING_JOB_PROTOCOL,
    jobId: input.jobId,
    kind: 'techdraw',
    outputDir: input.outputDir,
    options: normalizeDrawingOptions(input.options ?? {}),
    titleBlock,
    parts: input.parts.map((part) => ({
      partId: part.partId,
      fileStem: part.fileStem,
      name: cleanText(part.name, 60) || part.partId,
      material: cleanText(part.material, 40),
      drawingNo: cleanText(part.drawingNo, 40),
      quantity: Number.isInteger(part.quantity) && part.quantity > 0 ? part.quantity : 1,
      step: part.step,
      ...(part.scale && SCALE_PATTERN.test(part.scale) ? { scale: part.scale } : {}),
      ...(part.paper && (DRAWING_PAPERS as readonly string[]).includes(part.paper) ? { paper: part.paper } : {}),
      ...(Array.isArray(part.holes) ? { holes: part.holes.map((spec) => ({ ...spec, positions: spec.positions.map(([x, y]) => [x, y] as [number, number]) })) } : {})
    }))
  };
  const errors = validateDrawingJob(job);
  if (errors.length > 0) throw new Error(`工程图作业无效：${errors.join('；')}`);
  return job;
}

/** 返回全部中文错误，不抛异常；与 Python 侧 validate_job 同口径（更严格）。 */
export function validateDrawingJob(job: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(job)) return ['作业必须是对象'];
  if (job.protocol !== DRAWING_JOB_PROTOCOL) errors.push(`协议不匹配：期望 ${DRAWING_JOB_PROTOCOL}`);
  if (job.kind !== 'techdraw') errors.push('kind 必须是 techdraw');
  if (typeof job.jobId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(job.jobId)) errors.push('jobId 非法');
  if (typeof job.outputDir !== 'string' || !job.outputDir.trim()) errors.push('outputDir 缺失');
  if (!isRecord(job.options)) errors.push('options 缺失');
  else {
    const options = job.options;
    if (!Array.isArray(options.formats) || options.formats.length === 0
      || !options.formats.every((item) => (DRAWING_FORMATS as readonly unknown[]).includes(item))) {
      errors.push('options.formats 非法');
    }
    if (!(DRAWING_PAPERS as readonly unknown[]).includes(options.paper)) errors.push('options.paper 非法');
    if (typeof options.scale !== 'string' || !SCALE_PATTERN.test(options.scale)) errors.push('options.scale 非法');
  }
  if (!isRecord(job.titleBlock)) errors.push('titleBlock 缺失');
  if (!Array.isArray(job.parts) || job.parts.length === 0) {
    errors.push('parts 必须是非空数组');
    return errors;
  }
  if (job.parts.length > MAX_DRAWING_PARTS) errors.push(`单次作业最多 ${MAX_DRAWING_PARTS} 个零件`);
  const ids = new Set<string>();
  const stems = new Set<string>();
  job.parts.forEach((part, index) => {
    const label = `第 ${index + 1} 个零件`;
    if (!isRecord(part)) {
      errors.push(`${label}不是对象`);
      return;
    }
    if (typeof part.partId !== 'string' || !part.partId.trim() || part.partId.length > 64) {
      errors.push(`${label}缺少 partId`);
    } else if (ids.has(part.partId)) errors.push(`partId 重复：${part.partId}`);
    else ids.add(part.partId);
    if (typeof part.fileStem !== 'string' || !FILE_STEM_PATTERN.test(part.fileStem)) errors.push(`${label} fileStem 非法`);
    else if (stems.has(part.fileStem.toLowerCase())) errors.push(`${label} fileStem 重复：${part.fileStem}`);
    else stems.add(part.fileStem.toLowerCase());
    if (typeof part.step !== 'string' || !/\.(step|stp)$/i.test(part.step)) errors.push(`${label} step 必须是 .step/.stp 路径`);
    if (typeof part.quantity !== 'number' || !Number.isInteger(part.quantity) || part.quantity < 1) errors.push(`${label} quantity 非法`);
    errors.push(...validateHoleSpecs(part.holes, label));
  });
  return errors;
}

export function serializeDrawingJob(job: DrawingJob): string {
  return `${JSON.stringify(job, null, 2)}\n`;
}

function safeFileName(value: unknown, stem: string, format: DrawingFormat): string | null {
  if (typeof value !== 'string') return null;
  const expected = format === 'fcstd' ? `${stem}.FCStd` : `${stem}.${format}`;
  // 结果只能引用作业约定的同名文件：拒绝任何路径分隔符、上级目录或别名
  return value === expected ? value : null;
}

function finiteTriple(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * 解析 FreeCAD 作业写出的 result.json：只采信与作业零件一一对应、文件名合规的条目。
 * 作业里有、结果里缺的零件按失败处理；结果里多出来的零件丢弃。
 */
export function parseDrawingJobResult(raw: unknown, job: DrawingJob): DrawingJobResult {
  if (!isRecord(raw) || raw.protocol !== DRAWING_RESULT_PROTOCOL) {
    return {
      ok: false,
      jobId: job.jobId,
      error: 'FreeCAD 作业结果格式无效',
      parts: job.parts.map((part) => ({ partId: part.partId, ok: false, files: {}, warnings: [], error: '未返回结果' }))
    };
  }
  if (raw.jobId !== job.jobId) {
    return {
      ok: false,
      jobId: job.jobId,
      error: 'FreeCAD 作业结果与作业编号不匹配',
      parts: job.parts.map((part) => ({ partId: part.partId, ok: false, files: {}, warnings: [], error: '结果不匹配' }))
    };
  }
  const reported = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.parts)) {
    for (const item of raw.parts) {
      if (isRecord(item) && typeof item.partId === 'string' && !reported.has(item.partId)) reported.set(item.partId, item);
    }
  }
  const parts: DrawingPartResult[] = job.parts.map((part) => {
    const item = reported.get(part.partId);
    if (!item) {
      return {
        partId: part.partId,
        ok: false,
        files: {},
        warnings: [],
        error: typeof raw.error === 'string' && raw.error ? raw.error : '未返回该零件结果'
      };
    }
    const files: Partial<Record<DrawingFormat, string>> = {};
    const warnings = Array.isArray(item.warnings)
      ? item.warnings.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.slice(0, 300)).slice(0, 20)
      : [];
    if (isRecord(item.files)) {
      for (const format of DRAWING_FORMATS) {
        const file = safeFileName(item.files[format], part.fileStem, format);
        if (file) files[format] = file;
        else if (item.files[format] !== undefined) warnings.push(`忽略不合规的 ${format} 输出文件名`);
      }
    }
    const ok = item.ok === true && Object.keys(files).length > 0;
    const result: DrawingPartResult = { partId: part.partId, ok, files, warnings };
    if (!ok) {
      result.error = typeof item.error === 'string' && item.error
        ? item.error.slice(0, 500)
        : (item.ok === true ? '作业未产出任何文件' : '出图失败');
    }
    if (typeof item.paper === 'string' && /^A[34]$/.test(item.paper)) result.paper = item.paper;
    if (typeof item.scale === 'string' && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(item.scale)) result.scale = item.scale;
    const bbox = finiteTriple(item.bbox);
    if (bbox) result.bbox = bbox;
    if (isRecord(item.dimensions)) {
      const { length, width, height } = item.dimensions;
      if ([length, width, height].every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
        result.dimensions = { length: length as number, width: width as number, height: height as number };
      }
    }
    if (Array.isArray(item.views)) result.views = item.views.filter((entry): entry is string => typeof entry === 'string').slice(0, 8);
    if (item.pdfFallback === true) result.pdfFallback = true;
    const holes = parseHoleSummary(item.holes);
    if (holes) result.holes = holes;
    if (typeof item.elapsedMs === 'number' && Number.isFinite(item.elapsedMs)) result.elapsedMs = item.elapsedMs;
    return result;
  });
  const result: DrawingJobResult = {
    ok: parts.every((part) => part.ok),
    jobId: job.jobId,
    parts
  };
  if (typeof raw.freecadVersion === 'string') result.freecadVersion = raw.freecadVersion.slice(0, 40);
  if (typeof raw.scriptVersion === 'string') result.scriptVersion = raw.scriptVersion.slice(0, 20);
  if (typeof raw.error === 'string' && raw.error) result.error = raw.error.slice(0, 500);
  if (typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs)) result.elapsedMs = raw.elapsedMs;
  return result;
}

function parseHoleSummary(value: unknown): DrawingHoleSummary | undefined {
  if (!isRecord(value)) return undefined;
  const sources = ['features', 'geometry', 'mixed', 'none'] as const;
  const modes = ['dims', 'table', 'none'] as const;
  const source = sources.find((item) => item === value.source);
  const mode = modes.find((item) => item === value.mode);
  if (!source || !mode) return undefined;
  const callouts = Array.isArray(value.callouts)
    ? value.callouts.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 80)).slice(0, 50)
    : [];
  const summary: DrawingHoleSummary = { source, callouts, mode };
  if (typeof value.section === 'string' && /^[A-Z]-[A-Z]$/.test(value.section)) summary.section = value.section;
  return summary;
}

/** 解析 stdout 中的进度行；不是进度行或格式不对返回 null。 */
export function parseProgressLine(line: string): DrawingProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DRAWING_PROGRESS_PREFIX.trim())) return null;
  try {
    const payload: unknown = JSON.parse(trimmed.slice(DRAWING_PROGRESS_PREFIX.trim().length).trim());
    if (!isRecord(payload)) return null;
    if (payload.event === 'done') return { event: 'done', ok: payload.ok === true };
    if ((payload.event === 'part-start' || payload.event === 'part-done')
      && Number.isInteger(payload.index) && Number.isInteger(payload.total) && typeof payload.partId === 'string') {
      const base = { index: payload.index as number, total: payload.total as number, partId: payload.partId };
      return payload.event === 'part-start'
        ? { event: 'part-start', ...base }
        : { event: 'part-done', ...base, ok: payload.ok === true };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 零件的稳定文件名主干：ASCII 片段 + partKey 的 SHA-256 前 8 位。
 * 中文物料号也能得到唯一、可跨作业复用的文件名；不随零件顺序变化。
 */
export function partFileStem(partKey: string): string {
  const ascii = partKey.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = sha256Hex(partKey).slice(0, 8);
  return ascii ? `${ascii}-${hash}` : `part-${hash}`;
}
