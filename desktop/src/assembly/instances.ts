/**
 * 装配实例（标准件放到场景里的那一份）的纯数据与几何计算。
 *
 * 约定：场景是 **Z 轴向上**（相机 up = (0,0,1)），所以贴合计算也按 Z-up：
 * - 命中面的法向 n 决定实例的朝向（实例自身 +Z 对齐 n）
 * - 落位点沿 n 抬高「实例厚度的一半」，避免嵌进被贴的面里
 */

import type { PartDims } from './dims.ts';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface AssemblyInstance {
  /** 实例 id（与标准件 id 区分：同一零件可以放多次） */
  id: string;
  partId: string;
  model: string;
  category: string;
  vendor: string;
  dims: PartDims;
  position: Vec3;
  quaternion: Quat;
  /** 贴合来源：命中已有零件表面 / 落在基准面 Z=0 */
  snappedTo: 'surface' | 'ground';
}

export interface SurfaceHit {
  point: Vec3;
  normal: Vec3;
}

let counter = 0;

export function nextInstanceId(partId = 'part'): string {
  counter += 1;
  return `asm-${partId.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${counter}`;
}

/** 仅供测试重置自增序号 */
export function resetInstanceCounter(): void {
  counter = 0;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < 1e-9) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** 把实例自身的 +Z 轴对齐到目标法向的四元数 */
export function quaternionFromNormal(normal: Vec3): Quat {
  const [nx, ny, nz] = normalize(normal);
  // +Z = (0,0,1) 与 n 之间的最短弧
  const dot = Math.min(1, Math.max(-1, nz));
  if (dot > 1 - 1e-9) return [0, 0, 0, 1];
  if (dot < -1 + 1e-9) return [1, 0, 0, 0]; // 180° 绕 X
  // axis = z × n = (-ny, nx, 0)
  const ax = -ny;
  const ay = nx;
  const len = Math.hypot(ax, ay);
  if (len < 1e-9) return [0, 0, 0, 1];
  const half = Math.acos(dot) / 2;
  const s = Math.sin(half) / len;
  return [ax * s, ay * s, 0, Math.cos(half)];
}

/** 实例沿法向的半厚度：落位点要抬高这么多，表面才刚好接触 */
export function surfaceOffset(dims: PartDims, normal: Vec3): number {
  const [sx, sy, sz] = dims.size;
  if (dims.shape === 'cylinder' && dims.diameter !== null) {
    // 轴线沿 X，贴到面上时接触的是 Z 向半径
    return Math.max(0.1, sz / 2);
  }
  const [nx, ny, nz] = normalize(normal);
  // 盒体沿法向的半投影：|nx|*sx/2 + |ny|*sy/2 + |nz|*sz/2
  return Math.max(0.1, (Math.abs(nx) * sx + Math.abs(ny) * sy + Math.abs(nz) * sz) / 2);
}

export function snapPosition(hit: SurfaceHit, dims: PartDims): Vec3 {
  const offset = surfaceOffset(dims, hit.normal);
  const [nx, ny, nz] = normalize(hit.normal);
  return [
    round(hit.point[0] + nx * offset),
    round(hit.point[1] + ny * offset),
    round(hit.point[2] + nz * offset)
  ];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface CreateInstanceInput {
  partId: string;
  model: string;
  category: string;
  vendor: string;
  dims: PartDims;
  hit: SurfaceHit;
}

export function createInstance(input: CreateInstanceInput): AssemblyInstance {
  return {
    id: nextInstanceId(input.partId || input.model || 'part'),
    partId: input.partId,
    model: input.model,
    category: input.category,
    vendor: input.vendor,
    dims: input.dims,
    position: snapPosition(input.hit, input.dims),
    quaternion: quaternionFromNormal(input.hit.normal),
    snappedTo: Math.abs(input.hit.normal[2]) > 0.999 && Math.abs(input.hit.point[2]) < 1e-6 ? 'ground' : 'surface'
  };
}
