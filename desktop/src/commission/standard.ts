import type { PlcConfig, PlcPoint, SimRule } from '../plc/types.ts';
import type { Step } from './sequence.ts';

export interface CommissionCase {
  id: string;
  name: string;
  description: string;
  steps: Step[];
}

export const COMMISSION_POINTS: readonly PlcPoint[] = [
  { id: 'X0', name: '主回路反馈（DI 0.0）', area: 'discrete', address: 0, dataType: 'bool' },
  { id: 'X1', name: '24V 电源反馈（DI 0.1）', area: 'discrete', address: 1, dataType: 'bool' },
  { id: 'X2', name: 'PLC RUN 反馈（DI 0.2）', area: 'discrete', address: 2, dataType: 'bool' },
  { id: 'X3', name: '气源压力开关（DI 0.3）', area: 'discrete', address: 3, dataType: 'bool' },
  { id: 'X4', name: '原点到位（DI 0.4）', area: 'discrete', address: 4, dataType: 'bool' },
  { id: 'X5', name: 'PLC 就绪反馈（DI 0.5）', area: 'discrete', address: 5, dataType: 'bool' },
  { id: 'X6', name: '滑台前进到位（DI 0.6）', area: 'discrete', address: 6, dataType: 'bool' },
  { id: 'X7', name: '滑台后退到位（DI 0.7）', area: 'discrete', address: 7, dataType: 'bool' },
  { id: 'X8', name: '安全门闭合 SQ1（DI 1.0）', area: 'discrete', address: 8, dataType: 'bool' },
  { id: 'X9', name: '急停链路断开（DI 1.1）', area: 'discrete', address: 9, dataType: 'bool' },
  { id: 'X10', name: '急停复位（DI 1.2）', area: 'discrete', address: 10, dataType: 'bool' },
  { id: 'X11', name: '气源低压报警（DI 1.3）', area: 'discrete', address: 11, dataType: 'bool' },
  { id: 'X12', name: '伺服就绪（DI 1.4）', area: 'discrete', address: 12, dataType: 'bool' },
  { id: 'X13', name: '伺服报警（DI 1.5）', area: 'discrete', address: 13, dataType: 'bool' },
  { id: 'X14', name: '报警锁存（DI 1.6）', area: 'discrete', address: 14, dataType: 'bool' },
  { id: 'Y0', name: '主回路接触器 KM1（DO 0.0）', area: 'coil', address: 0, dataType: 'bool', writable: true },
  { id: 'Y1', name: '24V 电源输出（DO 0.1）', area: 'coil', address: 1, dataType: 'bool', writable: true },
  { id: 'Y2', name: 'PLC RUN 输出（DO 0.2）', area: 'coil', address: 2, dataType: 'bool', writable: true },
  { id: 'Y3', name: '气源电磁阀 YV0（DO 0.3）', area: 'coil', address: 3, dataType: 'bool', writable: true },
  { id: 'Y4', name: '回原点输出（DO 0.4）', area: 'coil', address: 4, dataType: 'bool', writable: true },
  { id: 'Y5', name: '就绪指示灯 HL1（DO 0.5）', area: 'coil', address: 5, dataType: 'bool', writable: true },
  { id: 'Y6', name: '滑台前进电磁阀 YV1（DO 0.6）', area: 'coil', address: 6, dataType: 'bool', writable: true },
  { id: 'Y7', name: '滑台后退电磁阀 YV2（DO 0.7）', area: 'coil', address: 7, dataType: 'bool', writable: true },
  { id: 'Y8', name: '急停测试继电器 KA1（DO 1.0）', area: 'coil', address: 8, dataType: 'bool', writable: true },
  { id: 'AI0', name: '气源压力（AI 0.0）', area: 'input', address: 0, dataType: 'uint16', unit: 'kPa' },
  { id: 'AI1', name: '伺服负载电流（AI 0.1）', area: 'input', address: 1, dataType: 'uint16', unit: '0.01A' },
  { id: 'AO0', name: '比例阀速度给定（AO 0.0）', area: 'holding', address: 0, dataType: 'uint16', unit: '%', writable: true },
  { id: 'AO1', name: '伺服速度给定（AO 0.1）', area: 'holding', address: 1, dataType: 'uint16', unit: '%', writable: true }
];

export const DEFAULT_SIM_RULES: readonly SimRule[] = [
  { target: 'X0', expr: 'Y0' },
  { target: 'X1', expr: 'Y1' },
  { target: 'X2', expr: 'Y2' },
  { target: 'X3', expr: 'Y3 && !X11' },
  { target: 'X4', expr: 'Y4' },
  { target: 'X5', type: 'timer', when: 'Y4', delayMs: 500 },
  { target: 'X6', expr: 'Y6' },
  { target: 'X7', expr: 'Y7' },
  { target: 'X9', expr: 'Y8' },
  { target: 'X14', type: 'latch', set: 'X9', reset: 'X10' },
  { target: 'Y5', expr: 'X0 && X1 && X2 && X3 && X5 && X8 && !X9' }
];

