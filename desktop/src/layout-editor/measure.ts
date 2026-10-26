/**
 * 整机布局编辑：临时测量（纯函数）。不写主数据，只给读数。
 */
export type Vec3 = [number, number, number];

export interface MeasurePick {
  point: Vec3;
  /** 拾取面的世界法向（单位向量）；无法向时按点测量 */
  normal?: Vec3;
  label?: string;
}

export interface MeasureResult {
  kind: 'point' | 'face';
  distanceMm: number;
  delta: Vec3;
  /** face：两平行面沿法向的距离；非平行面退化为点距 */
  text: string;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function pointDistance(a: Vec3, b: Vec3): { delta: Vec3; distanceMm: number } {
  const delta: Vec3 = [round(b[0] - a[0]), round(b[1] - a[1]), round(b[2] - a[2])];
  return { delta, distanceMm: round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) };
}

function unit(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/** 两次拾取：两面平行（|n1·n2| ≥ cos 1°）时给面距，否则给点距。 */
export function measurePicks(a: MeasurePick, b: MeasurePick): MeasureResult {
  const { delta, distanceMm } = pointDistance(a.point, b.point);
  const na = a.normal ? unit(a.normal) : null;
  const nb = b.normal ? unit(b.normal) : null;
  if (na && nb && Math.abs(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) >= Math.cos(Math.PI / 180)) {
    const gap = round(Math.abs((b.point[0] - a.point[0]) * na[0] + (b.point[1] - a.point[1]) * na[1] + (b.point[2] - a.point[2]) * na[2]));
    return { kind: 'face', distanceMm: gap, delta, text: `面距 ${gap} mm（平行面沿法向）· 点距 ${distanceMm} mm` };
  }
  return {
    kind: 'point',
    distanceMm,
    delta,
    text: `点距 ${distanceMm} mm · ΔX ${delta[0]} · ΔY ${delta[1]} · ΔZ ${delta[2]} mm`
  };
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/**
 * 两个包络盒之间的间隙：每轴 gap（负数 = 该轴重叠深度）与最短距离（重叠时为 0）。
 * 用于属性面板「与最近工位间隙」与碰撞列表的穿透深度提示。
 */
export function boxGap(a: Box3, b: Box3): { gap: Vec3; separationMm: number; overlapping: boolean } {
  const gap = [0, 1, 2].map((axis) => round(Math.max(a.min[axis] as number, b.min[axis] as number) - Math.min(a.max[axis] as number, b.max[axis] as number))) as Vec3;
  const overlapping = gap.every((value) => value < 0);
  const separationMm = overlapping ? 0 : round(Math.hypot(...gap.map((value) => Math.max(0, value))));
  return { gap, separationMm, overlapping };
}
