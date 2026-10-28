// CAD 工作区左栏零件列表：分组 + 搜索（纯函数，便于 node --test）
//
// 背景：工程打开后真正可见的是 CAD 工作区左栏（`.cad-part-row`），不是经典结构树；
// 94 件导入工程在那里只能一条条滚。这里给出「按装配路径分组 + 按名字/路径过滤」的纯逻辑，
// 由 viewer 负责渲染与选中（保持 data-part-index 不变）。

export interface PartListInput {
  name: string;
  /** 装配层级（根 → 父节点），STEP 有结构时才有。 */
  path?: readonly string[];
}

export type PartListEntry =
  | { kind: 'group'; key: string; label: string; count: number; depth: number }
  | { kind: 'part'; index: number; name: string; group: string };

/** 分组键：取路径前两级拼起来；没有路径归到「未分层」。 */
export function partGroupLabel(path: readonly string[] | undefined): string {
  if (!path || path.length === 0) return '未分层';
  const parts = path.filter((segment) => segment.trim().length > 0).slice(0, 2);
  return parts.length > 0 ? parts.join(' > ') : '未分层';
}

/**
 * 生成列表条目：按第一级路径分组（保持出现顺序），组内按原索引升序。
 * 只有一组时仍然给组头——它承载「N 件」信息，也作为搜索时的锚点。
 */
export function buildPartListEntries(parts: readonly PartListInput[]): PartListEntry[] {
  const groups = new Map<string, number[]>();
  parts.forEach((part, index) => {
    const label = partGroupLabel(part.path);
    const bucket = groups.get(label);
    if (bucket) bucket.push(index);
    else groups.set(label, [index]);
  });
  const entries: PartListEntry[] = [];
  for (const [label, indices] of groups) {
    entries.push({ kind: 'group', key: label, label, count: indices.length, depth: 0 });
    for (const index of indices) {
      entries.push({ kind: 'part', index, name: parts[index]?.name ?? '', group: label });
    }
  }
  return entries;
}

export interface PartListFilterResult {
  /** 命中零件的索引（原索引）。 */
  matched: Set<number>;
  /** query 为空时返回 null，表示「不过滤」。 */
  active: boolean;
  /** 有命中的分组 label，用于显示/隐藏组头。 */
  groups: Set<string>;
}

/** 名字或装配路径包含 query（大小写不敏感）即命中；空 query 不过滤。 */
export function filterPartList(
  parts: readonly PartListInput[],
  query: string
): PartListFilterResult {
  const text = query.trim().toLowerCase();
  if (text === '') return { matched: new Set(parts.map((_part, index) => index)), active: false, groups: new Set() };
  const matched = new Set<number>();
  const groups = new Set<string>();
  parts.forEach((part, index) => {
    const haystack = [part.name, ...(part.path ?? [])].join(' ').toLowerCase();
    if (haystack.includes(text)) {
      matched.add(index);
      groups.add(partGroupLabel(part.path));
    }
  });
  return { matched, active: true, groups };
}
