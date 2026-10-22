import type { StepResult } from './sequence.ts';

export interface Diagnosis {
  code: string;
  title: string;
  severity: 'error' | 'warning';
  evidence: string[];
  actions: string[];
  confidence: number;
}

export interface DiagnoseInput {
  step: StepResult;
  points: Record<string, boolean | number>;
  expected?: { point?: string; value?: unknown };
  timeoutMs?: number;
  commOk?: boolean;
}

const SENSOR_OUTPUT: Record<string, string> = {
  X0: 'Y0',
  X1: 'Y1',
  X2: 'Y2',
  X3: 'Y3',
  X4: 'Y4',
  X5: 'Y4',
  X6: 'Y6',
  X7: 'Y7',
  X9: 'Y8',
  X10: 'Y8',
  X11: 'Y3',
  X14: 'Y8'
};

function normalizePoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z]+\d+$/.test(trimmed)) return undefined;
  return trimmed.toUpperCase();
}

function parseScalar(raw: string): unknown {
  const text = raw.trim().replace(/[；;，,。]$/, '');
  if (/^true$/i.test(text) || text === '1' || /^on$/i.test(text)) return true;
  if (/^false$/i.test(text) || text === '0' || /^off$/i.test(text)) return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return undefined;
}

function parseAssignment(text: string): { point?: string; value?: unknown } {
  const match = /^\s*([A-Za-z]+\d+)\s*=\s*(.+?)\s*$/.exec(text);
  if (!match?.[1] || match[2] === undefined) return {};
  const point = normalizePoint(match[1]);
  const value = parseScalar(match[2]);
  return {
    ...(point ? { point } : {}),
    ...(value !== undefined ? { value } : {})
  };
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true' || value === 'ON') return true;
  if (value === 0 || value === '0' || value === 'false' || value === 'OFF') return false;
  return undefined;
}

function displayValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  return String(value);
}

function stepText(step: StepResult): string {
  return `${step.name} ${step.message ?? ''} ${step.actual}`;
}

function isTimeout(step: StepResult, timeoutMs?: number): boolean {
  if (/超时|timeout/i.test(stepText(step))) return true;
  return timeoutMs !== undefined && timeoutMs > 0 && step.durationMs >= timeoutMs;
}

function snapshotText(points: Record<string, boolean | number>): string {
  const entries = Object.entries(points);
  if (entries.length === 0) return '（无点位快照）';
  return entries.map(([id, value]) => `${id}=${displayValue(value)}`).join('，');
}

function hasActivePoint(points: Record<string, boolean | number>): boolean {
  return Object.values(points).some((value) => value === true || (typeof value === 'number' && value !== 0));
}

function expectedAndActual(input: DiagnoseInput): {
  point?: string;
  expected?: unknown;
  actual?: unknown;
} {
  const parsedExpected = parseAssignment(input.step.expected);
  const parsedActual = parseAssignment(input.step.actual);
  const point = normalizePoint(input.expected?.point) ?? parsedExpected.point ?? parsedActual.point;
  if (!point) return {};
  const expected = input.expected?.value !== undefined ? input.expected.value : parsedExpected.point === point ? parsedExpected.value : undefined;
  const fromPoints = input.points[point];
  const actual = fromPoints !== undefined ? fromPoints : parsedActual.point === point ? parsedActual.value : undefined;
  return {
    point,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {})
  };
}

