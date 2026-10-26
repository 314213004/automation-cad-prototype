/**
 * 主视口 3D 几何编辑的撤销/重做，与原型自身的撤销栈合成**一条时间线**（纯逻辑，可在 Node 单测）。
 *
 * 为什么不直接塞进原型栈：原型 `state.undoStack` / `pushHistory` 不导出，且约束禁止改 app.js。
 * 能观察到的只有状态栏 `#stUndoText「撤销 N」/ #stRedoText「重做 M」` 的计数，以及公开的
 * `ProtoApi.undo()/redo()`。因此这里维护：
 *
 * - 3D 自己的编辑栈（每条存编辑前/后的完整覆盖表快照，撤销 = 换回快照，天然幂等）；
 * - 一条令牌时间线 `undoTimeline / redoTimeline`，元素是 'proto' | 'orbit'，记录两边动作的先后；
 * - 每次观察到原型计数变化时调用 `observeProto()` 对账：新增动作 → 追加 'proto' 并清空重做；
 *   外部撤销/重做（Agent、ProtoApi、状态栏按钮）→ 把对应 'proto' 令牌在两条线之间搬动。
 *
 * Ctrl+Z 时看撤销线栈顶：'orbit' 由扩展自己撤；'proto' 放行给原型。新动作（任一侧）都会让另一侧
 * 的重做失效，与线性历史一致；原型的重做栈扩展清不掉，记为 orphan，重做时被拦截不执行。
 */
import type { ParamOverrides } from './model.ts';

/**
 * 'layout' = 整机布局 3D 编辑（src/layout-editor/）写入 MachineDesign.stationGeometryLayout 的一步；
 * 快照内容由布局编辑器解释，时间线只负责排序与撤销/重做归属。
 */
export type HistoryToken = 'proto' | 'orbit' | 'layout';

export interface ProtoCounts {
  undo: number;
  redo: number;
  /** 原型撤销/重做栈顶的动作名（读自按钮提示），用于区分「撤销后重做」与「撤销后做了新动作」 */
  undoLabel?: string | null;
  redoLabel?: string | null;
}

export interface OrbitEdit {
  label: string;
  before: ParamOverrides;
  after: ParamOverrides;
  /** 连续输入合并用：`part::key`；恢复默认等不合并的动作留空 */
  mergeKey?: string;
  at: number;
}

/** 整机布局编辑的一步：before/after 是布局编辑器自己的不可变快照（工位位姿表）。 */
export interface LayoutEdit {
  label: string;
  before: unknown;
  after: unknown;
  /** 同一字段连续输入合并用；拖动/对齐等离散动作留空 */
  mergeKey?: string;
  at: number;
}

export interface HistorySnapshot {
  undoTimeline: HistoryToken[];
  redoTimeline: HistoryToken[];
  orbitUndo: string[];
  orbitRedo: string[];
  layoutUndo: string[];
  layoutRedo: string[];
  proto: ProtoCounts;
  protoRedoOrphans: number;
}

/** 与原型 `pushEdit` 相同的合并窗口：同一字段 800 ms 内的连续输入算一步。 */
export const MERGE_WINDOW_MS = 800;
/** 与原型 `HISTORY_LIMIT` 一致。 */
export const ORBIT_HISTORY_LIMIT = 50;

/** 原型按钮提示「撤销：缸径 32→40（Ctrl+Z）」→「缸径 32→40」；「没有可撤销的操作」→ null。 */
export function parseProtoLabel(title: string | null | undefined): string | null {
  const m = /^(?:撤销|重做)：(.*)（Ctrl/.exec(title ?? '');
  return m ? (m[1] as string) : null;
}

/** 从状态栏文案读原型计数：「撤销 3」「重做 0」。读不出（原型尚未初始化）返回 null。 */
export function parseProtoCounts(
  undoText: string | null | undefined,
  redoText: string | null | undefined,
  undoTitle?: string | null,
  redoTitle?: string | null
): ProtoCounts | null {
  const u = /撤销\s*(\d+)/.exec(undoText ?? '');
  const r = /重做\s*(\d+)/.exec(redoText ?? '');
  if (!u) return null;
  const out: ProtoCounts = { undo: Number(u[1]), redo: r ? Number(r[1]) : 0 };
  if (undoTitle !== undefined) out.undoLabel = parseProtoLabel(undoTitle);
  if (redoTitle !== undefined) out.redoLabel = parseProtoLabel(redoTitle);
  return out;
}

