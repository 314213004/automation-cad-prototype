// 孔语义：特征树（唯一主数据）→ 工程图作业里每个零件的 holes[]。
// 纯函数层：无 DOM、无 node:fs；renderer（过期判定）与主进程（作业组装）共用。
// 分组、标注文本、孔位尺寸与布局在 FreeCAD 侧脚本（spike/freecad/techdraw_job.py，纯逻辑可 --self-test）完成；
// 这里只负责「语义从哪来、长什么样」，坐标为零件自身坐标系（与逐件 STEP 一致），孔轴沿 +Z、从顶面向下。
import type { FeatureNode } from '../parametric/features.ts';
import { sha256Hex } from '../plcgen/hash.ts';

export type DrawingHoleKind = 'hole' | 'counterbore' | 'slot';

export interface DrawingHoleSpec {
  /** 来源特征 id（追溯用；不参与分组） */
  featureId: string;
  kind: DrawingHoleKind;
  /** 孔心（腰形槽为槽中心），零件坐标 [x, y] mm */
  positions: Array<[number, number]>;
  /** 通孔/底孔直径（螺纹孔为底孔径）；腰形槽不填 */
  diameter?: number;
  /** true = 通孔/通槽；false 时 depth 为从顶面量起的孔深 */
  through: boolean;
  depth?: number;
  cbDiameter?: number;
  cbDepth?: number;
  /** 螺纹规格（规范化后，如 M6、M8×1），只对 kind=hole 有意义 */
  thread?: string;
  threadDepth?: number;
  /** 腰形槽总长 × 槽宽（沿 X） */
  length?: number;
  width?: number;
}

export const MAX_HOLE_SPECS = 100;
export const MAX_HOLE_POSITIONS = 400;
const THREAD_PATTERN = /^M(\d+(?:\.\d+)?)(?:[x×*](\d+(?:\.\d+)?))?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 'm6' → 'M6'；'M8x1' / 'M8*1' → 'M8×1'；非法或空返回 null。 */
export function normalizeThread(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = THREAD_PATTERN.exec(value.trim().replace(/\s+/g, ''));
  if (!match) return null;
  const nominal = Number(match[1]);
  if (!(nominal > 0 && nominal <= 100)) return null;
  return match[2] ? `M${match[1]}×${match[2]}` : `M${match[1]}`;
}

/** 螺纹公称直径（mm）；非法返回 null。 */
export function threadNominal(value: unknown): number | null {
  const thread = normalizeThread(value);
  if (!thread) return null;
  return Number(/^M(\d+(?:\.\d+)?)/.exec(thread)![1]);
}

function positionsOf(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [x, y] = item;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([x, y]);
  }
  return out;
}

/**
 * 从单个零件的特征列表提取孔语义（跳过抑制特征与参数不全的特征，不抛异常）。
 * 顺序与特征树一致；同规格合并由出图脚本按规格分组完成。
 */
export function holeSpecsOf(features: readonly FeatureNode[]): DrawingHoleSpec[] {
  const out: DrawingHoleSpec[] = [];
  for (const node of Array.isArray(features) ? features : []) {
    if (!isRecord(node) || node.suppressed === true || !isRecord(node.params)) continue;
    const params = node.params;
    const featureId = typeof node.id === 'string' ? node.id : '';
    const through = params.depth === undefined || params.depth === 'through' || params.depth === '';
    const depth = !through && positive(params.depth) ? params.depth : undefined;
    if (!through && depth === undefined) continue;
    if (node.type === 'holes' || node.type === 'counterbore') {
      const positions = positionsOf(params.positions);
      if (!positive(params.diameter) || positions.length === 0) continue;
      const spec: DrawingHoleSpec = {
        featureId,
        kind: node.type === 'holes' ? 'hole' : 'counterbore',
        positions,
        diameter: params.diameter,
        through,
        ...(depth !== undefined ? { depth } : {})
      };
      if (node.type === 'counterbore') {
        if (!positive(params.cbDiameter) || !positive(params.cbDepth)) continue;
        spec.cbDiameter = params.cbDiameter;
        spec.cbDepth = params.cbDepth;
      } else {
        const thread = normalizeThread(params.thread);
        if (thread) {
          spec.thread = thread;
          if (positive(params.threadDepth)) spec.threadDepth = params.threadDepth;
        }
      }
      out.push(spec);
    } else if (node.type === 'slot') {
      if (!positive(params.length) || !positive(params.width)) continue;
      // sidecar 的腰形槽固定以零件原点为中心、沿 X 方向、通槽
      out.push({ featureId, kind: 'slot', positions: [[0, 0]], through: true, length: params.length, width: params.width });
    }
  }
  return out;
}

/** 孔语义哈希：不含 featureId（改名/重排特征 id 不应使图纸过期），保序。 */
export function holesHashOf(specs: readonly DrawingHoleSpec[]): string {
  const stable = specs.map((spec) => [
    spec.kind,
    spec.positions,
    spec.diameter ?? null,
    spec.through,
    spec.depth ?? null,
    spec.cbDiameter ?? null,
    spec.cbDepth ?? null,
    spec.thread ?? null,
    spec.threadDepth ?? null,
    spec.length ?? null,
    spec.width ?? null
  ]);
  return sha256Hex(JSON.stringify(stable));
}

/** 作业 JSON 里 holes[] 的校验（中文错误，全量返回）；与 Python validate_job 同口径。 */
export function validateHoleSpecs(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${label} holes 必须是数组`];
  const errors: string[] = [];
  if (value.length > MAX_HOLE_SPECS) errors.push(`${label} holes 最多 ${MAX_HOLE_SPECS} 组`);
  let total = 0;
  value.forEach((spec, index) => {
    const at = `${label} 第 ${index + 1} 组孔`;
    if (!isRecord(spec)) {
      errors.push(`${at}不是对象`);
      return;
    }
    if (spec.kind !== 'hole' && spec.kind !== 'counterbore' && spec.kind !== 'slot') errors.push(`${at} kind 非法`);
    const positions = Array.isArray(spec.positions) ? spec.positions : null;
    if (!positions || positions.length === 0 || positionsOf(positions).length !== positions.length) {
      errors.push(`${at} positions 必须是非空 [x, y] 数组`);
    } else total += positions.length;
    if (typeof spec.through !== 'boolean') errors.push(`${at} through 必须是布尔值`);
    else if (!spec.through && !positive(spec.depth)) errors.push(`${at} 盲孔缺少 depth`);
    if (spec.kind === 'slot') {
      if (!positive(spec.length) || !positive(spec.width)) errors.push(`${at} 腰形槽缺少 length/width`);
      else if ((spec.length as number) < (spec.width as number)) errors.push(`${at} 腰形槽总长不能小于槽宽`);
    } else if (!positive(spec.diameter)) errors.push(`${at} diameter 非法`);
    if (spec.kind === 'counterbore' && (!positive(spec.cbDiameter) || !positive(spec.cbDepth))) {
      errors.push(`${at} 沉孔缺少 cbDiameter/cbDepth`);
    }
    if (spec.thread !== undefined && normalizeThread(spec.thread) !== spec.thread) errors.push(`${at} thread 非法`);
    if (spec.threadDepth !== undefined && !positive(spec.threadDepth)) errors.push(`${at} threadDepth 非法`);
  });
  if (total > MAX_HOLE_POSITIONS) errors.push(`${label} 孔位总数最多 ${MAX_HOLE_POSITIONS} 个`);
  return errors;
}
