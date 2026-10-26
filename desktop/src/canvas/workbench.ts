// 无限画布工作台（P2）· DOM 层
//
// 只做三件事：把纯视图模型画到屏幕上、把用户操作翻译成 graph/metrics/export 的纯函数调用、
// 暴露 data-action 供冒烟测试点击（不靠 class 断言）。
//
// 硬规则（照规格书）：
//   - 整机 CT/UPH 显示的是 evaluateFlow 的结果，甘特只是「单步时间」；
//   - 金额全部走注入的 priceLookup，P2 阶段没有价格源 → 全部「待询价」，总额标「不完全统计」；
//   - 端口不匹配的边才出现「⚡ 生成转接板」，插完必须两端匹配；匹配的边不出现按钮；
//   - 3D / B-Rep 未接入：界面里任何地方都不写「已校核 / 0 碰撞」。
import workbenchStyles from './canvas.css?inline';
import { buildEntryButton } from '../ui/panels.ts';
import {
  findMismatchedEdges,
  insertAdapterForEdge,
  insertAdaptersForAllMismatches,
  isAdapterNode,
  portDiff,
  removeNode
} from './graph.ts';
import { axisSizing, screwSizing, type AxisSizingResult, type ScrewSizingResult } from './metrics.ts';
import { build123dScript, buildMachineGraphJson, plcSt } from './export.ts';
import {
  buildArtboards,
  buildBomLines,
  buildGanttView,
  buildOrthoView,
  buildSummary,
  buildTopologyView,
  createDefaultAdapterFactory,
  formatPort,
  type WorkbenchSummary
} from './view-model.ts';
import { CANVAS_PALETTE, demoCanvasGraph, paletteNode, type PaletteItem } from './demo-graph.ts';
import { buildPaletteSections, summarizePackCoverage, type PaletteSection } from './packs-source.ts';
import {
  CANVAS_DRAFT_KEY,
  clearDraft,
  loadDraft,
  saveDraft,
  type CanvasViewMode,
  type DraftStorage
} from './persistence.ts';
import { validatePricebook } from '../cost/pricebook.ts';
import { createPricebookLookup, describePriceSource, summarizePricebook, type PriceSourceSummary } from './price-source.ts';
import type { PriceLookup } from './metrics.ts';
import type { CanvasNode, MachineGraph } from './types.ts';

type ViewMode = CanvasViewMode;
type InspectorTab = 'prop' | 'mech' | 'bom';
type ExportTab = 'json' | 'build123d' | 'plc';

interface WorkbenchState {
  graph: MachineGraph;
  selectedId: string | null;
  mode: ViewMode;
  inspector: InspectorTab;
  exportTab: ExportTab;
  open: boolean;
}

const DEFAULT_MARGIN_PX = 40;
let stylesInjected = false;
let mounted = false;
let toastTimer = 0;
let state: WorkbenchState = {
  graph: demoCanvasGraph(),
  selectedId: 'AXIS-Y',
  mode: 'topology',
  inspector: 'prop',
  exportTab: 'json',
  open: false
};

