/**
 * Agent 上下文快照（P7-E）
 *
 * 这里有两类上下文：
 * - `buildAgentContext`：P7-A 的历史文本块（工具清单 + 项目信息），保留给既有调用方；
 * - `collectAgentContext` / `serializeAgentContext`：结构化快照，供指代消解、会话提示和
 *   侧栏依据展示使用。两者都是纯函数，采集失败只降级为 null，不抛异常。
 *
 * 体积约束：序列化后的结构化上下文 ≤ 1.5 KB。超限时先丢最近的旧操作，再裁剪长字段，
 * 最后按 UTF-8 字符边界硬截断，避免把半个汉字/代理对塞进模型。
 */

export type AgentSelectionKind = 'component' | 'mesh' | 'placement' | 'feature';

export interface AgentSelection {
  kind: AgentSelectionKind;
  id: string;
  label: string;
}

export interface AgentRecentAction {
  tool: string;
  summary: string;
  at: string;
}

export interface AgentPlacementHint {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AgentContext {
  domain: 'mech' | 'elec' | null;
  view: string | null;
  selection: AgentSelection | null;
  machine: { name: string; stations: number; actuators: number; sensors: number } | null;
  plate: { width: number; height: number; placed: number; overlaps: number } | null;
  /** 最近 3 条；summary 可带 `[target=kind:id:label]` 尾部标记，序列化时会被剥掉。 */
  recentActions: AgentRecentAction[];
  units: 'mm';
  /** BOM 行数与 CAD 模型是否存在；用于多轮工程指纹。 */
  bomRows?: number;
  hasCadModel?: boolean;
  /** 底板 placement 列表，仅用于「左边第二个」这类几何指代；画布不可用时缺省。 */
  placements?: AgentPlacementHint[];
}

export interface AgentContextProviders {
  /** 通常接 `window.__AgentBridge.getProjectContext()` 或主进程 `get_project_context`。 */
  projectContext?: () => unknown;
  /** 最近命令历史；失败时按空数组处理。 */
  recentActions?: () => unknown;
}

export interface SerializedAgentContext {
  text: string;
  bytes: number;
  truncated: boolean;
  droppedRecent: number;
  context: AgentContext;
}

export interface AgentToolHint {
  name: string;
  description: string;
}

export interface AgentContextInput {
  project?: string;
  deviceNo?: string;
  domain?: string;
  view?: string;
  selection?: { id: string; label?: string; tag?: string } | null;
  recent?: Array<{ name: string; ok: boolean }>;
  unit?: string;
  tools: AgentToolHint[];
  note?: string;
}

export interface PackedAgentContext {
  text: string;
  bytes: number;
  truncated: boolean;
  toolCount: number;
  droppedTools: number;
  droppedRecent: number;
}

/** 1.5 KB：结构化上下文的上限。历史文本块也共用该常量。 */
export const CONTEXT_BYTE_LIMIT = 1536;
const RECENT_LIMIT = 3;
const DEFAULT_FIELD_LIMIT = 96;
const COMPACT_FIELD_LIMIT = 40;

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 按 UTF-8 字节截断，且只在完整码点边界落刀；不产生 U+FFFD。 */
export function truncateUtf8(text: string, limit: number, suffix = '…'): string {
  const budget = Math.max(0, Math.trunc(limit));
  if (byteLength(text) <= budget) return text;
  const suffixBytes = byteLength(suffix);
  if (suffixBytes >= budget) return '';
  const target = budget - suffixBytes;
  let used = 0;
  let output = '';
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > target) break;
    output += char;
    used += size;
  }
  return `${output}${suffix}`;
}

