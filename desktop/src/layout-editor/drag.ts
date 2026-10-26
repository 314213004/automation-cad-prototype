/**
 * 整机布局编辑：一次拖动的纯计算（无 DOM / three）。
 *
 * 视口每帧给出 gizmo 的原始位移 / 转角，这里统一做：锁轴 → 特征吸附 / 网格吸附（作用于主工位
 * 的主数据偏移）→ 角度吸附 → 多选整体变换（composeGroupTransform）。返回各工位新位姿、
 * 实际采用的增量（gizmo 需回写到吸附后的位置）与参考线。
 */
import { composeGroupTransform, boxToRect, type LayoutModel, type LayoutStationUnit } from './model.ts';
import type { DragHandle, LayoutPose } from './numeric.ts';
import { snapAngleDeg, snapTranslation, type Rect2, type SnapGuide, type SnapTarget } from './snap.ts';
import { FRAME_UNIT } from './collision.ts';

export interface SnapSettings {
  /** 0 = 关闭 */
  gridMm: number;
  /** 0 = 关闭 */
  angleDeg: number;
  /** 特征吸附（包络边/中线对齐） */
  features: boolean;
  /** 特征吸附容差（mm，由视口按约 8 px 换算） */
  toleranceMm: number;
}

export interface DragStart {
  stationIds: string[];
  /** 拖动开始时各工位（含位姿、枢轴） */
  stations: LayoutStationUnit[];
  /** 整体变换枢轴（单工位 = 工位原点；多选 = 合并包络中心） */
  center: [number, number];
  /** 移动工位合并 XY 包络（起点） */
  rect: Rect2;
  targets: SnapTarget[];
}

export interface DragResult {
  poses: Map<string, LayoutPose>;
  delta: { dx: number; dy: number; dRotationZDeg: number };
  guides: SnapGuide[];
}

function unionRect(rects: readonly Rect2[]): Rect2 {
  return rects.reduce((acc, rect) => ({
    minX: Math.min(acc.minX, rect.minX), maxX: Math.max(acc.maxX, rect.maxX),
    minY: Math.min(acc.minY, rect.minY), maxY: Math.max(acc.maxY, rect.maxY)
  }), { ...(rects[0] as Rect2) });
}

/** 建立拖动起点：被拖工位、枢轴、包络与吸附目标（其它工位 + 机架/输送零件包络）。 */
export function beginDrag(model: LayoutModel, stationIds: readonly string[]): DragStart {
  const stations = stationIds.map((id) => model.stations.find((station) => station.id === id)).filter((station): station is LayoutStationUnit => Boolean(station));
  if (stations.length === 0) throw new Error('没有可移动的工位');
  const rect = unionRect(stations.map((station) => boxToRect(station.bounds)));
  const center: [number, number] = stations.length === 1
    ? [(stations[0] as LayoutStationUnit).origin[0], (stations[0] as LayoutStationUnit).origin[1]]
    : [(rect.minX + rect.maxX) / 2, (rect.minY + rect.maxY) / 2];
  const moving = new Set(stations.map((station) => station.id));
  const targets: SnapTarget[] = [
    ...model.stations.filter((station) => !moving.has(station.id)).map((station) => ({ id: station.id, label: station.name, rect: boxToRect(station.bounds) })),
    ...model.parts.filter((part) => part.unitId === FRAME_UNIT && (part.role === 'transfer' || part.id === 'frame-top')).map((part) => ({ id: part.id, label: part.name, rect: boxToRect(part.bounds) })),
    ...(model.frameRect ? [{ id: 'frame', label: '机架外廓', rect: model.frameRect }] : [])
  ];
  return { stationIds: stations.map((station) => station.id), stations: stations.map((station) => ({ ...station, pose: { ...station.pose } })), center, rect, targets };
}

/** 拖动中一帧：raw 为 gizmo 相对起点的原始位移 / 转角。 */
export function dragFrame(
  start: DragStart,
  handle: DragHandle,
  raw: { dx: number; dy: number; dRotationZDeg: number },
  snap: SnapSettings
): DragResult {
  const primary = start.stations[0] as LayoutStationUnit;
  let dx = 0;
  let dy = 0;
  let dRotationZDeg = 0;
  let guides: SnapGuide[] = [];
  if (handle === 'RZ') {
    const target = snap.angleDeg > 0 ? snapAngleDeg(primary.pose.rotationZDeg + raw.dRotationZDeg, snap.angleDeg) : primary.pose.rotationZDeg + raw.dRotationZDeg;
    let delta = target - primary.pose.rotationZDeg;
    while (delta > 180) delta -= 360;
    while (delta <= -180) delta += 360;
    dRotationZDeg = Math.round(delta * 1000) / 1000;
  } else {
    const result = snapTranslation({
      startX: primary.pose.xMm,
      startY: primary.pose.yMm,
      rawX: primary.pose.xMm + raw.dx,
      rawY: primary.pose.yMm + raw.dy,
      gridMm: snap.gridMm,
      lockX: handle === 'Y',
      lockY: handle === 'X',
      ...(snap.features ? { startRect: start.rect, targets: start.targets, toleranceMm: snap.toleranceMm } : {})
    });
    dx = Math.round((result.x - primary.pose.xMm) * 1000) / 1000;
    dy = Math.round((result.y - primary.pose.yMm) * 1000) / 1000;
    guides = result.guides;
  }
  const poses = composeGroupTransform(start.stations, start.center, { dx, dy, dRotationZDeg });
  return { poses, delta: { dx, dy, dRotationZDeg }, guides };
}

/** 数值输入确认：主工位目标位姿 → 整体增量（多选时其余工位按同一增量刚体跟随）。 */
export function dragToPose(start: DragStart, target: LayoutPose): DragResult {
  const primary = start.stations[0] as LayoutStationUnit;
  const delta = {
    dx: Math.round((target.xMm - primary.pose.xMm) * 1000) / 1000,
    dy: Math.round((target.yMm - primary.pose.yMm) * 1000) / 1000,
    dRotationZDeg: Math.round((target.rotationZDeg - primary.pose.rotationZDeg) * 1000) / 1000
  };
  // 旋转时以主工位原点为枢轴，保证主工位精确落在输入值上
  const center: [number, number] = delta.dRotationZDeg !== 0 ? [primary.origin[0], primary.origin[1]] : start.center;
  return { poses: composeGroupTransform(start.stations, center, delta), delta, guides: [] };
}

/** 对齐/分布/阵列：XY 增量表 → 新位姿表（旋转不变）。 */
export function posesFromDeltas(model: LayoutModel, deltas: ReadonlyMap<string, { dx: number; dy: number }>): Map<string, LayoutPose> {
  const poses = new Map<string, LayoutPose>();
  for (const [id, delta] of deltas) {
    const station = model.stations.find((item) => item.id === id);
    if (!station || (delta.dx === 0 && delta.dy === 0)) continue;
    poses.set(id, {
      xMm: Math.round((station.pose.xMm + delta.dx) * 1000) / 1000,
      yMm: Math.round((station.pose.yMm + delta.dy) * 1000) / 1000,
      rotationZDeg: station.pose.rotationZDeg
    });
  }
  return poses;
}
