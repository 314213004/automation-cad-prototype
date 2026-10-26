// 多画板 = 真实候选方案（P3 第三步）
//
// 之前三块画板是「同一张拓扑的三种产能口径」，容易被误读成三套方案。这里改成直接调用
// 与 Agent/向导同源的 design/candidates.generateCandidates → synthMachine，拿真实候选
// （不同整机形态、各自 BOM/成本/节拍/警告）来铺画板。
//
// 边界：
//   - 从画布反推的 brief 是**估计**：工位数 = 运动节点数、节拍取目标值、机构按节点类型计数。
//     它只用于方案对比，不等于真实工艺需求；真实需求要走向导第 1 步。
//   - 候选卡片里的金额来自 synthMachine 的成本模型（含内置价格簿），缺价行不计入并报 missingCount。
//   - 候选**不会**自动变成画布节点：把 MachineDesign 反解成 MountPort 拓扑需要型号级接口数据，
//     现在没有，硬转就是编造孔位。
import { generateCandidates } from '../design/candidates.ts';
import type { MachineActuatorKind, MachineBrief, MachineSensorKind } from '../machine/spec.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { isAdapterNode } from './graph.ts';
import type { MachineGraph } from './types.ts';

export interface CandidateSummary {
  formId: string;
  formName: string;
  layout: string;
  stations: number;
  /** 整机节拍 s = 60 / 估算产能。 */
  cycleSeconds: number;
  unitsPerHour: number;
  targetPerMin: number | null;
  meetsTarget: boolean | null;
  costTotalYuan: number;
  /** 缺价行数（不计入总额）。 */
  missingPriceCount: number;
  bomRows: number;
  warnings: string[];
  assumptions: string[];
}

export interface BriefFromGraphOptions {
  process?: MachineBrief['process'];
  targetPerMin?: number;
  brand?: string | null;
  voltage?: MachineBrief['voltage'];
}

/**
 * 从画布拓扑反推方案 brief（估计值）。
 * 工位数取运动节点数并夹到 1–12；机构按节点 kind 映射到 cylinder/gripper/rotary。
 */
export function briefFromGraph(graph: MachineGraph, options: BriefFromGraphOptions = {}): MachineBrief {
  const motion = graph.nodes.filter((node) => !isAdapterNode(node) && (node.stepSec > 0 || node.strokeMm > 0));
  const stations = Math.min(12, Math.max(1, motion.length || graph.nodes.length || 1));
  const counts = new Map<MachineActuatorKind, number>();
  for (const node of graph.nodes) {
    const kind: MachineActuatorKind | null =
      node.kind === 'actuator' ? 'cylinder' : node.kind === 'gripper' ? 'gripper' : node.kind === 'indexer' ? 'rotary' : null;
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const actuators = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  const di = graph.nodes.reduce((sum, node) => sum + (node.io?.di ?? 0), 0);
  const sensors: Array<{ kind: MachineSensorKind; count: number }> = [
    { kind: 'proximity', count: Math.max(1, di) }
  ];
  return {
    process: options.process ?? 'screw',
    stations,
    cyclePerMin: options.targetPerMin ?? graph.targetPerMin ?? 20,
    layout: graph.layout ?? 'single',
    actuators: actuators.length > 0 ? actuators : [{ kind: 'cylinder', count: Math.max(1, stations) }],
    sensors,
    brand: options.brand ?? null,
    voltage: options.voltage ?? null,
    notes: ['由画布拓扑反推：工位数=运动节点数、节拍=目标值、机构按节点类型计数（估计值）']
  };
}

export function summarizeDesign(design: MachineDesign): CandidateSummary {
  const throughput = design.cycle.throughputPerMin;
  const cycleSeconds = throughput > 0 ? 60 / throughput : 0;
  const target = typeof design.cycle.perMin === 'number' && design.cycle.perMin > 0 ? design.cycle.perMin : null;
  return {
    formId: design.form.id,
    formName: design.form.name,
    layout: design.cycle.mode,
    stations: design.config.stations.length,
    cycleSeconds: Number(cycleSeconds.toFixed(3)),
    unitsPerHour: Math.round(throughput * 60),
    targetPerMin: target,
    meetsTarget: target === null ? null : throughput >= target - 1e-9,
    costTotalYuan: Number(design.cost.total.toFixed(2)),
    missingPriceCount: design.cost.missingCount,
    bomRows: design.bomDraft.items.length,
    warnings: design.warnings.slice(0, 4),
    assumptions: design.assumptions.slice(0, 3)
  };
}

/**
 * 生成三套真实候选并汇总。合成失败时返回空数组（调用方回落到布局口径对比），
 * 不静默编造候选。
 */
export function buildCandidateSummaries(brief: MachineBrief): CandidateSummary[] {
  try {
    const designs = generateCandidates(brief);
    return designs.map((design) => summarizeDesign(design));
  } catch (error) {
    console.warn('[canvas] 候选方案合成失败，回落布局对比', error);
    return [];
  }
}

export interface CandidateBestMarks {
  fastestFormId: string | null;
  cheapestFormId: string | null;
  fewestStationsFormId: string | null;
  /** 成本是否可横向比较（缺价行数一致才比）。 */
  costComparable: boolean;
}

/**
 * 指标选优：最快（UPH 最大）、最低成本、最少工位。
 * 成本只有在三套候选的缺价行数一致时才比较——缺价不同时总额不可比，返回 costComparable=false。
 */
export function bestCandidateMarks(candidates: readonly CandidateSummary[]): CandidateBestMarks {
  if (candidates.length === 0) {
    return { fastestFormId: null, cheapestFormId: null, fewestStationsFormId: null, costComparable: false };
  }
  const fastest = [...candidates].sort((a, b) => b.unitsPerHour - a.unitsPerHour)[0] ?? null;
  const missing = new Set(candidates.map((item) => item.missingPriceCount));
  const costComparable = missing.size === 1;
  const cheapest = costComparable
    ? [...candidates].sort((a, b) => a.costTotalYuan - b.costTotalYuan)[0] ?? null
    : null;
  const fewest = [...candidates].sort((a, b) => a.stations - b.stations)[0] ?? null;
  return {
    fastestFormId: fastest?.formId ?? null,
    cheapestFormId: cheapest?.formId ?? null,
    fewestStationsFormId: fewest?.formId ?? null,
    costComparable
  };
}

/** 候选 → 画板标题：形态名 + 布局 + 工位数，便于一眼区分。 */
export function candidateHeadline(candidate: CandidateSummary): string {
  return `${candidate.formName}（${candidate.layout} · ${candidate.stations} 工位）`;
}
