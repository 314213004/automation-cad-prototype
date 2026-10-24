// 通用产能引擎：纯函数。输入任意工位组成、布局与工序时间，输出节拍、产能、
// 瓶颈与达标所需工位。synthMachine 只负责把机型 brief 映射成 FlowModel，
// 不再在合成器里写某一种布局的产能公式。
//
// 诚实边界：这是静态估算，不含故障、换型、人工节拍、缓存区与真实加减速曲线；
// 设备节拍仍需节拍分析或现场测量确认。

export type MachineLayout = 'single' | 'linear' | 'dial' | 'parallel' | 'cell';

export interface FlowOp {
  id: string;
  name: string;              // 上料 / 锁螺丝 / 检测 / 下料…
  seconds: number;           // 单件在该工序的作业时间
  station: number;           // 第几个工位（0-based）
  optional?: boolean;        // 可选工序（不计入关键路径，但计入成本）
}

export interface FlowModel {
  layout: MachineLayout;
  stations: number;           // 工位总数
  copies?: number;            // 同工序并行副本数（layout='parallel' 时 = stations）
  lanes?: number;             // 并行轨道数（layout='cell' 时生效，默认 1）
  ops: FlowOp[];
  transferSeconds?: number;   // 直线/单元：件在工位间转移时间（默认 0）
  indexSeconds?: number;      // 转盘分度时间（layout='dial'，默认 0.6）
  targetPerMin?: number;
}

export interface FlowEvaluation {
  mode: MachineLayout;
  stationSeconds: number[];   // 每工位单件时间（含转移/分度分摊）
  stationSecondsMax: number;
  cycleSeconds: number;       // 单件产出节拍（决定产能）
  throughputPerMin: number;
  meetsTarget: boolean | null; // 无目标时 null
  requiredStations: number;   // 达标所需总工位数（无目标时 0）
  bottleneck: { station: number; seconds: number; op: string } | null;
  notes: string[];
}

const DEFAULT_INDEX_SECONDS = 0.6;
const EPS = 1e-9;

function assertPositiveSeconds(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须大于 0 秒`);
  }
  return value;
}

function assertNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}不能为负数`);
  }
  return value;
}

function assertModel(model: FlowModel): void {
  if (!model || typeof model !== 'object') throw new Error('产能模型不能为空');
  if (!Number.isInteger(model.stations) || model.stations <= 0) {
    throw new Error('工位数必须是大于 0 的整数');
  }
  if (!Array.isArray(model.ops) || model.ops.length === 0) {
    throw new Error('工序不能为空：至少需要 1 道工序');
  }
  for (const op of model.ops) {
    assertPositiveSeconds(op.seconds, `工序「${op.name || op.id}」的作业时间`);
    if (!Number.isInteger(op.station) || op.station < 0 || op.station >= model.stations) {
      throw new Error(`工序「${op.name || op.id}」的工位索引必须在 0–${model.stations - 1} 之间`);
    }
  }
  if (model.copies !== undefined && (!Number.isInteger(model.copies) || model.copies <= 0)) {
    throw new Error('并行副本数必须是大于 0 的整数');
  }
  if (model.lanes !== undefined && (!Number.isInteger(model.lanes) || model.lanes <= 0)) {
    throw new Error('并行轨道数必须是大于 0 的整数');
  }
  if (model.transferSeconds !== undefined) assertNonNegative(model.transferSeconds, '转移时间');
  if (model.indexSeconds !== undefined) assertNonNegative(model.indexSeconds, '分度时间');
  if (model.targetPerMin !== undefined) {
    if (typeof model.targetPerMin !== 'number' || !Number.isFinite(model.targetPerMin) || model.targetPerMin <= 0) {
      throw new Error('目标节拍必须大于 0 件/分钟');
    }
  }
}

function stationSums(ops: readonly FlowOp[], stations: number): number[] {
  const sums = Array.from({ length: stations }, () => 0);
  for (const op of ops) {
    if (op.optional === true) continue;
    sums[op.station] = (sums[op.station] ?? 0) + op.seconds;
  }
  return sums;
}

function opNamesAt(ops: readonly FlowOp[], station: number): string {
  const names = ops
    .filter((op) => op.optional !== true && op.station === station)
    .map((op) => op.name || op.id);
  return names.length > 0 ? names.join(' + ') : '(无工序)';
}

function maxIndex(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) > (values[best] ?? 0) + EPS) best = index;
  }
  return best;
}

