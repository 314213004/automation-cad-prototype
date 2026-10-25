/**
 * 标准件 → 3D 代理体尺寸。
 *
 * 库里的 `specs` 是给人看的中文字符串（"15 mm"、"1000 mm（样本 ≤4000 mm 定制）"），
 * 而且是逐品类自由格式。这里按「品类 → 取值规则」抽成可建模的尺寸，
 * 抽不到就退回保守默认值并标记 `estimated`，绝不静默编出一个精确数。
 *
 * 单位统一 mm（与 STEP 导入一致）。
 */

export type ProxyShape = 'box' | 'cylinder';

export interface PartDims {
  shape: ProxyShape;
  /** 包围盒 X/Y/Z（mm）；圆柱体 X=Y=直径 */
  /**
   * 包围盒 [X, Y, Z]，统一约定：**X = 长边、Z = 贴合方向（厚度/端面）**。
   * 这样"沿命中面法向对齐"（把 +Z 转到法向）就等于把零件贴在面上，导轨/型材不会立起来。
   */
  size: [number, number, number];
  /** 圆柱直径（mm），box 为 null */
  diameter: number | null;
  /** 是否含估算值（库里没有几何或没有该字段） */
  estimated: boolean;
  /** 从哪个字段取到的，便于在 UI 里显示「来源」 */
  source: string;
}

interface RawPart {
  id?: unknown;
  model?: unknown;
  category?: unknown;
  specs?: unknown;
}

const DEFAULT_SIZE: [number, number, number] = [40, 40, 40];

/** "15 mm" / "40×40" / "1000 mm（样本 ≤4000 mm 定制）" → 数值（首个数） */
export function parseMm(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  // 先取「数字 + mm」，取不到再退化成第一个数字；"40×40" 取第一个 40
  const withUnit = value.match(/(\d+(?:\.\d+)?)\s*mm/i);
  const anyNumber = value.match(/(\d+(?:\.\d+)?)/);
  const matched = withUnit?.[1] ?? anyNumber?.[1];
  if (!matched) return null;
  const number = Number(matched);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** "40×40" → [40, 40] */
export function parseSection(value: unknown): [number, number] | null {
  if (typeof value !== 'string') return null;
  const matched = value.match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
  if (!matched) return null;
  const a = Number(matched[1]);
  const b = Number(matched[2]);
  return a > 0 && b > 0 ? [a, b] : null;
}

function spec(specs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = specs[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function box(size: [number, number, number], estimated: boolean, source: string): PartDims {
  return { shape: 'box', size, diameter: null, estimated, source };
}

function cylinder(diameter: number, length: number, estimated: boolean, source: string): PartDims {
  // 轴线沿 X：X = 长度，Y/Z = 直径
  return { shape: 'cylinder', size: [length, diameter, diameter], diameter, estimated, source };
}

/**
 * 按 `specs.type` 优先、`category` 兜底决定代理体。
 * 每个分支都写下取值依据；缺字段时才标记 estimated。
 */
export function dimsForPart(part: RawPart): PartDims {
  const specs = (typeof part.specs === 'object' && part.specs !== null ? part.specs : {}) as Record<string, unknown>;
  const type = String(spec(specs, 'type') ?? '').toLowerCase();
  const category = String(part.category ?? '');

  // 直线导轨：轨宽定截面，长度按样本（未给则 1000）
  if (type === 'rail' || category.includes('导轨')) {
    const width = parseMm(spec(specs, 'railWidth', 'width', '轨宽'));
    const length = parseMm(spec(specs, 'length', '长度'));
    if (width) {
      const h = Math.round(width * 0.72 * 10) / 10;
      // X=导轨长度，Y=轨宽，Z=轨高（贴合方向）
      return box([length ?? 1000, width, h], length === null, 'railWidth/length');
    }
    return box([1000, 20, 15], true, '导轨默认 HGH20 系列外形');
  }

  // 滚珠丝杠：公称直径定圆，长度按行程（未给则 300）
  if (type === 'ballscrew' || category.includes('丝杠')) {
    const diameter = parseMm(spec(specs, 'nominalDiameter', 'diameter', '公称直径'));
    const rawLength = spec(specs, 'length', '长度');
    // "按行程定制（样本 ≤3000 mm）" 里的 3000 是上限而不是长度，不能当尺寸用
    const customizable = typeof rawLength === 'string' && /定制|按行程/.test(rawLength);
    const length = customizable ? null : parseMm(rawLength);
    return cylinder(diameter ?? 16, Math.min(length ?? 300, 4000), diameter === null || length === null, 'nominalDiameter/length');
  }

  // 气缸：缸径 + 行程
  if (category.includes('气缸') || type === 'cylinder') {
    const bore = parseMm(spec(specs, 'bore', '缸径'));
    const stroke = parseMm(spec(specs, 'stroke', '行程'));
    if (bore) {
      const total = (stroke ?? 30) + bore * 1.2;
      return cylinder(bore, Math.round(total * 10) / 10, stroke === null, 'bore/stroke');
    }
    return cylinder(32, 70, true, '气缸默认 φ32×50 外形');
  }

  // 减速机：型号里的数字就是机座号（PLE60 → 60 mm）
  if (type === 'reducer' || category.includes('减速机')) {
    const model = String(part.model ?? '');
    const frame = Number((model.match(/(\d{2,3})/) ?? [])[1]);
    const side = Number.isFinite(frame) && frame >= 40 && frame <= 300 ? frame : 80;
    return box([side, side, Math.round(side * 1.35)], !(Number.isFinite(frame) && frame >= 40), 'model 机座号');
  }

  // 联轴器：长度给定时按 0.6 估外径
  if (type === 'coupling' || category.includes('联轴器')) {
    const length = parseMm(spec(specs, 'length', '长度')) ?? 30;
    return cylinder(Math.round(length * 0.9), length, true, 'length→外径估算');
  }

  // 铝型材：截面 × 长度（6000 样本长度按 1000 展示）
  if (type === 'profile' || category.includes('型材')) {
    const section = parseSection(spec(specs, 'section', '截面'));
    const length = parseMm(spec(specs, 'length', '长度'));
    if (section) {
      const len = length && length <= 3000 ? length : 1000;
      // X=型材长度，Y/Z=截面
      return box([len, section[0], section[1]], !length || length > 3000, 'section/length');
    }
    return box([1000, 40, 40], true, '型材默认 4040');
  }

  // 伺服驱动器/电机：库里有功率没有外形
  if (category.includes('伺服') || category.includes('电机') || type === 'servo' || type === 'motor') {
    const ratedW = Number(spec(specs, 'ratedW') ?? 0);
    const side = ratedW >= 750 ? 80 : ratedW >= 400 ? 60 : 40;
    return box([side, side, Math.round(side * 2.4)], true, `ratedW=${ratedW || '?'} → 机座估算`);
  }

  // 传感器：小方块
  if (category.includes('传感器') || type === 'sensor') {
    return box([12, 12, 40], true, '传感器默认 M12 外形');
  }

  // 其余（电气、视觉、安全件…）：给一个可辨认的占位体
  return { shape: 'box', size: DEFAULT_SIZE, diameter: null, estimated: true, source: '无尺寸字段，使用 40×40×40 占位' };
}