// 价格源：P3 起从内置价格簿读取；读不到时保持「全部待询价」，不编价。
let priceLookup: PriceLookup = () => null;
let priceSource: PriceSourceSummary | null = null;
let priceSourceError = '';
let priceSourceLoaded = false;
const adapterFactory = createDefaultAdapterFactory({ dowelDiaMm: 4 });

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function ensureStyles(): void {
  if (stylesInjected || document.getElementById('cw-styles')) {
    stylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'cw-styles';
  style.textContent = workbenchStyles;
  document.head.appendChild(style);
  stylesInjected = true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function toast(message: string, error = false): void {
  let element = document.getElementById('cwToast');
  if (!element) {
    element = document.createElement('div');
    element.id = 'cwToast';
    element.className = 'cw-toast';
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.classList.toggle('is-error', error);
  element.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element?.classList.remove('is-on'), 3200);
}

// ---- 本地草稿（P2.5）：localStorage 不可用时只提示，不影响使用 ----

let draftStorageCache: DraftStorage | null | undefined;
let draftLoaded = false;
let draftSaveTimer = 0;

function getDraftStorage(): DraftStorage | null {
  if (draftStorageCache !== undefined) return draftStorageCache;
  try {
    const storage = window.localStorage;
    // 真正探一次：部分环境 getItem 会抛（隐私模式 / 禁用存储）
    storage.getItem(CANVAS_DRAFT_KEY);
    draftStorageCache = storage;
  } catch {
    draftStorageCache = null;
  }
  return draftStorageCache;
}

function setDraftState(text: string, error = false): void {
  const element = document.getElementById('cwDraftState');
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('cw-warn', error);
}

function persistNow(): void {
  const storage = getDraftStorage();
  if (!storage) {
    setDraftState('无本地存储，改动不会保存', true);
    return;
  }
  const savedAt = new Date().toISOString();
  const result = saveDraft(storage, { graph: state.graph, selectedId: state.selectedId, mode: state.mode }, savedAt);
  setDraftState(result.ok ? `已保存 ${savedAt.slice(11, 19)}` : result.reason ?? '保存失败', !result.ok);
}

/** 改动后 400ms 落草稿；连续拖拽只在停手后写一次。 */
function markDirty(): void {
  setDraftState('未保存…');
  draftSaveTimer = window.setTimeout(persistNow, 400);
}

function renderPriceSource(): void {
  const element = document.getElementById('cwPriceSource');
  if (!element) return;
  element.textContent = priceSourceError ? `价格源：不可用（${priceSourceError}）` : describePriceSource(priceSource);
  element.classList.toggle('cw-warn', Boolean(priceSourceError));
  element.title = priceSource?.source ?? priceSourceError;
}

/**
 * 读内置价格簿（主进程 cost:pricebook）。
 * 模块未启用 / 浏览器模式 / 书损坏都只影响「有没有价」，不影响画布可用性。
 */
async function loadPriceSource(): Promise<void> {
  if (priceSourceLoaded) return;
  priceSourceLoaded = true;
  const api = window.desktop?.cost;
  if (!api) {
    priceSourceError = '浏览器模式没有价格簿接口';
    renderPriceSource();
    return;
  }
  try {
    const result = await api.pricebook();
    if (!result.ok) {
      priceSourceError = result.message ?? result.code ?? '价格簿不可用';
      renderPriceSource();
      return;
    }
    const book = validatePricebook(result.book as unknown);
    priceLookup = createPricebookLookup(book);
    priceSource = summarizePricebook(book);
    priceSourceError = '';
    renderPriceSource();
    renderAll();
  } catch (error) {
    priceSourceError = error instanceof Error ? error.message : String(error);
    renderPriceSource();
    console.warn('[canvas] 价格簿读取失败，保持待询价', error);
  }
}

function restoreDraft(): void {
  if (draftLoaded) return;
  draftLoaded = true;
  const loaded = loadDraft(getDraftStorage());
  if (loaded.draft) {
    state.graph = loaded.draft.graph;
    state.selectedId = loaded.draft.selectedId;
    state.mode = loaded.draft.mode;
    const savedAt = loaded.draft.savedAt.slice(11, 19);
    setDraftState(savedAt ? `已恢复草稿 ${savedAt}` : '已恢复草稿');
    if (loaded.issues.length > 0) {
      toast(`草稿已清理 ${loaded.issues.length} 处结构问题（重复 id / 孤儿边等）`);
    }
    return;
  }
  if (loaded.reason && loaded.reason !== '没有本地草稿') setDraftState(loaded.reason, true);
}

function root(): HTMLElement {
  const element = document.getElementById('canvasWorkbench');
  if (!element) throw new Error('画布工作台尚未挂载');
  return element;
}

function selectedNode(): CanvasNode | null {
  if (!state.selectedId) return null;
  return state.graph.nodes.find((node) => node.id === state.selectedId) ?? null;
}

function summary(): WorkbenchSummary {
  return buildSummary(state.graph, { priceLookup });
}

// ---------------------------------------------------------------------------
// 骨架
// ---------------------------------------------------------------------------

function buildShell(): void {
  if (document.getElementById('canvasWorkbench')) return;
  const section = document.createElement('section');
  section.id = 'canvasWorkbench';
  section.className = 'cw';
  section.hidden = true;
  section.setAttribute('aria-label', '无限画布工作台');
  section.innerHTML = `
    <header class="cw-head">
      <div class="cw-title">
        <b>无限画布工作台</b>
        <span>节点-端口拓扑 · 2D 正交 · 多口径画板（P2 前端，无 3D / B-Rep）</span>
      </div>
      <div class="cw-modes" role="tablist" aria-label="画布视图">
        <button type="button" class="cw-btn is-active" data-action="mode" data-mode="topology" role="tab">拓扑</button>
        <button type="button" class="cw-btn" data-action="mode" data-mode="ortho" role="tab">2D 正交</button>
        <button type="button" class="cw-btn" data-action="mode" data-mode="artboard" role="tab">多画板</button>
      </div>
      <div class="cw-kpi">
        <span><em>成本</em><b id="cwKpiCost">—</b></span>
        <span><em>CT</em><b id="cwKpiCt">—</b></span>
        <span><em>UPH</em><b id="cwKpiUph">—</b></span>
        <span><em>不匹配</em><b id="cwKpiMismatch">—</b></span>
      </div>
      <div class="cw-actions">
        <button type="button" class="cw-btn primary" data-action="auto-adapters">⚡ 全部生成转接板</button>
        <button type="button" class="cw-btn" data-action="export">导出</button>
        <span class="cw-draft-state" id="cwPriceSource" title="">价格源：未接入</span>
        <span class="cw-draft-state" id="cwDraftState" role="status" aria-live="polite">—</span>
        <button type="button" class="cw-btn" data-action="reset-demo">重置演示</button>
        <button type="button" class="cw-btn" data-action="close">关闭 Esc</button>
      </div>
    </header>
    <div class="cw-body">
      <aside class="cw-palette">
        <h3>模组库</h3>
        <input type="search" id="cwPaletteSearch" class="cw-palette-search" placeholder="搜索型号 / 品类" aria-label="搜索模组" />
        <div id="cwPalette"></div>
        <p class="cw-palette-note">
          通用模组模板，不是具体型号：<code>partId</code> 留空，价格必然「待询价」。
          点击 = 挂在当前选中节点下游；未选中时落在画布空白处。
        </p>
      </aside>
      <main class="cw-stage">
        <div class="cw-view" data-mode="topology" id="cwTopology">
          <div class="cw-canvas" id="cwCanvas">
            <svg class="cw-edges" id="cwEdges" aria-hidden="true"></svg>
            <div id="cwNodes"></div>
          </div>
        </div>
        <div class="cw-view" data-mode="ortho" id="cwOrtho" hidden></div>
        <div class="cw-view" data-mode="artboard" id="cwArtboards" hidden></div>
        <div class="cw-gantt" id="cwGantt"></div>
      </main>
      <aside class="cw-inspector">
        <div class="cw-tabs" role="tablist" aria-label="检查器">
          <button type="button" class="cw-tab is-active" data-action="inspector" data-tab="prop" role="tab">属性 / 转接板</button>
          <button type="button" class="cw-tab" data-action="inspector" data-tab="mech" role="tab">力学选型</button>
          <button type="button" class="cw-tab" data-action="inspector" data-tab="bom" role="tab">BOM / IO</button>
        </div>
        <div class="cw-inspector-body" id="cwInspector"></div>
      </aside>
    </div>
    <div class="cw-modal" id="cwExportModal" hidden>
      <div class="cw-modal-box" role="dialog" aria-modal="true" aria-label="导出预览">
        <div class="cw-modal-head">
          <b>导出预览</b>
          <span class="cw-hint">只生成文本，不执行、不落盘</span>
          <button type="button" class="cw-btn" data-action="close-export">关闭</button>
        </div>
        <div class="cw-export-tabs">
          <button type="button" class="cw-btn is-active" data-action="export-tab" data-tab="json">Machine Graph JSON</button>
          <button type="button" class="cw-btn" data-action="export-tab" data-tab="build123d">build123d 脚本</button>
          <button type="button" class="cw-btn" data-action="export-tab" data-tab="plc">PLC ST</button>
        </div>
        <pre class="cw-pre" id="cwExportCode"></pre>
        <div class="cw-modal-foot">
          <button type="button" class="cw-btn primary" data-action="copy-export">复制到剪贴板</button>
          <span id="cwCopyState"></span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(section);
}

// ---- 模组库（P3：优先读 packs 真实元件，读不到回落到通用模板） ----

let paletteSections: PaletteSection[] = [];
let paletteIndex = new Map<string, PaletteItem>();
let paletteSourceNote = '通用模板（packs 未接入）：型号/质量/端口均为品类默认值';

function paletteItemMarkup(item: PaletteItem): string {
  const bound = item.partId ? '' : ' · 待选型';
  return `
    <button type="button" class="cw-palette-item" data-action="add-module" data-item="${escapeHtml(item.id)}"
            title="${escapeHtml(`${item.spec}${item.partId ? ` · partId=${item.partId}` : ''}`)}">
      ${escapeHtml(item.label)}
      <small>${escapeHtml(item.spec)}${bound}</small>
    </button>`;
}

function renderPalette(filter = ''): void {
  const host = document.getElementById('cwPalette');
  if (!host) return;
  const keyword = filter.trim().toLowerCase();
  const match = (item: PaletteItem): boolean =>
    keyword === '' ||
    item.label.toLowerCase().includes(keyword) ||
    item.spec.toLowerCase().includes(keyword) ||
    (item.partId ?? '').toLowerCase().includes(keyword);

  if (paletteSections.length === 0) {
    const items = CANVAS_PALETTE.filter(match);
    host.innerHTML = `
      <div class="cw-palette-group">
        <div class="cw-palette-group-head">通用模组 <em>${items.length}</em></div>
        ${items.map(paletteItemMarkup).join('') || '<p class="cw-hint">没有匹配的模组</p>'}
      </div>
      <p class="cw-palette-note">${escapeHtml(paletteSourceNote)}</p>`;
    return;
  }

  host.innerHTML = [
    ...paletteSections.map((section) => {
      const items = section.items.filter(match);
      if (items.length === 0) return '';
      return `
        <div class="cw-palette-group">
          <div class="cw-palette-group-head">${escapeHtml(section.label)} <em>${section.total}</em></div>
          ${items.map(paletteItemMarkup).join('')}
        </div>`;
    }),
    `<p class="cw-palette-note">${escapeHtml(paletteSourceNote)}</p>`
  ]
    .filter(Boolean)
    .join('');
}

function rebuildPaletteIndex(): void {
  paletteIndex = new Map<string, PaletteItem>();
  for (const item of CANVAS_PALETTE) paletteIndex.set(item.id, item);
  for (const section of paletteSections) {
    for (const item of section.items) paletteIndex.set(item.id, item);
  }
}

/** 读 packs（主进程 packs.listParts）。失败只影响模组库来源，不影响画布。 */
async function loadPacksPalette(): Promise<void> {
  const api = window.desktop?.packs;
  if (!api || typeof api.listParts !== 'function') {
    rebuildPaletteIndex();
    renderPalette();
    return;
  }
  try {
    const parts = await api.listParts({});
    const coverage = summarizePackCoverage(parts);
    paletteSections = buildPaletteSections(parts);
    paletteSourceNote =
      coverage.mountable > 0
        ? `来自 packs：${coverage.total} 件元件中 ${coverage.mountable} 件可上画布（${paletteSections.length} 类）；质量取品类默认值，端口为品类通用接口，价格按 partId 查价格簿`
        : `packs 里没有可上画布的机械件（共 ${coverage.total} 件），回落到通用模板`;
    rebuildPaletteIndex();
    renderPalette((document.getElementById('cwPaletteSearch') as HTMLInputElement | null)?.value ?? '');
  } catch (error) {
    paletteSourceNote = `packs 读取失败：${error instanceof Error ? error.message : String(error)}；使用通用模板`;
    rebuildPaletteIndex();
    renderPalette();
  }
}

// ---------------------------------------------------------------------------
// 渲染：拓扑
// ---------------------------------------------------------------------------

function renderTopology(): void {
  const canvas = document.getElementById('cwCanvas');
  const svg = document.getElementById('cwEdges');
  const host = document.getElementById('cwNodes');
  if (!canvas || !svg || !host) return;
  const view = buildTopologyView(state.graph);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  canvas.dataset.mismatch = String(view.mismatchCount);
  canvas.dataset.nodes = String(view.nodes.length);
  canvas.dataset.edges = String(view.edges.length);

  svg.setAttribute('width', String(view.width));
  svg.setAttribute('height', String(view.height));
  svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
  svg.innerHTML = view.edges
    .map(
      (edge) =>
        `<path class="cw-edge${edge.mismatched ? ' is-mismatch' : ''}" data-edge="${escapeHtml(edge.id)}" d="${edge.d}" />`
    )
    .join('');

  host.innerHTML = view.nodes
    .map((node) => {
      const classes = [
        'cw-node',
        node.adapter ? 'is-adapter' : '',
        node.mismatch ? 'is-mismatch' : '',
        node.id === state.selectedId ? 'is-selected' : ''
      ]
        .filter(Boolean)
        .join(' ');
      return `
        <div class="${classes}" data-node-id="${escapeHtml(node.id)}" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px" tabindex="0" role="button" aria-label="${escapeHtml(node.name)}">
          <div class="cw-node-head">
            <span>${escapeHtml(node.name)}</span>
            <i class="cw-node-kind">${escapeHtml(node.kind)}</i>
          </div>
          <div class="cw-node-port">↓ ${escapeHtml(node.portInLabel)}</div>
          <div class="cw-node-port">↑ ${escapeHtml(node.portOutLabel)}</div>
          <div class="cw-node-meta">
            <span>${node.massKg}kg</span>
            <span>${node.stepSec ? `${node.stepSec}s` : '无节拍'}</span>
            <span>${node.strokeMm ? `${node.strokeMm}mm` : '—'}</span>
            <span>${node.partId ? escapeHtml(node.partId) : '待选型'}</span>
          </div>
        </div>`;
    })
    .join('');

  // ⚡ 按钮单独作为 HTML 元素（foreignObject 里放 button 在部分环境点不到）
  for (const edge of view.edges) {
    if (!edge.mismatched) continue;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'cw-badge';
    badge.dataset.action = 'insert-adapter';
    badge.dataset.edgeId = edge.id;
    badge.style.left = `${edge.badgeX}px`;
    badge.style.top = `${edge.badgeY}px`;
    badge.textContent = `⚡ 生成转接板（${edge.diffFields.length} 项不匹配）`;
    badge.title = `不匹配字段：${edge.diffFields.join('、')}`;
    host.appendChild(badge);
  }
}

// ---------------------------------------------------------------------------
// 渲染：2D 正交
// ---------------------------------------------------------------------------

function renderOrtho(): void {
  const host = document.getElementById('cwOrtho');
  if (!host) return;
  const view = buildOrthoView(state.graph);
  const gridStep = 100;
  const lines: string[] = [];
  for (let x = 0; x <= view.width; x += gridStep * view.scale) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${view.height}" stroke="#23282c" stroke-width="1" />`);
  }
  for (let y = 0; y <= view.height; y += gridStep * view.scale) {
    lines.push(`<line x1="0" y1="${y}" x2="${view.width}" y2="${y}" stroke="#23282c" stroke-width="1" />`);
  }
  const stations = view.stations
    .map((station) => {
      const selected = station.id === state.selectedId;
      return `
        <g class="cw-station" data-node-id="${escapeHtml(station.id)}">
          <rect class="envelope" x="${station.x - 4}" y="${station.y - 4}"
                width="${Math.max(station.width, station.envelopeWidthMm * view.scale) + 8}"
                height="${Math.max(station.height, station.envelopeHeightMm * view.scale) + 8}" />
          <rect class="body${station.adapter ? ' is-adapter' : ''}" x="${station.x}" y="${station.y}"
                width="${station.width}" height="${station.height}"
                stroke-width="${selected ? 2 : 1}" stroke="${selected ? '#35c7b3' : undefined}" />
          <text x="${station.x + 3}" y="${station.y - 7}">${escapeHtml(station.name)}</text>
          <text class="dim" x="${station.x + 3}" y="${station.y + station.height + 12}">
            ${station.mmX},${station.mmY} · ${station.mmWidth}×${station.mmHeight}mm
          </text>
        </g>`;
    })
    .join('');
  host.innerHTML = `
    <svg class="cw-ortho-svg" width="${view.width}" height="${view.height}" viewBox="0 0 ${view.width} ${view.height}" aria-label="2D 正交布局">
      ${lines.join('')}
      ${stations}
    </svg>
    <div class="cw-ortho-note">
      1px ≈ ${(1 / view.scale).toFixed(2)}mm · 包围盒 ${Math.round(view.boundsMm.maxX - view.boundsMm.minX)}×${Math.round(view.boundsMm.maxY - view.boundsMm.minY)}mm<br />
      ${view.notes.map((note) => `<b>${escapeHtml(note)}</b>`).join('<br />')}
    </div>`;
  host.dataset.stations = String(view.stations.length);
}

