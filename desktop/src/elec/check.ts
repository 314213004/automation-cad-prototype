/**
 * 电气校验规则引擎（纯函数层，不依赖 DOM）。
 *
 * 覆盖三类检查：
 * 1. 线号合规：缺号、格式、重复、同一线号跨网络/跨电位、数字线号跳号
 * 2. 功率统计：按额定功率汇总 kW/kVA、分相电流、需要系数、主断路器与进线截面建议、24V 电源余量
 * 3. 导线截面：截面缺失、载流量不足、断路器大于导线载流量
 *
 * 计算结果只依赖入参，方便单测，也便于 Agent 工具与 UI 面板共用同一套判定。
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  location: string;
  suggestion?: string;
}

export interface Wire {
  /** 线号，例如 L1 / 24V / 101 */
  no: string;
  /** 所属网络（同一电位连通的一组导体） */
  net: string;
  /** 电位：L1/L2/L3/N/PE/24V/0V 或自定义 */
  potential: string;
  from: string;
  to: string;
  sectionMm2?: number;
  currentA?: number;
}

export type Phase = '3P' | 'L1' | 'L2' | 'L3' | 'DC24';

export interface Load {
  tag: string;
  powerKw: number;
  phase: Phase;
  cosPhi?: number;
  efficiency?: number;
  quantity?: number;
}

export interface PowerOptions {
  voltage3P?: number;
  voltage1P?: number;
  voltageDc?: number;
  demandFactor?: number;
  /** 已选 24V 电源额定输出电流 */
  psuRatedA?: number;
}

export interface PowerSummary {
  totalKw: number;
  totalKva: number;
  demandKw: number;
  demandFactor: number;
  phaseCurrentA: { L1: number; L2: number; L3: number };
  maxPhaseCurrentA: number;
  /** (最大相 - 最小相) / 平均相电流 */
  unbalanceRatio: number;
  dcCurrentA: number;
  psuRequiredA: number;
  /** 24V 电源余量比例；未给额定电流时为 null */
  psuMarginRatio: number | null;
  breakerSuggestion: { ratedA: number; cableMm2: number } | null;
  findings: Finding[];
}

export interface CircuitCheck {
  wireNo: string;
  currentA: number;
  sectionMm2?: number;
  breakerA?: number;
}

export interface ElecDocument {
  wires?: Wire[];
  loads?: Load[];
  circuits?: CircuitCheck[];
  options?: PowerOptions;
}

export interface ElecCheckResult {
  findings: Finding[];
  summary: PowerSummary;
  counts: { error: number; warning: number; info: number };
}

/** 铜芯导线载流量（30℃，穿管敷设，单位 A）。 */
export const AMPACITY_TABLE: ReadonlyArray<{ mm2: number; amp: number }> = [
  { mm2: 1.5, amp: 14 },
  { mm2: 2.5, amp: 20 },
  { mm2: 4, amp: 27 },
  { mm2: 6, amp: 36 },
  { mm2: 10, amp: 50 },
  { mm2: 16, amp: 68 },
  { mm2: 25, amp: 91 },
  { mm2: 35, amp: 113 },
  { mm2: 50, amp: 135 },
  { mm2: 70, amp: 175 },
  { mm2: 95, amp: 210 }
];

/** 微型断路器/塑壳断路器标准壳架电流。 */
export const BREAKER_RATINGS: readonly number[] = [
  6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 320, 400, 630
];

const SEVERITY_WEIGHT: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function finding(
  code: string,
  severity: Severity,
  message: string,
  location: string,
  suggestion?: string
): Finding {
  return suggestion === undefined
    ? { code, severity, message, location }
    : { code, severity, message, location, suggestion };
}

export const WIRE_NO_RULES: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'phase', label: '相线 L1/L2/L3/N/PE', pattern: /^(L1|L2|L3|N|PE)$/ },
  { id: 'dc', label: '直流 24V/0V', pattern: /^(24V|0V)$/ },
  { id: 'digital', label: '数字线号 3~4 位', pattern: /^\d{3,4}$/ }
];

