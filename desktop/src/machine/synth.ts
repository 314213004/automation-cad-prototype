// 机型方案合成：纯函数。输入 MachineBrief，输出可直接喂给 createScene3D 的
// MachineConfig，以及点位、节拍、功率、BOM 草案、警告与假设。
//
// 诚实边界：几何仍是配置驱动；功率来自固定估算表；节拍是工艺余量 + 机构动作
// 时间的粗略估算，不替代节拍分析、结构强度、干涉和真实运动学校核。

import type { MachineConfig } from '../commission/machine-config.ts';
import { validateMachineConfig } from '../commission/machine-config.ts';
import {
  DEFAULT_NOTE_CYCLE,
  DEFAULT_NOTE_STATIONS,
  MACHINE_DEFAULT_CYCLE_PER_MIN,
  MACHINE_STATIONS_MAX,
  MACHINE_STATIONS_MIN,
  type MachineActuatorKind,
  type MachineBrief,
  type MachineProcess,
  type MachineSensorKind
} from './spec.ts';

export interface MachineCycleEstimate {
  perMin: number;
  secondsPerPiece: number;
  bottleneck: string;
}

export interface MachinePowerEstimate {
  va: number;
  byGroup: { name: string; va: number }[];
}

export interface MachineBomItem {
  kind: 'actuator' | 'sensor' | 'electrical';
  name: string;
  qty: number;
  /** 可选型号；方案合成默认不编造型号。 */
  model?: string;
  note?: string;
}

export interface MachineDesign {
  config: MachineConfig;
  points: string[];
  cycle: MachineCycleEstimate;
  power: MachinePowerEstimate;
  bomDraft: { items: MachineBomItem[] };
  warnings: string[];
  assumptions: string[];
}

export interface SynthOptions {
  stationCount?: number;
  cyclePerMin?: number;
  name?: string;
  id?: string;
}

export const POWER_VA = {
  cylinder: 5,
  gripper: 15,
  rotary: 200,
  servo: 750,
  sensor: 3,
  safety: 20
} as const;

const PROCESS_LABEL: Record<MachineProcess, string> = {
  screw: '锁螺丝',
  dispense: '点胶',
  assembly: '装配',
  inspection: '检测',
  packaging: '包装',
  unknown: '通用'
};

const ACTUATOR_LABEL: Record<MachineActuatorKind, string> = {
  cylinder: '气缸',
  gripper: '夹爪',
  rotary: '旋转轴'
};

const SENSOR_LABEL: Record<MachineSensorKind, string> = {
  proximity: '接近开关',
  photoelectric: '光电传感器',
  safety: '安全光栅',
  pressure: '压力传感器'
};

/** 工艺基线：每工位的默认动作与检测类型。仅在 brief 未给出对应清单时启用。 */
const ACTUATOR_TEMPLATE: Record<MachineProcess, MachineActuatorKind[]> = {
  screw: ['rotary', 'gripper'],
  dispense: ['rotary'],
  assembly: ['cylinder', 'gripper'],
  inspection: ['rotary'],
  packaging: ['cylinder', 'gripper'],
  unknown: ['cylinder']
};

const SENSOR_TEMPLATE: Record<MachineProcess, MachineSensorKind[]> = {
  screw: ['proximity', 'pressure'],
  dispense: ['pressure'],
  assembly: ['proximity', 'proximity'],
  inspection: ['photoelectric', 'safety'],
  packaging: ['photoelectric', 'proximity'],
  unknown: ['proximity']
};

/** 工艺固定余量（秒/件）：换刀、定位、上下料衔接等，未建模为真实动作。 */
const PROCESS_BASE_SECONDS: Record<MachineProcess, number> = {
  screw: 2.2,
  dispense: 2.4,
  assembly: 1.8,
  inspection: 1.5,
  packaging: 1.8,
  unknown: 2
};

const ACTUATOR_SECONDS: Record<MachineActuatorKind, number> = {
  cylinder: 0.4,
  gripper: 0.28,
  rotary: 0.7
};

const ACTUATOR_DURATION_MS: Record<MachineActuatorKind, number> = {
  cylinder: 400,
  gripper: 280,
  rotary: 700
};

const ACTUATOR_TRAVEL_MM: Record<MachineActuatorKind, number> = {
  cylinder: 40,
  gripper: 20,
  rotary: 90
};

