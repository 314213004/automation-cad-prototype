// 整机形态库：把「工艺」进一步落到可复现的机架/布局组合。
// 纯数据 + 纯函数：不读写文件，不依赖 Electron；产能预演统一走 flow.ts。
//
// 诚实边界：形态选型只基于工艺适配、工位范围与静态节拍预演，不含真实结构、
// 换型时间、占地 CAD 校核与报价；warning 只说明估算缺口，不强行判为达标。

import type { MachineActuatorKind, MachineBrief, MachineProcess } from './spec.ts';
import type { FlowEvaluation, FlowModel, FlowOp, MachineLayout } from './flow.ts';
import { evaluateFlow } from './flow.ts';
import { templateFor, templateKinds, type MachineTemplate } from './templates.ts';

export type MachineFormGeometryKind = 'dial' | 'linear' | 'gantry' | 'dual';

export interface MachineFormGeometry {
  /** 交给 geometry.ts 的几何布局种类。 */
  kind: MachineFormGeometryKind;
  /** 双轨/多轨形态的轨道数。 */
  lanes?: number;
  /** 每条轨道的工位数（dual-lane 固定 2 轨 × 3 工位）。 */
  stationsPerLane?: number;
  /** 龙门轴数，仅 gantry 使用。 */
  axes?: number;
  /** 输送形式，仅 linear/dual 使用。 */
  conveyor?: 'belt' | 'chain';
  /** 分度器形式，仅 dial 使用。 */
  indexer?: 'cam' | 'dd';
}

export interface MachineForm {
  id: string;
  name: string;
  layout: MachineLayout;
  stationRange: [number, number];
  indexSeconds?: number;
  transferSeconds?: number;
  footprintScale: number;
  suits: MachineProcess[];
  rationale: string;
  geometry: MachineFormGeometry;
}

export interface FormAlternative {
  form: MachineForm;
  score: number;
  /** 一句话差异：占地 / 成本 / 换型。 */
  difference: string;
}

export interface FormPick {
  form: MachineForm;
  score: number;
  alternatives: FormAlternative[];
  warning?: string;
  /** 选型时的预演结果，方便调用方解释为什么选它。 */
  evaluation: FlowEvaluation;
  /** 实际参与预演的工位数（通常等于 brief.stations）。 */
  stations: number;
}

export interface FormPickOptions {
  stationCount?: number;
  cyclePerMin?: number;
}

export interface MachineFormSummary {
  id: string;
  name: string;
  rationale: string;
  layout: MachineLayout;
  geometry: MachineFormGeometry;
  score: number;
  alternatives: { id: string; name: string; difference: string }[];
  warning?: string;
}

/** 与 synth.ts 共用：工艺固定余量与执行机构动作时间。 */
export const PROCESS_BASE_SECONDS: Record<MachineProcess, number> = {
  screw: 2.2,
  dispense: 2.4,
  assembly: 1.8,
  inspection: 1.5,
  packaging: 1.8,
  unknown: 2
};

export const ACTUATOR_SECONDS: Record<'cylinder' | 'gripper' | 'rotary', number> = {
  cylinder: 0.4,
  gripper: 0.28,
  rotary: 0.7
};

