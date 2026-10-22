/**
 * 电箱底板布局的纯几何层。
 *
 * 全部尺寸单位为毫米，Placement 的 x/y 表示矩形左上角。这里不依赖 DOM，
 * 便于对吸附、碰撞、钳制与利用率做独立单测。
 */

export interface Placement {
  id: string;
  partId: string;
  model: string;
  x: number;
  y: number;
  w: number;
  h: number;
  railId?: string;
}

export interface Rail {
  id: string;
  y: number;
  height: number;
  label: string;
}

export interface PlateSpec {
  width: number;
  height: number;
  rails: Rail[];
}

export function snapMm(value: number, grid = 1): number {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0) return 0;
  const snapped = Math.round(value / grid) * grid;
  return Math.abs(snapped) < 1e-9 ? 0 : Number(snapped.toFixed(6));
}

/** 轴对齐矩形相交；只共享一条边不算碰撞。 */
export function collision(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function findCollisions(list: Placement[]): Array<[string, string]> {
  const collisions: Array<[string, string]> = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a && b && collision(a, b)) collisions.push([a.id, b.id]);
    }
  }
  return collisions;
}

function clipRect(rect: { x: number; y: number; w: number; h: number }, plate: PlateSpec) {
  const x1 = Math.max(0, Math.min(plate.width, rect.x));
  const y1 = Math.max(0, Math.min(plate.height, rect.y));
  const x2 = Math.max(0, Math.min(plate.width, rect.x + rect.w));
  const y2 = Math.max(0, Math.min(plate.height, rect.y + rect.h));
  return { x1, y1, x2, y2 };
}

/** 已放置元件在底板范围内的并集面积，重叠部分只计一次。 */
export function utilization(list: Placement[], plate: PlateSpec): { usedMm2: number; ratio: number } {
  const plateArea = Math.max(0, plate.width) * Math.max(0, plate.height);
  if (plateArea <= 0 || list.length === 0) return { usedMm2: 0, ratio: 0 };

  const rects = list
    .map((item) => clipRect(item, plate))
    .filter((rect) => rect.x2 > rect.x1 && rect.y2 > rect.y1);
  if (rects.length === 0) return { usedMm2: 0, ratio: 0 };

  const xs = [...new Set(rects.flatMap((rect) => [rect.x1, rect.x2]))].sort((a, b) => a - b);
  let usedMm2 = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const left = xs[index];
    const right = xs[index + 1];
    if (left === undefined || right === undefined || right <= left) continue;
    const stripWidth = right - left;
    const intervals = rects
      .filter((rect) => rect.x1 < right && rect.x2 > left)
      .map((rect) => [rect.y1, rect.y2] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let start = intervals[0]?.[0];
    let end = intervals[0]?.[1];
    for (const [nextStart, nextEnd] of intervals.slice(1)) {
      if (start === undefined || end === undefined) {
        start = nextStart;
        end = nextEnd;
      } else if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        covered += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    if (start !== undefined && end !== undefined) covered += end - start;
    usedMm2 += stripWidth * covered;
  }

  return { usedMm2, ratio: plateArea > 0 ? usedMm2 / plateArea : 0 };
}

/** 将左上角与右下角都钳制在底板内；元件大于底板时贴左上角。 */
export function clampToPlate(p: Placement, plate: PlateSpec): Placement {
  const maxX = Math.max(0, plate.width - p.w);
  const maxY = Math.max(0, plate.height - p.h);
  return {
    ...p,
    x: Math.min(Math.max(0, p.x), maxX),
    y: Math.min(Math.max(0, p.y), maxY)
  };
}

/** DIN 导轨元件的底部与 35mm 导轨底边对齐。 */
export function railSnapY(rail: Rail, partHeight: number): number {
  return rail.y + rail.height - partHeight;
}
