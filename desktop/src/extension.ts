import cadStyles from './cad.css?inline';
import CadImportWorker from './cad/importer.worker?worker&inline';
import wasmAssetUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { occtFormatForFile, parseOcctBuffer } from './cad/step';
import { parseStandardCadBuffer } from './cad/loaders';
import { CadViewer } from './cad/viewer';
import {
  initKinematicsUi,
  pointOptionsFromMachineConfig,
  type KinematicsUiHandle
} from './cad/kinematics-ui';
import type { CadImportResult } from './shared/types';
import { initFactoryPanel } from './factory/ui';
import { initPackPanel } from './packs/ui';
import { initElecLibraryPanel } from './packs/elec-ui';
import { closeEnclosure, initEnclosureUi } from './enclosure/canvas';
import { initElecCheckPanel } from './elec/ui';
import { initCommissionPanel, type CommissionPanelHandle } from './commission/ui';
import { initSyncPanel } from './sync/ui';
import { initAgentPanel } from './agent/ui';
import type { SyncUploadPayload } from './sync/types';
import type { InterferenceHit, InterferencePart } from './mech/interference';
import { initInterferencePanel, type InterferencePanelHandle } from './mech/interference-ui';
import { initStressPanel, type StressConclusion } from './mech/ui';
import { toCsv, toXlsx, type BomRow } from './export/bom';
import { toDxf, type DxfShape } from './export/dxf';
import { toMeshBlob } from './export/mesh';
import { renderReportHtml } from './export/report';

const ICONS = {
  cube: '<svg viewBox="0 0 16 16"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M2 4.2h4l1.4 1.8H14v6.6H2z"/><path d="M9.2 9.1h3.6M11 7.3l1.8 1.8-1.8 1.8"/></svg>',
  fit: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h3.2M2.5 2.5v3.2M13.5 2.5h-3.2M13.5 2.5v3.2M2.5 13.5h3.2M2.5 13.5v-3.2M13.5 13.5h-3.2M13.5 13.5v-3.2"/></svg>',
  wire: '<svg viewBox="0 0 16 16"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14M4.3 6.7L8 8.1l3.7-1.4"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>',
  export: '<svg viewBox="0 0 16 16"><path d="M8 2v7M5.5 6.5L8 9l2.5-2.5M3 11.5v2h10v-2"/></svg>',
  kinematics: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h7M11.5 4.5h2M2.5 11.5h2M6.5 11.5h7"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="5" cy="11.5" r="1.5"/></svg>',
  parametric: '<svg viewBox="0 0 16 16"><path d="M3 13V3M3 13h10"/><path d="M4.5 10.5l2.5-3 2 1.5 3-4.5"/><circle cx="7" cy="7.5" r=".8"/><circle cx="9" cy="9" r=".8"/></svg>'
};

const CAD_ENTRY = 'cadEntryButton';
let viewer: CadViewer | null = null;
let root: HTMLElement | null = null;
let overlayOpen = false;
let busy = false;
let dragDepth = 0;
let noticeTimer = 0;
let worker: Worker | null = null;
let workerSequence = 0;
let currentFileName = '';
let stressConclusions: StressConclusion[] = [];
let interference: InterferencePanelHandle | null = null;
let commission: CommissionPanelHandle | null = null;
let kinematics: KinematicsUiHandle | null = null;
let parametricStarting = false;
let mechUiReady = false;
let stressTabObserver: MutationObserver | null = null;
type ExportFormat = 'pdf' | 'dxf' | 'glb' | 'obj' | 'csv' | 'xlsx';
const pendingWorker = new Map<number, { resolve(result: CadImportResult): void; reject(error: Error): void }>();

function injectStyles(): void {
  if (document.getElementById('automation-cad-styles')) return;
  const style = document.createElement('style');
  style.id = 'automation-cad-styles';
  style.textContent = cadStyles;
  document.head.appendChild(style);
}

