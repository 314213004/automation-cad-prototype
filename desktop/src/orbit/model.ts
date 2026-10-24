/**
 * 原型装配体（滑台气缸）的参数化几何模型。纯函数，不依赖 three / DOM。
 *
 * 默认参数逐项复刻原型 app.js `buildScene()` 的坐标（底板 210×72×8、导轨 12..198、
 * 滑台中心 X=92、法兰顶 51、缸体高 56、缸径半径 4+bore·0.32、杆长 10+stroke·0.12），
 * 所以 WebGL 视图与降级的等轴测 SVG 画的是同一个装配体；区别是这里的尺寸会沿
 * 「底板 → 导轨 → 滑台 → 气缸 → 活塞杆/磁性开关」的叠放链传递：改底板厚度，上面的
 * 零件整体抬高；改滑台 X，气缸与开关一起移动。缸径/行程的视觉比例沿用原型（示意比例，
 * 不是 1:1 真实缸径），这一点在 BACKLOG 中说明。
 */
import type { Bounds3, Vec3 } from './camera.ts';
import { unionBounds } from './camera.ts';

export type Prim =
  | { type: 'box'; min: Vec3; max: Vec3; color: string }
  | { type: 'cyl'; center: [number, number]; z0: number; z1: number; r: number; color: string };

export interface PartSpec {
  id: string;
  prims: Prim[];
  bbox: Bounds3;
  /** 内置装配件 / 从标准件库插入的占位体 */
  origin: 'builtin' | 'inserted';
}

export interface Assembly {
  parts: PartSpec[];
  bounds: Bounds3;
  /** 剖切面 X（原型固定在气缸中心线） */
  sectionX: number;
}

export interface InsertedBox {
  id: string;
  x: number; y: number; z: number;
  w: number; d: number; h: number;
  color?: string;
}

export type ParamValues = Record<string, number>;
export type ParamOverrides = Record<string, ParamValues>;

export interface AssemblyInputs {
  /** 原型属性面板里的缸径 / 行程（原值，未夹紧） */
  bore: number;
  stroke: number;
  inserted: readonly InsertedBox[];
  overrides: ParamOverrides;
}

export interface ParamDef {
  key: string;
  label: string;
  unit: 'mm';
  min: number;
  max: number;
  kind: 'size' | 'position';
}

export const COLORS = {
  base: '#5a626b',
  rail: '#6b737c',
  carriage: '#7d8690',
  plate: '#747d87',
  cyl: '#8b949e',
  cap: '#7a838d',
  rod: '#a7b0b9',
  sensor: '#4a5057',
  steel: '#8c959e'
} as const;

export const BUILTIN_PARTS = ['base', 'rail', 'carriage', 'cyl', 'rod', 'sensor'] as const;
export type BuiltinPart = typeof BUILTIN_PARTS[number];

/** 内置零件可编辑参数（默认值 = 原型坐标）。气缸缸径/行程由原型自身字段驱动，不在此重复。 */
export const DEFAULT_PARAMS: Record<BuiltinPart, ParamValues> = {
  base: { length: 210, width: 72, thickness: 8 },
  rail: { length: 186, width: 24, height: 14 },
  carriage: { length: 60, width: 32, height: 22, x: 92 },
  cyl: {},
  rod: {},
  sensor: { z: 19 }
};

const BUILTIN_SCHEMA: Record<BuiltinPart, ParamDef[]> = {
  base: [
    { key: 'length', label: '长度 X', unit: 'mm', min: 50, max: 2000, kind: 'size' },
    { key: 'width', label: '宽度 Y', unit: 'mm', min: 20, max: 1000, kind: 'size' },
    { key: 'thickness', label: '厚度 Z', unit: 'mm', min: 2, max: 100, kind: 'size' }
  ],
  rail: [
    { key: 'length', label: '长度 X', unit: 'mm', min: 20, max: 2000, kind: 'size' },
    { key: 'width', label: '宽度 Y', unit: 'mm', min: 5, max: 200, kind: 'size' },
    { key: 'height', label: '高度 Z', unit: 'mm', min: 5, max: 100, kind: 'size' }
  ],
  carriage: [
    { key: 'length', label: '长度 X', unit: 'mm', min: 10, max: 500, kind: 'size' },
    { key: 'width', label: '宽度 Y', unit: 'mm', min: 10, max: 300, kind: 'size' },
    { key: 'height', label: '厚度 Z', unit: 'mm', min: 5, max: 200, kind: 'size' },
    { key: 'x', label: '位置 X', unit: 'mm', min: -1000, max: 3000, kind: 'position' }
  ],
  cyl: [],
  rod: [],
  sensor: [
    { key: 'z', label: '槽内高度', unit: 'mm', min: 0, max: 44, kind: 'position' }
  ]
};

