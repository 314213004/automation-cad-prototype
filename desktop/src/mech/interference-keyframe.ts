// 12.3 【P1】多姿态干涉粗筛：行程包围盒 + 三关键帧 + 配合面豁免（纯逻辑层）
//
// 定位：这是 OCP B-Rep 精检之前的粗筛，不是 B-Rep 本身。现有 mech/interference.ts
// 只做静态 AABB，无法回答“运动到半程 / 满行程时会不会撞”；本模块补这一层：
//   1. 行程包围盒（swept AABB）先剪枝：行程全程都不相交的零件对直接跳过，
//      不进入逐关键帧计算；
//   2. 在 0% / 50% / 100% 三个关键姿态下按行程向量平移包围盒，再做 AABB 求交；
//   3. 配合面豁免：直接 MountPort 配合对（调用方从画布边传入，见 matedPairs），
//      且重叠体积 < 50 mm³（螺钉 / 销孔微过盈量级，文档 12.3 口径）时豁免，不报；
//      ≥50 mm³ 仍报，且 severity 为 error；非配合对 <50 mm³ 为 warning。
// 注意与旧口径的区别：interference.ts 用 volume >1000 或单向重叠 >5mm 判 error，
// 本模块用文档 12.3 的 50 mm³ 口径判 error/warning，两者不互相覆盖，旧函数保持不变。
import type { BBox, Vec3 } from './interference.ts';
import { interferencePairKey } from './interference.ts';

export interface KeyframePart {
  name: string;
  bbox: BBox;
  /** 行程向量 mm（方向 × 行程量）；缺省 = 不动。 */
  strokeVectorMm?: Vec3;
}

export interface KeyframeHit {
  a: string;
  b: string;
  poseRatio: number;
  overlapMm: Vec3;
  volumeApproxMm3: number;
  severity: 'error' | 'warning';
}

export interface KeyframeOptions {
  /** 直接配合对，如 [['AXIS-Y', 'AXIS-Z']]，顺序不限，内部按 pairKey 归一化。 */
  matedPairs?: readonly (readonly [string, string])[];
  /** 配合豁免阈值 mm³，默认 50（文档 12.3）。 */
  fastenerTolMm3?: number;
  /** 行程包围盒粗筛容差 mm，默认 0.1（文档 12.3 的 aabb_overlaps 口径）。 */
  sweptTolMm?: number;
}

function validateBBox(part: KeyframePart): void {
  for (let axis = 0; axis < 3; axis += 1) {
    // noUncheckedIndexedAccess：索引结果可能是 undefined，先归一成 NaN 再校验
    const min = part.bbox.min[axis] ?? Number.NaN;
    const max = part.bbox.max[axis] ?? Number.NaN;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error(`零件「${part.name}」的包围盒非法`);
    }
  }
  const stroke = part.strokeVectorMm ?? [0, 0, 0];
  for (const v of stroke) {
    if (!Number.isFinite(v)) throw new Error(`零件「${part.name}」的行程向量非法`);
  }
}

/** 行程包围盒：原盒 + 按行程向量平移后的盒的并集。 */
export function sweptBBox(part: KeyframePart): BBox {
  validateBBox(part);
  const stroke = part.strokeVectorMm ?? [0, 0, 0];
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = part.bbox.min[axis] ?? 0;
    const hi = part.bbox.max[axis] ?? 0;
    const step = stroke[axis] ?? 0;
    min[axis] = Math.min(lo, lo + step);
    max[axis] = Math.max(hi, hi + step);
  }
  return { min, max };
}

/** 某关键姿态下的包围盒：原盒按行程向量 × ratio 平移。 */
export function bboxAtRatio(part: KeyframePart, ratio: number): BBox {
  validateBBox(part);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('关键帧比例必须在 0~1 之间');
  }
  const stroke = part.strokeVectorMm ?? [0, 0, 0];
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = (part.bbox.min[axis] ?? 0) + (stroke[axis] ?? 0) * ratio;
    max[axis] = (part.bbox.max[axis] ?? 0) + (stroke[axis] ?? 0) * ratio;
  }
  return { min, max };
}

function aabbOverlap(a: BBox, b: BBox, tolMm: number): { overlap: Vec3; volume: number } | null {
  const overlap: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    const lower = Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0);
    const upper = Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0);
    // 粗筛用容差：upper + tol > lower 才算相交；精算时 tol=0，相切不算。
    if (upper + tolMm <= lower) return null;
    overlap[axis] = Math.max(0, upper - lower);
  }
  const volume = overlap[0] * overlap[1] * overlap[2];
  return { overlap, volume };
}

export function detectKeyframeInterferences(
  parts: readonly KeyframePart[],
  keyframes: readonly number[] = [0, 0.5, 1],
  options: KeyframeOptions = {}
): KeyframeHit[] {
  if (!Array.isArray(parts)) throw new Error('干涉检测输入必须是零件数组');
  parts.forEach(validateBBox);
  const tol = options.fastenerTolMm3 ?? 50;
  const sweptTol = options.sweptTolMm ?? 0.1;
  const mated = new Set((options.matedPairs ?? []).map(([a, b]) => interferencePairKey(a, b)));
  const swept = parts.map((part) => sweptBBox(part));
  const hits: KeyframeHit[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const a = parts[i]!;
      const b = parts[j]!;
      // 1. 行程包围盒粗筛：全程都不相交，直接跳过该对。
      if (!aabbOverlap(swept[i]!, swept[j]!, sweptTol)) continue;
      const isMated = mated.has(interferencePairKey(a.name, b.name));
      for (const ratio of keyframes) {
        const boxA = bboxAtRatio(a, ratio);
        const boxB = bboxAtRatio(b, ratio);
        const hit = aabbOverlap(boxA, boxB, 0);
        if (!hit || hit.volume <= 1e-3) continue;
        // 3. 配合面豁免：配合对 + 微过盈（<50 mm³）时不报。
        if (isMated && hit.volume < tol) continue;
        hits.push({
          a: a.name,
          b: b.name,
          poseRatio: ratio,
          overlapMm: hit.overlap,
          volumeApproxMm3: Number(hit.volume.toFixed(2)),
          severity: hit.volume >= tol ? 'error' : 'warning'
        });
      }
    }
  }
  return hits;
}
