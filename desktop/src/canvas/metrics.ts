// 画布指标：整机 CT/UPH 走 machine/flow.ts 的 evaluateFlow，单轴走梯形速度曲线。
//
// 规格书第 3 节第 2 条：原型 `totalCT = Σ stepDuration` 是纯串行口径，
// 会同一台并行/单元式机器算慢，与 flow.ts 冲突。本模块**一律**调用 evaluateFlow，
// ΣstepSec 只作为甘特图与单轴选型的输入，绝不进入 CT/UPH。
//
// 价格口径（规格书第 3 节第 3 条）：本文件里**没有任何金额常量**。所有金额来自
// 调用方注入的 priceLookup(partId)；查不到 → null → 进「待询价」且不计入总额，
// 总额标注「不完全统计」。
//
// 单位：入参长度 mm、时间 s、质量 kg；公式内部统一换算 SI（m、kg、N、N·m、rad/s²），
// 输出字段用后缀标明单位（Ms / Sec / Nm / KgM2 / Mm / Mpa / RadS2）。
import { evaluateFlow, type FlowEvaluation, type FlowModel, type FlowOp } from '../machine/flow.ts';
import type { CanvasNode, MachineGraph } from './types.ts';
import { findMismatchedEdges, isAdapterNode } from './graph.ts';

// ---------------------------------------------------------------------------
// 整机指标
// ---------------------------------------------------------------------------

/** 价格查询注入。返回 null = 该 partId 无价可查 → 待询价。 */
export type PriceLookup = (partId: string) => number | null;

export interface PendingQuoteItem {
  nodeId: string;
  name: string;
  /** null = 节点没有 partId（待选型）。 */
  partId: string | null;
  reason: string;
  qty: number;
}

export interface CostSummary {
  /** 只累加查到价的节点；缺价不计入。 */
  totalYuan: number;
  pricedNodes: number;
  /** 待询价清单（缺 partId 或价格簿无价）。 */
  pendingQuote: PendingQuoteItem[];
  /** 缺价时 false，UI 必须显示「不完全统计」。 */
  complete: boolean;
  label: string;
}

export interface MachineMetricsOptions {
  priceLookup: PriceLookup;
  /** 覆盖图上 layout/target 等；显式 flow 优先（同 brief 对照用）。 */
  flow?: FlowModel;
  targetPerMin?: number;
  transferSeconds?: number;
  indexSeconds?: number;
  lanes?: number;
  /** 单轴伺服选型参数注入。 */
  axis?: AxisSizingOptions;
}

export interface MachineMetrics {
  /** = evaluateFlow().cycleSeconds（单件产出节拍，s）。 */
  cycleSeconds: number;
  throughputPerMin: number;
  unitsPerHour: number;
  /** 完整评估结果，含瓶颈工位与 notes。无运动节点时为 null。 */
  flow: FlowEvaluation | null;
  cost: CostSummary;
  nodeCount: number;
  adapterCount: number;
  mismatchCount: number;
  /** 主运动轴（行程×导程都 > 0 的最大行程节点）的选型结果；无则 null。 */
  primaryAxis: { nodeId: string; name: string; sizing: AxisSizingResult } | null;
  notes: string[];
}

/** 参与节拍的节点：非转接板且 stepSec > 0。 */
function motionNodes(graph: MachineGraph): CanvasNode[] {
  return graph.nodes.filter((node) => !isAdapterNode(node) && node.stepSec > 0);
}

/**
 * 图上拓扑 → flow.ts 的 FlowModel。
 *
 * 缺省工位归集：每个运动节点算一个独立工位（node.station 显式给出时优先）。
 * 这是**假设**，不是物理事实——排布不同（多个动作挤在一个工位、或一个模组横跨两工位）
 * 请在节点上写 station。layout='single' 时全部工序落在工位 0（单工位串行）。
 */