export const MACHINE_FORMS: readonly MachineForm[] = [
  {
    id: 'dial-6',
    name: '六工位转盘机',
    layout: 'dial',
    stationRange: [2, 6],
    indexSeconds: 0.6,
    footprintScale: 0.78,
    suits: ['screw', 'dispense', 'assembly', 'packaging'],
    rationale: '转盘让上下料与作业同时进行，六工位内换型只需更换治具与凸轮程序，适合中小件锁螺丝/点胶/装配。',
    geometry: { kind: 'dial', indexer: 'cam' }
  },
  {
    id: 'dial-8',
    name: '八工位转盘机',
    layout: 'dial',
    stationRange: [6, 8],
    indexSeconds: 0.45,
    footprintScale: 0.95,
    suits: ['inspection', 'screw', 'assembly', 'dispense', 'packaging'],
    rationale: '八工位可把上料、拍照、复检与下料拆开，DD 分度更快，适合节拍较高的检测/小件装配。',
    geometry: { kind: 'dial', indexer: 'dd' }
  },
  {
    id: 'linear-4',
    name: '四工位直线机',
    layout: 'linear',
    stationRange: [2, 4],
    footprintScale: 1,
    suits: ['screw', 'dispense', 'assembly', 'inspection', 'packaging'],
    rationale: '直线四工位结构简单、输送短，工序能一一落位，适合中等节拍且换型不频繁的单机。',
    geometry: { kind: 'linear', conveyor: 'belt' }
  },
  {
    id: 'linear-8',
    name: '八工位直线线体',
    layout: 'linear',
    stationRange: [5, 8],
    transferSeconds: 0.8,
    footprintScale: 1.55,
    suits: ['assembly', 'inspection', 'packaging', 'screw', 'dispense'],
    rationale: '八工位线体把多道工序串成连续流，工位可独立扩容，适合装配/检测/包装的长工序链。',
    geometry: { kind: 'linear', conveyor: 'belt' }
  },
  {
    id: 'gantry-2',
    name: '双工位龙门机',
    layout: 'parallel',
    stationRange: [1, 6],
    footprintScale: 0.9,
    suits: ['dispense', 'screw', 'assembly', 'inspection', 'packaging'],
    rationale: '龙门双轴跨越大件上方作业，两个工位可并行上下料，适合大件点胶/锁螺丝与不宜转盘的工件。',
    geometry: { kind: 'gantry', axes: 2 }
  },
  {
    id: 'dual-lane',
    name: '双轨并行线',
    layout: 'cell',
    stationRange: [4, 6],
    transferSeconds: 0.6,
    footprintScale: 1.35,
    suits: ['inspection', 'packaging', 'assembly', 'screw', 'dispense'],
    rationale: '双轨各三工位，组内串行、两轨并行；一条轨换型/停线时另一条仍可生产，适合检测与包装的并行产出。',
    geometry: { kind: 'dual', lanes: 2, stationsPerLane: 3, conveyor: 'belt' }
  }
] as const;

const FLOW_LAYOUTS: ReadonlySet<MachineLayout> = new Set(['single', 'linear', 'dial', 'parallel', 'cell']);
const PROCESSES: ReadonlySet<MachineProcess> = new Set([
  'screw',
  'dispense',
  'assembly',
  'inspection',
  'packaging',
  'unknown'
]);
const GEOMETRY_KINDS: ReadonlySet<MachineFormGeometryKind> = new Set(['dial', 'linear', 'gantry', 'dual']);

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 校验单个形态；返回中文错误列表，空数组表示合法。 */
export function validateMachineForm(form: MachineForm): string[] {
  const errors: string[] = [];
  if (!form || typeof form !== 'object') return ['形态必须是对象'];
  if (typeof form.id !== 'string' || !form.id.trim()) errors.push('id 不能为空');
  if (typeof form.name !== 'string' || !form.name.trim()) errors.push(`${form.id || '?'}：name 不能为空`);
  if (!FLOW_LAYOUTS.has(form.layout)) errors.push(`${form.id || '?'}：layout 与 flow.ts 不一致`);
  if (!Array.isArray(form.stationRange) || form.stationRange.length !== 2) {
    errors.push(`${form.id || '?'}：stationRange 必须是 [min,max]`);
  } else {
    const [min, max] = form.stationRange;
    if (!isInteger(min) || !isInteger(max) || min < 1 || max > 12) {
      errors.push(`${form.id || '?'}：stationRange 必须是 1–12 的整数`);
    } else if (min > max) {
      errors.push(`${form.id || '?'}：stationRange 的 min 不能大于 max`);
    }
  }
  if (form.indexSeconds !== undefined && (!Number.isFinite(form.indexSeconds) || form.indexSeconds <= 0)) {
    errors.push(`${form.id || '?'}：indexSeconds 必须大于 0`);
  }
  if (form.transferSeconds !== undefined && (!Number.isFinite(form.transferSeconds) || form.transferSeconds < 0)) {
    errors.push(`${form.id || '?'}：transferSeconds 不能为负数`);
  }
  if (!Number.isFinite(form.footprintScale) || form.footprintScale <= 0) {
    errors.push(`${form.id || '?'}：footprintScale 必须大于 0`);
  }
  if (!Array.isArray(form.suits) || form.suits.length === 0) {
    errors.push(`${form.id || '?'}：suits 至少包含一种工艺`);
  } else {
    for (const process of form.suits) {
      if (!PROCESSES.has(process)) errors.push(`${form.id || '?'}：未知工艺 ${String(process)}`);
    }
  }
  if (typeof form.rationale !== 'string' || !form.rationale.trim()) errors.push(`${form.id || '?'}：rationale 不能为空`);
  if (!form.geometry || typeof form.geometry !== 'object') {
    errors.push(`${form.id || '?'}：geometry 不能为空`);
  } else {
    if (!GEOMETRY_KINDS.has(form.geometry.kind)) errors.push(`${form.id || '?'}：geometry.kind 不合法`);
    if (form.layout === 'dial' && form.geometry.kind !== 'dial') {
      errors.push(`${form.id || '?'}：dial 布局必须使用 dial 几何`);
    }
    if (form.layout === 'linear' && form.geometry.kind !== 'linear') {
      errors.push(`${form.id || '?'}：linear 布局必须使用 linear 几何`);
    }
    if (form.layout === 'parallel' && form.geometry.kind === 'dial') {
      errors.push(`${form.id || '?'}：parallel 布局不能使用 dial 几何`);
    }
    if (form.layout === 'cell' && form.geometry.kind !== 'dual') {
      errors.push(`${form.id || '?'}：cell 形态当前只支持 dual 几何`);
    }
  }
  return errors;
}

