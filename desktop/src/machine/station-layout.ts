import type { GeomMovingAxis, GeomPart, MachineGeometry, Vec3 } from './geometry.ts';
import { partBounds } from './geometry.ts';
import type { MachineDesign } from './synth.ts';
import { baselineStationIdentities, isStationIdentity, isStationIdentityList, type StationIdentity } from './station-identity.ts';

/** 稳定工位身份上的全局 XY 平移；不含缩放、旋转或局部坐标变换。 */
export interface StationGeometryOffset {
  stationIdentity: StationIdentity;
  /** 仅用于显示/追溯；不参与身份匹配。 */
  stationName: string;
  xMm: number;
  yMm: number;
}
/** MachineDesign 中持久化的严格版本化字段；v2 以不可变 stationIdentity 关联。 */
export interface StationGeometryLayout {
  schemaVersion: 2;
  offsets: StationGeometryOffset[];
}
export interface StationGeometryLayoutResolution {
  layout?: StationGeometryLayout;
  warning?: string;
}
const MAX_OFFSET_MM = 1_000_000;
const MAX_OFFSETS = 200;
const LAYOUT_V2_KEYS = ['offsets', 'schemaVersion'];
const OFFSET_V2_KEYS = ['stationIdentity', 'stationName', 'xMm', 'yMm'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
function finiteOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_OFFSET_MM;
}
function roundMm(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
function warningForDroppedOffsets(count: number): string {
  return `已按稳定工位身份清除 ${count} 个已删除或无法对应的旧几何偏移；其余工位偏移保留，新工位按零偏移处理。`;
}

/**
 * 读取 MachineDesign 中的偏移。v1 只有 stN/名称/序号，不能证明同序号工位未被替换，
 * 因此仅安全保留工程本身并清除全部旧偏移；v2 按稳定 ID 交集保留，孤儿 ID 单独丢弃。
 */
export function normalizeStationGeometryLayout(
  value: unknown,
  stationNames: readonly string[],
  stationIdentities: readonly string[]
): StationGeometryLayoutResolution {
  if (value === undefined) return {};
  if (isRecord(value) && value.schemaVersion === 1) {
    return {
      warning: '旧版工位偏移只记录序号和名称，无法证明与当前工位是同一实体；已安全清除全部旧偏移，请重新定位工位。'
    };
  }
  const layout = parseStationGeometryLayoutV2(value, stationIdentities);
  const indexByIdentity = new Map(stationIdentities.map((identity, index) => [identity, index]));
  const retained = layout.offsets.flatMap((offset) => {
    const index = indexByIdentity.get(offset.stationIdentity);
    if (index === undefined) return [];
    const currentName = stationNames[index];
    return [{ ...offset, stationName: typeof currentName === 'string' && currentName.trim() ? currentName : offset.stationName }];
  });
  const dropped = layout.offsets.length - retained.length;
  return {
    ...(retained.length ? { layout: { schemaVersion: 2, offsets: retained } } : {}),
    ...(dropped ? { warning: warningForDroppedOffsets(dropped) } : {})
  };
}

function parseStationGeometryLayoutV2(value: unknown, stationIdentities: readonly string[]): StationGeometryLayout {
  if (!isRecord(value) || !hasExactKeys(value, LAYOUT_V2_KEYS) || value.schemaVersion !== 2 || !Array.isArray(value.offsets)) {
    throw new Error('design.stationGeometryLayout 必须是 schemaVersion 2 的严格工位偏移对象');
  }
  if (value.offsets.length > MAX_OFFSETS) throw new Error(`design.stationGeometryLayout.offsets 不能超过 ${MAX_OFFSETS} 项`);
  if (!isStationIdentityList(stationIdentities, stationIdentities.length)) {
    throw new Error('应用工位偏移前必须提供唯一且有效的稳定 stationIdentities');
  }
  const seen = new Set<string>();
  const offsets = value.offsets.map((raw, index): StationGeometryOffset => {
    if (!isRecord(raw) || !hasExactKeys(raw, OFFSET_V2_KEYS)) {
      throw new Error(`design.stationGeometryLayout.offsets[${index}] 含未知或缺失字段`);
    }
    if (!isStationIdentity(raw.stationIdentity) || typeof raw.stationName !== 'string' ||
        !raw.stationName.trim() || raw.stationName.length > 500 ||
        !finiteOffset(raw.xMm) || !finiteOffset(raw.yMm)) {
      throw new Error(`design.stationGeometryLayout.offsets[${index}] 稳定身份或 X/Y 毫米坐标无效`);
    }
    if (seen.has(raw.stationIdentity)) throw new Error(`design.stationGeometryLayout 工位身份重复：${raw.stationIdentity}`);
    seen.add(raw.stationIdentity);
    return {
      stationIdentity: raw.stationIdentity,
      stationName: raw.stationName,
      xMm: raw.xMm,
      yMm: raw.yMm
    };
  });
  return { schemaVersion: 2, offsets };
}

/** 严格校验可应用的 v2 偏移；显示名不参与匹配，只使用不可变身份键。 */
export function validateStationGeometryLayout(
  value: unknown,
  stationNames: readonly string[],
  stationIdentities: readonly string[] = baselineStationIdentities('legacy-layout-validation', stationNames.length)
): StationGeometryLayout {
  if (stationNames.length !== stationIdentities.length) {
    throw new Error('工位名称与稳定身份数量不一致，拒绝应用几何平移');
  }
  const layout = parseStationGeometryLayoutV2(value, stationIdentities);
  const known = new Set(stationIdentities);
  const stale = layout.offsets.find((offset) => !known.has(offset.stationIdentity));
  if (stale) throw new Error(`工位偏移身份 ${stale.stationIdentity} 未映射到当前设计`);
  return layout;
}

function translate(point: Vec3, xMm: number, yMm: number): Vec3 {
  return [roundMm(point[0] + xMm), roundMm(point[1] + yMm), point[2]];
}
function geometryBounds(parts: readonly GeomPart[]): { min: Vec3; max: Vec3 } {
  if (parts.length === 0) throw new Error('MachineGeometry.parts 为空，不能重算工位平移包络');
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const bounds = partBounds(part);
    for (let axis = 0; axis < 3; axis += 1) {
      const low = bounds.min[axis] as number;
      const high = bounds.max[axis] as number;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
        throw new Error(`零件 ${part.id} 的毫米几何包络无效`);
      }
      min[axis] = Math.min(min[axis] as number, low);
      max[axis] = Math.max(max[axis] as number, high);
    }
  }
  return { min: min.map(roundMm) as Vec3, max: max.map(roundMm) as Vec3 };
}