// ---------------------------------------------------------------------------
// 渲染：多画板
// ---------------------------------------------------------------------------

function renderArtboards(): void {
  const host = document.getElementById('cwArtboards');
  if (!host) return;
  const boards = buildArtboards(state.graph, { priceLookup });
  host.innerHTML = `
    <div class="cw-artboards">
      ${boards
        .map(
          (board) => `
        <article class="cw-artboard" data-layout="${board.layout}">
          <h4>${escapeHtml(board.label)}</h4>
          <p>${escapeHtml(board.note)}</p>
          <dl>
            <dt>CT</dt><dd>${fmt(board.cycleSeconds, 2)} s</dd>
            <dt>UPH</dt><dd>${board.unitsPerHour}</dd>
            <dt>瓶颈</dt><dd>${escapeHtml(board.bottleneck)}</dd>
            <dt>成本</dt><dd class="${board.pendingQuoteCount > 0 ? 'warn' : ''}">¥${fmt(board.totalCostYuan, 2)}${board.pendingQuoteCount > 0 ? ` · ${board.pendingQuoteCount} 项待询价` : ''}</dd>
            <dt>惯量比</dt><dd>${board.inertiaRatio === null ? '—' : fmt(board.inertiaRatio, 2)}</dd>
            <dt>不匹配</dt><dd class="${board.mismatchCount > 0 ? 'warn' : ''}">${board.mismatchCount} 条</dd>
          </dl>
        </article>`
        )
        .join('')}
    </div>
    <p class="cw-hint" style="padding:0 12px 12px">
      三块画板是**同一张拓扑**在三种产能口径下的真实评估（single / linear / dial），
      不是三套不同 BOM 的候选方案 —— 候选方案要等 P3 接 design/synthesis，这里不伪造。
    </p>`;
  host.dataset.boards = String(boards.length);
}

