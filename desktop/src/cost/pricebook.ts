import { DEFAULTS } from './defaults.ts';

/** 示例条目固定来源标记；带此标记的条目不会参与真实成本计算。 */
export const PRICEBOOK_EXAMPLE_SOURCE = '示例，需替换';

export interface PricebookTier {
  minQty: number;
  price: number;
}

export interface PricebookItem {
  /** 目录单价（未命中阶梯价时使用） */
  list: number;
  /** 阶梯价，按 qty 取满足条件的最高 minQty */
  tiers?: PricebookTier[];
  /** 价格来源，缺省回落到价格簿来源 */
  source?: string;
  /** 价格日期，必须带时区；缺省回落到价格簿日期 */
  updatedAt?: string;
  model?: string;
  category?: string;
  /** 示例条目标记，真实报告必须忽略 */
  example?: boolean;
}

export interface PricebookLabor {
  panelWiringPerPoint: number;
  terminalPerWire: number;
  assemblyHourly: number;
  source?: string;
}

export interface PricebookAccessories {
  dinRail35PerMeter: number;
  wireDuctPerMeter: number;
  wirePerMeter: Record<string, number>;
  source?: string;
}

export interface Pricebook {
  schemaVersion: 1;
  currency: string;
  updatedAt: string;
  source: string;
  items: Record<string, PricebookItem>;
  labor: PricebookLabor;
  accessories: PricebookAccessories;
}

const TIMEZONE_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CURRENCY = /^[A-Za-z]{3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

export function isTimezoneDate(value: string): boolean {
  return TIMEZONE_DATE.test(value) && Number.isFinite(Date.parse(value));
}

function money(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(path, '必须是非负有限数');
  }
  return value;
}

function timezoneDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !isTimezoneDate(value)) {
    fail(path, '必须带时区（如 2026-10-23T00:00:00+08:00）');
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, '必须是非空字符串');
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(path, '必须是字符串');
  return value;
}

function validateTiers(value: unknown, path: string): PricebookTier[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, '必须是数组');
  const result: PricebookTier[] = [];
  let previous = -1;
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isRecord(raw)) fail(`${path}[${index}]`, '必须是对象');
    const minQty = raw.minQty;
    if (typeof minQty !== 'number' || !Number.isInteger(minQty) || minQty <= 0) {
      fail(`${path}[${index}].minQty`, '必须是正整数');
    }
    if (minQty <= previous) {
      fail(`${path}[${index}].minQty`, '必须严格递增且唯一');
    }
    previous = minQty;
    result.push({
      minQty,
      price: money(raw.price, `${path}[${index}].price`)
    });
  }
  return result;
}

function validateItem(value: unknown, path: string): PricebookItem {
  if (!isRecord(value)) fail(path, '必须是对象');
  const item: PricebookItem = {
    list: money(value.list, `${path}.list`)
  };
  const tiers = validateTiers(value.tiers, `${path}.tiers`);
  if (tiers !== undefined) item.tiers = tiers;
  const source = optionalString(value.source, `${path}.source`);
  if (source !== undefined) item.source = source;
  const updatedAt = value.updatedAt;
  if (updatedAt !== undefined) item.updatedAt = timezoneDate(updatedAt, `${path}.updatedAt`);
  const model = optionalString(value.model, `${path}.model`);
  if (model !== undefined) item.model = model;
  const category = optionalString(value.category, `${path}.category`);
  if (category !== undefined) item.category = category;
  if (value.example !== undefined) {
    if (typeof value.example !== 'boolean') fail(`${path}.example`, '必须是布尔值');
    item.example = value.example;
  }
  return item;
}

