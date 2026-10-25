/**
 * 顶部入口栏的排布判定（纯函数，便于单测）。
 *
 * 背景：入口按钮都挂在 `.tb-right` 里，原本 `flex:0 0 auto` 不换行，每加一个面板
 * 就往外顶——实测 13 个入口时 `scrollWidth 1980 > clientWidth 1670`，
 * 「智能体/装配/图纸/PLC 程序」四个按钮直接跑到窗口外（x > 1920）。
 */

export type EntryBarMode = 'full' | 'compact';

export interface EntryBarInput {
  /** 所有入口按钮含间距的总宽（px） */
  needed: number;
  /** 可用宽度（px） */
  available: number;
  /** 图标模式的单按钮宽度（px），用于判断降级后是否仍溢出 */
  compactNeeded: number;
  /** 触发降级的阈值比例：留 8px 余量避免最后一像素来回抖动 */
  margin?: number;
}

export interface EntryBarDecision {
  mode: EntryBarMode;
  /** 降级为图标模式后仍需横向滚动（极端窄窗口） */
  scrolls: boolean;
}

export function decideEntryBar({ needed, available, compactNeeded, margin = 8 }: EntryBarInput): EntryBarDecision {
  const fits = (width: number) => width + margin <= available;
  if (fits(needed)) return { mode: 'full', scrolls: false };
  if (fits(compactNeeded)) return { mode: 'compact', scrolls: false };
  return { mode: 'compact', scrolls: true };
}
