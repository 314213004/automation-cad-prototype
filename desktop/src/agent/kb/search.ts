import kbSource from './kb.json' with { type: 'json' };
import type { KbChunk, KbMeta } from './index.ts';

export interface DocHit {
  source: string;
  heading: string;
  snippet: string;
  score: number;
}

interface KbFile {
  meta: KbMeta;
  chunks: KbChunk[];
}

interface IndexedChunk {
  chunk: KbChunk;
  termFrequency: Map<string, number>;
  length: number;
  searchText: string;
}

const KB = kbSource as unknown as KbFile;
const K1 = 1.5;
const B = 0.75;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;
const SNIPPET_CHARS = 240;
export const SEARCH_CONTEXT_MAX_BYTES = 2048;

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const WORD_RUN = /[a-z0-9]+/g;

/** 中文 2-gram + 英文/数字词；大小写与全半角先归一化。 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  for (const word of normalized.match(WORD_RUN) ?? []) tokens.push(word);
  return tokens;
}

function indexChunk(chunk: KbChunk): IndexedChunk {
  const searchText = `${chunk.heading}\n${chunk.text}`;
  const frequencies = new Map<string, number>();
  const tokens = tokenize(searchText);
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return { chunk, termFrequency: frequencies, length: tokens.length, searchText };
}

const CHUNKS: IndexedChunk[] = Array.isArray(KB.chunks) ? KB.chunks.map(indexChunk) : [];
const AVERAGE_LENGTH = CHUNKS.length > 0
  ? CHUNKS.reduce((sum, entry) => sum + entry.length, 0) / CHUNKS.length
  : 1;
const DOCUMENT_FREQUENCY = new Map<string, number>();
for (const entry of CHUNKS) {
  for (const token of entry.termFrequency.keys()) {
    DOCUMENT_FREQUENCY.set(token, (DOCUMENT_FREQUENCY.get(token) ?? 0) + 1);
  }
}

export const KB_STATS = {
  docs: KB.meta?.docs ?? 0,
  chunks: CHUNKS.length,
  bytes: KB.meta?.bytes ?? 0,
  truncated: KB.meta?.truncated === true
} as const;

function idf(token: string): number {
  const total = CHUNKS.length;
  const frequency = DOCUMENT_FREQUENCY.get(token) ?? 0;
  return Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncateToBytes(text: string, limit: number): string {
  if (byteLength(text) <= limit) return text;
  const encoder = new TextEncoder();
  let result = '';
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > limit) break;
    result += char;
    used += size;
  }
  return result;
}

function snippetFor(entry: IndexedChunk, terms: string[]): string {
  const text = entry.chunk.text;
  if (!text) return entry.chunk.heading.slice(0, SNIPPET_CHARS);
  const lower = text.normalize('NFKC').toLowerCase();
  let matchIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) matchIndex = index;
  }
  if (matchIndex < 0) return text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS - 1)}…`;
  const half = Math.floor(SNIPPET_CHARS / 3);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function fitContext(hits: DocHit[]): DocHit[] {
  const fitted = hits.map((hit) => ({ ...hit }));
  let guard = 0;
  while (byteLength(JSON.stringify({ hits: fitted })) > SEARCH_CONTEXT_MAX_BYTES && guard < 200) {
    guard += 1;
    let target = -1;
    let longest = 0;
    for (const [index, hit] of fitted.entries()) {
      const size = byteLength(hit.snippet);
      if (size > longest) {
        longest = size;
        target = index;
      }
    }
    if (target < 0) break;
    const current = fitted[target]!;
    if (current.snippet.length <= 12) {
      if (fitted.length <= 1) break;
      fitted.pop();
      continue;
    }
    const shortened = truncateToBytes(current.snippet, Math.max(8, byteLength(current.snippet) - 64)).trimEnd();
    fitted[target] = { ...current, snippet: `${shortened}…` };
  }
  return fitted;
}

export interface SearchDocsOptions {
  /** 1–5，默认 3。 */
  limit?: number;
}

/** 纯函数检索：只读内嵌 kb.json，无 IO、无网络、无随机性。 */
export function searchDocs(query: string, options: SearchDocsOptions | number = {}): DocHit[] {
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return [];
  const requested = typeof options === 'number' ? options : options.limit;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const queryTokens = [...new Set(tokenize(text))];
  if (queryTokens.length === 0) return [];

  const scored: Array<{ entry: IndexedChunk; score: number; matched: number }> = [];
  for (const entry of CHUNKS) {
    let score = 0;
    let matched = 0;
    const normalizer = K1 * (1 - B + B * (entry.length / AVERAGE_LENGTH));
    for (const token of queryTokens) {
      const termFrequency = entry.termFrequency.get(token) ?? 0;
      if (termFrequency === 0) continue;
      matched += 1;
      score += idf(token) * ((termFrequency * (K1 + 1)) / (termFrequency + normalizer));
    }
    if (matched > 0 && score > 0) scored.push({ entry, score, matched });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.matched !== left.matched) return right.matched - left.matched;
    if (left.entry.chunk.file !== right.entry.chunk.file) {
      return left.entry.chunk.file.localeCompare(right.entry.chunk.file);
    }
    return left.entry.chunk.line - right.entry.chunk.line;
  });

  const hits = scored.slice(0, limit).map(({ entry, score }) => ({
    source: entry.chunk.source,
    heading: entry.chunk.heading,
    snippet: snippetFor(entry, queryTokens),
    score: Number(score.toFixed(4))
  }));
  return fitContext(hits);
}

export function isCjkToken(token: string): boolean {
  return CJK.test(token);
}
