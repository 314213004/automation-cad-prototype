/**
 * 整机布局编辑：多选对齐 / 等距分布 / 线性阵列排布（纯函数）。
 *
 * 输入是各工位当前的 XY 包络（世界 mm），输出每个工位需要的平移增量；调用方把增量加到
 * 工位位姿偏移上并作为同一个撤销步写回主数据。俯视约定：X 向右，Y 向「后」（屏幕上方）。
 * 「顶 / 底」= +Y / −Y 边。
 */
import type { Rect2 } from './snap.ts';

export type AlignMode = 'left' | 'centerX' | 'right' | 'bottom' | 'centerY' | 'top';

export interface AlignItem {
  id: string;
  rect: Rect2;
}

export interface AlignDelta {
  dx: number;
  dy: number;
}

export const ALIGN_LABELS: Readonly<Record<AlignMode, string>> = Object.freeze({
  left: '左对齐（−X 边）',
  centerX: '水平居中（X 中线）',
  right: '右对齐（+X 边）',
  bottom: '底对齐（−Y 边）',
  centerY: '垂直居中（Y 中线）',
  top: '顶对齐（+Y 边）'
});

function clean(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function edge(rect: Rect2, mode: AlignMode): number {
  switch (mode) {
    case 'left': return rect.minX;
    case 'right': return rect.maxX;
    case 'centerX': return (rect.minX + rect.maxX) / 2;
    case 'bottom': return rect.minY;
    case 'top': return rect.maxY;
    case 'centerY': return (rect.minY + rect.maxY) / 2;
  }
}

/**
 * 对齐：reference='selection' 以选择集整体包络为基准（左=最左边、右=最右边、居中=整体中线）；
 * reference='first' 以第一个选中项为基准（它本身不动）。至少 2 项。
 */
export function alignDeltas(items: readonly AlignItem[], mode: AlignMode, reference: 'selection' | 'first' = 'selection'): Map<string, AlignDelta> {
  if (items.length < 2) throw new Error('对齐至少需要选中 2 个工位');
  let target: number;
  if (reference === 'first') {
    target = edge((items[0] as AlignItem).rect, mode);
  } else {
    const union = items.reduce<Rect2>((acc, item) => ({
      minX: Math.min(acc.minX, item.rect.minX), maxX: Math.max(acc.maxX, item.rect.maxX),
      minY: Math.min(acc.minY, item.rect.minY), maxY: Math.max(acc.maxY, item.rect.maxY)
    }), { ...(items[0] as AlignItem).rect });
    target = edge(union, mode);
  }
  const horizontal = mode === 'left' || mode === 'right' || mode === 'centerX';
  const result = new Map<string, AlignDelta>();
  for (const item of items) {
    const delta = clean(target - edge(item.rect, mode));
    result.set(item.id, horizontal ? { dx: delta, dy: 0 } : { dx: 0, dy: delta });
  }
  return result;
}

/**
 * 等距分布（至少 3 项）：按该轴最小边排序，首尾两项不动；
 * mode='gap' 让相邻包络间隙相等，mode='center' 让中心等距。
 */
export function distributeDeltas(items: readonly AlignItem[], axis: 'x' | 'y', mode: 'gap' | 'center' = 'gap'): Map<string, AlignDelta> {
  if (items.length < 3) throw new Error('等距分布至少需要选中 3 个工位');
  const lo = (rect: Rect2): number => (axis === 'x' ? rect.minX : rect.minY);
  const hi = (rect: Rect2): number => (axis === 'x' ? rect.maxX : rect.maxY);
  const sorted = [...items].sort((a, b) => lo(a.rect) - lo(b.rect) || a.id.localeCompare(b.id));
  const first = sorted[0] as AlignItem;
  const last = sorted[sorted.length - 1] as AlignItem;
  const result = new Map<string, AlignDelta>();
  const put = (id: string, delta: number): void => {
    const value = clean(delta);
    result.set(id, axis === 'x' ? { dx: value, dy: 0 } : { dx: 0, dy: value });
  };
  if (mode === 'center') {
    const c0 = (lo(first.rect) + hi(first.rect)) / 2;
    const c1 = (lo(last.rect) + hi(last.rect)) / 2;
    const step = (c1 - c0) / (sorted.length - 1);
    sorted.forEach((item, index) => put(item.id, c0 + step * index - (lo(item.rect) + hi(item.rect)) / 2));
    return result;
  }
  const span = hi(last.rect) - lo(first.rect);
  const total = sorted.reduce((sum, item) => sum + (hi(item.rect) - lo(item.rect)), 0);
  const gap = (span - total) / (sorted.length - 1);
  let cursor = lo(first.rect);
  for (const item of sorted) {
    put(item.id, cursor - lo(item.rect));
    cursor += hi(item.rect) - lo(item.rect) + gap;
  }
  return result;
}

/**
 * 线性阵列排布：按选择顺序，第一项不动，第 i 项中心 = 第一项中心 + i × 间距（沿 axis）。
 * 另一轴与第一项中心对齐。这里只重排已存在的工位；新增工位（复制）需要改机型配置，见 MODULE.md。
 */
export function linearArrayDeltas(items: readonly AlignItem[], axis: 'x' | 'y', pitchMm: number): Map<string, AlignDelta> {
  if (items.length < 2) throw new Error('阵列排布至少需要选中 2 个工位');
  if (!Number.isFinite(pitchMm) || pitchMm === 0 || Math.abs(pitchMm) > 1_000_000) throw new Error('阵列间距必须是非零有限毫米值');
  const first = items[0] as AlignItem;
  const cx0 = (first.rect.minX + first.rect.maxX) / 2;
  const cy0 = (first.rect.minY + first.rect.maxY) / 2;
  const result = new Map<string, AlignDelta>();
  items.forEach((item, index) => {
    const cx = (item.rect.minX + item.rect.maxX) / 2;
    const cy = (item.rect.minY + item.rect.maxY) / 2;
    const tx = axis === 'x' ? cx0 + pitchMm * index : cx0;
    const ty = axis === 'y' ? cy0 + pitchMm * index : cy0;
    result.set(item.id, { dx: clean(tx - cx), dy: clean(ty - cy) });
  });
  return result;
}
