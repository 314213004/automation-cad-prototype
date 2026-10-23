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

export type PlacementWarningCode = 'OVERLAP' | 'OUT_OF_BOUNDS';

export interface PlacementWarning {
  code: PlacementWarningCode;
  message: string;
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

/** 旋转 90°：宽高互换。 */
export function rotateSize(width: number, height: number): { w: number; h: number } {
  return { w: height, h: width };
}

/** 离矩形中心最近的导轨；没有导轨时返回 undefined。 */
export function nearestRail(plate: PlateSpec, rect: { y: number; h: number }): Rail | undefined {
  const center = rect.y + rect.h / 2;
  let best: Rail | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const rail of plate.rails) {
    const current = Math.abs(center - (rail.y + rail.height / 2));
    if (current < distance) {
      distance = current;
      best = rail;
    }
  }
  return best;
}

/** 吸附到最近导轨：返回贴住导轨底边的 y 与导轨 id。 */
export function railSnapPlacement(
  plate: PlateSpec,
  rect: { y: number; h: number }
): { y: number; railId: string } | undefined {
  const rail = nearestRail(plate, rect);
  if (!rail) return undefined;
  return { y: railSnapY(rail, rect.h), railId: rail.id };
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 放置告警：越界与重叠都不阻止放置（画布会钳制/贴边），只把风险交给调用方。
 * `intended` 是吸附后、钳制前的矩形，用于判断用户请求是否超出底板。
 */
export function placementWarnings(
  existing: Placement[],
  placement: Placement,
  plate: PlateSpec,
  intended: Placement = placement
): PlacementWarning[] {
  const warnings: PlacementWarning[] = [];
  if (
    intended.x < 0 ||
    intended.y < 0 ||
    intended.x + intended.w > plate.width + 1e-9 ||
    intended.y + intended.h > plate.height + 1e-9
  ) {
    warnings.push({
      code: 'OUT_OF_BOUNDS',
      message:
        `元件超出底板范围（X ${formatMm(intended.x)}–${formatMm(intended.x + intended.w)} / ` +
        `Y ${formatMm(intended.y)}–${formatMm(intended.y + intended.h)} mm，` +
        `底板 ${formatMm(plate.width)}×${formatMm(plate.height)} mm），已贴边放置`
    });
  }
  for (const item of existing) {
    if (!collision(item, placement)) continue;
    warnings.push({
      code: 'OVERLAP',
      message: `与已放置元件 ${item.model}（${item.id}）重叠`
    });
  }
  return warnings;
}
