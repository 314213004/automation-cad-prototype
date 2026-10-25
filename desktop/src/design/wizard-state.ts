// 整机设计向导的纯状态层：不读写文件、不访问 DOM，便于单测与渲染层复用。
// 草稿只记录用户输入与方案引用；所有产线公式仍由 machine/synth.ts 提供。

import type {
  ActuatorConfig,
  MachineConfig,
  SensorConfig
} from '../commission/machine-config.ts';
import type { Placement } from '../enclosure/layout.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { templateFor } from '../machine/templates.ts';
import type { MachineBrief, MachineProcess, MachineVoltage } from '../machine/spec.ts';

export type DesignStep = 1 | 2 | 3 | 4 | 5;
export type IncomingForm = 'bulk' | 'tray' | 'aligned' | 'reel';
export type LoadingMethod = 'manual' | 'conveyor' | 'robot';
export type DesignProcess = 'screw' | 'dispense' | 'inspection' | 'assembly' | 'packaging';

export interface DesignFootprint {
  lengthMm: number;
  widthMm: number;
}

/** 第 1 步表单；转换为 MachineBrief 后交给 synthMachine。 */
export interface MachineBriefInput {
  name: string;
  incoming: IncomingForm;
  process: DesignProcess;
  cyclePerMin: number;
  /** null = 自动推荐工位。 */
  stations: number | null;
  load: LoadingMethod;
  footprint: DesignFootprint | null;
  voltage: Extract<MachineVoltage, '220VAC' | '380VAC'>;
  brand: string | null;
}

export type ActuatorDraft = ActuatorConfig;
export type SensorDraft = SensorConfig;

export interface StationDraft {
  id: string;
  name: string;
  actuators: ActuatorDraft[];
  sensors: SensorDraft[];
}

export interface DesignDraft {
  version: 1;
  step: DesignStep;
  brief: MachineBriefInput;
  candidates?: MachineDesign[];
  selectedIndex?: 0 | 1 | 2;
  design?: MachineDesign;
  stations: StationDraft[];
  placements: Placement[];
  updatedAt: string;
}

export const DESIGN_STEP_LABELS: Record<DesignStep, string> = {
  1: '需求',
  2: '方案对比',
  3: '工位与元件',
  4: '布局',
  5: '校核与产出'
};

export const DESIGN_STEPS: readonly DesignStep[] = [1, 2, 3, 4, 5];

export const PROCESS_LABELS: Record<DesignProcess, string> = {
  screw: '锁螺丝',
  dispense: '点胶',
  inspection: '检测',
  assembly: '装配',
  packaging: '包装'
};

export const INCOMING_LABELS: Record<IncomingForm, string> = {
  bulk: '散料',
  tray: '托盘',
  aligned: '整列',
  reel: '卷料'
};

export const LOADING_LABELS: Record<LoadingMethod, string> = {
  manual: '人工',
  conveyor: '输送线',
  robot: '机械手'
};

const PROCESSES = new Set<DesignProcess>(['screw', 'dispense', 'inspection', 'assembly', 'packaging']);
const INCOMING = new Set<IncomingForm>(['bulk', 'tray', 'aligned', 'reel']);
const LOADING = new Set<LoadingMethod>(['manual', 'conveyor', 'robot']);

