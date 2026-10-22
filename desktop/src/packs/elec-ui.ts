import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml,
  notify,
  type DrawerHandle
} from '../ui/panels';

const ELEC_ICON = '<svg viewBox="0 0 16 16"><path d="M10.8 1.8L4.4 8.6h3.2l-1.4 5.6 6.4-7.5H9.3z"/></svg>';
const CACHE_TTL_MS = 30_000;
const ALL_CATEGORY = '全部';
const ELECTRICAL_PACK_PATTERN = /(^|[-_])(iec|elec|electric|电气)([-_]|$)/i;
function isElectricalPack(parts: DesktopComponentPart[]): boolean {
  if (parts.length === 0) return false;
  const id = parts[0]?.packId ?? '';
  if (ELECTRICAL_PACK_PATTERN.test(id)) return true;
  const withSymbol = parts.filter((part) => typeof part.symbol === 'string' && part.symbol !== '').length;
  return withSymbol * 2 >= parts.length;
}

interface PartsCache {
  at: number;
  parts: DesktopComponentPart[];
}

interface ElecLibraryUi {
  status: HTMLElement;
  categories: HTMLElement;
  search: HTMLInputElement;
  results: HTMLElement;
  count: HTMLElement;
}

let ui: ElecLibraryUi | null = null;
let drawer: DrawerHandle | null = null;
let cache: PartsCache | null = null;
let loading: Promise<DesktopComponentPart[]> | null = null;
let activeCategory = ALL_CATEGORY;
let query = '';
let searchTimer = 0;
let shownParts: DesktopComponentPart[] = [];
const expanded = new Set<string>();

function desktop() {
  return window.desktop;
}

function hasSymbol(part: DesktopComponentPart): boolean {
  return typeof part.symbol === 'string' && part.symbol.trim() !== '';
}

function partKey(part: DesktopComponentPart): string {
  return `${part.packId ?? ''}|${part.id}`;
}

function electricalParts(parts: DesktopComponentPart[]): DesktopComponentPart[] {
  const byPack = new Map<string, DesktopComponentPart[]>();
  for (const part of parts) {
    const id = part.packId ?? '';
    const list = byPack.get(id) ?? [];
    list.push(part);
    byPack.set(id, list);
  }
  const electricalPacks = new Set(
    [...byPack.entries()]
      .filter(([, list]) => isElectricalPack(list))
      .map(([id]) => id)
  );
  return parts.filter((part) => electricalPacks.has(part.packId ?? ''));
}

function matchesQuery(part: DesktopComponentPart, text: string): boolean {
  if (!text) return true;
  const needle = text.toLocaleLowerCase('zh-CN');
  const haystack = [
    part.id,
    part.model,
    part.category,
    part.vendor ?? '',
    part.packId ?? '',
    part.packName ?? '',
    ...Object.values(part.specs ?? {}).map(String)
  ].join(' ').toLocaleLowerCase('zh-CN');
  return haystack.includes(needle);
}

function setStatus(message: string, kind: 'ok' | 'error' | 'idle' = 'idle'): void {
  if (!ui) return;
  ui.status.textContent = message;
  ui.status.classList.toggle('is-on', Boolean(message));
  ui.status.classList.toggle('is-error', kind === 'error');
}

async function ensureParts(): Promise<DesktopComponentPart[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.parts;
  if (loading) return await loading;
  const api = desktop();
  if (!api) throw new Error('电气元件库仅在桌面版可用');
  const request = api.packs.listParts().then((parts) => {
    const filtered = electricalParts(parts);
    cache = { at: Date.now(), parts: filtered };
    return filtered;
  });
  loading = request;
  try {
    return await request;
  } finally {
    if (loading === request) loading = null;
  }
}

function visibleCategories(): Array<{ name: string; count: number }> {
  const parts = filteredParts();
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.category, (counts.get(part.category) ?? 0) + 1);
  return [
    { name: ALL_CATEGORY, count: parts.length },
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
      .map(([name, count]) => ({ name, count }))
  ];
}