function trimToBytes(text: string, limit: number): string {
  return truncateUtf8(text, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function countValue(value: unknown, fallback = 0): number {
  const number = finiteNumber(value);
  if (number === null || number < 0) return fallback;
  return Math.trunc(number);
}

function normalizeDomain(value: unknown): AgentContext['domain'] {
  const text = textValue(value)?.toLowerCase();
  if (!text) return null;
  if (text === 'mech' || text === 'mechanical' || text === '机械' || text === '机械域') return 'mech';
  if (text === 'elec' || text === 'electrical' || text === '电气' || text === '电气域') return 'elec';
  return null;
}

const SELECTION_KINDS = new Set<AgentSelectionKind>(['component', 'mesh', 'placement', 'feature']);

function normalizeSelection(value: unknown): AgentSelection | null {
  if (!isRecord(value)) return null;
  const rawKind = textValue(value.kind);
  const kind = rawKind && SELECTION_KINDS.has(rawKind as AgentSelectionKind)
    ? rawKind as AgentSelectionKind
    : 'component';
  const id = textValue(value.id) ?? textValue(value.name);
  if (!id) return null;
  const label = textValue(value.label) ?? textValue(value.tag) ?? textValue(value.name) ?? id;
  return { kind, id, label };
}

function normalizeMachine(value: unknown): AgentContext['machine'] {
  if (!isRecord(value)) return null;
  const name = textValue(value.name) ?? textValue(value.id);
  if (!name) return null;
  return {
    name,
    stations: countValue(value.stations),
    actuators: countValue(value.actuators),
    sensors: countValue(value.sensors)
  };
}

function normalizePlacements(value: unknown): AgentPlacementHint[] {
  if (!Array.isArray(value)) return [];
  const output: AgentPlacementHint[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = textValue(entry.id);
    const x = finiteNumber(entry.x);
    const y = finiteNumber(entry.y);
    if (!id || x === null || y === null) continue;
    const w = finiteNumber(entry.w) ?? 0;
    const h = finiteNumber(entry.h) ?? 0;
    const label = textValue(entry.label) ?? textValue(entry.tag) ?? textValue(entry.model) ?? textValue(entry.partId) ?? id;
    output.push({ id, label, x, y, w, h });
  }
  return output;
}

function normalizePlate(value: unknown): { plate: AgentContext['plate']; placements: AgentPlacementHint[] } {
  if (!isRecord(value)) return { plate: null, placements: [] };
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const placements = normalizePlacements(value.placements);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { plate: null, placements };
  }
  const overlaps = countValue(value.overlaps ?? value.overlap ?? value.collisions);
  const placed = countValue(value.placed, placements.length);
  return {
    plate: { width, height, placed, overlaps },
    placements
  };
}

function actionSummary(entry: Record<string, unknown>, tool: string): string {
  const summary = textValue(entry.summary);
  if (summary) return summary;
  return entry.ok === false ? `${tool} 失败` : `${tool} 成功`;
}

function normalizeRecent(value: unknown, now: () => string): AgentRecentAction[] {
  if (!Array.isArray(value)) return [];
  const output: AgentRecentAction[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const tool = textValue(entry.tool) ?? textValue(entry.name);
    if (!tool) continue;
    output.push({
      tool,
      summary: actionSummary(entry, tool),
      at: textValue(entry.at) ?? now()
    });
  }
  return output.slice(-RECENT_LIMIT);
}

export function emptyAgentContext(): AgentContext {
  return {
    domain: null,
    view: null,
    selection: null,
    machine: null,
    plate: null,
    recentActions: [],
    units: 'mm'
  };
}

/**
 * 从现有 UI 状态采集。每个 provider 单独 try/catch：某一项失败只影响该字段，
 * 其余字段照常返回，且永远不会向调用方抛错。
 */
export function collectAgentContext(
  providers: AgentContextProviders = {},
  now: () => string = () => new Date().toISOString()
): AgentContext {
  let project: unknown = null;
  if (providers.projectContext) {
    try {
      project = providers.projectContext();
    } catch {
      project = null;
    }
  }
  let recent: unknown = null;
  if (providers.recentActions) {
    try {
      recent = providers.recentActions();
    } catch {
      recent = null;
    }
  }

  const source = isRecord(project) && project.ok !== false ? project : {};
  const rawPlate = source.plate;
  if (recent === null && isRecord(rawPlate) && Array.isArray(rawPlate.recentActions)) {
    recent = rawPlate.recentActions;
  }
  if (recent === null && Array.isArray(source.recentActions)) recent = source.recentActions;
  const { plate, placements } = normalizePlate(rawPlate);
  const directPlacements = normalizePlacements(source.placements);
  const activePlacements = directPlacements.length > 0 ? directPlacements : placements;

  return {
    domain: normalizeDomain(source.domain),
    view: textValue(source.view),
    selection: normalizeSelection(source.selection),
    machine: normalizeMachine(source.machine),
    plate,
    recentActions: normalizeRecent(recent, now),
    units: 'mm',
    ...(typeof source.bomRows === 'number' || typeof source.bomCount === 'number'
      ? { bomRows: countValue(source.bomRows ?? source.bomCount) }
      : {}),
    ...(typeof source.hasCadModel === 'boolean' ? { hasCadModel: source.hasCadModel } : {}),
    ...(activePlacements.length > 0 ? { placements: activePlacements } : {})
  };
}

const TARGET_MARKER = /\s*\[target=([a-z]+):([^:\]]*):([^\]]*)\]\s*$/;

