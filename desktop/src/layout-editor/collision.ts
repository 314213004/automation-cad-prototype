/**
 * 整机布局编辑：包络级碰撞检测（纯函数，无 DOM / three）。
 *
 * 口径：每个零件取其形体包络盒（圆柱取外接盒）在世界坐标下的 OBB——零件只有绕 Z 旋转，
 * 所以 OBB 检测 = XY 平面上两个旋转矩形的分离轴测试 + Z 区间重叠。粗筛用 AABB 扫掠。
 * 这不是 B-rep 实体求交：结果是保守的「包络重叠」，体积字段是两 AABB 交集体积（上界）。
 *
 * 只比较不同「单元」之间的零件（工位 stN 之间、工位与机架/输送等无工位零件之间）。
 * 同一工位内部零件随工位刚体移动，编辑不会改变它们的相对关系。
 */
import { shapeHalfExtents, type GeomPart, type MachineGeometry, type Vec3 } from '../machine/geometry.ts';

export const FRAME_UNIT = 'frame';

export interface CollisionBody {
  id: string;
  name: string;
  /** 工位 stN；无工位的机架/输送/安全零件归为 'frame' */
  unitId: string;
  center: Vec3;
  /** 局部半尺寸（X/Y 已含形体方向，Z 向上） */
  half: Vec3;
  rotationZDeg: number;
  moving: boolean;
  /** XY 截面：盒/水平圆柱 = 矩形；竖直圆柱 = 圆（精检用多边形近似） */
  profile: { kind: 'rect' } | { kind: 'circle'; radius: number };
  /** 水平圆柱（axis x/y）在 Z 方向截面不是矩形，精检只能给上界 */
  horizontalCylinder: boolean;
}

export interface CollisionPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  aUnit: string;
  bUnit: string;
  method: 'obb';
  /** 两 AABB 交集体积（mm³，上界；用于排序与提示） */
  aabbOverlapMm3: number;
  /** 世界 AABB 交集范围 */
  overlap: { min: Vec3; max: Vec3 };
}

export interface CollisionReport {
  pairs: CollisionPair[];
  /** 基线中已存在（规则引擎原始摆放就有）因而不提示的对数 */
  baselineSkipped: number;
  /** 涉及的单元 / 零件，用于把视口里的对象标红 */
  unitIds: string[];
  partIds: string[];
  checkedBodies: number;
  method: 'obb-envelope';
}