/**
 * 应用已验证偏移，返回新快照；生成器缓存对象本身永不被修改。
 * geometry 的 stN 仅作当前快照内部引用，由 stationIdentities 的同位置记录映射到持久身份。
 */
export function applyStationGeometryLayout(
  geometry: MachineGeometry,
  layoutValue: unknown,
  stationIdentities: readonly string[] = baselineStationIdentities(geometry.machineId, geometry.stations.length)
): MachineGeometry {
  if (layoutValue === undefined) return geometry;
  const layout = validateStationGeometryLayout(layoutValue, geometry.stations.map((station) => station.name), stationIdentities);
  if (layout.offsets.length === 0) return geometry;
  const stationById = new Map(geometry.stations.map((station) => [station.id, station]));
  if (stationById.size !== geometry.stations.length) throw new Error('MachineGeometry 工位 ID 重复，拒绝应用平移');
  for (const [index, station] of geometry.stations.entries()) {
    if (!/^st[1-9][0-9]*$/.test(station.id) || station.id !== `st${index + 1}` || station.index !== index ||
        typeof station.name !== 'string' || !station.name.trim() || station.footprint.stationId !== station.id ||
        !station.origin.every(Number.isFinite) || !station.workPoint.every(Number.isFinite) ||
        !station.plateSize.every((value) => Number.isFinite(value) && value > 0) ||
        !station.footprint.center.every(Number.isFinite) ||
        !station.footprint.half.every((value) => Number.isFinite(value) && value > 0) ||
        !Number.isFinite(station.rotationZDeg) || !Number.isFinite(station.footprint.rotationZDeg)) {
      throw new Error(`MachineGeometry 工位 ${station.id} 缺少可信的 ID/index 映射`);
    }
  }
  if (new Set(geometry.parts.map((part) => part.id)).size !== geometry.parts.length) {
    throw new Error('MachineGeometry.parts 零件 ID 重复，拒绝应用平移');
  }
  const partsById = new Map(geometry.parts.map((part) => [part.id, part]));
  for (const part of geometry.parts) {
    if (part.stationId !== undefined && !stationById.has(part.stationId)) {
      throw new Error(`零件 ${part.id} 的 stationId 未映射到当前 MachineGeometry 工位`);
    }
  }
  for (const axis of geometry.moving) {
    if (!stationById.has(axis.stationId) || !axis.pivot.every(Number.isFinite) ||
        !axis.axis.every(Number.isFinite) || Math.hypot(...axis.axis) <= 0 ||
        !Number.isFinite(axis.strokeMm) || axis.strokeMm < 0 ||
        !Number.isFinite(axis.rangeDeg) || axis.rangeDeg < 0) {
      throw new Error(`运动轴 ${axis.actuatorId} 的工位、全局轴向或枢轴无效`);
    }
    if (axis.partIds.length === 0 || axis.partIds.some((partId) => partsById.get(partId)?.stationId !== axis.stationId)) {
      throw new Error(`运动轴 ${axis.actuatorId} 的随动零件未完整映射到同一 stationId 工位`);
    }
  }
  const offsetsByIdentity = new Map(layout.offsets.map((offset) => [offset.stationIdentity, offset]));
  const offsetsByGeometryStationId = new Map<string, StationGeometryOffset>();
  for (const station of geometry.stations) {
    const identity = stationIdentities[station.index];
    const offset = identity ? offsetsByIdentity.get(identity) : undefined;
    if (offset) {
      const members = geometry.parts.filter((part) => part.stationId === station.id);
      if (members.length === 0) throw new Error(`工位 ${identity} 未映射到任何当前几何零件`);
      offsetsByGeometryStationId.set(station.id, offset);
    }
  }
  const parts = geometry.parts.map((part) => {
    const offset = part.stationId ? offsetsByGeometryStationId.get(part.stationId) : undefined;
    return offset ? { ...part, center: translate(part.center, offset.xMm, offset.yMm) } : { ...part, center: [...part.center] as Vec3 };
  });
  const stations = geometry.stations.map((station) => {
    const offset = offsetsByGeometryStationId.get(station.id);
    if (!offset) return { ...station, origin: [...station.origin] as Vec3, workPoint: [...station.workPoint] as Vec3, footprint: { ...station.footprint, center: [...station.footprint.center] as [number, number] } };
    return {
      ...station,
      origin: translate(station.origin, offset.xMm, offset.yMm),
      workPoint: translate(station.workPoint, offset.xMm, offset.yMm),
      footprint: {
        ...station.footprint,
        center: [roundMm(station.footprint.center[0] + offset.xMm), roundMm(station.footprint.center[1] + offset.yMm)] as [number, number]
      }
    };
  });
  const moving: GeomMovingAxis[] = geometry.moving.map((axis) => {
    const offset = offsetsByGeometryStationId.get(axis.stationId);
    return {
      ...axis,
      axis: [...axis.axis] as Vec3,
      pivot: offset ? translate(axis.pivot, offset.xMm, offset.yMm) : [...axis.pivot] as Vec3,
      partIds: [...axis.partIds],
      ...(axis.jaws ? { jaws: axis.jaws.map((jaw) => ({ ...jaw })) } : {})
    };
  });
  const bounds = geometryBounds(parts);
  const envelope = bounds.min.map((value, axis) => roundMm((bounds.max[axis] as number) - value)) as Vec3;
  return { ...geometry, stations, parts, moving, bounds, envelope };
}

