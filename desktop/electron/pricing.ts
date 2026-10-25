import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MACHINE_PRICING, MACHINE_PRICING_FILE, defaultPricingAssumptions, parseMachinePricing, type MachinePricingLoad } from '../src/machine/cost-model.ts';

/**
 * 读取 `<userData>/machine-pricing.json`。文件不存在、不可读或 JSON 非法时回落
 * 默认参数，并把「为什么用默认值」写进 assumptions，供方案卡与文档引用。
 */
export function readMachinePricing(userDataRoot?: string): MachinePricingLoad {
  const path = userDataRoot ? join(userDataRoot, MACHINE_PRICING_FILE) : MACHINE_PRICING_FILE;
  if (!userDataRoot || !existsSync(path)) {
    return {
      pricing: DEFAULT_MACHINE_PRICING,
      source: 'defaults',
      path,
      assumptions: defaultPricingAssumptions(Boolean(userDataRoot)),
      warnings: []
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const result = parseMachinePricing(parsed);
    return {
      pricing: result.pricing,
      source: 'file',
      path,
      assumptions: [`功率与成本参数来自 ${path}。`],
      warnings: result.warnings
    };
  } catch (error) {
    return {
      pricing: DEFAULT_MACHINE_PRICING,
      source: 'defaults',
      path,
      assumptions: [
        `读取 ${path} 失败（${error instanceof Error ? error.message : String(error)}），已回落默认参数。`
      ],
      warnings: [`参数文件不可用：${path}`]
    };
  }
}