export function graphFlowModel(graph: MachineGraph, options: MachineMetricsOptions): FlowModel {
  if (options.flow) return options.flow;
  const motion = motionNodes(graph);
  const layout = graph.layout ?? 'single';
  const ops: FlowOp[] = [];
  let stations = 1;

  if (layout === 'single' || layout === 'parallel') {
    stations = layout === 'parallel' ? Math.max(1, motion.length) : 1;
    motion.forEach((node, index) => {
      ops.push({
        id: node.id,
        name: node.name,
        seconds: node.stepSec,
        station: layout === 'parallel' ? Math.min(index, stations - 1) : 0
      });
    });
  } else {
    motion.forEach((node, index) => {
      const station = node.station ?? index;
      ops.push({ id: node.id, name: node.name, seconds: node.stepSec, station });
    });
    stations = Math.max(1, ...motion.map((node, index) => (node.station ?? index) + 1));
  }

  const model: FlowModel = { layout, stations, ops };
  const targetPerMin = options.targetPerMin ?? graph.targetPerMin;
  if (targetPerMin !== undefined) model.targetPerMin = targetPerMin;
  const transferSeconds = options.transferSeconds ?? graph.transferSeconds;
  if (transferSeconds !== undefined) model.transferSeconds = transferSeconds;
  const indexSeconds = options.indexSeconds ?? graph.indexSeconds;
  if (indexSeconds !== undefined) model.indexSeconds = indexSeconds;
  const lanes = options.lanes ?? graph.lanes;
  if (lanes !== undefined) model.lanes = lanes;
  if (layout === 'parallel') model.copies = stations;
  return model;
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

/** 成本汇总：只认 lookup，缺价进待询价。 */
export function costSummary(graph: MachineGraph, priceLookup: PriceLookup): CostSummary {
  if (typeof priceLookup !== 'function') {
    throw new Error('priceLookup 必须由调用方注入（本模块不含任何内置单价）');
  }
  const pendingQuote: PendingQuoteItem[] = [];
  let totalYuan = 0;
  let pricedNodes = 0;
  for (const node of graph.nodes) {
    if (node.partId === undefined || node.partId.trim() === '') {
      pendingQuote.push({
        nodeId: node.id,
        name: node.name,
        partId: null,
        reason: '缺 partId（待选型），无价格来源',
        qty: 1
      });
      continue;
    }
    const price = priceLookup(node.partId);
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      pendingQuote.push({
        nodeId: node.id,
        name: node.name,
        partId: node.partId,
        reason: `价格簿查不到型号 ${node.partId}`,
        qty: 1
      });
      continue;
    }
    totalYuan += price;
    pricedNodes += 1;
  }
  const complete = pendingQuote.length === 0;
  return {
    totalYuan: roundTo(totalYuan, 2),
    pricedNodes,
    pendingQuote,
    complete,
    label: complete ? '价格齐全' : `不完全统计（${pendingQuote.length} 项待询价）`
  };
}

/** 沿出边向下游累加质量（含转接板），用作该轴的负载质量 kg。 */
function carriedMassAlong(graph: MachineGraph, nodeId: string): number {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const seen = new Set<string>([nodeId]);
  const queue = [...(outgoing.get(nodeId) ?? [])];
  let mass = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    mass += node.massKg;
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  return roundTo(mass, 3);
}

/** 主运动轴：行程与导程都 > 0，取行程最大者（并列取先出现者）。 */
export function selectPrimaryAxis(graph: MachineGraph): CanvasNode | null {
  let best: CanvasNode | null = null;
  for (const node of graph.nodes) {
    if (isAdapterNode(node)) continue;
    if (node.strokeMm <= 0 || node.leadMm <= 0) continue;
    if (!best || node.strokeMm > best.strokeMm) best = node;
  }
  return best;
}

export function machineMetrics(graph: MachineGraph, options: MachineMetricsOptions): MachineMetrics {
  const notes: string[] = [];
  const model = graphFlowModel(graph, options);
  const flow = model.ops.length > 0 ? evaluateFlow(model) : null;
  if (flow === null) {
    notes.push('图中没有 stepSec > 0 的运动节点，CT/UPH 不适用（不是 0 秒节拍）。');
  }

  const cycleSeconds = flow === null ? 0 : roundTo(flow.cycleSeconds, 3);
  const throughputPerMin = flow === null ? 0 : roundTo(flow.throughputPerMin, 3);
  const unitsPerHour = flow === null ? 0 : Math.round(flow.throughputPerMin * 60);

  const cost = costSummary(graph, options.priceLookup);
  if (!cost.complete) {
    notes.push(`${cost.label}：总额仅统计查得到价的 ${cost.pricedNodes} 项，不代表整机报价。`);
  }

  const adapterCount = graph.nodes.filter((node) => isAdapterNode(node)).length;
  const mismatchCount = findMismatchedEdges(graph).length;
  if (mismatchCount > 0) {
    notes.push(`存在 ${mismatchCount} 条端口不兼容直连边，需插入转接板后才能定版。`);
  }

  const primary = selectPrimaryAxis(graph);
  let primaryAxis: MachineMetrics['primaryAxis'] = null;
  if (primary) {
    const carried = carriedMassAlong(graph, primary.id);
    const sizing = axisSizing(primary, carried, primary.stepSec, options.axis ?? {});
    primaryAxis = { nodeId: primary.id, name: primary.name, sizing };
    notes.push(`主运动轴按 ${primary.name}（行程 ${primary.strokeMm}mm）选型，负载质量 ${carried}kg 由下游节点质量累加。`);
  }

  if (flow) notes.push(...flow.notes);

  return {
    cycleSeconds,
    throughputPerMin,
    unitsPerHour,
    flow,
    cost,
    nodeCount: graph.nodes.length,
    adapterCount,
    mismatchCount,
    primaryAxis,
    notes
  };
}

// ---------------------------------------------------------------------------
// 单轴伺服 / 丝杠选型（梯形速度曲线）
// ---------------------------------------------------------------------------

