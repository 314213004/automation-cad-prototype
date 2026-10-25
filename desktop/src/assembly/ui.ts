/**
 * 标准件装配面板：从库里把标准件拖进 3D，落位时吸附到命中面并沿法向对齐。
 *
 * 交互两条路，都能用：
 * 1. 拖拽：列表项 draggable → 拖到 3D 视图松开（拖动过程显示半透明预览体）
 * 2. 点选：点列表项进入「待放置」→ 在视图里点一下（鼠标精度更高，也便于自动化验证）
 */

import { createDrawer, notify, errorMessage, escapeHtml, type DrawerHandle } from '../ui/panels.ts';
import { dimsForPart, type PartDims } from './dims.ts';
import { createInstance, type AssemblyInstance, type SurfaceHit } from './instances.ts';
import type { OrbitView } from '../orbit/view.ts';

interface PackPart {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  packName?: string;
  specs?: Record<string, unknown>;
}

export interface AssemblyUiHandle {
  open(): void;
  close(): void;
  state(): {
    instances: Array<{ id: string; model: string; partId: string; position: [number, number, number]; snappedTo: string; estimated: boolean }>;
    armed: string | null;
    count: number;
  };
  /** 供测试/自动化用：在客户端坐标处放置一个标准件 */
  placeAt(partId: string, clientX: number, clientY: number): { ok: boolean; message: string; id?: string };
  remove(id: string): boolean;
  clear(): void;
}

interface DrawCall {
  handle: DrawerHandle | null;
  view: OrbitView;
  host: HTMLElement | null;
  instances: AssemblyInstance[];
  parts: PackPart[];
  armed: PackPart | null;
  query: string;
  category: string;
}

const draw: DrawCall = {
  handle: null,
  view: null as unknown as OrbitView,
  host: null,
  instances: [],
  parts: [],
  armed: null,
  query: '',
  category: ''
};

function stageHost(): HTMLElement | null {
  return document.getElementById('stageAssembly') ?? document.querySelector('#cadOverlay .cad-stage') as HTMLElement | null;
}

async function loadParts(): Promise<void> {
  const api = window.desktop?.packs;
  if (!api) {
    draw.parts = [];
    return;
  }
  try {
    draw.parts = await api.listParts({ ...(draw.query ? { q: draw.query } : {}), ...(draw.category ? { category: draw.category } : {}) }) as PackPart[];
  } catch (error) {
    draw.parts = [];
    notify(errorMessage(error), true);
  }
}

function dimsOf(part: PackPart): PartDims {
  return dimsForPart(part);
}

