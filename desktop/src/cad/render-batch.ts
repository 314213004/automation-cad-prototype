/**
 * 渲染批次层（P4 性能）：把 `planFrame` 的结论变成渲染器能直接照做的「指令表」。
 *
 * 这一层仍然不引用 three，只产出纯数据：
 *  - 每个可见零件：用哪级 LOD / 多少三角面
 *  - 每个可合批实例组：归零后的几何数据 + 每实例平移矩阵
 *  - 被剔除（不画）的零件下标
 * 渲染器只负责「照着开关可见性、换几何、塞矩阵」，逻辑本身可以单测。
 */

import type { FramePlan, LodLevel, PartMeta, Vec3 } from './render-plan.ts';

export interface MeshSource {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number> | null;
  indices?: ArrayLike<number> | null;
}

export interface RenderPartOp {
  kind: 'part';
  partIndex: number;
  lod: LodLevel;
  triangles: number;
}

export interface RenderInstanceOp {
  kind: 'instance';
  signature: string;
  colorKey: string;
  /** 与 matrices 一一对应 */
  partIndices: number[];
  centers: Vec3[];
  /** 每实例 16 个 float 的平移矩阵，列主序（可直接喂给 THREE.Matrix4.fromArray） */
  matrices: Float32Array;
  triangles: number;
}

export type RenderOp = RenderPartOp | RenderInstanceOp;

export interface RenderOps {
  ops: RenderOp[];
  /** 本帧不画的零件下标（视锥外或覆盖率为 0） */
  hidden: number[];
  /** LOD0 / LOD1 / LOD2 各多少个零件 */
  lodCounts: [number, number, number];
  drawCalls: number;
  triangles: number;
  instanceGroups: number;
  warnings: string[];
}

export interface CenteredGeometry {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  triangleCount: number;
  center: Vec3;
}

function translationMatrix(center: Vec3): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  matrix[12] = center.x;
  matrix[13] = center.y;
  matrix[14] = center.z;
  return matrix;
}

function trianglesOf(source: MeshSource): number {
  const indices = source.indices;
  if (indices && indices.length > 0) return Math.floor(indices.length / 3);
  return Math.floor(source.positions.length / 9);
}

/**
 * 把零件几何整体平移到原点（减去中心），这样同款零件可以共用一份几何 + 每实例平移矩阵。
 * 世界坐标 = 归零坐标 + center，因此实例矩阵是纯平移。
 */
export function centerGeometry(source: MeshSource, center: Vec3): CenteredGeometry {
  const positions = new Float32Array(source.positions.length);
  for (let i = 0; i + 2 < source.positions.length; i += 3) {
    positions[i] = (source.positions[i] ?? 0) - center.x;
    positions[i + 1] = (source.positions[i + 1] ?? 0) - center.y;
    positions[i + 2] = (source.positions[i + 2] ?? 0) - center.z;
  }
  let normals: Float32Array | null = null;
  const sourceNormals = source.normals;
  if (sourceNormals && sourceNormals.length >= 3) {
    normals = new Float32Array(positions.length);
    for (let i = 0; i + 2 < sourceNormals.length; i += 3) {
      normals[i] = sourceNormals[i] ?? 0;
      normals[i + 1] = sourceNormals[i + 1] ?? 0;
      normals[i + 2] = sourceNormals[i + 2] ?? 0;
    }
  }
  let indices: Uint32Array | null = null;
  const sourceIndices = source.indices;
  if (sourceIndices && sourceIndices.length > 0) {
    indices = new Uint32Array(sourceIndices.length);
    for (let i = 0; i < sourceIndices.length; i += 1) indices[i] = sourceIndices[i] ?? 0;
  }
  return {
    positions,
    normals,
    indices,
    triangleCount: trianglesOf(source),
    center: { x: center.x, y: center.y, z: center.z }
  };
}

/**
 * 简化网格：按固定步长抽样三角面并展开成非索引三角形。
 * 抽样是确定性的（同一输入必得同一输出），避免每次相机移动产生抖动。
 */
export function decimateMesh(
  source: MeshSource,
  ratio: number
): { positions: Float32Array; normals: Float32Array | null; triangleCount: number } {
  const total = trianglesOf(source);
  if (total <= 0) {
    return { positions: new Float32Array(0), normals: null, triangleCount: 0 };
  }
  const keepRatio = Number.isFinite(ratio) ? Math.min(1, Math.max(0.0001, ratio)) : 1;
  const stride = keepRatio >= 1 ? 1 : Math.max(2, Math.round(1 / keepRatio));
  const indices = source.indices;
  const positions = source.positions;
  const sourceNormals = source.normals && source.normals.length >= 3 ? source.normals : null;

  const kept: number[] = [];
  for (let triangle = 0; triangle < total; triangle += stride) kept.push(triangle);

  const out = new Float32Array(kept.length * 9);
  const outNormals = sourceNormals ? new Float32Array(kept.length * 9) : null;
  let cursor = 0;
  for (const triangle of kept) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices && indices.length > 0
        ? indices[triangle * 3 + corner] ?? 0
        : triangle * 3 + corner;
      out[cursor] = positions[vertex * 3] ?? 0;
      out[cursor + 1] = positions[vertex * 3 + 1] ?? 0;
      out[cursor + 2] = positions[vertex * 3 + 2] ?? 0;
      if (outNormals && sourceNormals) {
        outNormals[cursor] = sourceNormals[vertex * 3] ?? 0;
        outNormals[cursor + 1] = sourceNormals[vertex * 3 + 1] ?? 0;
        outNormals[cursor + 2] = sourceNormals[vertex * 3 + 2] ?? 0;
      }
      cursor += 3;
    }
  }
  return { positions: out, normals: outNormals, triangleCount: kept.length };
}

