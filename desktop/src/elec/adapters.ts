/**
 * 适配器：把上游数据翻译成机型无关的 ElecDesign。
 *
 *  ① elecDesignFromProject：已保存的整机工程（参数 + 零件清单）。电机功率由“工艺 → 物理估算器”
 *     注册表给出（目前有输送线阻力模型），没有估算器的工艺按零件名分类、功率取缺省并写进说明；
 *     传感器/执行件一律按零件名分类，不认机型。
 *  ② elecDesignFromMachine：规则引擎机型方案（MachineDesign：config + IO 表 + BOM + 功率）。
 *     IO 表里每个点位就是一个 PLC 点；执行机构/传感器/安全件/电机按类别映射，型号取 BOM 里已选的。
 *
 * 两个适配器都只产出数据；出图管线（renderElecDrawing）里没有任何机型分支。
 */

import type { MachineDesign } from '../machine/synth.ts';
import { buildMachineIoMap, type MachineIoMapRow } from '../machine/io-map.ts';
import { estimateConveyorDrive } from '../machine/conveyor-synth.ts';
import type { ElecDesign, ElecInput, ElecMotor, ElecOutput } from './design.ts';

/* ------------------------------------------------------------------ 共用 */

const PROCESS_CODE: Record<string, string> = {
  conveyor: 'CV',
  screw: 'SC',
  dispense: 'DP',
  assembly: 'AS',
  inspection: 'IN',
  packaging: 'PK'
};

