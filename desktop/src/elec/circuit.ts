/**
 * 电路模型 + 电气规则校验（ERC）。
 *
 * 这一层不画图、不管像素，只回答两个问题：
 *   1) 这台机器在电气上需要哪些元件、怎么连（nodes/edges）；
 *   2) 这份连接在电气规则上是否自洽（ERC）。
 *
 * 出图前必须先过 ERC：有 error 就拒绝出图，把问题清单打回给调用方，
 * 而不是画一张看着完整、实际接不通的图。
 */

export type DeviceKind =
  | 'breaker'   // 三极断路器
  | 'contactor' // 三极接触器主触头
  | 'thermal'   // 三极热继电器（主回路）
  | 'motor'
  | 'fuse'
  | 'nc'        // 常闭按钮/触点
  | 'no'        // 常开按钮/触点
  | 'coil'      // 继电器/接触器线圈
  | 'lamp'
  | 'sensor'    // 三线制光电/接近
  | 'plc';

export interface CircuitDevice {
  tag: string;
  kind: DeviceKind;
  /** 元件表里的名称 */
  name: string;
  model: string;
  spec: string;
  /** 引脚名（主回路三相用 1/2 这类，控制回路用 13/14、A1/A2、+/-/OUT） */
  pins: string[];
  /** 同一物理元件的多个符号共用一个位号（如接触器主触头/辅助触点/线圈） */
  displayTag?: string;
  /** 选型来自估算 */
  estimated?: boolean;
}

export interface CircuitNet {
  id: string;
  /** 该网络的名字：L1/L2/L3/PE/+24V/0V 或自动编号 */
  label?: string;
  /** 连接点：`deviceTag:pin` */
  pins: string[];
}

export interface Circuit {
  devices: CircuitDevice[];
  nets: CircuitNet[];
  /** 主回路电源形式 */
  supply: '3ph-380' | '1ph-220';
}

export interface ErcIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** 涉及的元件/网络 */
  refs?: string[];
}

export const PIN = (device: string, pin: string): string => `${device}:${pin}`;

function netOfPins(circuit: Circuit, pin: string): CircuitNet | undefined {
  return circuit.nets.find((net) => net.pins.includes(pin));
}

function devicesOfKind(circuit: Circuit, kind: DeviceKind): CircuitDevice[] {
  return circuit.devices.filter((device) => device.kind === kind);
}

/** 某引脚是否落在给定 net label 上（如 +24V / 0V / L1） */
function onNet(circuit: Circuit, pin: string, label: string): boolean {
  const net = netOfPins(circuit, pin);
  return Boolean(net && net.label === label);
}

/**
 * 电气规则检查。
 *
 * 规则来自"这台图要能接得通、能停得下来"这两条底线，
 * 不是审美检查：审美交给布局阶段的重叠检测。
 */