function renderList(): void {
  const body = draw.handle?.body;
  if (!body) return;
  const categories = [...new Set(draw.parts.map((p) => p.category))].sort();
  const rows = draw.parts.slice(0, 120).map((part) => {
    const dims = dimsOf(part);
    const sizeText = dims.shape === 'cylinder'
      ? `φ${dims.diameter ?? '?'} × ${dims.size[2]}`
      : `${dims.size[0]}×${dims.size[1]}×${dims.size[2]}`;
    const active = draw.armed?.id === part.id ? ' is-armed' : '';
    return `<button type="button" class="asm-part${active}" draggable="true" data-asm-part="${escapeHtml(part.id)}"
        title="${escapeHtml(dims.source)}${dims.estimated ? '（尺寸为估算）' : ''}">
      <span class="asm-part-model">${escapeHtml(part.model)}</span>
      <span class="asm-part-cat">${escapeHtml(part.category)}</span>
      <span class="asm-part-size">${escapeHtml(sizeText)}${dims.estimated ? ' · 估' : ''}</span>
    </button>`;
  }).join('');
  body.innerHTML = `
    <div class="asm-toolbar">
      <input type="search" id="asmSearch" placeholder="搜索型号 / 品类…" value="${escapeHtml(draw.query)}">
      <select id="asmCategory">
        <option value="">全部品类</option>
        ${categories.map((c) => `<option value="${escapeHtml(c)}"${c === draw.category ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
    </div>
    <p class="asm-hint">拖到左边 3D 视图里落位，或点一下再在视图里点位置。落位会自动贴合命中面并对齐法向。</p>
    <div class="asm-list">${rows || '<p class="asm-hint">没有匹配的标准件</p>'}</div>
    <div class="asm-instances">
      <div class="asm-instances-head"><span>已放置</span><b>${draw.instances.length}</b></div>
      ${draw.instances.map((item) => `
        <div class="asm-instance" data-asm-instance="${escapeHtml(item.id)}">
          <span>${escapeHtml(item.model)}</span>
          <span class="asm-instance-pos">${item.position.map((v) => Math.round(v)).join(', ')}</span>
          <span class="asm-instance-snap">${item.snappedTo === 'ground' ? '基准面' : '零件面'}</span>
          <button type="button" class="acp-icon-btn" data-asm-remove="${escapeHtml(item.id)}" title="删除">×</button>
        </div>`).join('') || '<p class="asm-hint">还没有放置任何标准件</p>'}
    </div>`;
  bindListEvents(body);
}

function bindListEvents(body: HTMLElement): void {
  const search = body.querySelector<HTMLInputElement>('#asmSearch');
  search?.addEventListener('input', () => {
    draw.query = search.value.trim();
    void loadParts().then(() => { renderList(); });
  });
  const select = body.querySelector<HTMLSelectElement>('#asmCategory');
  select?.addEventListener('change', () => {
    draw.category = select.value;
    void loadParts().then(() => { renderList(); });
  });
  body.querySelectorAll<HTMLElement>('[data-asm-part]').forEach((button) => {
    const id = button.dataset.asmPart ?? '';
    const part = draw.parts.find((p) => p.id === id);
    if (!part) return;
    button.addEventListener('click', () => {
      draw.armed = draw.armed?.id === part.id ? null : part;
      renderList();
    });
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', id);
      draw.armed = part;
    });
    button.addEventListener('dragend', () => {
      draw.view.previewAssemblyInstance(null);
    });
  });
  body.querySelectorAll<HTMLElement>('[data-asm-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      removeInstance(button.dataset.asmRemove ?? '');
    });
  });
}

function commit(part: PackPart, clientX: number, clientY: number): { ok: boolean; message: string; id?: string } {
  const hit: SurfaceHit | null = draw.view.pickAssemblyHit(clientX, clientY);
  if (!hit) return { ok: false, message: '这个位置没有命中可落位的面' };
  const instance = createInstance({
    partId: part.id,
    model: part.model,
    category: part.category,
    vendor: part.vendor ?? '',
    dims: dimsOf(part),
    hit
  });
  draw.instances = [...draw.instances, instance];
  draw.view.setAssemblyInstances(draw.instances);
  draw.view.previewAssemblyInstance(null);
  renderList();
  return { ok: true, message: `${part.model} 已放置`, id: instance.id };
}

function removeInstance(id: string): boolean {
  const before = draw.instances.length;
  draw.instances = draw.instances.filter((item) => item.id !== id);
  draw.view.setAssemblyInstances(draw.instances);
  renderList();
  return draw.instances.length < before;
}

/** 视图上的拖放与点放 */
function bindStage(): void {
  const host = stageHost();
  if (!host || draw.host === host) return;
  draw.host = host;
  host.addEventListener('dragover', (event) => {
    if (!draw.armed) return;
    event.preventDefault();
    const hit = draw.view.pickAssemblyHit(event.clientX, event.clientY);
    if (!hit) return;
    draw.view.previewAssemblyInstance(createInstance({
      partId: draw.armed.id,
      model: draw.armed.model,
      category: draw.armed.category,
      vendor: draw.armed.vendor ?? '',
      dims: dimsOf(draw.armed),
      hit
    }));
  });
  host.addEventListener('dragleave', () => draw.view.previewAssemblyInstance(null));
  host.addEventListener('drop', (event) => {
    if (!draw.armed) return;
    event.preventDefault();
    const result = commit(draw.armed, event.clientX, event.clientY);
    notify(result.message, !result.ok);
    if (result.ok && !event.shiftKey) draw.armed = null;
    renderList();
  });
  // 点选放置：一次点击落一个（保持 armed 直至 Esc 或再次点选）
  host.addEventListener('click', (event) => {
    if (!draw.armed) return;
    const result = commit(draw.armed, event.clientX, event.clientY);
    notify(result.message, !result.ok);
    renderList();
  }, true);
}

export function initAssemblyUi(options: { view: OrbitView }): AssemblyUiHandle {
  draw.view = options.view;
  if (!draw.handle) {
    draw.handle = createDrawer('assemblyDrawer', '标准件装配', '拖进 3D 落位 · 自动贴合面 · 尺寸来自数据包');
    draw.handle.footer.innerHTML = '<span class="acp-pill">617 件标准件</span><span class="acp-pill">锁定：不使用 agent</span>';
  }
  void loadParts().then(() => { renderList(); bindStage(); });
  return {
    open() { draw.handle?.open(); bindStage(); void loadParts().then(() => renderList()); },
    close() { draw.handle?.close(); },
    state() {
      return {
        count: draw.instances.length,
        armed: draw.armed?.id ?? null,
        instances: draw.instances.map((i) => ({
          id: i.id, model: i.model, partId: i.partId,
          position: i.position, snappedTo: i.snappedTo, estimated: i.dims.estimated
        }))
      };
    },
    placeAt(partId, clientX, clientY) {
      const part = draw.parts.find((p) => p.id === partId);
      if (!part) return { ok: false, message: `没有这个标准件：${partId}` };
      return commit(part, clientX, clientY);
    },
    remove: removeInstance,
    clear() {
      draw.instances = [];
      draw.view.setAssemblyInstances([]);
      renderList();
    }
  };
}

export function assemblyStyles(): string {
  return `
.asm-toolbar{display:flex;gap:6px;margin:8px 0}
.asm-toolbar input{flex:1;min-width:0}
.asm-hint{font-size:11px;color:var(--text-3);margin:6px 0}
.asm-list{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;margin:6px 0}
.asm-part{display:grid;grid-template-columns:1fr auto;gap:2px 8px;text-align:left;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:transparent;cursor:grab}
.asm-part:hover{border-color:var(--accent)}
.asm-part.is-armed{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.asm-part-model{font-size:12px;color:var(--text-1)}
.asm-part-cat{font-size:10px;color:var(--text-3)}
.asm-part-size{grid-column:1/-1;font-size:10px;color:var(--text-2);font-family:var(--mono,monospace)}
.asm-instances{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
.asm-instances-head{display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-bottom:4px}
.asm-instance{display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;font-size:11px;padding:3px 0}
.asm-instance-pos{color:var(--text-3);font-family:var(--mono,monospace)}
.asm-instance-snap{color:var(--text-3);font-size:10px}
`;
}
