import type { Placement } from '../enclosure/layout.ts';
import { findOverlaps, outOfBounds, type LayoutConflict } from './layout.ts';

export type ProjectLayoutItemStatus = 'valid' | 'overlap' | 'out-of-bounds' | 'overlap-and-out-of-bounds' | 'unchecked' | 'overlap-unchecked';
export type ProjectLayoutSaveBlockReason = 'unknown-envelope' | 'out-of-bounds' | null;

export interface ProjectLayoutValidationView {
  envelopeKnown: boolean;
  envelopeLabel: string;
  overlaps: LayoutConflict[];
  outOfBounds: string[];
  messages: string[];
  state: 'valid' | 'warning' | 'error';
  saveBlockReason: ProjectLayoutSaveBlockReason;
  overlapIds: string[];
  rows: Array<{ id: string; status: ProjectLayoutItemStatus; label: string }>;
}

function isKnownEnvelope(envelope?: readonly [number, number, number] | null): envelope is readonly [number, number, number] {
  return Array.isArray(envelope) && Number.isFinite(envelope[0]) && envelope[0] > 0 &&
    Number.isFinite(envelope[1]) && envelope[1] > 0;
}

function formatMm(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** Build the exact status model shared by the editor UI and its tests. The project envelope is [length, width, height]. */
export function buildProjectLayoutValidationView(
  placements: readonly Placement[],
  envelope?: readonly [number, number, number] | null
): ProjectLayoutValidationView {
  const envelopeKnown = isKnownEnvelope(envelope);
  const overlaps = findOverlaps(placements);
  const outOfBoundsIds = envelopeKnown
    ? outOfBounds(placements, { width: envelope[0], height: envelope[1] })
    : [];
  const overlapIds = [...new Set(overlaps.flatMap(({ a, b }) => [a, b]))];
  const overlapSet = new Set(overlapIds);
  const outsideSet = new Set(outOfBoundsIds);
  const names = new Map(placements.map((item) => [item.id, item.model || item.id]));
  const messages = [
    envelopeKnown
      ? `项目包络（长度 × 宽度）：${formatMm(envelope[0])} × ${formatMm(envelope[1])} mm。`
      : '项目包络尺寸缺失或无效，无法校验边界；不会推测尺寸，当前禁止保存。'
  ];
  if (outOfBoundsIds.length) {
    const list = outOfBoundsIds.slice(0, 8).map((id) => names.get(id) ?? id).join('、');
    const remaining = outOfBoundsIds.length > 8 ? ` 等 ${outOfBoundsIds.length} 项` : '';
    messages.push(`越界 ${outOfBoundsIds.length} 项，已阻止保存：${list}${remaining}。`);
  }
  if (overlaps.length) {
    const pairs = overlaps.slice(0, 8).map(({ a, b }) => `${names.get(a) ?? a} ↔ ${names.get(b) ?? b}`).join('；');
    const remaining = overlaps.length > 8 ? `；另有 ${overlaps.length - 8} 处` : '';
    messages.push(`检测到重叠 ${overlaps.length} 处：${pairs}${remaining}。保存前需要工程师确认。`);
  }
  if (envelopeKnown && !outOfBoundsIds.length && !overlaps.length) {
    messages.push('边界校验通过，未发现越界或重叠。');
  }
  const rows = placements.map((item) => {
    const overlap = overlapSet.has(item.id);
    const outside = outsideSet.has(item.id);
    let status: ProjectLayoutItemStatus;
    if (!envelopeKnown) status = overlap ? 'overlap-unchecked' : 'unchecked';
    else if (overlap && outside) status = 'overlap-and-out-of-bounds';
    else if (overlap) status = 'overlap';
    else if (outside) status = 'out-of-bounds';
    else status = 'valid';
    const label: Record<ProjectLayoutItemStatus, string> = {
      valid: '正常',
      overlap: '重叠',
      'out-of-bounds': '越界',
      'overlap-and-out-of-bounds': '重叠 · 越界',
      unchecked: '边界未校核',
      'overlap-unchecked': '重叠 · 边界未校核'
    };
    return { id: item.id, status, label: label[status] };
  });
  const saveBlockReason: ProjectLayoutSaveBlockReason = !envelopeKnown
    ? 'unknown-envelope'
    : outOfBoundsIds.length ? 'out-of-bounds' : null;
  return {
    envelopeKnown,
    envelopeLabel: messages[0] ?? '',
    overlaps,
    outOfBounds: outOfBoundsIds,
    messages,
    state: saveBlockReason ? 'error' : overlaps.length ? 'warning' : 'valid',
    saveBlockReason,
    overlapIds,
    rows
  };
}

export function projectLayoutItemStatus(view: ProjectLayoutValidationView, id: string): ProjectLayoutItemStatus {
  return view.rows.find((row) => row.id === id)?.status ?? 'valid';
}

export function canSaveProjectLayout(view: ProjectLayoutValidationView, overlapConfirmed = false): boolean {
  return view.saveBlockReason === null && (view.overlaps.length === 0 || overlapConfirmed);
}

export function projectLayoutOverlapConfirmation(
  view: ProjectLayoutValidationView,
  placements: readonly Placement[]
): string {
  if (!view.overlaps.length) return '';
  const names = new Map(placements.map((item) => [item.id, item.model || item.id]));
  const pairs = view.overlaps.slice(0, 10).map(({ a, b }) => `• ${names.get(a) ?? a} ↔ ${names.get(b) ?? b}`);
  if (view.overlaps.length > pairs.length) pairs.push(`…另有 ${view.overlaps.length - pairs.length} 处重叠`);
  return `检测到 ${view.overlaps.length} 处布局重叠：\n${pairs.join('\n')}\n\n重叠不会自动调整。请确认这是工程师接受的布局后再保存。\n仍要保存吗？`;
}
