import { partBounds, type GeomMovingAxis, type GeomPart, type MachineGeometry } from '../machine/geometry.ts';

/** XY 投影中的毫米 AABB；只用于概念运动提醒，不是干涉或安全签核。 */
export interface MotionEnvelopeBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface MotionPartEnvelope {
  partId: string;
  partName: string;
  bounds: MotionEnvelopeBounds;
  minZ: number;
  maxZ: number;
}

export interface MotionAxisEnvelope {
  actuatorId: string;
  stationId: string;
  kind: string;
  coverage: 'covered' | 'uncovered';
  strokeMm?: number;
  rangeDeg?: number;
  bounds?: MotionEnvelopeBounds;
  parts: MotionPartEnvelope[];
  reason?: string;
}

export interface MotionEnvelopeOverlap {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface MotionEnvelopeAlert {
  moving: { actuatorId: string; partId: string; partName: string };
  other: {
    kind: 'static' | 'moving-sweep' | 'moving-home-only';
    actuatorId?: string;
    partId: string;
    partName: string;
  };
  overlap: MotionEnvelopeOverlap;
}

export interface UncoveredMotionPart {
  partId: string;
  partName: string;
  reason: string;
}

export interface MotionEnvelopeBlocked {
  status: 'blocked';
  reason: string;
  axes: [];
  alerts: [];
  uncoveredParts: [];
}

export interface MotionEnvelopeComputed {
  status: 'computed';
  source: 'machine-geometry.parts+moving';
  units: 'mm';
  axes: MotionAxisEnvelope[];
  alerts: MotionEnvelopeAlert[];
  uncoveredParts: UncoveredMotionPart[];
}

export type MotionEnvelopeAnalysis = MotionEnvelopeComputed | MotionEnvelopeBlocked;

const OVERLAP_EPSILON_MM = 1e-6;
const UNIT_AXIS_TOLERANCE = 1e-6;
const ROTARY_AXIS_TOLERANCE = 1e-9;
const ENVELOPE_COLORS = ['#c2410c', '#7c3aed', '#0369a1', '#be185d', '#4d7c0f', '#a16207', '#0f766e', '#b91c1c', '#1d4ed8', '#047857', '#c026d3', '#475569'];
const UNSUPPORTED_PART_TRANSFORM_KEYS = ['mirror', 'mirrored', 'mirrorX', 'mirrorY', 'mirrorZ', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'transform', 'matrix', 'transformMatrix', 'rotation', 'rotationX', 'rotationY', 'rotationXDeg', 'rotationYDeg', 'orientation', 'quaternion', 'position', 'translation', 'translate'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function validShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'box') {
    return Array.isArray(value.size) && value.size.length === 3 && value.size.every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0);
  }
  return value.type === 'cylinder' &&
    typeof value.radius === 'number' && Number.isFinite(value.radius) && value.radius > 0 &&
    typeof value.length === 'number' && Number.isFinite(value.length) && value.length > 0 &&
    (value.axis === 'x' || value.axis === 'y' || value.axis === 'z');
}

