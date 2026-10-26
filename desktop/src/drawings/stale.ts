// 工程图过期判定纯逻辑：特征树（唯一主数据）→ 零件指纹 → 与清单比对。
// 无 DOM、无 node:fs；renderer 与主进程共用。STEP 只是中间产物，其哈希仅作追溯，
// 不参与过期判定（STEP 头里带时间戳，同一特征树两次导出字节不同）。
import { compileOps, toAssembly, type AssemblyDoc, type FeatureDoc, type FeatureNode, type PartInstance } from '../parametric/features.ts';
import { sha256Hex } from '../plcgen/hash.ts';
import {
  DRAWING_FORMATS,
  DRAWING_PAPERS,
  TECHDRAW_SCRIPT_VERSION,
  partFileStem,
  type DrawingFormat,
  type DrawingPaper,
  type DrawingPartResult
} from './protocol.ts';
import { holeSpecsOf, holesHashOf, type DrawingHoleSpec } from './holes.ts';

export const DRAWING_MANIFEST_SCHEMA_VERSION = 1;

export interface DrawingPartMeta {
  material?: string;
  drawingNo?: string;
  scale?: string;
  paper?: DrawingPaper;
}

export interface PlannedDrawingPart {
  partKey: string;
  partId: string;
  name: string;
  instanceIds: string[];
  quantity: number;
  /** 参与出图的实体（同 partId 取第一个） */
  features: FeatureNode[];
  geometryHash: string;
  /** 孔语义（随作业下发）及其哈希；螺纹规格等不进 sidecar 算子，必须单独纳入指纹 */
  holes: DrawingHoleSpec[];
  holesHash: string;
  fingerprint: string;
  material: string;
  drawingNo: string;
  scale?: string;
  paper?: DrawingPaper;
  fileStem: string;
  conflict: boolean;
}

export interface DrawingPlan {
  parts: PlannedDrawingPart[];
  /** 无法出图的实体（空特征等），不阻断其他零件 */
  skipped: Array<{ instanceId: string; name: string; reason: string }>;
  warnings: string[];
}

export interface DrawingManifestEntry {
  partKey: string;
  partId: string;
  name: string;
  fingerprint: string;
  geometryHash: string;
  holesHash?: string;
  fileStem: string;
  files: Partial<Record<DrawingFormat, string>>;
  stepSha256?: string;
  paper?: string;
  scale?: string;
  bbox?: [number, number, number];
  warnings: string[];
  generatedAt: string;
  freecadVersion?: string;
  scriptVersion: string;
  jobId: string;
  /** 最近一次重出失败的原因；旧图纸文件仍保留 */
  lastError?: string;
}

export interface DrawingManifest {
  schemaVersion: typeof DRAWING_MANIFEST_SCHEMA_VERSION;
  projectKey: string;
  updatedAt: string;
  entries: Record<string, DrawingManifestEntry>;
}

export type DrawingFreshness = 'fresh' | 'stale' | 'missing';

export interface DrawingPartStatus {
  partKey: string;
  partId: string;
  name: string;
  status: DrawingFreshness;
  reason: string;
  conflict: boolean;
  entry?: DrawingManifestEntry;
}

export interface DrawingStatusReport {
  parts: DrawingPartStatus[];
  /** 清单里有、当前特征树已没有的零件图（不自动删除） */
  orphans: DrawingManifestEntry[];
  staleKeys: string[];
  missingKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 稳定 JSON：对象键排序，数组保序；用于指纹。 */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (Array.isArray(item)) return item.map((entry) => entry === undefined ? null : normalize(entry));
    if (isRecord(item)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) out[key] = normalize(item[key]);
      }
      return out;
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

/** 图纸身份：有 partId（物料号）按 partId，否则按实体 id。 */
export function partKeyOf(instance: Pick<PartInstance, 'id' | 'partId'>): string {
  const partId = typeof instance.partId === 'string' ? instance.partId.trim() : '';
  return partId || `inst:${instance.id}`;
}

function singleDoc(features: readonly FeatureNode[]): FeatureDoc {
  return { schemaVersion: 1, features: JSON.parse(JSON.stringify(features)) as FeatureNode[], updatedAt: '1970-01-01T00:00:00Z' };
}