// ---------------------------------------------------------------------------
// 渲染：甘特
// ---------------------------------------------------------------------------

function renderGantt(): void {
  const host = document.getElementById('cwGantt');
  if (!host) return;
  const view = buildGanttView(state.graph);
  host.innerHTML = `
    <div class="cw-gantt-head">
      <span>工步甘特（拖动条改单步时间）</span>
      <b>Σ ${fmt(view.totalSec, 2)} s</b>
      <span>${escapeHtml(view.note)}</span>
    </div>
    ${view.rows
      .map(
        (row) => `
      <div class="cw-gantt-row" data-gantt-node="${escapeHtml(row.nodeId)}">
        <span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
        <div class="cw-gantt-track">
          <div class="cw-gantt-bar" data-action="gantt-drag" data-node-id="${escapeHtml(row.nodeId)}"
               style="left:${(row.leftRatio * 100).toFixed(2)}%;width:${Math.max(0.6, row.widthRatio * 100).toFixed(2)}%"></div>
        </div>
        <span class="cw-gantt-sec">${row.stepSec.toFixed(2)}s</span>
      </div>`
      )
      .join('')}`;
  host.dataset.rows = String(view.rows.length);
}

// ---------------------------------------------------------------------------
// 渲染：KPI 与检查器
// ---------------------------------------------------------------------------

function renderKpis(): void {
  const data = summary();
  const cost = document.getElementById('cwKpiCost');
  const ct = document.getElementById('cwKpiCt');
  const uph = document.getElementById('cwKpiUph');
  const mismatch = document.getElementById('cwKpiMismatch');
  if (cost) {
    cost.textContent = data.pendingQuoteCount > 0
      ? `¥${fmt(data.totalCostYuan, 0)}（${data.pendingQuoteCount} 项待询价）`
      : `¥${fmt(data.totalCostYuan, 0)}`;
    cost.classList.toggle('warn', !data.costComplete);
  }
  if (ct) ct.textContent = `${fmt(data.cycleSeconds, 2)}s`;
  if (uph) uph.textContent = String(data.unitsPerHour);
  if (mismatch) {
    mismatch.textContent = String(data.mismatchCount);
    mismatch.classList.toggle('warn', data.mismatchCount > 0);
  }
  const canvas = document.getElementById('cwCanvas');
  if (canvas) canvas.dataset.summaryCt = String(data.cycleSeconds);
}

function portRow(label: string, port: CanvasNode['portIn'], bad: boolean): string {
  return `<div class="cw-port${bad ? ' is-mismatch' : ''}"><em>${label}</em> ${escapeHtml(formatPort(port))}</div>`;
}

function renderInspector(): void {
  const host = document.getElementById('cwInspector');
  if (!host) return;
  const node = selectedNode();
  if (!node) {
    host.innerHTML = '<p class="cw-empty">先在上方画布选一个节点。</p>';
    return;
  }
  host.dataset.nodeId = node.id;
  if (state.inspector === 'prop') host.innerHTML = inspectorProp(node);
  else if (state.inspector === 'mech') host.innerHTML = inspectorMech(node);
  else host.innerHTML = inspectorBom(node);
}

function inspectorProp(node: CanvasNode): string {
  const outgoing = state.graph.edges.filter((edge) => edge.from === node.id);
  const incoming = state.graph.edges.filter((edge) => edge.to === node.id);
  const badFields = new Set<string>();
  for (const edge of [...incoming, ...outgoing]) {
    const from = state.graph.nodes.find((item) => item.id === edge.from);
    const to = state.graph.nodes.find((item) => item.id === edge.to);
    if (!from || !to) continue;
    for (const field of portDiff(from.portOut, to.portIn)) badFields.add(field);
  }
  const adapterBlock = node.adapterParams
    ? `
      <section class="cw-section">
        <h4>转接板参数（build123d 生成请求）</h4>
        <div class="cw-field"><span>板外形</span><b>${node.adapterParams.plateDimsMm.join(' × ')} mm</b></div>
        <div class="cw-field"><span>板厚</span><b>${node.adapterParams.thicknessMm} mm</b></div>
        <div class="cw-field"><span>材料</span><b>${escapeHtml(node.adapterParams.material)}</b></div>
        <div class="cw-field"><span>沉头孔</span><b>${node.adapterParams.counterBore ? '母件侧沉头' : '通孔'}</b></div>
        <div class="cw-field"><span>定位销</span><b>${node.adapterParams.dowelDiaMm > 0 ? `Ø${node.adapterParams.dowelDiaMm}mm × 2` : '不设'}</b></div>
        <div class="cw-field"><span>质量</span><b>${node.adapterParams.massKg} kg</b></div>
        <div class="cw-field"><span>价格</span><b class="cw-warn">${node.adapterParams.costYuan === null ? '待询价（不计入总额）' : `¥${node.adapterParams.costYuan}`}</b></div>
        ${platePreview(node)}
        <p class="cw-hint">孔位由两端 MountPort 决定；这只是图纸参数，build123d 实际建模走 parametric sidecar（当前仅导出文本）。</p>
      </section>`
    : '';

  const mismatchEdge = state.graph.edges.find((edge) => {
    if (edge.from !== node.id && edge.to !== node.id) return false;
    const from = state.graph.nodes.find((item) => item.id === edge.from);
    const to = state.graph.nodes.find((item) => item.id === edge.to);
    return Boolean(from && to && portDiff(from.portOut, to.portIn).length > 0);
  });

  return `
    <section class="cw-section">
      <h4>${escapeHtml(node.name)}</h4>
      <div class="cw-field"><span>id</span><b>${escapeHtml(node.id)}</b></div>
      <div class="cw-field"><span>类型</span><b>${escapeHtml(node.kind)}${isAdapterNode(node) ? '（转接板）' : ''}</b></div>
      <div class="cw-field"><span>型号</span><b>${node.partId ? escapeHtml(node.partId) : '待选型'}</b></div>
      <div class="cw-field"><span>规格</span><b title="${escapeHtml(node.spec)}">${escapeHtml(node.spec || '—')}</b></div>
      <div class="cw-field"><span>行程 / 导程</span><b>${node.strokeMm} / ${node.leadMm} mm</b></div>
      <div class="cw-field"><span>质量</span><b>${node.massKg} kg</b></div>
      <div class="cw-field"><span>单步时间</span><b>${node.stepSec} s（仅甘特）</b></div>
      <div class="cw-field"><span>外形</span><b>${node.dimsMm.join(' × ')} mm</b></div>
      <div class="cw-field"><span>正交坐标</span><b>${node.ortho.x}, ${node.ortho.y} mm</b></div>
    </section>
    <section class="cw-section">
      <h4>安装端口</h4>
      ${portRow('入 portIn', node.portIn, badFields.size > 0)}
      ${portRow('出 portOut', node.portOut, badFields.size > 0)}
      ${
        mismatchEdge
          ? `<p class="cw-hint cw-warn">该节点参与的边有端口不匹配：在画布上点「⚡ 生成转接板」，或点下面的按钮。</p>
             <div class="cw-inspector-actions"><button type="button" class="cw-btn primary" data-action="insert-adapter" data-edge-id="${escapeHtml(mismatchEdge.id)}">⚡ 生成转接板</button></div>`
          : '<p class="cw-hint cw-ok">端口全字段匹配，无需转接板。</p>'
      }
    </section>
    ${adapterBlock}
    <section class="cw-section">
      <h4>操作</h4>
      <div class="cw-inspector-actions">
        <button type="button" class="cw-btn danger" data-action="delete-node">删除该节点</button>
      </div>
      <p class="cw-hint">删除转接板会恢复上下游直连；若两端仍不匹配，会重新标橙。</p>
    </section>`;
}

