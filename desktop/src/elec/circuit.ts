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
  | 'plc'
  | 'drive'     // 变频器/伺服驱动器功率部分：电源输入 → U/V/W 输出
  | 'psu'       // 24V 开关电源：L/N → +/-
  | 'solenoid'  // 电磁阀线圈（PLC 输出驱动）
  | 'buzzer'
  | 'sensor2'   // 两线制接近/磁性开关
  | 'curtain'   // 安全光栅（OSSD 双通道）
  | 'safety'    // 安全继电器本体（输入回路/复位/电源）
  | 'module'    // 其他带端子的框式元件（驱动器控制端子等）
  | 'terminal'; // 端子排上的一个端子：两侧引脚属同一网络

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
  /** 在本机上的用途（如“进料检测”），图上写在位号下方 */
  purpose?: string;
  /**
   * 元件内部的“受控导通”路径（ERC 走线用）：PLC 晶体管输出从输出组电源 3L+ 导通到各 Q 点。
   * 只用于判断“线圈能否被驱动/切断”，图面连通性不看它。
   */
  links?: Array<{ from: string; to: string[] }>;
  /** 该触点承担停止/安全切断功能（安全继电器安全输出 13-14） */
  stopFunction?: boolean;
  /** 现场元件（经端子排进出柜） */
  field?: boolean;
  /** 端子：所属端子排与端子号 */
  terminal?: { strip: string; no: number; pe?: boolean };
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

  // 2) 主回路：三相不得互相短接，且每台电机每相都要从进线经保护元件走到
  const phases = ['L1', 'L2', 'L3'];
  for (const net of circuit.nets) {
    const phaseHits = phases.filter((phase) => net.label === phase);
    if (phaseHits.length > 1) add('error', 'PHASE_SHORT', `网络 ${net.id} 把两相及以上接在一起`, [net.id]);
  }
  const motors = devicesOfKind(circuit, 'motor');
  if (motors.length > 0) {
    for (const phase of phases) {
      if (!circuit.nets.some((net) => net.label === phase)) add('warning', 'PHASE_PATH_SUSPECT', `主回路缺少 ${phase} 进线`);
    }
  }
  /* 从电机每个相端子往回追：经三极/两极/单极元件（第 i 脚 ↔ 第 i+极数 脚）、驱动器（输出 ↔ 输入）
     一直追到带 L1/L2/L3/N 标签的进线网络。中间段网络不带标签，不能按“标签网络数”判。 */
  const dolMotors: CircuitDevice[] = [];
  for (const motor of motors) {
    const feeds = motorFeeds(circuit, motor);
    const viaDrive = feeds.some((feed) => feed.kinds.includes('drive'));
    if (!viaDrive) dolMotors.push(motor);
    feeds.forEach((feed, index) => {
      const phase = feed.label ?? phases[index] ?? `L${index + 1}`;
      if (!feed.label) {
        add('warning', 'PHASE_PATH_SUSPECT', `${phase} 从进线走不到电机 ${motor.tag}，主回路相线断开`, [phase, motor.tag]);
        return;
      }
      const missing = viaDrive
        ? [...(!feed.kinds.includes('breaker') ? ['断路器'] : [])]
        : [
          ...(!feed.kinds.includes('breaker') ? ['断路器'] : []),
          ...(!feed.kinds.includes('contactor') ? ['接触器'] : []),
          ...(devicesOfKind(circuit, 'thermal').length > 0 && !feed.kinds.includes('thermal') ? ['热继'] : [])
        ];
      if (missing.length > 0) add('warning', 'PHASE_PATH_SUSPECT', `${phase} 到电机 ${motor.tag} 没有经过${missing.join('/')}`, [phase, motor.tag]);
    });
  }

  // 3) 直接起动的电机必须有热保护，且热继常闭触点串在它所在接触器的线圈回路里
  const thermals = devicesOfKind(circuit, 'thermal');
  if (dolMotors.length > 0 && thermals.length === 0) {
    add('error', 'NO_THERMAL', '有直接起动的电机但没有热继电器，过载无法保护', dolMotors.map((m) => m.tag));
  }
  for (const thermal of thermals) {
    const contacts = circuit.devices.filter((device) => device.kind === 'nc' && device.displayTag === thermal.tag);
    if (contacts.length === 0) {
      add('error', 'THERMAL_NO_TRIP', `${thermal.tag} 的常闭触点没有串在任何线圈回路里，过载切不断`, [thermal.tag]);
      continue;
    }
    const contactor = feederOf(circuit, thermal);
    const coil = contactor ? circuit.devices.find((device) => device.kind === 'coil' && device.displayTag === contactor.tag) : undefined;
    if (!coil) continue;
    const entry = netOfPins(circuit, PIN(coil.tag, coil.pins[0] ?? 'A1'));
    if (!entry) continue;
    const excluded = new Set(contacts.map((device) => device.tag));
    if (reach(circuit, entry.id, (device) => !excluded.has(device.tag))) {
      add('error', 'THERMAL_NO_TRIP', `${thermal.tag} 的常闭触点没有串在 ${coil.displayTag ?? coil.tag} 线圈回路里，过载切不断`, [thermal.tag]);
    }
  }

  // 4) 受控负载（接触器/继电器线圈、电磁阀）：从 +24V 走到进线端，路径上必须有驱动元件与停止元件
  const coils = circuit.devices.filter((device) => device.kind === 'coil' || device.kind === 'solenoid');
  for (const coil of coils) {
    const [pinIn, pinOut] = coil.kind === 'coil' ? ['A1', 'A2'] : [coil.pins[0] ?? '1', coil.pins[1] ?? '2'];
    const a1 = netOfPins(circuit, PIN(coil.tag, pinIn));
    const a2 = netOfPins(circuit, PIN(coil.tag, pinOut));
    if (!a1 || !a2) {
      add('error', 'COIL_OPEN', `${coil.tag} 线圈 ${pinIn}/${pinOut} 没有接通`, [coil.tag]);
      continue;
    }
    if (!reach(circuit, a1.id, () => true)) {
      add('error', 'COIL_NO_PATH', `${coil.tag} 线圈从 +24V 到不了，回路断了`, [coil.tag]);
      continue;
    }
    // 拿掉所有驱动元件（常开触点、PLC 输出）后还能通电 → 线圈常得电，没有被任何东西控制
    if (reach(circuit, a1.id, (device, link) => device.kind !== 'no' && !link)) {
      add('error', 'COIL_NO_DRIVE', `${coil.tag} 线圈回路上没有常开驱动触点（启动/自锁/PLC 输出）`, [coil.tag]);
    }
    // 拿掉所有停止元件（急停/停止常闭、安全继电器安全输出）后还能通电 → 停不下来
    if (reach(circuit, a1.id, (device) => !isStopElement(circuit, device))) {
      add('error', 'NO_STOP', `${coil.tag} 线圈回路上没有常闭停止元件（急停/停止）`, [coil.tag]);
    }
    if (!onNet(circuit, PIN(coil.tag, pinOut), '0V')) {
      add('warning', 'COIL_NO_RETURN', `${coil.tag} 的 ${pinOut} 没有直接接 0V`, [coil.tag]);
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

  // 6) 三线制传感器 / 安全光栅：电源与信号都要接
  for (const sensor of [...devicesOfKind(circuit, 'sensor'), ...devicesOfKind(circuit, 'curtain')]) {
    const plus = onNet(circuit, PIN(sensor.tag, '+'), '+24V');
    const minus = onNet(circuit, PIN(sensor.tag, '-'), '0V');
    const out = sensor.kind === 'curtain'
      ? netOfPins(circuit, PIN(sensor.tag, 'OSSD1')) && netOfPins(circuit, PIN(sensor.tag, 'OSSD2'))
      : netOfPins(circuit, PIN(sensor.tag, 'OUT'));
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

/** 停止元件：急停/停止按钮的常闭触点、安全继电器的安全输出；热继常闭是保护，不算停止 */
function isStopElement(circuit: Circuit, device: CircuitDevice): boolean {
  if (device.stopFunction) return true;
  if (device.kind !== 'nc') return false;
  if (!device.displayTag) return true;
  const owner = circuit.devices.find((item) => item.tag === device.displayTag);
  return owner?.kind !== 'thermal';
}

/** 极数：多极开关元件的进/出引脚各占一半 */
function polesOf(device: CircuitDevice): number {
  return Math.max(1, Math.floor(device.pins.length / 2));
}

const POLE_KINDS = new Set<DeviceKind>(['breaker', 'contactor', 'thermal']);

/** 驱动器输入/输出引脚 */
export function drivePins(device: CircuitDevice): { inputs: string[]; outputs: string[] } {
  const outputs = device.pins.filter((pin) => pin === 'U' || pin === 'V' || pin === 'W');
  const inputs = device.pins.filter((pin) => /^(L\d?|N)$/.test(pin));
  return { inputs, outputs };
}

interface Feed {
  /** 追到的进线标签（L1/L2/L3/N），追不到为 null */
  label: string | null;
  kinds: DeviceKind[];
}

/** 从某网络往电源侧追一级：找到把它作为输出端的开关元件或驱动器 */
function traceUp(circuit: Circuit, net: CircuitNet | undefined, kinds: DeviceKind[], depth: number): Feed[] {
  if (!net) return [{ label: null, kinds }];
  if (net.label && ['L1', 'L2', 'L3', 'N'].includes(net.label)) return [{ label: net.label, kinds }];
  if (depth > 16) return [{ label: null, kinds }];
  for (const pin of net.pins) {
    const device = circuit.devices.find((item) => pin.startsWith(`${item.tag}:`) && item.pins.includes(pin.slice(item.tag.length + 1)));
    if (!device) continue;
    const name = pin.slice(device.tag.length + 1);
    if (POLE_KINDS.has(device.kind)) {
      const poles = polesOf(device);
      const index = device.pins.indexOf(name);
      if (index < poles) continue;
      const input = device.pins[index - poles];
      if (!input) continue;
      return traceUp(circuit, netOfPins(circuit, PIN(device.tag, input)), [...kinds, device.kind], depth + 1);
    }
    if (device.kind === 'drive') {
      const { inputs, outputs } = drivePins(device);
      if (!outputs.includes(name)) continue;
      const feeds = inputs.map((input) => traceUp(circuit, netOfPins(circuit, PIN(device.tag, input)), [...kinds, 'drive'], depth + 1)).flat();
      // 驱动器的相线输入（非 N）决定这一相的来源
      const phase = feeds.filter((feed) => feed.label !== 'N');
      return phase.length > 0 ? phase : feeds;
    }
  }
  return [{ label: null, kinds }];
}

/** 电机 U/V/W 每相的供电来源 */
export function motorFeeds(circuit: Circuit, motor: CircuitDevice): Feed[] {
  return motor.pins.slice(0, 3).map((pin) => {
    const feeds = traceUp(circuit, netOfPins(circuit, PIN(motor.tag, pin)), [], 0);
    return feeds.find((feed) => feed.label !== null) ?? feeds[0] ?? { label: null, kinds: [] };
  });
}

/** 某多极元件的上一级元件（例如热继的上一级接触器） */
function feederOf(circuit: Circuit, device: CircuitDevice): CircuitDevice | undefined {
  const input = device.pins[0];
  if (!input) return undefined;
  const net = netOfPins(circuit, PIN(device.tag, input));
  for (const pin of net?.pins ?? []) {
    const other = circuit.devices.find((item) => item.tag !== device.tag && pin.startsWith(`${item.tag}:`));
    if (other && POLE_KINDS.has(other.kind)) return other;
  }
  return undefined;
}

/**
 * 从 +24V 出发，只经过“开关类”元件（熔断器、常开/常闭触点、端子、PLC 输出导通）能否走到目标网络。
 * allow 返回 false 的元件/导通不走——用来判断“拿掉某类元件后是否还能通电”。
 * 线圈、灯、电机等负载不导通，避免经 0V 绕回别的线圈造成假通路。
 */
export function reach(
  circuit: Circuit,
  targetNetId: string,
  allow: (device: CircuitDevice, link: boolean) => boolean
): boolean {
  const netById = new Map(circuit.nets.map((net) => [net.id, net]));
  const netOfPin = new Map<string, string>();
  for (const net of circuit.nets) for (const pin of net.pins) netOfPin.set(pin, net.id);
  const deviceByPin = new Map<string, CircuitDevice>();
  for (const device of circuit.devices) for (const pin of device.pins) deviceByPin.set(PIN(device.tag, pin), device);
  const queue = circuit.nets.filter((net) => net.label === '+24V').map((net) => net.id);
  const seen = new Set(queue);
  const passable = new Set<DeviceKind>(['fuse', 'no', 'nc', 'terminal']);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === targetNetId) return true;
    for (const pin of netById.get(id)?.pins ?? []) {
      const device = deviceByPin.get(pin);
      if (!device) continue;
      const name = pin.slice(device.tag.length + 1);
      const next: string[] = [];
      if (passable.has(device.kind) && allow(device, false)) next.push(...device.pins.filter((other) => other !== name));
      for (const link of device.links ?? []) {
        if (link.from === name && allow(device, true)) next.push(...link.to);
      }
      for (const other of next) {
        const netId = netOfPin.get(PIN(device.tag, other));
        if (netId && !seen.has(netId)) {
          seen.add(netId);
          queue.push(netId);
        }
      }
    }
  }
  return false;
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
