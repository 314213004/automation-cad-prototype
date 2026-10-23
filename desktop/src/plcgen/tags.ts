import type { PlcGenConfig, TagRow, TagTable } from './types.ts';
import { collectIoRefs, sanitizeTagName } from './io.ts';

export const TAG_CSV_HEADER = ['地址', '名称', '数据类型', '注释', '工位'] as const;
export const TAG_NAME_MAX_LENGTH = 32;

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

function uniqueName(base: string, used: Set<string>): string {
  const sanitizedBase = sanitizeTagName(base, TAG_NAME_MAX_LENGTH);
  let candidate = sanitizedBase;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let suffix = 2;
  while (true) {
    const tail = `_${suffix}`;
    candidate = `${truncate(sanitizedBase, TAG_NAME_MAX_LENGTH - tail.length)}${tail}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function addressOf(area: 'input' | 'output', index: number): string {
  return `${area === 'input' ? 'I' : 'Q'}${Math.floor(index / 8)}.${index % 8}`;
}

/** 按 I 区、Q 区分开顺序分配地址；点位先按自然序稳定排序。 */
export function buildTags(config: PlcGenConfig): TagTable {
  const refs = collectIoRefs(config);
  const usedNames = new Set<string>();
  let inputIndex = 0;
  let outputIndex = 0;
  const rows: TagRow[] = refs.map((ref) => {
    const address = ref.area === 'input'
      ? addressOf('input', inputIndex++)
      : addressOf('output', outputIndex++);
    const owner = ref.actuatorName
      ?? (ref.station === '安全' ? '安全回路' : '通用');
    const name = uniqueName(`${ref.station}_${owner}_${ref.purpose}`, usedNames);
    return {
      address,
      name,
      type: 'BOOL',
      comment: ref.comment,
      station: ref.station
    };
  });

  const lines = [
    TAG_CSV_HEADER.map(csvCell).join(','),
    ...rows.map((row) => [
      row.address,
      row.name,
      row.type,
      row.comment,
      row.station
    ].map(csvCell).join(','))
  ];
  return {
    rows,
    csv: `\uFEFF${lines.join('\r\n')}`
  };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `buildTags`。 */
export const generateTags = buildTags;