/** 校验整组形态：单条合法性 + id 唯一 + 形态数量。 */
export function validateMachineForms(forms: readonly MachineForm[] = MACHINE_FORMS): string[] {
  const errors: string[] = [];
  if (forms.length < 6) errors.push(`形态库至少需要 6 种，实际 ${forms.length} 种`);
  const ids = new Set<string>();
  for (const form of forms) {
    for (const error of validateMachineForm(form)) errors.push(error);
    if (typeof form.id === 'string') {
      if (ids.has(form.id)) errors.push(`形态 id 重复：${form.id}`);
      ids.add(form.id);
    }
  }
  return errors;
}

function distribute<T>(items: readonly T[], stations: number): T[][] {
  const buckets = Array.from({ length: stations }, () => [] as T[]);
  for (const [index, item] of items.entries()) buckets[index % stations]?.push(item);
  return buckets;
}

function processLabel(process: MachineProcess): string {
  const labels: Record<MachineProcess, string> = {
    screw: '锁螺丝',
    dispense: '点胶',
    assembly: '装配',
    inspection: '检测',
    packaging: '包装',
    unknown: '通用工艺'
  };
  return labels[process];
}

/** 需求中的布局意图；auto 时沿用解析器的推断规则（单一工艺 → 同工序并行）。 */
export function preferredLayout(brief: MachineBrief): MachineLayout {
  const declared = brief.layout ?? 'auto';
  if (declared === 'line' || declared === 'linear') return 'linear';
  if (declared === 'dial' || declared === 'cell' || declared === 'parallel' || declared === 'single') return declared;
  if ((brief.processes?.length ?? 0) >= 2) return 'linear';
  if (brief.stations <= 1) return 'parallel';
  return 'parallel';
}

function previewModel(
  brief: MachineBrief,
  form: MachineForm,
  stations: number,
  cyclePerMin: number,
  templates: Record<string, MachineTemplate>
): FlowModel {
  const template = templates[brief.process] ?? templateFor(brief.process);
  const templateActuators = templateKinds(template.actuators);
  const actuatorKinds: MachineActuatorKind[] = brief.actuators.length > 0
    ? brief.actuators.flatMap((entry) => Array.from({ length: entry.count }, () => entry.kind))
    : Array.from({ length: stations }, () => templateActuators).flat();
  const buckets = distribute(actuatorKinds, stations);
  const fillKind = templateActuators[0] ?? 'cylinder';
  for (const bucket of buckets) if (bucket.length === 0) bucket.push(fillKind);
  const baseSeconds = PROCESS_BASE_SECONDS[brief.process];
  const chain = brief.processes?.length ? brief.processes : [processLabel(brief.process)];
  const work = buckets.map((kinds, index) => ({
    index,
    seconds: baseSeconds + kinds.reduce((sum, kind) => sum + ACTUATOR_SECONDS[kind], 0)
  }));
  let ops: FlowOp[] = work.map((entry) => ({
    id: `preview-st${entry.index + 1}`,
    name: chain[entry.index % chain.length] ?? processLabel(brief.process),
    seconds: entry.seconds,
    station: entry.index
  }));
  let copies: number | undefined;
  if (form.layout === 'parallel') {
    const fullSet = work.reduce((max, entry) => Math.max(max, entry.seconds), 0);
    ops = [{ id: 'preview-parallel-set', name: chain.join(' + '), seconds: fullSet, station: 0 }];
    copies = stations;
  }
  return {
    layout: form.layout,
    stations,
    ops,
    targetPerMin: cyclePerMin,
    ...(copies === undefined ? {} : { copies }),
    ...(form.indexSeconds === undefined ? {} : { indexSeconds: form.indexSeconds }),
    ...(form.transferSeconds === undefined ? {} : { transferSeconds: form.transferSeconds })
  };
}