const ACTUATOR_POSITION: Record<MachineActuatorKind, [number, number, number]> = {
  cylinder: [-0.72, 0.55, -0.38],
  gripper: [0.05, 0.55, -0.38],
  rotary: [0.76, 0.65, 0.35]
};

function assertStations(value: number): number {
  if (!Number.isInteger(value) || value < MACHINE_STATIONS_MIN || value > MACHINE_STATIONS_MAX) {
    throw new Error(`工位数必须是 ${MACHINE_STATIONS_MIN}–${MACHINE_STATIONS_MAX} 的整数`);
  }
  return value;
}

function assertCycle(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('节拍必须大于 0 件/分钟');
  return value;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function countKinds<T extends string>(items: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

function flattened<T>(entries: readonly { kind: T; count: number }[]): T[] {
  const result: T[] = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.count; index += 1) result.push(entry.kind);
  }
  return result;
}

function distribute<T>(items: readonly T[], stations: number): T[][] {
  const buckets = Array.from({ length: stations }, () => [] as T[]);
  for (const [index, item] of items.entries()) buckets[index % stations]?.push(item);
  return buckets;
}

function stationPoints(stationIndex: number, actuatorIndex: number, kind: MachineActuatorKind): {
  extendPoint?: string;
  retractPoint?: string;
  gripPoint?: string;
  point?: string;
} {
  const prefix = `ST${stationIndex + 1}`;
  const actuator = `A${actuatorIndex}`;
  if (kind === 'cylinder') {
    return { extendPoint: `${prefix}-EXT-${actuator}`, retractPoint: `${prefix}-RET-${actuator}` };
  }
  if (kind === 'gripper') return { gripPoint: `${prefix}-GRIP-${actuator}` };
  return { point: `${prefix}-ROT-${actuator}` };
}

function sensorPoint(stationIndex: number, sensorIndex: number, kind: MachineSensorKind): string {
  const prefix = `ST${stationIndex + 1}`;
  const code: Record<MachineSensorKind, string> = {
    proximity: 'PRX',
    photoelectric: 'PHT',
    safety: 'SAFE',
    pressure: 'PRS'
  };
  return `${prefix}-${code[kind]}-S${sensorIndex}`;
}

function sensorKindFromPoint(point: string): MachineSensorKind {
  if (point.includes('-SAFE-')) return 'safety';
  if (point.includes('-PRS-')) return 'pressure';
  if (point.includes('-PHT-')) return 'photoelectric';
  return 'proximity';
}

function sanitizeId(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'machine-design';
}

function servoDetected(brief: MachineBrief): boolean {
  return brief.notes.some((note) => /伺服|步进/.test(note));
}

function templateDescription(kinds: readonly string[]): string {
  return kinds.join('、');
}

function buildPower(actuators: readonly MachineActuatorKind[], sensors: readonly MachineSensorKind[], servo: boolean): MachinePowerEstimate {
  const actuatorCounts = countKinds(actuators);
  const sensorCounts = countKinds(sensors);
  const groups: { name: string; va: number }[] = [];
  const add = (name: string, qty: number, unit: number): void => {
    if (qty > 0) groups.push({ name, va: qty * unit });
  };

  add('气缸', actuatorCounts.get('cylinder') ?? 0, POWER_VA.cylinder);
  add('夹爪', actuatorCounts.get('gripper') ?? 0, POWER_VA.gripper);
  if (servo) {
    add('伺服', actuatorCounts.get('rotary') ?? 0, POWER_VA.servo);
  } else {
    add('旋转轴', actuatorCounts.get('rotary') ?? 0, POWER_VA.rotary);
  }
  const ordinarySensors =
    (sensorCounts.get('proximity') ?? 0) +
    (sensorCounts.get('photoelectric') ?? 0) +
    (sensorCounts.get('pressure') ?? 0);
  add('传感器', ordinarySensors, POWER_VA.sensor);
  add('安全光栅', sensorCounts.get('safety') ?? 0, POWER_VA.safety);

  return {
    va: groups.reduce((sum, group) => sum + group.va, 0),
    byGroup: groups
  };
}

