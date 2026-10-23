import type { PlcGenConfig, TagRow } from './types.ts';
import { buildTags } from './tags.ts';
import { collectIoRefs, normalizePointKey, type IoRef } from './io.ts';

export interface TagBinding {
  ref: IoRef;
  row: TagRow;
}

/** IO 收集顺序与变量表分配顺序一致，二者按位置绑定。 */
export function buildTagBindings(config: PlcGenConfig): TagBinding[] {
  const refs = collectIoRefs(config);
  const rows = buildTags(config).rows;
  if (refs.length !== rows.length) {
    throw new Error('PLC 变量表与 IO 点位数量不一致');
  }
  return refs.map((ref, index) => {
    const row = rows[index];
    if (!row) throw new Error(`PLC 变量表行不存在：${index + 1}`);
    return { ref, row };
  });
}

/**
 * 点位 / 地址 / 变量名 → 变量名。步序既可引用原始点位（X0、Y0），
 * 也可引用显式地址或已经生成好的变量名。
 */
export function buildSymbolMap(config: PlcGenConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const binding of buildTagBindings(config)) {
    map.set(normalizePointKey(binding.ref.point), binding.row.name);
    map.set(normalizePointKey(binding.row.address), binding.row.name);
    if (binding.ref.sourceAddress) {
      map.set(normalizePointKey(binding.ref.sourceAddress), binding.row.name);
    }
    map.set(`VAR:${binding.row.name}`, binding.row.name);
  }
  return map;
}

export function resolveSymbol(map: Map<string, string>, token: string): string | undefined {
  return map.get(normalizePointKey(token)) ?? map.get(`VAR:${token.trim()}`);
}

export function tagRef(variable: string): string {
  return `"DB_IO".${variable}`;
}

export function outputBindings(config: PlcGenConfig): TagBinding[] {
  return buildTagBindings(config).filter((binding) => binding.ref.area === 'output');
}
