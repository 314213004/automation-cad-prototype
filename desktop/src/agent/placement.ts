/**
 * 底板放置的纯函数：中文指令 → 坐标/旋转/吸附参数，型号文本 → 元器件。
 *
 * 路由层只负责抽取候选（`partRef`），真正的唯一命中判定放在这里，避免
 * `router.ts` 依赖数据包注册表；工具层拿到候选后调用 `resolvePartReference`，
 * 多义时返回 AMBIGUOUS 让用户选，而不是猜一个型号放上去。
 */

import type { ComponentPart } from '../shared/types.ts';

export interface PlacementSpec {
  x?: number;
  y?: number;
  rotate: boolean;
  railSnap: boolean;
  /** 用户输入的物料号或型号候选；路由层不保证它已经唯一命中。 */
  partRef?: string;
}

export interface PartCandidate {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  packId?: string;
}

export type PartResolution =
  | { ok: true; part: ComponentPart }
  | {
      ok: false;
      code: 'PART_NOT_FOUND' | 'AMBIGUOUS';
      message: string;
      candidates?: PartCandidate[];
    };

const EXPLICIT_PART_ID = /(?:partId|物料号|物料编号|物料\s*号)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/i;
const MODEL_BEFORE_VERB = /([A-Za-z0-9][A-Za-z0-9._ /-]*?)\s*(?:放到|放在|摆在|摆到|放置到|放置在)/;
const MODEL_AFTER_VERB =
  /(?:放|摆|加)(?:一个|个|一件|一只)?\s*([A-Za-z0-9][A-Za-z0-9._ /-]*?)\s*(?=在|到|于|位置|坐标|$)/;
const MODEL_TOKEN =
  /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+|[A-Za-z]{2,}[0-9][A-Za-z0-9]{2,}|[A-Za-z]{1,3}[0-9]{2,}[A-Za-z0-9]*)(?![A-Za-z0-9])/g;
const XY_PAIR = /(?:x\s*[:=：]\s*)?(-?\d+(?:\.\d+)?)\s*(?:mm)?\s*[,，]\s*(?:y\s*[:=：]\s*)?(-?\d+(?:\.\d+)?)\s*(?:mm)?/i;
const X_VALUE = /(?:^|[^A-Za-z0-9])x\s*[:=：]\s*(-?\d+(?:\.\d+)?)/i;
const Y_VALUE = /(?:^|[^A-Za-z0-9])y\s*[:=：]\s*(-?\d+(?:\.\d+)?)/i;

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 抽取物料号/型号候选；只找 ASCII 型号片段，避免把中文类别当成 partId。 */
export function extractPartReference(text: string): string | undefined {
  const explicit = text.match(EXPLICIT_PART_ID)?.[1];
  if (explicit) return explicit;

  // 优先保留带空格的完整型号（如「iC65N 1P C16」），否则模糊匹配会只剩
  // 「iC65N」而误报多义；纯类别（中文/中文+字母）仍交给下面的 ASCII 片段兜底。
  const before = text.match(MODEL_BEFORE_VERB)?.[1]?.trim();
  if (before) return before;
  const after = text.match(MODEL_AFTER_VERB)?.[1]?.trim();
  if (after) return after;

  MODEL_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(MODEL_TOKEN)) {
    const token = match[1]?.trim();
    if (!token) continue;
    if (/^[xy]$/i.test(token)) continue;
    return token;
  }
  return undefined;
}

/** 抽取放置参数。`x/y` 只认成对坐标或显式 `x=`/`y=`，不会把「2 号工位」当坐标。 */
export function extractPlacementSpec(text: string): PlacementSpec {
  const value = (text ?? '').trim();
  const partRef = extractPartReference(value);
  const pair = value.match(XY_PAIR);
  let x = toNumber(pair?.[1]);
  let y = toNumber(pair?.[2]);
  if (x === undefined || y === undefined) {
    const xOnly = toNumber(value.match(X_VALUE)?.[1]);
    const yOnly = toNumber(value.match(Y_VALUE)?.[1]);
    if (xOnly !== undefined && yOnly !== undefined) {
      x = xOnly;
      y = yOnly;
    }
  }
  return {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    rotate: /旋转|转\s*90|横放|竖放|竖向|横向/.test(value),
    railSnap: !/不吸附|不要吸附|不贴导轨|不自动吸附/.test(value),
    ...(partRef ? { partRef } : {})
  };
}