/** 几何哈希：只看编译后的算子（已剔除抑制特征与 UI 字段），与实体摆位无关。 */
export function geometryHashOf(features: readonly FeatureNode[]): string {
  return sha256Hex(canonicalJson(compileOps(singleDoc(features))));
}

export function cleanMeta(meta: DrawingPartMeta | undefined): Required<Pick<DrawingPartMeta, 'material' | 'drawingNo'>> & Pick<DrawingPartMeta, 'scale' | 'paper'> {
  const material = typeof meta?.material === 'string' ? meta.material.trim().slice(0, 40) : '';
  const drawingNo = typeof meta?.drawingNo === 'string' ? meta.drawingNo.trim().slice(0, 40) : '';
  const scale = typeof meta?.scale === 'string' && /^(auto|\d+(\.\d+)?:\d+(\.\d+)?)$/.test(meta.scale.trim())
    ? meta.scale.trim()
    : undefined;
  const paper = typeof meta?.paper === 'string' && (DRAWING_PAPERS as readonly string[]).includes(meta.paper)
    ? meta.paper
    : undefined;
  return { material, drawingNo, ...(scale && scale !== 'auto' ? { scale } : {}), ...(paper && paper !== 'auto' ? { paper } : {}) };
}

/** 指纹 = 几何 + 孔语义 + 标题栏字段 + 出图脚本版本；任一变化都使图纸过期。 */
export function drawingFingerprint(input: {
  geometryHash: string;
  holesHash?: string;
  name: string;
  partId: string;
  quantity: number;
  meta: ReturnType<typeof cleanMeta>;
  scriptVersion?: string;
}): string {
  return sha256Hex(canonicalJson({
    v: input.scriptVersion ?? TECHDRAW_SCRIPT_VERSION,
    geometry: input.geometryHash,
    holes: input.holesHash ?? '',
    name: input.name,
    partId: input.partId,
    quantity: input.quantity,
    material: input.meta.material,
    drawingNo: input.meta.drawingNo,
    scale: input.meta.scale ?? 'auto',
    paper: input.meta.paper ?? 'auto'
  }));
}

function enabledFeatures(features: readonly FeatureNode[]): FeatureNode[] {
  return features.filter((feature) => feature.suppressed !== true);
}

/**
 * 把装配拆成待出图零件：同 partKey 合并为一张图（数量 = 实例数），
 * 几何不一致的同号实例标记 conflict 并以第一个实例出图。
 * instanceIds 为空表示全部零件；否则只出所选实例所属的零件。
 */
