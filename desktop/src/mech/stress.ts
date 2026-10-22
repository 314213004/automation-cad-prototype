export interface StressQuantity {
  label: string;
  value: number;
  unit: string;
}

export interface StressResult {
  formula: string;
  inputs: StressQuantity[];
  outputs: StressQuantity[];
  safetyFactor: number;
  pass: boolean;
  verdict: string;
}

export interface CylinderForceInput {
  bore: number;
  pressure: number;
  efficiency?: number;
  load: number;
}

export interface CylinderForceResult extends StressResult {
  push: number;
  pull: number;
  margin: number;
}

export interface CantileverInput {
  force: number;
  length: number;
  E?: number;
  width: number;
  height: number;
}

export interface CantileverResult extends StressResult {
  I: number;
  delta: number;
  stress: number;
  allowable: number;
}

export type BoltSize = 'M4' | 'M5' | 'M6' | 'M8';
export type BoltGrade = 8.8 | 10.9;

export interface BoltPreloadInput {
  size: BoltSize;
  grade: BoltGrade;
  load: number;
}

export interface BoltPreloadResult extends StressResult {
  As: number;
  F0: number;
  safety: number;
}

const BOLT_DATA: Record<BoltSize, { pitch: number; As: number }> = {
  M4: { pitch: 0.7, As: 8.78 },
  M5: { pitch: 0.8, As: 14.2 },
  M6: { pitch: 1.0, As: 20.1 },
  M8: { pitch: 1.25, As: 36.6 }
};

const BOLT_YIELD: Record<BoltGrade, number> = {
  8.8: 640,
  10.9: 940
};