function platePreview(node: CanvasNode): string {
  const params = node.adapterParams;
  if (!params) return '';
  const [w, h] = params.plateDimsMm;
  const pad = 26;
  const width = 240;
  const height = 140;
  const sx = (width - pad * 2) / Math.max(w, 1);
  const sy = (height - pad * 2) / Math.max(h, 1);
  const cx = width / 2;
  const cy = height / 2;
  const holes = (port: typeof params.fromPort, radial: number, cls: string): string => {
    const cols = port.count <= 1 ? 1 : 2;
    const rows = Math.max(1, Math.ceil(port.count / cols));
    const points: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = cx + ((col - (cols - 1) / 2) * port.pitchXMm) * sx;
        const y = cy + ((row - (rows - 1) / 2) * port.pitchYMm) * sy;
        points.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.max(1.6, (port.holeDiaMm / 2) * Math.min(sx, sy) * 2.2).toFixed(1)}" />`);
      }
    }
    return points.join('');
  };
  return `
    <svg class="cw-plate" viewBox="0 0 ${width} ${height}" role="img" aria-label="转接板孔位预览">
      <rect class="plate" x="${pad * 0.6}" y="${pad * 0.6}" width="${width - pad * 1.2}" height="${height - pad * 1.2}" rx="6" />
      ${holes(params.fromPort, 0, 'from')}
      ${holes(params.toPort, 0, 'to')}
      <text x="8" y="14">${w}×${h}×${params.thicknessMm}mm · ${escapeHtml(params.material)}</text>
    </svg>`;
}

function mechBlock(node: CanvasNode, sizing: AxisSizingResult): string {
  return `
    <section class="cw-section">
      <h4>${escapeHtml(node.name)} · 梯形速度曲线</h4>
      <div class="cw-field"><span>v_max</span><b>${fmt(sizing.vMaxMs, 3)} m/s</b></div>
      <div class="cw-field"><span>加速度</span><b>${fmt(sizing.accelMs2, 1)} m/s²</b></div>
      <div class="cw-field"><span>α</span><b>${fmt(sizing.alphaRadS2, 0)} rad/s²</b></div>
      <div class="cw-field"><span>最高转速</span><b>${fmt(sizing.maxRpm, 0)} rpm</b></div>
      <div class="cw-field"><span>J_load</span><b>${sizing.jLoadKgM2.toExponential(3)} kg·m²</b></div>
      <div class="cw-field"><span>惯量比</span><b class="${sizing.checks.inertiaOk ? 'cw-ok' : 'cw-warn'}">${fmt(sizing.inertiaRatio, 2)}</b></div>
      <div class="cw-field"><span>T_peak</span><b>${fmt(sizing.tPeakNm, 3)} N·m</b></div>
      <div class="cw-field"><span>T_rms</span><b>${fmt(sizing.tRmsNm, 3)} N·m</b></div>
      <div class="cw-field"><span>挠度</span><b class="${sizing.checks.deflectionOk ? 'cw-ok' : 'cw-warn'}">${fmt(sizing.deflectionMm, 4)} mm</b></div>
      <pre class="cw-formula">${sizing.formulas.map((line) => escapeHtml(line)).join('\n')}</pre>
      <p class="cw-hint">${escapeHtml(sizing.verdict)}</p>
      <p class="cw-hint">不含减速箱刚度、热伸长与切削力；临界转速/压杆稳定见下方（标准端部条件，仍需与丝杠样本核对）。</p>
    </section>`;
}

function screwBlock(result: ScrewSizingResult): string {
  const mark = (value: boolean | null): string => (value === null ? 'cw-hint' : value ? 'cw-ok' : 'cw-warn');
  const label = (value: boolean | null): string => (value === null ? '未判定' : value ? '通过' : '超限');
  return `
    <section class="cw-section">
      <h4>丝杠临界转速 / 压杆稳定 / DN</h4>
      <div class="cw-field"><span>端部支撑</span><b>${escapeHtml(result.endFixityLabel)}</b></div>
      <div class="cw-field"><span>n_cr</span><b>${fmt(result.criticalSpeedRpm, 0)} rpm</b></div>
      <div class="cw-field"><span>允许转速</span><b>${fmt(result.speedLimitRpm, 0)} rpm（min(0.8n_cr, DN/d)）</b></div>
      <div class="cw-field"><span>转速判定</span><b class="${mark(result.checks.criticalSpeedOk)}">${label(result.checks.criticalSpeedOk)} · ${fmt(result.maxRpm ?? 0, 0)} rpm</b></div>
      <div class="cw-field"><span>DN 值</span><b class="${mark(result.checks.dnOk)}">${fmt(result.dnValue, 0)} / ${fmt(result.dnLimit, 0)}</b></div>
      <div class="cw-field"><span>压杆许用</span><b class="${mark(result.checks.bucklingOk)}">${fmt(result.bucklingAllowableN, 0)} N（载荷 ${fmt(result.axialLoadN, 0)} N）</b></div>
      <pre class="cw-formula">${result.formulas.map((line) => escapeHtml(line)).join('\n')}</pre>
      <p class="cw-hint">${escapeHtml(result.verdict)}</p>
    </section>`;
}

