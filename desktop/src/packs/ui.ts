import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml,
  notify
} from '../ui/panels';

const PACK_ICON = '<svg viewBox="0 0 16 16"><path d="M2.3 5.2L8 2l5.7 3.2v5.6L8 14 2.3 10.8z"/><path d="M2.3 5.2L8 8.4l5.7-3.2M8 8.4V14"/></svg>';
const OVERLAY_KEY = 'automationcad.parts.overlay.v1';

interface StoredPart {
  part: DesktopComponentPart;
  insertedAt: string;
  source: 'data-pack';
}

interface OverlayStore {
  version: 1;
  parts: StoredPart[];
}

interface PackUi {
  status: HTMLElement;
  list: HTMLElement;
  results: HTMLElement;
  search: HTMLInputElement;
  importButton: HTMLButtonElement;
  overlayCount: HTMLElement;
}

let ui: PackUi | null = null;
let packs: DesktopPackInfo[] = [];
let searchTimer = 0;

function desktop() {
  return window.desktop;
}

function setStatus(message: string, kind: 'ok' | 'error' | 'warn' | 'idle' = 'idle'): void {
  if (!ui) return;
  ui.status.textContent = message;
  ui.status.classList.toggle('is-on', Boolean(message));
  ui.status.classList.toggle('is-error', kind === 'error');
  ui.status.classList.toggle('is-warn', kind === 'warn');
  if (kind !== 'idle') notify(message, kind === 'error');
}

