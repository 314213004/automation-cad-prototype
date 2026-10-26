// 自动布局（纯几何）：按拓扑层级从左到右排，同层按 y 堆叠
//
// 用途：手工加了一堆节点、或者从方案库载入别人改过的图之后，一键把坐标理顺。
// 只动 pos（拓扑卡片 px）与 ortho（2D mm），不动节点尺寸/端口/节拍——布局不该改设计数据。
//
// 层号用 Kahn 拓扑排序：有环时剩下的节点单独放到最后一层（不抛错，画布上环是允许存在的，
// 只是流程上没意义，交给人在检查器里看）。
import type { CanvasNode, MachineGraph } from './types.ts';

export interface AutoLayoutOptions {
  /** 层间距（mm）。 */
  gapXMm?: number;
  /** 同层纵向间距（mm）。 */
  gapYMm?: number;
  /** 左上角留白（mm）。 */
  paddingMm?: number;
}

export interface AutoLayoutResult {
  graph: MachineGraph;
  layers: number;
  moved: number;
}

const LAYOUT_PX_PER_MM = 0.55;
const LAYOUT_PX_PADDING = 60;
const DEFAULT_HEIGHT_MM = 60;

/** Kahn 分层：返回 nodeId → 层号。环上的节点统一放到最后一层。 */
export function assignLayers(graph: MachineGraph): Map<string, number> {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const layers = new Map<string, number>();
  for (const node of graph.nodes) layers.set(node.id, 0);
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const processed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (processed.has(id)) continue;
    processed.add(id);
    for (const next of outgoing.get(id) ?? []) {
      layers.set(next, Math.max(layers.get(next) ?? 0, (layers.get(id) ?? 0) + 1));
      const remaining = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, remaining);
      if (remaining <= 0) queue.push(next);
    }
  }
  const maxLayer = Math.max(0, ...[...layers.values()]);
  for (const node of graph.nodes) {
    if (!processed.has(node.id)) layers.set(node.id, maxLayer + 1);
  }
  return layers;
}

export function autoLayout(graph: MachineGraph, options: AutoLayoutOptions = {}): AutoLayoutResult {
  const gapX = options.gapXMm ?? 80;
  const gapY = options.gapYMm ?? 40;
  const padding = options.paddingMm ?? 0;
  const layers = assignLayers(graph);
  const layerCount = Math.max(0, ...[...layers.values()].map((value) => value + 1));

  // 每层宽度取该层最宽节点，层 x 依次累加
  const layerWidths = new Array<number>(layerCount).fill(0);
  for (const node of graph.nodes) {
    const layer = layers.get(node.id) ?? 0;
    layerWidths[layer] = Math.max(layerWidths[layer] ?? 0, node.dimsMm[0] ?? 0);
  }
  const layerX: number[] = [];
  let cursor = padding;
  for (let index = 0; index < layerCount; index += 1) {
    layerX[index] = cursor;
    cursor += (layerWidths[index] ?? 0) + gapX;
  }

  const next = new Map<string, { x: number; y: number }>();
  let moved = 0;
  for (let index = 0; index < layerCount; index += 1) {
    const members = graph.nodes
      .filter((node) => (layers.get(node.id) ?? 0) === index)
      .sort((a, b) => (a.ortho.y - b.ortho.y) || a.id.localeCompare(b.id));
    let y = padding;
    for (const node of members) {
      const x = layerX[index] ?? padding;
      next.set(node.id, { x, y });
      y += Math.max(node.dimsMm[1] ?? DEFAULT_HEIGHT_MM, DEFAULT_HEIGHT_MM) + gapY;
    }
  }

  const nodes: CanvasNode[] = graph.nodes.map((node) => {
    const target = next.get(node.id);
    if (!target) return node;
    if (target.x !== node.ortho.x || target.y !== node.ortho.y) moved += 1;
    return {
      ...node,
      ortho: { x: Math.round(target.x * 10) / 10, y: Math.round(target.y * 10) / 10 },
      pos: {
        x: Math.round(LAYOUT_PX_PADDING + target.x * LAYOUT_PX_PER_MM),
        y: Math.round(LAYOUT_PX_PADDING + target.y * LAYOUT_PX_PER_MM)
      }
    };
  });

  return { graph: { ...graph, nodes }, layers: layerCount, moved };
}