function hasUnsupportedTransform(value: Record<string, unknown>): boolean {
  return UNSUPPORTED_PART_TRANSFORM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function blocked(reason: string): MotionEnvelopeBlocked {
  return { status: 'blocked', reason, axes: [], alerts: [], uncoveredParts: [] };
}

function toPlanBounds(bounds: { min: number[]; max: number[] }): MotionEnvelopeBounds {
  return { minX: bounds.min[0] as number, maxX: bounds.max[0] as number, minY: bounds.min[1] as number, maxY: bounds.max[1] as number };
}

function finiteBounds(bounds: MotionEnvelopeBounds): boolean {
  return [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite) &&
    bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY;
}

function translatedBounds(bounds: MotionEnvelopeBounds, dx: number, dy: number): MotionEnvelopeBounds {
  return { minX: bounds.minX + dx, maxX: bounds.maxX + dx, minY: bounds.minY + dy, maxY: bounds.maxY + dy };
}

function unionBounds(bounds: readonly MotionEnvelopeBounds[]): MotionEnvelopeBounds | undefined {
  if (bounds.length === 0) return undefined;
  return bounds.reduce((result, item) => ({
    minX: Math.min(result.minX, item.minX),
    maxX: Math.max(result.maxX, item.maxX),
    minY: Math.min(result.minY, item.minY),
    maxY: Math.max(result.maxY, item.maxY)
  }), { ...bounds[0] as MotionEnvelopeBounds });
}

/**
 * Sweep the current part AABB around a world-Z pivot through the signed angular range.
 * Rotating the current AABB (rather than the underlying primitive) is conservative.
 */
function rotarySweepBounds(
  current: MotionEnvelopeBounds,
  pivot: [number, number, number],
  axisZ: number,
  rangeDeg: number
): MotionEnvelopeBounds {
  const corners: [number, number][] = [
    [current.minX, current.minY], [current.minX, current.maxY],
    [current.maxX, current.minY], [current.maxX, current.maxY]
  ];
  const delta = axisZ * rangeDeg * Math.PI / 180;
  const xs: number[] = [];
  const ys: number[] = [];
  const addPoint = (x: number, y: number): void => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    xs.push(pivot[0] + dx * Math.cos(delta) - dy * Math.sin(delta));
    ys.push(pivot[1] + dx * Math.sin(delta) + dy * Math.cos(delta));
  };

  if (rangeDeg >= 360) {
    let radius = 0;
    for (const [x, y] of corners) radius = Math.max(radius, Math.hypot(x - pivot[0], y - pivot[1]));
    return { minX: pivot[0] - radius, maxX: pivot[0] + radius, minY: pivot[1] - radius, maxY: pivot[1] + radius };
  }

  const quarterTurn = Math.PI / 2;
  for (const [x, y] of corners) {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    const start = Math.atan2(dy, dx);
    const radius = Math.hypot(dx, dy);
    const candidates = [0, 1];
    if (Math.abs(delta) > Number.EPSILON) {
      const finish = start + delta;
      const low = Math.min(start, finish);
      const high = Math.max(start, finish);
      for (let turn = Math.floor(low / quarterTurn) - 1; turn <= Math.ceil(high / quarterTurn) + 1; turn += 1) {
        const angle = turn * quarterTurn;
        const ratio = (angle - start) / delta;
        if (ratio > 0 && ratio < 1) candidates.push(ratio);
      }
    }
    for (const ratio of candidates) {
      const angle = start + delta * ratio;
      xs.push(pivot[0] + radius * Math.cos(angle));
      ys.push(pivot[1] + radius * Math.sin(angle));
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function overlapBounds(a: MotionEnvelopeBounds, b: MotionEnvelopeBounds): MotionEnvelopeOverlap | null {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minY = Math.max(a.minY, b.minY);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX <= minX + OVERLAP_EPSILON_MM || maxY <= minY + OVERLAP_EPSILON_MM) return null;
  return { minX, maxX, minY, maxY, minZ: 0, maxZ: 0 };
}

function overlapVolume(a: MotionPartEnvelope, b: MotionPartEnvelope): MotionEnvelopeOverlap | null {
  const xy = overlapBounds(a.bounds, b.bounds);
  if (!xy) return null;
  const minZ = Math.max(a.minZ, b.minZ);
  const maxZ = Math.min(a.maxZ, b.maxZ);
  if (maxZ <= minZ + OVERLAP_EPSILON_MM) return null;
  return { ...xy, minZ, maxZ };
}

function axisName(kind: string): string {
  if (kind === 'linear') return '直线轴';
  if (kind === 'gripper') return '夹爪双指';
  if (kind === 'rotary') return '旋转轴';
  return `未知类型（${kind || '缺失'}）`;
}

function numberMm(value: number): string {
  const scaled = value * 10;
  if (!Number.isFinite(scaled)) return String(value);
  const rounded = Math.round(scaled) / 10;
  return `${Object.is(rounded, -0) ? 0 : rounded}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

/** A deterministic color for the independent per-axis overlay and its legend entry. */
export function motionEnvelopeColor(index: number): string {
  return ENVELOPE_COLORS[((index % ENVELOPE_COLORS.length) + ENVELOPE_COLORS.length) % ENVELOPE_COLORS.length] ?? '#c2410c';
}

/**
 * Compute conservative XY swept AABBs from the current MachineGeometry snapshot.
 * This function is intentionally independent of reviewDesign and never changes review pass/errors.
 */
export function analyzeConceptMotionEnvelopes(input: unknown): MotionEnvelopeAnalysis {
  if (!isRecord(input) || input.kind !== 'machine-geometry' || input.schemaVersion !== 1 ||
      input.units !== 'mm' || input.upAxis !== 'z' || input.geometryFidelity !== 'conceptual-estimate') {
    return blocked('MachineGeometry 版本、单位、Z-up 或概念几何来源不明确；运动包络未生成。');
  }
  if (!Array.isArray(input.parts) || input.parts.length === 0 || !Array.isArray(input.stations) || input.stations.length === 0 || !Array.isArray(input.moving)) {
    return blocked('MachineGeometry 零件、工位或运动轴数据缺失；运动包络未生成。');
  }

  const stationById = new Map<string, { actuatorIds: Set<string> }>();
  const actuatorOwner = new Map<string, string>();
  for (const raw of input.stations) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !/^[a-z0-9-]+$/.test(raw.id) ||
        !Array.isArray(raw.actuatorIds) || raw.actuatorIds.some((id) => typeof id !== 'string') || stationById.has(raw.id)) {
      return blocked('工位 ID 或执行机构映射无效；运动包络未生成。');
    }
    const actuatorIds = raw.actuatorIds as string[];
    if (new Set(actuatorIds).size !== actuatorIds.length || actuatorIds.some((id) => actuatorOwner.has(id))) {
      return blocked('执行机构 ID 在工位映射中重复；运动包络未生成。');
    }
    for (const id of actuatorIds) actuatorOwner.set(id, raw.id);
    stationById.set(raw.id, { actuatorIds: new Set(actuatorIds) });
  }

  const parts: GeomPart[] = [];
  const partById = new Map<string, GeomPart>();
  const boundsByPart = new Map<string, MotionPartEnvelope>();
  for (const raw of input.parts) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !/^[a-z0-9-]+$/.test(raw.id) || partById.has(raw.id) ||
        typeof raw.name !== 'string' || !raw.name.trim() || !validShape(raw.shape) || !finiteVec3(raw.center) ||
        typeof raw.rotationZDeg !== 'number' || !Number.isFinite(raw.rotationZDeg) ||
        (raw.stationId !== undefined && (typeof raw.stationId !== 'string' || !stationById.has(raw.stationId))) ||
        (raw.moving !== undefined && typeof raw.moving !== 'boolean')) {
      return blocked('存在重复 ID、未知变换、尺寸无效或工位映射断裂的几何零件；运动包络未生成。');
    }
    if (hasUnsupportedTransform(raw) || (isRecord(raw.shape) && hasUnsupportedTransform(raw.shape))) {
      return blocked(`零件 ${raw.id} 含未支持的坐标变换；运动包络未生成。`);
    }
    const part = raw as unknown as GeomPart;
    const box = partBounds(part);
    const bounds = toPlanBounds(box);
    const volume: MotionPartEnvelope = { partId: part.id, partName: part.name, bounds, minZ: box.min[2] as number, maxZ: box.max[2] as number };
    if (!finiteBounds(bounds) || !Number.isFinite(volume.minZ) || !Number.isFinite(volume.maxZ) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY || volume.maxZ <= volume.minZ) {
      return blocked(`零件 ${part.id} 的当前 XY AABB 无效；运动包络未生成。`);
    }
    parts.push(part);
    partById.set(part.id, part);
    boundsByPart.set(part.id, volume);
  }

  const rawAxes = input.moving as unknown[];
  const referenceCounts = new Map<string, number>();
  const referencedPartIds = new Set<string>();
  const actuatorCounts = new Map<string, number>();
  for (const raw of rawAxes) {
    if (!isRecord(raw)) continue;
    if (typeof raw.actuatorId === 'string') actuatorCounts.set(raw.actuatorId, (actuatorCounts.get(raw.actuatorId) ?? 0) + 1);
    if (Array.isArray(raw.partIds)) {
      for (const id of raw.partIds) {
        if (typeof id !== 'string') continue;
        referencedPartIds.add(id);
        referenceCounts.set(id, (referenceCounts.get(id) ?? 0) + 1);
      }
    }
  }

  const axes: MotionAxisEnvelope[] = [];
  const supportedEntries: Array<{ axis: MotionAxisEnvelope; envelope: MotionPartEnvelope }> = [];
  const axisMembersById = new Map<string, Set<string>>();
  for (const [index, raw] of rawAxes.entries()) {
    const fallbackId = `未命名轴-${index + 1}`;
    if (!isRecord(raw)) {
      axes.push({ actuatorId: fallbackId, stationId: '', kind: '', coverage: 'uncovered', parts: [], reason: '轴数据不是有效对象，已阻断该轴包络。' });
      continue;
    }
    const axis = raw as unknown as GeomMovingAxis;
    const actuatorId = typeof raw.actuatorId === 'string' && raw.actuatorId ? raw.actuatorId : fallbackId;
    const stationId = typeof raw.stationId === 'string' ? raw.stationId : '';
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    const mappedPartIds = Array.isArray(raw.partIds) && raw.partIds.every((id) => typeof id === 'string') ? raw.partIds as string[] : [];
    const members = mappedPartIds.map((id) => partById.get(id)).filter((part): part is GeomPart => Boolean(part));
    const base: MotionAxisEnvelope = {
      actuatorId,
      stationId,
      kind,
      coverage: 'uncovered',
      ...(typeof raw.strokeMm === 'number' ? { strokeMm: raw.strokeMm } : {}),
      ...(typeof raw.rangeDeg === 'number' ? { rangeDeg: raw.rangeDeg } : {}),
      parts: []
    };
    axisMembersById.set(actuatorId, new Set(mappedPartIds));

    let reason: string | null = null;
    const station = stationById.get(stationId);
    if (!actuatorId || actuatorId === fallbackId || !stationId || !station || !station.actuatorIds.has(actuatorId)) {
      reason = '执行机构 ID 与工位 actuatorIds 未能一一对应，已阻断该轴包络。';
    } else if ((actuatorCounts.get(actuatorId) ?? 0) !== 1) {
      reason = '执行机构映射缺失或重复，已阻断该轴包络。';
    } else if (!Array.isArray(raw.partIds) || mappedPartIds.length === 0 || new Set(mappedPartIds).size !== mappedPartIds.length) {
      reason = '随动零件 ID 缺失、重复或格式错误，已阻断该轴包络。';
    } else if (members.length !== mappedPartIds.length || members.some((part) =>
      part.stationId !== stationId || part.actuatorId !== actuatorId || part.moving !== true || (referenceCounts.get(part.id) ?? 0) !== 1)) {
      reason = '轴与随动零件的 ID/工位/执行机构/moving 标记关联不一致，已阻断该轴包络。';
    } else if (axis.kind !== 'linear' && axis.kind !== 'gripper' && axis.kind !== 'rotary') {
      reason = '运动类型未知或不受支持，已阻断该轴包络。';
    } else if (!finiteVec3(raw.axis) || Math.abs(Math.hypot(...raw.axis) - 1) > UNIT_AXIS_TOLERANCE) {
      reason = '3D 轴向缺失或不是已归一化的单位向量，已阻断该轴包络。';
    } else if (!finiteVec3(raw.pivot)) {
      reason = '枢轴/安装点缺失或非有限数，已阻断该轴包络。';
    } else if (typeof raw.strokeMm !== 'number' || !Number.isFinite(raw.strokeMm) || raw.strokeMm < 0) {
      reason = '行程为负数、非有限数或缺失，已阻断该轴包络。';
    } else if (typeof raw.rangeDeg !== 'number' || !Number.isFinite(raw.rangeDeg) || raw.rangeDeg < 0) {
      reason = '角度范围为负数、非有限数或缺失，已阻断该轴包络。';
    } else if (axis.kind === 'linear' && (axis.home !== 'retracted' || axis.rangeDeg !== 0 || axis.jaws !== undefined)) {
      reason = '直线轴 home/range/jaws 变换字段不符合已支持模型，已阻断该轴包络。';
    } else if (axis.kind === 'gripper' && (axis.home !== 'open' || axis.rangeDeg !== 0 || !Array.isArray(axis.jaws) || axis.jaws.length !== 2 || axis.jaws.length !== mappedPartIds.length ||
        axis.jaws.some((jaw) => !jaw || (jaw.sign !== 1 && jaw.sign !== -1)) ||
        new Set(axis.jaws.map((jaw) => jaw.partId)).size !== 2 ||
        new Set(axis.jaws.map((jaw) => jaw.sign)).size !== 2 ||
        axis.jaws.some((jaw) => !mappedPartIds.includes(jaw.partId)) || mappedPartIds.some((id) => !axis.jaws?.some((jaw) => jaw.partId === id)))) {
      reason = '夹爪 home/jaws 双指 ±sign 映射不完整，已阻断该轴包络。';
    } else if (axis.kind === 'rotary' && (axis.home !== 'zero' || axis.strokeMm !== 0 || axis.jaws !== undefined)) {
      reason = '旋转轴 home/stroke/jaws 字段不符合已支持模型，已阻断该轴包络。';
    } else if (axis.kind === 'rotary' && (Math.abs(axis.axis[0]) > ROTARY_AXIS_TOLERANCE || Math.abs(axis.axis[1]) > ROTARY_AXIS_TOLERANCE || Math.abs(Math.abs(axis.axis[2]) - 1) > ROTARY_AXIS_TOLERANCE)) {
      reason = '当前只覆盖严格的世界 Z 轴旋转；该 rotary 轴未覆盖。';
    }

    if (!reason && axis.kind === 'gripper' && axis.jaws?.some((jaw) => {
      const part = partById.get(jaw.partId);
      return !part || !mappedPartIds.includes(jaw.partId) || part.stationId !== stationId || part.actuatorId !== actuatorId || part.moving !== true;
    })) {
      reason = '夹爪 jaws 与实际随动零件映射不一致，已阻断该轴包络。';
    }

    if (reason) {
      axes.push({ ...base, reason });
      continue;
    }

    const envelopes: MotionPartEnvelope[] = [];
    const currentBounds = members.map((part) => ({ part, current: boundsByPart.get(part.id) as MotionPartEnvelope }));
    for (const { part, current } of currentBounds) {
      const bounds = current.bounds;
      let swept: MotionEnvelopeBounds;
      let minZ = current.minZ;
      let maxZ = current.maxZ;
      if (axis.kind === 'linear') {
        const dx = axis.axis[0] * axis.strokeMm;
        const dy = axis.axis[1] * axis.strokeMm;
        const dz = axis.axis[2] * axis.strokeMm;
        const atExtreme = translatedBounds(bounds, dx, dy);
        minZ = Math.min(current.minZ, current.minZ + dz);
        maxZ = Math.max(current.maxZ, current.maxZ + dz);
        swept = {
          minX: Math.min(bounds.minX, atExtreme.minX), maxX: Math.max(bounds.maxX, atExtreme.maxX),
          minY: Math.min(bounds.minY, atExtreme.minY), maxY: Math.max(bounds.maxY, atExtreme.maxY)
        };
      } else if (axis.kind === 'gripper') {
        const jaw = axis.jaws?.find((item) => item.partId === part.id);
        if (!jaw) {
          reason = `夹指 ${part.id} 没有 jaw sign 映射，已阻断该轴包络。`;
          break;
        }
        const distance = axis.strokeMm / 2 * jaw.sign;
        const atExtreme = translatedBounds(bounds, axis.axis[0] * distance, axis.axis[1] * distance);
        const dz = axis.axis[2] * distance;
        minZ = Math.min(current.minZ, current.minZ + dz);
        maxZ = Math.max(current.maxZ, current.maxZ + dz);
        swept = {
          minX: Math.min(bounds.minX, atExtreme.minX), maxX: Math.max(bounds.maxX, atExtreme.maxX),
          minY: Math.min(bounds.minY, atExtreme.minY), maxY: Math.max(bounds.maxY, atExtreme.maxY)
        };
      } else {
        swept = rotarySweepBounds(bounds, axis.pivot, axis.axis[2], axis.rangeDeg);
      }
      if (!finiteBounds(swept)) {
        reason = `零件 ${part.id} 的 swept XY AABB 计算出现非有限数，已阻断该轴包络。`;
        break;
      }
      if (!Number.isFinite(minZ) || !Number.isFinite(maxZ) || maxZ <= minZ) {
        reason = `零件 ${part.id} 的 swept Z AABB 无效，已阻断该轴包络。`;
        break;
      }
      envelopes.push({ partId: part.id, partName: part.name, bounds: swept, minZ, maxZ });
    }
    if (reason) {
      axes.push({ ...base, reason });
      continue;
    }
    const combined = unionBounds(envelopes.map((item) => item.bounds));
    if (!combined || !finiteBounds(combined)) {
      axes.push({ ...base, reason: '运动件没有有效 swept AABB，已阻断该轴包络。' });
      continue;
    }
    const covered: MotionAxisEnvelope = { ...base, coverage: 'covered', bounds: combined, parts: envelopes };
    axes.push(covered);
    for (const envelope of envelopes) supportedEntries.push({ axis: covered, envelope });
  }

  const coveredPartIds = new Set(supportedEntries.map((entry) => entry.envelope.partId));
  const uncoveredParts: UncoveredMotionPart[] = [];
  for (const part of parts) {
    if (part.moving === true && !referencedPartIds.has(part.id)) {
      uncoveredParts.push({ partId: part.id, partName: part.name, reason: '零件标记为 moving=true，但没有 GeomMovingAxis.partIds 关联；未覆盖运动。' });
    } else if (part.moving === true && !coveredPartIds.has(part.id)) {
      uncoveredParts.push({ partId: part.id, partName: part.name, reason: '关联轴未覆盖；此处只保留当前位置 AABB，不代表其完整运动包络。' });
    }
  }

  const alerts: MotionEnvelopeAlert[] = [];
  const staticParts = parts.filter((part) => part.moving !== true && !referencedPartIds.has(part.id));
  const homeOnlyParts = parts.filter((part) => part.moving === true && !coveredPartIds.has(part.id));
  for (const { axis, envelope } of supportedEntries) {
    for (const other of staticParts) {
      if (other.id === envelope.partId) continue;
      const otherBounds = boundsByPart.get(other.id);
      const overlap = otherBounds ? overlapVolume(envelope, otherBounds) : null;
      if (overlap) alerts.push({
        moving: { actuatorId: axis.actuatorId, partId: envelope.partId, partName: envelope.partName },
        other: { kind: 'static', partId: other.id, partName: other.name },
        overlap
      });
    }
    for (const other of homeOnlyParts) {
      if (other.id === envelope.partId) continue;
      const otherBounds = boundsByPart.get(other.id);
      const overlap = otherBounds ? overlapVolume(envelope, otherBounds) : null;
      if (overlap) {
        const otherAxis = axes.find((candidate) => candidate.coverage === 'uncovered' && axisMembersById.get(candidate.actuatorId)?.has(other.id));
        alerts.push({
          moving: { actuatorId: axis.actuatorId, partId: envelope.partId, partName: envelope.partName },
          other: { kind: 'moving-home-only', ...(otherAxis ? { actuatorId: otherAxis.actuatorId } : {}), partId: other.id, partName: other.name },
          overlap
        });
      }
    }
  }
  for (let leftIndex = 0; leftIndex < supportedEntries.length; leftIndex += 1) {
    const left = supportedEntries[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < supportedEntries.length; rightIndex += 1) {
      const right = supportedEntries[rightIndex];
      if (!right || left.axis.actuatorId === right.axis.actuatorId) continue;
      const overlap = overlapVolume(left.envelope, right.envelope);
      if (overlap) alerts.push({
        moving: { actuatorId: left.axis.actuatorId, partId: left.envelope.partId, partName: left.envelope.partName },
        other: { kind: 'moving-sweep', actuatorId: right.axis.actuatorId, partId: right.envelope.partId, partName: right.envelope.partName },
        overlap
      });
    }
  }
  alerts.sort((a, b) => a.moving.actuatorId.localeCompare(b.moving.actuatorId) || a.moving.partId.localeCompare(b.moving.partId) || a.other.partId.localeCompare(b.other.partId));

  return { status: 'computed', source: 'machine-geometry.parts+moving', units: 'mm', axes, alerts, uncoveredParts };
}

/** Concise, phone-readable engineer panel. Its wording deliberately never grants a pass/sign-off. */
export function renderMotionEnvelopePanel(analysis: MotionEnvelopeAnalysis): string {
  if (analysis.status === 'blocked') {
    return `<section class="design-motion-envelope blocked" data-motion-envelope-status="blocked" aria-label="概念运动包络提醒"><h4>概念运动包络 · 未生成</h4><p>${escapeHtml(analysis.reason)}</p><p>这是独立提醒，不修改 reviewed geometry pass/errors；不能据此判断无干涉或校核通过。</p></section>`;
  }

  const coveredCount = analysis.axes.filter((axis) => axis.coverage === 'covered').length;
  const uncoveredAxisCount = analysis.axes.length - coveredCount;
  const uncoveredPartCount = analysis.uncoveredParts.length;
  const axisRows = analysis.axes.map((axis, index) => {
    const label = `${axisName(axis.kind)} ${axis.actuatorId} · ${axis.stationId || '工位未映射'}`;
    const details = axis.coverage === 'covered' && axis.bounds
      ? axis.kind === 'rotary'
        ? `角度 0→${numberMm(axis.rangeDeg ?? 0)}°；XY X ${numberMm(axis.bounds.minX)}～${numberMm(axis.bounds.maxX)} mm，Y ${numberMm(axis.bounds.minY)}～${numberMm(axis.bounds.maxY)} mm`
        : axis.kind === 'gripper'
          ? `双指总行程 ${numberMm(axis.strokeMm ?? 0)} mm（每指 ±${numberMm((axis.strokeMm ?? 0) / 2)} mm）；XY X ${numberMm(axis.bounds.minX)}～${numberMm(axis.bounds.maxX)} mm，Y ${numberMm(axis.bounds.minY)}～${numberMm(axis.bounds.maxY)} mm`
          : `全行程 ${numberMm(axis.strokeMm ?? 0)} mm；XY X ${numberMm(axis.bounds.minX)}～${numberMm(axis.bounds.maxX)} mm，Y ${numberMm(axis.bounds.minY)}～${numberMm(axis.bounds.maxY)} mm`
      : axis.reason ?? '运动信息不完整；未覆盖。';
    const memberNames = axis.parts.length ? `<small>${axis.parts.map((part) => escapeHtml(`${part.partName}（${part.partId}）`)).join('、')}</small>` : '';
    return `<li data-motion-axis-id="${escapeHtml(axis.actuatorId)}" data-motion-coverage="${axis.coverage}"><i style="--motion-color:${motionEnvelopeColor(index)}"></i><div><b>${escapeHtml(label)} · ${axis.coverage === 'covered' ? '已估算' : '未覆盖'}</b><span>${escapeHtml(details)}</span>${memberNames}</div></li>`;
  }).join('');
  const orphanRows = analysis.uncoveredParts.map((part) => `<li data-motion-uncovered-part="${escapeHtml(part.partId)}"><b>${escapeHtml(part.partName)}（${escapeHtml(part.partId)}）</b><span>${escapeHtml(part.reason)}</span></li>`).join('');
  const alertRows = analysis.alerts.slice(0, 40).map((alert) => {
    const counterpart = alert.other.kind === 'moving-sweep'
      ? `另一运动包络 ${alert.other.actuatorId ?? ''} · ${alert.other.partName}（${alert.other.partId}）`
      : alert.other.kind === 'moving-home-only'
        ? `未覆盖运动件当前位置 AABB ${alert.other.actuatorId ? `${alert.other.actuatorId} · ` : ''}${alert.other.partName}（${alert.other.partId}）`
        : `静止件 ${alert.other.partName}（${alert.other.partId}）`;
    return `<li>${escapeHtml(alert.moving.actuatorId)} · ${escapeHtml(alert.moving.partName)}（${escapeHtml(alert.moving.partId)}） ↔ ${escapeHtml(counterpart)}；3D AABB 相交 X ${numberMm(alert.overlap.minX)}～${numberMm(alert.overlap.maxX)} mm，Y ${numberMm(alert.overlap.minY)}～${numberMm(alert.overlap.maxY)} mm，Z ${numberMm(alert.overlap.minZ)}～${numberMm(alert.overlap.maxZ)} mm</li>`;
  }).join('');
  const alertSection = analysis.alerts.length
    ? `<details class="design-motion-alerts" open><summary>需人工复核：${analysis.alerts.length} 对 3D AABB 候选相交</summary><ul>${alertRows}</ul>${analysis.alerts.length > 40 ? `<p>另有 ${analysis.alerts.length - 40} 对未展开；完整结果仍由分析数据保留。</p>` : ''}</details>`
    : '<p class="design-motion-no-overlap">本次未发现 3D AABB 重叠；这不表示无干涉，也不表示校核通过。</p>';
  const axisContent = axisRows || '<li>当前没有可计算的 GeomMovingAxis；不代表几何没有运动。</li>';
  const uncoveredContent = orphanRows ? `<h5>未关联运动轴的零件</h5><ul class="design-motion-uncovered">${orphanRows}</ul>` : '';
  return `<section class="design-motion-envelope" data-motion-envelope-status="computed" aria-label="概念运动包络提醒"><h4>概念运动包络 · 只作初筛提醒</h4><p class="design-motion-summary">${coveredCount} 轴已估算 · ${uncoveredAxisCount} 轴未覆盖 · ${uncoveredPartCount} 件未覆盖 · ${analysis.alerts.length} 对需人工复核；未知运动不外推。</p><ul class="design-motion-axes">${axisContent}</ul>${uncoveredContent}${alertSection}<p class="design-motion-caveat">模型是概念估算；图中显示保守 XY AABB，告警另以 Z 范围过滤 3D AABB 候选相交，仍可能误报或漏掉非 AABB 细节。未建模线缆、夹具细节及真实机构，同轴内部零件相互关系也未在本层判定。即使没有 AABB 重叠，也不表示无干涉或校核通过；请工程师人工复核并使用真实 CAD 与适当的工程校核。</p></section>`;
}
