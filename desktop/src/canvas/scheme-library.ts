// 方案库（纯逻辑）：一个 userData 里的多方案集合，用于「同一台机器的几个版本」并存
//
// 为什么不用 projects：工程记录里的 design 要过 validateMachineDesign（向导的机型设计），
// 画布图塞进去会被校验拒绝；这里给画布单独一个库，互不污染。
//
// 纪律：名字做去重与长度限制；同一个名字再保存 = 覆盖（并更新 savedAt），不做静默追加副本。
import type { MachineGraph } from './types.ts';

export const SCHEME_LIBRARY_SCHEMA = 'canvas-scheme-library/1';
export const MAX_SCHEMES = 50;
export const MAX_SCHEME_NAME = 40;

export interface SchemeEntry {
  name: string;
  savedAt: string;
  graph: MachineGraph;
}

export interface SchemeLibrary {
  schema: string;
  schemes: SchemeEntry[];
}

export function emptySchemeLibrary(): SchemeLibrary {
  return { schema: SCHEME_LIBRARY_SCHEMA, schemes: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 名称校验：非空、≤40 字、不含路径分隔符（避免写文件时出问题）。 */
export function validateSchemeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '方案名不能为空';
  if (trimmed.length > MAX_SCHEME_NAME) return `方案名最多 ${MAX_SCHEME_NAME} 字`;
  if (/[\\/]/.test(trimmed) || trimmed.includes('..')) return '方案名不能包含路径分隔符';
  return null;
}

export interface UpsertResult {
  library: SchemeLibrary;
  error: string | null;
  /** true = 覆盖了同名方案 */
  replaced: boolean;
}

export function upsertScheme(library: SchemeLibrary, name: string, graph: MachineGraph, savedAt: string): UpsertResult {
  const nameError = validateSchemeName(name);
  if (nameError) return { library, error: nameError, replaced: false };
  const trimmed = name.trim();
  const existing = library.schemes.find((entry) => entry.name === trimmed);
  if (!existing && library.schemes.length >= MAX_SCHEMES) {
    return { library, error: `方案库最多 ${MAX_SCHEMES} 个，请先删掉不用的`, replaced: false };
  }
  const entry: SchemeEntry = { name: trimmed, savedAt, graph };
  const schemes = existing
    ? library.schemes.map((item) => (item.name === trimmed ? entry : item))
    : [...library.schemes, entry];
  return { library: { schema: SCHEME_LIBRARY_SCHEMA, schemes }, error: null, replaced: Boolean(existing) };
}

export function removeScheme(library: SchemeLibrary, name: string): SchemeLibrary {
  if (!library.schemes.some((entry) => entry.name === name)) return library;
  return { schema: SCHEME_LIBRARY_SCHEMA, schemes: library.schemes.filter((entry) => entry.name !== name) };
}

/** 列表按保存时间倒序（最新在前），便于「刚才那个」直接点。 */
export function listSchemes(library: SchemeLibrary): Array<{ name: string; savedAt: string; nodes: number; edges: number }> {
  return [...library.schemes]
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
    .map((entry) => ({
      name: entry.name,
      savedAt: entry.savedAt,
      nodes: entry.graph?.nodes?.length ?? 0,
      edges: entry.graph?.edges?.length ?? 0
    }));
}

export interface ParseLibraryResult {
  library: SchemeLibrary;
  issues: string[];
  rejected: boolean;
}

/** 读回：schema 不匹配整份拒绝；坏条目逐条丢弃并报出。 */
export function parseSchemeLibrary(raw: unknown): ParseLibraryResult {
  if (raw === null || raw === undefined) return { library: emptySchemeLibrary(), issues: [], rejected: false };
  if (!isRecord(raw)) return { library: emptySchemeLibrary(), issues: ['方案库文件不是对象'], rejected: true };
  if (raw.schema !== SCHEME_LIBRARY_SCHEMA) {
    return { library: emptySchemeLibrary(), issues: [`方案库 schema 不匹配（期望 ${SCHEME_LIBRARY_SCHEMA}）`], rejected: true };
  }
  if (!Array.isArray(raw.schemes)) {
    return { library: emptySchemeLibrary(), issues: ['方案库缺少 schemes 数组'], rejected: true };
  }
  const library = emptySchemeLibrary();
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.schemes) {
    if (!isRecord(item) || typeof item.name !== 'string' || !isRecord(item.graph)) {
      issues.push('有一条方案缺少 name/graph，已丢弃');
      continue;
    }
    const nameError = validateSchemeName(item.name);
    if (nameError) {
      issues.push(`方案「${item.name}」${nameError}，已丢弃`);
      continue;
    }
    if (seen.has(item.name.trim())) {
      issues.push(`方案「${item.name}」重名，保留第一条`);
      continue;
    }
    seen.add(item.name.trim());
    library.schemes.push({
      name: item.name.trim(),
      savedAt: typeof item.savedAt === 'string' ? item.savedAt : '',
      graph: item.graph as unknown as MachineGraph
    });
  }
  return { library, issues, rejected: false };
}