/** 包围盒代理：LOD2 只画一个盒子，12 个三角面，位置贴着零件真实包围盒 */
export function boxProxyGeometry(meta: PartMeta): { positions: Float32Array; normals: Float32Array; triangleCount: number } {
  const { min, max } = meta.bbox;
  const x0 = min.x;
  const y0 = min.y;
  const z0 = min.z;
  const x1 = max.x;
  const y1 = max.y;
  const z1 = max.z;
  const corners: Array<[number, number, number]> = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ];
  const faces: Array<[number, number, number, number]> = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7]
  ];
  const positions = new Float32Array(12 * 9);
  const normals = new Float32Array(12 * 9);
  let cursor = 0;
  for (const [a, b, c, d] of faces) {
    const quad = [a, b, c, a, c, d];
    for (const cornerIndex of quad) {
      const corner = corners[cornerIndex]!;
      positions[cursor] = corner[0];
      positions[cursor + 1] = corner[1];
      positions[cursor + 2] = corner[2];
      cursor += 3;
    }
  }
  // 法线用面法线：每个四边形 6 个顶点共用一条
  let normalCursor = 0;
  for (const [a, b, c] of faces) {
    const p0 = corners[a]!;
    const p1 = corners[b]!;
    const p2 = corners[c]!;
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (let vertex = 0; vertex < 6; vertex += 1) {
      normals[normalCursor] = nx;
      normals[normalCursor + 1] = ny;
      normals[normalCursor + 2] = nz;
      normalCursor += 3;
    }
  }
  return { positions, normals, triangleCount: 12 };
}

/**
 * 生成一帧的渲染指令表。
 * 注意：实例组只会包含 LOD0 的零件（简化几何形状不同，不能和全模合批）。
 */
export function buildRenderOps(plan: FramePlan, metas: readonly PartMeta[]): RenderOps {
  const metaByIndex = new Map<number, PartMeta>();
  for (const meta of metas) metaByIndex.set(meta.index, meta);

  const visible = new Set<number>();
  const lodCounts: [number, number, number] = [0, 0, 0];
  for (const part of plan.parts) {
    visible.add(part.index);
    lodCounts[part.lod] += 1;
  }

  const hidden: number[] = [];
  for (const meta of metas) {
    if (!visible.has(meta.index)) hidden.push(meta.index);
  }

  const instances: RenderInstanceOp[] = [];
  const instanced = new Set<number>();
  for (const group of plan.instanceGroups) {
    const matrices = new Float32Array(group.centers.length * 16);
    group.centers.forEach((center, offset) => {
      matrices.set(translationMatrix(center), offset * 16);
    });
    for (const index of group.indices) instanced.add(index);
    instances.push({
      kind: 'instance',
      signature: group.signature,
      colorKey: group.colorKey,
      partIndices: [...group.indices],
      centers: group.centers.map((center) => ({ ...center })),
      matrices,
      triangles: group.triangles
    });
  }

  const singles: RenderPartOp[] = [];
  for (const part of plan.parts) {
    if (instanced.has(part.index)) continue;
    singles.push({ kind: 'part', partIndex: part.index, lod: part.lod, triangles: part.triangles });
  }

  const ops: RenderOp[] = [...instances, ...singles];
  const warnings = [...plan.warnings];
  if (instances.length > 0) {
    const first = instances[0]!;
    if (metaByIndex.size > 0 && !metaByIndex.has(first.partIndices[0] ?? -1)) {
      warnings.push('实例组包含未知零件下标，已跳过合批');
    }
  }

  return {
    ops,
    hidden,
    lodCounts,
    drawCalls: ops.length,
    triangles: plan.parts.reduce((sum, part) => sum + part.triangles, 0),
    instanceGroups: instances.length,
    warnings
  };
}

export function describeRenderOps(ops: RenderOps): string {
  const [lod0, lod1, lod2] = ops.lodCounts;
  const parts: string[] = [
    `绘制 ${ops.drawCalls} 批（实例组 ${ops.instanceGroups}）`,
    `LOD ${lod0}/${lod1}/${lod2}`,
    `三角面 ${ops.triangles.toLocaleString('zh-CN')}`
  ];
  if (ops.hidden.length > 0) parts.push(`剔除 ${ops.hidden.length} 件`);
  return parts.join(' · ');
}
