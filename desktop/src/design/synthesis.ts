import type { ComponentPart } from '../shared/types.ts';
import type { Pricebook } from '../cost/pricebook.ts';
import { mapMachineBom } from '../machine/bom-map.ts';
import { defaultPricingAssumptions, estimateCost } from '../machine/cost-model.ts';
import { estimatePower } from '../machine/power.ts';
import { synthMachine, type MachineDesign, type SynthOptions } from '../machine/synth.ts';
import type { MachinePricingLoad } from '../machine/cost-model.ts';
import type { MachineBrief } from '../machine/spec.ts';

/** 与 Agent design_machine 相同的后处理，供需要显式复算时调用。 */
export function completeDesign(
  brief: MachineBrief,
  parts: readonly ComponentPart[],
  options: SynthOptions & { builtinPricebook?: Pricebook; pricingLoad?: Pick<MachinePricingLoad, 'pricing' | 'assumptions' | 'warnings'> } = {}
): MachineDesign {
  const pricingLoad = options.pricingLoad ?? {
    pricing: options.pricing ?? { power: { simultaneity: 0.7, loadFactor: 0.6, efficiency: 0.9, cosPhi: 0.9 }, labor: { ratePerHour: 120, mechanicalHoursPerStation: 8, electricalHoursPerStation: 6, debugHoursPerStation: 4 } },
    assumptions: defaultPricingAssumptions(false),
    warnings: []
  };
  const design = synthMachine(brief, { ...options, parts, pricing: pricingLoad.pricing, pricingAssumptions: pricingLoad.assumptions });
  try {
    const mapped = mapMachineBom(design, parts);
    design.bomDraft = { items: mapped.items };
    design.warnings.push(...mapped.pending.map((entry) => `${entry.name}：${entry.reason}`), ...mapped.notices);
  } catch {
    // 与 Agent 相同：自定义包缺少固定型号时保留通用 BOM。
  }
  const selectedBreaker = design.bomDraft.items.find((item) => /总进线断路器/.test(item.name));
  const selectedPart = parts.find((part) => part.id === selectedBreaker?.partId && (!selectedBreaker?.packId || part.packId === selectedBreaker.packId));
  const current = selectedPart?.specs['额定电流'];
  const selectedBreakerA = typeof current === 'number' ? current : typeof current === 'string' ? Number(current.match(/(\d+(?:\.\d+)?)\s*A/i)?.[1]) : undefined;
  design.power = estimatePower(design, {
    parts,
    voltage: design.power.voltage,
    simultaneity: pricingLoad.pricing.power.simultaneity,
    loadFactor: pricingLoad.pricing.power.loadFactor,
    efficiency: pricingLoad.pricing.power.efficiency,
    cosPhi: pricingLoad.pricing.power.cosPhi,
    ...(selectedBreakerA !== undefined && Number.isFinite(selectedBreakerA) ? { selectedBreakerA } : {}),
    assumptions: pricingLoad.assumptions
  });
  design.cost = estimateCost(design, {
    parts,
    pricing: pricingLoad.pricing,
    pricingAssumptions: pricingLoad.assumptions,
    ...(options.builtinPricebook ? { builtinPricebook: options.builtinPricebook } : {})
  });
  design.assumptions.push(...pricingLoad.warnings);
  return design;
}