export function classifyWireNo(no: string): string {
  const text = (no ?? '').trim();
  const hit = WIRE_NO_RULES.find((rule) => rule.pattern.test(text));
  return hit ? hit.id : 'invalid';
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 线号合规检查。 */
export function checkWireNumbers(wires: readonly Wire[]): Finding[] {
  const findings: Finding[] = [];
  const byNo = new Map<string, Wire[]>();
  const numeric: number[] = [];

  for (const wire of wires) {
    const no = (wire.no ?? '').trim();
    const location = `${wire.from} → ${wire.to}`;
    if (!no) {
      findings.push(
        finding('WIRE_NO_MISSING', 'warning', `线号缺失：${location} 未标注线号`, location, '按接线表补号线号')
      );
      continue;
    }
    const kind = classifyWireNo(no);
    if (kind === 'invalid') {
      findings.push(
        finding(
          'WIRE_NO_FORMAT',
          'warning',
          `线号格式不合规：${no}（${location}）`,
          location,
          '改为 L1/L2/L3/N/PE、24V/0V 或 3~4 位数字线号'
        )
      );
    }
    if (kind === 'digital') numeric.push(Number(no));
    const key = no.toUpperCase();
    const list = byNo.get(key);
    if (list) list.push(wire);
    else byNo.set(key, [wire]);
  }

  for (const [no, list] of byNo) {
    const nets = [...new Set(list.map((wire) => wire.net))];
    const location = list.map((wire) => `${wire.from}→${wire.to}`).join('、');
    if (nets.length > 1) {
      findings.push(
        finding(
          'WIRE_NO_CROSS_NET',
          'error',
          `线号 ${no} 跨 ${nets.length} 个网络（${nets.join(' / ')}），存在短路或误接风险`,
          location,
          '拆分为独立线号，并核对接线表'
        )
      );
    } else if (list.length > 1) {
      findings.push(
        finding(
          'WIRE_NO_DUPLICATE',
          'warning',
          `线号 ${no} 在同一网络内重复标注 ${list.length} 次`,
          location,
          '合并为一条线，或补充分支后缀区分'
        )
      );
    }
    for (const wire of list) {
      const expected = classifyWireNo(no);
      if (expected === 'phase' && wire.potential !== no) {
        findings.push(
          finding(
            'WIRE_NO_POTENTIAL_MISMATCH',
            'error',
            `线号 ${no} 标注电位为 ${wire.potential || '未填'}，与线号语义不一致`,
            `${wire.from} → ${wire.to}`,
            '按线号规范修正电位字段'
          )
        );
      }
    }
  }

  const uniqueNumeric = [...new Set(numeric)].sort((a, b) => a - b);
  const first = uniqueNumeric[0];
  const last = uniqueNumeric[uniqueNumeric.length - 1];
  if (first !== undefined && last !== undefined && last > first) {
    const present = new Set(uniqueNumeric);
    const missing: number[] = [];
    for (let value = first; value <= last; value += 1) {
      if (!present.has(value)) missing.push(value);
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 10).join('、');
      findings.push(
        finding(
          'WIRE_NO_GAP',
          'warning',
          `数字线号跳号 ${missing.length} 个：${preview}${missing.length > 10 ? '…' : ''}`,
          `线号段 ${first}~${last}`,
          '按接线表补齐，或确认已删除的线号'
        )
      );
    }
  }

  return findings;
}

/** 按载流量选最小导线截面；超出表范围返回 null。 */
export function requiredSection(currentA: number): number | null {
  if (!Number.isFinite(currentA) || currentA <= 0) return null;
  const hit = AMPACITY_TABLE.find((row) => row.amp >= currentA);
  return hit ? hit.mm2 : null;
}

/** 已知截面的载流量；未收录返回 null。 */
export function ampacityOf(sectionMm2: number): number | null {
  const hit = AMPACITY_TABLE.find((row) => row.mm2 === sectionMm2);
  return hit ? hit.amp : null;
}

function pickBreaker(currentA: number): number | null {
  const target = currentA * 1.25;
  const hit = BREAKER_RATINGS.find((rating) => rating >= target);
  return hit === undefined ? null : hit;
}

