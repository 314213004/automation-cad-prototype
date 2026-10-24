// 机型参数化几何生成器：纯函数，无 DOM / three.js / 文件 IO。
//
// 输入 MachineConfig（或 synthMachine 返回的 MachineDesign），输出一份带真实毫米尺寸与
// 位置的参数化装配：机架（台面 + 立腿 + 下横梁）、输送线或分度转盘、每工位底板 + 门架、
// 气缸（缸体 + 活塞杆，缩回位）、夹爪（本体 + 双指，张开位）、旋转台（底座 + 台面 + 治具）、
// 传感器（接近 / 光电 / 压力）与安全光栅立柱。运动件带轴向、行程/角度、点位与时长元数据，
// 供 3D 联调动画、STL/glTF 导出与 build123d sidecar 实体化共用同一份数据。
//
// 坐标系：Z 向上、单位 mm；X 为物料流向（左 → 右），-Y 指向操作侧；原点在机架地面中心。
//
// 诚实边界：这是「按规则摆放的标准件外形」，不是结构设计。尺寸来自固定的典型值（缸径 32、
// M12 接近开关、50 方立柱等），不做强度/刚度/干涉求解、不选型号、不生成紧固件与钣金，
// 工位与输送线/转盘之间的上下料机构不建模。

import type { ActuatorConfig, MachineConfig, SensorConfig } from '../commission/machine-config.ts';
import { validateMachineConfig } from '../commission/machine-config.ts';
import type { MachineProcess, MachineSensorKind } from './spec.ts';

export type Vec3 = [number, number, number];

export type GeomShape =
  | { type: 'box'; size: Vec3 }
  | { type: 'cylinder'; radius: number; length: number; axis: 'x' | 'y' | 'z' };

export type GeomRole =
  | 'frame'
  | 'transfer'
  | 'plate'
  | 'structure'
  | 'fixture'
  | 'actuator'
  | 'sensor'
  | 'safety';

export type GeomBomGroup =
  | 'actuator:cylinder'
  | 'actuator:gripper'
  | 'actuator:rotary'
  | 'sensor:proximity'
  | 'sensor:photoelectric'
  | 'sensor:pressure'
  | 'sensor:safety'
  | 'structure';

export interface GeomPart {
  /** 全装配唯一，仅 [a-z0-9-]。 */
  id: string;
  name: string;
  role: GeomRole;
  shape: GeomShape;
  /** 形体中心，世界坐标 mm。 */
  center: Vec3;
  /** 绕自身中心、世界 Z 轴的转角（度）。 */
  rotationZDeg: number;
  color: string;
  material: string;
  bomGroup: GeomBomGroup;
  stationId?: string;
  actuatorId?: string;
  sensorPoint?: string;
  /** true 表示属于某个运动轴的随动件（活塞杆、夹指、旋转台面）。 */
  moving?: boolean;
}

export interface GeomMovingAxis {
  actuatorId: string;
  stationId: string;
  /** linear=气缸直线；gripper=夹爪双指对向；rotary=旋转台。 */
  kind: 'linear' | 'gripper' | 'rotary';
  /** 随动零件 id（gripper 为全部夹指）。 */
  partIds: string[];
  /** 世界坐标单位向量：linear 为伸出方向；gripper 为左指闭合方向；rotary 为转轴。 */
  axis: Vec3;
  /** rotary 的转轴通过点；linear/gripper 为本体安装点。 */
  pivot: Vec3;
  /** linear：全行程；gripper：双指合计行程（每指一半）。rotary 为 0。 */
  strokeMm: number;
  /** rotary：0 → rangeDeg；其余为 0。 */
  rangeDeg: number;
  home: 'retracted' | 'open' | 'zero';
  durationMs: number;
  points: { extend?: string; retract?: string; grip?: string; point?: string };
  /** gripper：每个夹指闭合时沿 axis 的符号（+1 / -1）。 */
  jaws?: { partId: string; sign: 1 | -1 }[];
}

export interface GeomFootprint {
  stationId: string;
  /** 世界坐标中心（XY，mm）。 */
  center: [number, number];
  /** 局部半宽（沿工位局部 X）与半深（沿局部 Y）。 */
  half: [number, number];
  rotationZDeg: number;
}

export interface GeomStation {
  id: string;
  name: string;
  index: number;
  /** 工位底板顶面中心（世界 mm）。 */
  origin: Vec3;
  rotationZDeg: number;
  plateSize: Vec3;
  /** 工作点（世界 mm）：门架正下方、底板中心。 */
  workPoint: Vec3;
  footprint: GeomFootprint;
  actuatorIds: string[];
  sensorPoints: string[];
}

export type GeomLayout = 'single' | 'linear' | 'dial' | 'gantry' | 'dual';

export interface MachineGeometry {
  schemaVersion: 1;
  kind: 'machine-geometry';
  machineId: string;
  name: string;
  units: 'mm';
  upAxis: 'z';
  process: MachineProcess;
  layout: GeomLayout;
  /** 外形包络（mm）：X 长 × Y 宽 × Z 高。 */
  envelope: Vec3;
  bounds: { min: Vec3; max: Vec3 };
  tableHeight: number;
  stations: GeomStation[];
  parts: GeomPart[];
  moving: GeomMovingAxis[];
  /** 结构件 BOM（机架、底板、门架、输送线等），与 bomDraft 的执行机构/传感器分开。 */
  structureBom: { name: string; spec: string; qty: number; material: string }[];
  assumptions: string[];
  warnings: string[];
}

export interface MachineGeometryOptions {
  /** 工艺；缺省从 config.id（design-<process>-Nst）推断，推断不到为 unknown。 */
  process?: MachineProcess;
  /** 强制布局；缺省按工艺与工位数选择。 */
  layout?: GeomLayout;
  /** 仅用于性能诊断：跳过结果缓存。 */
  bypassCache?: boolean;
}

/** 生产路径上同时保留的整机几何结果数；每项最多数千个零件，避免无界增长。 */
const GEOMETRY_CACHE_LIMIT = 16;
const geometryCache = new Map<string, MachineGeometry>();
let geometryCacheHits = 0;
let geometryCacheMisses = 0;
let geometryCacheEvictions = 0;

export function geometryCacheStats(): {
  size: number;
  limit: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  return {
    size: geometryCache.size,
    limit: GEOMETRY_CACHE_LIMIT,
    hits: geometryCacheHits,
    misses: geometryCacheMisses,
    evictions: geometryCacheEvictions
  };
}

export function clearGeometryCache(): void {
  geometryCache.clear();
  geometryCacheHits = 0;
  geometryCacheMisses = 0;
  geometryCacheEvictions = 0;
}

// ── 典型尺寸（mm），全部集中在此便于评审 ─────────────────────────────────────