function validateLabor(value: unknown): PricebookLabor {
  if (value === undefined) {
    return {
      panelWiringPerPoint: DEFAULTS.labor.panelWiringPerPoint,
      terminalPerWire: DEFAULTS.labor.terminalPerWire,
      assemblyHourly: DEFAULTS.labor.assemblyHourly,
      source: DEFAULTS.labor.source
    };
  }
  if (!isRecord(value)) fail('价格簿.labor', '必须是对象');
  const result: PricebookLabor = {
    panelWiringPerPoint: money(value.panelWiringPerPoint, '价格簿.labor.panelWiringPerPoint'),
    terminalPerWire: money(value.terminalPerWire, '价格簿.labor.terminalPerWire'),
    assemblyHourly: money(value.assemblyHourly, '价格簿.labor.assemblyHourly')
  };
  const source = optionalString(value.source, '价格簿.labor.source');
  if (source !== undefined) result.source = source;
  return result;
}

function validateAccessories(value: unknown): PricebookAccessories {
  if (value === undefined) {
    return {
      dinRail35PerMeter: DEFAULTS.accessories.dinRail35PerMeter,
      wireDuctPerMeter: DEFAULTS.accessories.wireDuctPerMeter,
      wirePerMeter: { ...DEFAULTS.accessories.wirePerMeter },
      source: DEFAULTS.accessories.source
    };
  }
  if (!isRecord(value)) fail('价格簿.accessories', '必须是对象');
  const result: PricebookAccessories = {
    dinRail35PerMeter: money(value.dinRail35PerMeter, '价格簿.accessories.dinRail35PerMeter'),
    wireDuctPerMeter: money(value.wireDuctPerMeter, '价格簿.accessories.wireDuctPerMeter'),
    wirePerMeter: { ...DEFAULTS.accessories.wirePerMeter }
  };
  if (value.wirePerMeter !== undefined) {
    if (!isRecord(value.wirePerMeter)) fail('价格簿.accessories.wirePerMeter', '必须是对象');
    for (const [section, price] of Object.entries(value.wirePerMeter)) {
      const key = section.trim();
      if (key === '') fail('价格簿.accessories.wirePerMeter', '的截面键不能为空');
      result.wirePerMeter[key] = money(price, `价格簿.accessories.wirePerMeter.${key}`);
    }
  }
  const source = optionalString(value.source, '价格簿.accessories.source');
  if (source !== undefined) result.source = source;
  return result;
}

/** 校验并规范化价格簿；错误消息统一为中文。 */
export function validatePricebook(value: unknown): Pricebook {
  if (!isRecord(value)) throw new Error('价格簿必须是对象');
  if (value.schemaVersion !== 1) throw new Error('价格簿.schemaVersion 必须为 1');
  if (typeof value.currency !== 'string' || !CURRENCY.test(value.currency)) {
    throw new Error('价格簿.currency 必须是 3 个字母的币种代码');
  }
  const updatedAt = timezoneDate(value.updatedAt, '价格簿.updatedAt');
  const source = nonEmptyString(value.source, '价格簿.source');
  if (!isRecord(value.items)) throw new Error('价格簿.items 必须是对象');
  const items: Record<string, PricebookItem> = {};
  for (const [partId, raw] of Object.entries(value.items)) {
    if (partId.trim() === '') throw new Error('价格簿.items 的 partId 不能为空');
    items[partId] = validateItem(raw, `价格簿.items.${partId}`);
  }
  return {
    schemaVersion: 1,
    currency: value.currency,
    updatedAt,
    source,
    items,
    labor: validateLabor(value.labor),
    accessories: validateAccessories(value.accessories)
  };
}

/** 从 JSON 文本解析价格簿，JSON 语法错误也转成中文消息。 */
export function parsePricebook(text: string): Pricebook {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`价格簿不是合法 JSON：${detail}`);
  }
  return validatePricebook(value);
}

/** 示例条目只用于展示格式，不参与真实成本报告。 */
export function isUsablePricebookItem(item: PricebookItem): boolean {
  return item.example !== true && item.source !== PRICEBOOK_EXAMPLE_SOURCE;
}