function buildEntryButton(): void {
  if (document.getElementById(CAD_ENTRY)) return;
  const target = document.querySelector('.tb-right');
  if (!target) return;
  const button = document.createElement('button');
  button.id = CAD_ENTRY;
  button.type = 'button';
  button.className = 'cad-entry-btn';
  button.title = '打开 CAD 轻量化查看器';
  button.innerHTML = `${ICONS.cube}<span>CAD 查看</span><span class="cad-entry-badge">STEP</span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openOverlay();
  });
  target.appendChild(button);
}

function buildOverlay(): void {
  if (root) return;
  root = document.createElement('div');
  root.id = 'automationCadOverlay';
  root.className = 'cad-overlay';
  root.hidden = true;
  root.innerHTML = `
    <header class="cad-topbar">
      <div class="cad-brand">
        <div class="cad-brand-mark">${ICONS.cube}</div>
        <div>
          <div class="cad-brand-title">CAD 查看</div>
          <div class="cad-brand-sub">轻量化查看模式 · 不进建模内核</div>
        </div>
      </div>
      <div class="cad-actions">
        <button type="button" class="cad-btn cad-btn-primary" data-cad-action="open">${ICONS.open}<span>打开文件</span></button>
        <button type="button" class="cad-btn" data-cad-action="fit">${ICONS.fit}<span>缩放到适合</span></button>
        <button type="button" class="cad-btn" data-cad-action="wire">${ICONS.wire}<span>线框</span></button>
        <button type="button" class="cad-btn" data-cad-action="kinematics" id="cadKinematicsToggle">${ICONS.kinematics}<span>运动学</span></button>
        <button type="button" class="cad-btn" data-cad-action="parametric" id="cadParametricToggle">${ICONS.parametric}<span>参数化</span></button>
        <span class="cad-parametric-status" id="cadParametricStatus" hidden></span>
        <div class="cad-export-wrap">
          <button type="button" class="cad-btn" data-cad-action="export-menu">${ICONS.export}<span>导出</span><span class="cad-export-caret">▾</span></button>
          <div class="cad-export-menu" id="cadExportMenu" hidden>
            <button type="button" data-export="pdf"><span>PDF 报告</span><em>A3 横向</em></button>
            <button type="button" data-export="dxf"><span>DXF 图纸</span><em>三视图</em></button>
            <button type="button" data-export="glb"><span>GLB 模型</span><em>二进制</em></button>
            <button type="button" data-export="obj"><span>OBJ 模型</span><em>文本</em></button>
            <span class="cad-export-sep"></span>
            <button type="button" data-export="csv"><span>BOM (CSV)</span><em>表格</em></button>
            <button type="button" data-export="xlsx"><span>BOM (XLSX)</span><em>Excel</em></button>
          </div>
        </div>
        <button type="button" class="cad-btn" data-cad-action="close">${ICONS.close}<span>关闭</span></button>
      </div>
      <div class="cad-spacer"></div>
      <div class="cad-file-info" id="cadFileInfo">未打开文件</div>
    </header>
    <main class="cad-main">
      <aside class="cad-sidebar">
        <div class="cad-side-tabs" role="tablist" aria-label="CAD 侧栏">
          <button type="button" class="cad-side-tab is-active" data-cad-side="parts" role="tab" aria-selected="true">零件</button>
          <button type="button" class="cad-side-tab" data-cad-side="stress" role="tab" aria-selected="false">受力</button>
        </div>
        <div class="cad-side-pane" id="cadPartsPane">
          <div class="cad-side-head"><span>零件列表</span><b id="cadPartCount">0</b></div>
          <div class="cad-parts" id="cadParts">
            <div class="cad-parts-empty">打开或拖入 STEP / IGES / BREP / STL / OBJ / GLTF / GLB 文件</div>
          </div>
          <div class="cad-detail" id="cadDetail">
            <div class="cad-detail-empty">单击零件查看包围盒与尺寸</div>
          </div>
        </div>
        <div class="cad-side-pane" id="cadStressPane" hidden></div>
      </aside>
      <section class="cad-viewport">
        <div class="cad-host" id="cadHost"></div>
        <div class="cad-empty" id="cadEmpty">
          <div class="cad-empty-ico">${ICONS.cube}</div>
          <div class="cad-empty-title">把 CAD 文件拖到窗口任意位置</div>
          <div class="cad-empty-sub">STEP / IGES / BREP 由 OCCT WASM 在 Worker 中解析<br>STL / OBJ / GLTF / GLB 使用 three.js 异步加载</div>
        </div>
        <div class="cad-hint">左键旋转 · 滚轮缩放 · 中键/右键平移 · 单击零件测量</div>
        <div class="cad-loading" id="cadLoading" hidden>
          <div class="cad-spinner"></div>
          <div id="cadLoadingText">正在解析 CAD 文件…</div>
        </div>
      </section>
      <aside class="cad-inspector">
        <div class="cad-side-head"><span>干涉检查</span><b id="cadInterferenceCount">0</b></div>
        <div class="cad-inspector-body" id="cadInterferencePanel"></div>
      </aside>
      <aside class="cad-kinematics-drawer" id="cadKinematicsDrawer" hidden></aside>
    </main>
    <footer class="cad-footer">
      <span id="cadStats">就绪 · <strong>0</strong> 个零件</span>
      <span class="cad-footer-flex"></span>
      <span class="cad-unit-note">单位按源文件 mm 解释 · 未做隐式缩放</span>
    </footer>`;
  document.body.appendChild(root);

  root.addEventListener('click', (event) => {
    event.stopPropagation();
    const sideTab = (event.target as HTMLElement).closest<HTMLElement>('[data-cad-side]');
    if (sideTab) {
      const pane = sideTab.dataset.cadSide === 'stress' ? 'stress' : 'parts';
      activateSidePane(pane);
      return;
    }
    const exportItem = (event.target as HTMLElement).closest<HTMLElement>('[data-export]');
    if (exportItem) {
      toggleExportMenu(false);
      const format = exportItem.dataset.export as ExportFormat | undefined;
      if (format) void exportAs(format);
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cad-action]');
    if (!target) return;
    const action = target.dataset.cadAction;
    if (action === 'open') void chooseAndImport();
    else if (action === 'fit') viewer?.fit();
    else if (action === 'wire') {
      const on = viewer?.toggleWireframe() ?? false;
      target.classList.toggle('is-active', on);
      showNotice(on ? '已切换为线框显示' : '已切换为实体显示');
    } else if (action === 'kinematics') {
      const handle = ensureKinematicsUi();
      if (handle.isOpen()) handle.close();
      else handle.open();
    } else if (action === 'parametric') {
      void startParametric();
    } else if (action === 'export-menu') {
      toggleExportMenu();
    } else if (action === 'close') closeOverlay();
  });
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

function activateSidePane(pane: 'parts' | 'stress'): void {
  const partsPane = document.getElementById('cadPartsPane');
  const stressPane = document.getElementById('cadStressPane');
  if (partsPane) partsPane.hidden = pane !== 'parts';
  if (stressPane) stressPane.hidden = pane !== 'stress';
  root?.querySelectorAll<HTMLElement>('[data-cad-side]').forEach((button) => {
    const active = button.dataset.cadSide === pane;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function toggleExportMenu(force?: boolean): void {
  const menu = document.getElementById('cadExportMenu');
  if (!menu) return;
  menu.hidden = force === undefined ? !menu.hidden : !force;
}

function initMechUi(): void {
  if (mechUiReady) return;
  initStressPanel(requiredElement('cadStressPane'), (results) => {
    stressConclusions = results;
  });
  interference = initInterferencePanel({
    container: requiredElement('cadInterferencePanel'),
    getParts: () => viewer?.getModelParts() ?? [],
    highlight: (names) => viewer?.highlightNames(names, true) ?? false,
    clearHighlight: () => viewer?.selectPart(null),
    notify: showNotice,
    onCount: (count) => {
      const badge = document.getElementById('cadInterferenceCount');
      if (badge) badge.textContent = String(count);
    }
  });
  mechUiReady = true;
}

function openStressView(): void {
  openOverlay();
  activateSidePane('stress');
}

function injectStressTab(): void {
  const panel = document.querySelector<HTMLElement>('[data-panel="left"][data-for="assembly"]');
  if (!panel) return;
  const ensure = (): void => {
    const tabs = panel.querySelector<HTMLElement>('.tabs');
    if (!tabs || tabs.querySelector('[data-cad-stress-tab]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'cadStressRootTab';
    button.className = 'tab cad-stress-root-tab';
    button.dataset.cadStressTab = '1';
    button.textContent = '受力';
    button.title = '打开机械受力校核';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openStressView();
    });
    tabs.appendChild(button);
  };
  ensure();
  if (!stressTabObserver) {
    stressTabObserver = new MutationObserver(ensure);
    stressTabObserver.observe(panel, { childList: true, subtree: true });
  }
}

function exportBaseName(): string {
  const raw = currentFileName.replace(/\.[^.]+$/, '').trim() || 'AutomationCAD';
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'AutomationCAD';
}

function currentBomRows(): BomRow[] {
  const rows = reportBomRows();
  if (rows.length === 0) throw new Error('请先打开 CAD 文件再导出');
  return rows;
}

function reportBomRows(): BomRow[] {
  const parts = viewer?.getModelParts() ?? [];
  return parts.map((part, index) => ({
    index: index + 1,
    name: part.name,
    model: part.name,
    quantity: 1,
    material: '—',
    note: '来自当前 CAD 模型'
  }));
}

function currentDxfShapes(): DxfShape[] {
  const parts = viewer?.getModelParts() ?? [];
  if (parts.length === 0) throw new Error('请先打开 CAD 文件再导出 DXF');
  return parts.map((part) => ({ name: part.name, bbox: part.bbox }));
}

function buildReportHtml(): string {
  const commissionReport = commission?.getReport();
  const hasCommission = Boolean(commissionReport && (commissionReport.powerUp.results.length > 0 || commissionReport.cases.length > 0));
  return renderReportHtml({
    project: {
      name: currentFileName || '未命名模型',
      code: 'A3-MECH',
      author: 'AutomationCAD'
    },
    bom: reportBomRows(),
    interference: interference?.getHits() ?? [],
    stress: stressConclusions,
    ...(hasCommission && commissionReport ? { commission: commissionReport } : {})
  });
}

async function buildSyncPayload(): Promise<SyncUploadPayload> {
  if (!viewer) throw new Error('请先在 CAD 查看器中打开模型');
  const bomRows = currentBomRows();
  if (bomRows.length === 0) throw new Error('当前模型没有可同步的 BOM 行');
  const csv = toCsv(bomRows);
  const dxf = toDxf(currentDxfShapes());
  const glbBlob = await toMeshBlob(viewer.getExportRoot(), 'glb');
  const glb = new Uint8Array(await glbBlob.arrayBuffer());
  return {
    projectName: exportBaseName(),
    bomCsv: csv,
    reportHtml: buildReportHtml(),
    glb,
    dxf,
    bom: bomRows.map((row, index) => {
      const bom = {
        no: index + 1,
        name: row.name,
        spec: String(row.model),
        qty: Number(row.quantity) || 1,
        mat: row.material
      };
      return row.note ? { ...bom, remark: row.note } : bom;
    })
  };
}

async function buildExport(format: ExportFormat): Promise<{ name: string; data: string | Uint8Array; size: number }> {
  if (!viewer) throw new Error('请先打开 CAD 文件');
  const base = exportBaseName();
  if (format === 'csv') {
    const text = toCsv(currentBomRows());
    return { name: `${base}-BOM.csv`, data: text, size: new TextEncoder().encode(text).byteLength };
  }
  if (format === 'xlsx') {
    const data = toXlsx(currentBomRows());
    return { name: `${base}-BOM.xlsx`, data, size: data.byteLength };
  }
  if (format === 'dxf') {
    const text = toDxf(currentDxfShapes());
    return { name: `${base}.dxf`, data: text, size: new TextEncoder().encode(text).byteLength };
  }
  if (format === 'glb' || format === 'obj') {
    const blob = await toMeshBlob(viewer.getExportRoot(), format);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { name: `${base}.${format}`, data: bytes, size: bytes.byteLength };
  }
  if (format === 'pdf') {
    const html = buildReportHtml();
    return { name: `${base}-report.pdf`, data: html, size: new TextEncoder().encode(html).byteLength };
  }
  throw new Error(`不支持的导出格式：${String(format)}`);
}

async function exportData(format: ExportFormat): Promise<{ format: string; size: number }> {
  const built = await buildExport(format);
  return { format, size: built.size };
}

async function exportPdfReport(): Promise<{ path: string; htmlPath: string }> {
  if (!window.desktop) throw new Error('导出功能仅在桌面版可用');
  const html = buildReportHtml();
  return await window.desktop.exportReport({ html, projectName: currentFileName });
}

async function exportAs(format: ExportFormat): Promise<void> {
  try {
    if (!window.desktop) throw new Error('导出功能仅在桌面版可用');
    if (format === 'pdf') {
      const result = await exportPdfReport();
      showNotice(`PDF 报告已保存：${result.path}`);
      return;
    }
    const built = await buildExport(format);
    const result = await window.desktop.exportFile(built.name, built.data);
    if (result.canceled) showNotice('导出已取消');
    else showNotice(`已保存：${result.path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showNotice(`导出失败：${message}`, true);
    console.error('[export] 失败', error);
  }
}