const INSERTED_SCHEMA: ParamDef[] = [
  { key: 'w', label: '长度 X', unit: 'mm', min: 1, max: 1000, kind: 'size' },
  { key: 'd', label: '宽度 Y', unit: 'mm', min: 1, max: 1000, kind: 'size' },
  { key: 'h', label: '高度 Z', unit: 'mm', min: 1, max: 1000, kind: 'size' },
  { key: 'x', label: '位置 X', unit: 'mm', min: -1000, max: 3000, kind: 'position' },
  { key: 'y', label: '位置 Y', unit: 'mm', min: -1000, max: 3000, kind: 'position' },
  { key: 'z', label: '位置 Z', unit: 'mm', min: -1000, max: 3000, kind: 'position' }
];

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

export function isBuiltinPart(id: string): id is BuiltinPart {
  return (BUILTIN_PARTS as readonly string[]).includes(id);
}

export function paramSchema(partId: string, inputs: Pick<AssemblyInputs, 'inserted'>): ParamDef[] {
  if (isBuiltinPart(partId)) return BUILTIN_SCHEMA[partId].map((def) => ({ ...def }));
  if (inputs.inserted.some((item) => item.id === partId)) return INSERTED_SCHEMA.map((def) => ({ ...def }));
  return [];
}

/** 当前生效参数：默认值 / 插入件放置 + 覆盖。 */
export function effectiveParams(partId: string, inputs: Pick<AssemblyInputs, 'inserted' | 'overrides'>): ParamValues {
  const override = inputs.overrides[partId] ?? {};
  if (isBuiltinPart(partId)) return { ...DEFAULT_PARAMS[partId], ...override };
  const ins = inputs.inserted.find((item) => item.id === partId);
  if (!ins) return {};
  return { w: ins.w, d: ins.d, h: ins.h, x: ins.x, y: ins.y, z: ins.z, ...override };
}

/** 原型同款夹紧：缸径 12–63、行程 10–200（超范围时原型 SVG 也按夹紧值绘制）。 */
export function effectiveBore(bore: number): number {
  return clamp(Number(bore) || 32, 12, 63);
}

export function effectiveStroke(stroke: number): number {
  return clamp(Number(stroke) || 50, 10, 200);
}

export function cylinderRadius(bore: number): number {
  return 4 + effectiveBore(bore) * 0.32;
}

function bboxOf(prims: readonly Prim[]): Bounds3 {
  return unionBounds(prims.map((p) => (p.type === 'box'
    ? { min: [...p.min] as Vec3, max: [...p.max] as Vec3 }
    : { min: [p.center[0] - p.r, p.center[1] - p.r, p.z0] as Vec3, max: [p.center[0] + p.r, p.center[1] + p.r, p.z1] as Vec3 })));
}

function box(min: Vec3, max: Vec3, color: string): Prim {
  return { type: 'box', min, max, color };
}