export function cloneOverrides(overrides: ParamOverrides): ParamOverrides {
  const out: ParamOverrides = {};
  Object.entries(overrides).forEach(([id, values]) => { out[id] = { ...values }; });
  return out;
}

export function sameOverrides(a: ParamOverrides, b: ParamOverrides): boolean {
  const norm = (o: ParamOverrides): string => JSON.stringify(Object.keys(o).sort()
    .filter((id) => Object.keys(o[id] ?? {}).length > 0)
    .map((id) => [id, Object.keys(o[id] ?? {}).sort().map((k) => [k, (o[id] as Record<string, number>)[k]])]));
  return norm(a) === norm(b);
}

function removeLast<T>(list: T[], value: T): boolean {
  const index = list.lastIndexOf(value);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

function countOf<T>(list: readonly T[], value: T): number {
  return list.reduce((n, item) => n + (item === value ? 1 : 0), 0);
}

export class UnifiedHistory {
  private undoTimeline: HistoryToken[] = [];
  private redoTimeline: HistoryToken[] = [];
  private orbitUndo: OrbitEdit[] = [];
  private orbitRedo: OrbitEdit[] = [];
  private layoutUndo: LayoutEdit[] = [];
  private layoutRedo: LayoutEdit[] = [];
  private proto: ProtoCounts = { undo: 0, redo: 0 };
  /** 原型重做栈里已被 3D 新动作「作废」、但扩展无法清除的条目数 */
  private protoRedoOrphans = 0;

  constructor(initial: ProtoCounts | null = null) {
    if (initial) this.resetProto(initial);
  }

  /** 以当前原型计数为起点（扩展挂载时原型可能已有历史，全部视为更早的 'proto' 动作）。 */
  resetProto(counts: ProtoCounts): void {
    this.proto = { ...counts };
    this.undoTimeline = this.undoTimeline.filter((t) => t !== 'proto');
    this.undoTimeline.unshift(...Array.from({ length: counts.undo }, () => 'proto' as const));
    this.redoTimeline = this.redoTimeline.filter((t) => t !== 'proto');
    this.protoRedoOrphans = counts.redo;
  }

  /**
   * 记录一次 3D 编辑。同字段 800 ms 内的连续输入合并到栈顶条目（保留最初的 before）。
   * 返回 false 表示前后快照相同（无效编辑，不入栈）。
   */
  recordOrbit(edit: OrbitEdit): boolean {
    const top = this.orbitUndo[this.orbitUndo.length - 1];
    const topToken = this.undoTimeline[this.undoTimeline.length - 1];
    if (edit.mergeKey && top && topToken === 'orbit' && top.mergeKey === edit.mergeKey &&
        this.redoTimeline.length === 0 && edit.at - top.at <= MERGE_WINDOW_MS) {
      top.after = cloneOverrides(edit.after);
      top.at = edit.at;
      top.label = edit.label;
      if (sameOverrides(top.before, top.after)) {
        // 改回了原值：整条作废
        this.orbitUndo.pop();
        this.undoTimeline.pop();
      }
      return true;
    }
    if (sameOverrides(edit.before, edit.after)) return false;
    this.orbitUndo.push({ ...edit, before: cloneOverrides(edit.before), after: cloneOverrides(edit.after) });
    this.undoTimeline.push('orbit');
    this.dropRedo();
    this.trimOrbit();
    return true;
  }

  /**
   * 记录一次整机布局编辑（与 3D/原型动作同一条时间线）。同 mergeKey 800 ms 内合并；
   * sameSnapshot 判定前后相同（无效编辑不入栈）。
   */
  recordLayout(edit: LayoutEdit, sameSnapshot: (a: unknown, b: unknown) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b)): boolean {
    const top = this.layoutUndo[this.layoutUndo.length - 1];
    const topToken = this.undoTimeline[this.undoTimeline.length - 1];
    if (edit.mergeKey && top && topToken === 'layout' && top.mergeKey === edit.mergeKey &&
        this.redoTimeline.length === 0 && edit.at - top.at <= MERGE_WINDOW_MS) {
      top.after = edit.after;
      top.at = edit.at;
      top.label = edit.label;
      if (sameSnapshot(top.before, top.after)) {
        this.layoutUndo.pop();
        this.undoTimeline.pop();
      }
      return true;
    }
    if (sameSnapshot(edit.before, edit.after)) return false;
    this.layoutUndo.push({ ...edit });
    this.undoTimeline.push('layout');
    this.dropRedo();
    this.trimLayout();
    return true;
  }

  peekLayoutUndo(): LayoutEdit | null {
    return this.nextUndo() === 'layout' ? this.layoutUndo[this.layoutUndo.length - 1] ?? null : null;
  }

  peekLayoutRedo(): LayoutEdit | null {
    return this.nextRedo() === 'layout' ? this.layoutRedo[this.layoutRedo.length - 1] ?? null : null;
  }

  /** 栈顶是布局编辑时弹出它（调用方把工位位姿换回 `before`）。 */
  takeLayoutUndo(): LayoutEdit | null {
    if (this.nextUndo() !== 'layout') return null;
    const edit = this.layoutUndo.pop();
    this.undoTimeline.pop();
    if (!edit) return null;
    this.layoutRedo.push(edit);
    this.redoTimeline.push('layout');
    return edit;
  }

  /** 重做栈顶是布局编辑时弹出它（调用方把工位位姿换成 `after`）。 */
  takeLayoutRedo(): LayoutEdit | null {
    if (this.nextRedo() !== 'layout') return null;
    const edit = this.layoutRedo.pop();
    this.redoTimeline.pop();
    if (!edit) return null;
    this.layoutUndo.push(edit);
    this.undoTimeline.push('layout');
    this.trimLayout();
    return edit;
  }

  /**
   * 布局主数据被布局编辑器以外的路径整体替换（换方案、需求重算、关闭草稿）时调用：
   * 旧快照已不对应当前设计，丢弃全部布局条目，避免撤销把旧方案的位姿写进新方案。
   */
  clearLayout(): void {
    this.layoutUndo = [];
    this.layoutRedo = [];
    this.undoTimeline = this.undoTimeline.filter((t) => t !== 'layout');
    this.redoTimeline = this.redoTimeline.filter((t) => t !== 'layout');
  }

  layoutCounts(): { undo: number; redo: number } {
    return { undo: this.layoutUndo.length, redo: this.layoutRedo.length };
  }

  /** 下一次撤销该由谁执行；null = 两边都没有可撤销项。 */
  nextUndo(): HistoryToken | null {
    const top = this.undoTimeline[this.undoTimeline.length - 1];
    if (top) return top;
    return this.proto.undo > 0 ? 'proto' : null;
  }

  /** 下一次重做该由谁执行；null = 没有有效重做（原型 orphan 重做也算没有）。 */
  nextRedo(): HistoryToken | null {
    return this.redoTimeline[this.redoTimeline.length - 1] ?? null;
  }

  /** 原型里还有被作废的重做条目：扩展需要拦截原型自己的重做入口。 */
  protoRedoBlocked(): boolean {
    return this.nextRedo() !== 'proto' && this.proto.redo > 0;
  }

  peekOrbitUndo(): OrbitEdit | null {
    return this.nextUndo() === 'orbit' ? this.orbitUndo[this.orbitUndo.length - 1] ?? null : null;
  }

  peekOrbitRedo(): OrbitEdit | null {
    return this.nextRedo() === 'orbit' ? this.orbitRedo[this.orbitRedo.length - 1] ?? null : null;
  }

  /** 栈顶是 3D 编辑时弹出它（调用方把覆盖表换回 `before`）。 */
  takeOrbitUndo(): OrbitEdit | null {
    if (this.nextUndo() !== 'orbit') return null;
    const edit = this.orbitUndo.pop();
    this.undoTimeline.pop();
    if (!edit) return null;
    this.orbitRedo.push(edit);
    this.redoTimeline.push('orbit');
    return edit;
  }

  /** 重做栈顶是 3D 编辑时弹出它（调用方把覆盖表换成 `after`）。 */
  takeOrbitRedo(): OrbitEdit | null {
    if (this.nextRedo() !== 'orbit') return null;
    const edit = this.orbitRedo.pop();
    this.redoTimeline.pop();
    if (!edit) return null;
    this.orbitUndo.push(edit);
    this.undoTimeline.push('orbit');
    this.trimOrbit();
    return edit;
  }

  /**
   * 原型计数变化后对账。能识别：新增动作（含合并窗口外的连续编辑、达到上限后的滚动）、
   * 外部撤销 k 步、外部重做 k 步；识别不了的组合按计数强制对齐，保证不会多撤/少撤原型。
   */
  observeProto(counts: ProtoCounts): void {
    const prev = this.proto;
    if (counts.undo === prev.undo && counts.redo === prev.redo) {
      this.proto = { ...counts };
      return;
    }
    const dU = counts.undo - prev.undo;
    const dR = counts.redo - prev.redo;
    if (dU < 0 && dR === -dU) {
      for (let i = 0; i < -dU; i += 1) {
        removeLast(this.undoTimeline, 'proto');
        this.redoTimeline.push('proto');
      }
    } else if (dU > 0 && dR === -dU && !this.looksLikePush(prev, counts)) {
      for (let i = 0; i < dU; i += 1) {
        if (!removeLast(this.redoTimeline, 'proto') && this.protoRedoOrphans > 0) this.protoRedoOrphans -= 1;
        this.undoTimeline.push('proto');
      }
    } else if (counts.redo === 0 && (dU > 0 || prev.redo > 0)) {
      const pushes = Math.max(1, dU);
      for (let i = 0; i < pushes; i += 1) this.undoTimeline.push('proto');
      this.dropRedo();
    }
    this.proto = { ...counts };
    this.align();
  }

  /**
   * 撤销一步后再出现 (U+1, R−1) 有两种可能：重做，或做了新动作（原型新动作会清空重做栈，
   * 只剩 1 条重做时计数完全一样）。用栈顶动作名区分：重做后撤销栈顶应是刚才的重做栈顶。
   */
  private looksLikePush(prev: ProtoCounts, next: ProtoCounts): boolean {
    if (next.redo !== 0) return false;
    if (typeof prev.redoLabel !== 'string' || typeof next.undoLabel !== 'string') return false;
    return prev.redoLabel !== next.undoLabel;
  }

  /** 强制让时间线里的 'proto' 令牌数与原型计数一致（上限滚动、无法识别的跳变）。 */
  private align(): void {
    let extra = countOf(this.undoTimeline, 'proto') - this.proto.undo;
    while (extra > 0) {
      const index = this.undoTimeline.indexOf('proto');
      this.undoTimeline.splice(index, 1);
      extra -= 1;
    }
    while (extra < 0) {
      this.undoTimeline.unshift('proto');
      extra += 1;
    }
    let redoExtra = countOf(this.redoTimeline, 'proto') - this.proto.redo;
    while (redoExtra > 0) {
      const index = this.redoTimeline.indexOf('proto');
      this.redoTimeline.splice(index, 1);
      redoExtra -= 1;
    }
    this.protoRedoOrphans = Math.max(0, this.proto.redo - countOf(this.redoTimeline, 'proto'));
  }

  private dropRedo(): void {
    this.protoRedoOrphans += countOf(this.redoTimeline, 'proto');
    this.redoTimeline = [];
    this.orbitRedo = [];
    this.layoutRedo = [];
    this.protoRedoOrphans = Math.min(this.protoRedoOrphans, this.proto.redo);
  }

  private trimOrbit(): void {
    while (this.orbitUndo.length > ORBIT_HISTORY_LIMIT) {
      this.orbitUndo.shift();
      const index = this.undoTimeline.indexOf('orbit');
      if (index >= 0) this.undoTimeline.splice(index, 1);
    }
  }

  private trimLayout(): void {
    while (this.layoutUndo.length > ORBIT_HISTORY_LIMIT) {
      this.layoutUndo.shift();
      const index = this.undoTimeline.indexOf('layout');
      if (index >= 0) this.undoTimeline.splice(index, 1);
    }
  }

  /** 3D 撤销/重做栈条数（状态栏徽标）。 */
  orbitCounts(): { undo: number; redo: number } {
    return { undo: this.orbitUndo.length, redo: this.orbitRedo.length };
  }

  snapshot(): HistorySnapshot {
    return {
      undoTimeline: [...this.undoTimeline],
      redoTimeline: [...this.redoTimeline],
      orbitUndo: this.orbitUndo.map((e) => e.label),
      orbitRedo: this.orbitRedo.map((e) => e.label),
      layoutUndo: this.layoutUndo.map((e) => e.label),
      layoutRedo: this.layoutRedo.map((e) => e.label),
      proto: { ...this.proto },
      protoRedoOrphans: this.protoRedoOrphans
    };
  }
}