export interface CollisionOptions {
  /** 判定重叠的穿透阈值（mm），默认 0.01：贴合面不算干涉 */
  toleranceMm?: number;
  /** pairKey 集合：基线中已存在的对，不进入结果 */
  baseline?: ReadonlySet<string>;
  /** 只检查涉及这些单元的对（拖动时只查被拖工位，减少开销）；缺省检查全部 */
  focusUnits?: ReadonlySet<string>;
  /** 结果上限，默认 500 */
  limit?: number;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function bodyFromPart(part: GeomPart): CollisionBody {
  return {
    id: part.id,
    name: part.name,
    unitId: part.stationId ?? FRAME_UNIT,
    center: [...part.center] as Vec3,
    half: shapeHalfExtents(part.shape),
    rotationZDeg: part.rotationZDeg,
    moving: part.moving === true,
    profile: part.shape.type === 'cylinder' && part.shape.axis === 'z' ? { kind: 'circle', radius: part.shape.radius } : { kind: 'rect' },
    horizontalCylinder: part.shape.type === 'cylinder' && part.shape.axis !== 'z'
  };
}

export function bodiesFromGeometry(geometry: Pick<MachineGeometry, 'parts'>): CollisionBody[] {
  return geometry.parts.map(bodyFromPart);
}

interface Prepared {
  body: CollisionBody;
  cos: number;
  sin: number;
  min: Vec3;
  max: Vec3;
}

function prepare(body: CollisionBody): Prepared {
  const rad = body.rotationZDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ex = Math.abs(cos) * body.half[0] + Math.abs(sin) * body.half[1];
  const ey = Math.abs(sin) * body.half[0] + Math.abs(cos) * body.half[1];
  return {
    body,
    cos,
    sin,
    min: [body.center[0] - ex, body.center[1] - ey, body.center[2] - body.half[2]],
    max: [body.center[0] + ex, body.center[1] + ey, body.center[2] + body.half[2]]
  };
}

/** XY 平面两个旋转矩形的分离轴测试；返回最小穿透深度（≤ 0 表示分离或贴合）。 */
function rectPenetration(a: Prepared, b: Prepared): number {
  const axes: Array<[number, number]> = [[a.cos, a.sin], [-a.sin, a.cos], [b.cos, b.sin], [-b.sin, b.cos]];
  const dx = b.body.center[0] - a.body.center[0];
  const dy = b.body.center[1] - a.body.center[1];
  let minDepth = Infinity;
  for (const [ux, uy] of axes) {
    const ra = a.body.half[0] * Math.abs(a.cos * ux + a.sin * uy) + a.body.half[1] * Math.abs(-a.sin * ux + a.cos * uy);
    const rb = b.body.half[0] * Math.abs(b.cos * ux + b.sin * uy) + b.body.half[1] * Math.abs(-b.sin * ux + b.cos * uy);
    const depth = ra + rb - Math.abs(dx * ux + dy * uy);
    if (depth < minDepth) minDepth = depth;
    if (minDepth <= 0) return minDepth;
  }
  return minDepth;
}

/** 两个零件包络（OBB）是否穿透超过阈值。 */
export function bodiesOverlap(a: CollisionBody, b: CollisionBody, toleranceMm = 0.01): boolean {
  const pa = prepare(a);
  const pb = prepare(b);
  const zDepth = Math.min(pa.max[2], pb.max[2]) - Math.max(pa.min[2], pb.min[2]);
  if (zDepth <= toleranceMm) return false;
  return rectPenetration(pa, pb) > toleranceMm;
}

function round(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 扫掠粗筛（按 minX 排序）+ OBB 精筛；结果按交集体积降序、再按 id 排序，确定可测。 */
export function detectCollisions(bodies: readonly CollisionBody[], options: CollisionOptions = {}): CollisionReport {
  const tolerance = options.toleranceMm ?? 0.01;
  const limit = options.limit ?? 500;
  const prepared = bodies.map(prepare).sort((left, right) => left.min[0] - right.min[0]);
  const pairs: CollisionPair[] = [];
  let baselineSkipped = 0;
  for (let i = 0; i < prepared.length; i += 1) {
    const a = prepared[i] as Prepared;
    for (let j = i + 1; j < prepared.length; j += 1) {
      const b = prepared[j] as Prepared;
      if (b.min[0] >= a.max[0] - tolerance) break;
      if (a.body.unitId === b.body.unitId) continue;
      if (options.focusUnits && !options.focusUnits.has(a.body.unitId) && !options.focusUnits.has(b.body.unitId)) continue;
      if (a.max[1] - tolerance <= b.min[1] || b.max[1] - tolerance <= a.min[1]) continue;
      if (a.max[2] - tolerance <= b.min[2] || b.max[2] - tolerance <= a.min[2]) continue;
      if (rectPenetration(a, b) <= tolerance) continue;
      const key = pairKey(a.body.id, b.body.id);
      if (options.baseline?.has(key)) { baselineSkipped += 1; continue; }
      const min: Vec3 = [0, 1, 2].map((axis) => round(Math.max(a.min[axis] as number, b.min[axis] as number))) as Vec3;
      const max: Vec3 = [0, 1, 2].map((axis) => round(Math.min(a.max[axis] as number, b.max[axis] as number))) as Vec3;
      const volume = round(Math.max(0, max[0] - min[0]) * Math.max(0, max[1] - min[1]) * Math.max(0, max[2] - min[2]));
      const [first, second] = a.body.id < b.body.id ? [a.body, b.body] : [b.body, a.body];
      pairs.push({ a: first.id, b: second.id, aName: first.name, bName: second.name, aUnit: first.unitId, bUnit: second.unitId, method: 'obb', aabbOverlapMm3: volume, overlap: { min, max } });
    }
  }
  pairs.sort((left, right) => right.aabbOverlapMm3 - left.aabbOverlapMm3 || pairKey(left.a, left.b).localeCompare(pairKey(right.a, right.b)));
  const kept = pairs.slice(0, limit);
  return {
    pairs: kept,
    baselineSkipped,
    unitIds: [...new Set(kept.flatMap((pair) => [pair.aUnit, pair.bUnit]))].sort(),
    partIds: [...new Set(kept.flatMap((pair) => [pair.a, pair.b]))].sort(),
    checkedBodies: bodies.length,
    method: 'obb-envelope'
  };
}

/** 规则引擎原始摆放中已存在的跨单元重叠（作为基线，编辑后不重复提示）。 */
export function baselinePairs(bodies: readonly CollisionBody[], toleranceMm = 0.01): Set<string> {
  return new Set(detectCollisions(bodies, { toleranceMm, limit: Number.MAX_SAFE_INTEGER }).pairs.map((pair) => pairKey(pair.a, pair.b)));
}

/* ---------------------------------------------------------------- 松手后精检 */

type Point2 = [number, number];

function bodyPolygon(body: CollisionBody, segments = 32): Point2[] {
  if (body.profile.kind === 'circle') {
    const r = body.profile.radius;
    // 外切多边形（保守：面积略大于圆，偏差 < 0.33%）
    const rr = r / Math.cos(Math.PI / segments);
    return Array.from({ length: segments }, (_unused, index) => {
      const angle = (index / segments) * Math.PI * 2;
      return [body.center[0] + rr * Math.cos(angle), body.center[1] + rr * Math.sin(angle)] as Point2;
    });
  }
  const rad = body.rotationZDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const [hx, hy] = body.half;
  return ([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] as Point2[]).map(([x, y]) => [
    body.center[0] + x * cos - y * sin,
    body.center[1] + x * sin + y * cos
  ] as Point2);
}

function polygonArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i] as Point2;
    const [x2, y2] = points[(i + 1) % points.length] as Point2;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** 凸多边形求交（Sutherland–Hodgman，两者均为 CCW）。 */
export function convexIntersection(subject: readonly Point2[], clip: readonly Point2[]): Point2[] {
  let output: Point2[] = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i += 1) {
    const a = clip[i] as Point2;
    const b = clip[(i + 1) % clip.length] as Point2;
    const inside = (p: Point2): boolean => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const intersect = (p: Point2, q: Point2): Point2 => {
      const a1 = q[1] - p[1];
      const b1 = p[0] - q[0];
      const c1 = a1 * p[0] + b1 * p[1];
      const a2 = b[1] - a[1];
      const b2 = a[0] - b[0];
      const c2 = a2 * a[0] + b2 * a[1];
      const det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-12) return p;
      return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j] as Point2;
      const previous = input[(j + input.length - 1) % input.length] as Point2;
      if (inside(current)) {
        if (!inside(previous)) output.push(intersect(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(intersect(previous, current));
      }
    }
  }
  return output;
}

