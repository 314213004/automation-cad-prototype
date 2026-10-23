/**
 * Agent 上下文预算与成本口径（纯函数）
 *
 * 目标：在把上下文交给模型之前，先按「系统策略 → 选择/记忆 → 文档/工具结果 → 历史」
 * 的优先级装包。任何情况下都不截断 system 策略段；超限时先收敛长列表（首尾各 5 条 +
 * total），再丢弃最旧的 history，最后才动 docs 与 toolResults。
 *
 * 估算口径：中文 1 token ≈ 1.6 字符，其他字符 4 字符 ≈ 1 token。它是保守估计，
 * 只用于预算与成本提示；端点回传 usage 时以真实值为准。
 */

export type BudgetSectionName =
  | 'system'
  | 'selection'
  | 'memory'
  | 'docs'
  | 'toolResults'
  | 'history';

export interface BudgetSectionCaps {
  system: number;
  selection: number;
  memory: number;
  docs: number;
  toolResults: number;
  history: number;
}

/** 默认总量 12k tokens；各档上限之和可以大于总量，总量是最后一道闸。 */
export const DEFAULT_TOTAL_BUDGET = 12_000;
export const DEFAULT_SECTION_CAPS: BudgetSectionCaps = {
  system: 4_000,
  selection: 1_500,
  memory: 1_200,
  docs: 2_500,
  toolResults: 5_000,
  history: 3_000
};
export const DEFAULT_LIST_HEAD = 5;
export const DEFAULT_LIST_TAIL = 5;

export interface BudgetOptions {
  /** 总预算，默认 12000 tokens。 */
  total?: number;
  /** 单档上限，未传的档位使用默认值。 */
  caps?: Partial<BudgetSectionCaps>;
  /** 长列表首部保留条数，默认 5。 */
  listHead?: number;
  /** 长列表尾部保留条数，默认 5。 */
  listTail?: number;
}

export interface BudgetList {
  items: readonly unknown[];
  total?: number;
}

export type BudgetSectionValue = string | BudgetList | readonly unknown[] | null | undefined;

export interface BudgetPayload {
  system?: string;
  selection?: string;
  memory?: string;
  docs?: BudgetSectionValue;
  toolResults?: BudgetSectionValue;
  history?: BudgetSectionValue;
}

export type BudgetDropReasonCode =
  | 'section_cap_list'
  | 'section_cap_text'
  | 'total_history'
  | 'total_docs'
  | 'total_toolResults'
  | 'total_memory'
  | 'total_selection'
  | 'system_protected';

export interface BudgetDrop {
  section: BudgetSectionName;
  reason: string;
  code: BudgetDropReasonCode;
}

export interface BudgetSectionUsage {
  tokens: number;
  cap: number;
  truncated: boolean;
  dropped: boolean;
  items?: number;
}

export interface PackedBudget {
  /** 可直接作为系统提示/上下文文本使用。 */
  text: string;
  /** 最终文本的 token 估算值。 */
  used: number;
  dropped: BudgetDrop[];
  sections: Record<BudgetSectionName, BudgetSectionUsage>;
  /** docs 段实际保留的来源数（列表项数）。 */
  docsSources: number;
}

const SECTION_ORDER: BudgetSectionName[] = [
  'system',
  'selection',
  'memory',
  'docs',
  'toolResults',
  'history'
];

/** 总量超限时的裁剪顺序：history 最旧，接着 docs，最后 toolResults。 */
const TOTAL_DROP_ORDER: BudgetSectionName[] = [
  'history',
  'docs',
  'toolResults',
  'memory',
  'selection'
];

const CJK_PATTERN =
  /[\u2e80-\u2eff\u2f00-\u2fdf\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

/** 中文按 1.6 字符 / token，其他字符按 4 字符 / token，向上取整。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.6 + other / 4);
}

/** 按 token 预算安全截断（只在完整码点边界落刀），结果不会超过 limit。 */
export function truncateToTokens(text: string, limit: number, suffix = '…'): string {
  const budget = Math.max(0, Math.trunc(limit));
  if (budget === 0) return '';
  if (estimateTokens(text) <= budget) return text;
  const chars = Array.from(text);
  let safeSuffix = suffix;
  if (estimateTokens(safeSuffix) > budget) safeSuffix = '';
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('')}${safeSuffix}`;
    if (estimateTokens(candidate) <= budget) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join('')}${safeSuffix}`;
}

