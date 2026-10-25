/**
 * 顶部入口按钮与右侧抽屉的 id 配对约定：`<base>EntryButton` ↔ `<base>Drawer`。
 *
 * 抽屉共用同一块停靠位置（同一个 x、同宽），同时打开会互相遮挡 —— 所以入口点击既要
 * 保证「只能有一个抽屉打开」，也要支持「同一个入口再点一次收起」。
 * 配对规则单独放这里，便于脱离 DOM 做单元测试。
 */

export const ENTRY_SUFFIX = 'EntryButton';
export const DRAWER_SUFFIX = 'Drawer';

/** 由入口按钮 id 推导抽屉 id；不符合约定时返回 null（不猜、不兜底）。 */
export function drawerIdForEntry(entryId: string): string | null {
  if (!entryId || !entryId.endsWith(ENTRY_SUFFIX)) return null;
  const base = entryId.slice(0, -ENTRY_SUFFIX.length);
  if (!base) return null;
  return `${base}${DRAWER_SUFFIX}`;
}
