/**
 * 结构树 ↔ 3D 零件映射（纯函数）。输入是原型 `ProtoApi.getTree()` 的 JSON 拷贝。
 *
 * 规则：
 * - 叶子节点 `id === part`（如 cyl / rod / ins1）是零件本体；
 * - `kind === 'grp'` 且带 part 的组节点（如 g-cyl）代表该零件 + 子孙零件；
 * - 「标准件」文件夹里 `std1..3` 只是借用 base/rail/cyl 的代理节点（id ≠ part），
 *   选中它们不应把底板/导轨/气缸当成标准件高亮，因此不计入组展开。
 */
export interface ProtoTreeNode {
  id: string;
  label?: string;
  kind?: string;
  part?: string;
  children?: ProtoTreeNode[];
}

function walk(list: readonly ProtoTreeNode[] | undefined, visit: (node: ProtoTreeNode, parents: ProtoTreeNode[]) => boolean | void, parents: ProtoTreeNode[] = []): boolean {
  for (const node of list ?? []) {
    if (visit(node, parents) === true) return true;
    if (walk(node.children, visit, [...parents, node])) return true;
  }
  return false;
}

export function findTreeNode(tree: readonly ProtoTreeNode[], id: string): ProtoTreeNode | null {
  let found: ProtoTreeNode | null = null;
  walk(tree, (node) => {
    if (node.id === id) { found = node; return true; }
    return false;
  });
  return found;
}

function ownsPart(node: ProtoTreeNode): boolean {
  return !!node.part && (node.id === node.part || node.kind === 'grp');
}

/** 选中某树节点时 3D 中应高亮的零件 id（去重、保持树序）。 */
export function partsForNode(tree: readonly ProtoTreeNode[], nodeId: string): string[] {
  const node = findTreeNode(tree, nodeId);
  if (!node) return [];
  const out: string[] = [];
  const add = (id: string | undefined): void => { if (id && !out.includes(id)) out.push(id); };
  if (node.part) add(node.part);
  walk(node.children, (child) => { if (ownsPart(child)) add(child.part); });
  return out;
}

/**
 * 3D 拾取到零件后对应的树节点：优先 id === part 的本体叶子，
 * 其次任意带该 part 的组节点，最后才是代理节点。
 */
export function nodeForPart(tree: readonly ProtoTreeNode[], partId: string): string | null {
  let exact: string | null = null;
  let group: string | null = null;
  let proxy: string | null = null;
  walk(tree, (node) => {
    if (node.part !== partId) return false;
    if (node.id === partId) { exact = node.id; return true; }
    if (node.kind === 'grp' && !group) group = node.id;
    else if (!proxy) proxy = node.id;
    return false;
  });
  return exact ?? group ?? proxy;
}

/** 树中所有 3D 零件 id（本体，不含代理）。 */
export function allPartIds(tree: readonly ProtoTreeNode[]): string[] {
  const out: string[] = [];
  walk(tree, (node) => { if (ownsPart(node) && node.part && !out.includes(node.part)) out.push(node.part); });
  return out;
}

/** 原型从标准件库插入的零件（标准件组里 id 以 ins 开头），保持插入顺序。 */
export function insertedIdsFromTree(tree: readonly ProtoTreeNode[]): string[] {
  const group = findTreeNode(tree, 'g-std');
  return (group?.children ?? [])
    .filter((node) => /^ins\d+$/.test(node.id) && node.part === node.id)
    .map((node) => node.id);
}

/** 从树取根到节点的标签路径（状态提示用）。 */
export function nodePath(tree: readonly ProtoTreeNode[], nodeId: string): string[] {
  let path: string[] = [];
  walk(tree, (node, parents) => {
    if (node.id === nodeId) {
      path = [...parents, node].map((item) => item.label ?? item.id);
      return true;
    }
    return false;
  });
  return path;
}

/** 选择集 = 原型 SVG 选中 ∪ 组节点展开；文件夹节点（无 part）替换掉原型残留的旧零件选中。 */
export function resolveSelection(treeNodes: readonly ProtoTreeNode[], svgSelected: readonly string[], nodeId: string | null): string[] {
  if (!nodeId) return [...svgSelected];
  const node = findTreeNode(treeNodes, nodeId);
  if (!node) return [...svgSelected];
  if (!node.part) return partsForNode(treeNodes, nodeId);
  if (node.kind === 'grp') {
    const out = [...svgSelected];
    partsForNode(treeNodes, nodeId).forEach((id) => { if (!out.includes(id)) out.push(id); });
    return out;
  }
  return [...svgSelected];
}