export const GEOMETRY_DIMENSIONS = {
  tableHeight: 850,
  topPlateThickness: 20,
  legSection: 60,
  legSpanMax: 1200,
  stringerSection: 40,
  stringerHeight: 150,
  frameMargin: 60,
  stationPlateThickness: 15,
  stationPlateDepth: 300,
  stationPlateMinWidth: 320,
  stationMargin: 50,
  stationGap: 60,
  slotWidth: { cylinder: 110, gripper: 130, rotary: 170 } as Record<ActuatorConfig['kind'], number>,
  uprightSection: 50,
  beamSection: 50,
  cylinderBore: 32,
  cylinderBodyRadius: 20,
  cylinderRodRadius: 6,
  cylinderBodyExtra: 70,
  rodProtrusion: 25,
  mountBlock: 20,
  gripperBody: [64, 40, 56] as Vec3,
  gripperJaw: [12, 24, 40] as Vec3,
  gripperClosedGap: 20,
  rotaryBaseRadius: 55,
  rotaryBaseHeight: 40,
  rotaryTableRadius: 70,
  rotaryTableHeight: 12,
  fixture: [70, 70, 30] as Vec3,
  workClearance: 60,
  sensorRowInset: 30,
  safetyPostSection: 35,
  safetyPostHeight: 600,
  safetyPostOffset: 40,
  conveyorWidth: 140,
  conveyorHeight: 70,
  conveyorBeltWidth: 110,
  conveyorOverhang: 120,
  conveyorClearance: 60,
  dialIndexerSize: 260,
  dialIndexerHeight: 120,
  dialThickness: 20,
  dialMinRadius: 280,
  dialClearance: 60
} as const;

const D = GEOMETRY_DIMENSIONS;
export const DIAL_PROCESSES: ReadonlySet<MachineProcess> = new Set(['screw', 'assembly']);
export const DIAL_MAX_STATIONS = 8;

const COLORS = {
  frame: '#5c646b',
  top: '#8a949c',
  plate: '#b7c0c7',
  upright: '#6f7a83',
  conveyor: '#4b5563',
  belt: '#1f2937',
  dial: '#9aa7b2',
  cylinderBody: '#9aa7b2',
  rod: '#d7dde2',
  gripperBody: '#68747e',
  jaw: '#23b7a5',
  rotaryBase: '#59636b',
  rotaryTable: '#f59e0b',
  fixture: '#3b82f6',
  sensor: '#5d666e',
  safety: '#ef4444',
  bracket: '#7c8790'
} as const;

const PROCESSES: readonly MachineProcess[] = ['screw', 'dispense', 'assembly', 'inspection', 'packaging', 'unknown'];

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  const result = Math.round(value * scale) / scale;
  return Object.is(result, -0) ? 0 : result;
}

function roundVec(value: Vec3): Vec3 {
  return [round(value[0]), round(value[1]), round(value[2])];
}

export function geometryIdPart(value: string): string {
  const ascii = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  // 纯中文等无 ASCII 的名称：用稳定哈希保证唯一且可复现。
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `u${hash.toString(36)}`;
}

export function inferProcess(config: Pick<MachineConfig, 'id'>): MachineProcess {
  const match = /^design-([a-z]+)-\d+st/.exec(config.id);
  const candidate = match?.[1];
  return PROCESSES.find((process) => process === candidate) ?? 'unknown';
}

export function sensorKindOf(sensor: Pick<SensorConfig, 'point'>): MachineSensorKind {
  const point = sensor.point.toUpperCase();
  if (point.includes('-SAFE-')) return 'safety';
  if (point.includes('-PRS-')) return 'pressure';
  if (point.includes('-PHT-')) return 'photoelectric';
  return 'proximity';
}

export function chooseLayout(process: MachineProcess, stations: number): GeomLayout {
  if (stations <= 1) return 'single';
  if (DIAL_PROCESSES.has(process) && stations <= DIAL_MAX_STATIONS) return 'dial';
  return 'linear';
}

