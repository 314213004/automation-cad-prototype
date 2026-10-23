/** 模型价格表读取：pricing.json 是唯一来源，单位默认「元 / 1k tokens」。 */
import rawPricing from './pricing.json' with { type: 'json' };
import type { ModelPrice, PricingBook } from './budget.ts';

function normalizePrice(value: unknown): ModelPrice | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const input = Number(record.input);
  const output = Number(record.output);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  return { input, output };
}

export function normalizePricing(value: unknown): PricingBook {
  const source = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const currency = typeof source.currency === 'string' && source.currency.trim()
    ? source.currency.trim()
    : 'CNY';
  const unitValue = Number(source.unit);
  const unit = Number.isFinite(unitValue) && unitValue > 0 ? unitValue : 1000;
  const models: Record<string, ModelPrice> = {};
  if (typeof source.models === 'object' && source.models !== null && !Array.isArray(source.models)) {
    for (const [name, price] of Object.entries(source.models as Record<string, unknown>)) {
      const normalized = normalizePrice(price);
      if (name.trim() && normalized) models[name.trim()] = normalized;
    }
  }
  return { currency, unit, models };
}

/** 启动时读取一次；pricing.json 随源码打包，不依赖用户目录。 */
export const DEFAULT_PRICING: PricingBook = normalizePricing(rawPricing);