/** 由参数生成整机几何。叠放链：底板顶 → 导轨 → 滑台 → 法兰 → 缸体 → 端盖 → 活塞杆。 */
export function buildAssembly(inputs: AssemblyInputs): Assembly {
  const base = effectiveParams('base', inputs);
  const rail = effectiveParams('rail', inputs);
  const car = effectiveParams('carriage', inputs);
  const sensor = effectiveParams('sensor', inputs);

  const baseL = base.length as number, baseW = base.width as number, baseT = base.thickness as number;
  const cy = baseW / 2;
  const railL = rail.length as number, railW = rail.width as number, railH = rail.height as number;
  const railX0 = (baseL - railL) / 2;
  const railTop = baseT + railH;
  const carL = car.length as number, carW = car.width as number, carH = car.height as number, carX = car.x as number;
  const carTop = railTop + carH;

  const r = cylinderRadius(inputs.bore);
  const flangeTop = carTop + 7;
  const bodyTop = flangeTop + 56;
  const rodTop = bodyTop + 16 + effectiveStroke(inputs.stroke) * 0.12;
  const rodR = Math.max(3.2, r * 0.34);
  const sensorZ = flangeTop + (sensor.z as number);

  const parts: PartSpec[] = [];
  const push = (id: string, prims: Prim[], origin: PartSpec['origin'] = 'builtin'): void => {
    parts.push({ id, prims, bbox: bboxOf(prims), origin });
  };

  push('base', [box([0, 0, 0], [baseL, baseW, baseT], COLORS.base)]);
  push('rail', [box([railX0, cy - railW / 2, baseT], [railX0 + railL, cy + railW / 2, railTop], COLORS.rail)]);
  push('carriage', [box([carX - carL / 2, cy - carW / 2, railTop], [carX + carL / 2, cy + carW / 2, carTop], COLORS.carriage)]);
  push('cyl', [
    box([carX - 20, cy - 20, carTop], [carX + 20, cy + 20, flangeTop], COLORS.plate),
    { type: 'cyl', center: [carX, cy], z0: flangeTop, z1: bodyTop, r, color: COLORS.cyl },
    { type: 'cyl', center: [carX, cy], z0: bodyTop, z1: bodyTop + 6, r: r * 0.86, color: COLORS.cap }
  ]);
  push('rod', [{ type: 'cyl', center: [carX, cy], z0: bodyTop + 6, z1: rodTop, r: rodR, color: COLORS.rod }]);
  push('sensor', [box([carX - 4, cy + r - 3, sensorZ], [carX + 6, cy + r + 4, sensorZ + 12], COLORS.sensor)]);

  for (const ins of inputs.inserted) {
    const p = effectiveParams(ins.id, inputs);
    const x = p.x as number, y = p.y as number, z = p.z as number;
    push(ins.id, [box([x, y, z], [x + (p.w as number), y + (p.d as number), z + (p.h as number)], ins.color ?? COLORS.steel)], 'inserted');
  }

  return { parts, bounds: unionBounds(parts.map((p) => p.bbox)), sectionX: carX };
}

export type EditResult =
  | { ok: true; overrides: ParamOverrides; value: number }
  | { ok: false; message: string };

/**
 * 校验并应用一次属性编辑，返回新的覆盖表（不修改入参）。
 * 除单项范围外，还做装配合理性校验：导轨不超出底板、滑台不脱出导轨。
 */
export function applyParamEdit(inputs: AssemblyInputs, partId: string, key: string, raw: unknown): EditResult {
  const schema = paramSchema(partId, inputs);
  const def = schema.find((item) => item.key === key);
  if (!def) return { ok: false, message: `零件「${partId}」没有可编辑参数「${key}」` };
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const value = typeof text === 'number' ? text : (text === '' || text === null || text === undefined ? NaN : Number(text));
  if (!Number.isFinite(value)) return { ok: false, message: `${def.label}必须是数字` };
  if (value < def.min || value > def.max) {
    return { ok: false, message: `${def.label}超出范围（${def.min}–${def.max} ${def.unit}）` };
  }
  const overrides: ParamOverrides = {};
  Object.entries(inputs.overrides).forEach(([id, values]) => { overrides[id] = { ...values }; });
  overrides[partId] = { ...(overrides[partId] ?? {}), [key]: value };
  const next: AssemblyInputs = { ...inputs, overrides };

  const violation = assemblyViolation(next);
  if (violation) return { ok: false, message: violation };
  return { ok: true, overrides, value };
}