function buildBom(
  actuators: readonly MachineActuatorKind[],
  sensors: readonly MachineSensorKind[],
  servo: boolean,
  brief: MachineBrief
): { items: MachineBomItem[] } {
  const actuatorCounts = countKinds(actuators);
  const sensorCounts = countKinds(sensors);
  const items: MachineBomItem[] = [];

  for (const kind of ['cylinder', 'gripper', 'rotary'] as const) {
    const qty = actuatorCounts.get(kind) ?? 0;
    if (qty > 0) items.push({ kind: 'actuator', name: ACTUATOR_LABEL[kind], qty, note: '型号待定，按方案数量估算' });
  }
  for (const kind of ['proximity', 'photoelectric', 'safety', 'pressure'] as const) {
    const qty = sensorCounts.get(kind) ?? 0;
    if (qty > 0) items.push({ kind: 'sensor', name: SENSOR_LABEL[kind], qty, note: '型号待定，按方案数量估算' });
  }
  if (servo) {
    items.push({
      kind: 'electrical',
      name: '伺服驱动器',
      qty: Math.max(1, actuatorCounts.get('rotary') ?? 0),
      note: '按伺服轴数量估算，型号待定'
    });
  }
  const voltage = brief.voltage ? `，${brief.voltage}` : '';
  items.push({
    kind: 'electrical',
    name: '电气控制（PLC/电源/端子）',
    qty: 1,
    note: `按点位估算${voltage}，待选型`
  });
  return { items };
}

function buildSummary(design: MachineDesign): string {
  const { config, cycle, power, warnings } = design;
  const actuatorCounts = countKinds(config.actuators.map((actuator) => actuator.kind));
  const sensorCounts = countKinds(config.sensors.map((sensor) => sensorKindFromPoint(sensor.point)));
  const actuatorText = (['cylinder', 'gripper', 'rotary'] as const)
    .filter((kind) => (actuatorCounts.get(kind) ?? 0) > 0)
    .map((kind) => `${ACTUATOR_LABEL[kind]} ${actuatorCounts.get(kind) ?? 0}`)
    .join('、');
  const sensorText = (['proximity', 'photoelectric', 'safety', 'pressure'] as const)
    .filter((kind) => (sensorCounts.get(kind) ?? 0) > 0)
    .map((kind) => `${SENSOR_LABEL[kind]} ${sensorCounts.get(kind) ?? 0}`)
    .join('、');
  const risk = warnings.length > 0 ? warnings.join('；') : '未发现明显参数冲突，仍需人工确认选型与安全。';
  const text = [
    `机型方案：${config.name}`,
    `工位：${config.stations.length} 个；执行机构：${config.actuators.length} 个（${actuatorText || '无'}）；传感器：${config.sensors.length} 个（${sensorText || '无'}）`,
    `节拍：${cycle.perMin} 件/分钟（${cycle.secondsPerPiece.toFixed(2)} 秒/件）；瓶颈：${cycle.bottleneck}`,
    `功率：约 ${power.va} VA（固定表估算）`,
    `风险：${risk}`,
    '说明：几何仍由机型配置驱动，功率与节拍均为估算，需人工确认。'
  ].join('\n');
  return text.length <= 600 ? text : `${text.slice(0, 597)}...`;
}

