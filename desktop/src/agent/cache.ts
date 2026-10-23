/**
 * 会话内工具结果短缓存（P7-N）
 *
 * 只缓存三个稳定的只读查询：`get_bom` / `get_project_context` / `list_components`。
 * - 键 = `(tool, canonicalArgs, projectFingerprint)`；
 * - 默认 TTL 30 秒，仅存在于当前 AgentSession 内存，不落盘、不跨会话；
 * - 任何写工具执行后清空缓存，避免 BOM / 底板 / 成本读到旧状态；
 * - 指纹变化视为未命中，并删除旧条目。
 */

import { toolCallKey } from './dedupe.ts';

export const DEFAULT_RESULT_CACHE_TTL_MS = 30_000;
export const CACHEABLE_TOOLS = new Set([
  'get_bom',
  'get_project_context',
  'list_components'
]);

export type CacheScope = 'bom' | 'plate' | 'cost' | 'all';

export interface ToolResultCacheOptions {
  ttlMs?: number;
  now?: () => number;
  maxEntries?: number;
}

export interface CacheLookup {
  hit: boolean;
  result?: unknown;
  ageMs?: number;
  key: string;
}

interface CacheEntry {
  fingerprint: string;
  result: unknown;
  storedAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
}

/** 工具结果是否会改变工程状态；所有写工具都应调用 invalidateAll。 */
export function isCacheableTool(tool: string): boolean {
  return CACHEABLE_TOOLS.has(tool);
}

/** 写工具对应需要失效的范围（当前三个缓存都属于 BOM/底板派生数据）。 */
export function cacheScopeForWrite(_tool: string): CacheScope {
  return 'all';
}

export class ToolResultCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private hitCount = 0;
  private missCount = 0;
  private invalidationCount = 0;

  constructor(options: ToolResultCacheOptions = {}) {
    this.ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? DEFAULT_RESULT_CACHE_TTL_MS));
    this.now = options.now ?? Date.now;
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 64));
  }

  private key(tool: string, args: unknown, _fingerprint: string): string {
    // 指纹只作为条目字段参与命中判断；键里不含指纹，才能在指纹变化时删掉旧条目。
    return toolCallKey(tool, args);
  }

  get(tool: string, args: unknown, fingerprint: string): CacheLookup {
    const key = this.key(tool, args, fingerprint);
    if (!isCacheableTool(tool)) return { hit: false, key };
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount += 1;
      return { hit: false, key };
    }
    const ageMs = Math.max(0, this.now() - entry.storedAt);
    if (entry.fingerprint !== fingerprint || ageMs >= this.ttlMs) {
      this.entries.delete(key);
      this.missCount += 1;
      return { hit: false, key };
    }
    this.hitCount += 1;
    return { hit: true, result: entry.result, ageMs, key };
  }

  /** 只缓存成功结果；失败结果不进入 TTL 缓存，避免把临时错误放大 30 秒。 */
  set(tool: string, args: unknown, fingerprint: string, result: unknown): boolean {
    if (!isCacheableTool(tool)) return false;
    if (isRecord(result) && result.ok === false) return false;
    const key = this.key(tool, args, fingerprint);
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, result, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** 写工具后调用；未指定范围时清空全部会话缓存。 */
  invalidate(_scope: CacheScope = 'all'): number {
    const removed = this.entries.size;
    this.entries.clear();
    this.invalidationCount += 1;
    return removed;
  }

  invalidateAfterWrite(tool?: string): number {
    return this.invalidate(tool ? cacheScopeForWrite(tool) : 'all');
  }

  clear(): void {
    this.entries.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.invalidationCount = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      invalidations: this.invalidationCount,
      size: this.entries.size
    };
  }

  size(): number {
    return this.entries.size;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
