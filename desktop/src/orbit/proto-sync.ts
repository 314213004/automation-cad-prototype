/**
 * 从原型 DOM 读回缸径 / 行程（纯函数部分）。
 *
 * 原型的 `state` 是模块级 const，没有导出；属性面板只在选中气缸时才有输入框。
 * 撤销/重做/「写入装配」发生在别的零件被选中时，唯一可见的结果是重新挂载的等轴测 SVG。
 * 因此：有输入框时直接读（精确）；没有时从 SVG 反算近似值，再吸附到「见过的精确值」
 * （用户输入过的值、初始值、标准缸径/行程表）。反算误差：缸径 ±0.13 mm、行程 ±0.9 mm。
 */

/** 原型 cylShape：椭圆 rx = r·1.2247，r = 4 + bore·0.32。 */
export function boreFromEllipseRx(rx: number): number {
  return (rx / 1.2247 - 4) / 0.32;
}

/**
 * 原型活塞杆路径 `M x,y0 L x,y1 A ...`：y0 − y1 = rodTop − (bodyTop + 6) = 10 + stroke·0.12。
 */
export function strokeFromRodPath(d: string): number | null {
  const match = /^\s*M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/i.exec(d);
  if (!match) return null;
  const y0 = Number(match[2]);
  const y1 = Number(match[4]);
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
  return (y0 - y1 - 10) / 0.12;
}

export const STANDARD_BORES = [12, 16, 20, 25, 32, 40, 50, 63] as const;
export const STANDARD_STROKES = [10, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 125, 150, 175, 200] as const;

export const BORE_TOLERANCE = 0.2;
export const STROKE_TOLERANCE = 1.0;

/**
 * 把近似值吸附到候选池里最近的值（候选按原型的夹紧规则比较）。
 * 池里越靠后越新：距离相同时取较新的。没有候选在容差内时返回四舍五入到 0.1 的近似值。
 */
export function snapValue(
  approx: number,
  pool: readonly number[],
  tolerance: number,
  clampFn: (v: number) => number = (v) => v
): { value: number; exact: boolean } {
  let best: number | null = null;
  let bestDistance = Infinity;
  pool.forEach((candidate) => {
    if (!Number.isFinite(candidate)) return;
    const distance = Math.abs(clampFn(candidate) - approx);
    if (distance <= tolerance && distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  });
  if (best !== null) return { value: best, exact: true };
  return { value: Math.round(approx * 10) / 10, exact: false };
}

/** 候选池：去重后把最新值放到末尾，长度上限防止无界增长。 */
export function pushCandidate(pool: number[], value: unknown, limit = 64): number[] {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || String(value ?? '').trim() === '') return pool;
  const next = pool.filter((item) => item !== n);
  next.push(n);
  return next.length > limit ? next.slice(next.length - limit) : next;
}