function rotateXY(x: number, y: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** 形体在自身局部（未旋转）坐标中的半尺寸。 */
export function shapeHalfExtents(shape: GeomShape): Vec3 {
  if (shape.type === 'box') return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
  const r = shape.radius;
  const h = shape.length / 2;
  if (shape.axis === 'x') return [h, r, r];
  if (shape.axis === 'y') return [r, h, r];
  return [r, r, h];
}

/** 零件世界轴对齐包围盒（考虑绕 Z 旋转）。 */
export function partBounds(part: Pick<GeomPart, 'shape' | 'center' | 'rotationZDeg'>): { min: Vec3; max: Vec3 } {
  const [hx, hy, hz] = shapeHalfExtents(part.shape);
  const rad = (part.rotationZDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const ex = hx * cos + hy * sin;
  const ey = hx * sin + hy * cos;
  return {
    min: [part.center[0] - ex, part.center[1] - ey, part.center[2] - hz],
    max: [part.center[0] + ex, part.center[1] + ey, part.center[2] + hz]
  };
}

/** 两个绕 Z 旋转的矩形（工位占地）是否重叠；分离轴定理，边界接触不算重叠。 */
export function footprintsOverlap(a: GeomFootprint, b: GeomFootprint, tolerance = 1e-6): boolean {
  const corners = (fp: GeomFootprint): [number, number][] =>
    ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
      const [dx, dy] = rotateXY(sx * fp.half[0], sy * fp.half[1], fp.rotationZDeg);
      return [fp.center[0] + dx, fp.center[1] + dy];
    });
  const axes = (fp: GeomFootprint): [number, number][] => [
    rotateXY(1, 0, fp.rotationZDeg),
    rotateXY(0, 1, fp.rotationZDeg)
  ];
  const ca = corners(a);
  const cb = corners(b);
  for (const [ax, ay] of [...axes(a), ...axes(b)]) {
    const project = (points: [number, number][]): [number, number] => {
      let min = Infinity;
      let max = -Infinity;
      for (const [x, y] of points) {
        const value = x * ax + y * ay;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return [min, max];
    };
    const [minA, maxA] = project(ca);
    const [minB, maxB] = project(cb);
    if (maxA <= minB + tolerance || maxB <= minA + tolerance) return false;
  }
  return true;
}

// ── 工位局部构建 ─────────────────────────────────────────────────────────────

interface LocalPart extends Omit<GeomPart, 'center' | 'rotationZDeg'> {
  /** 工位局部坐标（原点为底板顶面中心）。 */
  local: Vec3;
}

interface LocalAxis extends Omit<GeomMovingAxis, 'axis' | 'pivot'> {
  axisLocal: Vec3;
  pivotLocal: Vec3;
}

interface StationBuild {
  station: string;
  stationId: string;
  index: number;
  width: number;
  parts: LocalPart[];
  axes: LocalAxis[];
  /** 局部占地 AABB（XY）。 */
  local: { minX: number; maxX: number; minY: number; maxY: number };
  actuatorIds: string[];
  sensorPoints: string[];
  warnings: string[];
}

function strokeOf(actuator: ActuatorConfig): number {
  return Math.max(1, actuator.travelMm ?? 40);
}

function buildStation(
  config: MachineConfig,
  station: string,
  index: number,
  usedIds: Set<string>
): StationBuild {
  const stationId = `st${index + 1}`;
  const actuators = config.actuators.filter((actuator) => actuator.station === station);
  const sensors = config.sensors.filter((sensor) => sensor.station === station);
  const parts: LocalPart[] = [];
  const axes: LocalAxis[] = [];
  const warnings: string[] = [];

  const claim = (raw: string): string => {
    let id = geometryIdPart(raw);
    if (usedIds.has(id)) {
      let suffix = 2;
      while (usedIds.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    usedIds.add(id);
    return id;
  };
  const add = (part: Omit<LocalPart, 'id'> & { id: string }): string => {
    const id = claim(part.id);
    parts.push({ ...part, id });
    return id;
  };

  const slotsWidth = actuators.reduce((sum, actuator) => sum + D.slotWidth[actuator.kind], 0);
  const width = Math.max(D.stationPlateMinWidth, slotsWidth + 2 * D.stationMargin);
  const depth = D.stationPlateDepth;
  const plateT = D.stationPlateThickness;

  // 底板：局部原点在底板顶面中心。
  add({
    id: `${stationId}-plate`,
    name: `${station} 底板`,
    role: 'plate',
    shape: { type: 'box', size: [width, depth, plateT] },
    local: [0, 0, -plateT / 2],
    color: COLORS.plate,
    material: 'AL6061',
    bomGroup: 'structure',
    stationId
  });

  // 门架高度按最长气缸与旋转台计算，保证伸出到位不撞治具。
  const maxStroke = actuators.reduce(
    (max, actuator) => (actuator.kind === 'cylinder' ? Math.max(max, strokeOf(actuator)) : max),
    0
  );
  const gripperDrop = D.mountBlock + D.gripperBody[2] + D.gripperJaw[2];
  const cylinderDrop = maxStroke > 0 ? D.mountBlock + maxStroke + D.cylinderBodyExtra + D.rodProtrusion + maxStroke : 0;
  const workTop = Math.max(D.rotaryBaseHeight + D.rotaryTableHeight + D.fixture[2], D.fixture[2]);
  const beamBottom = Math.round(workTop + D.workClearance + Math.max(cylinderDrop, gripperDrop, 120));
  const uprightHeight = beamBottom + D.beamSection;
  const uprightX = width / 2 - D.uprightSection / 2;

  for (const side of [-1, 1] as const) {
    add({
      id: `${stationId}-upright-${side < 0 ? 'l' : 'r'}`,
      name: `${station} 门架立柱${side < 0 ? '左' : '右'}`,
      role: 'structure',
      shape: { type: 'box', size: [D.uprightSection, D.uprightSection, uprightHeight] },
      local: [side * uprightX, 0, uprightHeight / 2],
      color: COLORS.upright,
      material: 'AL6063-T5 型材',
      bomGroup: 'structure',
      stationId
    });
  }
  const beamLength = width - 2 * D.uprightSection;
  add({
    id: `${stationId}-beam`,
    name: `${station} 门架横梁`,
    role: 'structure',
    shape: { type: 'box', size: [beamLength, D.beamSection, D.beamSection] },
    local: [0, 0, beamBottom + D.beamSection / 2],
    color: COLORS.upright,
    material: 'AL6063-T5 型材',
    bomGroup: 'structure',
    stationId
  });

  // 执行机构按槽位沿局部 X 排列。
  const slotCenters = new Map<string, number>();
  let cursor = -slotsWidth / 2;
  for (const actuator of actuators) {
    const slot = D.slotWidth[actuator.kind];
    slotCenters.set(actuator.id, cursor + slot / 2);
    cursor += slot;
  }

  const actuatorIds: string[] = [];
  for (const actuator of actuators) {
    const x = slotCenters.get(actuator.id) ?? 0;
    const key = geometryIdPart(actuator.id);
    const durationMs = actuator.durationMs ?? 400;
    actuatorIds.push(actuator.id);
    const meta = { stationId, actuatorId: actuator.id };

    if (actuator.kind === 'cylinder') {
      const stroke = strokeOf(actuator);
      const bodyLength = stroke + D.cylinderBodyExtra;
      const mountTop = beamBottom;
      const bodyTop = mountTop - D.mountBlock;
      const bodyCenterZ = bodyTop - bodyLength / 2;
      const rodLength = stroke + D.rodProtrusion + 10;
      // 缩回位：活塞杆露出缸体底面 rodProtrusion。
      const rodBottom = bodyTop - bodyLength - D.rodProtrusion;
      const rodCenterZ = rodBottom + rodLength / 2;
      add({
        id: `${key}-mount`,
        name: `${actuator.name} 安装块`,
        role: 'structure',
        shape: { type: 'box', size: [60, 50, D.mountBlock] },
        local: [x, 0, mountTop - D.mountBlock / 2],
        color: COLORS.bracket,
        material: 'AL6061',
        bomGroup: 'structure',
        ...meta
      });
      add({
        id: `${key}-body`,
        name: `${actuator.name} 缸体 Ø${D.cylinderBore}×${stroke}`,
        role: 'actuator',
        shape: { type: 'cylinder', radius: D.cylinderBodyRadius, length: bodyLength, axis: 'z' },
        local: [x, 0, bodyCenterZ],
        color: COLORS.cylinderBody,
        material: '铝合金缸筒',
        bomGroup: 'actuator:cylinder',
        ...meta
      });
      const rodId = add({
        id: `${key}-rod`,
        name: `${actuator.name} 活塞杆`,
        role: 'actuator',
        shape: { type: 'cylinder', radius: D.cylinderRodRadius, length: rodLength, axis: 'z' },
        local: [x, 0, rodCenterZ],
        color: COLORS.rod,
        material: 'S45C 镀铬',
        bomGroup: 'actuator:cylinder',
        moving: true,
        ...meta
      });
      const toolId = add({
        id: `${key}-tool`,
        name: `${actuator.name} 压头`,
        role: 'actuator',
        shape: { type: 'cylinder', radius: 16, length: 14, axis: 'z' },
        local: [x, 0, rodBottom - 7],
        color: COLORS.bracket,
        material: 'SKD11',
        bomGroup: 'actuator:cylinder',
        moving: true,
        ...meta
      });
      add({
        id: `${key}-nest`,
        name: `${actuator.name} 治具`,
        role: 'fixture',
        shape: { type: 'box', size: [...D.fixture] },
        local: [x, 0, D.fixture[2] / 2],
        color: COLORS.fixture,
        material: 'POM',
        bomGroup: 'structure',
        ...meta
      });
      const extendedBottom = rodBottom - 14 - stroke;
      if (extendedBottom < D.fixture[2] - 1e-6) {
        warnings.push(`${actuator.name} 伸出到位后压头低于治具顶面，请复核行程`);
      }
      axes.push({
        actuatorId: actuator.id,
        stationId,
        kind: 'linear',
        partIds: [rodId, toolId],
        axisLocal: [0, 0, -1],
        pivotLocal: [x, 0, bodyTop],
        strokeMm: stroke,
        rangeDeg: 0,
        home: 'retracted',
        durationMs,
        points: {
          ...(actuator.extendPoint ? { extend: actuator.extendPoint } : {}),
          ...(actuator.retractPoint ? { retract: actuator.retractPoint } : {})
        }
      });
    } else if (actuator.kind === 'gripper') {
      const stroke = strokeOf(actuator);
      const [bw, bd, bh] = D.gripperBody;
      const [jw, jd, jh] = D.gripperJaw;
      const bodyTop = beamBottom - D.mountBlock;
      add({
        id: `${key}-mount`,
        name: `${actuator.name} 安装块`,
        role: 'structure',
        shape: { type: 'box', size: [70, 50, D.mountBlock] },
        local: [x, 0, beamBottom - D.mountBlock / 2],
        color: COLORS.bracket,
        material: 'AL6061',
        bomGroup: 'structure',
        ...meta
      });
      add({
        id: `${key}-body`,
        name: `${actuator.name} 本体（行程 ${stroke}）`,
        role: 'actuator',
        shape: { type: 'box', size: [bw, bd, bh] },
        local: [x, 0, bodyTop - bh / 2],
        color: COLORS.gripperBody,
        material: '铝合金本体',
        bomGroup: 'actuator:gripper',
        ...meta
      });
      // 张开位：两指内侧间距 = 闭合间隙 + 行程。
      const openGap = D.gripperClosedGap + stroke;
      const jawZ = bodyTop - bh - jh / 2;
      const jawIds: { partId: string; sign: 1 | -1 }[] = [];
      for (const side of [-1, 1] as const) {
        const id = add({
          id: `${key}-jaw-${side < 0 ? 'l' : 'r'}`,
          name: `${actuator.name} 夹指${side < 0 ? '左' : '右'}`,
          role: 'actuator',
          shape: { type: 'box', size: [jw, jd, jh] },
          local: [x + side * (openGap / 2 + jw / 2), 0, jawZ],
          color: COLORS.jaw,
          material: 'S45C',
          bomGroup: 'actuator:gripper',
          moving: true,
          ...meta
        });
        jawIds.push({ partId: id, sign: side < 0 ? 1 : -1 });
      }
      add({
        id: `${key}-nest`,
        name: `${actuator.name} 取料位`,
        role: 'fixture',
        shape: { type: 'box', size: [...D.fixture] },
        local: [x, 0, D.fixture[2] / 2],
        color: COLORS.fixture,
        material: 'POM',
        bomGroup: 'structure',
        ...meta
      });
      axes.push({
        actuatorId: actuator.id,
        stationId,
        kind: 'gripper',
        partIds: jawIds.map((jaw) => jaw.partId),
        axisLocal: [1, 0, 0],
        pivotLocal: [x, 0, jawZ],
        strokeMm: stroke,
        rangeDeg: 0,
        home: 'open',
        durationMs,
        points: actuator.gripPoint ? { grip: actuator.gripPoint } : {},
        jaws: jawIds
      });
    } else {
      const baseH = D.rotaryBaseHeight;
      const tableH = D.rotaryTableHeight;
      add({
        id: `${key}-base`,
        name: `${actuator.name} 底座`,
        role: 'actuator',
        shape: { type: 'cylinder', radius: D.rotaryBaseRadius, length: baseH, axis: 'z' },
        local: [x, 0, baseH / 2],
        color: COLORS.rotaryBase,
        material: '铸铝壳体',
        bomGroup: 'actuator:rotary',
        ...meta
      });
      const tableId = add({
        id: `${key}-table`,
        name: `${actuator.name} 台面 Ø${D.rotaryTableRadius * 2}`,
        role: 'actuator',
        shape: { type: 'cylinder', radius: D.rotaryTableRadius, length: tableH, axis: 'z' },
        local: [x, 0, baseH + tableH / 2],
        color: COLORS.rotaryTable,
        material: 'AL6061 阳极',
        bomGroup: 'actuator:rotary',
        moving: true,
        ...meta
      });
      // 偏心治具：让 0°/90° 两个位姿在视觉上可分辨。
      const fixtureId = add({
        id: `${key}-fixture`,
        name: `${actuator.name} 治具`,
        role: 'fixture',
        shape: { type: 'box', size: [60, 30, D.fixture[2]] },
        local: [x + 30, 0, baseH + tableH + D.fixture[2] / 2],
        color: COLORS.fixture,
        material: 'POM',
        bomGroup: 'structure',
        moving: true,
        ...meta
      });
      axes.push({
        actuatorId: actuator.id,
        stationId,
        kind: 'rotary',
        partIds: [tableId, fixtureId],
        axisLocal: [0, 0, 1],
        pivotLocal: [x, 0, baseH],
        strokeMm: 0,
        rangeDeg: 90,
        home: 'zero',
        durationMs,
        points: actuator.point ? { point: actuator.point } : {}
      });
    }
  }

  // 传感器：前排（局部 -Y 侧）沿 X 排开，靠近所检测的执行机构槽位；安全光栅在底板外侧前方。
  const sensorPoints: string[] = [];
  const rowY = -depth / 2 + D.sensorRowInset;
  const sensorCountByX = new Map<number, number>();
  const ordinary = sensors.filter((sensor) => sensorKindOf(sensor) !== 'safety');
  const spread = ordinary.length > 1 ? (width - 2 * D.stationMargin - 40) / (ordinary.length - 1) : 0;
  ordinary.forEach((sensor, order) => {
    const kind = sensorKindOf(sensor);
    const target = slotCenters.get(sensor.part);
    let x = target ?? (ordinary.length > 1 ? -width / 2 + D.stationMargin + 20 + spread * order : 0);
    const used = sensorCountByX.get(Math.round(x)) ?? 0;
    sensorCountByX.set(Math.round(x), used + 1);
    if (target !== undefined && used > 0) x += used * 36 * (used % 2 === 0 ? -1 : 1);
    const key = geometryIdPart(sensor.point);
    sensorPoints.push(sensor.point);
    const meta = { stationId, sensorPoint: sensor.point };
    add({
      id: `sensor-${key}-bracket`,
      name: `${sensor.point} 支架`,
      role: 'structure',
      shape: { type: 'box', size: [30, 10, 70] },
      local: [x, rowY - 15, 35],
      color: COLORS.bracket,
      material: 'SPCC',
      bomGroup: 'structure',
      ...meta
    });
    if (kind === 'proximity') {
      add({
        id: `sensor-${key}`,
        name: `${sensor.point} 接近开关 M12`,
        role: 'sensor',
        shape: { type: 'cylinder', radius: 6, length: 45, axis: 'y' },
        local: [x, rowY + 12.5, 55],
        color: COLORS.sensor,
        material: '黄铜镀镍',
        bomGroup: 'sensor:proximity',
        ...meta
      });
    } else if (kind === 'photoelectric') {
      add({
        id: `sensor-${key}`,
        name: `${sensor.point} 光电传感器`,
        role: 'sensor',
        shape: { type: 'box', size: [18, 32, 40] },
        local: [x, rowY + 6, 50],
        color: COLORS.sensor,
        material: 'PBT',
        bomGroup: 'sensor:photoelectric',
        ...meta
      });
    } else {
      add({
        id: `sensor-${key}`,
        name: `${sensor.point} 压力传感器`,
        role: 'sensor',
        shape: { type: 'cylinder', radius: 16, length: 30, axis: 'y' },
        local: [x, rowY + 5, 50],
        color: COLORS.sensor,
        material: '不锈钢',
        bomGroup: 'sensor:pressure',
        ...meta
      });
    }
  });

  const safety = sensors.filter((sensor) => sensorKindOf(sensor) === 'safety');
  safety.forEach((sensor, order) => {
    const key = geometryIdPart(sensor.point);
    sensorPoints.push(sensor.point);
    const y = -depth / 2 - D.safetyPostOffset - order * (D.safetyPostSection + 10);
    for (const side of [-1, 1] as const) {
      add({
        id: `sensor-${key}-${side < 0 ? 'tx' : 'rx'}`,
        name: `${sensor.point} 安全光栅${side < 0 ? '发射端' : '接收端'}`,
        role: 'safety',
        shape: { type: 'box', size: [D.safetyPostSection, D.safetyPostSection, D.safetyPostHeight] },
        local: [side * (width / 2 - D.safetyPostSection / 2), y, D.safetyPostHeight / 2 - D.stationPlateThickness],
        color: COLORS.safety,
        material: '铝型材外壳',
        bomGroup: 'sensor:safety',
        stationId,
        sensorPoint: sensor.point
      });
    }
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    const box = partBounds({ shape: part.shape, center: part.local, rotationZDeg: 0 });
    minX = Math.min(minX, box.min[0]);
    maxX = Math.max(maxX, box.max[0]);
    minY = Math.min(minY, box.min[1]);
    maxY = Math.max(maxY, box.max[1]);
  }

  return {
    station,
    stationId,
    index,
    width,
    parts,
    axes,
    local: { minX, maxX, minY, maxY },
    actuatorIds,
    sensorPoints,
    warnings
  };
}

// ── 整机装配 ─────────────────────────────────────────────────────────────────

interface Placement {
  origin: Vec3;
  rotationZDeg: number;
}

function toWorld(placement: Placement, local: Vec3): Vec3 {
  const [x, y] = rotateXY(local[0], local[1], placement.rotationZDeg);
  return [placement.origin[0] + x, placement.origin[1] + y, placement.origin[2] + local[2]];
}

function directionToWorld(placement: Placement, local: Vec3): Vec3 {
  const [x, y] = rotateXY(local[0], local[1], placement.rotationZDeg);
  return [x, y, local[2]];
}

function footprintFor(build: StationBuild, placement: Placement): GeomFootprint {
  const cx = (build.local.minX + build.local.maxX) / 2;
  const cy = (build.local.minY + build.local.maxY) / 2;
  const [wx, wy] = toWorld(placement, [cx, cy, 0]);
  return {
    stationId: build.stationId,
    center: [round(wx), round(wy)],
    half: [round((build.local.maxX - build.local.minX) / 2), round((build.local.maxY - build.local.minY) / 2)],
    rotationZDeg: round(placement.rotationZDeg)
  };
}

type MachineGeometryInput = MachineConfig | {
  config: MachineConfig;
  form?: { geometry?: { kind?: unknown }; layout?: unknown };
};

function isMachineDesignLike(value: unknown): value is { config: MachineConfig; form?: { geometry?: { kind?: unknown }; layout?: unknown } } {
  return typeof value === 'object' && value !== null && 'config' in value && typeof (value as { config: unknown }).config === 'object';
}

function formGeometryLayout(value: unknown): GeomLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const form = (value as { form?: unknown }).form;
  if (!form || typeof form !== 'object') return undefined;
  const geometry = (form as { geometry?: unknown }).geometry;
  if (!geometry || typeof geometry !== 'object') return undefined;
  const kind = (geometry as { kind?: unknown }).kind;
  return kind === 'dial' || kind === 'linear' || kind === 'gantry' || kind === 'dual'
    ? kind
    : undefined;
}

/**
 * 从 MachineConfig / MachineDesign 生成参数化整机几何。纯函数：相同输入产生相同输出。
 */
export function generateMachineGeometry(
  input: MachineGeometryInput,
  options: MachineGeometryOptions = {}
): MachineGeometry {
  const config = validateMachineConfig(isMachineDesignLike(input) ? input.config : input);
  const process = options.process ?? inferProcess(config);
  const formLayout = formGeometryLayout(input);
  const layout = options.layout
    ?? (config.stations.length <= 1 ? 'single' : undefined)
    ?? formLayout
    ?? chooseLayout(process, config.stations.length);
  const cacheKey = options.bypassCache
    ? ''
    : JSON.stringify({
        config,
        process,
        layout,
        formLayout: formLayout ?? null
      });
  if (cacheKey) {
    const cached = geometryCache.get(cacheKey);
    if (cached) {
      geometryCacheHits += 1;
      // Map 保持插入顺序，命中的项移到末尾即 LRU。
      geometryCache.delete(cacheKey);
      geometryCache.set(cacheKey, cached);
      return cached;
    }
    geometryCacheMisses += 1;
  }
  const usedIds = new Set<string>();
  const warnings: string[] = [];
  const assumptions: string[] = [
    '几何为按规则摆放的标准件外形（典型尺寸），不含强度、刚度、干涉求解与紧固件/钣金细节。',
    `台面高度 ${D.tableHeight} mm；工位底板 ${D.stationPlateThickness} mm 厚、深 ${D.stationPlateDepth} mm，宽度按执行机构槽位累加（最小 ${D.stationPlateMinWidth} mm）。`,
    `气缸按缸径 Ø${D.cylinderBore}、竖直下压、缩回位建模；夹爪按张开位建模；旋转台按 0° 位建模。`
  ];
  // 预占整机级 id，避免与工位件冲突。
  for (const id of ['frame-top', 'conveyor-frame', 'conveyor-belt', 'conveyor-motor', 'dial-indexer', 'dial-plate']) usedIds.add(id);

  const builds = config.stations.map((station, index) => buildStation(config, station, index, usedIds));
  for (const build of builds) warnings.push(...build.warnings);

  const stationTopZ = D.tableHeight + D.stationPlateThickness;
  const placements: Placement[] = [];
  const machineParts: GeomPart[] = [];
  const layoutPart = (part: GeomPart): void => {
    machineParts.push(part);
  };

  if (layout === 'dial') {
    const n = builds.length;
    const halfDepthMax = Math.max(...builds.map((build) => (build.local.maxY - build.local.minY) / 2));
    const dialRadius = Math.max(D.dialMinRadius, Math.round(n * 70));
    let radius = dialRadius + D.dialClearance + halfDepthMax;
    const angleOf = (index: number): number => 90 + (360 / n) * index;
    const tryPlace = (r: number): Placement[] =>
      builds.map((build, index) => {
        const theta = angleOf(index);
        const [cx, cy] = rotateXY(r, 0, theta);
        // 局部原点与占地中心不重合：先按占地中心落位，再反推原点，保证 -Y 指向转盘中心。
        const rotation = theta - 90;
        const offsetY = (build.local.minY + build.local.maxY) / 2;
        const [ox, oy] = rotateXY(0, offsetY, rotation);
        return { origin: [cx - ox, cy - oy, stationTopZ], rotationZDeg: rotation };
      });
    let candidate = tryPlace(radius);
    for (let guard = 0; guard < 400; guard += 1) {
      const fps = builds.map((build, index) => footprintFor(build, candidate[index] as Placement));
      let clash = false;
      for (let i = 0; i < fps.length && !clash; i += 1) {
        for (let j = i + 1; j < fps.length; j += 1) {
          if (footprintsOverlap(fps[i] as GeomFootprint, fps[j] as GeomFootprint)) {
            clash = true;
            break;
          }
        }
      }
      if (!clash) break;
      radius += 20;
      candidate = tryPlace(radius);
    }
    // 留出 stationGap/2 的间距，避免相邻工位刚好贴边。
    radius += D.stationGap / 2;
    placements.push(...tryPlace(radius));
    const indexerZ = D.tableHeight + D.dialIndexerHeight / 2;
    layoutPart({
      id: 'dial-indexer',
      name: '凸轮分度器',
      role: 'transfer',
      shape: { type: 'box', size: [D.dialIndexerSize, D.dialIndexerSize, D.dialIndexerHeight] },
      center: [0, 0, indexerZ],
      rotationZDeg: 0,
      color: COLORS.conveyor,
      material: '铸铁壳体',
      bomGroup: 'structure'
    });
    layoutPart({
      id: 'dial-plate',
      name: `分度转盘 Ø${dialRadius * 2}×${D.dialThickness}`,
      role: 'transfer',
      shape: { type: 'cylinder', radius: dialRadius, length: D.dialThickness, axis: 'z' },
      center: [0, 0, D.tableHeight + D.dialIndexerHeight + D.dialThickness / 2],
      rotationZDeg: 0,
      color: COLORS.dial,
      material: 'AL6061',
      bomGroup: 'structure'
    });
    for (let index = 0; index < n; index += 1) {
      const [x, y] = rotateXY(dialRadius - D.fixture[0] / 2 - 20, 0, angleOf(index));
      const id = `dial-nest-${index + 1}`;
      usedIds.add(id);
      layoutPart({
        id,
        name: `转盘治具 ${index + 1}`,
        role: 'fixture',
        shape: { type: 'box', size: [...D.fixture] },
        center: [x, y, D.tableHeight + D.dialIndexerHeight + D.dialThickness + D.fixture[2] / 2],
        rotationZDeg: angleOf(index) - 90,
        color: COLORS.fixture,
        material: 'POM',
        bomGroup: 'structure'
      });
    }
    assumptions.push(`分度转盘布局：${n} 工位沿 Ø${dialRadius * 2} 转盘均布，工位中心半径约 ${Math.round(radius)} mm；转盘分度运动未接入点位。`);
  } else if (layout === 'dual') {
    // 双轨：两排工位各自沿 X 排开，外侧各一条输送线。
    const laneCount = 2;
    const perLane = Math.max(1, Math.ceil(builds.length / laneCount));
    const lanes = [builds.slice(0, perLane), builds.slice(perLane)];
    const laneDepth = lanes.map((lane) => Math.max(0, ...lane.map((build) => build.local.maxY - build.local.minY)));
    const pitch = Math.max(...laneDepth) + D.stationGap * 2;
    const laneY = [-pitch / 2, pitch / 2];
    let placementIndex = 0;
    for (const [laneIndex, lane] of lanes.entries()) {
      let x = 0;
      const xs: number[] = [];
      for (const build of lane) {
        const span = build.local.maxX - build.local.minX;
        xs.push(x - build.local.minX);
        x += span + D.stationGap;
      }
      const total = x - D.stationGap;
      const y = laneY[laneIndex] ?? 0;
      for (const [index] of lane.entries()) {
        placements[placementIndex] = { origin: [(xs[index] ?? 0) - total / 2, y, stationTopZ], rotationZDeg: 0 };
        placementIndex += 1;
      }
      const frontMax = Math.max(0, ...lane.map((build) => -build.local.minY));
      const conveyorY = laneIndex === 0
        ? y - frontMax - D.conveyorClearance - D.conveyorWidth / 2
        : y + frontMax + D.conveyorClearance + D.conveyorWidth / 2;
      const length = total + 2 * D.conveyorOverhang;
      layoutPart({
        id: `conveyor-frame-l${laneIndex + 1}`,
        name: `轨道${laneIndex + 1}输送线机架 ${Math.round(length)}×${D.conveyorWidth}`,
        role: 'transfer',
        shape: { type: 'box', size: [length, D.conveyorWidth, D.conveyorHeight] },
        center: [0, conveyorY, D.tableHeight + D.conveyorHeight / 2],
        rotationZDeg: 0,
        color: COLORS.conveyor,
        material: 'AL6063-T5 型材',
        bomGroup: 'structure'
      });
      layoutPart({
        id: `conveyor-belt-l${laneIndex + 1}`,
        name: `轨道${laneIndex + 1}输送皮带 宽 ${D.conveyorBeltWidth}`,
        role: 'transfer',
        shape: { type: 'box', size: [length - 40, D.conveyorBeltWidth, 6] },
        center: [0, conveyorY, D.tableHeight + D.conveyorHeight + 3],
        rotationZDeg: 0,
        color: COLORS.belt,
        material: 'PVC',
        bomGroup: 'structure'
      });
    }
    assumptions.push(`双轨布局：${builds.length} 工位分 ${laneCount} 轨、每轨约 ${perLane} 工位，轨间距 ${Math.round(pitch)} mm；两轨可独立停线/换型。`);
  } else {
    // single / linear / gantry：工位沿 X 排开。
    const frontMax = Math.max(...builds.map((build) => -build.local.minY));
    let x = 0;
    const xs: number[] = [];
    for (const build of builds) {
      const span = build.local.maxX - build.local.minX;
      xs.push(x - build.local.minX);
      x += span + D.stationGap;
    }
    const total = x - D.stationGap;
    for (const [index] of builds.entries()) {
      placements.push({ origin: [(xs[index] ?? 0) - total / 2, 0, stationTopZ], rotationZDeg: 0 });
    }
    if (layout === 'linear') {
      const conveyorY = -frontMax - D.conveyorClearance - D.conveyorWidth / 2;
      const length = total + 2 * D.conveyorOverhang;
      layoutPart({
        id: 'conveyor-frame',
        name: `输送线机架 ${Math.round(length)}×${D.conveyorWidth}`,
        role: 'transfer',
        shape: { type: 'box', size: [length, D.conveyorWidth, D.conveyorHeight] },
        center: [0, conveyorY, D.tableHeight + D.conveyorHeight / 2],
        rotationZDeg: 0,
        color: COLORS.conveyor,
        material: 'AL6063-T5 型材',
        bomGroup: 'structure'
      });
      layoutPart({
        id: 'conveyor-belt',
        name: `输送皮带 宽 ${D.conveyorBeltWidth}`,
        role: 'transfer',
        shape: { type: 'box', size: [length - 40, D.conveyorBeltWidth, 6] },
        center: [0, conveyorY, D.tableHeight + D.conveyorHeight + 3],
        rotationZDeg: 0,
        color: COLORS.belt,
        material: 'PVC',
        bomGroup: 'structure'
      });
      layoutPart({
        id: 'conveyor-motor',
        name: '输送线减速电机',
        role: 'transfer',
        shape: { type: 'cylinder', radius: 40, length: 120, axis: 'y' },
        center: [length / 2 - 60, conveyorY - D.conveyorWidth / 2 - 60, D.tableHeight + 45],
        rotationZDeg: 0,
        color: COLORS.rotaryBase,
        material: '电机',
        bomGroup: 'structure'
      });
      assumptions.push(`直线布局：${builds.length} 工位沿 X 排开、间距 ${D.stationGap} mm，操作侧输送线 ${Math.round(length)} mm；输送线驱动未接入点位。`);
    } else if (layout === 'gantry') {
      const gantryHeight = 760;
      const gantryZ = stationTopZ + gantryHeight / 2;
      for (const [label, sx] of [['left', -1], ['right', 1]] as const) {
        layoutPart({
          id: `gantry-upright-${label}`,
          name: `龙门立柱（${label === 'left' ? '左' : '右'}）`,
          role: 'frame',
          shape: { type: 'box', size: [D.uprightSection, D.uprightSection, gantryHeight] },
          center: [sx * (total / 2 + D.frameMargin), 0, gantryZ],
          rotationZDeg: 0,
          color: COLORS.upright,
          material: 'AL6063-T5 型材',
          bomGroup: 'structure'
        });
      }
      layoutPart({
        id: 'gantry-beam',
        name: `龙门横梁 ${Math.round(total + 2 * D.frameMargin)}×${D.beamSection}`,
        role: 'frame',
        shape: { type: 'box', size: [total + 2 * D.frameMargin, D.beamSection, D.beamSection] },
        center: [0, 0, stationTopZ + gantryHeight - D.beamSection / 2],
        rotationZDeg: 0,
        color: COLORS.upright,
        material: 'AL6063-T5 型材',
        bomGroup: 'structure'
      });
      layoutPart({
        id: 'gantry-carriage',
        name: '龙门双轴滑台',
        role: 'transfer',
        shape: { type: 'box', size: [180, 120, 90] },
        center: [0, 0, stationTopZ + gantryHeight - D.beamSection - 45],
        rotationZDeg: 0,
        color: COLORS.rotaryBase,
        material: 'AL6061',
        bomGroup: 'structure'
      });
      assumptions.push(`龙门布局：${builds.length} 工位沿 X 排开，上方 ${gantryHeight} mm 双轴龙门覆盖全部工位；龙门运动未接入点位。`);
    } else {
      assumptions.push('单工位布局：不生成输送线/转盘。');
    }
  }

  // 工位件落到世界坐标。
  const parts: GeomPart[] = [];
  const moving: GeomMovingAxis[] = [];
  const stations: GeomStation[] = [];
  builds.forEach((build, index) => {
    const placement = placements[index] as Placement;
    for (const part of build.parts) {
      const { local, ...rest } = part;
      parts.push({ ...rest, center: roundVec(toWorld(placement, local)), rotationZDeg: round(placement.rotationZDeg) });
    }
    for (const axis of build.axes) {
      const { axisLocal, pivotLocal, ...rest } = axis;
      moving.push({
        ...rest,
        axis: roundVec(directionToWorld(placement, axisLocal)),
        pivot: roundVec(toWorld(placement, pivotLocal))
      });
    }
    stations.push({
      id: build.stationId,
      name: build.station,
      index,
      origin: roundVec(placement.origin),
      rotationZDeg: round(placement.rotationZDeg),
      plateSize: [build.width, D.stationPlateDepth, D.stationPlateThickness],
      workPoint: roundVec(toWorld(placement, [0, 0, 0])),
      footprint: footprintFor(build, placement),
      actuatorIds: build.actuatorIds,
      sensorPoints: build.sensorPoints
    });
  });
  parts.push(...machineParts);

  // 机架：按内容 XY 包络 + 边距生成台面、立腿与下横梁。
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const part of parts) {
    const box = partBounds(part);
    minX = Math.min(minX, box.min[0]);
    maxX = Math.max(maxX, box.max[0]);
    minY = Math.min(minY, box.min[1]);
    maxY = Math.max(maxY, box.max[1]);
  }
  const frameLength = Math.ceil((maxX - minX + 2 * D.frameMargin) / 10) * 10;
  const frameWidth = Math.ceil((maxY - minY + 2 * D.frameMargin) / 10) * 10;
  const shiftX = -(minX + maxX) / 2;
  const shiftY = -(minY + maxY) / 2;
  const shift = (part: { center: Vec3 }): void => {
    part.center = roundVec([part.center[0] + shiftX, part.center[1] + shiftY, part.center[2]]);
  };
  for (const part of parts) shift(part);
  for (const axis of moving) axis.pivot = roundVec([axis.pivot[0] + shiftX, axis.pivot[1] + shiftY, axis.pivot[2]]);
  for (const station of stations) {
    station.origin = roundVec([station.origin[0] + shiftX, station.origin[1] + shiftY, station.origin[2]]);
    station.workPoint = roundVec([station.workPoint[0] + shiftX, station.workPoint[1] + shiftY, station.workPoint[2]]);
    station.footprint.center = [round(station.footprint.center[0] + shiftX), round(station.footprint.center[1] + shiftY)];
  }

  const topT = D.topPlateThickness;
  const legH = D.tableHeight - topT;
  const frameParts: GeomPart[] = [
    {
      id: 'frame-top',
      name: `机架台面 ${frameLength}×${frameWidth}×${topT}`,
      role: 'frame',
      shape: { type: 'box', size: [frameLength, frameWidth, topT] },
      center: [0, 0, D.tableHeight - topT / 2],
      rotationZDeg: 0,
      color: COLORS.top,
      material: 'Q235 磨床板',
      bomGroup: 'structure'
    }
  ];
  const legInset = D.legSection / 2 + 10;
  const bays = Math.max(1, Math.ceil((frameLength - 2 * legInset) / D.legSpanMax));
  const legXs = Array.from({ length: bays + 1 }, (_unused, i) => -frameLength / 2 + legInset + ((frameLength - 2 * legInset) * i) / bays);
  let legNo = 0;
  for (const y of [-frameWidth / 2 + legInset, frameWidth / 2 - legInset]) {
    for (const lx of legXs) {
      legNo += 1;
      const id = `frame-leg-${legNo}`;
      usedIds.add(id);
      frameParts.push({
        id,
        name: `机架立腿 ${legNo}（${D.legSection}×${D.legSection}×${legH}）`,
        role: 'frame',
        shape: { type: 'box', size: [D.legSection, D.legSection, legH] },
        center: roundVec([lx, y, legH / 2]),
        rotationZDeg: 0,
        color: COLORS.frame,
        material: 'Q235 方管',
        bomGroup: 'structure'
      });
    }
  }
  const stringerLength = frameLength - 2 * legInset - D.legSection;
  for (const [label, y] of [['front', -frameWidth / 2 + legInset], ['back', frameWidth / 2 - legInset]] as const) {
    const id = `frame-stringer-${label}`;
    usedIds.add(id);
    frameParts.push({
      id,
      name: `机架下横梁（${label === 'front' ? '前' : '后'}）`,
      role: 'frame',
      shape: { type: 'box', size: [stringerLength, D.stringerSection, D.stringerSection] },
      center: roundVec([0, y, D.stringerHeight]),
      rotationZDeg: 0,
      color: COLORS.frame,
      material: 'Q235 方管',
      bomGroup: 'structure'
    });
  }
  const crossLength = frameWidth - 2 * legInset - D.legSection;
  for (const [label, x] of [['left', -frameLength / 2 + legInset], ['right', frameLength / 2 - legInset]] as const) {
    const id = `frame-cross-${label}`;
    usedIds.add(id);
    frameParts.push({
      id,
      name: `机架下横梁（${label === 'left' ? '左' : '右'}）`,
      role: 'frame',
      shape: { type: 'box', size: [D.stringerSection, crossLength, D.stringerSection] },
      center: roundVec([x, 0, D.stringerHeight]),
      rotationZDeg: 0,
      color: COLORS.frame,
      material: 'Q235 方管',
      bomGroup: 'structure'
    });
  }
  const allParts = [...frameParts, ...parts];

  const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
  const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of allParts) {
    const box = partBounds(part);
    for (let axis = 0; axis < 3; axis += 1) {
      boundsMin[axis] = Math.min(boundsMin[axis] as number, box.min[axis] as number);
      boundsMax[axis] = Math.max(boundsMax[axis] as number, box.max[axis] as number);
    }
  }

  const structureBom = buildStructureBom(allParts, bays + 1, frameLength, frameWidth, legH);
  if (layout === 'dial' && config.stations.length > 6) {
    warnings.push(`分度转盘 ${config.stations.length} 工位，整机直径较大，建议评估改为直线输送布局。`);
  }
  if (layout === 'dual' && config.stations.length > 6) {
    warnings.push(`双轨 ${config.stations.length} 工位超出标准 2×3 配置，几何按两轨均分，需复核节拍与换型。`);
  }

  const result: MachineGeometry = {
    schemaVersion: 1,
    kind: 'machine-geometry',
    machineId: config.id,
    name: config.name,
    units: 'mm',
    upAxis: 'z',
    process,
    layout,
    envelope: roundVec([boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2]]),
    bounds: { min: roundVec(boundsMin), max: roundVec(boundsMax) },
    tableHeight: D.tableHeight,
    stations,
    parts: allParts,
    moving,
    structureBom,
    assumptions,
    warnings
  };
  if (cacheKey) {
    geometryCache.set(cacheKey, result);
    while (geometryCache.size > GEOMETRY_CACHE_LIMIT) {
      const oldest = geometryCache.keys().next().value;
      if (oldest === undefined) break;
      geometryCache.delete(oldest);
      geometryCacheEvictions += 1;
    }
  }
  return result;
}