/**
 * 装配合理性校验（导轨不超出底板、滑台不脱出导轨）。合法返回 null，否则返回中文原因。
 * 编辑校验与「从工程存储恢复」共用，保证落盘数据被手改坏时不会画出脱轨的装配。
 */
export function assemblyViolation(inputs: Pick<AssemblyInputs, 'inserted' | 'overrides'>): string | null {
  const base = effectiveParams('base', inputs);
  const rail = effectiveParams('rail', inputs);
  const car = effectiveParams('carriage', inputs);
  if ((rail.length as number) > (base.length as number)) {
    return `导轨长度 ${rail.length} mm 不能超过底板长度 ${base.length} mm`;
  }
  if ((rail.width as number) > (base.width as number)) {
    return `导轨宽度 ${rail.width} mm 不能超过底板宽度 ${base.width} mm`;
  }
  const railX0 = ((base.length as number) - (rail.length as number)) / 2;
  const railX1 = railX0 + (rail.length as number);
  const carHalf = (car.length as number) / 2;
  const carX = car.x as number;
  if ((car.length as number) > (rail.length as number)) {
    return `滑台长度 ${car.length} mm 不能超过导轨长度 ${rail.length} mm`;
  }
  if (carX - carHalf < railX0 - 1e-9 || carX + carHalf > railX1 + 1e-9) {
    const lo = railX0 + carHalf, hi = railX1 - carHalf;
    return `滑台会脱出导轨：位置 X 需在 ${round1(lo)}–${round1(hi)} mm`;
  }
  return null;
}

/** 清除某零件的全部覆盖（恢复原型默认尺寸 / 放置）。 */
export function resetPartOverrides(overrides: ParamOverrides, partId: string): ParamOverrides {
  const out: ParamOverrides = {};
  Object.entries(overrides).forEach(([id, values]) => { if (id !== partId) out[id] = { ...values }; });
  return out;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/* ------------------------------------------------------------ 插入件放置复刻 */

/** 原型 app.js `SCENE_OCCUPANCY`（静态常量）。 */
export const PROTO_SCENE_OCCUPANCY: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 0, 210, 72, 8],
  [12, 24, 8, 198, 48, 22],
  [62, 20, 22, 122, 52, 44],
  [72, 16, 44, 112, 56, 51],
  [77.8, 21.8, 51, 106.2, 50.2, 107],
  [86.8, 30.8, 113, 97.2, 41.2, 122],
  [88, 50, 70, 98, 60, 82]
];

type Aabb = readonly [number, number, number, number, number, number];

function overlaps(a: Aabb, b: Aabb): boolean {
  return a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2];
}

/**
 * 复刻原型 `findFreePlacement()`：原型不导出插入件坐标，但放置算法是确定性的，
 * 按插入顺序依次计算即可得到与原型 SVG 完全一致的坐标（撤销/重做是后进先出，顺序不变）。
 */
export function replicatePlacements(ids: readonly string[]): Array<Omit<InsertedBox, 'color'>> {
  const placed: Array<Omit<InsertedBox, 'color'>> = [];
  const w = 20, d = 20, h = 20;
  for (const id of ids) {
    const occupied: Aabb[] = PROTO_SCENE_OCCUPANCY.slice();
    placed.forEach((p) => occupied.push([p.x, p.y, p.z, p.x + p.w, p.y + p.d, p.z + p.h]));
    let found: Omit<InsertedBox, 'color'> | null = null;
    for (let row = 0; row < 5 && !found; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const c = { x: 4 + col * 40, y: 2 + row * 14, z: 8 };
        const bounds: Aabb = [c.x, c.y, c.z, c.x + w, c.y + d, c.z + h];
        if (!occupied.some((item) => overlaps(bounds, item))) {
          found = { id, ...c, w, d, h };
          break;
        }
      }
    }
    if (!found) {
      const index = placed.length;
      found = { id, x: 4 + (index % 5) * 40, y: 2 + (Math.floor(index / 5) % 5) * 14, z: 8 + Math.floor(index / 25) * h, w, d, h };
    }
    placed.push(found);
  }
  return placed;
}
