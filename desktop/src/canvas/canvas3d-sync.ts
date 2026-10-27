// 画布 ↔ 3D 双向增量同步（架构文档 12.2，第一步：纯逻辑层）
//
// 现状（文档 11 节 / 12.2 前言）：画布改参数后是全量重建 3D（build_canvas_assembly /
// pip3d.update 全量 clearRoot + 重建），3D 里拖零件也无法反向回写画布。
// 本模块只做不依赖 Three.js / DOM 的纯逻辑，UI 接线（workbench / pip3d.update 改为
// 增量更新）留给下一步，避免一次改动大文件。
//
// 与仓库现有字段对齐（不照搬文档原稿的 orthoX / orthoY / zBase 字段名）：
//   - 画布节点用 CanvasNode.ortho {x, y}（mm，俯视图）+ dimsMm [w, h, d]
//   - 3D 占位盒公式与 pip3d.buildPipBoxes 完全一致：
//       centerMm = [ortho.x + w/2, h/2, ortho.y + d/2]
//     其中 three 的 Y 是离地高度，Z 对应画布 ortho.y。pip3d 改公式时这里必须同步改。
//   - 反向：3D 盒中心（mm）→ ortho.x = centerX - w/2，ortho.y = centerZ - d/2，
//     四舍五入到整数 mm（文档原稿也是 round，不做亚毫米假精度）。
import type { CanvasEdge, CanvasNode, MachineGraph } from './types.ts';

/** 3D 占位盒（mm 单位，与 pip3d.PipBox 的米单位不同，这里只做同步计算，不画图）。 */
export interface SyncBoxMm {
  id: string;
  name: string;
  /** 盒中心 mm：[X, 离地高度中心, Z]，Z 对应画布 ortho.y。 */
  centerMm: [number, number, number];
  /** 盒尺寸 mm：[w, h, d]。 */
  sizeMm: [number, number, number];
  /** 运动包络 mm；直线轴有行程时沿 X 展开，否则等于 sizeMm。 */
  envelopeMm: [number, number, number];
  adapter: boolean;
}

export function pipBoxForNodeMm(node: CanvasNode): SyncBoxMm {
  const [w, h, d] = node.dimsMm;
  const moving = node.kind === 'linear' && node.strokeMm > 0;
  return {
    id: node.id,
    name: node.name,
    centerMm: [node.ortho.x + w / 2, h / 2, node.ortho.y + d / 2],
    sizeMm: [w, h, d],
    envelopeMm: moving ? [w + node.strokeMm, h, d] : [w, h, d],
    adapter: node.kind === 'adapter' || node.adapter === true
  };
}

/**
 * 脏子树：从 rootId 出发沿边 from→to 做 BFS，返回去重后的下游节点 id（含 root）。
 * 环、重复边、自环都不会死循环；root 不在图中时返回 []（不猜）。
 */
export function dirtySubtree(rootId: string, edges: readonly CanvasEdge[]): string[] {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [rootId];
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++]!;
    if (seen.has(curr)) continue;
    seen.add(curr);
    order.push(curr);
    for (const next of children.get(curr) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  // root 本身不在任何节点里时，上面仍会返回 [root]；调用方用图校验，见 dirtySubtreeOfGraph。
  return order;
}

/** 图级别的脏子树：root 不在图中返回 []，否则返回 BFS 下游（含 root）。 */
export function dirtySubtreeOfGraph(rootId: string, graph: MachineGraph): string[] {
  if (!graph.nodes.some((node) => node.id === rootId)) return [];
  return dirtySubtree(rootId, graph.edges);
}

/** 仅对脏节点重新算 3D 占位盒；未变更节点不重算（增量更新的核心）。 */
export function incrementalBoxesMm(graph: MachineGraph, dirtyIds: readonly string[]): SyncBoxMm[] {
  const dirty = new Set(dirtyIds);
  const boxes: SyncBoxMm[] = [];
  for (const node of graph.nodes) {
    if (dirty.has(node.id)) boxes.push(pipBoxForNodeMm(node));
  }
  return boxes;
}

/**
 * 3D 拖拽落位 → 反向回写画布：给定某节点的 3D 盒中心（mm，[X, Y, Z]），
 * 算回 ortho.x / ortho.y，返回一个只改该节点 ortho 的新图（原图不动）。
 * 节点不存在返回 null；坐标非有限数时抛错（不把 NaN 写进图里）。
 */
export function syncFrom3DToCanvas(
  graph: MachineGraph,
  nodeId: string,
  boxCenterMm: readonly [number, number, number]
): MachineGraph | null {
  if (boxCenterMm.some((v) => !Number.isFinite(v))) {
    throw new Error('3D 盒中心坐标必须为有限数');
  }
  const target = graph.nodes.find((node) => node.id === nodeId);
  if (!target) return null;
  const [w, , d] = target.dimsMm;
  const ortho = { x: Math.round(boxCenterMm[0] - w / 2), y: Math.round(boxCenterMm[2] - d / 2) };
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, ortho } : node))
  };
}

/**
 * 有状态版（对应文档原稿 Canvas3DBidirectionalSync 的最小可用形态）：
 * mark 后 flush 只对脏节点回调，不清空未变更节点；flush 后清空脏集。
 */
export class Canvas3DSync {
  private dirtyNodeIds = new Set<string>();

  markSubtreeDirty(rootId: string, edges: readonly CanvasEdge[]): string[] {
    const order = dirtySubtree(rootId, edges);
    for (const id of order) this.dirtyNodeIds.add(id);
    return order;
  }

  dirtyIds(): string[] {
    return [...this.dirtyNodeIds];
  }

  flushIncrementalBoxes(
    graph: MachineGraph,
    apply: (box: SyncBoxMm) => void
  ): SyncBoxMm[] {
    const boxes = incrementalBoxesMm(graph, this.dirtyNodeIds);
    for (const box of boxes) apply(box);
    this.dirtyNodeIds.clear();
    return boxes;
  }
}
