/**
 * 通用电气描述层（机型无关）。
 *
 * 任何机器的电气原理图都从这一份数据出发：
 *   工程 / 机型方案 ──适配器──→ ElecDesign ──build──→ Circuit ──ERC──→ 版面（分页）──自检──→ SVG
 *
 * 这里只描述“机器上有什么电气负载/信号、怎么保护、怎么起停”，不出现任何机型名词；
 * 换一台机器只是换一份 ElecDesign，管线里没有任何机型特判。
 */

/** 电机起动/驱动方式 */
export type MotorStarter = 'dol' | 'vfd' | 'servo';

export interface ElecMotor {
  /** 稳定 id（适配器给，用于把 PLC 输出点关联到这台电机） */
  id: string;
  /** 元件名，如“减速电机”“伺服电机” */
  name: string;
  /** 在机器上的用途，如“皮带驱动”“工位1旋转轴” */
  purpose?: string;
  starter: MotorStarter;
  powerKw: number;
  /** 电机规格补充（转速/速比等），写在图上 */
  spec?: string;
  motorModel?: string;
  /** 变频器/伺服驱动器型号（starter≠dol 时） */
  driveModel?: string;
  /** 支路断路器型号（缺省按电流选） */
  breakerModel?: string;
}

/** PLC 输入点的现场器件 */
export type InputDevice =
  | 'photoelectric' // 三线制光电
  | 'proximity'     // 三线制接近
  | 'pressure'      // 三线制压力开关
  | 'proximity-2w'  // 两线制接近/磁性开关
  | 'button-no'     // 按钮/开关常开触点
  | 'button-nc'     // 按钮/开关常闭触点
  | 'safety-status'; // 安全继电器状态反馈（柜内，接安全继电器 Y32）

export interface ElecInput {
  id: string;
  device: InputDevice;
  /** 三线制传感器输出极性，缺省 PNP */
  output?: 'pnp' | 'npn';
  purpose: string;
  model?: string;
  /** PLC 地址，缺省自动分配 */
  address?: string;
  /** IO 表点位名（原样带进导出） */
  point?: string;
  /** 按钮角色：起停方式为 plc 时用来识别起/停按钮 */
  role?: 'start' | 'stop' | 'reset' | 'other';
  /** safety-status 指向的安全功能：'estop' 或光栅 id */
  safetyOf?: string;
}

/** PLC 输出点驱动的负载 */
export type OutputDevice =
  | 'valve'     // 电磁阀线圈
  | 'lamp'      // 指示灯
  | 'buzzer'    // 蜂鸣器
  | 'relay'     // 中间继电器线圈
  | 'motor-run'; // 电机运行：直启→接触器线圈，变频→运行端子，伺服→使能/启动端子

export interface ElecOutput {
  id: string;
  device: OutputDevice;
  purpose: string;
  model?: string;
  address?: string;
  point?: string;
  /** device=motor-run 时关联的电机 id */
  motorId?: string;
}

export interface ElecCurtain {
  id: string;
  name: string;
  model?: string;
  purpose?: string;
}

export interface ElecSafety {
  /** 急停按钮数量（IEC 60204-1 要求至少 1 个；0 时 ERC 会拒绝驱动受控负载） */
  estops: number;
  /** 安全光栅（OSSD 双通道），每套配一只安全继电器 */
  curtains: ElecCurtain[];
  /** 急停是否经安全继电器（双通道）；有光栅时自动为 true */
  relay: boolean;
  relayModel?: string;
  curtainRelayModel?: string;
}

export interface ElecDesign {
  project: string;
  /** 图号（每页图号相同，页码 n/N 由分页给出） */
  drawingNo: string;
  /** 数据来源说明，写进说明栏 */
  source: string;
  supply: { mainBreakerModel?: string };
  plc: { model: string; spec?: string };
  psu: { model: string; watts?: number };
  motors: ElecMotor[];
  inputs: ElecInput[];
  outputs: ElecOutput[];
  safety: ElecSafety;
  /**
   * 起停方式：
   *  hardwired 起保停硬接线（只控直接起动电机；其余负载仍走 PLC）；
   *  plc       起/停按钮进 PLC，由 PLC 输出驱动；
   *  none      无起停按钮（上电后由 PLC 程序控制）。
   */
  startStop: 'hardwired' | 'plc' | 'none';
  notes: string[];
  date?: string;
  designer?: string;
}

export interface DesignIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/* ------------------------------------------------------------------ 地址 */

/** 西门子风格地址 I0.0…I0.7、I1.0…；已占用的跳过 */
export function nextAddress(prefix: 'I' | 'Q', used: Set<string>): string {
  for (let byte = 0; byte < 64; byte += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const address = `${prefix}${byte}.${bit}`;
      if (!used.has(address)) {
        used.add(address);
        return address;
      }
    }
  }
  throw new Error(`${prefix} 地址用尽`);
}

const SAFE_ADDRESS = /^[IQ]\d{1,3}\.[0-7]$/;

function addressOrder(address: string): number {
  const match = /^[IQ](\d+)\.(\d)$/.exec(address);
  return match ? Number(match[1]) * 8 + Number(match[2]) : 1e6;
}

/**
 * 规整化：补齐起停按钮、电机运行输出、PLC 地址；返回规整后的副本与设计层问题。
 * 规则只看 ElecDesign 的字段，不看机型。
 */
