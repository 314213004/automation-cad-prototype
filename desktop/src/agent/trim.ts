/**
 * 工具结果裁剪（P7-E）
 *
 * 三条硬约束：
 * - 列表 > 20 条：只留前 20 条，补 `total` 与 `truncated:true`；
 * - 长文本 > 2 KB：按 UTF-8 码点边界截断并附中文提示；
 * - 任何单个工具结果进入模型上下文前必须 ≤ 10 KB。
 */

import { byteLength, truncateUtf8 } from './context.ts';

export const LIST_RESULT_LIMIT = 20;
export const LONG_TEXT_BYTE_LIMIT = 2048;
export const TOOL_RESULT_BYTE_LIMIT = 10 * 1024;

const LIST_KEYS = new Set([
  'items', 'rows', 'components', 'parts', 'files', 'results',
  'placements', 'candidates', 'warnings', 'lines', 'entries', 'tools'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface TrimmedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/** 列表裁剪：≤ limit 原样返回；超过则返回前 limit 条 + total + truncated。 */
export function trimListResult<T>(items: readonly T[], limit = LIST_RESULT_LIMIT): TrimmedList<T> {
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (items.length <= safeLimit) {
    return { items: items.slice(), total: items.length, truncated: false };
  }
  return {
    items: items.slice(0, safeLimit),
    total: items.length,
    truncated: true
  };
}

export interface TrimmedText {
  text: string;
  originalBytes: number;
  truncated: boolean;
}

/** 长文本截断；提示语也计入 2 KB 预算，保证最终字节数不超限。 */
export function trimLongText(text: string, limit = LONG_TEXT_BYTE_LIMIT): TrimmedText {
  const originalBytes = byteLength(text);
  if (originalBytes <= limit) {
    return { text, originalBytes, truncated: false };
  }
  const note = `\n…（已截断，原文 ${originalBytes} 字节）`;
  const noteBytes = byteLength(note);
  const budget = Math.max(0, Math.trunc(limit) - noteBytes);
  return {
    text: `${truncateUtf8(text, budget, '')}${note}`,
    originalBytes,
    truncated: true
  };
}

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return trimLongText(value).text;
  if (Array.isArray(value)) {
    if (value.length <= LIST_RESULT_LIMIT) return value.map(trimValue);
    return {
      items: value.slice(0, LIST_RESULT_LIMIT).map(trimValue),
      total: value.length,
      truncated: true
    };
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && (LIST_KEYS.has(key) || key === 'data')) {
      const list = key === 'data' ? entry.map(trimValue) : entry.map(trimValue);
      if (list.length > LIST_RESULT_LIMIT) {
        output[key] = {
          items: list.slice(0, LIST_RESULT_LIMIT),
          total: list.length,
          truncated: true
        };
      } else {
        output[key] = list;
      }
      continue;
    }
    if (Array.isArray(entry)) {
      output[key] = entry.length > LIST_RESULT_LIMIT
        ? {
            items: entry.slice(0, LIST_RESULT_LIMIT).map(trimValue),
            total: entry.length,
            truncated: true
          }
        : entry.map(trimValue);
      continue;
    }
    output[key] = trimValue(entry);
  }
  return output;
}

/** 结构化裁剪（不修改入参）。列表/长文本规则见模块头。 */
export function trimToolResult(value: unknown): unknown {
  if (Array.isArray(value)) return trimValue(value);
  return trimValue(value);
}

function fallbackText(value: unknown, text: string, maxBytes: number): string {
  const ok = isRecord(value) && typeof value.ok === 'boolean' ? value.ok : undefined;
  const note = '结果超过 10 KB，已截断；请缩小查询范围或分页读取。';
  const base = {
    ...(ok === undefined ? {} : { ok }),
    truncated: true,
    note
  };
  const overhead = byteLength(JSON.stringify({ ...base, preview: '' }));
  let budget = Math.max(0, maxBytes - overhead - 2);
  for (;;) {
    const preview = truncateUtf8(text, budget, '');
    const candidate = JSON.stringify({ ...base, preview });
    const excess = byteLength(candidate) - maxBytes;
    if (excess <= 0 || budget === 0) return candidate;
    budget = Math.max(0, budget - excess - 8);
  }
}

export interface SerializedToolResult {
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * 工具结果 → 模型上下文文本。先做列表/长文本裁剪，再保证 JSON ≤ 10 KB。
 * 超限时保留 `ok` 状态并给出 `preview`，不把半截 JSON 交给模型。
 */
export function serializeToolResult(
  value: unknown,
  maxBytes = TOOL_RESULT_BYTE_LIMIT
): SerializedToolResult {
  const limit = Math.max(256, Math.trunc(maxBytes));
  let text: string;
  try {
    text = JSON.stringify(trimToolResult(value));
  } catch {
    text = JSON.stringify({ ok: false, code: 'RESULT_NOT_SERIALIZABLE', message: '工具结果无法序列化' });
  }
  if (typeof text !== 'string') text = JSON.stringify({ ok: false, code: 'RESULT_NOT_SERIALIZABLE', message: '工具结果无法序列化' });
  const bytes = byteLength(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  const fallback = fallbackText(value, text, limit);
  return { text: fallback, bytes: byteLength(fallback), truncated: true };
}