interface Candidate {
  form: MachineForm;
  inRange: boolean;
  processFit: boolean;
  layoutFit: boolean;
  stationDistance: number;
  evaluation: FlowEvaluation;
  score: number;
}

function scoreCandidate(
  form: MachineForm,
  stations: number,
  process: MachineProcess,
  intended: MachineLayout,
  evaluation: FlowEvaluation,
  targetPerMin: number
): number {
  const [min, max] = form.stationRange;
  const inRange = stations >= min && stations <= max;
  const distance = stations < min ? min - stations : stations > max ? stations - max : 0;
  const processFit = process === 'unknown' || form.suits.includes(process);
  const layoutFit = form.layout === intended;
  const throughput = evaluation.throughputPerMin;
  const meets = evaluation.meetsTarget === true;
  const stationScore = inRange ? 20 : Math.max(0, 20 - distance * 6);
  const processScore = process === 'unknown' ? 18 : processFit ? 25 : 0;
  const throughputScore = meets ? 15 : Math.min(12, (throughput / Math.max(targetPerMin, 1e-9)) * 12);
  const efficiency = Math.max(0, 5 - (min - 1) * 0.5);
  return (layoutFit ? 35 : 0) + processScore + stationScore + throughputScore + efficiency;
}

function footprintPercent(chosen: MachineForm, other: MachineForm): string {
  const delta = (other.footprintScale - chosen.footprintScale) / chosen.footprintScale;
  if (Math.abs(delta) < 0.01) return '占地相当';
  const pct = Math.round(Math.abs(delta) * 100);
  return delta < 0 ? `占地约小 ${pct}%` : `占地约大 ${pct}%`;
}

function costHint(chosen: MachineForm, other: MachineForm): string {
  const chosenStations = chosen.stationRange[1];
  const otherStations = other.stationRange[1];
  if (other.footprintScale <= chosen.footprintScale * 1.05 && otherStations <= chosenStations) return '成本略低';
  if (other.footprintScale >= chosen.footprintScale * 1.25 || otherStations > chosenStations + 2) return '成本更高';
  return '成本接近';
}

function changeoverHint(chosen: MachineForm, other: MachineForm): string {
  if (chosen.layout === other.layout) {
    return other.geometry.kind === chosen.geometry.kind
      ? '换型沿用同类治具'
      : '换型需要改机架/输送';
  }
  return `换型需从${chosen.name}切到${other.name}`;
}

function differenceText(chosen: MachineForm, other: MachineForm): string {
  return `${footprintPercent(chosen, other)}；${costHint(chosen, other)}；${changeoverHint(chosen, other)}。`;
}

/**
 * 形态选型：先按布局意图与工艺适配筛候选，再用 flow 引擎预演工位范围内节拍；
 * 达标者优先、工位范围更小者优先。没有候选同时满足时回退到最接近形态并给出 warning。
 */
