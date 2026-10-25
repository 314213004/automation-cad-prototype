import type { ComponentPart } from '../shared/types.ts';
import { estimateCost } from '../machine/cost-model.ts';
import { estimatePower } from '../machine/power.ts';
import type { MachinePricing } from '../machine/cost-model.ts';
import type { Pricebook } from '../cost/pricebook.ts';
import { detectInterferences, type InterferenceHit, type InterferencePart } from '../mech/interference.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { reevaluateCandidateCycle } from './candidates.ts';

export interface DesignReviewItem {
  severity: 'error' | 'warning' | 'pass';
  title: string;
  detail: string;
}
export interface DesignReview {
  errors: number;
  warnings: number;
  passed: number;
  items: DesignReviewItem[];
  interference: InterferenceHit[];
  cycle: ReturnType<typeof reevaluateCandidateCycle>;
  power: MachineDesign['power'];
  cost: MachineDesign['cost'];
}

export function reviewDesign(design: MachineDesign, parts: readonly InterferencePart[], library: readonly ComponentPart[] = [], pricing?: MachinePricing, builtinPricebook?: Pricebook): DesignReview {
  const interference = detectInterferences(parts);
  const cycle = reevaluateCandidateCycle(design);
  const power = estimatePower(design, { parts: library, voltage: design.power.voltage, ...(pricing ? pricing.power : {}) });
  const cost = estimateCost(design, { parts: library, ...(pricing ? { pricing } : {}), ...(builtinPricebook ? { builtinPricebook } : {}) });
  const items: DesignReviewItem[] = [];
  for (const hit of interference) items.push({
    severity: hit.severity,
    title: `干涉：${hit.a} ↔ ${hit.b}`,
    detail: `估算重叠体积 ${hit.volumeApprox.toFixed(1)} mm³；请调整结构或布局。`
  });
  items.push({
    severity: cycle.meetsTarget === true ? 'pass' : 'error',
    title: '节拍复核',
    detail: `实测模型产能 ${cycle.throughputPerMin.toFixed(2)} 件/分钟，目标 ${design.cycle.perMin} 件/分钟；瓶颈 ${cycle.bottleneck?.op ?? '—'}。`
  });
  items.push({ severity: 'pass', title: '功率与电流', detail: `装机 ${power.totalKw.toFixed(2)} kW，计算电流 ${power.currentA.toFixed(2)} A，建议断路器 ${power.breakerSuggestion.rating} A。` });
  items.push({ severity: cost.missingCount > 0 ? 'warning' : 'pass', title: '成本复核', detail: `合计 ¥${cost.total.toFixed(2)}，缺价 ${cost.missingCount} 项。` });
  for (const warning of design.warnings) items.push({ severity: 'warning', title: '方案提示', detail: warning });
  return {
    errors: items.filter((item) => item.severity === 'error').length,
    warnings: items.filter((item) => item.severity === 'warning').length,
    passed: items.filter((item) => item.severity === 'pass').length,
    items,
    interference,
    cycle,
    power,
    cost
  };
}