/** 剥掉给指代解析用的尾部标记，只给模型看自然语言摘要。 */
export function displayActionSummary(summary: string): string {
  return summary.replace(TARGET_MARKER, '').trim();
}

function clip(value: string, limit: number): string {
  const chars = [...value];
  return chars.length <= limit ? value : `${chars.slice(0, limit).join('')}…`;
}

function renderAgentContext(context: AgentContext, recent: AgentRecentAction[], fieldLimit: number): string {
  const lines: string[] = ['[工程上下文]'];
  const domain = context.domain === 'mech' ? '机械' : context.domain === 'elec' ? '电气' : '未知';
  lines.push(`域：${domain} · 视图：${context.view ? clip(context.view, fieldLimit) : '未知'}`);
  if (context.selection) {
    lines.push(`选中：${context.selection.kind}·${clip(context.selection.id, fieldLimit)}（${clip(context.selection.label, fieldLimit)}）`);
  } else {
    lines.push('选中：无');
  }
  if (context.machine) {
    lines.push(`机型：${clip(context.machine.name, fieldLimit)} · ${context.machine.stations} 工位 / ${context.machine.actuators} 执行机构 / ${context.machine.sensors} 传感器`);
  }
  if (context.plate) {
    lines.push(`底板：${context.plate.width}×${context.plate.height} mm · 已放置 ${context.plate.placed} · 重叠 ${context.plate.overlaps}`);
  }
  if (context.bomRows !== undefined || context.hasCadModel !== undefined) {
    lines.push(`工程：BOM ${context.bomRows ?? 0} 行 · CAD 模型 ${context.hasCadModel ? '有' : '无'}`);
  }
  lines.push(`单位：${context.units}`);
  if (recent.length > 0) {
    lines.push('最近操作：');
    for (const entry of recent) {
      lines.push(`- ${entry.tool}：${clip(displayActionSummary(entry.summary), fieldLimit)}`);
    }
  }
  return lines.join('\n');
}

/**
 * 序列化结构化上下文。降级顺序固定：删旧操作 → 压长字段 → UTF-8 安全硬截断。
 * 返回值里的 `context` 仍是完整快照，调用方（如指代消解）不受文本裁剪影响。
 */