function toDisplayItem(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isBudgetList(value: BudgetSectionValue): value is BudgetList {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Array.isArray((value as BudgetList).items);
}

interface NormalizedSection {
  name: BudgetSectionName;
  cap: number;
  kind: 'empty' | 'text' | 'list';
  text: string;
  items: string[];
  total: number;
  listTruncated: boolean;
  textTruncated: boolean;
  dropped: boolean;
  omitted: number;
  contentOverride: string | null;
}

function normalizeSection(
  name: BudgetSectionName,
  value: BudgetSectionValue | string,
  cap: number
): NormalizedSection {
  const base: NormalizedSection = {
    name,
    cap,
    kind: 'empty',
    text: '',
    items: [],
    total: 0,
    listTruncated: false,
    textTruncated: false,
    dropped: false,
    omitted: 0,
    contentOverride: null
  };
  if (value === null || value === undefined) return base;
  if (typeof value === 'string') {
    if (!value) return base;
    return { ...base, kind: 'text', text: value, total: 1 };
  }
  if (Array.isArray(value)) {
    const listItems = value.map(toDisplayItem);
    if (listItems.length === 0) return base;
    return { ...base, kind: 'list', items: listItems, total: listItems.length };
  }
  if (!isBudgetList(value)) return base;
  const items = value.items.map(toDisplayItem);
  if (items.length === 0) return base;
  const declaredTotal = typeof value.total === 'number' && Number.isFinite(value.total)
    ? Math.max(items.length, Math.trunc(value.total))
    : items.length;
  return { ...base, kind: 'list', items, total: declaredTotal };
}

function renderList(section: NormalizedSection, head: number, tail: number): string {
  if (section.kind !== 'list') return section.text;
  if (!section.listTruncated) return section.items.join('\n');
  const front = section.items.slice(0, head);
  const back = section.items.slice(-tail);
  const omitted = Math.max(0, section.total - front.length - back.length);
  const marker = `…（已省略 ${omitted} 条，共 ${section.total} 条）`;
  return [...front, marker, ...back].join('\n');
}

function sectionContent(section: NormalizedSection, head: number, tail: number): string {
  if (section.contentOverride !== null) return section.contentOverride;
  return section.kind === 'list' ? renderList(section, head, tail) : section.text;
}

function renderSections(
  sections: NormalizedSection[],
  head: number,
  tail: number
): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.dropped) continue;
    const content = sectionContent(section, head, tail);
    if (!content) continue;
    parts.push(`[${section.name}]\n${content}`);
  }
  return parts.join('\n\n');
}

function truncateList(section: NormalizedSection, head: number, tail: number): void {
  if (section.kind !== 'list' || section.listTruncated) return;
  if (section.items.length <= head + tail) return;
  section.items = [...section.items.slice(0, head), ...section.items.slice(-tail)];
  section.listTruncated = true;
  section.omitted = Math.max(0, section.total - head - tail);
}

function markSectionTruncated(
  section: NormalizedSection,
  cap: number,
  head: number,
  tail: number
): void {
  const content = sectionContent(section, head, tail);
  if (estimateTokens(content) <= cap) return;
  section.contentOverride = truncateToTokens(content, cap, '\n…（已截断）');
  section.textTruncated = true;
}

function cloneSection(section: NormalizedSection): NormalizedSection {
  return {
    ...section,
    items: section.items.slice()
  };
}

/**
 * 上下文装包。返回值中的 `text` 已按预算收敛；`dropped` 中每条原因都可直接展示给用户。
 */
