// 工位中心距编辑（纯逻辑）
//
// 非标排布最常改的数就是「这一站到上一站多远」。直接拖会同时动 X/Y，输入框只动 X，
// 并且以**上游中心为基准**移动当前站——这样上游不动、下游被推走的感觉和现场对间距的习惯一致。
//
// 只用 ortho 坐标（mm，Y 向下）与 dimsMm[0] 作为外形宽度，和 2D 视图/尺寸链同一套口径。
import type { CanvasNode, MachineGraph } from './types.ts';

export interface PitchEditResult {
  graph: MachineGraph;
  /** 实际上移动了多少 mm（正 = 向右）。 */
  movedMm: number;
  /** 移动后是否跨到了别的工位另一侧（顺序变了，尺寸链会重排）。 */
  reordered: boolean;
  error: string | null;
}

function centerMm(node: CanvasNode): number {
  return node.ortho.x + node.dimsMm[0] / 2;
}

/** 按 ortho.x 排序的工位序列（与 2D 尺寸链同一顺序）。 */
export function stationOrder(graph: MachineGraph): CanvasNode[] {
  return [...graph.nodes].sort((a, b) => a.ortho.x - b.ortho.x || a.id.localeCompare(b.id));
}

export function upstreamOf(graph: MachineGraph, nodeId: string): CanvasNode | null {
  const order = stationOrder(graph);
  const index = order.findIndex((node) => node.id === nodeId);
  if (index <= 0) return null;
  return order[index - 1] ?? null;
}

export function downstreamOf(graph: MachineGraph, nodeId: string): CanvasNode | null {
  const order = stationOrder(graph);
  const index = order.findIndex((node) => node.id === nodeId);
  if (index < 0 || index + 1 >= order.length) return null;
  return order[index + 1] ?? null;
}

/** 当前中心距：本节点中心 − 上游中心（无上游返回 null）。 */
export function currentPitchMm(graph: MachineGraph, nodeId: string): number | null {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const upstream = upstreamOf(graph, nodeId);
  if (!node || !upstream) return null;
  return Math.round((centerMm(node) - centerMm(upstream)) * 10) / 10;
}

/**
 * 把节点沿 X 挪到指定中心距。只改这一个节点的 ortho.x，其它节点坐标不动（纯函数）。
 * 间距必须为正——负间距意味着穿越，现场要的是「改小但不穿」。
 */
export function shiftToPitch(graph: MachineGraph, nodeId: string, pitchMm: number): PitchEditResult {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return { graph, movedMm: 0, reordered: false, error: `找不到节点 ${nodeId}` };
  const upstream = upstreamOf(graph, nodeId);
  if (!upstream) {
    return { graph, movedMm: 0, reordered: false, error: '该工位没有上游（已是序列最左），无法按中心距定位' };
  }
  if (!Number.isFinite(pitchMm)) return { graph, movedMm: 0, reordered: false, error: '中心距必须是数字' };
  if (pitchMm <= 0) return { graph, movedMm: 0, reordered: false, error: '中心距必须大于 0（负值表示工位穿越）' };

  const targetX = Math.round((centerMm(upstream) + pitchMm - node.dimsMm[0] / 2) * 10) / 10;
  const movedMm = Math.round((targetX - node.ortho.x) * 10) / 10;
  if (movedMm === 0) return { graph, movedMm: 0, reordered: false, error: null };
  const next: MachineGraph = {
    ...graph,
    nodes: graph.nodes.map((item) =>
      item.id === nodeId ? { ...item, ortho: { ...item.ortho, x: targetX } } : item
    )
  };
  // 顺序是否变化：看它的上游邻居换了没有（只比邻居，别比全集——节点自己永远在列表里）
  const reordered = (upstreamOf(next, nodeId)?.id ?? null) !== (upstreamOf(graph, nodeId)?.id ?? null);
  return { graph: next, movedMm, reordered, error: null };
}