export function runErc(circuit: Circuit): ErcIssue[] {
  const issues: ErcIssue[] = [];
  const add = (severity: ErcIssue['severity'], code: string, message: string, refs?: string[]): void => {
    issues.push({ severity, code, message, ...(refs ? { refs } : {}) });
  };

  // 1) 每个引脚必须且只能出现在一个网络里
  const seen = new Map<string, number>();
  for (const net of circuit.nets) {
    for (const pin of net.pins) seen.set(pin, (seen.get(pin) ?? 0) + 1);
  }
  for (const device of circuit.devices) {
    for (const pin of device.pins) {
      const key = PIN(device.tag, pin);
      const count = seen.get(key) ?? 0;
      if (count === 0) add('error', 'FLOATING_PIN', `${device.tag} 的引脚 ${pin} 没有接线`, [device.tag]);
      if (count > 1) add('error', 'PIN_MULTI_NET', `${device.tag} 的引脚 ${pin} 同时接在多个网络上`, [device.tag]);
    }
  }
  for (const net of circuit.nets) {
    for (const pin of net.pins) {
      const [tag, name] = pin.split(':');
      const device = circuit.devices.find((item) => item.tag === tag);
      if (!device) add('error', 'UNKNOWN_DEVICE', `网络 ${net.id} 引用了不存在的元件 ${tag}`, [tag ?? '']);
      else if (!name || !device.pins.includes(name)) {
        add('error', 'UNKNOWN_PIN', `网络 ${net.id} 引用了 ${tag} 不存在的引脚 ${name ?? ''}`, [tag ?? '']);
      }
    }
  }

  // 2) 主回路：三相不得互相短接，且每相都要串过断路器与接触器
  const phases = ['L1', 'L2', 'L3'];
  for (const net of circuit.nets) {
    const phaseHits = phases.filter((phase) => net.label === phase);
    if (phaseHits.length > 1) add('error', 'PHASE_SHORT', `网络 ${net.id} 把两相及以上接在一起`, [net.id]);
  }
  const phasePathOk = phases.every((phase) => {
    const mains = circuit.nets.filter((net) => net.label === phase);
    return mains.length >= 2; // 相线被断路器/接触器/热继分割后至少两段
  });
  if (!phasePathOk && devicesOfKind(circuit, 'motor').length > 0) {
    add('warning', 'PHASE_PATH_SUSPECT', '主回路相线没有被保护元件分段，检查是否漏画断路器/接触器/热继');
  }

  // 3) 电机必须有热保护，且其常闭触点串在控制回路里
  const coils = devicesOfKind(circuit, 'coil');
  const motors = devicesOfKind(circuit, 'motor');
  const thermals = devicesOfKind(circuit, 'thermal');
  if (motors.length > 0 && thermals.length === 0) {
    add('error', 'NO_THERMAL', '有电机但没有热继电器，过载无法保护', motors.map((m) => m.tag));
  }
  /* 热继的常闭触点必须真的在某个线圈的供电路径上（按图回溯，不按位号猜） */
  if (thermals.length > 0) {
    const paths = coils.map((coil) => tracePath(circuit, coil.tag));
    const hasTripContact = paths.some((path) => path.devices.some((tag) => tag.startsWith('-FR') || tag.includes('FR')));
    if (!hasTripContact) add('error', 'THERMAL_NO_TRIP', '热继的常闭触点没有串在任何线圈回路里，过载切不断', thermals.map((t) => t.tag));
  }

  // 4) 控制回路：从 +24V 回溯到线圈 A1，路径上必须有常开驱动触点和停止元件
  for (const coil of coils) {
    const a1 = netOfPins(circuit, PIN(coil.tag, 'A1'));
    const a2 = netOfPins(circuit, PIN(coil.tag, 'A2'));
    if (!a1 || !a2) {
      add('error', 'COIL_OPEN', `${coil.tag} 线圈 A1/A2 没有接通`, [coil.tag]);
      continue;
    }
    const path = tracePath(circuit, coil.tag);
    if (!path.found) {
      add('error', 'COIL_NO_PATH', `${coil.tag} 线圈从 +24V 到不了，回路断了`, [coil.tag]);
      continue;
    }
    if (!path.hasNo) add('error', 'COIL_NO_DRIVE', `${coil.tag} 线圈回路上没有常开驱动触点（启动/自锁）`, [coil.tag]);
    if (!path.hasNc) add('error', 'NO_STOP', `${coil.tag} 线圈回路上没有常闭停止元件（急停/停止）`, [coil.tag]);
    if (!onNet(circuit, PIN(coil.tag, 'A2'), '0V')) {
      add('warning', 'COIL_NO_RETURN', `${coil.tag} 的 A2 没有直接接 0V`, [coil.tag]);
    }
  }

  // 5) 24V 控制回路必须先过熔断器
  const fuses = devicesOfKind(circuit, 'fuse');
  const power24 = circuit.nets.find((net) => net.label === '+24V');
  if (coils.length > 0 && fuses.length === 0) {
    add('warning', 'NO_FUSE', '24V 控制回路没有熔断器');
  }
  if (power24 && fuses.length > 0) {
    const fuseOutput = circuit.nets.find((net) => net.pins.some((pin) => pin.startsWith(`${fuses[0]?.tag}:`)) && net.label !== '+24V');
    if (!fuseOutput) add('error', 'FUSE_OPEN', `${fuses[0]?.tag} 熔断器没有串在回路里`, [fuses[0]?.tag ?? '']);
  }

  // 6) 三线制传感器：电源与信号三根都要接
  for (const sensor of devicesOfKind(circuit, 'sensor')) {
    const plus = onNet(circuit, PIN(sensor.tag, '+'), '+24V');
    const minus = onNet(circuit, PIN(sensor.tag, '-'), '0V');
    const out = netOfPins(circuit, PIN(sensor.tag, 'OUT'));
    if (!plus) add('error', 'SENSOR_NO_SUPPLY', `${sensor.tag} 的 +24V 没有接`, [sensor.tag]);
    if (!minus) add('error', 'SENSOR_NO_RETURN', `${sensor.tag} 的 0V 没有接`, [sensor.tag]);
    if (!out) add('error', 'SENSOR_NO_SIGNAL', `${sensor.tag} 的信号线没有接`, [sensor.tag]);
  }

  // 7) PLC：L+ / M 必须供电，输入输出地址必须有唯一的接线
  for (const plc of devicesOfKind(circuit, 'plc')) {
    if (!onNet(circuit, PIN(plc.tag, 'L+'), '+24V')) add('error', 'PLC_NO_LPLUS', `${plc.tag} 的 L+ 没有接 +24V`, [plc.tag]);
    if (!onNet(circuit, PIN(plc.tag, 'M'), '0V')) add('error', 'PLC_NO_M', `${plc.tag} 的 M 没有接 0V`, [plc.tag]);
  }

  return issues;
}

