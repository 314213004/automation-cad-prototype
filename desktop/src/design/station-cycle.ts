import type { FlowEvaluation } from '../machine/flow.ts';
import type { MachineStationCycleInput } from '../machine/synth.ts';
import type { ReportStationCycle } from '../export/report.ts';

export interface StationCycleInput {
  /** 完整工位周期，单位秒/件；非正值保留为草稿，但不得参与产能计算。 */
  seconds: number;
  /** 工程师确认该完整周期已经包含本布局每件发生的公共等待、移载、上下料/分度等时间。 */
  sharedTimeConfirmed: boolean;
  source: 'engineer-input';
  verification: 'pending-measurement';
}

export interface StationCycleDraftLike {
  id: string;
  name: string;
  cycleTime?: StationCycleInput | null;
}

export type StationCycleInputStatus = 'none' | 'partial' | 'invalid' | 'unconfirmed' | 'layout-unsupported' | 'complete';

export interface StationCycleAssessment extends FlowEvaluation {
  source: 'model-estimate' | 'engineer-input';
  inputStatus: StationCycleInputStatus;
  enteredStations: number;
  missingStations: string[];
  invalidStations: string[];
  unconfirmedStations: string[];
  manualCalculationBlockedReason: string | null;
  bottleneckStationName: string | null;
  stationCycleInputs: MachineStationCycleInput[];
}

/** Multiple channels or stations do not carry enough mapping to interpret per-station manual values. */
export function manualCycleBlockReason(layout: FlowEvaluation['mode'], stationCount: number): string | null {
  if (layout === 'parallel') {
    return '并行布局没有说明这些输入对应每个并行副本还是整机产出，无法可靠合并并行通道；人工周期仅记录，目标判定已停用。';
  }
  if (layout === 'cell') {
    return '单元/多轨布局没有说明输入是每条轨道还是整机周期，也没有工位到通道的映射；不能擅自除以轨道数，人工周期仅记录，目标判定已停用。';
  }
  if (layout === 'single' && stationCount !== 1) {
    return '单机布局有多个工位输入，但没有说明这些值是顺序工序还是整机周期，无法可靠合并；人工周期仅记录，目标判定已停用。';
  }
  return null;
}

/**
 * Use manual throughput only when every station has a positive, finite, explicit
 * engineer-entered complete cycle and the layout/time basis is unambiguous.
 */
