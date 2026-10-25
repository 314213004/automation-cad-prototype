/**
 * 渲染规划层（P4 性能）：把导入的网格数据变成「一帧要画什么、怎么画」的计划。
 *
 * 这里只做纯计算，不碰 WebGL：
 *  - 几何指纹 → 找出可实例化（InstancedMesh）的重复零件
 *  - 包围球 + 相机 → 视锥剔除（不画看不见的）
 *  - 屏幕覆盖率 → LOD 分级（全模 / 简化 / 包围盒代理）
 *  - 汇总 drawCall 与三角面预算，供渲染器与基准脚本使用
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PartGeometryInput {
  name: string;
  positions: ArrayLike<number>;
  indices?: ArrayLike<number> | null;
  color?: [number, number, number];
}

export interface PartMeta {
  index: number;
  name: string;
  vertexCount: number;
  triangleCount: number;
  signature: string;
  colorKey: string;
  center: Vec3;
  radius: number;
  diagonal: number;
  /** 轴对齐包围盒，供 LOD2 代理盒使用 */
  bbox: { min: Vec3; max: Vec3 };
}

export type LodLevel = 0 | 1 | 2;

export interface LodConfig {
  /** 覆盖率 ≥ 该值用原始网格 */
  fullCoverage: number;
  /** 覆盖率 ≥ 该值用简化网格，低于则用包围盒代理 */
  mediumCoverage: number;
  /** 覆盖率低于该值视为不可见（剔除） */
  cullCoverage: number;
  /** 三角面数不超过该值的零件不降级（小零件简化没收益） */
  skipBelowTriangles: number;
  /** LOD1 / LOD2 的三角面保留比例 */
  ratios: [number, number, number];
  /** 同指纹零件达到该数量才合并成实例 */
  minInstanceCount: number;
}

export interface CameraState {
  position: Vec3;
  fovDeg: number;
  /** 视锥平面（世界坐标，法线朝内）；不传则不做视锥剔除 */
  planes?: FrustumPlane[] | null;
}

export interface FrustumPlane {
  normal: Vec3;
  /** 平面方程 normal·p + constant = 0 */
  constant: number;
}

export interface PartPlan {
  index: number;
  name: string;
  lod: LodLevel;
  coverage: number;
  distance: number;
  triangles: number;
  sourceTriangles: number;
  instanceKey: string | null;
  /** 世界坐标中心，实例化时用作每实例平移 */
  center: Vec3;
}

export interface InstanceGroup {
  signature: string;
  colorKey: string;
  /** 组内零件在原始 meshes 数组中的下标 */
  indices: number[];
  /** 与 indices 一一对应的世界坐标中心 */
  centers: Vec3[];
  count: number;
  triangles: number;
}

export interface FramePlan {
  parts: PartPlan[];
  instanceGroups: InstanceGroup[];
  culled: string[];
  /** 合并实例后的绘制批次数 */
  drawCalls: number;
  /** 不合并实例时的绘制批次数 */
  naiveDrawCalls: number;
  sourceTriangles: number;
  visibleTriangles: number;
  warnings: string[];
}

export const DEFAULT_LOD_CONFIG: LodConfig = {
  fullCoverage: 0.18,
  mediumCoverage: 0.045,
  cullCoverage: 0.0015,
  skipBelowTriangles: 2000,
  ratios: [1, 0.35, 0.04],
  minInstanceCount: 2
};

