// 画布撤销/重做：有界快照栈（纯函数，快照用 graph.cloneGraph 深拷贝）。
//
// 为什么快照而不是 patch：图画布的对象很小（几十个节点），快照实现简单、不会出现
// 「patch 漏应用一半」的状态；代价是每步一份内存，所以必须有上限（默认 60 步）。
//
// 语义：
//   - entries[0] 是初始状态；每次提交 append 一条，label 描述「这次改了什么」；
//   - undo 把 index 往回拨，redo 往前拨；undo 之后再提交会**丢弃** redo 尾巴（标准行为）；
//   - 到达上限时丢最老的一条，但保留当前 index 的相对位置。
import { cloneGraph } from './graph.ts';
import type { MachineGraph } from './types.ts';

export interface HistorySnapshot {
  graph: MachineGraph;
  selectedId: string | null;
}

export interface HistoryEntry extends HistorySnapshot {
  /** 产生这个状态的动作名，用于「撤销：插入转接板」。 */
  label: string;
}

export interface HistoryState {
  entries: HistoryEntry[];
  /** 当前所处的位置（0 = 初始状态）。 */
  index: number;
  limit: number;
}

export const DEFAULT_HISTORY_LIMIT = 60;

export function createHistory(initial: HistorySnapshot, label = '初始状态', limit = DEFAULT_HISTORY_LIMIT): HistoryState {
  if (!(limit >= 2)) throw new Error('撤销栈上限至少为 2');
  return {
    entries: [{ graph: cloneGraph(initial.graph), selectedId: initial.selectedId, label }],
    index: 0,
    limit
  };
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  return { graph: cloneGraph(entry.graph), selectedId: entry.selectedId, label: entry.label };
}

/** 提交一个新状态。返回新 HistoryState（不改入参）。 */
export function pushHistory(state: HistoryState, next: HistorySnapshot, label: string): HistoryState {
  if (!label || label.trim() === '') throw new Error('撤销记录必须有动作名');
  // undo 之后又提交：丢弃 redo 尾巴
  const kept = state.entries.slice(0, state.index + 1).map(cloneEntry);
  kept.push({ graph: cloneGraph(next.graph), selectedId: next.selectedId, label });
  const overflow = Math.max(0, kept.length - state.limit);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1, limit: state.limit };
}

export function canUndo(state: HistoryState): boolean {
  return state.index > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.index < state.entries.length - 1;
}

export interface HistoryStep {
  state: HistoryState;
  snapshot: HistorySnapshot;
  /** 被撤销/重做的动作名。 */
  label: string;
}

export function undoHistory(state: HistoryState): HistoryStep | null {
  if (!canUndo(state)) return null;
  const index = state.index - 1;
  const entry = state.entries[index];
  if (!entry) return null;
  return {
    state: { entries: state.entries.map(cloneEntry), index, limit: state.limit },
    snapshot: { graph: cloneGraph(entry.graph), selectedId: entry.selectedId },
    label: state.entries[state.index]?.label ?? ''
  };
}

export function redoHistory(state: HistoryState): HistoryStep | null {
  if (!canRedo(state)) return null;
  const index = state.index + 1;
  const entry = state.entries[index];
  if (!entry) return null;
  return {
    state: { entries: state.entries.map(cloneEntry), index, limit: state.limit },
    snapshot: { graph: cloneGraph(entry.graph), selectedId: entry.selectedId },
    label: entry.label
  };
}

/** 按钮 tooltip / 无障碍标签用：下一刀撤销的是什么。 */
export function historyAffordances(state: HistoryState): { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string } {
  const undoLabel = canUndo(state) ? state.entries[state.index]?.label ?? '' : '';
  const redoLabel = canRedo(state) ? state.entries[state.index + 1]?.label ?? '' : '';
  return { canUndo: canUndo(state), canRedo: canRedo(state), undoLabel, redoLabel };
}