export interface AxisSizingOptions {
  /** 加速段时间占单步总时间的比例；默认 0.25 → 加速 25% + 匀速 50% + 减速 25%。 */
  accelTimeRatio?: number;
  /** 丝杠/带传动效率 η，默认 0.9。 */
  efficiency?: number;
  /** 导轨摩擦系数 μ，默认 0.05。 */
  frictionCoeff?: number;
  /** 密封/预紧附加阻力 N，默认 10（可注入实测值）。 */
  sealFrictionN?: number;
  /** 电机转子惯量 kg·m²，默认 1.2e-5（200–400W 伺服典型量级，正式选型请注入样本值）。 */
  rotorInertiaKgM2?: number;
  /** 丝杠公称直径 mm，默认 16。 */
  screwDiaMm?: number;
  /** 丝杠长度 mm，默认 strokeMm + 100。 */
  screwLengthMm?: number;
  /** 丝杠材料密度 kg/m³，默认 7850（钢）。 */
  screwDensityKgM3?: number;
  /** 悬臂臂长 mm（导轨前沿到工具中心），默认 300。 */
  cantileverArmMm?: number;
  /** 悬臂截面宽 mm，默认 60。 */
  sectionWidthMm?: number;
  /** 悬臂截面高 mm，默认 60。 */
  sectionHeightMm?: number;
  /** 弹性模量 Pa，默认 70e9（铝）。 */
  youngsModulusPa?: number;
  /** 惯量比上限，默认 10。 */
  inertiaRatioLimit?: number;
  /** 悬臂挠度上限 mm，默认 0.05。 */
  deflectionLimitMm?: number;
  /** 重力加速度 m/s²，默认 9.80665。 */
  gravity?: number;
}

/** 全部输入 SI/mm 混用处的换算都写在字段注释与 formulas 里。 */
export interface AxisSizingResult {
  /** 输入回显（mm / s / kg）。 */
  strokeMm: number;
  leadMm: number;
  stepSec: number;
  carriedMassKg: number;
  /** 加速段 s。 */
  tAccelSec: number;
  /** 匀速段 s。 */
  tConstSec: number;
  /** 最大线速度 m/s：v_max = s / (t_acc + t_const)。 */
  vMaxMs: number;
  /** 直线加速度 m/s²：a = v_max / t_acc。 */
  accelMs2: number;
  /** 电机最高转速 rpm：n = v_max / (lead/1000) × 60。 */
  maxRpm: number;
  /** 电机角速度 rad/s。 */
  omegaMaxRadS: number;
  /** 电机角加速度 rad/s²。 */
  alphaRadS2: number;
  /** 折算到电机轴的负载惯量 kg·m²：J = m(lead/2π)² + J_screw。 */
  jLoadKgM2: number;
  /** 丝杠自身惯量 kg·m²：(π/32)·ρ·L·D⁴。 */
  jScrewKgM2: number;
  /** 电机转子惯量 kg·m²（注入值）。 */
  jRotorKgM2: number;
  /** 惯量比 = J_load / J_rotor。 */
  inertiaRatio: number;
  /** 摩擦阻力 N：F = μmg + F_seal。 */
  frictionForceN: number;
  /** 摩擦扭矩 N·m：T = F·lead/(2π·η)。 */
  tFrictionNm: number;
  /** 加速扭矩 N·m：T = (J_load + J_rotor)·α。 */
  tAccelNm: number;
  /** 峰值扭矩 N·m = 加速 + 摩擦。 */
  tPeakNm: number;
  /** 均方根扭矩 N·m（按加速/匀速两段加权的等效发热扭矩）。 */
  tRmsNm: number;
  /** 悬臂端挠度 mm：δ = F·L³/(3·E·I)。 */
  deflectionMm: number;
  /** 悬臂根部弯曲应力 MPa。 */
  bendingStressMpa: number;
  checks: {
    inertiaOk: boolean;
    deflectionOk: boolean;
  };
  pass: boolean;
  verdict: string;
  formulas: string[];
}

const AXIS_DEFAULTS = {
  accelTimeRatio: 0.25,
  efficiency: 0.9,
  frictionCoeff: 0.05,
  sealFrictionN: 10,
  rotorInertiaKgM2: 1.2e-5,
  screwDiaMm: 16,
  screwDensityKgM3: 7850,
  cantileverArmMm: 300,
  sectionWidthMm: 60,
  sectionHeightMm: 60,
  youngsModulusPa: 70e9,
  inertiaRatioLimit: 10,
  deflectionLimitMm: 0.05,
  gravity: 9.80665
} as const;

function positive(value: unknown, label: string, unit: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的数值（${unit}）`);
  }
  return value;
}

function nonNegative(value: unknown, label: string, unit: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是不小于 0 的数值（${unit}）`);
  }
  return value;
}

function fmt(value: number, digits = 3): string {
  return value.toFixed(digits);
}

