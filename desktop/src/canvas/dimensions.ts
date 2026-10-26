// 2D 正交视图尺寸链（纯几何，无 DOM）
//
// 目的：非标排布最常问的三个数——整体包络多大、工位中心距多少、选中的这一站离上下游多远。
// 不画真装配位置：画布的 ortho 坐标是示意布局，工位包围盒允许重叠；
// 重叠不隐藏，明确报「n 处重叠（示意坐标）」，避免把示意图当装配图。
import type { OrthoStation } from './view-model.ts';
import type { MachineGraph } from './types.ts';

export type DimensionAxis = 'x' | 'y';
export type DimensionKind = 'overall' | 'pitch' | 'selection';

export interface DimensionChain {
  id: string;
  kind: DimensionKind;
  axis: DimensionAxis;
  /** 起止（mm），用于画线。 */
  fromMm: number;
  toMm: number;
  /** 标注值（mm，绝对值；重叠时为负的真实差值，见 note）。 */
  valueMm: number;
  text: string;
  /** 显示层级：0 = 最外，越大越靠近图形。 */
  level: number;
  /** 关联节点（pitch/selection 才有）。 */
  nodeIds: string[];
  /** 供渲染时避让：1 = 正常，-1 = 重叠/异常需标红。 */
  direction: 1 | -1;
}

export interface DimensionsResult {
  chains: DimensionChain[];
  /** 工位包围盒重叠对（示意坐标，不是碰撞结论）。 */
  overlaps: Array<{ a: string; b: string; overlapMm: number }>;
  /** 面板上的一句话。 */
  note: string;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function fmt(value: number): string {
  return `${round(value)}`;
}

/** 整体包络 + 依次中心距 + （可选）选中工位与上下游的关系。 */
export function buildDimensions(view: { stations: readonly OrthoStation[]; boundsMm: { minX: number; minY: number; maxX: number; maxY: number } }, selectedId: string | null = null): DimensionsResult {
  const chains: DimensionChain[] = [];
  const stations = view.stations;
  const bounds = view.boundsMm;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width > 0) {
    chains.push({
      id: 'dim-overall-x',
      kind: 'overall',
      axis: 'x',
      fromMm: bounds.minX,
      toMm: bounds.maxX,
      valueMm: round(width),
      text: `总宽 ${fmt(width)}（含行程包络）`,
      level: 0,
      nodeIds: [],
      direction: 1
    });
  }
  if (height > 0) {
    chains.push({
      id: 'dim-overall-y',
      kind: 'overall',
      axis: 'y',
      fromMm: bounds.minY,
      toMm: bounds.maxY,
      valueMm: round(height),
      text: `总高 ${fmt(height)}（含行程包络）`,
      level: 1,
      nodeIds: [],
      direction: 1
    });
  }

  const sorted = [...stations].sort((a, b) => a.mmX - b.mmX || a.id.localeCompare(b.id));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    const pitch = round((current.mmX + current.mmWidth / 2) - (previous.mmX + previous.mmWidth / 2));
    chains.push({
      id: `dim-pitch-${previous.id}-${current.id}`,
      kind: 'pitch',
      axis: 'x',
      fromMm: previous.mmX + previous.mmWidth / 2,
      toMm: current.mmX + current.mmWidth / 2,
      valueMm: pitch,
      text: `${fmt(Math.abs(pitch))}`,
      level: 2 + (index % 2),
      nodeIds: [previous.id, current.id],
      direction: pitch >= 0 ? 1 : -1
    });
  }

  // 重叠检测：只在示意坐标上比较，明确不是干涉结论
  const overlaps: Array<{ a: string; b: string; overlapMm: number }> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const overlapX = Math.min(a.mmX + a.mmWidth, b.mmX + b.mmWidth) - Math.max(a.mmX, b.mmX);
      const overlapY = Math.min(a.mmY + a.mmHeight, b.mmY + b.mmHeight) - Math.max(a.mmY, b.mmY);
      if (overlapX > 0 && overlapY > 0) {
        overlaps.push({ a: a.id, b: b.id, overlapMm: round(Math.min(overlapX, overlapY)) });
      }
    }
  }

  if (selectedId) {
    const index = sorted.findIndex((station) => station.id === selectedId);
    if (index >= 0) {
      const station = sorted[index]!;
      const upstream = index > 0 ? sorted[index - 1]! : null;
      const downstream = index + 1 < sorted.length ? sorted[index + 1]! : null;
      const center = station.mmX + station.mmWidth / 2;
      if (upstream) {
        const upCenter = upstream.mmX + upstream.mmWidth / 2;
        chains.push({
          id: `dim-sel-up-${station.id}`,
          kind: 'selection',
          axis: 'x',
          fromMm: upCenter,
          toMm: center,
          valueMm: round(center - upCenter),
          text: `上游 ${fmt(center - upCenter)}`,
          level: 4,
          nodeIds: [upstream.id, station.id],
          direction: 1
        });
      }
      if (downstream) {
        const downCenter = downstream.mmX + downstream.mmWidth / 2;
        chains.push({
          id: `dim-sel-down-${station.id}`,
          kind: 'selection',
          axis: 'x',
          fromMm: center,
          toMm: downCenter,
          valueMm: round(downCenter - center),
          text: `下游 ${fmt(downCenter - center)}`,
          level: 5,
          nodeIds: [station.id, downstream.id],
          direction: 1
        });
      }
    }
  }

  const noteParts = [`包络 ${fmt(width)}×${fmt(height)}mm（含运动包络）`, `${sorted.length} 个工位`];
  if (sorted.length > 1) noteParts.push(`中心距 ${chains.filter((chain) => chain.kind === 'pitch').length} 段`);
  if (overlaps.length > 0) noteParts.push(`${overlaps.length} 处包围盒重叠（示意坐标，非干涉结论）`);
  return { chains, overlaps, note: noteParts.join(' · ') };
}

/** 选中节点的四至关系（左/右/上/下到包络边），检查器用。 */
export function selectionToBounds(graph: MachineGraph, stations: readonly OrthoStation[], nodeId: string): string[] {
  const station = stations.find((item) => item.id === nodeId);
  if (!station) return [];
  const bounds = stations.reduce(
    (acc, item) => ({
      minX: Math.min(acc.minX, item.mmX),
      minY: Math.min(acc.minY, item.mmY),
      maxX: Math.max(acc.maxX, item.mmX + item.mmWidth),
      maxY: Math.max(acc.maxY, item.mmY + item.mmHeight)
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );
  if (!Number.isFinite(bounds.minX)) return [];
  const node = graph.nodes.find((item) => item.id === nodeId);
  const name = node?.name ?? nodeId;
  return [
    `${name}：距左 ${fmt(station.mmX - bounds.minX)} · 距右 ${fmt(bounds.maxX - (station.mmX + station.mmWidth))}mm`,
    `距下 ${fmt(station.mmY - bounds.minY)} · 距上 ${fmt(bounds.maxY - (station.mmY + station.mmHeight))}mm`
  ];
}