function buildStructureBom(
  parts: readonly GeomPart[],
  legsPerSide: number,
  frameLength: number,
  frameWidth: number,
  legHeight: number
): MachineGeometry['structureBom'] {
  const rows: MachineGeometry['structureBom'] = [];
  rows.push({ name: '机架台面', spec: `${frameLength}×${frameWidth}×${D.topPlateThickness} mm`, qty: 1, material: 'Q235 磨床板' });
  rows.push({ name: '机架立腿', spec: `${D.legSection}×${D.legSection}×${legHeight} mm`, qty: legsPerSide * 2, material: 'Q235 方管' });
  rows.push({ name: '机架下横梁', spec: `${D.stringerSection}×${D.stringerSection} mm`, qty: 4, material: 'Q235 方管' });
  const plates = parts.filter((part) => part.role === 'plate');
  const plateSpecs = new Map<string, number>();
  for (const plate of plates) {
    if (plate.shape.type !== 'box') continue;
    const [x, y, z] = plate.shape.size;
    const spec = `${x}×${y}×${z} mm`;
    plateSpecs.set(spec, (plateSpecs.get(spec) ?? 0) + 1);
  }
  for (const [spec, qty] of plateSpecs) rows.push({ name: '工位底板', spec, qty, material: 'AL6061' });
  const uprights = parts.filter((part) => /-upright-[lr]$/.test(part.id)).length;
  if (uprights > 0) rows.push({ name: '门架立柱', spec: `${D.uprightSection}×${D.uprightSection} 型材`, qty: uprights, material: 'AL6063-T5' });
  const beams = parts.filter((part) => /^st\d+-beam$/.test(part.id)).length;
  if (beams > 0) rows.push({ name: '门架横梁', spec: `${D.beamSection}×${D.beamSection} 型材`, qty: beams, material: 'AL6063-T5' });
  const fixtures = parts.filter((part) => part.role === 'fixture').length;
  if (fixtures > 0) rows.push({ name: '治具（占位）', spec: '按产品定制', qty: fixtures, material: 'POM' });
  if (parts.some((part) => part.id === 'conveyor-frame')) rows.push({ name: '皮带输送线', spec: `宽 ${D.conveyorBeltWidth} mm`, qty: 1, material: '型材 + PVC' });
  if (parts.some((part) => part.id === 'dial-plate')) rows.push({ name: '分度转盘 + 凸轮分度器', spec: '分度数 = 工位数', qty: 1, material: 'AL6061 / 铸铁' });
  return rows;
}

