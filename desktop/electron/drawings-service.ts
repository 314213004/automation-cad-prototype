/**
 * 工程图服务（主进程，不依赖 electron）：特征树 → 逐件 STEP（build123d sidecar）→ FreeCAD 作业 → 工程目录。
 *
 * 数据流与边界：
 * - 特征树 JSON 是唯一主数据：renderer 只送 AssemblyDoc + 零件元数据（材料/图号/比例），不送任何文件路径；
 * - 逐件 STEP 由参数化内核现场导出（单件 FeatureDoc，零件自身坐标系，不带装配摆位）；
 * - 出图在独立 freecadcmd 进程里完成，STEP 只经文件中转（不在同一 Python 进程里混用 build123d 与 FreeCAD 的 OCCT）；
 * - 产物写入工程目录 drawings/，manifest.json 按 partKey 记录指纹/STEP 哈希，用于过期判定与一键重出。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAssemblyDoc, type AssemblyDoc, type FeatureDoc, type FeatureNode } from '../src/parametric/features.ts';
import {
  DRAWING_FORMATS,
  normalizeDrawingOptions,
  type DrawingFormat,
  type DrawingJobOptions,
  type DrawingTitleBlock
} from '../src/drawings/protocol.ts';
import {
  applyJobResults,
  drawingStatus,
  emptyManifest,
  parseDrawingManifest,
  planDrawingParts,
  type DrawingManifest,
  type DrawingPartMeta,
  type PlannedDrawingPart
} from '../src/drawings/stale.ts';
import type { FreecadInfo, FreecadJobOutcome, FreecadJobSnapshot, FreecadRunner } from './freecad.ts';

export const DRAWINGS_MODULE_ID = 'drawings.techdraw';
export const DRAWINGS_MODULE_DISABLED_MESSAGE =
  '功能模块「drawings.techdraw」当前已关闭；工程图生成已停用，已生成的图纸文件与清单保留，建模不受影响。重新启用后可继续出图。';

export interface DrawingsServiceOptions {
  userDataDir: string;
  runner: FreecadRunner;
  /** 单件特征 → STEP 文件路径（通常是 ParametricManager.build 的 files.step.path） */
  buildStep: (doc: FeatureDoc, signal: AbortSignal) => Promise<string>;
  isEnabled?: () => boolean;
  /** 工程库目录（userData/projects）；projectKey 命中已有工程时图纸落到该工程的 drawings/ */
  projectsRoot?: string;
}

export interface DrawingsGenerateRequest {
  projectKey: string;
  doc: AssemblyDoc | FeatureDoc;
  instanceIds?: string[];
  onlyStale?: boolean;
  meta?: Record<string, DrawingPartMeta>;
  titleBlock?: Partial<DrawingTitleBlock>;
  options?: Partial<DrawingJobOptions>;
}

export type DrawingsGenerateResponse =
  | { ok: true; jobId: string; partKeys: string[]; skipped: Array<{ instanceId: string; name: string; reason: string }>; warnings: string[] }
  | { ok: false; code: 'MODULE_DISABLED' | 'FREECAD_UNAVAILABLE' | 'INVALID_ARGUMENT' | 'NOTHING_TO_DO'; message: string; info?: FreecadInfo };

export interface DrawingsListResponse {
  ok: true;
  projectKey: string;
  directory: string;
  manifest: DrawingManifest;
}

const PROJECT_KEY_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProjectKey(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_KEY_PATTERN.test(value.trim())) throw new Error('projectKey 非法');
  return value.trim();
}

/** projectKey → 目录名：可读 ASCII 片段 + SHA-256 前 12 位；永不含路径分隔符。 */
export function projectDirName(projectKey: string): string {
  const ascii = projectKey.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hash = createHash('sha256').update(projectKey).digest('hex').slice(0, 12);
  return ascii ? `${ascii}-${hash}` : `project-${hash}`;
}

