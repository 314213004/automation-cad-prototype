/**
 * 主视口 3D 几何覆盖的工程存储（纯函数 + 可注入的 Storage）。
 *
 * 沿用桌面版渲染层已有的持久化方式：底板画布 `automationcad.enclosure.v1`、运动学标注、
 * 干涉忽略表都存在 Electron userData 下的 localStorage，重启 / 重新打开窗口后恢复。
 * 这里只存**内置零件**（底板/导轨/滑台/开关）的覆盖：原型自身不持久化从标准件库插入的零件，
 * 重启后 ins* 不存在，存了也会在挂载时被清掉，反而可能让新插入的同名零件继承旧尺寸。
 * 读回时逐项按参数表范围与装配合理性校验，坏数据整体丢弃，不画出脱轨的装配。
 */
import {
  assemblyViolation,
  isBuiltinPart,
  paramSchema,
  type ParamOverrides
} from './model.ts';

export const ORBIT_STORE_KEY = 'automationcad.orbit.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface StoredOrbit {
  version: 1;
  savedAt: string;
  overrides: ParamOverrides;
}

export type LoadResult =
  | { ok: true; overrides: ParamOverrides; dropped: string[] }
  | { ok: false; overrides: ParamOverrides; reason: string };

/** 只保留内置零件、参数表内、数值合法的覆盖。 */
export function persistableOverrides(overrides: ParamOverrides): { overrides: ParamOverrides; dropped: string[] } {
  const out: ParamOverrides = {};
  const dropped: string[] = [];
  Object.entries(overrides ?? {}).forEach(([partId, values]) => {
    if (!isBuiltinPart(partId) || !values || typeof values !== 'object') {
      dropped.push(partId);
      return;
    }
    const schema = paramSchema(partId, { inserted: [] });
    Object.entries(values).forEach(([key, raw]) => {
      const def = schema.find((item) => item.key === key);
      const value = typeof raw === 'number' ? raw : Number.NaN;
      if (!def || !Number.isFinite(value) || value < def.min || value > def.max) {
        dropped.push(`${partId}.${key}`);
        return;
      }
      out[partId] = { ...(out[partId] ?? {}), [key]: value };
    });
  });
  return { overrides: out, dropped };
}

export function serializeOrbit(overrides: ParamOverrides, now: Date = new Date()): string {
  const payload: StoredOrbit = { version: 1, savedAt: now.toISOString(), overrides: persistableOverrides(overrides).overrides };
  return JSON.stringify(payload);
}

export function parseStoredOrbit(raw: string | null | undefined): LoadResult {
  if (!raw) return { ok: true, overrides: {}, dropped: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, overrides: {}, reason: '工程存储不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    return { ok: false, overrides: {}, reason: '工程存储版本不符' };
  }
  const source = (parsed as { overrides?: unknown }).overrides;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, overrides: {}, reason: '工程存储缺少 overrides' };
  }
  const { overrides, dropped } = persistableOverrides(source as ParamOverrides);
  const violation = assemblyViolation({ inserted: [], overrides });
  if (violation) return { ok: false, overrides: {}, reason: `工程存储的几何不合法：${violation}` };
  return { ok: true, overrides, dropped };
}

export function loadOrbit(storage: StorageLike | null): LoadResult {
  if (!storage) return { ok: true, overrides: {}, dropped: [] };
  let raw: string | null = null;
  try {
    raw = storage.getItem(ORBIT_STORE_KEY);
  } catch {
    return { ok: false, overrides: {}, reason: '工程存储不可读' };
  }
  return parseStoredOrbit(raw);
}

/** 写入失败（存储不可用 / 配额满）不影响当前编辑，只返回 false。没有覆盖时删除键。 */
export function saveOrbit(storage: StorageLike | null, overrides: ParamOverrides, now: Date = new Date()): boolean {
  if (!storage) return false;
  try {
    const kept = persistableOverrides(overrides).overrides;
    if (Object.keys(kept).length === 0 && storage.removeItem) storage.removeItem(ORBIT_STORE_KEY);
    else storage.setItem(ORBIT_STORE_KEY, serializeOrbit(kept, now));
    return true;
  } catch (error) {
    console.warn('[ORBIT_PERSIST_FAILED]', { site: 'desktop/src/orbit/persist.ts' }, error);
    return false;
  }
}