/** 把一个明确工位的绝对 XY 偏移写入 MachineDesign；零偏移使用稀疏表示。 */
export function withStationGeometryOffset(
  design: MachineDesign,
  geometry: MachineGeometry,
  stationId: string,
  xMm: number,
  yMm: number
): MachineDesign {
  if (!finiteOffset(xMm) || !finiteOffset(yMm)) throw new Error('工位平移必须是有限且在允许范围内的毫米坐标');
  const identityList = isStationIdentityList(design.stationIdentities, design.config.stations.length)
    ? [...design.stationIdentities]
    : baselineStationIdentities(design.config.id, design.config.stations.length);
  const station = geometry.stations.find((item) => item.id === stationId);
  if (!station || !Number.isInteger(station.index) || station.index < 0 ||
      station.index >= design.config.stations.length || station.id !== `st${station.index + 1}` ||
      geometry.stations.length !== design.config.stations.length || station.name !== design.config.stations[station.index]) {
    throw new Error(`无法确认工位 ${stationId} 的稳定身份，未写入平移`);
  }
  if (!geometry.parts.some((part) => part.stationId === stationId)) {
    throw new Error(`工位 ${stationId} 未映射到任何当前几何零件，未写入平移`);
  }
  const resolved = normalizeStationGeometryLayout(design.stationGeometryLayout, design.config.stations, identityList);
  const prior = resolved.layout ?? { schemaVersion: 2 as const, offsets: [] };
  const identity = identityList[station.index];
  if (!identity) throw new Error(`工位 ${stationId} 缺少稳定身份，未写入平移`);
  const nextOffsets = prior.offsets.filter((offset) => offset.stationIdentity !== identity);
  const x = roundMm(xMm);
  const y = roundMm(yMm);
  if (x !== 0 || y !== 0) nextOffsets.push({ stationIdentity: identity, stationName: station.name, xMm: x, yMm: y });
  nextOffsets.sort((a, b) => identityList.indexOf(a.stationIdentity) - identityList.indexOf(b.stationIdentity));
  const updated: MachineDesign = { ...design, stationIdentities: identityList };
  if (nextOffsets.length === 0) delete updated.stationGeometryLayout;
  else updated.stationGeometryLayout = { schemaVersion: 2, offsets: nextOffsets };
  if (resolved.warning) updated.stationGeometryWarning = resolved.warning;
  else delete updated.stationGeometryWarning;
  return updated;
}