export function createSimulatorConfig(): PlcConfig {
  return {
    kind: 'sim',
    points: COMMISSION_POINTS.map((point) => ({ ...point })),
    pollMs: 100,
    rules: DEFAULT_SIM_RULES.map((rule) => ({ ...rule })),
    initialValues: {
      X8: true,
      X11: false,
      X12: true,
      X13: false,
      X10: false,
      AI0: 620,
      AI1: 120,
      AO0: 0,
      AO1: 0
    }
  };
}

const powerReady = (values: Record<string, boolean | number>): string | null => (
  values.X0 === true ? null : '主回路未闭合'
);

const supplyReady = (values: Record<string, boolean | number>): string | null => (
  values.X1 === true ? null : '24V 电源未建立'
);

const plcReady = (values: Record<string, boolean | number>): string | null => (
  values.X2 === true ? null : 'PLC 未进入 RUN'
);

const airReady = (values: Record<string, boolean | number>): string | null => (
  values.X3 === true ? null : '气源压力未建立'
);

const homeReady = (values: Record<string, boolean | number>): string | null => (
  values.X4 === true ? null : '回原点未完成'
);

export const POWER_UP_STEPS: readonly Step[] = [
  {
    id: 'power.main',
    name: '1. 主回路',
    action: 'set',
    point: 'Y0',
    value: true
  },
  {
    id: 'power.24v',
    name: '2. 24V 电源',
    precondition: powerReady,
    action: 'set',
    point: 'Y1',
    value: true
  },
  {
    id: 'power.plc',
    name: '3. PLC RUN',
    precondition: supplyReady,
    action: 'set',
    point: 'Y2',
    value: true
  },
  {
    id: 'power.air',
    name: '4. 气源',
    precondition: plcReady,
    action: 'set',
    point: 'Y3',
    value: true
  },
  {
    id: 'power.home',
    name: '5. 回原点',
    precondition: airReady,
    action: 'set',
    point: 'Y4',
    value: true
  },
  {
    id: 'power.ready',
    name: '6. 就绪',
    precondition: homeReady,
    action: 'wait',
    point: 'Y5',
    expect: true,
    timeoutMs: 3000
  }
];

const readyPrecondition = (values: Record<string, boolean | number>): string | null => (
  values.Y5 === true ? null : '设备未就绪，请先执行上电流程'
);

export const COMMISSION_CASES: readonly CommissionCase[] = [
  {
    id: 'jog',
    name: '点动',
    description: '前进电磁阀点动，前进到位信号随后闭合与释放',
    steps: [
      { id: 'jog.on', name: '点动前进', precondition: readyPrecondition, action: 'set', point: 'Y6', value: true },
      { id: 'jog.on-check', name: '前进到位', action: 'wait', point: 'X6', expect: true, timeoutMs: 1500 },
      { id: 'jog.off', name: '释放点动', action: 'set', point: 'Y6', value: false },
      { id: 'jog.off-check', name: '前进信号复位', action: 'wait', point: 'X6', expect: false, timeoutMs: 1500 }
    ]
  },
  {
    id: 'cylinder',
    name: '气缸伸出/缩回',
    description: '前进阀与后退阀互斥动作，核对两只到位开关',
    steps: [
      { id: 'cyl.extend', name: '气缸伸出', precondition: readyPrecondition, action: 'set', point: 'Y6', value: true },
      { id: 'cyl.extend-check', name: '前进到位确认', action: 'wait', point: 'X6', expect: true, timeoutMs: 1500 },
      { id: 'cyl.retract-enable', name: '关闭前进阀', action: 'set', point: 'Y6', value: false },
      { id: 'cyl.extend-reset', name: '前进信号复位', action: 'wait', point: 'X6', expect: false, timeoutMs: 1500 },
      { id: 'cyl.retract', name: '气缸缩回', action: 'set', point: 'Y7', value: true },
      { id: 'cyl.retract-check', name: '后退到位确认', action: 'wait', point: 'X7', expect: true, timeoutMs: 1500 },
      { id: 'cyl.retract-off', name: '关闭后退阀', action: 'set', point: 'Y7', value: false },
      { id: 'cyl.retract-reset', name: '后退信号复位', action: 'wait', point: 'X7', expect: false, timeoutMs: 1500 }
    ]
  },
  {
    id: 'estop',
    name: '急停链路',
    description: '急停测试继电器动作后，就绪灯熄灭、急停锁存，释放后恢复',
    steps: [
      { id: 'estop.press', name: '触发急停链路', precondition: readyPrecondition, action: 'set', point: 'Y8', value: true },
      { id: 'estop.feedback', name: '急停输入确认', action: 'wait', point: 'X9', expect: true, timeoutMs: 1500 },
      { id: 'estop.latch', name: '报警锁存确认', action: 'wait', point: 'X14', expect: true, timeoutMs: 1500 },
      { id: 'estop.ready-off', name: '就绪灯熄灭', action: 'wait', point: 'Y5', expect: false, timeoutMs: 1500 },
      { id: 'estop.release', name: '释放急停链路', action: 'set', point: 'Y8', value: false },
      { id: 'estop.feedback-reset', name: '急停输入复位', action: 'wait', point: 'X9', expect: false, timeoutMs: 1500 }
    ]
  }
];

export function findCase(id: string): CommissionCase | undefined {
  return COMMISSION_CASES.find((testCase) => testCase.id === id);
}
