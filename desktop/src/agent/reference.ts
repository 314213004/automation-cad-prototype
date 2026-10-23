/**
 * 指代消解（纯函数）
 *
 * 优先级固定：
 * 1. 「这个 / 它 / 刚才那个 / 选中的」→ 当前选中对象；
 * 2. 其次最近一次带对象信息的工具操作；
 * 3. 「左边第二个 / 上面那个」→ 底板 placement 按几何位置排序；没有列表或越界不猜。
 *
 * 置信度低于 0.6 一律返回 null，由调用方追问一次。这里不读写 DOM / 文件 / 网络，
 * 上下文由调用方采集后传入，便于单测与复用。
 */

import type {
  AgentContext,
  AgentPlacementHint,
  AgentSelection,
  AgentSelectionKind
} from './context.ts';

export const REFERENCE_CONFIDENCE_THRESHOLD = 0.6;

export type ReferenceSource = 'selection' | 'recent' | 'geometry';

export interface ReferenceTarget extends AgentSelection {
  source: ReferenceSource;
}

export type ReferenceReason =
  | 'SELECTION'
  | 'RECENT_ACTION'
  | 'GEOMETRY'
  | 'NO_REFERENCE'
  | 'NO_CANDIDATES'
  | 'LOW_CONFIDENCE';

export interface ReferenceResolution {
  target: ReferenceTarget | null;
  confidence: number;
  reason: ReferenceReason;
}

const TARGET_MARKER = /\s*\[target=([a-z]+):([^:\]]*):([^\]]*)\]\s*$/;
const SELECTION_KINDS = new Set<AgentSelectionKind>(['component', 'mesh', 'placement', 'feature']);
const OBJECT_TOOLS = new Set([
  'insert_component',
  'place_component',
  'update_component',
  'remove_component'
]);

const DEICTIC_PATTERN = /(这个|那个|刚才那个|刚才的|选中的|选中那个|这台|那台|它|他|她)/;
const POSITIONAL_PATTERN = /(左|右|上|下)(?:边|面)(?:第)?([一二三四五六七八九十两\d]+)?(?:个|那)?/;
const ORDINAL_PATTERN = /第([一二三四五六七八九十两\d]+)个/;

export function hasReferenceExpression(text: string): boolean {
  const value = text ?? '';
  return DEICTIC_PATTERN.test(value) || POSITIONAL_PATTERN.test(value) || ORDINAL_PATTERN.test(value);
}

function gate(target: ReferenceTarget | null, confidence: number, reason: ReferenceReason): ReferenceResolution {
  if (target && confidence >= REFERENCE_CONFIDENCE_THRESHOLD) {
    return { target, confidence, reason };
  }
  if (confidence > 0 && confidence < REFERENCE_CONFIDENCE_THRESHOLD) {
    return { target: null, confidence, reason: 'LOW_CONFIDENCE' };
  }
  return { target: null, confidence: 0, reason };
}

function parseOrdinal(raw: string | undefined): number | null {
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const digits: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10
  };
  if (raw === '十') return 10;
  if (raw.startsWith('十')) return 10 + (digits[raw.slice(1)] ?? 0);
  if (raw.endsWith('十')) return (digits[raw.slice(0, -1)] ?? 0) * 10;
  if (raw.includes('十')) {
    const [tens, ones] = raw.split('十');
    return (digits[tens ?? ''] ?? 0) * 10 + (digits[ones ?? ''] ?? 0);
  }
  return digits[raw] ?? null;
}

type Side = 'left' | 'right' | 'top' | 'bottom' | 'reading';

function sideOf(raw: string | undefined): Side {
  if (raw === '左') return 'left';
  if (raw === '右') return 'right';
  if (raw === '上') return 'top';
  if (raw === '下') return 'bottom';
  return 'reading';
}

/** 屏幕坐标系：y 越小越靠上。 */
function sortPlacements(list: readonly AgentPlacementHint[], side: Side): AgentPlacementHint[] {
  const copy = list.slice();
  copy.sort((a, b) => {
    if (side === 'left') return a.x - b.x || a.y - b.y;
    if (side === 'right') return b.x - a.x || a.y - b.y;
    if (side === 'top') return a.y - b.y || a.x - b.x;
    if (side === 'bottom') return b.y - a.y || a.x - b.x;
    return a.y - b.y || a.x - b.x;
  });
  return copy;
}

function parseRecentTarget(action: AgentContext['recentActions'][number] | undefined): {
  target: ReferenceTarget | null;
  weak: boolean;
} {
  if (!action) return { target: null, weak: false };
  const match = action.summary.match(TARGET_MARKER);
  if (!match) return { target: null, weak: OBJECT_TOOLS.has(action.tool) };
  const kind = match[1] as AgentSelectionKind;
  const id = (match[2] ?? '').trim();
  const label = (match[3] ?? '').trim() || id;
  if (!SELECTION_KINDS.has(kind) || !id) return { target: null, weak: OBJECT_TOOLS.has(action.tool) };
  return {
    target: { kind, id, label, source: 'recent' },
    weak: false
  };
}

function resolveGeometry(text: string, context: AgentContext): ReferenceResolution | null {
  const positional = text.match(POSITIONAL_PATTERN);
  const ordinalOnly = text.match(ORDINAL_PATTERN);
  if (!positional && !ordinalOnly) return null;

  const side = sideOf(positional?.[1]);
  const ordinal = parseOrdinal(positional?.[2] ?? ordinalOnly?.[1]);
  const candidates = context.placements ?? [];
  if (candidates.length === 0 || ordinal === null) {
    return { target: null, confidence: 0, reason: 'NO_CANDIDATES' };
  }
  const ordered = sortPlacements(candidates, side);
  const picked = ordered[ordinal - 1];
  if (!picked) return { target: null, confidence: 0, reason: 'NO_CANDIDATES' };
  return {
    target: {
      kind: 'placement',
      id: picked.id,
      label: picked.label || picked.id,
      source: 'geometry'
    },
    confidence: 0.78,
    reason: 'GEOMETRY'
  };
}

/** `resolveReference(text, ctx)` → `{ target, confidence, reason }`。 */
export function resolveReference(text: string, context: AgentContext | null | undefined): ReferenceResolution {
  const value = (text ?? '').trim();
  if (!value || !context || !hasReferenceExpression(value)) {
    return { target: null, confidence: 0, reason: 'NO_REFERENCE' };
  }

  // 几何指代必须优先于「这个」：用户说「左边第二个」时，选中对象不一定是他指的那个。
  const geometry = resolveGeometry(value, context);
  if (geometry) return gate(geometry.target, geometry.confidence, geometry.reason);

  if (context.selection) {
    return gate({
      ...context.selection,
      source: 'selection'
    }, 0.95, 'SELECTION');
  }

  const latest = context.recentActions[context.recentActions.length - 1];
  const recent = parseRecentTarget(latest);
  if (recent.target) return gate(recent.target, 0.72, 'RECENT_ACTION');
  if (recent.weak) return gate(null, 0.45, 'LOW_CONFIDENCE');
  return { target: null, confidence: 0, reason: 'NO_CANDIDATES' };
}

/** 给侧栏显示依据文案，例如「已使用选中对象：QF1」。 */
export function describeReference(resolution: ReferenceResolution): string {
  if (!resolution.target) return '';
  const label = resolution.target.label || resolution.target.id;
  if (resolution.target.source === 'selection') return `已使用选中对象：${label}`;
  if (resolution.target.source === 'recent') return `已使用最近操作对象：${label}`;
  return `已使用底板对象：${label}`;
}