/** 生成带 +08:00 偏移的 ISO 8601 时间，避免依赖运行机器时区。 */
export function shanghaiIso(date: Date = new Date()): string {
  const offsetMs = 8 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}.` +
    `${pad(local.getUTCMilliseconds(), 3)}+08:00`;
}

export function emptyBrief(): MachineBriefInput {
  return {
    name: '',
    incoming: 'bulk',
    process: 'screw',
    cyclePerMin: 10,
    stations: null,
    load: 'conveyor',
    footprint: null,
    voltage: '380VAC',
    brand: null
  };
}

export function initialDraft(now: Date = new Date()): DesignDraft {
  return {
    version: 1,
    step: 1,
    brief: emptyBrief(),
    stations: [],
    placements: [],
    updatedAt: shanghaiIso(now)
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneActuator(value: ActuatorConfig): ActuatorConfig {
  return JSON.parse(JSON.stringify(value)) as ActuatorConfig;
}

function cloneSensor(value: SensorConfig): SensorConfig {
  return JSON.parse(JSON.stringify(value)) as SensorConfig;
}

/** 把向导字段翻译为 synthMachine 输入；名称/来料/上下料写入 notes，算法层不重复实现。 */
export function briefToMachineBrief(brief: MachineBriefInput): MachineBrief {
  const template = templateFor(brief.process as MachineProcess);
  const stations = brief.stations ?? template.stations;
  const notes = [
    `产品/机型：${brief.name.trim()}`,
    `来料形式：${INCOMING_LABELS[brief.incoming]}`,
    `上下料方式：${LOADING_LABELS[brief.load]}`,
    ...(brief.footprint
      ? [`占地限制：${brief.footprint.lengthMm}×${brief.footprint.widthMm} mm`]
      : ['占地限制：未填写，按方案推荐尺寸'])
  ];
  return {
    process: brief.process,
    stations,
    cyclePerMin: brief.cyclePerMin,
    layout: 'auto',
    processes: [PROCESS_LABELS[brief.process]],
    actuators: [],
    sensors: [],
    brand: brief.brand?.trim() || null,
    voltage: brief.voltage,
    notes
  };
}

export function stationsFromDesign(design: MachineDesign): StationDraft[] {
  return design.config.stations.map((name, index) => ({
    id: `station-${index + 1}`,
    name,
    actuators: design.config.actuators
      .filter((actuator) => actuator.station === name)
      .map(cloneActuator),
    sensors: design.config.sensors
      .filter((sensor) => sensor.station === name)
      .map(cloneSensor)
  }));
}

/** 把第 3 步编辑结果写回 MachineDesign 的 config/points。 */
export function configFromStations(design: MachineDesign, stations: readonly StationDraft[]): MachineConfig {
  const names = stations.map((station) => station.name.trim());
  return {
    id: design.config.id,
    name: design.config.name,
    stations: names,
    actuators: stations.flatMap((station) =>
      station.actuators.map((actuator) => ({ ...cloneActuator(actuator), station: station.name.trim() }))),
    sensors: stations.flatMap((station) =>
      station.sensors.map((sensor) => ({ ...cloneSensor(sensor), station: station.name.trim() })))
  };
}

export function pointsFromConfig(config: MachineConfig): string[] {
  const seen = new Set<string>();
  const points: string[] = [];
  const add = (point: string | undefined): void => {
    if (!point) return;
    const key = point.trim().toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    points.push(point.trim());
  };
  for (const actuator of config.actuators) {
    add(actuator.extendPoint);
    add(actuator.retractPoint);
    add(actuator.gripPoint);
    add(actuator.point);
  }
  for (const sensor of config.sensors) add(sensor.point);
  return points;
}

export function withStations(draft: DesignDraft, stations: StationDraft[], now: Date = new Date()): DesignDraft {
  const next: DesignDraft = {
    ...draft,
    stations,
    updatedAt: shanghaiIso(now)
  };
  if (draft.design) {
    const config = configFromStations(draft.design, stations);
    next.design = {
      ...draft.design,
      config,
      points: pointsFromConfig(config)
    };
  }
  return next;
}

export function withPlacements(draft: DesignDraft, placements: Placement[], now: Date = new Date()): DesignDraft {
  return { ...draft, placements, updatedAt: shanghaiIso(now) };
}

export function withCandidates(
  draft: DesignDraft,
  candidates: MachineDesign[],
  now: Date = new Date()
): DesignDraft {
  const next: DesignDraft = {
    ...draft,
    candidates: candidates.slice(0, 3),
    updatedAt: shanghaiIso(now)
  };
  delete next.selectedIndex;
  delete next.design;
  return next;
}

/** 修改第 1 步需求：第 2 步候选与主方案失效；已有工位保留，等待重新生成时按名称合并。 */
export function withBrief(draft: DesignDraft, brief: MachineBriefInput, now: Date = new Date()): DesignDraft {
  const next: DesignDraft = {
    ...draft,
    brief: { ...brief, footprint: brief.footprint ? { ...brief.footprint } : null },
    step: 1,
    updatedAt: shanghaiIso(now)
  };
  delete next.candidates;
  delete next.selectedIndex;
  delete next.design;
  return next;
}

export function selectCandidate(draft: DesignDraft, index: 0 | 1 | 2, now: Date = new Date()): DesignDraft {
  const design = draft.candidates?.[index];
  if (!design) throw new Error(`候选 ${index + 1} 不存在`);
  return {
    ...draft,
    selectedIndex: index,
    design,
    stations: stationsFromDesign(design),
    updatedAt: shanghaiIso(now)
  };
}

function sanitizeBrief(value: unknown): MachineBriefInput | null {
  if (!isRecord(value)) return null;
  const process = value.process;
  const incoming = value.incoming;
  const load = value.load;
  const voltage = value.voltage;
  if (typeof value.name !== 'string' || !PROCESSES.has(process as DesignProcess) ||
      !INCOMING.has(incoming as IncomingForm) || !LOADING.has(load as LoadingMethod) ||
      (voltage !== '220VAC' && voltage !== '380VAC') || !finitePositive(value.cyclePerMin)) {
    return null;
  }
  const rawStations = value.stations;
  const stations = rawStations === null || rawStations === undefined
    ? null
    : Number.isInteger(rawStations) && Number(rawStations) >= 1 && Number(rawStations) <= 12
      ? Number(rawStations)
      : null;
  let footprint: DesignFootprint | null = null;
  if (isRecord(value.footprint) && finitePositive(value.footprint.lengthMm) && finitePositive(value.footprint.widthMm)) {
    footprint = { lengthMm: value.footprint.lengthMm, widthMm: value.footprint.widthMm };
  }
  const brand = typeof value.brand === 'string' && value.brand.trim() ? value.brand.trim() : null;
  return {
    name: value.name,
    incoming: incoming as IncomingForm,
    process: process as DesignProcess,
    cyclePerMin: value.cyclePerMin,
    stations,
    load: load as LoadingMethod,
    footprint,
    voltage,
    brand
  };
}

function sanitizeStations(value: unknown): StationDraft[] | null {
  if (!Array.isArray(value)) return null;
  const stations: StationDraft[] = [];
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    if (!Array.isArray(raw.actuators) || !Array.isArray(raw.sensors)) return null;
    const actuators = raw.actuators.filter((item): item is ActuatorConfig =>
      isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string' &&
      (item.kind === 'cylinder' || item.kind === 'gripper' || item.kind === 'rotary') &&
      typeof item.station === 'string');
    const sensors = raw.sensors.filter((item): item is SensorConfig =>
      isRecord(item) && typeof item.point === 'string' && typeof item.station === 'string' &&
      typeof item.part === 'string');
    if (actuators.length !== raw.actuators.length || sensors.length !== raw.sensors.length) return null;
    stations.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `station-${index + 1}`,
      name: raw.name,
      actuators: actuators.map(cloneActuator),
      sensors: sensors.map(cloneSensor)
    });
  }
  return stations;
}

function sanitizePlacements(value: unknown): Placement[] | null {
  if (!Array.isArray(value)) return null;
  const placements: Placement[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.partId !== 'string' ||
        typeof raw.model !== 'string' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y) ||
        !finitePositive(raw.w) || !finitePositive(raw.h)) {
      return null;
    }
    const placement: Placement = {
      id: raw.id,
      partId: raw.partId,
      model: raw.model,
      x: Number(raw.x),
      y: Number(raw.y),
      w: Number(raw.w),
      h: Number(raw.h)
    };
    if (typeof raw.railId === 'string') placement.railId = raw.railId;
    if (typeof raw.tag === 'string') placement.tag = raw.tag;
    if (typeof raw.note === 'string') placement.note = raw.note;
    placements.push(placement);
  }
  return placements;
}

/**
 * 草稿 JSON 解析。任何结构损坏都回落到全新第 1 步，避免半损坏状态把
 * 向导带到一个无法继续的步骤。
 */
export function parseDesignDraft(value: unknown, now: Date = new Date()): DesignDraft {
  if (!isRecord(value) || value.version !== 1) return initialDraft(now);
  const step = value.step;
  if (!DESIGN_STEPS.includes(step as DesignStep)) return initialDraft(now);
  const brief = sanitizeBrief(value.brief);
  const stations = sanitizeStations(value.stations);
  const placements = sanitizePlacements(value.placements);
  if (!brief || !stations || !placements || typeof value.updatedAt !== 'string') return initialDraft(now);
  let candidates: MachineDesign[] | undefined;
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates) || value.candidates.length !== 3 ||
        value.candidates.some((item) => !isRecord(item))) {
      return initialDraft(now);
    }
    candidates = value.candidates as unknown as MachineDesign[];
  }
  const selected = value.selectedIndex;
  const selectedIndex = selected === 0 || selected === 1 || selected === 2 ? selected : undefined;
  const design = isRecord(value.design) ? value.design as unknown as MachineDesign : undefined;
  const draft: DesignDraft = {
    version: 1,
    step: step as DesignStep,
    brief,
    stations,
    placements,
    updatedAt: value.updatedAt
  };
  if (candidates) draft.candidates = candidates;
  if (selectedIndex !== undefined) draft.selectedIndex = selectedIndex;
  if (design) draft.design = design;
  if ((step as number) >= 2 && (!candidates || candidates.length !== 3)) return initialDraft(now);
  if ((step as number) >= 3 && (!design || selectedIndex === undefined || stations.length === 0)) return initialDraft(now);
  if ((step as number) >= 5 && !design) return initialDraft(now);
  return draft;
}

function normalizedPoint(point: string): string {
  return point.trim().toUpperCase();
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 每一步的中文校验错误；空数组表示可前进。 */
export function validateStep(draft: DesignDraft): string[] {
  const errors: string[] = [];
  const brief = draft.brief;
  if (!nonEmpty(brief.name)) errors.push('产品/机型名称不能为空');
  if (!PROCESSES.has(brief.process)) errors.push('请选择有效工艺类型');
  if (!finitePositive(brief.cyclePerMin)) errors.push('目标产能必须大于 0 件/分钟');
  if (brief.stations !== null && (!Number.isInteger(brief.stations) || brief.stations < 1 || brief.stations > 12)) {
    errors.push('期望工位数必须是 1–12 的整数，或留空自动推荐');
  }
  if (brief.footprint && (!finitePositive(brief.footprint.lengthMm) || !finitePositive(brief.footprint.widthMm))) {
    errors.push('占地长和宽必须大于 0 mm，或同时留空');
  }
  if (!INCOMING.has(brief.incoming)) errors.push('请选择来料形式');
  if (!LOADING.has(brief.load)) errors.push('请选择上下料方式');
  if (brief.voltage !== '220VAC' && brief.voltage !== '380VAC') errors.push('请选择供电制式');

  if (draft.step >= 2) {
    const candidates = draft.candidates ?? [];
    if (candidates.length !== 3) errors.push('方案对比必须有 3 个候选');
    const ids = new Set(candidates.map((candidate) => candidate.form?.id ?? ''));
    if (candidates.length === 3 && ids.size !== 3) errors.push('3 个候选的整机形态必须互不相同');
    if (draft.selectedIndex === undefined || !candidates[draft.selectedIndex]) errors.push('请选择一个候选方案作为主方案');
    if (!draft.design) errors.push('尚未生成主方案');
  }

  if (draft.step >= 3) {
    if (draft.stations.length === 0) errors.push('至少需要 1 个工位');
    const stationNames = draft.stations.map((station) => station.name.trim());
    if (stationNames.some((name) => !name)) errors.push('工位名称不能为空');
    if (new Set(stationNames).size !== stationNames.length) errors.push('工位名称不能重复');
    const points = new Set<string>();
    for (const station of draft.stations) {
      for (const actuator of station.actuators) {
        if (!actuator.name.trim()) errors.push(`工位「${station.name}」的执行机构名称不能为空`);
        for (const [label, point] of [
          ['伸出', actuator.extendPoint],
          ['缩回', actuator.retractPoint],
          ['夹紧', actuator.gripPoint],
          ['旋转', actuator.point]
        ] as const) {
          if (!point) continue;
          const key = normalizedPoint(point);
          if (points.has(key)) errors.push(`点位「${point}」重复（${station.name}·${actuator.name} ${label}）`);
          points.add(key);
        }
      }
      for (const sensor of station.sensors) {
        if (!sensor.point.trim()) errors.push(`工位「${station.name}」的传感器点位不能为空`);
        const key = normalizedPoint(sensor.point);
        if (points.has(key)) errors.push(`点位「${sensor.point}」重复（${station.name} 传感器）`);
        points.add(key);
      }
    }
  }

  if (draft.step >= 4) {
    if (draft.placements.filter((placement) => placement.id.startsWith('station:')).length === 0) {
      errors.push('布局至少放置 1 个工位');
    }
  }
  return [...new Set(errors)];
}

export function canAdvance(draft: DesignDraft): boolean {
  return validateStep(draft).length === 0;
}

/** 推进到下一步；当前步校验失败时抛出中文错误，调用方应先展示 validateStep。 */
export function nextStep(draft: DesignDraft, now: Date = new Date()): DesignDraft {
  const errors = validateStep(draft);
  if (errors.length > 0) throw new Error(errors.join('；'));
  if (draft.step >= 5) return draft;
  return { ...draft, step: (draft.step + 1) as DesignStep, updatedAt: shanghaiIso(now) };
}

export function prevStep(draft: DesignDraft, now: Date = new Date()): DesignDraft {
  if (draft.step <= 1) return draft;
  return { ...draft, step: (draft.step - 1) as DesignStep, updatedAt: shanghaiIso(now) };
}