function ensureViewer(): CadViewer {
  if (viewer) return viewer;
  const host = requiredElement('cadHost');
  const parts = requiredElement('cadParts');
  const detail = requiredElement('cadDetail');
  viewer = new CadViewer({
    container: host,
    partsElement: parts,
    detailElement: detail,
    onStats: (text) => {
      const stats = document.getElementById('cadStats');
      if (stats) stats.innerHTML = `就绪 · <strong>${text}</strong>`;
    }
  });
  return viewer;
}

function ensureKinematicsUi(): KinematicsUiHandle {
  if (kinematics) return kinematics;
  const container = requiredElement('cadKinematicsDrawer');
  kinematics = initKinematicsUi({
    container,
    viewer: ensureViewer(),
    getPointOptions: () => pointOptionsFromMachineConfig(commission?.getMachineConfig() ?? null),
    notify: showNotice,
    onOpenChange: (open) => {
      document.getElementById('cadKinematicsToggle')?.classList.toggle('is-active', open);
    },
    onChange: (annotation) => {
      commission?.setKinematics(annotation);
    }
  });
  return kinematics;
}

interface ParametricStateView {
  status: 'stopped' | 'starting' | 'ready' | 'unavailable' | 'crashed';
  message: string;
  version?: string;
}

function setParametricStatus(state: ParametricStateView): void {
  const badge = document.getElementById('cadParametricStatus');
  const button = document.getElementById('cadParametricToggle');
  if (!badge) return;
  const labels: Record<ParametricStateView['status'], string> = {
    stopped: '未启动',
    starting: '启动中',
    ready: '就绪',
    unavailable: '不可用',
    crashed: '已崩溃'
  };
  badge.hidden = state.status === 'stopped';
  badge.dataset.state = state.status;
  badge.textContent = `内核 ${labels[state.status]}`;
  badge.title = state.message;
  button?.classList.toggle('is-active', state.status === 'ready');
  button?.setAttribute('aria-busy', String(state.status === 'starting'));
}