export function pack(payload: BudgetPayload, options: BudgetOptions = {}): PackedBudget {
  const total = Math.max(1, Math.trunc(options.total ?? DEFAULT_TOTAL_BUDGET));
  const caps: BudgetSectionCaps = { ...DEFAULT_SECTION_CAPS, ...(options.caps ?? {}) };
  const head = Math.max(0, Math.trunc(options.listHead ?? DEFAULT_LIST_HEAD));
  const tail = Math.max(0, Math.trunc(options.listTail ?? DEFAULT_LIST_TAIL));
  const sections = SECTION_ORDER.map((name) =>
    normalizeSection(name, payload[name], caps[name])
  );
  const byName = new Map(sections.map((section) => [section.name, section]));
  const dropped: BudgetDrop[] = [];

  // 1) 单档上限：先收敛长列表，再截断文本；system 永不裁剪。
  for (const section of sections) {
    if (section.name === 'system' || section.kind === 'empty') continue;
    const initial = estimateTokens(sectionContent(section, head, tail));
    if (initial <= section.cap) continue;
    if (section.kind === 'list' && section.items.length > head + tail) {
      truncateList(section, head, tail);
      dropped.push({
        section: section.name,
        code: 'section_cap_list',
        reason: `${section.name} 超过单档上限 ${section.cap} tokens，已保留首尾各 ${head}/${tail} 条（共 ${section.total} 条）`
      });
    }
    if (estimateTokens(sectionContent(section, head, tail)) > section.cap) {
      markSectionTruncated(section, section.cap, head, tail);
      dropped.push({
        section: section.name,
        code: 'section_cap_text',
        reason: `${section.name} 超过单档上限 ${section.cap} tokens，已截断到 ${section.cap} tokens`
      });
    }
  }

  // 2) 总量超限：先对长列表做首尾收敛（docs / toolResults / history）。
  let text = renderSections(sections, head, tail);
  if (estimateTokens(text) > total) {
    for (const name of ['docs', 'toolResults'] as const) {
      const section = byName.get(name);
      if (!section || section.dropped || section.kind !== 'list') continue;
      if (section.items.length <= head + tail) continue;
      truncateList(section, head, tail);
      dropped.push({
        section: name,
        code: 'section_cap_list',
        reason: `${name} 超过总预算 ${total} tokens，已先保留首尾各 ${head}/${tail} 条（共 ${section.total} 条）`
      });
      text = renderSections(sections, head, tail);
      if (estimateTokens(text) <= total) break;
    }
  }

  // 3) 仍超限：按 history → docs → toolResults → memory → selection 丢弃。
  let guard = 0;
  while (estimateTokens(text) > total && guard < 1_000) {
    guard += 1;
    const target = TOTAL_DROP_ORDER
      .map((name) => byName.get(name))
      .find((section) => section !== undefined && !section.dropped && section.kind !== 'empty');
    if (!target) break;
    if (target.name === 'history' && target.kind === 'list' && !target.listTruncated && target.items.length > 1) {
      // 列表未截断时逐条丢最旧，并保留 total 口径。
      const removed = target.items.shift();
      target.total = Math.max(target.items.length, target.total - 1);
      dropped.push({
        section: 'history',
        code: 'total_history',
        reason: `history 超过总预算 ${total} tokens，丢弃最旧 1 条（剩余 ${target.items.length} 条）：${removed?.slice(0, 40) ?? ''}`
      });
    } else {
      target.dropped = true;
      const code: BudgetDropReasonCode = target.name === 'history'
        ? 'total_history'
        : target.name === 'docs'
          ? 'total_docs'
          : target.name === 'toolResults'
            ? 'total_toolResults'
            : target.name === 'memory'
              ? 'total_memory'
              : 'total_selection';
      const sourceNote = target.name === 'docs' && target.kind === 'list'
        ? `（${target.total} 个来源）`
        : '';
      dropped.push({
        section: target.name,
        code,
        reason: `${target.name} 超过总预算 ${total} tokens，已移除该段${sourceNote}`
      });
    }
    text = renderSections(sections, head, tail);
  }

  // system 段即使自身超过总量也不裁，只把事实写进 dropped 供 UI 解释。
  const used = estimateTokens(text);
  if (used > total) {
    const system = byName.get('system');
    if (system && !system.dropped && system.kind !== 'empty') {
      dropped.push({
        section: 'system',
        code: 'system_protected',
        reason: `system 策略段超过总预算 ${total} tokens（${used} tokens），按策略永不裁剪`
      });
    }
  }

  const usage = Object.fromEntries(
    sections.map((section) => {
      const content = sectionContent(section, head, tail);
      return [section.name, {
        tokens: section.dropped ? 0 : estimateTokens(content),
        cap: section.cap,
        truncated: section.listTruncated || section.textTruncated,
        dropped: section.dropped,
        ...(section.kind === 'list' ? { items: section.dropped ? 0 : section.total } : {})
      } satisfies BudgetSectionUsage];
    })
  ) as Record<BudgetSectionName, BudgetSectionUsage>;

  return {
    text,
    used,
    dropped,
    sections: usage,
    docsSources: (() => {
      const docs = byName.get('docs');
      if (!docs || docs.dropped || docs.kind !== 'list') return 0;
      return docs.listTruncated ? Math.min(docs.total, head + tail) : docs.total;
    })()
  };
}