function parseMeta(value: unknown): Record<string, DrawingPartMeta> {
  if (!isRecord(value)) return {};
  const out: Record<string, DrawingPartMeta> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 200)) {
    if (!isRecord(entry) || key.length > 200) continue;
    const meta: DrawingPartMeta = {};
    if (typeof entry.material === 'string') meta.material = entry.material;
    if (typeof entry.drawingNo === 'string') meta.drawingNo = entry.drawingNo;
    if (typeof entry.scale === 'string') meta.scale = entry.scale;
    if (entry.paper === 'A3' || entry.paper === 'A4' || entry.paper === 'auto') meta.paper = entry.paper;
    out[key] = meta;
  }
  return out;
}

/** IPC 入参校验：只收结构化数据，不收路径。 */
export function parseGenerateRequest(value: unknown): DrawingsGenerateRequest {
  if (!isRecord(value)) throw new Error('出图请求必须是对象');
  const projectKey = validateProjectKey(value.projectKey);
  const doc = value.doc;
  if (!isRecord(doc)) throw new Error('doc 必须是特征树对象');
  if (!isAssemblyDoc(doc) && !Array.isArray((doc as Record<string, unknown>).features)) throw new Error('doc 不是特征树');
  const request: DrawingsGenerateRequest = { projectKey, doc: doc as unknown as AssemblyDoc | FeatureDoc };
  if (Array.isArray(value.instanceIds)) {
    request.instanceIds = value.instanceIds.filter((item): item is string => typeof item === 'string' && item.length <= 80).slice(0, 50);
  }
  if (value.onlyStale === true) request.onlyStale = true;
  request.meta = parseMeta(value.meta);
  if (isRecord(value.titleBlock)) {
    const titleBlock: Partial<DrawingTitleBlock> = {};
    if (typeof value.titleBlock.designer === 'string') titleBlock.designer = value.titleBlock.designer;
    if (typeof value.titleBlock.company === 'string') titleBlock.company = value.titleBlock.company;
    if (typeof value.titleBlock.date === 'string') titleBlock.date = value.titleBlock.date;
    request.titleBlock = titleBlock;
  }
  if (isRecord(value.options)) request.options = normalizeDrawingOptions(value.options);
  return request;
}

export class DrawingsService {
  private readonly options: DrawingsServiceOptions;
  /** 同一工程的清单写入串行化 */
  private manifestChain: Promise<void> = Promise.resolve();

  constructor(options: DrawingsServiceOptions) {
    this.options = options;
  }

  enabled(): boolean {
    if (!this.options.isEnabled) return true;
    try {
      return this.options.isEnabled() === true;
    } catch {
      return false;
    }
  }

  /** 图纸目录：命中工程库 project.json 时用 projects/<id>/drawings，否则 userData/drawings/<slug-hash>。 */
  directoryFor(projectKey: string): string {
    const key = validateProjectKey(projectKey);
    const projectsRoot = this.options.projectsRoot;
    if (projectsRoot && PROJECT_ID_PATTERN.test(key) && existsSync(join(projectsRoot, key, 'project.json'))) {
      return join(projectsRoot, key, 'drawings');
    }
    return join(this.options.userDataDir, 'drawings', projectDirName(key));
  }

  readManifest(projectKey: string): DrawingManifest {
    const key = validateProjectKey(projectKey);
    const path = join(this.directoryFor(key), 'manifest.json');
    if (!existsSync(path)) return emptyManifest(key);
    try {
      return parseDrawingManifest(JSON.parse(readFileSync(path, 'utf8')), key);
    } catch {
      return emptyManifest(key);
    }
  }

  private writeManifest(projectKey: string, manifest: DrawingManifest): void {
    const directory = this.directoryFor(projectKey);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'manifest.json');
    const staging = `${path}.tmp`;
    writeFileSync(staging, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(staging, path);
  }

  list(projectKey: unknown): DrawingsListResponse {
    const key = validateProjectKey(projectKey);
    return { ok: true, projectKey: key, directory: this.directoryFor(key), manifest: this.readManifest(key) };
  }

  /** 解析某零件某格式的图纸绝对路径；只返回清单登记且确实存在的文件。 */
  resolveFile(projectKey: unknown, partKey: unknown, format: unknown): string | null {
    const key = validateProjectKey(projectKey);
    if (typeof partKey !== 'string' || typeof format !== 'string') return null;
    if (!(DRAWING_FORMATS as readonly string[]).includes(format)) return null;
    const entry = this.readManifest(key).entries[partKey];
    const name = entry?.files[format as DrawingFormat];
    if (!name) return null;
    const path = join(this.directoryFor(key), name);
    return existsSync(path) ? path : null;
  }