export function evaluateFlow(model: FlowModel): FlowEvaluation {
  assertModel(model);
  const notes: string[] = [];
  const criticalOps = model.ops.filter((op) => op.optional !== true);
  const optionalOps = model.ops.filter((op) => op.optional === true);
  if (optionalOps.length > 0) {
    notes.push(`可选工序 ${optionalOps.map((op) => op.name || op.id).join('、')} 不计入关键路径，仅计入成本。`);
  }
  if (criticalOps.length === 0) {
    notes.push('全部工序均为可选，关键路径按 0 秒处理。');
  }

  const transfer = model.transferSeconds === undefined ? 0 : model.transferSeconds;
  if (model.transferSeconds === undefined && (model.layout === 'linear' || model.layout === 'cell')) {
    notes.push('transferSeconds 未提供，按默认 0 秒估算。');
  }
  const indexSeconds = model.indexSeconds === undefined ? DEFAULT_INDEX_SECONDS : model.indexSeconds;
  if (model.indexSeconds === undefined && model.layout === 'dial') {
    notes.push(`indexSeconds 未提供，按默认 ${DEFAULT_INDEX_SECONDS} 秒/次分度估算。`);
  }

  const sums = stationSums(model.ops, model.stations);
  let stationSeconds: number[];
  let cycleSeconds: number;
  let bottleneck: FlowEvaluation['bottleneck'];

  switch (model.layout) {
    case 'single': {
      if (model.stations > 1) notes.push('single 布局只按一个工位完成全部工序计算，stations 不放大产能。');
      const total = criticalOps.reduce((sum, op) => sum + op.seconds, 0);
      stationSeconds = [total];
      cycleSeconds = total;
      bottleneck = {
        station: 0,
        seconds: total,
        op: criticalOps.map((op) => op.name || op.id).join(' + ') || '(无工序)'
      };
      break;
    }
    case 'linear': {
      stationSeconds = sums.map((sum) => sum + transfer);
      const index = maxIndex(stationSeconds);
      cycleSeconds = stationSeconds[index] ?? 0;
      bottleneck = { station: index, seconds: cycleSeconds, op: opNamesAt(model.ops, index) };
      break;
    }
    case 'dial': {
      stationSeconds = [...sums];
      const index = maxIndex(stationSeconds);
      cycleSeconds = (stationSeconds[index] ?? 0) + indexSeconds;
      bottleneck = { station: index, seconds: stationSeconds[index] ?? 0, op: opNamesAt(model.ops, index) };
      break;
    }
    case 'parallel': {
      const copies = model.copies ?? model.stations;
      if (model.copies === undefined) notes.push(`copies 未提供，按 stations=${model.stations} 个并行副本估算。`);
      const total = criticalOps.reduce((sum, op) => sum + op.seconds, 0);
      stationSeconds = Array.from({ length: model.stations }, () => total);
      cycleSeconds = total / copies;
      bottleneck = {
        station: 0,
        seconds: total,
        op: criticalOps.map((op) => op.name || op.id).join(' + ') || '(无工序)'
      };
      break;
    }
    case 'cell': {
      stationSeconds = [...sums];
      const index = maxIndex(stationSeconds);
      const lanes = model.lanes ?? 1;
      cycleSeconds = ((stationSeconds[index] ?? 0) + transfer) / lanes;
      if (lanes > 1) notes.push(`单元布局按 ${lanes} 条轨道并行，单轨节拍再除以轨道数。`);
      bottleneck = { station: index, seconds: stationSeconds[index] ?? 0, op: opNamesAt(model.ops, index) };
      break;
    }
    default:
      throw new Error(`不支持的布局模型：${String((model as { layout?: unknown }).layout)}`);
  }

  const stationSecondsMax = stationSeconds.reduce((max, value) => Math.max(max, value), 0);
  const throughputPerMin = cycleSeconds > 0 ? 60 / cycleSeconds : 0;
  const targetCycle = model.targetPerMin === undefined ? null : 60 / model.targetPerMin;
  const meetsTarget = targetCycle === null ? null : cycleSeconds <= targetCycle + EPS;

  let requiredStations = 0;
  if (targetCycle !== null) {
    const copiesFor = (baseSeconds: number, fixedSeconds: number): number => {
      const available = targetCycle - fixedSeconds;
      if (available <= EPS) return Number.POSITIVE_INFINITY;
      return Math.max(1, Math.ceil(baseSeconds / available - EPS));
    };
    switch (model.layout) {
      case 'single':
        requiredStations = meetsTarget === true ? 1 : Number.POSITIVE_INFINITY;
        if (meetsTarget !== true) notes.push('single 布局无法通过增加工位降低节拍，当前目标不可达。');
        break;
      case 'linear': {
        const copies = copiesFor(stationSecondsMax - transfer, transfer);
        requiredStations = copies * model.stations;
        break;
      }
      case 'dial': {
        const copies = copiesFor(stationSecondsMax, indexSeconds);
        requiredStations = copies * model.stations;
        break;
      }
      case 'parallel': {
        const copies = model.copies ?? model.stations;
        const perCopy = stationSecondsMax;
        const totalCopies = Math.max(1, Math.ceil(perCopy / targetCycle - EPS));
        requiredStations = totalCopies;
        if (totalCopies > copies) notes.push(`达到目标至少需要 ${totalCopies} 个并行副本。`);
        break;
      }
      case 'cell': {
        const lanes = model.lanes ?? 1;
        const groups = Math.max(1, Math.ceil((stationSecondsMax + transfer) / (targetCycle * lanes) - EPS));
        requiredStations = groups * model.stations;
        break;
      }
    }
    if (!Number.isFinite(requiredStations)) {
      notes.push('目标节拍低于布局固定时间，仅靠增加工位/副本无法达标。');
    }
  } else {
    notes.push('未设置目标节拍，meetsTarget=null、requiredStations=0。');
  }

  return {
    mode: model.layout,
    stationSeconds,
    stationSecondsMax,
    cycleSeconds,
    throughputPerMin,
    meetsTarget,
    requiredStations,
    bottleneck,
    notes
  };
}
