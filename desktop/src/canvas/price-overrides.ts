// 手工询价覆盖（纯逻辑，无 fs / 无 DOM）
//
// 为什么需要：内置价格簿只覆盖 64 项，非标件（转接板、定制模组）永远「待询价」。
// 让工程师把自己的询价结果填进来，覆盖表优先于价格簿；填了才算钱，没填继续算待询价。
//
// 纪律：
//   - 不写任何内置单价，金额只能来自调用方（价格簿 / 用户输入）；
//   - 非法价格（0、负数、NaN、超大）整条拒绝，不做「夹到合法范围」这种悄悄改数；
//   - 覆盖表按 partId 去重，同一型号只留一条，后写覆盖先写（并保留 updatedAt 供追溯）。
import type { PriceLookup } from './metrics.ts';

export const CANVAS_PRICING_SCHEMA = 'canvas-price-overrides/1';
/** 单价上限 1000 万：挡住「把 1 打成 100000000」这类手滑，同时远高于任何单件。 */
export const MAX_UNIT_PRICE_YUAN = 10_000_000;
export const MAX_NOTE_LENGTH = 200;

export interface ManualPrice {
  partId: string;
  unitPriceYuan: number;
  note?: string;
  /** ISO 时间戳，用于提示「这条报价是什么时候填的」。 */
  updatedAt: string;
}

export interface ManualPriceBook {
  schema: string;
  items: Record<string, ManualPrice>;
}

export interface ManualPriceIssue {
  partId: string;
  message: string;
}

export interface ParseManualPriceResult {
  book: ManualPriceBook;
  issues: ManualPriceIssue[];
  /** 整个文件不可用（不是对象 / schema 不匹配）。 */
  rejected: boolean;
}

export function emptyManualPrices(): ManualPriceBook {
  return { schema: CANVAS_PRICING_SCHEMA, items: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验单条价格：返回中文原因或 null。 */
export function validateUnitPrice(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '单价必须是数字';
  if (value <= 0) return '单价必须大于 0（免费件请填 0.01 并备注）';
  if (value > MAX_UNIT_PRICE_YUAN) return `单价超过 ${MAX_UNIT_PRICE_YUAN} 元，疑似录错`;
  return null;
}

/** 读回覆盖表：逐条校验，坏条目丢掉但报出来，不因为一条坏数据丢整张表。 */
export function parseManualPrices(raw: unknown): ParseManualPriceResult {
  const book = emptyManualPrices();
  const issues: ManualPriceIssue[] = [];
  if (raw === null || raw === undefined) return { book, issues, rejected: false };
  if (!isRecord(raw)) return { book, issues: [{ partId: '', message: '报价文件不是对象' }], rejected: true };
  if (raw.schema !== CANVAS_PRICING_SCHEMA) {
    return { book, issues: [{ partId: '', message: `报价文件 schema 不匹配（期望 ${CANVAS_PRICING_SCHEMA}）` }], rejected: true };
  }
  if (!isRecord(raw.items)) return { book, issues: [{ partId: '', message: '报价文件缺少 items' }], rejected: true };
  for (const [partId, value] of Object.entries(raw.items)) {
    if (!isRecord(value)) {
      issues.push({ partId, message: '报价条目不是对象，已丢弃' });
      continue;
    }
    const priceError = validateUnitPrice(value.unitPriceYuan);
    if (priceError) {
      issues.push({ partId, message: priceError });
      continue;
    }
    const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.trim() ? value.updatedAt : new Date(0).toISOString();
    const note = typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE_LENGTH) : undefined;
    book.items[partId] = {
      partId,
      unitPriceYuan: value.unitPriceYuan as number,
      ...(note ? { note } : {}),
      updatedAt
    };
  }
  return { book, issues, rejected: false };
}

export interface SetManualPriceResult {
  book: ManualPriceBook;
  error: string | null;
}

/** 写入/覆盖一条报价（纯函数，返回新对象）。 */
export function setManualPrice(
  book: ManualPriceBook,
  partId: string,
  unitPriceYuan: number,
  updatedAt: string,
  note?: string
): SetManualPriceResult {
  const id = partId.trim();
  if (!id) return { book, error: 'partId 不能为空' };
  const priceError = validateUnitPrice(unitPriceYuan);
  if (priceError) return { book, error: priceError };
  const trimmedNote = note?.trim();
  if (trimmedNote && trimmedNote.length > MAX_NOTE_LENGTH) {
    return { book, error: `备注超过 ${MAX_NOTE_LENGTH} 字` };
  }
  return {
    book: {
      schema: CANVAS_PRICING_SCHEMA,
      items: {
        ...book.items,
        [id]: {
          partId: id,
          unitPriceYuan,
          ...(trimmedNote ? { note: trimmedNote } : {}),
          updatedAt
        }
      }
    },
    error: null
  };
}

export function removeManualPrice(book: ManualPriceBook, partId: string): ManualPriceBook {
  if (!book.items[partId]) return book;
  const items = { ...book.items };
  delete items[partId];
  return { schema: CANVAS_PRICING_SCHEMA, items };
}

/**
 * 组合查价：手工报价优先，其次价格簿。两者都查不到 → null（待询价）。
 * 显式不写任何兜底价——宁可在界面上空着，也不能给一个假金额。
 */
export function createOverrideLookup(overrides: ManualPriceBook, fallback: PriceLookup): PriceLookup {
  return (partId: string): number | null => {
    if (typeof partId !== 'string' || partId.trim() === '') return null;
    const manual = overrides.items[partId];
    if (manual && Number.isFinite(manual.unitPriceYuan) && manual.unitPriceYuan > 0) return manual.unitPriceYuan;
    return fallback(partId);
  };
}

export function summarizeOverrides(book: ManualPriceBook): { count: number; latest: string | null } {
  const entries = Object.values(book.items);
  if (entries.length === 0) return { count: 0, latest: null };
  const latest = entries
    .map((entry) => entry.updatedAt)
    .filter((value) => typeof value === 'string' && value)
    .sort()
    .at(-1) ?? null;
  return { count: entries.length, latest };
}