const EPSILON = 1e-9;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 配置自检：非法阈值直接抛中文错误，避免「静默不生效」 */
export function normalizeLodConfig(input?: Partial<LodConfig> | null): LodConfig {
  const config: LodConfig = { ...DEFAULT_LOD_CONFIG, ...(input ?? {}) };
  if (!(config.fullCoverage > 0)) throw new Error('LOD 配置错误：满精度覆盖率阈值必须大于 0');
  if (!(config.mediumCoverage > 0)) throw new Error('LOD 配置错误：简化覆盖率阈值必须大于 0');
  if (config.mediumCoverage >= config.fullCoverage) {
    throw new Error('LOD 配置错误：简化阈值必须小于满精度阈值');
  }
  if (!(config.cullCoverage > 0)) throw new Error('LOD 配置错误：剔除覆盖率阈值必须大于 0');
  if (config.cullCoverage >= config.mediumCoverage) {
    throw new Error('LOD 配置错误：剔除阈值必须小于简化阈值');
  }
  if (config.ratios.length !== 3 || config.ratios[0] !== 1) {
    throw new Error('LOD 配置错误：三角面比例必须是 [1, 简化比, 代理比]');
  }
  for (const ratio of config.ratios.slice(1)) {
    if (!(ratio > 0 && ratio < 1)) throw new Error('LOD 配置错误：简化与代理比例必须在 0 到 1 之间');
  }
  if (!Number.isInteger(config.minInstanceCount) || config.minInstanceCount < 2) {
    throw new Error('LOD 配置错误：实例合并至少需要 2 个同款零件');
  }
  if (!Number.isInteger(config.skipBelowTriangles) || config.skipBelowTriangles < 0) {
    throw new Error('LOD 配置错误：小零件三角面阈值必须是非负整数');
  }
  return config;
}