function inspectorMech(node: CanvasNode): string {
  const data = summary();
  const usable = node.strokeMm > 0 && node.leadMm > 0 && node.stepSec > 0;
  const primary = data.primaryAxis;
  const sections: string[] = [];
  if (usable) {
    const carried = downstreamMass(node.id);
    const sizing = axisSizing(node, carried, node.stepSec);
    sections.push(mechBlock(node, sizing), screwBlock(screwSizing(node, { maxRpm: sizing.maxRpm })));
  } else {
    sections.push(
      `<section class="cw-section"><h4>该节点不适用于单轴选型</h4><p class="cw-hint">需要 行程 &gt; 0、导程 &gt; 0 且有单步时间。当前 ${node.strokeMm}/${node.leadMm}mm、${node.stepSec}s。</p></section>`
    );
  }
  if (primary && primary.nodeId !== node.id) {
    const axis = state.graph.nodes.find((item) => item.id === primary.nodeId);
    if (axis) sections.push(`<p class="cw-hint">主运动轴是 ${escapeHtml(primary.name)}（行程最大）。</p>`, mechBlock(axis, primary.sizing));
  }
  sections.push(
    `<section class="cw-section"><h4>口径</h4><p class="cw-hint">整机 CT ${fmt(data.cycleSeconds, 2)}s / UPH ${data.unitsPerHour}，来自 evaluateFlow（${escapeHtml(
      state.graph.layout ?? 'single'
    )} 口径）；单步时间仅是甘特输入。</p></section>`
  );
  return sections.join('');
}

function downstreamMass(nodeId: string): number {
  const outgoing = new Map<string, string[]>();
  for (const edge of state.graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const seen = new Set<string>([nodeId]);
  const queue = [...(outgoing.get(nodeId) ?? [])];
  let mass = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) continue;
    mass += node.massKg;
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  return Math.round(mass * 1000) / 1000;
}

function inspectorBom(node: CanvasNode): string {
  const data = summary();
  const lines = buildBomLines(state.graph, priceLookup);
  const di = state.graph.nodes.reduce((sum, item) => sum + item.io.di, 0);
  const doCount = state.graph.nodes.reduce((sum, item) => sum + item.io.do, 0);
  const adapterLines = lines.filter((line) => line.adapter);
  return `
    <section class="cw-section">
      <h4>价格源</h4>
      <p class="cw-hint ${priceSourceError ? 'cw-warn' : ''}">${escapeHtml(
        priceSourceError ? `不可用：${priceSourceError}` : describePriceSource(priceSource)
      )}</p>
    </section>
    <section class="cw-section">
      <h4>当前节点 IO</h4>
      <div class="cw-field"><span>DI / DO</span><b>${node.io.di} / ${node.io.do}</b></div>
      <div class="cw-field"><span>说明</span><b>${escapeHtml(node.io.desc || '—')}</b></div>
      <div class="cw-field"><span>全机 DI+DO</span><b>${di + doCount}</b></div>
    </section>
    <section class="cw-section">
      <h4>BOM（${lines.length} 行）</h4>
      ${lines
        .map(
          (line) => `
        <div class="cw-field">
          <span>${escapeHtml(line.name)}</span>
          <b class="${line.priceState === 'pending' ? 'cw-warn' : ''}">
            ${line.partId ? escapeHtml(line.partId) : '待选型'} · ${line.priceState === 'pending' ? '待询价' : '已定价'}
          </b>
        </div>`
        )
        .join('')}
      <div class="cw-field"><span>合计</span><b class="${data.costComplete ? 'cw-ok' : 'cw-warn'}">¥${fmt(data.totalCostYuan, 2)}${data.costComplete ? '' : ` · ${data.pendingQuoteCount} 项待询价`}</b></div>
      <p class="cw-hint">缺价行不计入总额，总额标「不完全统计」；P2 没有接价格簿，所有行都落在待询价。</p>
    </section>
    <section class="cw-section">
      <h4>转接板</h4>
      <div class="cw-field"><span>数量</span><b>${adapterLines.length} 件</b></div>
      <p class="cw-hint">转接板是非标机加工件，价格必须询价；PLC 侧无 IO。</p>
    </section>`;
}

// ---------------------------------------------------------------------------
// 模式 / 导出
// ---------------------------------------------------------------------------

function renderMode(): void {
  const section = root();
  for (const button of section.querySelectorAll<HTMLElement>('[data-action="mode"]')) {
    button.classList.toggle('is-active', button.dataset.mode === state.mode);
  }
  for (const view of section.querySelectorAll<HTMLElement>('.cw-view')) {
    view.hidden = view.dataset.mode !== state.mode;
  }
  const gantt = document.getElementById('cwGantt');
  if (gantt) gantt.hidden = state.mode === 'artboard';
}

function exportContent(tab: ExportTab): string {
  if (tab === 'json') return buildMachineGraphJson(state.graph);
  if (tab === 'build123d') return build123dScript(state.graph);
  const result = plcSt(state.graph);
  if (result.supported && result.content) return result.content;
  return [
    `# PLC ST 未生成：${result.reason}`,
    '#',
    '# 下面是给 plcgen 的 Machine Graph JSON IR（补点位后可直接复用生成器）：',
    '',
    result.graphIr ?? ''
  ].join('\n');
}

function renderExport(): void {
  const modal = document.getElementById('cwExportModal');
  if (!modal) return;
  const code = document.getElementById('cwExportCode');
  if (code) code.textContent = exportContent(state.exportTab);
  for (const button of modal.querySelectorAll<HTMLElement>('[data-action="export-tab"]')) {
    button.classList.toggle('is-active', button.dataset.tab === state.exportTab);
  }
  const stateLabel = document.getElementById('cwCopyState');
  if (stateLabel) stateLabel.textContent = '';
}

