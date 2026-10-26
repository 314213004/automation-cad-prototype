// 导入模型 ↔ 画布节点的尺寸核对（不是渲染真实网格）
//
// 能拿到的是导入后每个零件的 **AABB**（mech/interference.InterferencePart），没有三角网格，
// 也没有可靠的坐标系约定（CAD 多为 Z-up，画布是 Y-up）。所以这里只做一件不会骗人的事：
// 用「包围盒体积」跟画布节点的 dimsMm 体积比，找出明显不一致的节点，让人去核对型号。
//
// 不要在这里把 AABB 直接当盒子渲染——位置和轴向都需要装配坐标系约定，硬猜会把 3D 预览画歪。
import type { InterferencePart } from '../mech/interference.ts';
import type { CanvasNode, MachineGraph } from './types.ts';

export type ModelMatchVerdict = 'close' | 'differs' | 'no-model';

export interface NodeModelCheck {
  nodeId: string;
  nodeName: string;
  /** 命中的导入零件名（未命中为空）。 */
  partName: string | null;
  /** 导入 AABB 体积 / 画布节点体积；未命中为 null。 */
  volumeRatio: number | null;
  verdict: ModelMatchVerdict;
  note: string;
}

export interface ModelCheckSummary {
  items: NodeModelCheck[];
  matched: number;
  total: number;
  differs: number;
}

const CLOSE_LOW = 0.5;
const CLOSE_HIGH = 2;

/** 名称归一：小写、去空格/下划线/横线/斜杠、全角括号，便于跨命名习惯比对。 */
export function normalizePartName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（）]/g, (char) => (char === '（' ? '(' : ')'))
    .replace(/[\s_\-/.]+/g, '');
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s_\-/.,()（）]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function bigramDice(left: string, right: string): number {
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  let total = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    total += 1;
    const gram = right.slice(index, index + 2);
    const available = counts.get(gram) ?? 0;
    if (available > 0) {
      shared += 1;
      counts.set(gram, available - 1);
    }
  }
  if (total === 0) return 0;
  return shared / Math.max(left.length - 1, total);
}

/** 0..1 的名称相似度：完全相同 1；互相包含 0.8；词元重合 / 字符二元组 Dice 取较大。 */
export function nameScore(nodeName: string, partName: string): number {
  const left = normalizePartName(nodeName);
  const right = normalizePartName(partName);
  if (!left || !right) return 0;
  if (left === right) return 1;
  let score = left.includes(right) || right.includes(left) ? 0.8 : 0;
  const nodeTokens = new Set(tokens(nodeName));
  const partTokens = tokens(partName);
  if (nodeTokens.size > 0 && partTokens.length > 0) {
    const hit = partTokens.filter((token) =>
      [...nodeTokens].some((candidate) => candidate.includes(token) || token.includes(candidate))
    ).length;
    score = Math.max(score, (hit / partTokens.length) * 0.8);
  }
  return Math.max(score, bigramDice(left, right));
}

function boxVolumeMm3(part: InterferencePart): number {
  const size = [0, 1, 2].map((axis) => Math.abs((part.bbox.max[axis] ?? 0) - (part.bbox.min[axis] ?? 0)));
  return (size[0] ?? 0) * (size[1] ?? 0) * (size[2] ?? 0);
}

/** 给每个节点找最像的导入零件；低于阈值算没命中，宁可不匹配也不硬凑。 */
export function matchParts(nodes: readonly CanvasNode[], parts: readonly InterferencePart[], threshold = 0.55): Map<string, InterferencePart> {
  const result = new Map<string, InterferencePart>();
  for (const node of nodes) {
    let best: InterferencePart | null = null;
    let bestScore = 0;
    for (const part of parts) {
      const score = nameScore(node.name, part.name);
      if (score > bestScore) {
        best = part;
        bestScore = score;
      }
    }
    if (best && bestScore >= threshold) result.set(node.id, best);
  }
  return result;
}

/**
 * 尺寸核对：导入 AABB 体积 vs 节点 dimsMm 体积。
 * 比值在 [0.5, 2] 之间算「量级一致」，否则「明显不一致」——只表示要复核，不代表谁错。
 */
export function checkNodeSizes(graph: MachineGraph, parts: readonly InterferencePart[], threshold = 0.55): ModelCheckSummary {
  const matches = matchParts(graph.nodes, parts, threshold);
  const items: NodeModelCheck[] = graph.nodes.map((node) => {
    const part = matches.get(node.id);
    if (!part) {
      return {
        nodeId: node.id,
        nodeName: node.name,
        partName: null,
        volumeRatio: null,
        verdict: 'no-model',
        note: '没有对应的导入零件（按名称匹配），无法核对'
      };
    }
    const nodeVolume = node.dimsMm[0] * node.dimsMm[1] * node.dimsMm[2];
    const partVolume = boxVolumeMm3(part);
    if (!(nodeVolume > 0) || !(partVolume > 0)) {
      return {
        nodeId: node.id,
        nodeName: node.name,
        partName: part.name,
        volumeRatio: null,
        verdict: 'no-model',
        note: '体积数据不可用（节点尺寸或包围盒为 0）'
      };
    }
    const ratio = Number((partVolume / nodeVolume).toFixed(3));
    const close = ratio >= CLOSE_LOW && ratio <= CLOSE_HIGH;
    return {
      nodeId: node.id,
      nodeName: node.name,
      partName: part.name,
      volumeRatio: ratio,
      verdict: close ? 'close' : 'differs',
      note: close ? `体积比 ${ratio}（量级一致）` : `体积比 ${ratio}，模型与画布尺寸差 ${Math.round((ratio > 1 ? ratio : 1 / ratio) * 100 - 100)}%`
    };
  });
  return {
    items,
    matched: items.filter((item) => item.partName !== null).length,
    total: items.length,
    differs: items.filter((item) => item.verdict === 'differs').length
  };
}

/** 面板上一行话。 */
export function describeModelCheck(summary: ModelCheckSummary | null, partCount: number): string {
  if (!summary || partCount === 0) return '3D 尺寸核对：未导入模型（AABB 体积核对需要先导入 STEP/STL）';
  const head = `3D 尺寸核对：${summary.matched}/${summary.total} 节点匹配到导入零件（AABB 体积比，非网格显示）`;
  if (summary.differs === 0) return `${head} · 没有明显偏差`;
  return `${head} · ${summary.differs} 个节点体积差超过 2 倍，需复核型号`;
}