export function assessStationCycles(
  fallback: FlowEvaluation,
  stations: readonly StationCycleDraftLike[],
  targetPerMin: number
): StationCycleAssessment {
  const entered = stations.filter((station) => station.cycleTime !== undefined && station.cycleTime !== null);
  const missingStations = stations
    .filter((station) => station.cycleTime === undefined || station.cycleTime === null)
    .map((station) => station.name);
  const invalidStations = entered
    .filter((station) => !Number.isFinite(station.cycleTime?.seconds) || (station.cycleTime?.seconds ?? 0) <= 0)
    .map((station) => station.name);
  const unconfirmedStations = entered
    .filter((station) => station.cycleTime?.sharedTimeConfirmed !== true)
    .map((station) => station.name);
  const stationCycleInputs = entered.flatMap((station): MachineStationCycleInput[] => {
    const cycleTime = station.cycleTime;
    if (!cycleTime || !Number.isFinite(cycleTime.seconds) || cycleTime.seconds <= 0) return [];
    return [{
      stationId: station.id,
      stationName: station.name,
      seconds: cycleTime.seconds,
      sharedTimeConfirmed: cycleTime.sharedTimeConfirmed === true,
      source: 'engineer-input',
      verification: 'pending-measurement'
    }];
  });
  const allValid = stations.length > 0 && missingStations.length === 0 && invalidStations.length === 0;
  const layoutBlockReason = manualCycleBlockReason(fallback.mode, stations.length);
  const inputStatus: StationCycleInputStatus = allValid
    ? layoutBlockReason
      ? 'layout-unsupported'
      : unconfirmedStations.length > 0
        ? 'unconfirmed'
        : 'complete'
    : entered.length === 0
      ? 'none'
      : invalidStations.length > 0
        ? 'invalid'
        : 'partial';

  if (!allValid) {
    return {
      ...fallback,
      source: 'model-estimate',
      inputStatus,
      enteredStations: entered.length,
      missingStations,
      invalidStations,
      unconfirmedStations,
      manualCalculationBlockedReason: layoutBlockReason,
      bottleneckStationName: null,
      ...(layoutBlockReason
        ? { notes: [...fallback.notes, layoutBlockReason, '该布局的人工周期即使补齐也不会参与产能计算。'] }
        : {}),
      stationCycleInputs
    };
  }

  if (layoutBlockReason || unconfirmedStations.length > 0) {
    const reason = layoutBlockReason ?? `尚未确认以下工位周期已包含公共等待、移载、上下料${fallback.mode === 'dial' ? '及每次转盘分度' : ''}：${unconfirmedStations.join('、')}；请确认后再使用人工输入计算。`;
    return {
      ...fallback,
      source: 'model-estimate',
      inputStatus: layoutBlockReason ? 'layout-unsupported' : 'unconfirmed',
      enteredStations: entered.length,
      missingStations,
      invalidStations,
      unconfirmedStations,
      manualCalculationBlockedReason: reason,
      bottleneckStationName: null,
      notes: [...fallback.notes, reason, '当前显示的产能仍是模型估算；人工周期没有参与计算，且未输出基于人工输入的目标判定。'],
      stationCycleInputs
    };
  }

  const stationSeconds = stations.map((station) => station.cycleTime!.seconds);
  let bottleneckIndex = 0;
  for (let index = 1; index < stationSeconds.length; index += 1) {
    if ((stationSeconds[index] ?? 0) > (stationSeconds[bottleneckIndex] ?? 0)) bottleneckIndex = index;
  }
  const cycleSeconds = stationSeconds[bottleneckIndex] ?? 0;
  const targetCycleSeconds = targetPerMin > 0 && Number.isFinite(targetPerMin) ? 60 / targetPerMin : null;
  const notes = [
    `使用工程师确认的完整周期，按 ${fallback.mode === 'dial' ? '转盘工位循环' : fallback.mode === 'single' ? '单机完整循环' : '线性流水'} 口径取最大周期；公共等待、移载、上下料${fallback.mode === 'dial' ? '及每次转盘分度' : ''}已包含在输入内，不再重复叠加。`,
    '输入仍待现场测量确认；不等同于验收或达标结论。',
    '所需工位数仍保留模型估算值；单凭已录入周期不能推导复制瓶颈站或新增整机后的实际产能。'
  ];

  return {
    ...fallback,
    stationSeconds,
    stationSecondsMax: cycleSeconds,
    cycleSeconds,
    throughputPerMin: 60 / cycleSeconds,
    meetsTarget: targetCycleSeconds === null ? null : cycleSeconds <= targetCycleSeconds + 1e-9,
    requiredStations: fallback.requiredStations,
    bottleneck: {
      station: bottleneckIndex,
      seconds: cycleSeconds,
      op: '完整工位周期'
    },
    notes,
    source: 'engineer-input',
    inputStatus: 'complete',
    enteredStations: stations.length,
    missingStations: [],
    invalidStations: [],
    unconfirmedStations: [],
    manualCalculationBlockedReason: null,
    bottleneckStationName: stations[bottleneckIndex]?.name ?? null,
    stationCycleInputs
  };
}

