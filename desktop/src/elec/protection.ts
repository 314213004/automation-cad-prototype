/**
 * 电机保护选型（供电气图与 BOM 共用）。
 *
 * 只做两件有依据的事：
 * 1) 由功率算额定电流 I = P / (√3 · U · cosφ · η)，cosφ·η 取 0.8；
 * 2) 按电流落到常规档位（iC65N C 曲线 / LC1D / LRD）。
 * 型号仍标 estimated —— 档位是算的，具体订货型号要按样本核对。
 */

export interface ProtectionSelection {
  currentA: number;
  breaker: string;
  contactor: string;
  thermal: string;
  /** 热继整定值：必须落在所选档的范围内 */
  thermalSetA: number;
}

const BREAKER_STEPS: Array<{ upTo: number; model: string }> = [
  { upTo: 1, model: 'iC65N 3P C1' },
  { upTo: 2, model: 'iC65N 3P C2' },
  { upTo: 4, model: 'iC65N 3P C4' },
  { upTo: 6.3, model: 'iC65N 3P C6' },
  { upTo: 10, model: 'iC65N 3P C10' },
  { upTo: 16, model: 'iC65N 3P C16' },
  { upTo: 25, model: 'iC65N 3P C25' }
];

const CONTACTOR_STEPS: Array<{ upTo: number; model: string }> = [
  { upTo: 7, model: 'LC1D09' },
  { upTo: 12, model: 'LC1D12' },
  { upTo: 18, model: 'LC1D18' },
  { upTo: 25, model: 'LC1D25' }
];

const THERMAL_STEPS: Array<{ upTo: number; model: string }> = [
  // 0.1 A 以下也要有能整定的档：LRD01 起 0.1–0.16 A，不能用 0.63–1 A 的 LRD05
  { upTo: 0.16, model: 'LRD01 · 0.1–0.16A' },
  { upTo: 0.25, model: 'LRD02 · 0.16–0.25A' },
  { upTo: 0.4, model: 'LRD03 · 0.25–0.4A' },
  { upTo: 0.63, model: 'LRD04 · 0.4–0.63A' },
  { upTo: 1, model: 'LRD05 · 0.63–1A' },
  { upTo: 1.6, model: 'LRD06 · 1–1.6A' },
  { upTo: 2.5, model: 'LRD07 · 1.6–2.5A' },
  { upTo: 4, model: 'LRD08 · 2.5–4A' },
  { upTo: 6, model: 'LRD10 · 4–6A' },
  { upTo: 8, model: 'LRD12 · 5.5–8A' },
  { upTo: 13, model: 'LRD16 · 9–13A' },
  { upTo: 18, model: 'LRD21 · 12–18A' }
];

function pick(steps: Array<{ upTo: number; model: string }>, currentA: number, fallback: string): string {
  for (const step of steps) {
    if (currentA <= step.upTo) return step.model;
  }
  return fallback;
}

export function selectMotorProtection(powerKw: number): ProtectionSelection {
  const safePower = Number.isFinite(powerKw) && powerKw > 0 ? powerKw : 0.37;
  const currentA = Math.round(((safePower * 1000) / (1.732 * 380 * 0.8)) * 10) / 10;
  const thermal = pick(THERMAL_STEPS, currentA, 'LRD21 · 12–18A');
  // 整定值夹到所选档的下限，避免出现「0.1 A 整定却选 0.63–1 A 档」这种矛盾
  const lower = Number((thermal.match(/([\d.]+)–/)?.[1]) ?? 0);
  const thermalSetA = Math.max(lower, Math.round(currentA * 10) / 10);
  return {
    currentA,
    breaker: pick(BREAKER_STEPS, currentA, 'iC65N 3P C25'),
    contactor: pick(CONTACTOR_STEPS, currentA, 'LC1D25'),
    thermal,
    thermalSetA
  };
}

/** 元件明细表的行（代号 / 名称 / 数量），顺序与图纸阅读顺序一致 */
export function protectionRows(protection: ProtectionSelection, options: { sensors: number }): Array<[string, string, string]> {
  return [
    ['-QF1', '断路器', '1'],
    ['-KM1', '接触器', '1'],
    ['-FR1', '热继电器', '1'],
    ['-M1', '减速电机', '1'],
    ['-SB1', '急停按钮', '1'],
    ['-SB2', '启动按钮', '1'],
    ['-SB3', '停止按钮', '1'],
    // 自锁用 -KM1 自身辅助触点，不再需要中间继电器
    ['-A1', 'PLC', '1'],
    ...(options.sensors > 0 ? ([['-PE1 ~ -PE' + options.sensors, '光电传感器', String(options.sensors)]] as Array<[string, string, string]>) : []),
    ['-HL1', '运行指示灯', '1'],
    ['-X1', '端子排', '1'],
    ['-FU1', '熔断器 6A', '1']
  ];
  void protection;
}