export function planDrawingParts(
  input: AssemblyDoc | FeatureDoc,
  options: { instanceIds?: readonly string[]; meta?: Readonly<Record<string, DrawingPartMeta>>; scriptVersion?: string } = {}
): DrawingPlan {
  const assembly = toAssembly(input);
  const wanted = options.instanceIds && options.instanceIds.length > 0 ? new Set(options.instanceIds) : null;
  const wantedKeys = new Set<string>();
  if (wanted) {
    for (const instance of assembly.instances) if (wanted.has(instance.id)) wantedKeys.add(partKeyOf(instance));
  }
  const groups = new Map<string, PartInstance[]>();
  const skipped: DrawingPlan['skipped'] = [];
  for (const instance of assembly.instances) {
    const key = partKeyOf(instance);
    if (wanted && !wantedKeys.has(key)) continue;
    if (enabledFeatures(instance.features).length === 0) {
      skipped.push({ instanceId: instance.id, name: instance.name, reason: '没有启用的特征，无法生成实体' });
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(instance);
    groups.set(key, list);
  }
  const warnings: string[] = [];
  const parts: PlannedDrawingPart[] = [];
  for (const [partKey, instances] of groups) {
    const first = instances[0]!;
    const geometryHash = geometryHashOf(first.features);
    const conflict = instances.some((instance) => geometryHashOf(instance.features) !== geometryHash);
    if (conflict) {
      warnings.push(`物料号 ${partKey} 下的 ${instances.length} 个实体几何不一致，按第一个实体「${first.name}」出图`);
    }
    const partId = typeof first.partId === 'string' && first.partId.trim() ? first.partId.trim() : first.id;
    const meta = cleanMeta(options.meta?.[partKey]);
    const name = first.name.trim() || partId;
    const quantity = instances.length;
    const holes = holeSpecsOf(first.features);
    const holesHash = holesHashOf(holes);
    const fingerprintInput = {
      geometryHash, holesHash, name, partId, quantity, meta,
      ...(options.scriptVersion ? { scriptVersion: options.scriptVersion } : {})
    };
    parts.push({
      partKey,
      partId,
      name,
      instanceIds: instances.map((instance) => instance.id),
      quantity,
      features: JSON.parse(JSON.stringify(first.features)) as FeatureNode[],
      geometryHash,
      holes,
      holesHash,
      fingerprint: drawingFingerprint(fingerprintInput),
      material: meta.material,
      drawingNo: meta.drawingNo || partId,
      ...(meta.scale ? { scale: meta.scale } : {}),
      ...(meta.paper ? { paper: meta.paper } : {}),
      fileStem: partFileStem(partKey),
      conflict
    });
  }
  return { parts, skipped, warnings };
}

export function emptyManifest(projectKey: string, now: Date = new Date()): DrawingManifest {
  return { schemaVersion: DRAWING_MANIFEST_SCHEMA_VERSION, projectKey, updatedAt: now.toISOString(), entries: {} };
}

/** 读盘后的清单校验：丢弃不合规条目（文件名必须与 fileStem 一致），不抛异常。 */
export function parseDrawingManifest(raw: unknown, projectKey: string): DrawingManifest {
  const manifest = emptyManifest(projectKey);
  if (!isRecord(raw) || raw.schemaVersion !== DRAWING_MANIFEST_SCHEMA_VERSION || !isRecord(raw.entries)) return manifest;
  if (typeof raw.updatedAt === 'string') manifest.updatedAt = raw.updatedAt;
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!isRecord(value) || value.partKey !== key) continue;
    if (typeof value.fingerprint !== 'string' || typeof value.fileStem !== 'string') continue;
    if (value.fileStem !== partFileStem(key)) continue;
    const files: Partial<Record<DrawingFormat, string>> = {};
    if (isRecord(value.files)) {
      for (const format of DRAWING_FORMATS) {
        const expected = format === 'fcstd' ? `${value.fileStem}.FCStd` : `${value.fileStem}.${format}`;
        if (value.files[format] === expected) files[format] = expected;
      }
    }
    const entry: DrawingManifestEntry = {
      partKey: key,
      partId: typeof value.partId === 'string' ? value.partId : key,
      name: typeof value.name === 'string' ? value.name : key,
      fingerprint: value.fingerprint,
      geometryHash: typeof value.geometryHash === 'string' ? value.geometryHash : '',
      fileStem: value.fileStem,
      files,
      warnings: Array.isArray(value.warnings) ? value.warnings.filter((item): item is string => typeof item === 'string') : [],
      generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
      scriptVersion: typeof value.scriptVersion === 'string' ? value.scriptVersion : '',
      jobId: typeof value.jobId === 'string' ? value.jobId : ''
    };
    if (typeof value.stepSha256 === 'string') entry.stepSha256 = value.stepSha256;
    if (typeof value.holesHash === 'string') entry.holesHash = value.holesHash;
    if (typeof value.paper === 'string') entry.paper = value.paper;
    if (typeof value.scale === 'string') entry.scale = value.scale;
    if (Array.isArray(value.bbox) && value.bbox.length === 3 && value.bbox.every((item) => typeof item === 'number')) {
      entry.bbox = value.bbox as [number, number, number];
    }
    if (typeof value.freecadVersion === 'string') entry.freecadVersion = value.freecadVersion;
    if (typeof value.lastError === 'string') entry.lastError = value.lastError;
    manifest.entries[key] = entry;
  }
  return manifest;
}

/**
 * 当前特征树 vs 清单：
 * - missing：从未出过图（或文件条目为空）
 * - stale：指纹变化（几何 / 标题栏字段 / 脚本版本），或最近一次重出失败
 * - fresh：指纹一致
 */