/**
 * 梯形（等加速-匀速-等减速）速度曲线下，单轴"电机 + 丝杠"选型。
 *
 * 公式（s = 行程 m，lead = 导程 mm，t = 单步时间 s，m = 负载质量 kg）：
 *   t_acc = ratio·t，t_const = t − 2·t_acc
 *   v_max = s / (t_acc + t_const)                     （加速/减速段平均速度 = v_max/2）
 *   a     = v_max / t_acc
 *   n_max = v_max / (lead/1000) × 60                   （rpm）
 *   ω_max = n_max·2π/60，α = ω_max / t_acc
 *   J_load = m·(lead/2000π)² + J_screw，J_screw = (π/32)·ρ·L·D⁴
 *   惯量比 = J_load / J_rotor
 *   F_fric = μ·m·g + F_seal，T_fric = F_fric·(lead/1000)/(2π·η)
 *   T_acc = (J_load + J_rotor)·α，T_peak = T_acc + T_fric
 *   T_rms = √[(T_peak²·2t_acc + T_fric²·t_const) / t]
 *   δ = F·L³/(3·E·I)，I = w·h³/12（mm⁴ → m⁴ 乘 1e-12）
 *
 * 诚实边界：不含减速箱/联轴器刚度、丝杠临界转速、热伸长、切削力与动态跟随误差；
 * 结果只用于方案阶段初选，不替代电机厂样本校核。
 */
