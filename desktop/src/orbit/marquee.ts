/**
 * WebGL 模式框选（纯计算，只用 three 核心，可在 Node 单测）。
 *
 * 命中规则与原型 `bindMarquee()` 一致：零件的**屏幕包围矩形与框相交**即命中（不要求完全包含）。
 * 原型用 SVG `getBoundingClientRect()`；这里把零件 3D 包围盒 8 个角点经当前相机投影到屏幕，
 * 取其外接矩形。开着剖切时，完全落在剖切面之后（被裁掉）的零件不参与命中。
 */
import * as THREE from 'three';
import type { Bounds3 } from './camera.ts';
import type { Assembly } from './model.ts';

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 两个拖拽点 → 规范化矩形。 */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
}

/** 与原型相同的「相交即命中」判断（边界相接算命中）。 */
export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/**
 * 包围盒 → 屏幕矩形（客户端像素）。角点全部在相机后方时返回 null；
 * 部分角点在后方时只用前方角点（透视下极端视角的近似，足够框选使用）。
 */
export function projectBounds(bounds: Bounds3, camera: THREE.Camera, viewport: Viewport): ScreenRect | null {
  camera.updateMatrixWorld();
  const v = new THREE.Vector3();
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let any = false;
  for (let i = 0; i < 8; i += 1) {
    v.set(
      i & 1 ? bounds.max[0] : bounds.min[0],
      i & 2 ? bounds.max[1] : bounds.min[1],
      i & 4 ? bounds.max[2] : bounds.min[2]
    ).project(camera);
    if (v.z < -1 || v.z > 1) continue;
    any = true;
    const x = viewport.left + (v.x + 1) * 0.5 * viewport.width;
    const y = viewport.top + (1 - v.y) * 0.5 * viewport.height;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return any ? { left, top, right, bottom } : null;
}

/**
 * 框内零件（保持装配顺序）。`clipX` 为剖切面 X：开剖切时只保留 x ≤ clipX 的部分，
 * 包围盒完全在其后的零件不命中，部分被切的零件按切后包围盒投影。
 */
export function partsInRect(
  assembly: Assembly,
  camera: THREE.Camera,
  viewport: Viewport,
  rect: ScreenRect,
  clipX: number | null = null
): string[] {
  const out: string[] = [];
  for (const part of assembly.parts) {
    let bounds = part.bbox;
    if (clipX !== null) {
      if (bounds.min[0] > clipX) continue;
      if (bounds.max[0] > clipX) bounds = { min: [bounds.min[0], bounds.min[1], bounds.min[2]], max: [clipX, bounds.max[1], bounds.max[2]] };
    }
    const screen = projectBounds(bounds, camera, viewport);
    if (screen && rectsIntersect(screen, rect)) out.push(part.id);
  }
  return out;
}