// ---------------------------------------------------------------------------
// Token / 成本口径
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** true = 端点未回传 usage，按字符数估算。 */
  estimated: boolean;
  /** 本轮/本会话累计的模型请求次数（重试也计一次）。 */
  requests: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false, requests: 0 };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimated: left.estimated || right.estimated,
    requests: left.requests + right.requests
  };
}

export interface ModelPrice {
  /** 每 unit 个输入 token 的价格。 */
  input: number;
  /** 每 unit 个输出 token 的价格。 */
  output: number;
}

export interface PricingBook {
  currency: string;
  /** 价格单位：unit 个 token。默认 1000（即「元/k tokens」）。 */
  unit: number;
  models: Record<string, ModelPrice>;
}

export interface CostView {
  /** 是否能在价格表中找到模型；false 时金额无意义。 */
  known: boolean;
  currency: string;
  /** 未知模型为 null。 */
  amount: number | null;
  /** 展示文本：已知 "¥0.0000"，未知 "—"。 */
  display: string;
}

export const UNKNOWN_COST = '—';

/** 精确匹配优先；其次取最长前缀（处理 deepseek-chat-2026 这类带日期的模型名）。 */
export function resolveModelPrice(book: PricingBook | null | undefined, model: string): ModelPrice | null {
  if (!book || typeof model !== 'string' || !model.trim()) return null;
  const key = model.trim();
  if (Object.hasOwn(book.models, key)) return book.models[key] ?? null;
  let best: string | null = null;
  for (const candidate of Object.keys(book.models)) {
    if (!candidate) continue;
    if (key.startsWith(`${candidate}-`) || key.startsWith(`${candidate}:`)) {
      if (!best || candidate.length > best.length) best = candidate;
    }
  }
  return best ? book.models[best] ?? null : null;
}

export function formatCost(amount: number | null, currency = 'CNY'): string {
  if (amount === null || !Number.isFinite(amount) || amount < 0) return UNKNOWN_COST;
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  if (amount > 0 && amount < 0.00005) return `${symbol}<0.0001`;
  return `${symbol}${amount.toFixed(4)}`;
}

export function estimateCostView(
  book: PricingBook | null | undefined,
  model: string,
  promptTokens: number,
  completionTokens: number
): CostView {
  const price = resolveModelPrice(book, model);
  if (!price) {
    return {
      known: false,
      currency: book?.currency ?? 'CNY',
      amount: null,
      display: UNKNOWN_COST
    };
  }
  const unit = Number.isFinite(book?.unit) && (book?.unit ?? 0) > 0 ? book!.unit : 1000;
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
  const amount = (prompt * price.input + completion * price.output) / unit;
  return {
    known: true,
    currency: book?.currency ?? 'CNY',
    amount,
    display: formatCost(amount, book?.currency ?? 'CNY')
  };
}

/** 侧栏展示用：小于 10k 原样，千位加逗号；更大用 k/M 缩写。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const count = Math.round(value);
  if (count < 10_000) return count.toLocaleString('en-US');
  if (count < 1_000_000) {
    const short = count / 1000;
    return `${short >= 100 ? short.toFixed(0) : short.toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}