/** 图号：EL-<工艺码>-<工程标识后 4 位>，由数据给出，不写死 */
export function drawingNoFor(process: string | undefined, id: string): string {
  const code = PROCESS_CODE[process ?? ''] ?? 'GN';
  // 取标识最后一段（design-screw-6st → 6ST，proj-ab12 → AB12）
  const segments = id.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const suffix = (segments[segments.length - 1] ?? '').slice(-6).toUpperCase() || '0001';
  return `EL-${code}-${suffix}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ ① 工程 */

export interface ProjectLike {
  id: string;
  name: string;
  process?: string;
  parts: number;
  massKg: number | null;
  partsList?: Array<{ file: string; name: string }>;
  params?: Record<string, number>;
}

/** 工艺 → 电机物理估算器（只算功率与转速，不决定电气结构） */
type DriveEstimator = (params: Record<string, number>) => { powerKw: number; spec: string; note: string } | null;

const DRIVE_ESTIMATORS: Record<string, DriveEstimator> = {
  conveyor: (raw) => {
    const params = {
      lengthMm: Number(raw.lengthMm ?? 2000),
      widthMm: Number(raw.widthMm ?? 300),
      beltHeightMm: Number(raw.beltHeightMm ?? 850),
      pulleyDiameterMm: Number(raw.pulleyDiameterMm ?? 50),
      beltThicknessMm: Number(raw.beltThicknessMm ?? 4),
      frameSectionMm: Number(raw.frameSectionMm ?? 40)
    };
    const drive = estimateConveyorDrive(params, {});
    const powerKw = Math.max(0.04, Math.round((drive.motorW / 1000) * 100) / 100);
    const pulleyRadiusM = Math.max(0.01, params.pulleyDiameterMm / 2 / 1000);
    const rpm = Math.max(1, Math.round((60 * 0.2) / (2 * Math.PI * pulleyRadiusM)));
    const ratio = Math.max(1, Math.round((1400 / rpm) * 10) / 10);
    return {
      powerKw,
      spec: `${rpm} rpm · i=${ratio}`,
      note: `驱动功率按阻力模型估算：牵引力 ${drive.forceN} N，选 ${drive.motorW} W；线体 ${Math.round(params.lengthMm)}×${Math.round(params.widthMm)} mm`
    };
  }
};

interface PartClass {
  pattern: RegExp;
  kind: 'motor' | 'input' | 'output' | 'curtain' | 'estop';
  device?: ElecInput['device'] | ElecOutput['device'];
  noun: string;
}

/** 零件名分类：只看“这是什么电气件”，不看是哪台机器 */
const PART_CLASSES: PartClass[] = [
  { pattern: /安全光栅|光幕/, kind: 'curtain', noun: '安全光栅' },
  { pattern: /急停/, kind: 'estop', noun: '急停' },
  { pattern: /伺服电机|减速电机|电机|马达/, kind: 'motor', noun: '电机' },
  { pattern: /光电/, kind: 'input', device: 'photoelectric', noun: '检测' },
  { pattern: /磁性开关|磁环开关/, kind: 'input', device: 'proximity-2w', noun: '到位' },
  { pattern: /接近/, kind: 'input', device: 'proximity', noun: '检测' },
  { pattern: /压力(开关|传感器)/, kind: 'input', device: 'pressure', noun: '压力' },
  { pattern: /电磁阀|气缸/, kind: 'output', device: 'valve', noun: '电磁阀' },
  { pattern: /蜂鸣/, kind: 'output', device: 'buzzer', noun: '报警' },
  { pattern: /指示灯|三色灯/, kind: 'output', device: 'lamp', noun: '指示' }
];

/** “进料光电支架” → “进料检测”：去掉器件名与安装件后缀，补上动作名 */
function purposeFromPart(name: string, cls: PartClass): string {
  const stripped = name
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/支架|安装座|安装板|本体|组件/g, '')
    .replace(cls.pattern, '')
    .replace(/\s+/g, '')
    .trim();
  return stripped ? `${stripped}${cls.noun}` : cls.noun;
}

export function elecDesignFromProject(project: ProjectLike, options: { date?: string } = {}): ElecDesign {
  const motors: ElecMotor[] = [];
  const inputs: ElecInput[] = [];
  const outputs: ElecOutput[] = [];
  const curtains: ElecDesign['safety']['curtains'] = [];
  let estops = 0;
  const notes: string[] = [];
  const estimator = DRIVE_ESTIMATORS[project.process ?? ''];
  const estimate = estimator ? estimator(project.params ?? {}) : null;
  const seen = new Set<string>();
  for (const part of project.partsList ?? []) {
    const cls = PART_CLASSES.find((item) => item.pattern.test(part.name));
    if (!cls) continue;
    // 同名零件（左右对称件）只算一件
    if (seen.has(part.name)) continue;
    seen.add(part.name);
    const id = `p${seen.size}`;
    if (cls.kind === 'motor') {
      const servo = /伺服/.test(part.name);
      motors.push({
        id,
        name: part.name.replace(/（.*?）|\(.*?\)/g, ''),
        purpose: motors.length === 0 && estimate ? '主驱动' : part.name,
        starter: servo ? 'servo' : 'dol',
        powerKw: estimate && motors.length === 0 ? estimate.powerKw : servo ? 0.4 : 0.37,
        ...(estimate && motors.length === 0 ? { spec: estimate.spec } : {})
      });
      continue;
    }
    if (cls.kind === 'curtain') {
      curtains.push({ id, name: '安全光栅', purpose: purposeFromPart(part.name, cls) });
      continue;
    }
    if (cls.kind === 'estop') {
      estops += 1;
      continue;
    }
    if (cls.kind === 'input') inputs.push({ id, device: cls.device as ElecInput['device'], purpose: purposeFromPart(part.name, cls) });
    else outputs.push({ id, device: cls.device as ElecOutput['device'], purpose: purposeFromPart(part.name, cls) });
  }
  if (estimate) notes.push(estimate.note);
  else if (motors.length > 0) notes.push('该工艺没有电机功率估算器：电机功率按缺省 0.37 kW（伺服 0.4 kW）出图，需按实际负载核算');
  // 运行指示灯：所有机器通用
  outputs.push({ id: 'lamp-run', device: 'lamp', purpose: '运行指示' });
  notes.push(`零件 ${project.parts} 件 · 总质量 ${project.massKg ?? '—'} kg`);
  const simple = motors.length === 1 && motors[0]?.starter === 'dol';
  return {
    project: project.name,
    drawingNo: drawingNoFor(project.process, project.id),
    source: `工程「${project.name}」的参数与零件清单`,
    supply: {},
    plc: { model: 'CPU 1214C DC/DC/DC' },
    psu: { model: 'LRS-150-24', watts: 150 },
    motors,
    inputs,
    outputs,
    safety: { estops: Math.max(1, estops), curtains, relay: curtains.length > 0 },
    // 单台直启电机的简单机器用起保停硬接线；其余由 PLC 控制
    startStop: simple ? 'hardwired' : 'plc',
    notes,
    date: options.date ?? today()
  };
}

/* ------------------------------------------------------------------ ② 机型方案 */

/** 机型方案里出电气图要用的部分：config 必有；BOM 草稿/功率估算缺失时按缺省出图并写说明 */
export type MachineDesignLike = Pick<MachineDesign, 'config'> & Partial<Pick<MachineDesign, 'power' | 'bomDraft' | 'assumptions'>>;
type DesignLike = MachineDesignLike;

function bomModel(design: DesignLike, test: (item: MachineDesign['bomDraft']['items'][number]) => boolean): string | undefined {
  const hit = design.bomDraft?.items.find((item) => test(item) && item.model && !item.pendingSelection);
  return hit?.model;
}

function wattsOf(text: string | undefined): number | null {
  const match = /([\d.]+)\s*(k?W)\b/i.exec(text ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return /k/i.test(match[2] ?? '') ? value * 1000 : value;
}

export interface MachineAdapterOptions {
  /** 已有的 IO 表（缺省按 config 现算，与 PLC 包同一地址分配） */
  ioRows?: readonly MachineIoMapRow[];
  date?: string;
}

export function elecDesignFromMachine(design: DesignLike, options: MachineAdapterOptions = {}): ElecDesign {
  const { config } = design;
  const rows = options.ioRows ?? buildMachineIoMap(config).rows;
  const notes: string[] = [];
  const bomItems = design.bomDraft?.items ?? [];
  const servoGroup = design.power?.byGroup.find((group) => group.name === '伺服');
  const rotaryGroup = design.power?.byGroup.find((group) => group.name === '旋转轴');
  const hasServo = Boolean(servoGroup) || bomItems.some((item) => /伺服/.test(item.name));
  const gearMotor = bomItems.find((item) => /减速电机/.test(item.name));

  // 电机：每个旋转轴一台（有伺服 → 伺服驱动；只有减速电机 → 直接起动）
  const motors: ElecMotor[] = [];
  const motorOfActuator = new Map<string, string>();
  for (const actuator of config.actuators.filter((item) => item.kind === 'rotary')) {
    const servo = hasServo || !gearMotor;
    let watts: number | null;
    if (servo) {
      watts = bomItems.find((item) => item.role === 'servo' && item.ratedW)?.ratedW
        ?? (servoGroup ? servoGroup.ratedW / Math.max(1, servoGroup.count) : null)
        ?? (rotaryGroup ? rotaryGroup.ratedW / Math.max(1, rotaryGroup.count) : null);
    } else {
      watts = wattsOf(gearMotor?.name) ?? wattsOf(gearMotor?.model) ?? (rotaryGroup ? rotaryGroup.ratedW / Math.max(1, rotaryGroup.count) : null);
    }
    const powerKw = Math.round(((watts ?? (servo ? 400 : 370)) / 1000) * 1000) / 1000;
    if (watts === null) notes.push(`${actuator.name} 功率无数据，按 ${powerKw} kW 出图`);
    motors.push({
      id: actuator.id,
      name: servo ? '伺服电机' : '减速电机',
      purpose: actuator.name,
      starter: servo ? 'servo' : 'dol',
      powerKw,
      ...(servo ? {
        ...(bomModel(design, (item) => item.name === '伺服电机') ? { motorModel: bomModel(design, (item) => item.name === '伺服电机') as string } : {}),
        ...(bomModel(design, (item) => item.name === '伺服驱动器') ? { driveModel: bomModel(design, (item) => item.name === '伺服驱动器') as string } : {}),
        ...(bomModel(design, (item) => item.name === '伺服支路断路器') ? { breakerModel: bomModel(design, (item) => item.name === '伺服支路断路器') as string } : {})
      } : {
        ...(gearMotor?.name ? { spec: gearMotor.name.replace(/^减速电机\s*/, '') } : {})
      })
    });
    motorOfActuator.set(actuator.name, actuator.id);
  }

  const proximityModel = bomModel(design, (item) => /到位|接近|磁性/.test(item.name));
  const twoWire = /D-M9B|磁性/.test(`${proximityModel ?? ''}${bomItems.map((item) => item.name).join(' ')}`);
  const valveModel = bomModel(design, (item) => item.role === 'valve' || /电磁阀/.test(item.name));
  const curtainModel = bomModel(design, (item) => item.role === 'safety' || /安全光栅/.test(item.name));
  const curtains: ElecDesign['safety']['curtains'] = [];
  const inputs: ElecInput[] = [];
  const outputs: ElecOutput[] = [];
  let estopStatus = false;
  for (const row of rows) {
    const base = { id: row.point, purpose: row.comment.replace(/^(输入|输出)\s*[^；;]*[；;]\s*/, '') || `${row.owner} ${row.type}`, address: row.address, point: row.point };
    if (row.direction === '输入') {
      if (row.type === '安全光栅' || row.type === '安全门/光栅') {
        const id = `curtain-${row.point}`;
        curtains.push({ id, name: '安全光栅', ...(curtainModel ? { model: curtainModel } : {}), purpose: `${row.station} 防护` });
        inputs.push({ ...base, device: 'safety-status', safetyOf: id, purpose: `${row.station} 光栅状态` });
      } else if (row.type === '急停') {
        estopStatus = true;
        inputs.push({ ...base, device: 'safety-status', safetyOf: 'estop', purpose: '急停状态' });
      } else if (row.type === '光电传感器') inputs.push({ ...base, device: 'photoelectric' });
      else if (row.type === '压力传感器') inputs.push({ ...base, device: 'pressure' });
      else if (row.type === '接近开关') inputs.push({ ...base, device: twoWire ? 'proximity-2w' : 'proximity', ...(proximityModel ? { model: proximityModel } : {}) });
      else inputs.push({ ...base, device: 'button-no', role: 'other' });
      continue;
    }
    if (row.type.startsWith('旋转轴')) {
      const motorId = motorOfActuator.get(row.owner);
      if (motorId) {
        outputs.push({ ...base, device: 'motor-run', motorId });
        continue;
      }
    }
    if (row.ownerType === '执行机构') outputs.push({ ...base, device: 'valve', ...(valveModel ? { model: valveModel } : {}) });
    else outputs.push({ ...base, device: 'relay' });
  }
  const plcModel = bomModel(design, (item) => item.role === 'plc') ?? 'CPU 1214C DC/DC/DC';
  const psuItem = bomItems.find((item) => item.role === 'psu');
  const relayModel = bomModel(design, (item) => /安全继电器/.test(item.name));
  const mainBreakerModel = bomModel(design, (item) => /总进线断路器/.test(item.name));
  notes.push(`IO ${rows.length} 点按方案 IO 表取地址；执行机构/传感器型号取方案 BOM 已选型号`);
  if (estopStatus) notes.push('急停状态经安全继电器 Y32 反馈 PLC');
  return {
    project: config.name,
    drawingNo: drawingNoFor(processOf(config.id), config.id),
    source: `机型方案「${config.name}」（${config.id}）的 IO 表、BOM 与功率估算`,
    supply: { ...(mainBreakerModel ? { mainBreakerModel } : {}) },
    plc: { model: plcModel },
    psu: { model: psuItem?.model ?? 'LRS-150-24', watts: psuItem?.ratedW ?? wattsOf(psuItem?.model) ?? 150 },
    motors,
    inputs,
    outputs: [...outputs, { id: 'lamp-run', device: 'lamp', purpose: '运行指示' }],
    safety: {
      estops: 1,
      curtains,
      relay: curtains.length > 0 || estopStatus,
      ...(relayModel ? { relayModel, curtainRelayModel: relayModel } : {})
    },
    startStop: 'plc',
    notes,
    date: options.date ?? today()
  };
}

function processOf(id: string): string | undefined {
  return Object.keys(PROCESS_CODE).find((key) => id.includes(key));
}