export function pickForm(
  brief: MachineBrief,
  templates: Record<string, MachineTemplate> = {},
  options: FormPickOptions = {}
): FormPick {
  const stations = options.stationCount ?? brief.stations;
  const cyclePerMin = options.cyclePerMin ?? brief.cyclePerMin ?? 10;
  const intended = preferredLayout(brief);
  const previewable = MACHINE_FORMS.filter((form) => form.layout !== 'single');
  const formMatchesLayout = (form: MachineForm): boolean =>
    intended === 'single' ? form.layout === 'parallel' : form.layout === intended;
  const formMatchesProcess = (form: MachineForm): boolean =>
    brief.process === 'unknown' || form.suits.includes(brief.process);

  let pool = previewable.filter((form) => formMatchesLayout(form) && formMatchesProcess(form));
  let fallbackReason = '';
  if (pool.length === 0) {
    pool = previewable.filter((form) => formMatchesLayout(form));
    fallbackReason = '没有同时满足布局与工艺适配的形态';
  }
  if (pool.length === 0) {
    pool = [...previewable];
    fallbackReason = '没有与需求布局一致的形态';
  }

  const candidates: Candidate[] = pool.map((form) => {
    const evaluation = evaluateFlow(previewModel(brief, form, stations, cyclePerMin, templates));
    const [min, max] = form.stationRange;
    return {
      form,
      inRange: stations >= min && stations <= max,
      processFit: formMatchesProcess(form),
      layoutFit: formMatchesLayout(form),
      stationDistance: stations < min ? min - stations : stations > max ? stations - max : 0,
      evaluation,
      score: scoreCandidate(form, stations, brief.process, intended, evaluation, cyclePerMin)
    };
  });

  const eligible = candidates.filter((candidate) => candidate.inRange && candidate.layoutFit && candidate.processFit);
  const ranked = (eligible.length > 0 ? eligible : candidates)
    .slice()
    .sort((left, right) => {
      if (eligible.length === 0 && left.stationDistance !== right.stationDistance) {
        return left.stationDistance - right.stationDistance;
      }
      const leftMeets = left.evaluation.meetsTarget === true ? 1 : 0;
      const rightMeets = right.evaluation.meetsTarget === true ? 1 : 0;
      if (leftMeets !== rightMeets) return rightMeets - leftMeets;
      if (Math.abs(right.score - left.score) > 1e-9) return right.score - left.score;
      return left.form.stationRange[0] - right.form.stationRange[0];
    });

  const chosen = ranked[0] as Candidate;
  const missingCapacity = chosen.evaluation.meetsTarget === false
    ? Math.max(0, cyclePerMin - chosen.evaluation.throughputPerMin)
    : 0;
  const warnings: string[] = [];
  if (eligible.length === 0) {
    const reason = fallbackReason || '没有工位范围匹配的形态';
    warnings.push(
      `${reason}：已回退到最接近的 ${chosen.form.name}（支持 ${chosen.form.stationRange[0]}–${chosen.form.stationRange[1]} 工位，需求 ${stations} 工位）。`
    );
  } else if (!chosen.inRange) {
    warnings.push(
      `${chosen.form.name} 支持 ${chosen.form.stationRange[0]}–${chosen.form.stationRange[1]} 工位，需求 ${stations} 工位；请确认换型或拆分产线。`
    );
  }
  if (missingCapacity > 1e-9) {
    const missingPct = (missingCapacity / cyclePerMin) * 100;
    warnings.push(
      `${chosen.form.name} 预估 ${chosen.evaluation.throughputPerMin.toFixed(2)} 件/分钟，低于目标 ${cyclePerMin} 件/分钟，` +
      `缺口 ${missingCapacity.toFixed(2)} 件/分钟（约 ${missingPct.toFixed(1)}%）；` +
      `需增加工位/复制瓶颈或改用更高节拍形态。`
    );
  }

  const alternatives = previewable
    .filter((form) => form.id !== chosen.form.id)
    .map((form) => {
      const evaluation = evaluateFlow(previewModel(brief, form, stations, cyclePerMin, templates));
      return {
        form,
        score: scoreCandidate(form, stations, brief.process, intended, evaluation, cyclePerMin),
        difference: differenceText(chosen.form, form)
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 2);

  return {
    form: chosen.form,
    score: Math.round(chosen.score * 10) / 10,
    alternatives,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    evaluation: chosen.evaluation,
    stations
  };
}

/** 供 design_machine / 落盘 / 方案卡使用的紧凑形态记录。 */
export function summarizeForm(pick: FormPick): MachineFormSummary {
  return {
    id: pick.form.id,
    name: pick.form.name,
    rationale: pick.form.rationale,
    layout: pick.form.layout,
    geometry: pick.form.geometry,
    score: pick.score,
    alternatives: pick.alternatives.map((entry) => ({
      id: entry.form.id,
      name: entry.form.name,
      difference: entry.difference
    })),
    ...(pick.warning ? { warning: pick.warning } : {})
  };
}