export function serializeAgentContext(
  context: AgentContext,
  limit = CONTEXT_BYTE_LIMIT
): SerializedAgentContext {
  const safeLimit = Math.max(160, Math.trunc(limit));
  let recent = context.recentActions.slice(-RECENT_LIMIT);
  let fieldLimit = DEFAULT_FIELD_LIMIT;
  let text = renderAgentContext(context, recent, fieldLimit);
  const fullText = renderAgentContext(context, recent, Number.MAX_SAFE_INTEGER);
  let bytes = byteLength(fullText);
  let truncated = text !== fullText || bytes > safeLimit;
  const initialRecent = recent.length;

  while (bytes > safeLimit && recent.length > 0) {
    recent = recent.slice(1);
    text = renderAgentContext(context, recent, fieldLimit);
    bytes = byteLength(text);
    truncated = true;
  }
  if (bytes > safeLimit) {
    fieldLimit = COMPACT_FIELD_LIMIT;
    text = renderAgentContext(context, recent, fieldLimit);
    bytes = byteLength(text);
    truncated = true;
  }
  if (bytes > safeLimit) {
    text = trimToBytes(text, safeLimit);
    bytes = byteLength(text);
    truncated = true;
  }

  return {
    text,
    bytes,
    truncated,
    droppedRecent: initialRecent - recent.length,
    context
  };
}

function render(
  input: AgentContextInput,
  tools: AgentToolHint[],
  recent: Array<{ name: string; ok: boolean }>,
  withDescription: boolean
): string {
  const lines: string[] = ['[工程上下文]'];
  const project = input.project?.trim() || '未命名项目';
  const device = input.deviceNo?.trim();
  lines.push(`项目：${project}${device ? ` / 机台：${device}` : ''}`);
  lines.push(`域：${input.domain?.trim() || '机械'} · 视图：${input.view?.trim() || '装配'}`);
  if (input.selection) {
    const tag = input.selection.tag ? `${input.selection.tag}·` : '';
    const label = input.selection.label ? `（${input.selection.label}）` : '';
    lines.push(`选中：${tag}${input.selection.id}${label}`);
  } else {
    lines.push('选中：无');
  }
  lines.push(`单位：${input.unit?.trim() || 'mm，数量为整数'}`);
  if (recent.length > 0) {
    lines.push(`最近操作：${recent.map((entry) => `${entry.name}(${entry.ok ? '成功' : '失败'})`).join(' / ')}`);
  }
  if (input.note?.trim()) lines.push(`备注：${input.note.trim()}`);
  lines.push(`可用工具（${tools.length}）：`);
  for (const tool of tools) {
    lines.push(withDescription ? `- ${tool.name}：${tool.description}` : `- ${tool.name}`);
  }
  return lines.join('\n');
}

export function buildAgentContext(input: AgentContextInput, limit = CONTEXT_BYTE_LIMIT): PackedAgentContext {
  const safeLimit = Math.max(120, Math.trunc(limit));
  let tools = input.tools.slice();
  let recent = (input.recent ?? []).slice(-RECENT_LIMIT);
  let withDescription = true;
  const initialTools = tools.length;
  const initialRecent = recent.length;

  let text = render(input, tools, recent, withDescription);
  let bytes = byteLength(text);

  while (bytes > safeLimit) {
    if (withDescription) {
      withDescription = false;
      text = render(input, tools, recent, withDescription);
      bytes = byteLength(text);
      continue;
    }
    if (tools.length > 0) {
      tools = tools.slice(0, tools.length - 1);
      text = render(input, tools, recent, withDescription);
      bytes = byteLength(text);
      continue;
    }
    if (recent.length > 0) {
      recent = recent.slice(1);
      text = render(input, tools, recent, withDescription);
      bytes = byteLength(text);
      continue;
    }
    text = trimToBytes(text, safeLimit);
    bytes = byteLength(text);
    break;
  }

  return {
    text,
    bytes,
    truncated: bytes !== byteLength(render(input, input.tools.slice(), (input.recent ?? []).slice(-RECENT_LIMIT), true)),
    toolCount: tools.length,
    droppedTools: initialTools - tools.length,
    droppedRecent: initialRecent - recent.length
  };
}
