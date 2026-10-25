// 第 2 步方案对比：固定生成直线、转盘、双轨三种形态。这里只做形态指定，
// 节拍、功率、成本、BOM 全部继续调用 synthMachine，与 Agent design_machine 同源。

import type { MachineBrief } from '../machine/spec.ts';
import type { SynthOptions, MachineDesign, MachineStationCycleInput } from '../machine/synth.ts';
import { synthMachine } from '../machine/synth.ts';
import { MACHINE_FORMS, rankForms, PROCESS_BASE_SECONDS, ACTUATOR_SECONDS } from '../machine/forms.ts';
import type { FlowEvaluation, FlowModel, FlowOp } from '../machine/flow.ts';
import { evaluateFlow } from '../machine/flow.ts';
import type { StationCycleAssessment } from './station-cycle.ts';

function linearFormId(stations: number): string {
  if (stations <= 4) return 'linear-4';
  if (stations <= 8) return 'linear-8';
  return 'linear-12';
}

function dialFormId(process: MachineBrief['process'], stations: number): string {
  if (process === 'inspection') return stations > 8 ? 'dial-12' : 'dial-8';
  if (stations <= 6) return 'dial-6';
  if (stations <= 8) return 'dial-8';
  return 'dial-12';
}

function preferredFormIds(brief: MachineBrief): string[] {
  if (brief.process === 'conveyor') return ['belt-line', 'gantry-2', 'dual-lane'];
  const stations = brief.stations;
  return [linearFormId(stations), dialFormId(brief.process, stations), 'dual-lane'];
}

/**
 * 生成三个互不相同的候选。优先使用直线/转盘/双轨；若形态不可用或工艺不适配，
 * 则按 MACHINE_FORMS 顺序补位，最终仍保证 3 个不同 form.id。
 */
export function generateCandidates(
  brief: MachineBrief,
  options: Omit<SynthOptions, 'formId'> = {}
): MachineDesign[] {
  const preferred = preferredFormIds(brief);
  const fallback = rankForms(brief)
    .filter((entry) => entry.processFit)
    .map((entry) => entry.form.id)
    .filter((id) => !preferred.includes(id));
  const ids = [...preferred, ...fallback];
  const designs: MachineDesign[] = [];
  const used = new Set<string>();
  const failures: string[] = [];
  for (const formId of ids) {
    if (designs.length >= 3) break;
    if (used.has(formId)) continue;
    const form = MACHINE_FORMS.find((candidate) => candidate.id === formId);
    if (!form) continue;
    const processFits = brief.process === 'unknown' || form.suits.includes(brief.process);
    // 前三个目标形态按需求强制对比；补位时只接受工艺适配形态，避免把无关形态混进方案。
    if (!preferred.includes(formId) && !processFits) continue;
    try {
      const candidateBrief: MachineBrief = { ...brief, layout: form.layout };
      const design = synthMachine(candidateBrief, { ...options, formId });
      if (design.form.id !== formId) continue;
      designs.push(design);
      used.add(formId);
    } catch (error) {
      failures.push(`${formId}: ${error instanceof Error ? error.message : String(error)}`);
      if (designs.length < preferred.length) continue;
    }
  }
  if (designs.length !== 3) {
    throw new Error(`无法生成 3 个不同候选${failures.length > 0 ? `（${failures.join('；')}）` : ''}`);
  }
  return designs;
}

/**
 * 从主方案反推 flow 模型，供第 5 步节拍复核与测试核对。
 * 与 synthMachine 的 stationWork/flowModel 构造保持一致；不参与候选生成。
 */