function filteredParts(): DesktopComponentPart[] {
  const parts = cache?.parts ?? [];
  return parts.filter((part) => {
    if (activeCategory !== ALL_CATEGORY && part.category !== activeCategory) return false;
    return matchesQuery(part, query);
  });
}

function specSummary(part: DesktopComponentPart): string {
  const entries = Object.entries(part.specs ?? {}).slice(0, 3);
  return entries.length ? entries.map(([key, value]) => `${key} ${value}`).join(' · ') : '暂无关键参数';
}

function rowHtml(part: DesktopComponentPart, index: number): string {
  const key = partKey(part);
  const symbol = hasSymbol(part) ? part.symbol!.trim() : '';
  const isOpen = expanded.has(key);
  const specs = Object.entries(part.specs ?? {});
  const detail = specs.length
    ? specs.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')
    : '<dt>参数</dt><dd>该元件暂无参数</dd>';
  return `<article class="elec-part-row" data-elec-part="${escapeHtml(key)}" data-elec-symbol="${escapeHtml(symbol)}">
    <button type="button" class="elec-part-head" data-elec-toggle aria-expanded="${isOpen}">
      <span class="acp-part-main">
        <span class="acp-part-model">${escapeHtml(part.model)}</span>
        <span class="acp-part-meta">${escapeHtml(part.vendor || '未知厂商')} · ${escapeHtml(part.category)}<br>${escapeHtml(specSummary(part))}</span>
      </span>
      <span class="acp-pill ${symbol ? 'is-ok' : 'is-warn'}">${symbol ? `有符号 · ${escapeHtml(symbol)}` : '无符号'}</span>
    </button>
    <div class="elec-part-actions">
      <button type="button" class="acp-btn acp-btn-primary" data-elec-insert="${index}" ${symbol ? '' : 'disabled'}>放入图纸</button>
      ${symbol ? '' : '<span class="elec-part-hint">该元件暂无原理图符号，可在元件属性中查看参数</span>'}
    </div>
    <div class="elec-part-detail" ${isOpen ? '' : 'hidden'}><dl class="elec-spec-list">${detail}</dl></div>
  </article>`;
}

function renderCategories(): void {
  if (!ui) return;
  const categories = visibleCategories();
  if (activeCategory !== ALL_CATEGORY && !categories.some((item) => item.name === activeCategory)) {
    activeCategory = ALL_CATEGORY;
  }
  ui.categories.innerHTML = categories.map((item) => `<button type="button" class="elec-cat ${activeCategory === item.name ? 'is-active' : ''}" data-elec-category="${escapeHtml(item.name)}">${escapeHtml(item.name)}<span>${item.count}</span></button>`).join('');
  ui.categories.querySelectorAll<HTMLElement>('[data-elec-category]').forEach((button) => {
    button.addEventListener('click', () => {
      activeCategory = button.dataset.elecCategory ?? ALL_CATEGORY;
      renderCategories();
      renderRows();
    });
  });
}

function renderRows(): void {
  if (!ui) return;
  const all = cache?.parts ?? [];
  const parts = filteredParts();
  shownParts = parts;
  const symbols = all.filter(hasSymbol).length;
  ui.results.dataset.parts = String(all.length);
  ui.results.dataset.categories = String(Math.max(0, visibleCategories().length - 1));
  ui.results.dataset.symbols = String(symbols);
  ui.results.dataset.ready = '1';
  ui.count.textContent = `${parts.length} / ${all.length} 项 · 有符号 ${symbols}`;
  if (parts.length === 0) {
    const message = query
      ? `没有匹配「${query}」的电气元件。`
      : all.length === 0
        ? '未在已启用的数据包中发现电气元件。请检查「数据包」面板或导入电气元件包。'
        : `分类「${activeCategory}」下没有条目。`;
    ui.results.innerHTML = `<div class="acp-empty">${escapeHtml(message)}</div>`;
    return;
  }
  ui.results.innerHTML = parts.map((part, index) => rowHtml(part, index)).join('');
  ui.results.querySelectorAll<HTMLElement>('[data-elec-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest<HTMLElement>('[data-elec-part]');
      const key = row?.dataset.elecPart;
      const detail = row?.querySelector<HTMLElement>('.elec-part-detail');
      if (!key || !detail) return;
      const open = !detail.hidden;
      detail.hidden = open;
      button.setAttribute('aria-expanded', String(!open));
      if (open) expanded.delete(key);
      else expanded.add(key);
    });
  });
  ui.results.querySelectorAll<HTMLButtonElement>('[data-elec-insert]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.elecInsert);
      const part = Number.isInteger(index) ? shownParts[index] : undefined;
      if (part) insertPart(part);
    });
  });
}