export interface RefinedCollision {
  a: string;
  b: string;
  /** 干涉体积（mm³） */
  volumeMm3: number;
  /** exact = 两者都是盒或竖直圆柱（多边形近似 < 0.4%）；upper-bound = 含水平圆柱，按外接盒计 */
  quality: 'exact' | 'polygon-approx' | 'upper-bound';
}

/**
 * 松手后精检：两零件 XY 截面多边形求交面积 × Z 重叠高度。盒-盒为精确体积；
 * 竖直圆柱用外切 32 边形（略偏大）；水平圆柱只能按外接盒给上界。
 * 这是基于概念占位体原始形体的解析求交，不是 build123d B-rep 布尔运算。
 */
export function refineCollision(a: CollisionBody, b: CollisionBody): RefinedCollision {
  const zLow = Math.max(a.center[2] - a.half[2], b.center[2] - b.half[2]);
  const zHigh = Math.min(a.center[2] + a.half[2], b.center[2] + b.half[2]);
  const height = Math.max(0, zHigh - zLow);
  const area = height > 0 ? Math.abs(polygonArea(convexIntersection(bodyPolygon(a), bodyPolygon(b)))) : 0;
  const quality: RefinedCollision['quality'] = a.horizontalCylinder || b.horizontalCylinder
    ? 'upper-bound'
    : a.profile.kind === 'circle' || b.profile.kind === 'circle' ? 'polygon-approx' : 'exact';
  return { a: a.id, b: b.id, volumeMm3: round(area * height), quality };
}