export function axisSizing(
  node: CanvasNode,
  carriedMassKg: number,
  stepSec: number,
  options: AxisSizingOptions = {}
): AxisSizingResult {
  if (!node || typeof node !== 'object') throw new Error('axisSizing 需要画布节点');
  const strokeMm = positive(node.strokeMm, '行程 strokeMm', 'mm');
  const leadMm = positive(node.leadMm, '导程 leadMm', 'mm');
  const step = positive(stepSec, '单步时间 stepSec', 's');
  const mass = nonNegative(carriedMassKg, '负载质量 carriedMassKg', 'kg');

  const ratio = options.accelTimeRatio ?? AXIS_DEFAULTS.accelTimeRatio;
  if (!(ratio > 0 && ratio < 0.5)) throw new Error('加速段时间占比必须在 (0, 0.5) 开区间内');
  const efficiency = options.efficiency ?? AXIS_DEFAULTS.efficiency;
  if (!(efficiency > 0 && efficiency <= 1)) throw new Error('传动效率必须在 (0, 1] 区间内');
  const mu = nonNegative(options.frictionCoeff ?? AXIS_DEFAULTS.frictionCoeff, '摩擦系数 μ', '');
  const sealFrictionN = nonNegative(options.sealFrictionN ?? AXIS_DEFAULTS.sealFrictionN, '密封阻力', 'N');
  const rotor = positive(options.rotorInertiaKgM2 ?? AXIS_DEFAULTS.rotorInertiaKgM2, '转子惯量', 'kg·m²');
  const screwDiaMm = positive(options.screwDiaMm ?? AXIS_DEFAULTS.screwDiaMm, '丝杠直径', 'mm');
  const screwLengthMm = positive(
    options.screwLengthMm ?? strokeMm + 100,
    '丝杠长度',
    'mm'
  );
  const rho = positive(options.screwDensityKgM3 ?? AXIS_DEFAULTS.screwDensityKgM3, '丝杠密度', 'kg/m³');
  const armMm = positive(options.cantileverArmMm ?? AXIS_DEFAULTS.cantileverArmMm, '悬臂臂长', 'mm');
  const sectionWidthMm = positive(options.sectionWidthMm ?? AXIS_DEFAULTS.sectionWidthMm, '悬臂截面宽', 'mm');
  const sectionHeightMm = positive(options.sectionHeightMm ?? AXIS_DEFAULTS.sectionHeightMm, '悬臂截面高', 'mm');
  const youngs = positive(options.youngsModulusPa ?? AXIS_DEFAULTS.youngsModulusPa, '弹性模量', 'Pa');
  const inertiaLimit = positive(options.inertiaRatioLimit ?? AXIS_DEFAULTS.inertiaRatioLimit, '惯量比上限', '');
  const deflectionLimit = positive(options.deflectionLimitMm ?? AXIS_DEFAULTS.deflectionLimitMm, '挠度上限', 'mm');
  const gravity = positive(options.gravity ?? AXIS_DEFAULTS.gravity, '重力加速度', 'm/s²');

  // —— 速度 / 加速度 ——（内部 SI）
  const strokeM = strokeMm / 1000;
  const pitchM = leadMm / 1000;
  const tAccel = ratio * step;
  const tConst = step - 2 * tAccel;
  const vMax = strokeM / (tAccel + tConst);
  const accel = vMax / tAccel;
  const maxRpm = (vMax / pitchM) * 60;
  const omegaMax = (maxRpm * 2 * Math.PI) / 60;
  const alpha = omegaMax / tAccel;

  // —— 惯量 ——（kg·m²）
  const screwDiaM = screwDiaMm / 1000;
  const screwLengthM = screwLengthMm / 1000;
  const jScrew = (Math.PI / 32) * rho * screwLengthM * screwDiaM ** 4;
  const jLoad = mass * (pitchM / (2 * Math.PI)) ** 2 + jScrew;
  const inertiaRatio = jLoad / rotor;

  // —— 扭矩 ——（N·m）
  const frictionForce = mu * mass * gravity + sealFrictionN;
  const tFriction = (frictionForce * pitchM) / (2 * Math.PI * efficiency);
  const tAccelNm = (jLoad + rotor) * alpha;
  const tPeak = tAccelNm + tFriction;
  const tRms = Math.sqrt((tPeak ** 2 * 2 * tAccel + tFriction ** 2 * tConst) / step);

  // —— 悬臂挠度 ——（mm）
  const tipForce = mass * gravity;
  const armM = armMm / 1000;
  const inertiaM4 = (sectionWidthMm * sectionHeightMm ** 3) / 12 * 1e-12;
  const deflectionM = (tipForce * armM ** 3) / (3 * youngs * inertiaM4);
  const deflectionMm = deflectionM * 1000;
  const sectionModulusMm3 = (sectionWidthMm * sectionHeightMm ** 2) / 6;
  const bendingStressMpa = sectionModulusMm3 > 0
    ? (tipForce * armMm) / sectionModulusMm3
    : 0;

  const inertiaOk = inertiaRatio <= inertiaLimit;
  const deflectionOk = deflectionMm <= deflectionLimit;
  const pass = inertiaOk && deflectionOk;

  const formulas = [
    `t_acc = ${fmt(ratio, 2)}×${fmt(step, 3)} = ${fmt(tAccel, 4)} s，t_const = ${fmt(tConst, 4)} s`,
    `v_max = ${fmt(strokeM, 4)} / (${fmt(tAccel, 4)} + ${fmt(tConst, 4)}) = ${fmt(vMax, 4)} m/s；a = v_max/t_acc = ${fmt(accel, 2)} m/s²`,
    `n_max = v_max/(${fmt(pitchM, 4)})×60 = ${fmt(maxRpm, 1)} rpm；ω_max = ${fmt(omegaMax, 2)} rad/s，α = ${fmt(alpha, 1)} rad/s²`,
    `J_screw = π/32·ρ·L·D⁴ = ${fmt(jScrew, 9)} kg·m²；J_load = m(lead/2π)² + J_screw = ${fmt(jLoad, 9)} kg·m²`,
    `惯量比 = ${fmt(jLoad, 9)} / ${fmt(rotor, 9)} = ${fmt(inertiaRatio, 2)}（上限 ${fmt(inertiaLimit, 1)}）`,
    `F_fric = μmg + F_seal = ${fmt(frictionForce, 2)} N；T_fric = F·lead/(2πη) = ${fmt(tFriction, 4)} N·m`,
    `T_peak = (J_load+J_rotor)·α + T_fric = ${fmt(tPeak, 4)} N·m；T_rms = ${fmt(tRms, 4)} N·m`,
    `δ = F·L³/(3EI) = ${fmt(tipForce, 2)}×${fmt(armM, 3)}³/(3×${youngs.toExponential(2)}×${inertiaM4.toExponential(3)}) = ${fmt(deflectionMm, 4)} mm（上限 ${fmt(deflectionLimit, 3)} mm）`
  ];

  const verdict = pass
    ? `惯量比 ${fmt(inertiaRatio, 2)}、挠度 ${fmt(deflectionMm, 4)}mm 均在限值内；峰值扭矩 ${fmt(tPeak, 3)} N·m、RMS ${fmt(tRms, 3)} N·m 需与电机样本核对`
    : `不满足：${[
        inertiaOk ? null : `惯量比 ${fmt(inertiaRatio, 2)} > ${fmt(inertiaLimit, 1)}（加减速器或减小负载质量）`,
        deflectionOk ? null : `挠度 ${fmt(deflectionMm, 4)}mm > ${fmt(deflectionLimit, 3)}mm（加大截面或缩短悬臂）`
      ]
        .filter((item): item is string => item !== null)
        .join('；')}`;

  return {
    strokeMm,
    leadMm,
    stepSec: step,
    carriedMassKg: mass,
    tAccelSec: roundTo(tAccel, 6),
    tConstSec: roundTo(tConst, 6),
    vMaxMs: roundTo(vMax, 6),
    accelMs2: roundTo(accel, 4),
    maxRpm: roundTo(maxRpm, 2),
    omegaMaxRadS: roundTo(omegaMax, 4),
    alphaRadS2: roundTo(alpha, 3),
    jLoadKgM2: roundTo(jLoad, 10),
    jScrewKgM2: roundTo(jScrew, 10),
    jRotorKgM2: roundTo(rotor, 10),
    inertiaRatio: roundTo(inertiaRatio, 3),
    frictionForceN: roundTo(frictionForce, 3),
    tFrictionNm: roundTo(tFriction, 6),
    tAccelNm: roundTo(tAccelNm, 6),
    tPeakNm: roundTo(tPeak, 6),
    tRmsNm: roundTo(tRms, 6),
    deflectionMm: roundTo(deflectionMm, 6),
    bendingStressMpa: roundTo(bendingStressMpa, 4),
    checks: { inertiaOk, deflectionOk },
    pass,
    verdict,
    formulas
  };
}

