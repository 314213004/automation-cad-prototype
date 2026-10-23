/**
 * 主视口相机数学（纯函数，不依赖 three / DOM，便于 Node 单测）。
 *
 * 约定：毫米、Z 轴向上、右手系；「前视」= 从 -Y 看向 +Y。
 */
export type Vec3 = [number, number, number];

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export const STANDARD_VIEWS: readonly StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];

export const VIEW_LABELS: Record<StandardView, string> = {
  front: '前视',
  back: '后视',
  left: '左视',
  right: '右视',
  top: '俯视',
  bottom: '仰视',
  iso: '等轴测'
};

/** 俯/仰视与 Z-up 的 OrbitControls 正好共线会退化；偏一个极小量，屏幕上方仍是 +Y。 */
const POLE_EPSILON = 1e-4;

export function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length === 0) throw new Error('零向量无法归一化');
  return [v[0] / length, v[1] / length, v[2] / length];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 从观察目标指向相机的单位向量 + 相机 up。 */
export function standardViewDirection(view: StandardView): { dir: Vec3; up: Vec3 } {
  const up: Vec3 = [0, 0, 1];
  switch (view) {
    case 'front': return { dir: [0, -1, 0], up };
    case 'back': return { dir: [0, 1, 0], up };
    case 'left': return { dir: [-1, 0, 0], up };
    case 'right': return { dir: [1, 0, 0], up };
    case 'top': return { dir: normalize([0, -POLE_EPSILON, 1]), up };
    case 'bottom': return { dir: normalize([0, -POLE_EPSILON, -1]), up };
    case 'iso': return { dir: normalize([1, -1, 1]), up };
    default: {
      const never: never = view;
      throw new Error(`未知标准视图：${String(never)}`);
    }
  }
}

export function isStandardView(value: unknown): value is StandardView {
  return typeof value === 'string' && (STANDARD_VIEWS as readonly string[]).includes(value);
}

export function emptyBounds(): Bounds3 {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function isEmptyBounds(bounds: Bounds3): boolean {
  return !(bounds.min[0] <= bounds.max[0] && bounds.min[1] <= bounds.max[1] && bounds.min[2] <= bounds.max[2]);
}

export function unionBounds(list: readonly Bounds3[]): Bounds3 {
  const out = emptyBounds();
  for (const b of list) {
    for (let axis = 0; axis < 3; axis += 1) {
      out.min[axis] = Math.min(out.min[axis] as number, b.min[axis] as number);
      out.max[axis] = Math.max(out.max[axis] as number, b.max[axis] as number);
    }
  }
  return out;
}

export function boundsCenter(b: Bounds3): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** 包围球半径（包围盒半对角线）。 */
export function boundsRadius(b: Bounds3): number {
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
}

/**
 * 透视相机完整装下半径 radius 的包围球所需距离。
 * 取竖直/水平半视角中较小者，窄窗口时不会裁掉两侧。
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.15): number {
  if (!(radius > 0)) return 1;
  if (!(fovDeg > 0 && fovDeg < 180)) throw new Error('视角必须在 (0, 180) 度之间');
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * safeAspect);
  return (radius * margin) / Math.sin(Math.min(halfV, halfH));
}

/** 正交相机装下包围球的视锥（zoom=1）。 */
export function orthoFrustum(radius: number, aspect: number, margin = 1.15): {
  left: number; right: number; top: number; bottom: number;
} {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const r = Math.max(radius, 1e-6) * margin;
  let halfH = r;
  let halfW = r * safeAspect;
  if (safeAspect < 1) {
    halfW = r;
    halfH = r / safeAspect;
  }
  return { left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  distance: number;
}

/** 标准视图 + 全部可见：目标是包围盒中心，相机沿视图方向退到 fitDistance。 */
export function poseForView(view: StandardView, bounds: Bounds3, fovDeg: number, aspect: number, margin = 1.15): CameraPose {
  const { dir, up } = standardViewDirection(view);
  return poseAlong(dir, up, bounds, fovDeg, aspect, margin);
}

/** 保持当前视线方向，仅重新取景（适合 / Fit all）。 */
export function poseAlong(dir: Vec3, up: Vec3, bounds: Bounds3, fovDeg: number, aspect: number, margin = 1.15): CameraPose {
  const unit = normalize(dir);
  const empty = isEmptyBounds(bounds);
  const target: Vec3 = empty ? [0, 0, 0] : boundsCenter(bounds);
  const radius = empty ? 100 : Math.max(boundsRadius(bounds), 1);
  const distance = fitDistance(radius, fovDeg, aspect, margin);
  return {
    position: [target[0] + unit[0] * distance, target[1] + unit[1] * distance, target[2] + unit[2] * distance],
    target,
    up,
    distance
  };
}

/** 透视 → 正交：在目标平面处保持同样的可见高度。 */
export function perspectiveToOrthoHalfHeight(distance: number, fovDeg: number): number {
  return distance * Math.tan((fovDeg * Math.PI) / 360);
}

/** 正交 → 透视：反求相机距离，使切换前后模型大小一致。 */
export function orthoToPerspectiveDistance(halfHeight: number, zoom: number, fovDeg: number): number {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return halfHeight / z / Math.tan((fovDeg * Math.PI) / 360);
}

/**
 * 把单位世界轴投到屏幕二维（视口右下角的坐标轴指示器）。
 * right/up 为相机在世界中的右、上方向；返回 y 向下的屏幕偏移（长度 ≤ 1）。
 */
export function projectAxes(right: Vec3, up: Vec3): Record<'x' | 'y' | 'z', [number, number]> {
  const axes: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const out = {} as Record<'x' | 'y' | 'z', [number, number]>;
  (Object.keys(axes) as Array<'x' | 'y' | 'z'>).forEach((key) => {
    out[key] = [dot(axes[key], right), -dot(axes[key], up)];
  });
  return out;
}

/** 视线方向最接近哪个标准视图（HUD 显示用；偏离较多返回 null = 自由视角）。 */
export function nearestStandardView(dir: Vec3, toleranceDeg = 3): StandardView | null {
  const unit = normalize(dir);
  let best: StandardView | null = null;
  let bestDot = Math.cos((toleranceDeg * Math.PI) / 180);
  for (const view of STANDARD_VIEWS) {
    const d = dot(unit, standardViewDirection(view).dir);
    if (d >= bestDot) {
      bestDot = d;
      best = view;
    }
  }
  return best;
}