export function normalizeElecDesign(input: ElecDesign): { design: ElecDesign; issues: DesignIssue[] } {
  const issues: DesignIssue[] = [];
  const design: ElecDesign = {
    ...input,
    motors: input.motors.map((motor) => ({ ...motor })),
    inputs: input.inputs.map((item) => ({ ...item })),
    outputs: input.outputs.map((item) => ({ ...item })),
    safety: { ...input.safety, curtains: input.safety.curtains.map((item) => ({ ...item })) },
    notes: [...input.notes]
  };
  if (design.safety.curtains.length > 0) design.safety.relay = true;
  if (design.safety.estops < 1) {
    issues.push({ severity: 'warning', code: 'NO_ESTOP', message: '设计里没有急停按钮：IEC 60204-1 要求至少 1 个，受控负载将无法通过 ERC' });
  }

  // 起停方式 hardwired 只对直接起动电机有意义；没有直启电机时退化为 plc
  const dol = design.motors.filter((motor) => motor.starter === 'dol');
  if (design.startStop === 'hardwired' && dol.length === 0) {
    design.startStop = 'plc';
    issues.push({ severity: 'warning', code: 'STARTSTOP_NO_DOL', message: '没有直接起动电机，起保停硬接线无对象，改为起/停按钮进 PLC' });
  }
  if (design.startStop === 'plc') {
    if (!design.inputs.some((item) => item.role === 'stop')) {
      design.inputs.push({ id: 'btn-stop', device: 'button-nc', purpose: '停止', role: 'stop' });
    }
    if (!design.inputs.some((item) => item.role === 'start')) {
      design.inputs.push({ id: 'btn-start', device: 'button-no', purpose: '启动', role: 'start' });
    }
  }

  // 每台由 PLC 控制的电机都要有一个运行输出
  for (const motor of design.motors) {
    const hardwired = design.startStop === 'hardwired' && motor.starter === 'dol';
    const has = design.outputs.some((item) => item.device === 'motor-run' && item.motorId === motor.id);
    if (hardwired && has) {
      design.outputs = design.outputs.filter((item) => !(item.device === 'motor-run' && item.motorId === motor.id));
      issues.push({ severity: 'warning', code: 'MOTOR_RUN_HARDWIRED', message: `${motor.name} 为起保停硬接线，PLC 运行输出不再接线` });
    }
    if (!hardwired && !has) {
      const verb = motor.starter === 'dol' ? '运行' : motor.starter === 'vfd' ? '变频运行' : '伺服使能';
      design.outputs.push({ id: `run-${motor.id}`, device: 'motor-run', motorId: motor.id, purpose: `${motor.purpose ?? motor.name}${verb}` });
    }
  }
  for (const output of design.outputs) {
    if (output.device === 'motor-run' && !design.motors.some((motor) => motor.id === output.motorId)) {
      issues.push({ severity: 'error', code: 'OUTPUT_NO_MOTOR', message: `输出 ${output.purpose} 关联的电机 ${output.motorId ?? '?'} 不存在` });
    }
  }
  for (const item of design.inputs) {
    if (item.device === 'safety-status' && item.safetyOf !== 'estop' && !design.safety.curtains.some((curtain) => curtain.id === item.safetyOf)) {
      // 安全状态点找不到对应安全功能：归到急停安全继电器
      item.safetyOf = 'estop';
    }
  }
  if (design.inputs.some((item) => item.device === 'safety-status' && item.safetyOf === 'estop') && !design.safety.relay) {
    design.safety.relay = true;
  }

  // 输入极性：同一输入组公共端只能接一种电位
  const polarities = new Set(design.inputs
    .filter((item) => item.device === 'photoelectric' || item.device === 'proximity' || item.device === 'pressure')
    .map((item) => item.output ?? 'pnp'));
  if (polarities.size > 1) {
    issues.push({ severity: 'warning', code: 'SENSOR_POLARITY_MIXED', message: 'PNP/NPN 传感器混用：同一输入公共端只能接一种电位，NPN 已按 PNP 出图，请换型' });
    for (const item of design.inputs) if (item.output === 'npn') item.output = 'pnp';
  }

  // 地址：给定的先占用，非法/重复的重新分配
  const used = new Set<string>();
  for (const list of [design.inputs, design.outputs] as const) {
    for (const item of list) {
      const prefix = list === design.inputs ? 'I' : 'Q';
      const address = item.address?.trim();
      if (address && SAFE_ADDRESS.test(address) && address.startsWith(prefix) && !used.has(address)) {
        used.add(address);
        item.address = address;
      } else {
        if (address) issues.push({ severity: 'warning', code: 'ADDRESS_REASSIGNED', message: `${item.purpose} 的地址 ${address} 不合法或重复，已重新分配` });
        delete item.address;
      }
    }
  }
  for (const item of design.inputs) if (!item.address) item.address = nextAddress('I', used);
  for (const item of design.outputs) if (!item.address) item.address = nextAddress('Q', used);
  // 按地址排序：IO 页按地址顺序成列
  design.inputs.sort((a, b) => addressOrder(a.address ?? '') - addressOrder(b.address ?? ''));
  design.outputs.sort((a, b) => addressOrder(a.address ?? '') - addressOrder(b.address ?? ''));
  return { design, issues };
}