async function startParametric(): Promise<void> {
  const api = window.desktop?.parametric;
  if (!api) {
    setParametricStatus({ status: 'unavailable', message: '参数化建模仅桌面端可用' });
    showNotice('参数化建模仅桌面端可用', true);
    return;
  }
  if (parametricStarting) return;
  parametricStarting = true;
  setParametricStatus({ status: 'starting', message: '正在启动参数化建模内核…' });
  try {
    const result = await api.start();
    setParametricStatus({
      status: result.status,
      message: result.message,
      ...(result.version ? { version: result.version } : {})
    });
    showNotice(`参数化建模：${result.message}`, !result.ok);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setParametricStatus({ status: 'unavailable', message: `参数化建模启动失败：${message}` });
    showNotice(`参数化建模启动失败：${message}`, true);
  } finally {
    parametricStarting = false;
  }
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少 CAD UI 节点：${id}`);
  return element;
}

function openOverlay(): void {
  closeEnclosure();
  buildOverlay();
  if (!root) return;
  overlayOpen = true;
  root.hidden = false;
  initMechUi();
  ensureViewer().setActive(true);
  ensureKinematicsUi().open();
  document.getElementById(CAD_ENTRY)?.classList.add('is-active');
}

function closeOverlay(): void {
  overlayOpen = false;
  if (root) root.hidden = true;
  toggleExportMenu(false);
  viewer?.setActive(false);
  document.getElementById(CAD_ENTRY)?.classList.remove('is-active');
  document.getElementById('cadStressRootTab')?.classList.remove('is-active');
  (document.getElementById(CAD_ENTRY) as HTMLButtonElement | null)?.focus();
}

function updateLoading(on: boolean, text?: string, error = false): void {
  const loading = document.getElementById('cadLoading');
  const label = document.getElementById('cadLoadingText');
  if (!loading || !label) return;
  loading.hidden = !on;
  label.textContent = text ?? '正在解析 CAD 文件…';
  label.classList.toggle('cad-loading-error', error);
  const spinner = loading.querySelector<HTMLElement>('.cad-spinner');
  if (spinner) spinner.hidden = error;
}

function setBusy(on: boolean, text?: string, error = false): void {
  busy = on;
  updateLoading(on, text, error);
}

function showNotice(message: string, error = false): void {
  let notice = document.getElementById('cadNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'cadNotice';
    notice.className = 'cad-notice';
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.classList.toggle('is-error', error);
  notice.classList.add('is-on');
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => notice?.classList.remove('is-on'), 3600);
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function displayFileInfo(name: string): void {
  const info = document.getElementById('cadFileInfo');
  if (info) info.textContent = name;
}

function setEmptyVisible(visible: boolean): void {
  const empty = document.getElementById('cadEmpty');
  if (empty) empty.hidden = !visible;
}

function resolveWasmUrl(): string {
  if (/^(data:|blob:|https?:|file:)/i.test(wasmAssetUrl)) return wasmAssetUrl;
  const base = window.desktop?.extensionBaseUrl || new URL('./', window.location.href).href;
  const relative = wasmAssetUrl.replace(/^\.?\//, '');
  return new URL(relative, base).href;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new CadImportWorker();
  worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: CadImportResult; error?: string }>) => {
    const pending = pendingWorker.get(event.data.id);
    if (!pending) return;
    pendingWorker.delete(event.data.id);
    if (event.data.ok && event.data.result) pending.resolve(event.data.result);
    else pending.reject(new Error(event.data.error || 'Worker 解析失败'));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'CAD Worker 异常');
    for (const pending of pendingWorker.values()) pending.reject(error);
    pendingWorker.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

async function parseInWorker(buffer: ArrayBuffer, name: string): Promise<CadImportResult> {
  const id = ++workerSequence;
  return await new Promise<CadImportResult>((resolve, reject) => {
    pendingWorker.set(id, { resolve, reject });
    getWorker().postMessage({ id, kind: 'occt', name, buffer, wasmUrl: resolveWasmUrl() }, [buffer]);
  });
}

function toArrayBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function parseBuffer(buffer: ArrayBuffer, name: string): Promise<CadImportResult> {
  const format = occtFormatForFile(name);
  return format
    ? await parseInWorker(buffer, name)
    : await parseStandardCadBuffer(buffer, name);
}

async function inspectPath(path: string): Promise<CadImportResult['stats']> {
  if (!window.desktop) throw new Error('桌面文件接口不可用');
  const name = fileNameFromPath(path);
  const bytes = await window.desktop.readFileBuffer(path);
  const result = await parseBuffer(toArrayBuffer(bytes), name);
  return result.stats;
}

async function loadCadBuffer(buffer: ArrayBuffer, name: string): Promise<CadImportResult> {
  if (busy) {
    throw new Error('已有文件正在解析，请稍候');
  }
  openOverlay();
  setBusy(true, `正在解析 ${name}…`);
  setEmptyVisible(false);
  try {
    const result = await parseBuffer(buffer, name);
    currentFileName = name;
    ensureViewer().load(result, name);
    ensureKinematicsUi().setSource(name, ensureViewer().getKinematicsMeshes());
    interference?.run([]);
    displayFileInfo(name);
    const partCount = document.getElementById('cadPartCount');
    if (partCount) partCount.textContent = String(result.stats.meshCount);
    setBusy(false);
    setEmptyVisible(false);
    showNotice(`${name} 已加载 · ${result.stats.triangleCount} 个三角面`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    busy = false;
    updateLoading(true, `打开失败：${message}`, true);
    setEmptyVisible(true);
    console.error('[cad] 导入失败', error);
    throw error;
  }
}

async function importBuffer(buffer: ArrayBuffer, name: string): Promise<void> {
  try {
    await loadCadBuffer(buffer, name);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function loadCadPath(path: string): Promise<CadImportResult> {
  const name = fileNameFromPath(path);
  if (!window.desktop) {
    throw new Error('当前为浏览器预览模式，请使用拖入文件或桌面版打开');
  }
  try {
    updateLoading(true, `正在读取 ${name}…`);
    const bytes = await window.desktop.readFileBuffer(path);
    return await loadCadBuffer(toArrayBuffer(bytes), name);
  } catch (error) {
    busy = false;
    updateLoading(true, `读取失败：${error instanceof Error ? error.message : String(error)}`, true);
    setEmptyVisible(true);
    throw error;
  }
}

async function importPath(path: string): Promise<void> {
  const name = fileNameFromPath(path);
  try {
    await loadCadPath(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    busy = false;
    updateLoading(true, `读取失败：${message}`, true);
    setEmptyVisible(true);
    showNotice(message, true);
  }
}

async function importDroppedFile(file: File): Promise<void> {
  const supported = /\.(step|stp|iges|igs|brep|stl|obj|gltf|glb)$/i.test(file.name);
  if (!supported) {
    showNotice(`不支持的文件类型：${file.name}`, true);
    return;
  }
  if (window.desktop) {
    try {
      const path = window.desktop.getPathForFile(file);
      if (path) {
        await importPath(path);
        return;
      }
    } catch {
      // 浏览器预览或非本地文件时退回 File.arrayBuffer。
    }
  }
  await importBuffer(await file.arrayBuffer(), file.name);
}

async function chooseAndImport(): Promise<void> {
  if (!window.desktop) {
    showNotice('桌面文件对话框不可用，请直接拖入文件。', true);
    return;
  }
  try {
    const result = await window.desktop.openCadDialog();
    if (!result.canceled && result.filePaths[0]) await importPath(result.filePaths[0]);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

async function importPack(path: string): Promise<void> {
  if (!window.desktop) {
    showNotice('浏览器预览模式不支持数据包导入。', true);
    return;
  }
  try {
    const info = await window.desktop.packs.importZip(path);
    showNotice(`数据包已导入：${info.name} · ${info.partCount} 个条目`);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function agentBridgeReady(): boolean {
  return Boolean(root && window.__AUTOMATION_CAD_EXTENSION_READY__ === true);
}

function agentBridgeUnavailable(): { ok: false; message: string } {
  return { ok: false, message: '渲染层尚未就绪' };
}

function initAgentBridge(): void {
  if (window.__AgentBridge) return;
  const bridge = {
    ready: (): boolean => agentBridgeReady(),
    getScene: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        const currentViewer = ensureViewer();
        return {
          parts: currentViewer.getSceneParts(),
          source: currentFileName || null
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    getSelection: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        return ensureViewer().getSelectionSnapshot();
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    getBom: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        return ensureViewer().getBomRows();
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    insertComponent: (part: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!part || typeof part !== 'object') return { ok: false, message: '零件参数不合法' };
      const source = part as Record<string, unknown>;
      const id = typeof source.id === 'string' ? source.id.trim() : '';
      const model = typeof source.model === 'string' ? source.model.trim() : '';
      const category = typeof source.category === 'string' ? source.category.trim() : '';
      if (!id || !model || !category) return { ok: false, message: '零件参数缺少 id/model/category' };
      try {
        const name = model || id;
        const meshIndex = ensureViewer().addPlaceholderPart(name);
        return { ok: true, meshIndex, name };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    removeComponent: (meshIndex: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (typeof meshIndex !== 'number' || !Number.isInteger(meshIndex)) {
        return { ok: false, message: 'meshIndex 必须是非负整数' };
      }
      try {
        if (!ensureViewer().removePart(meshIndex)) {
          return { ok: false, message: `零件索引不存在：${meshIndex}` };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    runInterference: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        initMechUi();
        const hits = interference?.run(ensureViewer().getModelParts()) ?? [];
        return {
          hits: hits.length,
          items: hits.map((hit) => ({
            a: hit.a,
            b: hit.b,
            volume: hit.volumeApprox,
            severity: hit.severity
          }))
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    importPath: async (path: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (typeof path !== 'string' || !path.trim()) return { ok: false, message: 'CAD 文件路径不能为空' };
      try {
        const result = await loadCadPath(path.trim());
        return {
          ok: true,
          meshCount: result.stats.meshCount,
          triangleCount: result.stats.triangleCount
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showNotice(`导入失败：${message}`, true);
        return { ok: false, message };
      }
    }
  };
  Object.defineProperty(window, '__AgentBridge', {
    value: Object.freeze(bridge),
    writable: false,
    configurable: false,
    enumerable: false
  });
}

function bindWindowEvents(): void {
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    root?.classList.add('is-drag');
  }, true);
  window.addEventListener('dragleave', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root?.classList.remove('is-drag');
  }, true);
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    root?.classList.remove('is-drag');
    const file = event.dataTransfer?.files[0];
    if (file) void importDroppedFile(file);
  }, true);

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      event.stopPropagation();
      if (!overlayOpen) openOverlay();
      toggleExportMenu(true);
      return;
    }
    if (event.key === 'Escape' && overlayOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.cad-export-wrap')) toggleExportMenu(false);
  });

  window.desktop?.onOpenCad((payload) => {
    void importPath(payload.path);
  });
  window.desktop?.onImportPack((payload) => {
    void importPack(payload.path);
  });
  window.desktop?.onSetDomain((domain) => {
    window.ElecDomain?.setDomain(domain);
  });
  window.desktop?.parametric.onStatus((state) => {
    setParametricStatus(state);
  });
}

function init(): void {
  injectStyles();
  buildEntryButton();
  initFactoryPanel();
  commission = initCommissionPanel({
    onExportReport: async () => {
      await exportPdfReport();
    }
  });
  initPackPanel();
  initElecLibraryPanel();
  initElecCheckPanel();
  initEnclosureUi();
  initSyncPanel({ buildPayload: buildSyncPayload });
  initAgentPanel();
  buildOverlay();
  initMechUi();
  injectStressTab();
  bindWindowEvents();
  Object.defineProperty(window, 'AutomationCadKinematics', {
    value: Object.freeze({
      open: (): void => {
        if (!overlayOpen) openOverlay();
        ensureKinematicsUi().open();
      },
      close: (): void => ensureKinematicsUi().close(),
      state: () => ensureKinematicsUi().state(),
      addMovingPart: (meshIds: readonly number[], name?: string): string => ensureKinematicsUi().addMovingPart(meshIds, name),
      updatePart: (id: string, patch: Parameters<KinematicsUiHandle['updatePart']>[1]): void =>
        ensureKinematicsUi().updatePart(id, patch),
      slide: (id: string, percent: number) => ensureKinematicsUi().slide(id, percent),
      save: (): boolean => ensureKinematicsUi().save(),
      getAnnotation: () => ensureKinematicsUi().getAnnotation(),
      getValidation: () => ensureKinematicsUi().getValidation()
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  window.AutomationCadViewer = {
    open: openOverlay,
    close: closeOverlay,
    importPath,
    inspectPath,
    runInterference: (parts?: InterferencePart[]): InterferenceHit[] => {
      initMechUi();
      return interference?.run(parts) ?? [];
    },
    exportMesh: async (format: 'glb' | 'obj') => {
      if (format !== 'glb' && format !== 'obj') throw new Error(`不支持的网格格式：${String(format)}`);
      return await exportData(format);
    },
    exportData,
    exportReportPdf: exportPdfReport
  };
  Object.defineProperty(window, '__Parametric', {
    value: Object.freeze({
      status: async (): Promise<ParametricStateView> => {
        const api = window.desktop?.parametric;
        if (!api) return { status: 'unavailable', message: '参数化建模仅桌面端可用' };
        return await api.status();
      },
      build: async (doc: unknown) => {
        const api = window.desktop?.parametric;
        if (!api) {
          return { ok: false, code: 'UNAVAILABLE' as const, message: '参数化建模仅桌面端可用' };
        }
        return await api.build(doc);
      }
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  initAgentBridge();
  window.__AUTOMATION_CAD_EXTENSION_READY__ = true;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
