// UI 重构第 1 步收尾（机械侧 only）：挂载层。
//
// workbench.ts（约 107 KB）无法整文件推送，所以本模块把
// “怎么挂到页面上”做成独立文件，workbench.ts 后续只需加
// 一小段调用（见文件末尾注释），不需要重写它：
//
//   import { mountFeatureWorkbench } from './feature-tree-mount.ts';
//   mountFeatureWorkbench(doc, {
//     tree: document.getElementById('featureTree'),
//     panel: document.getElementById('propertyPanel')
//   }, (nextDoc) => { /* 脏子树重算 + 视口刷新 + 历史入栈，见第 2 步 */ });
//
// 本模块故意只依赖最小的容器接口（innerHTML + addEventListener），
// 不直接引用 DOM 类型，这样 node --test 可以用假容器验证全部行为；
// 真实页面上传入的 DOM 元素天然满足这个接口。
// 电气侧不在本模块：只挂机械特征树与机械属性面板。

import { applyDocFeatureEdit, type FeatureDocLike } from './feature-tree-doc.ts';
import { buildFeatureTree, findTreeNode, panelFieldsForFeature } from './feature-tree.ts';
import { renderFeatureTreeHtml, renderPanelHtml } from './feature-tree-view.ts';

export interface MountContainer {
  innerHTML: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface MountOptions {
  tree: MountContainer;
  panel: MountContainer;
  /** 文档变化时回调：调用方在此做脏子树重算、视口刷新、历史入栈。 */
  onDocChange?: (nextDoc: FeatureDocLike) => void;
}

function closestTreeId(event: unknown): string | null {
  const target = (event as { target?: unknown } | null)?.target as
    | { closest?: (selector: string) => { dataset?: { treeId?: string } } | null }
    | null
    | undefined;
  if (!target || typeof target.closest !== 'function') return null;
  const element = target.closest('[data-tree-id]');
  return element?.dataset?.treeId ?? null;
}

export function mountFeatureWorkbench(doc: FeatureDocLike, options: MountOptions) {
  let current = doc;
  let selectedId: string | null = null;

  function render(): void {
    const tree = buildFeatureTree(current);
    options.tree.innerHTML = renderFeatureTreeHtml(tree, selectedId);
    const selected = selectedId ? findTreeNode(tree, selectedId) : null;
    const feature = selectedId ? current.features.find((f) => f.id === selectedId) : undefined;
    options.panel.innerHTML = feature
      ? renderPanelHtml(feature.name, panelFieldsForFeature(feature))
      : renderPanelHtml('未选中特征', []);
  }

  options.tree.addEventListener('click', (event: unknown) => {
    const id = closestTreeId(event);
    if (id !== null) select(id);
  });

  function select(id: string): boolean {
    const tree = buildFeatureTree(current);
    if (!findTreeNode(tree, id)) return false;
    selectedId = id;
    render();
    return true;
  }

  function applyEdit(key: string, value: unknown): boolean {
    if (selectedId === null) return false;
    const result = applyDocFeatureEdit(current, selectedId, key, value);
    if (!result.ok || result.value === undefined) return false;
    current = result.value;
    render();
    options.onDocChange?.(current);
    return true;
  }

  render();
  return {
    select,
    applyEdit,
    getDoc: (): FeatureDocLike => current,
    getSelectedId: (): string | null => selectedId
  };
}