/** 按 BOM 分组统计执行机构/传感器数量（每个执行机构/传感器只计 1 次），用于与 bomDraft 对账。 */
export function geometryComponentCounts(geometry: MachineGeometry): Record<GeomBomGroup, number> {
  const counts: Record<GeomBomGroup, number> = {
    'actuator:cylinder': 0,
    'actuator:gripper': 0,
    'actuator:rotary': 0,
    'sensor:proximity': 0,
    'sensor:photoelectric': 0,
    'sensor:pressure': 0,
    'sensor:safety': 0,
    structure: 0
  };
  const seen = new Set<string>();
  for (const part of geometry.parts) {
    if (part.bomGroup === 'structure') {
      counts.structure += 1;
      continue;
    }
    const owner = part.actuatorId ?? part.sensorPoint ?? part.id;
    const key = `${part.bomGroup}|${owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[part.bomGroup] += 1;
  }
  return counts;
}

/** 给工具结果/摘要用的紧凑描述。 */
export function summarizeGeometry(geometry: MachineGeometry): {
  layout: GeomLayout;
  parts: number;
  movingAxes: number;
  envelopeMm: Vec3;
  stations: number;
  structureBomRows: number;
} {
  return {
    layout: geometry.layout,
    parts: geometry.parts.length,
    movingAxes: geometry.moving.length,
    envelopeMm: geometry.envelope,
    stations: geometry.stations.length,
    structureBomRows: geometry.structureBom.length
  };
}