export interface PowerPath {
  found: boolean;
  /** 路径经过的常开/常闭元件位号 */
  devices: string[];
  hasNo: boolean;
  hasNc: boolean;
}

/**
 * 从 +24V 母线回溯到某线圈的 A1：把每个元件当作"引脚互连"的两端来走。
 * 这样判的是图纸拓扑（是否真的串上了），而不是按位号猜。
 */
export function tracePath(circuit: Circuit, coilTag: string): PowerPath {
  const startNets = circuit.nets.filter((net) => net.label === '+24V').map((net) => net.id);
  const coilNet = netOfPins(circuit, PIN(coilTag, 'A1'));
  if (!coilNet) return { found: false, devices: [], hasNo: false, hasNc: false };
  const target = coilNet.id;
  const netById = new Map(circuit.nets.map((net) => [net.id, net]));
  const deviceByPin = new Map<string, CircuitDevice>();
  for (const device of circuit.devices) {
    for (const pin of device.pins) deviceByPin.set(PIN(device.tag, pin), device);
  }

  const queue: string[] = [...startNets];
  const seen = new Set<string>(queue);
  const devices: string[] = [];
  let hasNo = false;
  let hasNc = false;

  while (queue.length > 0) {
    const netId = queue.shift() as string;
    if (netId === target) return { found: true, devices, hasNo, hasNc };
    const net = netById.get(netId);
    if (!net) continue;
    for (const pin of net.pins) {
      const device = deviceByPin.get(pin);
      if (!device || device.kind === 'plc' || device.kind === 'sensor') continue;
      const otherPins = device.pins.filter((name) => PIN(device.tag, name) !== pin);
      for (const other of otherPins) {
        const nextNet = netOfPins(circuit, PIN(device.tag, other));
        if (!nextNet || seen.has(nextNet.id)) continue;
        seen.add(nextNet.id);
        queue.push(nextNet.id);
        devices.push(device.tag);
        if (device.kind === 'no') hasNo = true;
        if (device.kind === 'nc') hasNc = true;
      }
    }
  }
  return { found: false, devices, hasNo, hasNc };
}

export function ercSummary(issues: readonly ErcIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length
  };
}