function renderAll(): void {
  renderKpis();
  renderTopology();
  renderOrtho();
  renderArtboards();
  renderGantt();
  renderInspector();
  renderMode();
  if (!document.getElementById('cwExportModal')?.hidden) renderExport();
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function selectNode(id: string | null): void {
  state.selectedId = id;
  renderTopology();
  renderOrtho();
  renderInspector();
  markDirty();
}

function insertAdapter(edgeId: string): void {
  try {
    const before = findMismatchedEdges(state.graph).length;
    const result = insertAdapterForEdge(state.graph, edgeId, adapterFactory);
    if (!result.inserted) {
      toast(result.reason);
      return;
    }
    state.graph = result.graph;
    state.selectedId = result.adapterId;
    renderAll();
    markDirty();
    const after = findMismatchedEdges(state.graph).length;
    toast(`已插入 ${result.adapterId}：不匹配 ${before} → ${after}，转接板价格待询价`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  }
}

function insertAllAdapters(): void {
  const before = findMismatchedEdges(state.graph).length;
  if (before === 0) {
    toast('所有端口已全字段匹配，无需转接板');
    return;
  }
  const result = insertAdaptersForAllMismatches(state.graph, adapterFactory);
  state.graph = result.graph;
  if (result.adapterIds.length > 0) state.selectedId = result.adapterIds[0] ?? state.selectedId;
  renderAll();
  markDirty();
  toast(`已生成 ${result.adapterIds.length} 块转接板：不匹配 ${before} → ${findMismatchedEdges(state.graph).length}`);
}

function addModule(itemId: string): void {
  const item = paletteIndex.get(itemId) ?? CANVAS_PALETTE.find((entry) => entry.id === itemId);
  if (!item) return;
  const current = selectedNode();
  const idBase = `n-${item.kind}-${state.graph.nodes.length + 1}`;
  let id = idBase;
  let index = 2;
  while (state.graph.nodes.some((node) => node.id === id)) {
    id = `${idBase}-${index}`;
    index += 1;
  }
  const pos = current
    ? { x: current.pos.x + 260, y: current.pos.y + 24 }
    : { x: DEFAULT_MARGIN_PX, y: DEFAULT_MARGIN_PX };
  const ortho = current
    ? { x: current.ortho.x + Math.max(current.dimsMm[0], 120) + 40, y: current.ortho.y + 20 }
    : { x: 0, y: 0 };
  const node = paletteNode(item, id, pos, ortho);
  const edges = [...state.graph.edges];
  if (current) edges.push({ id: `e-${current.id}-${id}`, from: current.id, to: id });
  state.graph = { ...state.graph, nodes: [...state.graph.nodes, node], edges };
  state.selectedId = id;
  renderAll();
  markDirty();
  const mismatched = current
    ? portDiff(current.portOut, node.portIn).length > 0
    : false;
  toast(mismatched ? `已添加 ${item.label}；与上游端口不匹配，可点 ⚡ 生成转接板` : `已添加 ${item.label}`);
}

function deleteSelected(): void {
  const node = selectedNode();
  if (!node) return;
  try {
    const result = removeNode(state.graph, node.id);
    state.graph = result.graph;
    state.selectedId = null;
    renderAll();
    markDirty();
    const mismatched = findMismatchedEdges(state.graph).length;
    toast(
      result.restoredEdge
        ? `已删除 ${node.id} 并恢复直连 ${result.restoredEdge.from} → ${result.restoredEdge.to}；当前不匹配 ${mismatched} 条`
        : `已删除 ${node.id}；当前不匹配 ${mismatched} 条`
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  }
}

/** 拖拽：拓扑改 pos（px），2D 改 ortho（mm）。 */
/** 点选（鼠标 click + 键盘 Enter/Space）：pointerdown 也会选中，这里覆盖无 pointer 的路径。 */
function bindSelection(): void {
  document.addEventListener('click', (event) => {
    const nodeElement = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cw-node');
    if (!nodeElement) return;
    if ((event.target as HTMLElement | null)?.closest('[data-action]')) return;
    const id = nodeElement.dataset.nodeId;
    if (id) selectNode(id);
  });
  document.addEventListener('keydown', (event) => {
    if (!state.open) return;
    const nodeElement = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cw-node');
    if (!nodeElement) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const id = nodeElement.dataset.nodeId;
    if (!id) return;
    event.preventDefault();
    selectNode(id);
  });
}

function bindDrag(): void {
  let drag: { id: string; startX: number; startY: number; originX: number; originY: number; mode: ViewMode; moved: boolean } | null = null;
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('[data-action]')) return;
    const nodeElement = target.closest<HTMLElement>('[data-node-id]');
    if (!nodeElement) return;
    const id = nodeElement.dataset.nodeId;
    if (!id) return;
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) return;
    selectNode(id);
    drag = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.mode === 'ortho' ? node.ortho.x : node.pos.x,
      originY: state.mode === 'ortho' ? node.ortho.y : node.pos.y,
      mode: state.mode,
      moved: false
    };
    nodeElement.setPointerCapture?.(event.pointerId);
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const node = state.graph.nodes.find((item) => item.id === drag?.id);
    if (!node || drag.mode === 'artboard') return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.mode === 'ortho') {
      const scale = buildOrthoView(state.graph).scale || 1;
      node.ortho = { x: Math.round(drag.originX + dx / scale), y: Math.round(drag.originY + dy / scale) };
      renderOrtho();
    } else {
      node.pos = { x: Math.round(drag.originX + dx), y: Math.round(drag.originY + dy) };
      renderTopology();
    }
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    renderInspector();
    if (moved) markDirty();
  });
}

/** 甘特条拖拽 → 改 stepSec（0.05 下限）。 */
function bindGanttDrag(): void {
  let drag: { id: string; startX: number; trackWidth: number; origin: number } | null = null;
  document.addEventListener('pointerdown', (event) => {
    const bar = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="gantt-drag"]');
    if (!bar) return;
    const id = bar.dataset.nodeId;
    const track = bar.parentElement;
    if (!id || !track) return;
    const node = state.graph.nodes.find((item) => item.id === id);
    if (!node) return;
    drag = { id, startX: event.clientX, trackWidth: Math.max(1, track.clientWidth), origin: node.stepSec };
    bar.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const node = state.graph.nodes.find((item) => item.id === drag?.id);
    if (!node) return;
    const total = buildGanttView(state.graph).totalSec || 1;
    const delta = ((event.clientX - drag.startX) / drag.trackWidth) * total;
    node.stepSec = Math.max(0.05, Math.round((drag.origin + delta) * 100) / 100);
    renderGantt();
    renderKpis();
    renderInspector();
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    markDirty();
  });
}

function bindEvents(): void {
  const section = root();
  section.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'mode') {
      const mode = target.dataset.mode as ViewMode | undefined;
      if (mode) {
        state.mode = mode;
        renderMode();
        markDirty();
      }
      return;
    }
    if (action === 'inspector') {
      const tab = target.dataset.tab as InspectorTab | undefined;
      if (tab) {
        state.inspector = tab;
        for (const button of section.querySelectorAll<HTMLElement>('[data-action="inspector"]')) {
          button.classList.toggle('is-active', button.dataset.tab === tab);
        }
        renderInspector();
      }
      return;
    }
    if (action === 'insert-adapter') {
      const edgeId = target.dataset.edgeId;
      if (edgeId) insertAdapter(edgeId);
      return;
    }
    if (action === 'auto-adapters') {
      insertAllAdapters();
      return;
    }
    if (action === 'add-module') {
      const item = target.dataset.item;
      if (item) addModule(item);
      return;
    }
    if (action === 'delete-node') {
      deleteSelected();
      return;
    }
    if (action === 'export') {
      const modal = document.getElementById('cwExportModal');
      if (modal) modal.hidden = false;
      renderExport();
      return;
    }
    if (action === 'close-export') {
      const modal = document.getElementById('cwExportModal');
      if (modal) modal.hidden = true;
      return;
    }
    if (action === 'export-tab') {
      const tab = target.dataset.tab as ExportTab | undefined;
      if (tab) {
        state.exportTab = tab;
        renderExport();
      }
      return;
    }
    if (action === 'copy-export') {
      const code = document.getElementById('cwExportCode')?.textContent ?? '';
      const done = (): void => {
        const label = document.getElementById('cwCopyState');
        if (label) label.textContent = `已复制 ${code.length} 字符`;
      };
      void navigator.clipboard?.writeText(code).then(done).catch(() => {
        toast('剪贴板不可用，请手动全选复制', true);
      });
      return;
    }
    if (action === 'reset-demo') {
      clearDraft(getDraftStorage());
      state.graph = demoCanvasGraph();
      state.selectedId = 'AXIS-Y';
      state.mode = 'topology';
      renderAll();
      persistNow();
      toast('已清除本地草稿并重置为演示拓扑');
      return;
    }
    if (action === 'close') {
      closeCanvasWorkbench();
    }
  });

  section.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id !== 'cwPaletteSearch') return;
    renderPalette((target as HTMLInputElement).value);
  });

  window.addEventListener('keydown', (event) => {
    if (!state.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!document.getElementById('cwExportModal')?.hidden) {
        const modal = document.getElementById('cwExportModal');
        if (modal) modal.hidden = true;
        return;
      }
      closeCanvasWorkbench();
    }
    if (event.key === 'Delete' && state.selectedId) {
      event.preventDefault();
      deleteSelected();
    }
  }, true);
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------