/** 功率统计与主进线建议。 */
export function powerSummary(loads: readonly Load[], options: PowerOptions = {}): PowerSummary {
  const voltage3P = options.voltage3P ?? 380;
  const voltage1P = options.voltage1P ?? 220;
  const voltageDc = options.voltageDc ?? 24;
  const demandFactor = options.demandFactor ?? 0.8;
  const findings: Finding[] = [];

  let totalKw = 0;
  let totalKva = 0;
  let dcCurrentA = 0;
  const phaseCurrentA = { L1: 0, L2: 0, L3: 0 };

  for (const load of loads) {
    const quantity = load.quantity ?? 1;
    const cosPhi = load.cosPhi ?? 0.85;
    const efficiency = load.efficiency ?? 1;
    if (!Number.isFinite(load.powerKw) || load.powerKw < 0) {
      findings.push(
        finding('LOAD_POWER_INVALID', 'error', `负载 ${load.tag} 额定功率非法：${load.powerKw}`, load.tag, '填写铭牌功率（kW）')
      );
      continue;
    }
    if (!(quantity > 0)) {
      findings.push(
        finding('LOAD_QUANTITY_INVALID', 'warning', `负载 ${load.tag} 数量非法：${quantity}，已按 1 计`, load.tag, '核对 BOM 数量')
      );
      continue;
    }
    if (cosPhi <= 0 || cosPhi > 1) {
      findings.push(
        finding('LOAD_COSPHI_INVALID', 'warning', `负载 ${load.tag} 功率因数非法：${cosPhi}，已按 0.85 计`, load.tag, '填写 0~1 之间的功率因数')
      );
    }
    if (efficiency <= 0 || efficiency > 1) {
      findings.push(
        finding('LOAD_EFFICIENCY_INVALID', 'warning', `负载 ${load.tag} 效率非法：${efficiency}，已按 1 计`, load.tag, '填写 0~1 之间的效率')
      );
    }

    const pf = cosPhi > 0 && cosPhi <= 1 ? cosPhi : 0.85;
    const eff = efficiency > 0 && efficiency <= 1 ? efficiency : 1;
    const kw = load.powerKw * quantity;
    totalKw += kw;

    if (load.phase === 'DC24') {
      const amps = (kw * 1000) / voltageDc;
      dcCurrentA += amps;
      totalKva += kw;
      continue;
    }

    totalKva += kw / (pf * eff);
    if (load.phase === '3P') {
      const amps = (kw * 1000) / (Math.sqrt(3) * voltage3P * pf * eff);
      phaseCurrentA.L1 += amps;
      phaseCurrentA.L2 += amps;
      phaseCurrentA.L3 += amps;
    } else {
      const amps = (kw * 1000) / (voltage1P * pf * eff);
      phaseCurrentA[load.phase] += amps;
    }
  }

  for (const key of ['L1', 'L2', 'L3'] as const) {
    phaseCurrentA[key] *= demandFactor;
  }
  dcCurrentA *= demandFactor;

  const currents = [phaseCurrentA.L1, phaseCurrentA.L2, phaseCurrentA.L3];
  const maxPhase = Math.max(...currents);
  const minPhase = Math.min(...currents);
  const avgPhase = (phaseCurrentA.L1 + phaseCurrentA.L2 + phaseCurrentA.L3) / 3;
  const unbalanceRatio = avgPhase > 0 ? (maxPhase - minPhase) / avgPhase : 0;

  if (avgPhase > 0 && unbalanceRatio > 0.15) {
    findings.push(
      finding(
        'PHASE_UNBALANCE',
        'warning',
        `三相不平衡度 ${(unbalanceRatio * 100).toFixed(1)}%，超过 15%`,
        '分相电流',
        '把单相负载重新分配到电流较小的相'
      )
    );
  }

  const breakerA = maxPhase > 0 ? pickBreaker(maxPhase) : null;
  let breakerSuggestion: PowerSummary['breakerSuggestion'] = null;
  if (maxPhase > 0 && breakerA === null) {
    findings.push(
      finding('MAIN_BREAKER_TOO_LARGE', 'error', `计算电流 ${round(maxPhase, 1)}A 超出标准壳架范围`, '主进线', '改为多路进线或复核负载')
    );
  } else if (breakerA !== null) {
    const cable = requiredSection(breakerA);
    if (cable === null) {
      findings.push(
        finding('MAIN_CABLE_TOO_LARGE', 'error', `断路器 ${breakerA}A 无匹配导线截面`, '主进线', '复核主进线方案')
      );
    } else {
      breakerSuggestion = { ratedA: breakerA, cableMm2: cable };
      findings.push(
        finding(
          'MAIN_BREAKER_SUGGEST',
          'info',
          `主断路器建议 ${breakerA}A，进线建议 ≥${cable}mm² 铜芯`,
          '主进线',
          '按短路电流校验分断能力'
        )
      );
    }
  }

  const psuRequiredA = dcCurrentA * 1.2;
  let psuMarginRatio: number | null = null;
  if (options.psuRatedA !== undefined) {
    const rated = options.psuRatedA;
    if (!Number.isFinite(rated) || rated <= 0) {
      findings.push(
        finding('PSU_RATING_INVALID', 'warning', `24V 电源额定电流非法：${rated}`, '24V 电源', '填写电源铭牌输出电流')
      );
    } else {
      psuMarginRatio = (rated - psuRequiredA) / rated;
      if (psuRequiredA > rated) {
        findings.push(
          finding(
            'PSU_OVERLOAD',
            'error',
            `24V 电源不足：需 ${round(psuRequiredA)}A，已选 ${rated}A`,
            '24V 电源',
            `换 ≥${Math.ceil(psuRequiredA / 5) * 5}A 电源或分流负载`
          )
        );
      } else if (psuMarginRatio < 0.2) {
        findings.push(
          finding(
            'PSU_LOW_MARGIN',
            'warning',
            `24V 电源余量仅 ${(psuMarginRatio * 100).toFixed(1)}%，低于 20%`,
            '24V 电源',
            '预留启动冲击与扩展余量'
          )
        );
      }
    }
  }

  if (loads.length === 0) {
    findings.push(finding('NO_LOAD', 'info', '未登记负载，功率统计为空', '负载表'));
  }

  return {
    totalKw: round(totalKw, 3),
    totalKva: round(totalKva, 3),
    demandKw: round(totalKw * demandFactor, 3),
    demandFactor,
    phaseCurrentA: {
      L1: round(phaseCurrentA.L1),
      L2: round(phaseCurrentA.L2),
      L3: round(phaseCurrentA.L3)
    },
    maxPhaseCurrentA: round(maxPhase),
    unbalanceRatio: round(unbalanceRatio, 4),
    dcCurrentA: round(dcCurrentA),
    psuRequiredA: round(psuRequiredA),
    psuMarginRatio: psuMarginRatio === null ? null : round(psuMarginRatio, 4),
    breakerSuggestion,
    findings
  };
}