export function flowModelForDesign(design: MachineDesign): FlowModel {
  const config = design.config;
  const stations = config.stations.length;
  const base = PROCESS_BASE_SECONDS[design.config.name ? inferProcess(design) : 'unknown'];
  const work = config.stations.map((station) => {
    const seconds = config.actuators
      .filter((actuator) => actuator.station === station)
      .reduce((sum, actuator) => sum + ACTUATOR_SECONDS[actuator.kind], base);
    return Math.max(base, seconds);
  });
  const processName = design.form.name;
  let ops: FlowOp[] = work.map((seconds, index) => ({
    id: `review-st${index + 1}`,
    name: processName,
    seconds,
    station: index
  }));
  let copies: number | undefined;
  if (design.cycle.mode === 'parallel') {
    const fullSet = Math.max(...work);
    ops = [{ id: 'review-parallel-set', name: processName, seconds: fullSet, station: 0 }];
    copies = stations;
  }
  const geometry = design.form.geometry;
  return {
    layout: design.cycle.mode,
    stations,
    ops,
    targetPerMin: design.cycle.perMin,
    ...(copies === undefined ? {} : { copies }),
    ...(geometry.lanes === undefined ? {} : { lanes: geometry.lanes }),
    ...(design.form.id.startsWith('dial') ? { indexSeconds: design.form.geometry.indexer === 'dd' ? 0.45 : 0.6 } : {}),
    ...(design.form.id.startsWith('linear-8') || design.form.id.startsWith('linear-12')
      ? { transferSeconds: design.form.id.startsWith('linear-12') ? 0.9 : 0.8 }
      : {}),
    ...(design.form.id === 'dual-lane' ? { transferSeconds: 0.6 } : {}),
    ...(design.form.id === 'hybrid-dial-linear' ? { transferSeconds: 0.75, indexSeconds: 0.5 } : {}),
    ...(design.form.id === 'cell-4' ? { transferSeconds: 0.5 } : {})
  };
}

/** 从 ID 与形态推断工艺；仅用于测试/复核的 baseSeconds 选择。 */
function inferProcess(design: MachineDesign): keyof typeof PROCESS_BASE_SECONDS {
  const text = `${design.config.id} ${design.config.name} ${design.form.id}`;
  if (/screw|锁/.test(text)) return 'screw';
  if (/dispense|点胶|胶/.test(text)) return 'dispense';
  if (/inspection|检测/.test(text)) return 'inspection';
  if (/packaging|包装/.test(text)) return 'packaging';
  if (/assembly|装配/.test(text)) return 'assembly';
  if (/conveyor|输送/.test(text)) return 'conveyor';
  return 'unknown';
}

export function reevaluateCandidateCycle(design: MachineDesign): FlowEvaluation {
  return evaluateFlow(flowModelForDesign(design));
}

/** 将校核的实时节拍回写到工程模型，供向导展示和保存共用。 */
export function withReviewedCycle(design: MachineDesign, evaluation: FlowEvaluation | StationCycleAssessment): MachineDesign {
  const stationSeconds = Math.round(evaluation.stationSecondsMax * 1000) / 1000;
  const throughputPerMin = Math.round(evaluation.throughputPerMin * 100) / 100;
  const requiredTotalStations = Number.isFinite(evaluation.requiredStations) ? evaluation.requiredStations : 0;
  const requiredParallelStations = evaluation.mode === 'parallel'
    ? requiredTotalStations
    : Math.max(1, Math.ceil(requiredTotalStations / design.config.stations.length));
  const slowestStation = (evaluation.bottleneck?.station ?? 0) + 1;
  const meetsTarget = evaluation.meetsTarget === true;
  const bottleneck = evaluation.bottleneck
    ? `工位${slowestStation} ${evaluation.bottleneck.op}（${evaluation.bottleneck.seconds.toFixed(2)} 秒）`
    : '无关键工序';
  const cycleSource = 'source' in evaluation ? evaluation.source : 'model-estimate';
  const stationCycleInputs: MachineStationCycleInput[] = 'stationCycleInputs' in evaluation ? evaluation.stationCycleInputs : [];
  return {
    ...design,
    cycle: {
      ...design.cycle,
      mode: evaluation.mode,
      source: cycleSource,
      stationCycleInputs,
      stationSeconds,
      throughputPerMin,
      partsPerMinute: throughputPerMin,
      estimatedSecondsPerPiece: stationSeconds,
      slowestStation,
      slowestActionSeconds: Math.round(Math.max(0, stationSeconds - design.cycle.baseSeconds) * 1000) / 1000,
      requiredParallelStations,
      requiredTotalStations,
      meetsTarget,
      bottleneck: `${bottleneck} → ${throughputPerMin.toFixed(2)} 件/分钟（目标 ${design.cycle.perMin} 件/分钟${meetsTarget ? '，达标' : '，未达标'}）`
    }
  };
}
