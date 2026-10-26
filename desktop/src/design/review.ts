import type { ComponentPart } from '../shared/types.ts';
import { estimateCost } from '../machine/cost-model.ts';
import { estimatePower } from '../machine/power.ts';
import type { MachinePricing } from '../machine/cost-model.ts';
import type { Pricebook } from '../cost/pricebook.ts';
import { detectInterferences, type InterferenceHit, type InterferencePart } from '../mech/interference.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { reevaluateCandidateCycle } from './candidates.ts';
import { assessStationCycles, type StationCycleAssessment, type StationCycleDraftLike } from './station-cycle.ts';

export interface DesignReviewItem {
  severity: 'error' | 'warning' | 'pass';
  title: string;
  detail: string;
}
export interface DesignReview {
  errors: number;
  warnings: number;
  passed: number;
  geometryCheck: 'not-executed' | 'aabb-screened';
  sourceSignature: string;
  items: DesignReviewItem[];
  interference: InterferenceHit[];
  cycle: StationCycleAssessment;
  power: MachineDesign['power'];
  cost: MachineDesign['cost'];
}

function reviewSourceSignature(
  design: MachineDesign,
  parts: readonly InterferencePart[],
  library: readonly ComponentPart[],
  pricing?: MachinePricing,
  builtinPricebook?: Pricebook,
  stations: readonly StationCycleDraftLike[] = []
): string {
  return JSON.stringify({
    config: design.config,
    stationIdentities: design.stationIdentities ?? null,
    stationGeometryLayout: design.stationGeometryLayout ?? null,
    bomDraft: design.bomDraft,
    form: { id: design.form.id, geometry: design.form.geometry },
    cycle: { mode: design.cycle.mode, perMin: design.cycle.perMin },
    stationCycles: stations.map((station) => ({ id: station.id, name: station.name, cycleTime: station.cycleTime ?? null })),
    voltage: design.power.voltage,
    warnings: design.warnings,
    parts,
    library,
    pricing: pricing ?? null,
    builtinPricebook: builtinPricebook ?? null
  });
}

/** 校核只对其实际读取的设计、场景、元件库和价格输入有效；任一变化都须重校核。 */
export function isDesignReviewCurrent(
  review: DesignReview | null | undefined,
  design: MachineDesign,
  parts: readonly InterferencePart[] = [],
  library: readonly ComponentPart[] = [],
  pricing?: MachinePricing,
  builtinPricebook?: Pricebook,
  stations: readonly StationCycleDraftLike[] = []
): boolean {
  return Boolean(review && review.sourceSignature === reviewSourceSignature(design, parts, library, pricing, builtinPricebook, stations));
}

export function buildCycleEngineeringNote(
  design: MachineDesign,
  source: 'model-estimate' | 'engineer-input'
): { kind: 'warning' | 'assumption'; detail: string } {
  const actuators = design.config.actuators;
  const linear = actuators.filter((actuator) => actuator.kind !== 'rotary');
  const rotary = actuators.filter((actuator) => actuator.kind === 'rotary');
  const sourceCount = (items: typeof actuators, isEngineerInput: (item: typeof actuators[number]) => boolean): string => {
    if (items.length === 0) return '无执行机构';
    const entered = items.filter(isEngineerInput).length;
    return `工程师输入 ${entered}/${items.length} 项，方案/系统默认 ${items.length - entered}/${items.length} 项`;
  };
  const trace = `运动参数来源：直线行程 ${sourceCount(linear, (actuator) => actuator.travelSource === 'engineer-input')}；旋转分度角 ${sourceCount(rotary, (actuator) => actuator.rotationRangeSource === 'engineer-input')}。`;

  return source === 'engineer-input'
    ? {
      kind: 'assumption',
      detail: `节拍计算依据为工程师输入的完整工位周期（仍待现场实测）；行程/分度角（包括工程师输入）仅用于概念运动几何预览，单动作 durationMs 仅用于动画预览，两者均不参与周期计算。${trace}`
    }
    : {
      kind: 'warning',
      detail: `模型节拍估算仅按工艺与执行机构类别默认值；行程/分度角（包括工程师输入）只驱动概念运动几何预览，单动作 durationMs 只用于动画预览，均不参与节拍估算。当前模型未纳入可信速度/加速度、完整动作时序、并行调度、等待/上下料时间或现场实测数据，不能签核。${trace}`
    };
}