function positive(value: unknown, label: string, unit: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的数值（${unit}）`);
  }
  return value;
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export function cylinderForce(input: CylinderForceInput): CylinderForceResult {
  const bore = positive(input.bore, '缸径 bore', 'mm');
  const pressure = positive(input.pressure, '压力 pressure', 'MPa');
  const efficiency = input.efficiency ?? 0.85;
  if (!Number.isFinite(efficiency) || efficiency <= 0 || efficiency > 1) {
    throw new Error('机械效率 efficiency 必须在 (0, 1] 区间内');
  }
  const load = positive(input.load, '负载 load', 'N');

  const area = (Math.PI * bore * bore) / 4;
  const push = pressure * area * efficiency;
  const pull = 0.85 * push;
  const margin = push - load;
  const safetyFactor = push / load;
  const pass = margin >= 0;

  return {
    push: round(push),
    pull: round(pull),
    margin: round(margin),
    formula:
      `F推 = p·π·D²/4·η = ${fmt(pressure)} × π × ${fmt(bore)}²/4 × ${fmt(efficiency)} = ${fmt(push)} N；` +
      `F拉 = 0.85·F推 = ${fmt(pull)} N；安全系数 = F推/F负载 = ${fmt(safetyFactor)}`,
    inputs: [
      { label: '缸径 D', value: bore, unit: 'mm' },
      { label: '工作压力 p', value: pressure, unit: 'MPa' },
      { label: '机械效率 η', value: efficiency, unit: '' },
      { label: '负载 F负载', value: load, unit: 'N' }
    ],
    outputs: [
      { label: '活塞面积 A', value: round(area), unit: 'mm²' },
      { label: '推力 F推', value: round(push), unit: 'N' },
      { label: '拉力 F拉', value: round(pull), unit: 'N' },
      { label: '推力余量', value: round(margin), unit: 'N' }
    ],
    safetyFactor: round(safetyFactor),
    pass,
    verdict: pass
      ? `推力满足负载，余量 ${fmt(margin)} N（安全系数 ${fmt(safetyFactor)}）`
      : `推力不足，缺口 ${fmt(-margin)} N（安全系数 ${fmt(safetyFactor)}）`
  };
}

export function cantileverDeflection(input: CantileverInput): CantileverResult {
  const force = positive(input.force, '集中力 force', 'N');
  const length = positive(input.length, '悬臂长度 length', 'mm');
  const E = positive(input.E ?? 70000, '弹性模量 E', 'MPa');
  const width = positive(input.width, '截面宽度 width', 'mm');
  const height = positive(input.height, '截面高度 height', 'mm');

  const I = (width * height ** 3) / 12;
  const W = (width * height ** 2) / 6;
  const delta = (force * length ** 3) / (3 * E * I);
  const stress = (force * length) / W;
  const allowable = length / 500;
  const safetyFactor = allowable / delta;
  const pass = delta <= allowable;

  return {
    I: round(I),
    delta: round(delta, 4),
    stress: round(stress),
    allowable: round(allowable),
    formula:
      `I = w·h³/12 = ${fmt(width)} × ${fmt(height)}³/12 = ${fmt(I)} mm⁴；` +
      `δ = F·L³/(3·E·I) = ${fmt(force)} × ${fmt(length)}³/(3 × ${fmt(E)} × ${fmt(I)}) = ${fmt(delta)} mm；` +
      `W = w·h²/6 = ${fmt(W)} mm³，σ = F·L/W = ${fmt(stress)} MPa；许用 δ ≤ L/500 = ${fmt(allowable)} mm`,
    inputs: [
      { label: '集中力 F', value: force, unit: 'N' },
      { label: '悬臂长度 L', value: length, unit: 'mm' },
      { label: '弹性模量 E', value: E, unit: 'MPa' },
      { label: '截面宽度 w', value: width, unit: 'mm' },
      { label: '截面高度 h', value: height, unit: 'mm' }
    ],
    outputs: [
      { label: '惯性矩 I', value: round(I), unit: 'mm⁴' },
      { label: '挠度 δ', value: round(delta, 4), unit: 'mm' },
      { label: '弯曲应力 σ', value: round(stress), unit: 'MPa' },
      { label: '许用挠度', value: round(allowable), unit: 'mm' }
    ],
    safetyFactor: round(safetyFactor),
    pass,
    verdict: pass
      ? `挠度 ${fmt(delta)} mm ≤ 许用 ${fmt(allowable)} mm，满足 L/500 要求`
      : `挠度 ${fmt(delta)} mm > 许用 ${fmt(allowable)} mm，需加大截面或缩短悬臂`
  };
}

export function boltPreload(input: BoltPreloadInput): BoltPreloadResult {
  const data = BOLT_DATA[input.size];
  if (!data) throw new Error(`不支持的螺栓规格：${String(input.size)}（仅支持 M4/M5/M6/M8）`);
  const yieldStrength = BOLT_YIELD[input.grade];
  if (!yieldStrength) throw new Error(`不支持的螺栓性能等级：${String(input.grade)}（仅支持 8.8/10.9）`);
  const load = positive(input.load, '工作负载 load', 'N');

  const As = data.As;
  const F0 = 0.7 * yieldStrength * As;
  const safety = F0 / load;
  const pass = safety >= 1.5;

  return {
    As,
    F0: round(F0),
    safety: round(safety),
    formula:
      `As(${input.size}, P=${fmt(data.pitch)}) = ${fmt(As)} mm²；σy(${input.grade}) = ${fmt(yieldStrength)} MPa；` +
      `F0 = 0.7·σy·As = 0.7 × ${fmt(yieldStrength)} × ${fmt(As)} = ${fmt(F0)} N；` +
      `安全系数 = F0/F负载 = ${fmt(safety)}（要求 ≥ 1.5）`,
    inputs: [
      { label: '螺栓规格', value: Number(input.size.slice(1)), unit: input.size },
      { label: '性能等级', value: input.grade, unit: '级' },
      { label: '工作负载 F负载', value: load, unit: 'N' }
    ],
    outputs: [
      { label: '公称应力截面积 As', value: As, unit: 'mm²' },
      { label: '预紧力 F0', value: round(F0), unit: 'N' },
      { label: '安全系数', value: round(safety), unit: '' }
    ],
    safetyFactor: round(safety),
    pass,
    verdict: pass
      ? `预紧力满足防松/防分离要求（安全系数 ${fmt(safety)}）`
      : `预紧力不足，安全系数 ${fmt(safety)} < 1.5，请升级规格或降低负载`
  };
}