/** 导线截面与断路器配合校验。 */
export function checkWireSections(circuits: readonly CircuitCheck[]): Finding[] {
  const findings: Finding[] = [];
  for (const circuit of circuits) {
    const location = `线号 ${circuit.wireNo}`;
    if (!Number.isFinite(circuit.currentA) || circuit.currentA <= 0) {
      findings.push(
        finding('CIRCUIT_CURRENT_INVALID', 'warning', `${location} 工作电流非法：${circuit.currentA}`, location, '填写计算电流')
      );
      continue;
    }
    if (circuit.sectionMm2 === undefined) {
      findings.push(
        finding(
          'WIRE_SECTION_MISSING',
          'warning',
          `${location} 未标注导线截面（回路电流 ${round(circuit.currentA, 1)}A）`,
          location,
          `建议 ≥${requiredSection(circuit.currentA) ?? '95'}mm²`
        )
      );
      continue;
    }
    const amp = ampacityOf(circuit.sectionMm2);
    if (amp === null) {
      findings.push(
        finding(
          'WIRE_SECTION_UNKNOWN',
          'warning',
          `${location} 截面 ${circuit.sectionMm2}mm² 不在载流量表内`,
          location,
          `改用 ${AMPACITY_TABLE.map((row) => row.mm2).join('/')} 之一`
        )
      );
      continue;
    }
    if (amp < circuit.currentA) {
      const need = requiredSection(circuit.currentA);
      findings.push(
        finding(
          'WIRE_SECTION_UNDER',
          'error',
          `${location} 截面 ${circuit.sectionMm2}mm² 载流量 ${amp}A，小于回路电流 ${round(circuit.currentA, 1)}A`,
          location,
          need === null ? '超出单根导线范围，需并联或改走母线' : `加大到 ≥${need}mm²`
        )
      );
    }
    if (circuit.breakerA !== undefined && circuit.breakerA > amp) {
      findings.push(
        finding(
          'BREAKER_OVERSIZE',
          'error',
          `${location} 断路器 ${circuit.breakerA}A 大于导线载流量 ${amp}A，导线失去保护`,
          location,
          `断路器降到 ≤${amp}A，或导线加大到 ≥${requiredSection(circuit.breakerA) ?? 95}mm²`
        )
      );
    }
  }
  return findings;
}

/** 汇总检查：线号 + 功率 + 截面，按严重级别排序。 */
export function runElectricalCheck(doc: ElecDocument): ElecCheckResult {
  const summary = powerSummary(doc.loads ?? [], doc.options ?? {});
  const findings = [
    ...checkWireNumbers(doc.wires ?? []),
    ...summary.findings,
    ...checkWireSections(doc.circuits ?? [])
  ].sort((a, b) => SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity]);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return { findings, summary, counts };
}

/** 供 UI / 报表使用的单行摘要。 */
export function describeCheck(result: ElecCheckResult): string {
  const { counts, summary } = result;
  return `电气校验：错误 ${counts.error} · 警告 ${counts.warning} · 提示 ${counts.info}；负载 ${summary.totalKw}kW / ${summary.totalKva}kVA，最大相电流 ${summary.maxPhaseCurrentA}A`;
}