export function drawingStatus(manifest: DrawingManifest, plan: DrawingPlan): DrawingStatusReport {
  const parts: DrawingPartStatus[] = plan.parts.map((part) => {
    const entry = manifest.entries[part.partKey];
    const base = { partKey: part.partKey, partId: part.partId, name: part.name, conflict: part.conflict };
    if (!entry || Object.keys(entry.files).length === 0) {
      return { ...base, status: 'missing' as const, reason: '尚未出图' };
    }
    if (entry.fingerprint !== part.fingerprint) {
      const reason = entry.geometryHash && entry.geometryHash !== part.geometryHash
        ? '几何参数已变更'
        : entry.holesHash !== undefined && entry.holesHash !== part.holesHash
          ? '孔规格（螺纹/孔深等）已变更'
          : entry.scriptVersion && entry.scriptVersion !== TECHDRAW_SCRIPT_VERSION
          ? '出图脚本已升级'
          : '名称/材料/图号/比例等标题栏字段已变更';
      return { ...base, status: 'stale' as const, reason, entry };
    }
    if (entry.lastError) {
      return { ...base, status: 'stale' as const, reason: `最近一次重出失败：${entry.lastError}`, entry };
    }
    return { ...base, status: 'fresh' as const, reason: '与当前特征树一致', entry };
  });
  const planned = new Set(plan.parts.map((part) => part.partKey));
  const orphans = Object.values(manifest.entries).filter((entry) => !planned.has(entry.partKey));
  return {
    parts,
    orphans,
    staleKeys: parts.filter((part) => part.status === 'stale').map((part) => part.partKey),
    missingKeys: parts.filter((part) => part.status === 'missing').map((part) => part.partKey)
  };
}

/** 两版特征树之间受影响（需要重出）的图纸集合：新增、几何或标题栏字段变化的 partKey。 */
export function affectedPartKeys(
  previous: AssemblyDoc | FeatureDoc | null,
  next: AssemblyDoc | FeatureDoc,
  meta: Readonly<Record<string, DrawingPartMeta>> = {}
): string[] {
  const after = planDrawingParts(next, { meta });
  if (!previous) return after.parts.map((part) => part.partKey);
  const before = new Map(planDrawingParts(previous, { meta }).parts.map((part) => [part.partKey, part.fingerprint]));
  return after.parts.filter((part) => before.get(part.partKey) !== part.fingerprint).map((part) => part.partKey);
}

/** 把一次作业结果并入清单：成功替换条目；失败保留旧图纸并记下 lastError（因此判为过期）。 */
export function applyJobResults(
  manifest: DrawingManifest,
  input: {
    jobId: string;
    freecadVersion?: string;
    parts: Array<{ plan: PlannedDrawingPart; result: DrawingPartResult; stepSha256?: string }>;
    now?: Date;
  }
): DrawingManifest {
  const now = (input.now ?? new Date()).toISOString();
  const entries = { ...manifest.entries };
  for (const { plan, result, stepSha256 } of input.parts) {
    const previous = entries[plan.partKey];
    if (result.ok) {
      const entry: DrawingManifestEntry = {
        partKey: plan.partKey,
        partId: plan.partId,
        name: plan.name,
        fingerprint: plan.fingerprint,
        geometryHash: plan.geometryHash,
        holesHash: plan.holesHash,
        fileStem: plan.fileStem,
        files: { ...result.files },
        warnings: [...result.warnings, ...(plan.conflict ? ['同物料号实体几何不一致，按第一个实体出图'] : [])],
        generatedAt: now,
        scriptVersion: TECHDRAW_SCRIPT_VERSION,
        jobId: input.jobId
      };
      if (stepSha256) entry.stepSha256 = stepSha256;
      if (result.paper) entry.paper = result.paper;
      if (result.scale) entry.scale = result.scale;
      if (result.bbox) entry.bbox = result.bbox;
      if (input.freecadVersion) entry.freecadVersion = input.freecadVersion;
      entries[plan.partKey] = entry;
    } else if (previous) {
      entries[plan.partKey] = { ...previous, lastError: result.error ?? '出图失败' };
    }
  }
  return { ...manifest, updatedAt: now, entries };
}