/** 生成可供 PDF 和工程报告使用的周期依据视图；未完整时绝不把部分输入标成计算依据。 */
export function buildStationCycleReport(
  assessment: StationCycleAssessment,
  stations: readonly StationCycleDraftLike[],
  targetPerMin: number
): ReportStationCycle {
  const missing = assessment.missingStations;
  const invalid = assessment.invalidStations;
  const inputStatusLabel = assessment.inputStatus === 'complete'
    ? `完整且口径已确认：${stations.length} 个工位均有有效输入`
    : assessment.inputStatus === 'unconfirmed'
      ? `周期数值完整，但公共时间口径未确认：${assessment.unconfirmedStations.join('、')}`
      : [
        assessment.inputStatus === 'none' ? '无周期输入' : `仅录入 ${assessment.enteredStations}/${stations.length} 个工位`,
        missing.length > 0 ? `未填写：${missing.join('、')}` : '',
        invalid.length > 0 ? `无效：${invalid.join('、')}` : '',
        assessment.unconfirmedStations.length > 0 ? `公共时间口径未确认：${assessment.unconfirmedStations.join('、')}` : '',
        assessment.manualCalculationBlockedReason ? `永久布局限制：${assessment.manualCalculationBlockedReason}` : ''
      ].filter(Boolean).join('；');
  const complete = assessment.source === 'engineer-input';
  const layoutUnsupported = manualCycleBlockReason(assessment.mode, stations.length) !== null;
  const bottleneckIndex = assessment.bottleneck?.station ?? -1;
  const modelBottleneckStation = bottleneckIndex >= 0 ? stations[bottleneckIndex] : undefined;
  const bottleneckLabel = complete
    ? `工程师输入瓶颈：${assessment.bottleneckStationName ?? modelBottleneckStation?.name ?? `工位${bottleneckIndex + 1}`} · ${assessment.cycleSeconds.toFixed(2)} 秒/件`
    : modelBottleneckStation
      ? `模型估算瓶颈：工位${bottleneckIndex + 1}「${modelBottleneckStation.name}」· ${assessment.bottleneck?.op ?? '—'}`
      : `模型估算瓶颈：${assessment.bottleneck?.op ?? '—'}`;
  const explanation = complete
    ? `产能按全部工位有效且口径已确认的工程师输入周期取最大值。公共等待、移载、上下料${assessment.mode === 'dial' ? '及每次转盘分度' : ''}已计入输入，不再额外相加。输入尚待现场测量确认；不等同于验收或达标结论。`
    : assessment.manualCalculationBlockedReason
      ? `产能来自模型估算（未实测）。${assessment.manualCalculationBlockedReason}${layoutUnsupported ? '该布局即使所有工位周期都补齐，人工值仍仅作记录、不会参与产能计算。' : ''}已录入的工程师周期仅作记录，未参与计算；不输出基于这些人工值的目标判定。`
      : assessment.inputStatus === 'unconfirmed'
        ? `产能来自模型估算（未实测）。已录入的周期值没有确认公共时间口径，人工输入仅作记录，未参与本次产能计算；不输出基于这些人工值的目标判定。请逐个确认完整周期包含全部公共等待、移载及上下料${assessment.mode === 'dial' ? '和每次转盘分度' : ''}后重新校核。`
        : '产能来自模型估算（未实测）。由于工位输入未填写完整或含无效值，已填写的工程师周期仅作记录，未参与本次产能计算；全部工位均填写大于 0 的完整周期并确认公共时间口径后，才会切换为工程师输入计算。';
  return {
    calculationSource: assessment.source,
    calculationSourceLabel: complete ? '工程师输入（完整周期；待实测）' : assessment.manualCalculationBlockedReason || assessment.inputStatus === 'unconfirmed' ? '模型估算（手工周期未用于产能判定）' : '模型估算（未实测）',
    inputStatusLabel,
    throughputPerMin: assessment.throughputPerMin,
    cycleSeconds: assessment.cycleSeconds,
    targetPerMin,
    bottleneckLabel,
    explanation,
    stations: stations.map((station, index) => {
      const cycleTime = station.cycleTime;
      if (!cycleTime) {
        return {
          stationName: station.name,
          seconds: null,
          sourceLabel: '未填写',
          verificationLabel: '未输入；未参与周期输入计算',
          state: 'not-entered' as const,
          bottleneck: false
        };
      }
      const valid = Number.isFinite(cycleTime.seconds) && cycleTime.seconds > 0;
      if (!valid) {
        return {
          stationName: station.name,
          seconds: cycleTime.seconds,
          sourceLabel: '工程师输入',
          verificationLabel: '无效值；未参与产能计算',
          state: 'invalid' as const,
          bottleneck: false
        };
      }
      return {
        stationName: station.name,
        seconds: cycleTime.seconds,
        sourceLabel: '工程师输入',
        verificationLabel: complete
          ? '待实测；公共时间口径已确认并参与本次产能计算'
          : assessment.inputStatus === 'layout-unsupported'
            ? '待实测；布局映射不明，未参与产能计算'
            : assessment.inputStatus === 'unconfirmed' && cycleTime.sharedTimeConfirmed !== true
              ? '待实测；公共时间口径未确认，未参与产能计算'
              : '待实测；因输入未完整，未参与产能计算',
        state: 'pending-measurement' as const,
        bottleneck: complete && index === bottleneckIndex
      };
    })
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

/** UI fragment kept pure so its required labels and provenance can be regression-tested. */
export function renderStationCycleEditor(
  station: StationCycleDraftLike,
  index: number,
  layout: FlowEvaluation['mode'],
  stationCount: number
): string {
  const cycleTime = station.cycleTime;
  const value = cycleTime && Number.isFinite(cycleTime.seconds) ? String(cycleTime.seconds) : '';
  const valid = Boolean(cycleTime && Number.isFinite(cycleTime.seconds) && cycleTime.seconds > 0);
  const blockReason = manualCycleBlockReason(layout, stationCount);
  const source = !cycleTime
    ? '未填写；暂用模板估算'
    : Number.isFinite(cycleTime.seconds) && cycleTime.seconds > 0
      ? '工程师输入 · 待实测'
      : '输入无效；请输入大于 0 的秒数';
  const coverageLabel = layout === 'dial'
    ? '确认此值已包含本工位动作、公共等待/移载/上下料及每次转盘分度（系统不会再额外加分度时间）。'
    : layout === 'single'
      ? `确认此值是整机每件完整循环，包含全部动作、等待、移载和上下料${stationCount === 1 ? '；若为单工位输送线，还须包含由线速和工件间距决定的实际出料间隔' : ''}。`
      : `确认此值是本工位每件完整循环，已包含该线体发生的公共等待、移载及上下料时间${stationCount === 1 ? '；单工位输送线还须包含由线速和工件间距决定的实际出料间隔' : ''}。`;
  const confirmationLabel = `${coverageLabel} 切换候选方案后周期值保留，但需重新确认此项。`;
  const blockNotice = blockReason
    ? `<small class="design-cycle-blocked">${escapeHtml(blockReason)}</small>`
    : `<label class="design-cycle-confirm"><input type="checkbox" data-cycle-coverage="${index}" ${cycleTime?.sharedTimeConfirmed === true ? 'checked' : ''} ${valid ? '' : 'disabled'}> ${escapeHtml(confirmationLabel)}</label>`;
  return `<div class="design-cycle-editor"><label for="designStationCycle-${index}">工位完整动作周期（秒/件）<input id="designStationCycle-${index}" type="number" min="0.001" step="any" inputmode="decimal" data-station-cycle="${index}" aria-label="${escapeHtml(station.name)}完整工位周期（秒/件）" value="${escapeHtml(value)}"></label><span class="design-cycle-source" data-cycle-source="${index}">${escapeHtml(source)}</span>${blockNotice}<small>填写本工位每件从开始处理到准备接收下一件的完整循环；不能用单个动作的 durationMs 代替。所有工位都须填写有效周期并逐项确认公共时间口径；可计算布局按最慢完整周期计算产能（60 ÷ 秒/件）。手工值仍待实测。</small></div>`;
}