export function openCanvasWorkbench(): void {
  ensureStyles();
  buildShell();
  const section = root();
  section.hidden = false;
  state.open = true;
  restoreDraft();
  renderAll();
}

export function closeCanvasWorkbench(): void {
  const section = document.getElementById('canvasWorkbench');
  if (section) section.hidden = true;
  state.open = false;
}

export function installCanvasWorkbench(): void {
  if (mounted) return;
  mounted = true;
  ensureStyles();
  buildShell();
  rebuildPaletteIndex();
  renderPalette();
  void loadPacksPalette();
  bindEvents();
  bindSelection();
  bindDrag();
  bindGanttDrag();
  buildEntryButton(
    'canvasWorkbenchEntryButton',
    '画布工作台',
    '<svg viewBox="0 0 16 16"><path d="M2 11V5a1 1 0 0 1 1-1h3l1.4 1.6H13a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M5 8h6"/></svg>',
    () => openCanvasWorkbench()
  );
  renderAll();
  void loadPriceSource();
}

/** 给冒烟/自动化用的状态快照（不含 DOM 引用）。 */
export function canvasWorkbenchState(): Record<string, number | string | boolean> {
  const view = buildTopologyView(state.graph);
  const ortho = buildOrthoView(state.graph);
  const summaryData = summary();
  return {
    open: state.open,
    mode: state.mode,
    nodeCount: state.graph.nodes.length,
    edgeCount: state.graph.edges.length,
    adapterCount: view.adapterCount,
    mismatchCount: view.mismatchCount,
    stationCount: ortho.stations.length,
    cycleSeconds: summaryData.cycleSeconds,
    unitsPerHour: summaryData.unitsPerHour,
    pendingQuoteCount: summaryData.pendingQuoteCount
  };
}

export interface CanvasSelfTestResult {
  nodes: number;
  edges: number;
  mismatchBefore: number;
  mismatchAfterInsert: number;
  adaptersAfterInsert: number;
  mismatchAfterAll: number;
  stations: number;
  artboards: number;
  ganttRows: number;
  exportLengths: { json: number; build123d: number; plc: number };
  cycleSeconds: number;
  unitsPerHour: number;
  pendingQuote: number;
  adapterBridgesMatch: boolean;
}

/**
 * 自测：走真实的 data-action 交互（不是直接调函数），返回可断言的数字。
 * 冒烟用它打印 SMOKE_CANVAS_*，人工排查也用它。
 */
export function canvasWorkbenchSelfTest(): CanvasSelfTestResult {
  openCanvasWorkbench();
  state.graph = demoCanvasGraph();
  state.selectedId = 'AXIS-Y';
  renderAll();
  const section = root();
  const nodes = state.graph.nodes.length;
  const edges = state.graph.edges.length;
  const mismatchBefore = findMismatchedEdges(state.graph).length;

  const badge = section.querySelector<HTMLElement>('[data-action="insert-adapter"]');
  badge?.click();
  const mismatchAfterInsert = findMismatchedEdges(state.graph).length;
  const adaptersAfterInsert = state.graph.nodes.filter((node) => isAdapterNode(node)).length;
  const adapterBridgesMatch = state.graph.nodes
    .filter((node) => isAdapterNode(node))
    .every((node) => {
      const incoming = state.graph.edges.find((edge) => edge.to === node.id);
      const outgoing = state.graph.edges.find((edge) => edge.from === node.id);
      if (!incoming || !outgoing) return false;
      const upstream = state.graph.nodes.find((item) => item.id === incoming.from);
      const downstream = state.graph.nodes.find((item) => item.id === outgoing.to);
      if (!upstream || !downstream) return false;
      return portDiff(upstream.portOut, node.portIn).length === 0 && portDiff(node.portOut, downstream.portIn).length === 0;
    });

  section.querySelector<HTMLElement>('[data-action="auto-adapters"]')?.click();
  const mismatchAfterAll = findMismatchedEdges(state.graph).length;

  section.querySelector<HTMLElement>('[data-action="mode"][data-mode="ortho"]')?.click();
  const stations = Number(document.getElementById('cwOrtho')?.dataset.stations ?? 0);
  section.querySelector<HTMLElement>('[data-action="mode"][data-mode="artboard"]')?.click();
  const artboards = Number(document.getElementById('cwArtboards')?.dataset.boards ?? 0);
  const ganttRows = Number(document.getElementById('cwGantt')?.dataset.rows ?? 0);

  section.querySelector<HTMLElement>('[data-action="export"]')?.click();
  const lengths = { json: 0, build123d: 0, plc: 0 };
  for (const tab of ['json', 'build123d', 'plc'] as const) {
    section.querySelector<HTMLElement>(`[data-action="export-tab"][data-tab="${tab}"]`)?.click();
    lengths[tab] = document.getElementById('cwExportCode')?.textContent?.length ?? 0;
  }
  section.querySelector<HTMLElement>('[data-action="close-export"]')?.click();

  section.querySelector<HTMLElement>('[data-action="mode"][data-mode="topology"]')?.click();
  const data = summary();
  const result: CanvasSelfTestResult = {
    nodes,
    edges,
    mismatchBefore,
    mismatchAfterInsert,
    adaptersAfterInsert,
    mismatchAfterAll,
    stations,
    artboards,
    ganttRows,
    exportLengths: lengths,
    cycleSeconds: data.cycleSeconds,
    unitsPerHour: data.unitsPerHour,
    pendingQuote: data.pendingQuoteCount,
    adapterBridgesMatch
  };
  state.graph = demoCanvasGraph();
  state.selectedId = 'AXIS-Y';
  renderAll();
  markDirty();
  return result;
}

declare global {
  interface Window {
    __CanvasWorkbench?: {
      open: () => void;
      close: () => void;
      state: () => Record<string, number | string | boolean>;
      selfTest: () => CanvasSelfTestResult;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__CanvasWorkbench = {
    open: openCanvasWorkbench,
    close: closeCanvasWorkbench,
    state: canvasWorkbenchState,
    selfTest: canvasWorkbenchSelfTest
  };
}
