export type Vec3 = [number, number, number];

export interface BBox {
  min: Vec3;
  max: Vec3;
}

export interface InterferencePart {
  name: string;
  bbox: BBox;
}

export type InterferenceSeverity = 'error' | 'warning';

export interface InterferenceHit {
  a: string;
  b: string;
  overlap: Vec3;
  volumeApprox: number;
  center: Vec3;
  severity: InterferenceSeverity;
}

export interface InterferenceOptions {
  ignoredPairs?: readonly string[];
}

export function interferencePairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}必须是有限数值`);
  }
  return value;
}

function validatePart(part: InterferencePart, index: number): void {
  if (!part || typeof part.name !== 'string' || !part.name.trim()) {
    throw new Error(`第 ${index + 1} 个零件缺少名称`);
  }
  if (!part.bbox || !Array.isArray(part.bbox.min) || !Array.isArray(part.bbox.max) ||
      part.bbox.min.length !== 3 || part.bbox.max.length !== 3) {
    throw new Error(`零件「${part.name}」的包围盒必须包含 min/max 三个坐标`);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const min = finiteNumber(part.bbox.min[axis], `零件「${part.name}」bbox.min[${axis}]`);
    const max = finiteNumber(part.bbox.max[axis], `零件「${part.name}」bbox.max[${axis}]`);
    if (min > max) {
      throw new Error(`零件「${part.name}」bbox.min[${axis}] 不能大于 bbox.max[${axis}]`);
    }
  }
}

export function boundsFromPositions(positions: ArrayLike<number>): BBox {
  if (positions.length < 3 || positions.length % 3 !== 0) {
    throw new Error('顶点坐标必须是 3 的倍数的非空数组');
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(positions[index + axis]);
      if (!Number.isFinite(value)) throw new Error(`顶点坐标包含非法数值（索引 ${index + axis}）`);
      min[axis] = Math.min(min[axis] as number, value);
      max[axis] = Math.max(max[axis] as number, value);
    }
  }
  return { min, max };
}

/**
 * 包围盒级干涉初筛。仅比较轴对齐包围盒，不替代基于三角面/B-rep 的精检。
 */
export function detectInterferences(
  parts: readonly InterferencePart[],
  options: InterferenceOptions = {}
): InterferenceHit[] {
  if (!Array.isArray(parts)) throw new Error('干涉检测输入必须是零件数组');
  parts.forEach(validatePart);
  const ignored = new Set(options.ignoredPairs ?? []);
  const hits: InterferenceHit[] = [];

  for (let left = 0; left < parts.length; left += 1) {
    const partA = parts[left];
    if (!partA) continue;
    for (let right = left + 1; right < parts.length; right += 1) {
      const partB = parts[right];
      if (!partB) continue;
      if (ignored.has(interferencePairKey(partA.name, partB.name))) continue;

      const overlap: Vec3 = [0, 0, 0];
      const center: Vec3 = [0, 0, 0];
      let intersects = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const lower = Math.max(partA.bbox.min[axis], partB.bbox.min[axis]);
        const upper = Math.min(partA.bbox.max[axis], partB.bbox.max[axis]);
        const length = upper - lower;
        // 相切（重叠恰为 0）不视为干涉。
        if (length <= 0) {
          intersects = false;
          break;
        }
        overlap[axis] = length;
        center[axis] = (lower + upper) / 2;
      }
      if (!intersects) continue;

      const volumeApprox = overlap[0] * overlap[1] * overlap[2];
      const severity: InterferenceSeverity =
        volumeApprox > 1000 || overlap.some((value) => value > 5) ? 'error' : 'warning';
      hits.push({
        a: partA.name,
        b: partB.name,
        overlap,
        volumeApprox,
        center,
        severity
      });
    }
  }

  return hits.sort((left, right) => {
    const byVolume = right.volumeApprox - left.volumeApprox;
    if (byVolume !== 0) return byVolume;
    return interferencePairKey(left.a, left.b).localeCompare(interferencePairKey(right.a, right.b));
  });
}
