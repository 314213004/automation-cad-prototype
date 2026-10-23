/**
 * 会话上下文裁剪（P7-A）
 *
 * 每次对话注入的工程上下文必须 ≤ 2 KB：模型不知道 UI 状态就答不准，但全量
 * 注入会挤掉用户问题与工具结果。这里按「先删描述 → 再删工具 → 再删最近操作
 * → 最后硬截断」的固定顺序降级，保证结果可预测、可单测。
 */

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

export const CONTEXT_BYTE_LIMIT = 2048;
const RECENT_LIMIT = 3;

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function trimToBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  const ellipsis = '…';
  const budget = Math.max(0, limit - byteLength(ellipsis));
  let value = text;
  while (value.length > 0 && byteLength(value) > budget) {
    value = value.slice(0, -1);
  }
  return `${value}${ellipsis}`;
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