export function reviewDesign(design: MachineDesign, parts: readonly InterferencePart[], library: readonly ComponentPart[] = [], pricing?: MachinePricing, builtinPricebook?: Pricebook, stations: readonly StationCycleDraftLike[] = []): DesignReview {
  const interference = detectInterferences(parts);
  const cycle = assessStationCycles(reevaluateCandidateCycle(design), stations, design.cycle.perMin);
  const servo = design.bomDraft.items.some((item) => item.role === 'servo' || /伺服驱动器|伺服电机/.test(item.name));
  const power = estimatePower(design, { parts: library, servo, voltage: design.power.voltage, ...(pricing ? pricing.power : {}) });
  const cost = estimateCost(design, { parts: library, ...(pricing ? { pricing } : {}), ...(builtinPricebook ? { builtinPricebook } : {}) });
  const items: DesignReviewItem[] = [];
  if (parts.length === 0) items.push({
    severity: 'error',
    title: '干涉初筛未执行',
    detail: '当前 CAD 视口没有可检查的零件，干涉初筛未执行；请先打开并确认模型已载入，再重新校核。'
  });
  for (const hit of interference) items.push({
    severity: hit.severity,
    title: `干涉：${hit.a} ↔ ${hit.b}`,
    detail: `估算重叠体积 ${hit.volumeApprox.toFixed(1)} mm³；请调整结构或布局。`
  });
  const cycleTitle = cycle.source === 'engineer-input'
    ? '工位节拍输入（工程师输入/待实测）'
    : cycle.manualCalculationBlockedReason
      ? '人工周期输入未用于产能判定'
      : '节拍估算（未实测）';
  const cycleInputCoverage = cycle.inputStatus === 'none'
    ? '当前尚未录入工位周期。'
    : [
      `当前已录入 ${cycle.enteredStations} 个工位`,
      cycle.missingStations.length > 0 ? `未填写：${cycle.missingStations.join('、')}` : '',
      cycle.invalidStations.length > 0 ? `无效：${cycle.invalidStations.join('、')}` : '',
      cycle.unconfirmedStations.length > 0 ? `公共时间口径未确认：${cycle.unconfirmedStations.join('、')}` : ''
    ].filter(Boolean).join('；');
  const cycleLayoutUnsupported = cycle.mode === 'parallel' || cycle.mode === 'cell' ||
    (cycle.mode === 'single' && cycle.enteredStations + cycle.missingStations.length !== 1);
  const cycleEngineeringNote = buildCycleEngineeringNote(design, cycle.source).detail;
  const cycleDetail = cycle.source === 'engineer-input'
    ? `来源：工程师输入/待实测。已完整录入并确认 ${cycle.enteredStations} 个工位的完整循环，取瓶颈工位「${cycle.bottleneckStationName ?? `工位${(cycle.bottleneck?.station ?? 0) + 1}`}」${cycle.cycleSeconds.toFixed(2)} 秒/件计算，产能 ${cycle.throughputPerMin.toFixed(2)} 件/分钟，目标 ${design.cycle.perMin} 件/分钟；${cycle.meetsTarget === true ? '输入值覆盖目标，但仍待实测，不是工程达标结论。' : '输入值低于目标。'}公共等待、移载、上下料${cycle.mode === 'dial' ? '及每次转盘分度' : ''}已按界面确认计入输入，不再重复叠加。${cycleEngineeringNote}`
    : cycle.manualCalculationBlockedReason
      ? `模型估算产能 ${cycle.throughputPerMin.toFixed(2)} 件/分钟（未实测）；${cycle.meetsTarget === true ? '模型估算覆盖目标，但不代表工程达标。' : cycle.meetsTarget === false ? '模型估算低于目标。' : '模型未给出目标对比。'}${cycleEngineeringNote}因为${cycle.inputStatus === 'unconfirmed' ? '公共时间口径未确认' : '布局/通道映射不明确'}，${cycleLayoutUnsupported ? '该布局存在永久限制：人工周期即使补齐也仅作记录、不参与产能计算' : '人工值当前未参与计算'}，基于人工输入的目标判定已停用。${cycle.manualCalculationBlockedReason}${cycleInputCoverage}`
      : `模型估算产能 ${cycle.throughputPerMin.toFixed(2)} 件/分钟，目标 ${design.cycle.perMin} 件/分钟；瓶颈 ${cycle.bottleneck?.op ?? '—'}。${cycle.meetsTarget === true ? '估算值覆盖目标，但不代表工程达标。' : '估算值低于目标。'}${cycleEngineeringNote}${cycle.inputStatus === 'none' ? '尚未录入完整工位周期。' : cycle.inputStatus === 'unconfirmed' ? `周期值已录入，但公共时间口径未确认：${cycle.unconfirmedStations.join('、')}；基于手工值的目标判定已停用。` : `当前有 ${cycle.enteredStations} 个工位已输入，但工位周期${cycle.inputStatus === 'invalid' ? `无效：${cycle.invalidStations.join('、')}` : `未完整：${cycle.missingStations.join('、')}`}；所有工位均有大于 0 的有效值并确认公共时间口径后才会采用工程师输入。`}`;
  items.push({
    severity: 'warning',
    title: cycleTitle,
    detail: cycleDetail
  });
  items.push({ severity: 'pass', title: '功率与电流', detail: `装机 ${power.totalKw.toFixed(2)} kW，计算电流 ${power.currentA.toFixed(2)} A，建议断路器 ${power.breakerSuggestion.rating} A。` });
  items.push({ severity: cost.missingCount > 0 ? 'warning' : 'pass', title: '成本复核', detail: `合计 ¥${cost.total.toFixed(2)}，缺价 ${cost.missingCount} 项。` });
  for (const warning of design.warnings) items.push({ severity: 'warning', title: '方案提示', detail: warning });
  return {
    errors: items.filter((item) => item.severity === 'error').length,
    warnings: items.filter((item) => item.severity === 'warning').length,
    passed: items.filter((item) => item.severity === 'pass').length,
    geometryCheck: parts.length === 0 ? 'not-executed' : 'aabb-screened',
    sourceSignature: reviewSourceSignature(design, parts, library, pricing, builtinPricebook, stations),
    items,
    interference,
    cycle,
    power,
    cost
  };
}
