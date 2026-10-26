// 画布价格源：把「内置价格簿」接到 PriceLookup 上（P3 第一步）。
//
// 口径：
//   - 价格只来自价格簿条目；条目必须可用（非示例、非示例来源）、单价是正的有限数；
//   - 阶梯价按数量取满足条件的最高 minQty，数量 1 时通常命中 list；
//   - 超过 180 天的条目仍然给价，但单独计「过期条数」，由 UI 标注，不静默当新价；
//   - 查不到 → null → 待询价，不计入总额。
import {
  isStalePricebookItem,
  isUsablePricebookItem,
  type Pricebook,
  type PricebookItem
} from '../cost/pricebook.ts';
import type { PriceLookup } from './metrics.ts';

export interface PriceSourceSummary {
  currency: string;
  updatedAt: string;
  /** 可计价条目数（排除示例）。 */
  usable: number;
  /** 示例条目数（不参与计价）。 */
  examples: number;
  /** 超过 180 天的条目数（仍给价，但标注过期）。 */
  stale: number;
  source: string;
}

function itemPrice(item: PricebookItem, qty: number): number | null {
  if (!isUsablePricebookItem(item)) return null;
  if (typeof item.list !== 'number' || !Number.isFinite(item.list) || item.list <= 0) return null;
  let price = item.list;
  let bestMin = 0;
  for (const tier of item.tiers ?? []) {
    if (!Number.isFinite(tier.minQty) || !Number.isFinite(tier.price) || tier.price <= 0) continue;
    if (tier.minQty <= qty && tier.minQty >= bestMin) {
      bestMin = tier.minQty;
      price = tier.price;
    }
  }
  return price;
}

/** 价格簿 → PriceLookup。书为空/缺 items 时一律 null（不猜价）。 */
export function createPricebookLookup(book: Pricebook | null, options: { qty?: number } = {}): PriceLookup {
  if (!book || typeof book !== 'object' || !book.items || typeof book.items !== 'object') {
    return () => null;
  }
  const qty = options.qty ?? 1;
  return (partId: string): number | null => {
    if (typeof partId !== 'string' || partId.trim() === '') return null;
    const item = book.items[partId];
    if (!item) return null;
    // 过期价不丢弃（丢弃会把「有价但旧」误报成待询价），过期口径由 summarizePricebook 统计
    return itemPrice(item, qty);
  };
}

export function summarizePricebook(book: Pricebook | null, options: { now?: Date } = {}): PriceSourceSummary | null {
  if (!book || typeof book !== 'object' || !book.items || typeof book.items !== 'object') return null;
  const now = options.now ?? new Date();
  let usable = 0;
  let examples = 0;
  let stale = 0;
  for (const item of Object.values(book.items)) {
    if (!item || typeof item !== 'object') continue;
    if (!isUsablePricebookItem(item)) {
      examples += 1;
      continue;
    }
    if (typeof item.list !== 'number' || !Number.isFinite(item.list) || item.list <= 0) continue;
    usable += 1;
    if (isStalePricebookItem(item, now)) stale += 1;
  }
  return {
    currency: typeof book.currency === 'string' ? book.currency : 'CNY',
    updatedAt: typeof book.updatedAt === 'string' ? book.updatedAt : '',
    usable,
    examples,
    stale,
    source: typeof book.source === 'string' ? book.source : ''
  };
}

/** 一句话价格源说明，直接显示在 KPI / BOM 面板上。 */
export function describePriceSource(summary: PriceSourceSummary | null): string {
  if (!summary) return '价格源：未接入（全部待询价）';
  const updated = summary.updatedAt ? ` · 更新 ${summary.updatedAt.slice(0, 10)}` : '';
  const stale = summary.stale > 0 ? ` · 其中 ${summary.stale} 条超 180 天` : '';
  return `价格源：内置价格簿 ${summary.usable} 项可计价（示例 ${summary.examples} 项已排除）${updated}${stale}`;
}