// ---------------------------------------------------------------------------
// 丝杠临界转速 / 压杆稳定 / DN 值
// ---------------------------------------------------------------------------

export type ScrewEndFixity = 'fixed-fixed' | 'fixed-supported' | 'supported-supported' | 'fixed-free';

/** 端部支撑方式 → 横向振动特征值 β 与压杆长度系数 K。 */
const END_FIXITY: Record<ScrewEndFixity, { beta: number; k: number; label: string }> = {
  'fixed-fixed': { beta: 4.73, k: 0.5, label: '两端固定' },
  'fixed-supported': { beta: 3.927, k: 0.707, label: '一端固定一端支撑' },
  'supported-supported': { beta: Math.PI, k: 1, label: '两端简支' },
  'fixed-free': { beta: 1.875, k: 2, label: '一端固定一端自由' }
};

export interface ScrewSizingOptions {
  /** 公称直径 mm，默认 16。 */
  screwDiaMm?: number;
  /** 螺纹底径 mm；缺省按 公称直径 − 3mm 估（滚珠丝杠常用 d − 1.2×珠径）。 */
  rootDiaMm?: number;
  /** 支撑跨距 mm，默认行程 + 100。 */
  lengthMm?: number;
  endFixity?: ScrewEndFixity;
  /** 钢 7850 kg/m³。 */
  densityKgM3?: number;
  /** 钢 206 GPa。 */
  youngsModulusPa?: number;
  /** DN 值上限 mm·rpm，脂润滑保守取 80000。 */
  dnLimit?: number;
  /** 临界转速降额系数，默认 0.8（样本通常要求 ≤ 80% n_cr）。 */
  criticalSpeedDerate?: number;
  /** 压杆稳定安全系数，默认 2.5。 */
  bucklingSafety?: number;
  /** 轴向工作载荷 N（预紧/顶推），默认 0 → 压杆稳定不判定。 */
  axialLoadN?: number;
  /** 实际最高工作转速 rpm（由 axisSizing 的 maxRpm 传入）；缺省只算允许值。 */
  maxRpm?: number;
}

export interface ScrewSizingResult {
  rootDiaMm: number;
  lengthMm: number;
  endFixity: ScrewEndFixity;
  endFixityLabel: string;
  /** 一阶横向临界转速 rpm：n_cr = (β²/L²)·√(EI/ρA)·60/2π。 */
  criticalSpeedRpm: number;
  /** 允许工作转速 = n_cr × 降额。 */
  allowableSpeedRpm: number;
  /** DN 允许转速 = dnLimit / d。 */
  dnSpeedRpm: number;
  /** 两者取小：结构上允许的最高转速。 */
  speedLimitRpm: number;
  maxRpm: number | null;
  dnValue: number;
  dnLimit: number;
  /** 欧拉临界载荷 N：P_cr = π²EI/(K·L)²。 */
  bucklingLoadN: number;
  /** 许用轴向载荷 = P_cr / 安全系数。 */
  bucklingAllowableN: number;
  axialLoadN: number;
  checks: { criticalSpeedOk: boolean | null; dnOk: boolean | null; bucklingOk: boolean | null };
  pass: boolean | null;
  verdict: string;
  formulas: string[];
}

/**
 * 丝杠（压杆 + 转子）校核。
 *
 * 公式（内部 SI）：
 *   I = π·d_r⁴/64，A = π·d_r²/4
 *   ω_cr = (β²/L²)·√(E·I/(ρ·A))，n_cr = 60·ω_cr/2π          ← 一阶横向临界转速
 *   n_allow = 0.8·n_cr，n_DN = DN_limit/d，n_max = min(两者)
 *   P_cr = π²·E·I/(K·L)²，P_allow = P_cr/2.5                  ← 欧拉压杆稳定
 *
 * 诚实边界：β/K 取标准端部条件，实际支座刚度、双螺母预紧、螺母位置都会改变结果；
 * 临界转速与压杆稳定必须与丝杠厂样本对照。
 */