function readOverlay(): OverlayStore {
  const raw = window.localStorage.getItem(OVERLAY_KEY);
  if (!raw) return { version: 1, parts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`标准件覆盖层数据损坏（${OVERLAY_KEY}）：${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { parts?: unknown }).parts)) {
    throw new Error(`标准件覆盖层数据格式不正确（${OVERLAY_KEY}）`);
  }
  const parts = (parsed as { parts: unknown[] }).parts.filter((item): item is StoredPart => {
    return Boolean(item && typeof item === 'object' && 'part' in item && 'insertedAt' in item);
  });
  return { version: 1, parts };
}

function saveOverlay(store: OverlayStore): void {
  window.localStorage.setItem(OVERLAY_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent('automationcad:parts-overlay-changed', {
    detail: { key: OVERLAY_KEY, count: store.parts.length }
  }));
  updateOverlayCount(store.parts.length);
}

function updateOverlayCount(count?: number): void {
  if (!ui) return;
  let value = count;
  if (value === undefined) {
    try {
      value = readOverlay().parts.length;
    } catch {
      value = 0;
    }
  }
  ui.overlayCount.textContent = `覆盖层 ${value} 项`;
}

function insertPart(part: DesktopComponentPart): void {
  let store: OverlayStore;
  try {
    store = readOverlay();
  } catch (error) {
    setStatus(errorMessage(error), 'error');
    return;
  }
  const next: StoredPart = {
    part,
    insertedAt: new Date().toISOString(),
    source: 'data-pack'
  };
  const index = store.parts.findIndex((item) => item.part.id === part.id && item.part.packId === part.packId);
  if (index >= 0) store.parts[index] = next;
  else store.parts.push(next);
  try {
    saveOverlay(store);
    setStatus(`已插入「${part.model}」到标准件库覆盖层（${OVERLAY_KEY}，共 ${store.parts.length} 项）。`, 'ok');
  } catch (error) {
    setStatus(`写入 localStorage 覆盖层失败：${errorMessage(error)}`, 'error');
  }
}

function packRows(): string {
  if (packs.length === 0) return '<div class="acp-empty">尚未发现数据包。点击「导入 ZIP」添加用户包。</div>';
  return packs.map((pack) => `<section class="acp-pack-row" data-pack-id="${escapeHtml(pack.id)}">
    <div class="acp-pack-main">
      <div style="min-width:0">
        <div class="acp-pack-name">${escapeHtml(pack.name)}</div>
        <div class="acp-pack-meta">${escapeHtml(pack.vendor || '未知厂商')} · v${escapeHtml(pack.version || '—')} · ${pack.builtin ? '内置包' : '用户包'} · ${escapeHtml(pack.id)}</div>
      </div>
      <div class="acp-pack-count">${pack.partCount} 项</div>
    </div>
    <div class="acp-pack-actions">
      <label class="acp-switch"><input type="checkbox" data-pack-enabled ${pack.enabled ? 'checked' : ''} ${pack.error ? 'disabled' : ''}> 启用</label>
      ${pack.builtin ? '<span class="acp-pill">只读</span>' : '<button type="button" class="acp-btn acp-btn-danger" data-pack-delete>删除</button>'}
      <span class="acp-row-end acp-pill ${pack.error ? 'is-error' : ''}">${pack.error ? '校验失败' : '可用'}</span>
    </div>
    ${pack.error ? `<div class="acp-pack-error">${escapeHtml(pack.error)}</div>` : ''}
  </section>`).join('');
}

async function loadPacks(): Promise<void> {
  const api = desktop();
  if (!api || !ui) {
    setStatus('数据包管理仅在桌面版可用。', 'error');
    return;
  }
  try {
    packs = await api.packs.list();
    ui.list.innerHTML = packRows();
    ui.list.querySelectorAll<HTMLElement>('[data-pack-id]').forEach((row) => {
      const id = row.dataset.packId;
      if (!id) return;
      const checkbox = row.querySelector<HTMLInputElement>('[data-pack-enabled]');
      checkbox?.addEventListener('change', () => void setEnabled(id, checkbox.checked, checkbox));
      row.querySelector('[data-pack-delete]')?.addEventListener('click', () => void removePack(id));
    });
    updateOverlayCount();
  } catch (error) {
    setStatus(`读取数据包失败：${errorMessage(error)}`, 'error');
  }
}

async function setEnabled(id: string, enabled: boolean, checkbox: HTMLInputElement): Promise<void> {
  const api = desktop();
  if (!api) return;
  try {
    await api.packs.setEnabled(id, enabled);
    const pack = packs.find((item) => item.id === id);
    if (pack) pack.enabled = enabled;
    setStatus(`数据包 ${id} 已${enabled ? '启用' : '禁用'}，标准件库即时更新。`, 'ok');
  } catch (error) {
    checkbox.checked = !enabled;
    setStatus(`切换数据包状态失败：${errorMessage(error)}`, 'error');
  }
}

async function removePack(id: string): Promise<void> {
  const api = desktop();
  if (!api) return;
  const pack = packs.find((item) => item.id === id);
  if (!window.confirm(`确定删除用户数据包「${pack?.name ?? id}」吗？\n\n该目录下所有条目与资源都会被删除。`)) return;
  try {
    await api.packs.remove(id);
    setStatus(`已删除用户数据包：${pack?.name ?? id}`, 'ok');
    await loadPacks();
  } catch (error) {
    setStatus(`删除数据包失败：${errorMessage(error)}`, 'error');
  }
}

async function importZip(): Promise<void> {
  const api = desktop();
  if (!api) {
    setStatus('数据包导入仅在桌面版可用。', 'error');
    return;
  }
  try {
    const picked = await api.packs.chooseZip();
    if (picked.canceled || !picked.filePaths[0]) return;
    setStatus('正在导入并校验数据包…', 'idle');
    const info = await api.packs.importZip(picked.filePaths[0]);
    setStatus(`数据包已导入：${info.name}（${info.id}）· ${info.partCount} 个条目`, 'ok');
    await loadPacks();
  } catch (error) {
    setStatus(`导入失败：${errorMessage(error)}`, 'error');
  }
}

function renderResults(parts: DesktopComponentPart[], query: string): void {
  if (!ui) return;
  if (parts.length === 0) {
    ui.results.innerHTML = `<div class="acp-empty">没有匹配「${escapeHtml(query)}」的元器件。</div>`;
    return;
  }
  ui.results.innerHTML = parts.map((part) => `<div class="acp-part-row" data-part-row>
    <div class="acp-part-main">
      <div class="acp-part-model">${escapeHtml(part.model)}</div>
      <div class="acp-part-meta">${escapeHtml(part.category)} · ${escapeHtml(part.vendor ?? '—')} · ${escapeHtml(part.packName ?? part.packId ?? '')}
        ${part.price !== undefined ? ` · ¥${part.price}` : ''}<br>${escapeHtml(Object.entries(part.specs).slice(0, 3).map(([key, value]) => `${key} ${value}`).join(' · ') || part.id)}</div>
    </div>
    <button type="button" class="acp-btn acp-btn-primary" data-insert-part>插入</button>
  </div>`).join('');
  const rows = ui.results.querySelectorAll<HTMLElement>('[data-part-row]');
  rows.forEach((row, index) => {
    row.querySelector('[data-insert-part]')?.addEventListener('click', () => {
      const part = parts[index];
      if (part) insertPart(part);
    });
  });
}

async function searchParts(): Promise<void> {
  const api = desktop();
  if (!api || !ui) return;
  const query = ui.search.value.trim();
  try {
    const parts = query
      ? await api.packs.listParts({ q: query })
      : await api.packs.listParts();
    renderResults(parts, query || '全部');
    setStatus(`搜索到 ${parts.length} 个元器件。插入动作写入 localStorage 覆盖层。`, 'idle');
  } catch (error) {
    setStatus(`搜索元器件失败：${errorMessage(error)}`, 'error');
  }
}

export function initPackPanel(): void {
  ensurePanelStyles();
  const entry = buildEntryButton('packEntryButton', '数据包', PACK_ICON, () => {
    drawer.open();
    void loadPacks();
    void searchParts();
  });
  if (!entry) return;
  const drawer = createDrawer('packDrawer', '数据包', '内置/用户包 · ZIP 导入 · 标准件库覆盖层');
  drawer.body.innerHTML = `
    <div class="acp-status" id="packStatusBar"></div>
    <div class="acp-row">
      <input class="acp-input" id="packSearch" type="search" placeholder="搜索型号 / 厂商 / 类别…" style="flex:1;min-width:0">
      <button type="button" class="acp-btn acp-btn-primary" id="packImport">导入 ZIP</button>
    </div>
    <div class="acp-section-title"><span>已安装数据包</span><b id="packOverlayCount">覆盖层 0 项</b></div>
    <div id="packList"><div class="acp-empty">正在读取数据包…</div></div>
    <div class="acp-section-title"><span>元器件搜索与插入</span><b>localStorage</b></div>
    <div id="packResults"><div class="acp-empty">输入关键词搜索已启用数据包中的元器件。</div></div>
    <div class="acp-note">插入会把条目写入 <code>${OVERLAY_KEY}</code> 覆盖层，并派发 <code>automationcad:parts-overlay-changed</code> 事件；不改动 app.js。导入失败会显示缺字段、ID 冲突或路径穿越的具体原因。</div>`;
  drawer.footer.innerHTML = '<span class="acp-pill">manifest 校验</span><span class="acp-pill">ZIP 路径穿越防护</span><span class="acp-pill">启用即时生效</span>';

  const status = drawer.body.querySelector<HTMLElement>('#packStatusBar');
  const list = drawer.body.querySelector<HTMLElement>('#packList');
  const results = drawer.body.querySelector<HTMLElement>('#packResults');
  const search = drawer.body.querySelector<HTMLInputElement>('#packSearch');
  const importButton = drawer.body.querySelector<HTMLButtonElement>('#packImport');
  const overlayCount = drawer.body.querySelector<HTMLElement>('#packOverlayCount');
  if (!status || !list || !results || !search || !importButton || !overlayCount) {
    throw new Error('数据包面板节点缺失');
  }
  ui = { status, list, results, search, importButton, overlayCount };
  importButton.addEventListener('click', () => void importZip());
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void searchParts(), 180);
  });
  updateOverlayCount();
}