  async generate(raw: unknown): Promise<DrawingsGenerateResponse> {
    if (!this.enabled()) return { ok: false, code: 'MODULE_DISABLED', message: DRAWINGS_MODULE_DISABLED_MESSAGE };
    let request: DrawingsGenerateRequest;
    try {
      request = parseGenerateRequest(raw);
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error) };
    }
    const info = await this.options.runner.detect(false);
    if (!info.available) {
      return { ok: false, code: 'FREECAD_UNAVAILABLE', message: `FreeCAD 不可用：${info.reason}。${info.installHint}`, info };
    }
    const plan = planDrawingParts(request.doc, {
      ...(request.instanceIds ? { instanceIds: request.instanceIds } : {}),
      ...(request.meta ? { meta: request.meta } : {})
    });
    let parts: PlannedDrawingPart[] = plan.parts;
    if (request.onlyStale) {
      const status = drawingStatus(this.readManifest(request.projectKey), plan);
      const need = new Set([...status.staleKeys, ...status.missingKeys]);
      parts = parts.filter((part) => need.has(part.partKey));
    }
    if (parts.length === 0) {
      return {
        ok: false,
        code: 'NOTHING_TO_DO',
        message: request.onlyStale ? '所有工程图都是最新的' : (plan.skipped[0]?.reason ? `没有可出图的零件：${plan.skipped[0].reason}` : '没有可出图的零件')
      };
    }
    const projectKey = request.projectKey;
    const outputDir = this.directoryFor(projectKey);
    const byKey = new Map(parts.map((part) => [part.partKey, part]));
    const featuresByKey = new Map<string, FeatureNode[]>(parts.map((part) => [part.partKey, part.features]));
    const snapshot: FreecadJobSnapshot = this.options.runner.enqueue({
      label: parts.length === 1 ? `工程图：${parts[0]!.name}` : `${parts.length} 个零件工程图`,
      parts: parts.map((part) => ({
        partKey: part.partKey,
        partId: part.partId,
        fileStem: part.fileStem,
        name: part.name,
        material: part.material,
        drawingNo: part.drawingNo,
        quantity: part.quantity,
        ...(part.scale ? { scale: part.scale } : {}),
        ...(part.paper ? { paper: part.paper } : {})
      })),
      resolveStep: async (part, signal) => {
        if (!this.enabled()) throw new Error(DRAWINGS_MODULE_DISABLED_MESSAGE);
        const features = featuresByKey.get(part.partKey) ?? [];
        return await this.options.buildStep({ schemaVersion: 1, features, updatedAt: new Date().toISOString() }, signal);
      },
      outputDir,
      ...(request.options ? { options: request.options } : {}),
      ...(request.titleBlock ? { titleBlock: request.titleBlock } : {}),
      onSettled: (outcome) => this.recordOutcome(projectKey, byKey, outcome)
    });
    return { ok: true, jobId: snapshot.jobId, partKeys: parts.map((part) => part.partKey), skipped: plan.skipped, warnings: plan.warnings };
  }

  private recordOutcome(projectKey: string, byKey: Map<string, PlannedDrawingPart>, outcome: FreecadJobOutcome): Promise<void> {
    const work = this.manifestChain.then(() => {
      const items = outcome.parts
        .map((entry) => {
          const plan = byKey.get(entry.part.partKey);
          return plan ? { plan, result: entry.result, ...(entry.stepSha256 ? { stepSha256: entry.stepSha256 } : {}) } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      if (items.length === 0) return;
      const next = applyJobResults(this.readManifest(projectKey), {
        jobId: outcome.jobId,
        ...(outcome.freecadVersion ? { freecadVersion: outcome.freecadVersion } : {}),
        parts: items
      });
      this.writeManifest(projectKey, next);
    });
    this.manifestChain = work.catch((error: unknown) => {
      console.warn('[DRAWINGS_MANIFEST_WRITE_FAILED]', error);
    });
    return this.manifestChain;
  }
}