export function screwSizing(node: CanvasNode, options: ScrewSizingOptions = {}): ScrewSizingResult {
  if (!node || typeof node !== 'object') throw new Error('screwSizing 需要画布节点');
  const strokeMm = nonNegative(node.strokeMm, '行程 strokeMm', 'mm');
  const screwDiaMm = positive(options.screwDiaMm ?? 16, '丝杠公称直径', 'mm');
  const rootDiaMm = positive(options.rootDiaMm ?? screwDiaMm - 3, '螺纹底径', 'mm');
  const lengthMm = positive(options.lengthMm ?? strokeMm + 100, '支撑跨距', 'mm');
  if (rootDiaMm >= screwDiaMm) throw new Error('螺纹底径必须小于公称直径');
  const fixityKey = options.endFixity ?? 'fixed-supported';
  const fixity = END_FIXITY[fixityKey];
  if (!fixity) throw new Error(`不支持的端部支撑方式：${String(fixityKey)}`);
  const rho = positive(options.densityKgM3 ?? 7850, '密度', 'kg/m³');
  const youngs = positive(options.youngsModulusPa ?? 206e9, '弹性模量', 'Pa');
  const dnLimit = positive(options.dnLimit ?? 80_000, 'DN 上限', 'mm·rpm');
  const derate = options.criticalSpeedDerate ?? 0.8;
  if (!(derate > 0 && derate <= 1)) throw new Error('临界转速降额系数必须在 (0, 1] 区间内');
  const bucklingSafety = positive(options.bucklingSafety ?? 2.5, '压杆安全系数', '');
  const axialLoad = nonNegative(options.axialLoadN ?? 0, '轴向载荷', 'N');
  const maxRpm = options.maxRpm === undefined ? null : nonNegative(options.maxRpm, '最高工作转速', 'rpm');

  const rootM = rootDiaMm / 1000;
  const lengthM = lengthMm / 1000;
  const inertia = (Math.PI * rootM ** 4) / 64;
  const area = (Math.PI * rootM ** 2) / 4;
  const waveSpeed = Math.sqrt((youngs * inertia) / (rho * area));
  const omega = ((fixity.beta ** 2) / lengthM ** 2) * waveSpeed;
  const criticalSpeed = (omega * 60) / (2 * Math.PI);
  const allowableSpeed = criticalSpeed * derate;
  const dnSpeed = dnLimit / screwDiaMm;
  const speedLimit = Math.min(allowableSpeed, dnSpeed);

  const bucklingLoad = (Math.PI ** 2 * youngs * inertia) / ((fixity.k * lengthM) ** 2);
  const bucklingAllowable = bucklingLoad / bucklingSafety;
  const dnValue = maxRpm === null ? 0 : maxRpm * screwDiaMm;

  const criticalSpeedOk = maxRpm === null ? null : maxRpm <= allowableSpeed;
  const dnOk = maxRpm === null ? null : dnValue <= dnLimit;
  const bucklingOk = axialLoad <= 0 ? null : axialLoad <= bucklingAllowable;
  const checks = { criticalSpeedOk, dnOk, bucklingOk };
  const failures = [
    criticalSpeedOk === false ? `最高转速 ${fmt(maxRpm ?? 0, 0)}rpm 超过允许 ${fmt(allowableSpeed, 0)}rpm` : null,
    dnOk === false ? `DN 值 ${fmt(dnValue, 0)} 超过 ${fmt(dnLimit, 0)}` : null,
    bucklingOk === false ? `轴向载荷 ${fmt(axialLoad, 0)}N 超过许用 ${fmt(bucklingAllowable, 0)}N` : null
  ].filter((item): item is string => item !== null);
  const decided = failures.length > 0 ? false : criticalSpeedOk === null && dnOk === null && bucklingOk === null ? null : true;

  const formulas = [
    `d_r = ${fmt(rootDiaMm, 2)}mm，L = ${fmt(lengthMm, 1)}mm，${fixity.label}（β=${fmt(fixity.beta, 3)}，K=${fmt(fixity.k, 3)}）`,
    `I = πd_r⁴/64 = ${inertia.toExponential(3)} m⁴，A = ${area.toExponential(3)} m²，√(EI/ρA) = ${fmt(waveSpeed, 1)} m/s`,
    `n_cr = (β²/L²)·√(EI/ρA)·60/2π = ${fmt(criticalSpeed, 0)} rpm；×${fmt(derate, 2)} → ${fmt(allowableSpeed, 0)} rpm`,
    `DN：${fmt(dnValue, 0)} / ${fmt(dnLimit, 0)} mm·rpm（转速 ${fmt(maxRpm ?? 0, 0)} rpm × Ø${fmt(screwDiaMm, 1)}mm）`,
    `P_cr = π²EI/(KL)² = ${fmt(bucklingLoad, 0)} N；/ ${fmt(bucklingSafety, 1)} = ${fmt(bucklingAllowable, 0)} N`
  ];

  return {
    rootDiaMm,
    lengthMm,
    endFixity: fixityKey,
    endFixityLabel: fixity.label,
    criticalSpeedRpm: roundTo(criticalSpeed, 1),
    allowableSpeedRpm: roundTo(allowableSpeed, 1),
    dnSpeedRpm: roundTo(dnSpeed, 1),
    speedLimitRpm: roundTo(speedLimit, 1),
    maxRpm: maxRpm === null ? null : roundTo(maxRpm, 1),
    dnValue: roundTo(dnValue, 1),
    dnLimit,
    bucklingLoadN: roundTo(bucklingLoad, 1),
    bucklingAllowableN: roundTo(bucklingAllowable, 1),
    axialLoadN: axialLoad,
    checks,
    pass: decided,
    verdict:
      decided === null
        ? '未提供最高工作转速/轴向载荷，只给出允许值，不做通过判定。'
        : decided
          ? `允许工作转速 ${fmt(speedLimit, 0)}rpm，压杆许用 ${fmt(bucklingAllowable, 0)}N，均在限值内`
          : `不满足：${failures.join('；')}`,
    formulas
  };
}

