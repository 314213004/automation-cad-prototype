// 五类工艺模板：只描述每工位的默认机构/检测与合理节拍区间，不包含具体型号。
// 模板是纯数据，供 synthMachine、design_machine 与测试直接读取。

import type {
  MachineActuatorKind,
  MachineProcess,
  MachineSensorKind
} from './spec.ts';

export type MachineTemplateKey = Exclude<MachineProcess, 'unknown'>;

export interface MachineTemplate {
  key: MachineTemplateKey | 'generic';
  label: string;
  /** 缺省工位数；用户未给出时按此值生成，并写入 assumptions。 */
  stations: number;
  /** 每工位的执行机构（数量按单工位计）。 */
  actuators: { kind: MachineActuatorKind; count: number }[];
  /** 每工位的传感器（数量按单工位计）。 */
  sensors: { kind: MachineSensorKind; count: number }[];
  /** 参考节拍区间（件/分钟），只用于提示，不硬性拦截用户目标。 */
  cycleRange: { minPerMin: number; maxPerMin: number };
  rationale: string;
}

export const TEMPLATES: Record<MachineTemplateKey, MachineTemplate> = {
  screw: {
    key: 'screw',
    label: '锁螺丝',
    stations: 2,
    actuators: [
      { kind: 'rotary', count: 1 },
      { kind: 'gripper', count: 1 }
    ],
    sensors: [{ kind: 'proximity', count: 1 }],
    cycleRange: { minPerMin: 12, maxPerMin: 30 },
    rationale: '锁螺丝需要旋转轴完成拧紧、夹爪固定工件，并用接近开关确认工件到位；单站节拍受取放与拧紧行程限制。'
  },
  dispense: {
    key: 'dispense',
    label: '点胶',
    stations: 2,
    actuators: [{ kind: 'rotary', count: 1 }],
    sensors: [{ kind: 'pressure', count: 1 }],
    cycleRange: { minPerMin: 10, maxPerMin: 24 },
    rationale: '点胶用三轴模组表达为旋转轴占位，压力传感器用于确认胶路压力；胶量稳定与固化衔接决定节拍上限。'
  },
  assembly: {
    key: 'assembly',
    label: '装配',
    stations: 2,
    actuators: [
      { kind: 'cylinder', count: 1 },
      { kind: 'gripper', count: 1 }
    ],
    sensors: [{ kind: 'proximity', count: 2 }],
    cycleRange: { minPerMin: 8, maxPerMin: 20 },
    rationale: '压装气缸提供装配行程、夹爪负责定位与保持，双接近开关分别确认压装前后位置；压装时间与零件公差影响节拍。'
  },
  inspection: {
    key: 'inspection',
    label: '检测',
    stations: 2,
    actuators: [{ kind: 'rotary', count: 1 }],
    sensors: [
      { kind: 'photoelectric', count: 1 },
      { kind: 'safety', count: 1 }
    ],
    cycleRange: { minPerMin: 20, maxPerMin: 60 },
    rationale: '相机位用旋转轴占位，光电传感器触发拍照，安全光栅隔离人工干预区域；检测节拍主要受成像与算法判定时间限制。'
  },
  packaging: {
    key: 'packaging',
    label: '包装',
    stations: 2,
    actuators: [
      { kind: 'cylinder', count: 1 },
      { kind: 'gripper', count: 1 }
    ],
    sensors: [{ kind: 'photoelectric', count: 1 }],
    cycleRange: { minPerMin: 12, maxPerMin: 30 },
    rationale: '推料气缸完成入盒/推料、吸盘按夹爪建模完成取放，光电传感器确认物料到位；纸盒成型与节拍匹配决定产能。'
  }
};

/** 工艺未知时的保守模板：每工位 1 气缸 + 1 接近开关。 */
export const GENERIC_TEMPLATE: MachineTemplate = {
  key: 'generic',
  label: '通用',
  stations: 2,
  actuators: [{ kind: 'cylinder', count: 1 }],
  sensors: [{ kind: 'proximity', count: 1 }],
  cycleRange: { minPerMin: 6, maxPerMin: 20 },
  rationale: '未识别工艺时只保留最保守的单气缸动作与到位检测，必须由用户确认后再细化。'
};

export function templateFor(process: MachineProcess): MachineTemplate {
  if (process === 'unknown') return GENERIC_TEMPLATE;
  return TEMPLATES[process];
}

/** 把模板中「每工位数量」展开成重复 kind 列表，保持模板声明顺序。 */
export function templateKinds<T extends string>(entries: readonly { kind: T; count: number }[]): T[] {
  const kinds: T[] = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.count; index += 1) kinds.push(entry.kind);
  }
  return kinds;
}
