// 画布草稿持久化（P2.5）：纯序列化/校验，存储由调用方注入（浏览器 localStorage / 测试内存桩）。
//
// 为什么单独一层：图是会漂的（改字段、加节点类型），读回来必须先 normalizeGraph，
// 把重复 id / 孤儿边清理掉，并把清理结果报给用户，而不是「打开就悄悄少两条边」。
// schema 版本对不上就不猜、不迁移 —— 直接拒绝并保留原草稿，避免把旧图读成半成品。
import { normalizeGraph, type GraphIssue } from './graph.ts';
import type { MachineGraph } from './types.ts';

export const CANVAS_DRAFT_SCHEMA = 'canvas-workbench-draft/1';
export const CANVAS_DRAFT_KEY = 'automationcad.canvas.workbench.v1';

export type CanvasViewMode = 'topology' | 'ortho' | 'artboard';

/** 只要能读写的键值存储即可（localStorage / 内存桩）。 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CanvasDraft {
  schema: string;
  /** ISO 时间戳，仅用于展示「上次保存」。 */
  savedAt: string;
  graph: MachineGraph;
  selectedId: string | null;
  mode: CanvasViewMode;
}

export interface DraftPayload {
  graph: MachineGraph;
  selectedId: string | null;
  mode: CanvasViewMode;
}

export interface ParseDraftResult {
  draft: CanvasDraft | null;
  /** normalizeGraph 清理掉的内容（重复 id / 孤儿边…）。 */
  issues: GraphIssue[];
  reason?: string;
}

const MODES: readonly CanvasViewMode[] = ['topology', 'ortho', 'artboard'];

/** 稳定字段顺序 + 显式 schema：同一张图 + 同一时间戳 → 字节一致（可做黄金样例）。 */
export function serializeDraft(payload: DraftPayload, savedAt: string): string {
  return `${JSON.stringify(
    {
      schema: CANVAS_DRAFT_SCHEMA,
      savedAt,
      mode: payload.mode,
      selectedId: payload.selectedId,
      graph: {
        schemeId: payload.graph.schemeId,
        ...(payload.graph.title === undefined ? {} : { title: payload.graph.title }),
        layout: payload.graph.layout ?? 'single',
        // 口径参数必须一起存：漏了 transferSeconds，读回来 CT 会从 0.75s 变成 0.55s
        ...(payload.graph.targetPerMin === undefined ? {} : { targetPerMin: payload.graph.targetPerMin }),
        ...(payload.graph.transferSeconds === undefined ? {} : { transferSeconds: payload.graph.transferSeconds }),
        ...(payload.graph.indexSeconds === undefined ? {} : { indexSeconds: payload.graph.indexSeconds }),
        ...(payload.graph.lanes === undefined ? {} : { lanes: payload.graph.lanes }),
        nodes: payload.graph.nodes,
        edges: payload.graph.edges
      }
    },
    null,
    2
  )}\n`;
}

/** 读草稿：结构不对就返回 reason；结构对但图脏就清理并回报 issues。 */
export function parseDraft(raw: string | null): ParseDraftResult {
  if (raw === null || raw.trim() === '') return { draft: null, issues: [], reason: '没有本地草稿' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { draft: null, issues: [], reason: '本地草稿不是合法 JSON（已保留原内容，未覆盖）' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { draft: null, issues: [], reason: '本地草稿不是对象' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schema !== CANVAS_DRAFT_SCHEMA) {
    return {
      draft: null,
      issues: [],
      reason: `本地草稿版本不支持（${String(record.schema)} ≠ ${CANVAS_DRAFT_SCHEMA}），未做自动迁移`
    };
  }
  const graphLike = record.graph;
  if (typeof graphLike !== 'object' || graphLike === null) {
    return { draft: null, issues: [], reason: '本地草稿缺少 graph' };
  }
  let normalized;
  try {
    normalized = normalizeGraph(graphLike as MachineGraph);
  } catch (error) {
    return {
      draft: null,
      issues: [],
      reason: `本地草稿的图无法解析：${error instanceof Error ? error.message : String(error)}`
    };
  }
  const mode = MODES.includes(record.mode as CanvasViewMode) ? (record.mode as CanvasViewMode) : 'topology';
  const selected =
    typeof record.selectedId === 'string' && normalized.graph.nodes.some((node) => node.id === record.selectedId)
      ? record.selectedId
      : null;
  return {
    draft: {
      schema: CANVAS_DRAFT_SCHEMA,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
      graph: normalized.graph,
      selectedId: selected,
      mode
    },
    issues: normalized.issues
  };
}

export interface SaveDraftResult {
  ok: boolean;
  reason?: string;
}

/** 写草稿：存储不可用/超限不抛给 UI，返回人话原因。 */
export function saveDraft(storage: DraftStorage, payload: DraftPayload, savedAt: string, key = CANVAS_DRAFT_KEY): SaveDraftResult {
  try {
    storage.setItem(key, serializeDraft(payload, savedAt));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `本地草稿保存失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function loadDraft(storage: DraftStorage | null, key = CANVAS_DRAFT_KEY): ParseDraftResult {
  if (!storage) return { draft: null, issues: [], reason: '当前环境没有本地存储' };
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    return { draft: null, issues: [], reason: `本地草稿读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return parseDraft(raw);
}

export function clearDraft(storage: DraftStorage | null, key = CANVAS_DRAFT_KEY): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    /* 存储不可用时无事可做：调用方已经重置了内存状态 */
  }
}