// ---------------------------------------------------------------------------
// 直线导轨倾覆力矩
// ---------------------------------------------------------------------------

export interface RailMomentInput {
  /** 滑块上的负载质量 kg。 */
  loadKg: number;
  /** 重心相对导轨中心的 X 偏置 mm（沿运动方向）。 */
  offsetXMm?: number;
  /** 重心相对导轨中心的 Y 偏置 mm（横向）。 */
  offsetYMm?: number;
  /** 重心高度（导轨面以上）mm。 */
  offsetZMm?: number;
  /** 附加垂直力 N（如气缸顶推、工件夹紧反力）。 */
  externalForceN?: number;
  /** 水平惯性力 N（加速度产生），用于偏航力矩。 */
  horizontalForceN?: number;
  /** 导轨样本额定力矩 N·m（M_A 俯仰 / M_B 偏航 / M_C 滚转）。 */
  allowableNm?: { pitch?: number; yaw?: number; roll?: number };
  gravity?: number;
}

export interface RailMomentResult {
  verticalForceN: number;
  /** 俯仰力矩 M_pitch = F_v·|X|。 */
  pitchNm: number;
  /** 滚转力矩 M_roll = F_v·|Y|。 */
  rollNm: number;
  /** 偏航力矩 M_yaw = F_h·|Z|。 */
  yawNm: number;
  checks: { pitch: boolean | null; yaw: boolean | null; roll: boolean | null };
  pass: boolean | null;
  verdict: string;
  formulas: string[];
}

/**
 * 导轨倾覆力矩（静载近似）。
 *
 *   F_v = m·g + F_ext
 *   M_pitch = F_v·|X|（重心沿行程方向偏置 → 前后倾覆）
 *   M_roll  = F_v·|Y|（横向偏置 → 左右滚转）
 *   M_yaw   = F_h·|Z|（水平惯性力作用在高处 → 绕竖轴偏转）
 *
 * 只有提供样本额定力矩（M_A/M_B/M_C）才做通过判定，否则 pass=null ——
 * 不用「拍脑袋的允许值」凑一个绿色的勾。
 */
export function railMomentCheck(input: RailMomentInput): RailMomentResult {
  if (!input || typeof input !== 'object') throw new Error('railMomentCheck 需要输入对象');
  const mass = nonNegative(input.loadKg, '负载质量 loadKg', 'kg');
  const g = positive(input.gravity ?? 9.80665, '重力加速度', 'm/s²');
  const offsetX = nonNegative(input.offsetXMm ?? 0, 'X 偏置', 'mm');
  const offsetY = nonNegative(input.offsetYMm ?? 0, 'Y 偏置', 'mm');
  const offsetZ = nonNegative(input.offsetZMm ?? 0, 'Z 偏置', 'mm');
  const external = input.externalForceN ?? 0;
  const horizontal = input.horizontalForceN ?? 0;
  if (!Number.isFinite(external)) throw new Error('附加垂直力必须是有限数（N）');
  if (!Number.isFinite(horizontal)) throw new Error('水平惯性力必须是有限数（N）');

  const vertical = mass * g + external;
  const pitch = (vertical * offsetX) / 1000;
  const roll = (vertical * offsetY) / 1000;
  const yaw = (horizontal * offsetZ) / 1000;

  const allow = input.allowableNm;
  const check = (value: number, limit: number | undefined): boolean | null =>
    limit === undefined ? null : value <= limit;
  const checks = {
    pitch: check(pitch, allow?.pitch),
    yaw: check(yaw, allow?.yaw),
    roll: check(roll, allow?.roll)
  };
  const decided = [checks.pitch, checks.yaw, checks.roll].filter((value) => value !== null);
  const pass = decided.length === 0 ? null : decided.every((value) => value === true);

  return {
    verticalForceN: roundTo(vertical, 2),
    pitchNm: roundTo(pitch, 3),
    rollNm: roundTo(roll, 3),
    yawNm: roundTo(yaw, 3),
    checks,
    pass,
    verdict:
      pass === null
        ? '只给出静载力矩；导轨样本 M_A/M_B/M_C 未提供，不做通过判定。'
        : pass
          ? '三向力矩均在样本额定值内（静载近似，不含冲击与偏载分布）'
          : '力矩超样本额定值：加大导轨规格或减小重心偏置',
    formulas: [
      `F_v = m·g + F_ext = ${fmt(mass, 2)}×${fmt(g, 4)} + ${fmt(external, 1)} = ${fmt(vertical, 1)} N`,
      `M_pitch = F_v·|X| = ${fmt(vertical, 1)}×${fmt(offsetX / 1000, 4)} = ${fmt(pitch, 3)} N·m`,
      `M_roll = F_v·|Y| = ${fmt(vertical, 1)}×${fmt(offsetY / 1000, 4)} = ${fmt(roll, 3)} N·m`,
      `M_yaw = F_h·|Z| = ${fmt(horizontal, 1)}×${fmt(offsetZ / 1000, 4)} = ${fmt(yaw, 3)} N·m`
    ]
  };
}