/** FNV-1a 32 位哈希，量化到 0.001mm 以吞掉浮点噪声；origin 用于抹掉整体平移 */
export function hashGeometry(
  positions: ArrayLike<number>,
  indices?: ArrayLike<number> | null,
  origin?: Vec3 | null
): string {
  let hash = 0x811c9dc5;
  const push = (value: number): void => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  const ox = origin?.x ?? 0;
  const oy = origin?.y ?? 0;
  const oz = origin?.z ?? 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const qx = Math.round(((positions[i] ?? 0) - ox) * 1000) | 0;
    const qy = Math.round(((positions[i + 1] ?? 0) - oy) * 1000) | 0;
    const qz = Math.round(((positions[i + 2] ?? 0) - oz) * 1000) | 0;
    push(qx);
    push(qx >>> 8);
    push(qx >>> 16);
    push(qx >>> 24);
    push(qy);
    push(qy >>> 8);
    push(qy >>> 16);
    push(qy >>> 24);
    push(qz);
    push(qz >>> 8);
    push(qz >>> 16);
    push(qz >>> 24);
  }
  if (indices && indices.length > 0) {
    push(0x1d);
    for (let i = 0; i < indices.length; i += 1) push(indices[i] ?? 0);
  }
  return `${positions.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

function colorKeyOf(color?: [number, number, number]): string {
  return color ? color.map((v) => v.toFixed(3)).join(',') : 'default';
}

/** 单零件元数据：三角面数、包围球（AABB 外接球，够用且不引入依赖） */
export function buildPartMeta(mesh: PartGeometryInput, index: number): PartMeta {
  const positions = mesh.positions;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const vertexCount = Math.floor(positions.length / 3);
  const empty = vertexCount === 0;
  const center: Vec3 = empty
    ? { x: 0, y: 0, z: 0 }
    : { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
  const diagonal = empty ? 0 : Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const indices = mesh.indices ?? null;
  const triangleCount = indices && indices.length > 0
    ? Math.floor(indices.length / 3)
    : Math.floor(vertexCount / 3);
  return {
    index,
    name: mesh.name,
    vertexCount,
    triangleCount,
    signature: empty ? `empty-${index}` : hashGeometry(positions, indices, center),
    colorKey: colorKeyOf(mesh.color),
    center,
    radius: diagonal / 2,
    diagonal,
    bbox: empty
      ? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
      : { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
  };
}

export function buildPartMetas(meshes: readonly PartGeometryInput[]): PartMeta[] {
  return meshes.map((mesh, index) => buildPartMeta(mesh, index));
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 覆盖率：零件包围球在竖直视野里占的比例（0~1，1 表示撑满画面高度） */
export function screenCoverage(radius: number, distance: number, fovDeg: number): number {
  if (!(radius > 0) || !(distance > 0) || !(fovDeg > 0 && fovDeg < 180)) return 0;
  const halfFov = (fovDeg * Math.PI) / 360;
  const halfHeightAtDistance = Math.tan(halfFov) * distance;
  if (halfHeightAtDistance <= EPSILON) return 0;
  return clamp01(radius / halfHeightAtDistance);
}

export function chooseLod(coverage: number, triangleCount: number, config: LodConfig = DEFAULT_LOD_CONFIG): LodLevel {
  if (coverage < config.cullCoverage) return 0; // 调用方按剔除处理，这里保持 0
  if (triangleCount <= config.skipBelowTriangles) return 0;
  if (coverage >= config.fullCoverage) return 0;
  if (coverage >= config.mediumCoverage) return 1;
  return 2;
}

export function lodTriangleCount(triangleCount: number, lod: LodLevel, config: LodConfig = DEFAULT_LOD_CONFIG): number {
  if (triangleCount <= 0) return 0;
  const ratio = config.ratios[lod] ?? 1;
  if (ratio >= 1) return triangleCount;
  return Math.max(1, Math.round(triangleCount * ratio));
}

/** 包围球 vs 视锥：只要有一个平面把球完全挡在外面就剔除 */
/**
 * 从「投影 × 视图」矩阵提取 6 个视锥平面（Gribb–Hartmann）。
 *
 * 正确公式是对矩阵行的加/减，不是单取某一行：
 *   left = row3 + row0, right = row3 - row0,
 *   bottom = row3 + row1, top = row3 - row1,
 *   near = row3 + row2, far = row3 - row2
 *
 * 过去的实现里近/左都直接用了 row3、远用 -row2，视锥是畸形的，
 * 结果整机被判定「视锥外」而隐藏（describeScene 里能看到 hidden）。
 * 平面法向约定：n·p + c ≥ 0 为视锥内。
 */
export function frustumPlanesFromClipElements(elements: readonly number[]): FrustumPlane[] {
  const at = (index: number): number => elements[index] ?? 0;
  const row = (index: number): [number, number, number, number] => [
    at(index),
    at(index + 4),
    at(index + 8),
    at(index + 12)
  ];
  const row0 = row(0);
  const row1 = row(1);
  const row2 = row(2);
  const row3 = row(3);
  const combine = (a: number[], b: number[], signB: number): FrustumPlane => {
    const nx = (a[0] ?? 0) + (b[0] ?? 0) * signB;
    const ny = (a[1] ?? 0) + (b[1] ?? 0) * signB;
    const nz = (a[2] ?? 0) + (b[2] ?? 0) * signB;
    const c = (a[3] ?? 0) + (b[3] ?? 0) * signB;
    const length = Math.hypot(nx, ny, nz) || 1;
    return { normal: { x: nx / length, y: ny / length, z: nz / length }, constant: c / length };
  };
  return [
    combine(row3, row0, 1), // left
    combine(row3, row0, -1), // right
    combine(row3, row1, 1), // bottom
    combine(row3, row1, -1), // top
    combine(row3, row2, 1), // near
    combine(row3, row2, -1) // far
  ];
}

export function isSphereVisible(planes: readonly FrustumPlane[] | null | undefined, center: Vec3, radius: number): boolean {
  if (!planes || planes.length === 0) return true;
  for (const plane of planes) {
    const distance = plane.normal.x * center.x + plane.normal.y * center.y + plane.normal.z * center.z + plane.constant;
    if (distance < -radius) return false;
  }
  return true;
}

export function instanceGroupsOf(parts: readonly PartPlan[], config: LodConfig = DEFAULT_LOD_CONFIG): InstanceGroup[] {
  const buckets = new Map<string, InstanceGroup>();
  for (const part of parts) {
    if (part.lod !== 0 || !part.instanceKey) continue;
    const key = part.instanceKey;
    const existing = buckets.get(key);
    if (existing) {
      existing.indices.push(part.index);
      existing.centers.push(part.center);
      existing.count += 1;
      existing.triangles += part.triangles;
    } else {
      buckets.set(key, {
        signature: key,
        colorKey: key.split('::')[1] ?? 'default',
        indices: [part.index],
        centers: [part.center],
        count: 1,
        triangles: part.triangles
      });
    }
  }
  const groups: InstanceGroup[] = [];
  for (const group of buckets.values()) {
    if (group.count >= config.minInstanceCount) groups.push(group);
  }
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

/**
 * 生成一帧的渲染计划。
 * 返回的 instanceGroups 只包含 LOD0 的同指纹零件——简化网格与代理盒形状不同，不能合批。
 */
export function planFrame(
  metas: readonly PartMeta[],
  camera: CameraState,
  options?: { config?: Partial<LodConfig> | null }
): FramePlan {
  const config = normalizeLodConfig(options?.config);
  const warnings: string[] = [];
  const parts: PartPlan[] = [];
  const culled: string[] = [];
  let sourceTriangles = 0;

  for (const meta of metas) {
    sourceTriangles += meta.triangleCount;
    if (meta.triangleCount <= 0) {
      warnings.push(`零件「${meta.name}」没有三角面，已跳过`);
      culled.push(meta.name);
      continue;
    }
    if (!isSphereVisible(camera.planes, meta.center, meta.radius)) {
      culled.push(meta.name);
      continue;
    }
    const distance = distanceBetween(camera.position, meta.center);
    const coverage = screenCoverage(meta.radius, distance, camera.fovDeg);
    if (coverage < config.cullCoverage) {
      culled.push(meta.name);
      continue;
    }
    const lod = chooseLod(coverage, meta.triangleCount, config);
    const triangles = lodTriangleCount(meta.triangleCount, lod, config);
    parts.push({
      index: meta.index,
      name: meta.name,
      lod,
      coverage,
      distance,
      triangles,
      sourceTriangles: meta.triangleCount,
      instanceKey: `${meta.signature}::${meta.colorKey}`,
      center: meta.center
    });
  }

  const instanceGroups = instanceGroupsOf(parts, config);
  const instancedPartCount = instanceGroups.reduce((sum, group) => sum + group.count, 0);
  const naiveDrawCalls = parts.length;
  const drawCalls = parts.length - instancedPartCount + instanceGroups.length;
  const visibleTriangles = parts.reduce((sum, part) => sum + part.triangles, 0);

  if (culled.length > 0 && metas.length === culled.length) {
    warnings.push('当前视角下所有零件都不可见，请检查相机位置或模型单位');
  }
  if (drawCalls > 1500) {
    warnings.push(`本帧 drawCall 预计 ${drawCalls}，超过 1500 会明显掉帧，建议降低可见零件数`);
  }

  return {
    parts,
    instanceGroups,
    culled,
    drawCalls,
    naiveDrawCalls,
    sourceTriangles,
    visibleTriangles,
    warnings
  };
}

/** 首帧是否达标（默认 3 秒预算，只统计导入 + 计划耗时） */
export function withinFrameBudget(elapsedMs: number, budgetMs = 3000): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= budgetMs;
}

export function describePlan(plan: FramePlan, elapsedMs?: number): string {
  const savedCalls = plan.naiveDrawCalls - plan.drawCalls;
  const savedRatio = plan.naiveDrawCalls > 0 ? (savedCalls / plan.naiveDrawCalls) * 100 : 0;
  const parts: string[] = [
    `可见 ${plan.parts.length}/${plan.parts.length + plan.culled.length} 个零件`,
    `drawCall ${plan.drawCalls}（实例合并省 ${savedCalls}，${savedRatio.toFixed(0)}%）`,
    `三角面 ${plan.visibleTriangles.toLocaleString('zh-CN')}/${plan.sourceTriangles.toLocaleString('zh-CN')}`
  ];
  if (plan.instanceGroups.length > 0) {
    const shown = plan.instanceGroups.slice(0, 3).map((g) => `${g.count}×${g.signature.split('::')[0]!.slice(0, 8)}`);
    const more = plan.instanceGroups.length > shown.length ? ` 等` : '';
    parts.push(`实例组 ${plan.instanceGroups.length}（${shown.join('、')}${more}）`);
  }
  if (typeof elapsedMs === 'number') {
    parts.push(`耗时 ${elapsedMs.toFixed(1)}ms ${withinFrameBudget(elapsedMs) ? '达标' : '超 3s 预算'}`);
  }
  return parts.join(' · ');
}