function renderError(message: string): void {
  if (!ui) return;
  ui.results.dataset.ready = 'error';
  ui.results.dataset.parts = '0';
  ui.results.dataset.categories = '0';
  ui.results.dataset.symbols = '0';
  ui.results.innerHTML = `<div class="acp-empty">电气元件包加载失败：${escapeHtml(message)}</div>`;
}

function insertPart(part: DesktopComponentPart): void {
  const symbol = hasSymbol(part) ? part.symbol!.trim() : '';
  if (!symbol) {
    notify('该元件暂无原理图符号，可在元件属性中查看参数', true);
    return;
  }
  const domain = window.ElecDomain;
  if (!domain?.insertSymbol) {
    notify('原理图放置接口尚未就绪，请稍后重试', true);
    return;
  }
  const result = domain.insertSymbol(symbol);
  if (!result.ok) {
    notify(`放入图纸失败：${result.message ?? '未知原因'}`, true);
    return;
  }
  notify(`已放入图纸：${result.tag ?? part.model}`, false);
}

async function refresh(force = false): Promise<void> {
  if (!ui) return;
  if (force) cache = null;
  setStatus('正在按需加载电气元件包…', 'idle');
  try {
    await ensureParts();
    setStatus('', 'idle');
    renderCategories();
    renderRows();
  } catch (error) {
    const message = errorMessage(error);
    setStatus(`电气元件包加载失败：${message}`, 'error');
    renderError(message);
  }
}

function openPanel(): void {
  drawer?.open();
  if (!cache && ui) ui.results.innerHTML = '<div class="acp-empty">正在加载电气元件包…</div>';
  void refresh();
}

export function initElecLibraryPanel(): void {
  ensurePanelStyles();
  const entry = buildEntryButton('elecLibEntryButton', '电气元件', ELEC_ICON, openPanel);
  if (!entry) return;
  drawer = createDrawer('elecLibDrawer', '电气元件', '按需加载 · 分类检索 · 一键放入原理图');
  drawer.body.innerHTML = `
    <div class="acp-status" id="elecLibStatus"></div>
    <div class="acp-row">
      <input class="acp-input" id="elecLibSearch" type="search" placeholder="搜索型号 / 厂商 / 参数…" style="flex:1;min-width:0">
      <span class="acp-pill" id="elecLibCount">0 项</span>
    </div>
    <div class="elec-cats" id="elecLibCategories"></div>
    <div id="elecLibResults"><div class="acp-empty">首次打开时才会按需读取电气元件包。</div></div>
    <div class="acp-note">列表来自已启用的数据包，首次打开时读取一次并在本地缓存 30 秒；切换分类和搜索不会重复调用 IPC。无符号元件仅供参数查看。</div>`;
  drawer.footer.innerHTML = '<span class="acp-pill">按需加载</span><span class="acp-pill">缓存 30s</span><span class="acp-pill">12 个电气分类</span>';

  const status = drawer.body.querySelector<HTMLElement>('#elecLibStatus');
  const categories = drawer.body.querySelector<HTMLElement>('#elecLibCategories');
  const search = drawer.body.querySelector<HTMLInputElement>('#elecLibSearch');
  const results = drawer.body.querySelector<HTMLElement>('#elecLibResults');
  const count = drawer.body.querySelector<HTMLElement>('#elecLibCount');
  if (!status || !categories || !search || !results || !count) throw new Error('电气元件面板节点缺失');
  ui = { status, categories, search, results, count };

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value.trim();
      renderRows();
    }, 120);
  });
}