export function diagnose(input: DiagnoseInput): Diagnosis[] {
  const { step, points } = input;
  const diagnoses: Diagnosis[] = [];
  const { point, expected, actual } = expectedAndActual(input);
  const expectedBool = toBoolean(expected);
  const actualBool = toBoolean(actual);
  const timedOut = isTimeout(step, input.timeoutMs);
  const failed = !step.pass;

  if (input.commOk === false || /读取失败|通讯|通信|连接.*(?:断开|失败)|ECONN|timeout/i.test(stepText(step))) {
    diagnoses.push({
      code: 'PLC_COMM_ERROR',
      title: 'PLC 通讯异常',
      severity: 'error',
      evidence: [
        input.commOk === false ? '通讯状态标记为不可用' : '步骤记录中出现读取失败或通讯错误',
        `阶段：${step.name}`,
        `实际：${step.actual}`,
        ...(step.message ? [`原始信息：${step.message}`] : [])
      ],
      actions: [
        '检查网线/串口连接、交换机与 PLC 电源',
        '核对 IP、端口、站号及 Modbus 从站地址',
        '重试连接并查看 PLC 通讯错误码'
      ],
      confidence: input.commOk === false ? 0.99 : 0.93
    });
  }

  const safetyEvidence: string[] = [];
  if (points.X8 === false) safetyEvidence.push('X8 安全门闭合信号为 OFF');
  if (points.X9 === true) safetyEvidence.push('X9 急停链路断开信号为 ON');
  if (points.X14 === true) safetyEvidence.push('X14 报警锁存为 ON');
  if (failed && safetyEvidence.length > 0) {
    diagnoses.push({
      code: 'SAFETY_LOOP_OPEN',
      title: '安全回路未闭合',
      severity: 'error',
      evidence: [
        ...safetyEvidence,
        `阶段：${step.name}`,
        `实际：${step.actual}`,
        '安全条件未满足时，PLC 会禁止后续输出动作'
      ],
      actions: [
        '确认安全门完全闭合且门锁开关动作',
        '复位急停按钮并检查安全继电器/安全回路供电',
        '检查 X8/X9/X14 接线与 PLC 输入指示灯'
      ],
      confidence: 0.97
    });
  }

  if (points.X6 === true && points.X7 === true) {
    diagnoses.push({
      code: 'DUAL_SENSOR',
      title: '双传感器同时触发',
      severity: 'error',
      evidence: [
        'X6 前进到位与 X7 后退到位同时为 ON',
        `Y6=${displayValue(points.Y6)}，Y7=${displayValue(points.Y7)}`,
        timedOut ? '步骤等待到位信号时超时' : '到位信号组合违反机械互斥状态',
        `阶段：${step.name}`
      ],
      actions: [
        '检查两只到位磁性开关位置是否过近或松动',
        '检查传感器线缆是否短路/共用电源串扰',
        '手动移动滑台确认两只开关不会同时点亮'
      ],
      confidence: 0.96
    });
  }

  if (failed && point?.startsWith('X') && expectedBool === true && actualBool === false) {
    const output = SENSOR_OUTPUT[point];
    if (output && points[output] === true) {
      diagnoses.push({
        code: 'POWERED_NOT_IN_POSITION',
        title: '执行元件已得电但未到位',
        severity: 'error',
        evidence: [
          `期望 ${point} 为 ON，实际为 OFF`,
          `对应输出 ${output} 已为 ON`,
          `阶段：${step.name}`,
          `实际：${step.actual}`
        ],
        actions: [
          '检查气源压力是否达到额定值（建议 ≥0.5 MPa）',
          '检查滑台/气缸机械是否卡滞或负载过大',
          '检查磁性开关安装位置、感应距离与固定螺钉'
        ],
        confidence: 0.9
      });
    } else if (output && points[output] === false) {
      diagnoses.push({
        code: 'OUTPUT_NOT_ACTUATED',
        title: '输出未动作',
        severity: 'error',
        evidence: [
          `期望 ${point} 为 ON，实际为 OFF`,
          `对应输出 ${output} 为 OFF`,
          `阶段：${step.name}`,
          `实际：${step.actual}`
        ],
        actions: [
          '用万用表检查 PLC 对应输出点是否按程序翻转',
          '检查中间继电器、接触器与端子排接线',
          '检查电磁阀线圈、插头及公共端供电'
        ],
        confidence: 0.86
      });
    }
  }

  if (failed && timedOut && !hasActivePoint(points)) {
    diagnoses.push({
      code: 'PLC_NOT_RUNNING',
      title: 'PLC 未 RUN / 程序未下载 / 输出模块故障',
      severity: 'error',
      evidence: [
        `阶段「${step.name}」等待超时`,
        `期望 ${point ?? '目标信号'}=${displayValue(expected)}，实际=${displayValue(actual)}`,
        '监控快照全部为 OFF/0，未观察到任何输出或反馈变化',
        `点位快照：${snapshotText(points)}`
      ],
      actions: [
        '确认 PLC 处于 RUN 状态且无硬件报警',
        '核对程序已下载并与当前点位表一致',
        '检查输出模块供电、保险丝及背板总线'
      ],
      confidence: 0.8
    });
  }

  if (points.X3 === false) {
    const relevant = points.Y3 === true || point === 'X3' || /气源|压力/.test(stepText(step));
    diagnoses.push({
      code: 'AIR_PRESSURE_LOW',
      title: '气源压力不足',
      severity: 'warning',
      evidence: [
        'X3 气源压力开关为 OFF',
        `Y3 气源电磁阀=${displayValue(points.Y3)}`,
        `AI0 气源压力=${displayValue(points.AI0)} kPa`,
        `阶段：${step.name}`
      ],
      actions: [
        '检查空压机与气源处理单元，确认供气压力',
        '检查气管泄漏、过滤器堵塞与减压阀设定',
        '核对 X3 压力开关设定值与接线'
      ],
      confidence: relevant ? 0.94 : 0.72
    });
  }

  if (diagnoses.length === 0) {
    diagnoses.push({
      code: 'UNCLASSIFIED',
      title: '未识别到明确故障',
      severity: 'warning',
      evidence: [
        `阶段：${step.name}`,
        `期望：${step.expected}`,
        `实际：${step.actual}`,
        ...(step.message ? [`原始信息：${step.message}`] : []),
        `点位快照：${snapshotText(points)}`
      ],
      actions: [
        '核对点位表地址与 PLC 程序中的实际映射',
        '复核本步骤期望值及传感器/执行元件接线',
        '保持现场状态后重复执行，观察点位是否变化'
      ],
      confidence: 0.3
    });
  }

  return diagnoses.sort((left, right) => right.confidence - left.confidence);
}