/** 是否明确是「底板放置」而不是普通装配体插入。 */
export function isPlacementInstruction(text: string, spec: PlacementSpec = extractPlacementSpec(text)): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  if (/(?<!添)(?:放|摆|加)(?:一个|个|一件|一只)/.test(value)) return true;
  if (/(?:放到|放在|摆在|摆到|放置到|放置在)/.test(value)) return true;
  if (/(?:放|摆|加).*(?:位置|坐标|mm)/i.test(value)) return true;
  const hasVerb = /(?:放|摆|加)/.test(value);
  if (!hasVerb || /(?:哪些|什么|有没有|列出|查询|查一下)/.test(value)) return false;
  if (/底板|电箱|配电箱|画布|导轨|柜内/.test(value)) return true;
  if (spec.x !== undefined && spec.y !== undefined) return true;
  return false;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\-_./\\]+/g, '');
}

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase('zh-CN')
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenMatches(candidateTokens: string[], token: string): boolean {
  return candidateTokens.some((candidate) => {
    if (candidate === token) return true;
    // 型号常带后缀（LC1D18 → LC1D18M7C）；只对 3 字符以上的片段做前缀匹配，
    // 否则「1P」「C16」这类短词会把整个库都算成候选。
    return token.length >= 3 && candidate.length >= 3 && (candidate.startsWith(token) || token.startsWith(candidate));
  });
}

function candidateOf(part: ComponentPart): PartCandidate {
  return {
    id: part.id,
    model: part.model,
    category: part.category,
    ...(part.vendor ? { vendor: part.vendor } : {}),
    ...(part.packId ? { packId: part.packId } : {})
  };
}

/**
 * 型号解析：
 * 1. 先按 partId 精确匹配（忽略大小写）；
 * 2. 再按 id/型号归一化后的包含关系与词元匹配；
 * 3. 只有唯一命中才返回 part，多个命中返回 AMBIGUOUS + 候选列表。
 */
export function resolvePartReference(parts: ComponentPart[], reference: string): PartResolution {
  const ref = (reference ?? '').trim();
  if (!ref) {
    return { ok: false, code: 'PART_NOT_FOUND', message: '请提供物料号或型号' };
  }

  const exact = parts.find((part) => part.id === ref) ??
    parts.find((part) => part.id.toLocaleLowerCase('zh-CN') === ref.toLocaleLowerCase('zh-CN'));
  if (exact) return { ok: true, part: exact };

  const refNormalized = normalize(ref);
  const refTokens = tokens(ref);
  const matches = parts.filter((part) => {
    const idNormalized = normalize(part.id);
    const modelNormalized = normalize(part.model);
    if (idNormalized === refNormalized || modelNormalized === refNormalized) return true;
    if (refNormalized.length >= 3 && (idNormalized.includes(refNormalized) || modelNormalized.includes(refNormalized))) {
      return true;
    }
    if (refTokens.length === 0) return false;
    const haystack = [...tokens(part.id), ...tokens(part.model)];
    return refTokens.every((token) => tokenMatches(haystack, token));
  });

  if (matches.length === 1) return { ok: true, part: matches[0]! };
  if (matches.length > 1) {
    const candidates = matches.slice(0, 10).map(candidateOf);
    return {
      ok: false,
      code: 'AMBIGUOUS',
      message:
        `型号「${ref}」匹配到 ${matches.length} 个元件：` +
        candidates.map((candidate) => `${candidate.id}（${candidate.model}）`).join('、') +
        '，请指定 partId',
      candidates
    };
  }
  return { ok: false, code: 'PART_NOT_FOUND', message: `元器件不存在：${ref}` };
}