export function synthMachine(brief: MachineBrief, options: SynthOptions = {}): MachineDesign {
  const stations = assertStations(options.stationCount ?? brief.stations);
  const cyclePerMin = assertCycle(options.cyclePerMin ?? brief.cyclePerMin ?? MACHINE_DEFAULT_CYCLE_PER_MIN);
  const process = brief.process;
  const servo = servoDetected(brief);
  const warnings: string[] = [];
  const assumptions: string[] = [
    '功率按固定估算表计算（气缸 5 VA、夹爪 15 VA、旋转轴 200 VA、伺服 750 VA、传感器 3 VA、安全光栅 20 VA），为粗略估算，不等于实测有功功率。',
    '节拍按单工位串行动作加固定工艺余量估算，未计入上下料、通讯、人工干预与调试损失。',
    '几何仍由 MachineConfig 配置驱动，不包含结构强度、干涉与真实运动学校核。'
  ];

  if (process === 'unknown') {
    warnings.push('未识别工艺：已按通用工艺（每工位 1 气缸 + 1 接近开关）合成，请确认工艺类型。');
    assumptions.push('未识别工艺，按通用工艺模板补全动作与检测。');
  }
  if (options.stationCount === undefined && brief.notes.includes(DEFAULT_NOTE_STATIONS)) {
    warnings.push('未提供工位数：已按缺省值 1 工位合成，请确认实际工位数。');
    assumptions.push('工位数缺省为 1。');
  }
  if (options.stationCount === undefined) {
    const invalidStationNote = brief.notes.find((note) => /^工位数\s*\d+\s*(?:无效|超出)/.test(note));
    if (invalidStationNote) warnings.push(invalidStationNote);
  }
  if (options.cyclePerMin === undefined && brief.cyclePerMin === null) {
    warnings.push(`未提供节拍：已按缺省值 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟（${(60 / MACHINE_DEFAULT_CYCLE_PER_MIN).toFixed(1)} 秒/件）估算，请确认目标产能。`);
    assumptions.push(`节拍缺省为 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟。`);
  }
  if (brief.notes.includes(DEFAULT_NOTE_CYCLE) && brief.cyclePerMin !== null) {
    // 理论上不会同时出现；保留显式标记的防御分支，避免外部构造的 brief 丢失缺省说明。
    assumptions.push('brief 标记了节拍缺省，但已提供 cyclePerMin；以 cyclePerMin 为准。');
  }

  let actuatorKinds = flattened(brief.actuators);
  let actuatorSource = 'brief';
  if (actuatorKinds.length === 0) {
    actuatorKinds = Array.from({ length: stations }, () => ACTUATOR_TEMPLATE[process]).flat();
    actuatorSource = 'template';
    assumptions.push(`未指定执行机构，按 ${process} 工艺模板补全（每工位：${templateDescription(ACTUATOR_TEMPLATE[process])}）。`);
  }

  let actuatorBuckets = distribute(actuatorKinds, stations);
  const emptyActuatorStations = actuatorBuckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.length === 0);
  if (emptyActuatorStations.length > 0) {
    const fillKind = ACTUATOR_TEMPLATE[process][0] ?? 'cylinder';
    for (const { bucket } of emptyActuatorStations) bucket.push(fillKind);
    actuatorBuckets = actuatorBuckets;
    warnings.push(
      `执行机构数量不足：${emptyActuatorStations.length} 个工位没有动作，已补 ${ACTUATOR_LABEL[fillKind]}；建议至少为每工位配置 1 个动作。`
    );
  }

  let sensorKinds = flattened(brief.sensors);
  let sensorSource = 'brief';
  if (sensorKinds.length === 0) {
    sensorKinds = Array.from({ length: stations }, () => SENSOR_TEMPLATE[process]).flat();
    sensorSource = 'template';
    assumptions.push(`未指定传感器，按 ${process} 工艺模板补全（每工位：${templateDescription(SENSOR_TEMPLATE[process])}）。`);
  }

  let sensorBuckets = distribute(sensorKinds, stations);
  const emptySensorStations = sensorBuckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(({ bucket }) => bucket.length === 0);
  if (emptySensorStations.length > 0) {
    for (const { bucket } of emptySensorStations) bucket.push('proximity');
    sensorBuckets = sensorBuckets;
    warnings.push(
      `传感器数量不足：${emptySensorStations.length} 个工位没有到位检测，已补接近开关；建议每工位至少 1 个到位检测。`
    );
  }

  const stationNames = Array.from({ length: stations }, (_unused, index) => `工位${index + 1}`);
  const actuators: MachineConfig['actuators'] = [];
  const sensors: MachineConfig['sensors'] = [];
  const points: string[] = [];

  for (const [stationIndex, station] of stationNames.entries()) {
    const kinds = actuatorBuckets[stationIndex] ?? [];
    const actuatorIds: string[] = [];
    for (const [offset, kind] of kinds.entries()) {
      const actuatorIndex = offset + 1;
      const id = `st${stationIndex + 1}-${kind}-${actuatorIndex}`;
      const pointFields = stationPoints(stationIndex, actuatorIndex, kind);
      const actuator = {
        id,
        name: `${station}${ACTUATOR_LABEL[kind]}${actuatorIndex}`,
        kind,
        station,
        travelMm: ACTUATOR_TRAVEL_MM[kind],
        durationMs: ACTUATOR_DURATION_MS[kind],
        position: ACTUATOR_POSITION[kind],
        ...pointFields
      } satisfies MachineConfig['actuators'][number];
      actuators.push(actuator);
      actuatorIds.push(id);
      for (const point of [pointFields.extendPoint, pointFields.retractPoint, pointFields.gripPoint, pointFields.point]) {
        if (point !== undefined) points.push(point);
      }
    }

    const stationSensorKinds = sensorBuckets[stationIndex] ?? [];
    for (const [offset, kind] of stationSensorKinds.entries()) {
      const point = sensorPoint(stationIndex, offset + 1, kind);
      sensors.push({
        point,
        station,
        part: actuatorIds[0] ?? station,
        ...(kind === 'safety' ? { color: '#ef4444' } : {})
      });
      points.push(point);
    }
  }

  const config = validateMachineConfig({
    id: options.id ? sanitizeId(options.id) : `design-${process}-${stations}st`,
    name: options.name ?? `${stations} 工位${PROCESS_LABEL[process]}机（方案草案）`,
    stations: stationNames,
    actuators,
    sensors
  });

  const baseSeconds = PROCESS_BASE_SECONDS[process];
  let slowest = { station: 1, seconds: 0, kind: ACTUATOR_TEMPLATE[process][0] ?? 'cylinder' };
  for (const [stationIndex, kinds] of actuatorBuckets.entries()) {
    const actionSeconds = kinds.reduce((sum, kind) => sum + ACTUATOR_SECONDS[kind], 0);
    const stationKind = kinds.reduce<MachineActuatorKind | null>((best, kind) => {
      if (!best) return kind;
      return ACTUATOR_SECONDS[kind] > ACTUATOR_SECONDS[best] ? kind : best;
    }, null) ?? 'cylinder';
    const seconds = baseSeconds + actionSeconds;
    if (seconds > slowest.seconds) slowest = { station: stationIndex + 1, seconds, kind: stationKind };
  }
  const secondsPerPiece = round(60 / cyclePerMin);
  if (slowest.seconds > secondsPerPiece) {
    const parallel = Math.max(1, Math.ceil(slowest.seconds / secondsPerPiece - 1e-9));
    warnings.push(
      `节拍瓶颈：工位${slowest.station} 估算 ${round(slowest.seconds, 2).toFixed(2)} 秒/件，超过目标 ${secondsPerPiece.toFixed(2)} 秒/件；` +
      `建议每道工序至少 ${parallel} 个并行工位（总工位建议 ≥ ${stations * parallel}）。`
    );
  }
  const bottleneck =
    `工位${slowest.station} 估算 ${round(slowest.seconds, 2).toFixed(2)} 秒/件` +
    `（工艺固定 ${baseSeconds.toFixed(2)}s + ${ACTUATOR_LABEL[slowest.kind]} ${ACTUATOR_SECONDS[slowest.kind].toFixed(2)}s）`;

  if (servo) {
    assumptions.push('检测到伺服/步进驱动：按旋转轴建模，并在功率估算中按 750 VA/轴计入伺服驱动。');
  }
  if (brief.brand) assumptions.push(`品牌按需求中的「${brief.brand}」记录，具体型号待选型。`);
  if (brief.voltage) assumptions.push(`供电按需求中的 ${brief.voltage} 记录，未做容量与保护校验。`);
  if (actuatorSource === 'brief') assumptions.push('执行机构按需求数量均分到各工位。');
  if (sensorSource === 'brief') assumptions.push('传感器按需求数量均分到各工位。');

  const finalActuatorKinds = actuatorBuckets.flat();
  const finalSensorKinds = sensorBuckets.flat();
  const power = buildPower(finalActuatorKinds, finalSensorKinds, servo);
  const bomDraft = buildBom(finalActuatorKinds, finalSensorKinds, servo, brief);
  const design: MachineDesign = {
    config,
    points,
    cycle: { perMin: cyclePerMin, secondsPerPiece, bottleneck },
    power,
    bomDraft,
    warnings,
    assumptions
  };
  return design;
}

/** 给 Agent 工具用的中文摘要；≤600 字，包含工位/机构/传感器/节拍/功率/风险。 */
export function summarizeMachineDesign(design: MachineDesign): string {
  return buildSummary(design);
}
