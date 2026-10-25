import cadStyles from './cad.css?inline';
import CadImportWorker from './cad/importer.worker?worker&inline';
import wasmAssetUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { occtFormatForFile, parseOcctBuffer } from './cad/step';
import { parseStandardCadBuffer, parseStandardCadBuffers } from './cad/loaders';
import { CadViewer } from './cad/viewer';
import { describeSuggestions } from './cad/kinematics-auto';
import {
  initKinematicsUi,
  pointOptionsFromMachineConfig,
  serializeAnnotation,
  type KinematicsUiHandle
} from './cad/kinematics-ui';
import { initParametricUi, type ParametricUiHandle } from './parametric/ui';
import { serializeDoc } from './parametric/model';
import type { CadImportResult } from './shared/types';
import { initFactoryPanel } from './factory/ui';
import { initPackPanel } from './packs/ui';
import { initElecLibraryPanel } from './packs/elec-ui';
import {
  closeEnclosure,
  enclosureState,
  initEnclosureUi,
  isEnclosureOpen,
  placePartInEnclosure,
  removeEnclosurePart,
  restoreEnclosurePlacement,
  updateEnclosurePlacement
} from './enclosure/canvas';
import { initElecCheckPanel } from './elec/ui';
import { initCostPanel } from './cost/ui';
import type { PlcGenUiHandle } from './plcgen/ui';
import { createModuleManager, type KeyValueStorage, type ModuleStatus } from './modules/registry';
import {
  PARAMETRIC_MODULE_DISABLED_MESSAGE,
  parametricModuleDisabledBuildResult
} from './modules/parametric-gate';
import { initModuleSettingsUi } from './modules/ui';
import { initUpdatePanel } from './update/ui';
import { initCommissionPanel, type CommissionPanelHandle } from './commission/ui';
import type { MachineConfig } from './commission/machine-config';
import { buildOptionalSyncPlcPayload } from './sync/plc.ts';
import { initSyncPanel } from './sync/ui';
import { initAgentPanel, setAgentResumeModuleEnabled } from './agent/ui';
import { applyAppearance } from './ui/appearance.ts';
import { bomSignatureFromRows } from './agent/advisor';
import type { SyncUploadPayload } from './sync/types';
import type { InterferenceHit, InterferencePart } from './mech/interference';
import { initInterferencePanel, type InterferencePanelHandle } from './mech/interference-ui';
import { initStressPanel, type StressConclusion } from './mech/ui';
import { toCsv, toXlsx, type BomRow } from './export/bom';
import { toDxf, type DxfShape } from './export/dxf';
import { toMeshBlob } from './export/mesh';
import { renderReportHtml } from './export/report';
import { initOrbitView } from './orbit/ui';
import { initAssemblyUi, assemblyStyles } from './assembly/ui';
import { initDrawingUi, drawingStyles, type DrawingHandle } from './cad/drawing';
import { protectionRows, selectMotorProtection } from './elec/protection';
import { buildMachineCircuit } from './elec/machine-circuit';
import { renderSheet } from './elec/sheet';
import { estimateConveyorDrive } from './machine/conveyor-synth';
import {
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  MATERIAL_LABEL,
  type ConveyorParams
} from './machine/conveyor-assembly';
import {
  MODEL_BUILDERS,
  pickModelBuilder,
  normalizeModelParams,
  toConveyorParams,
  RULES_ONLY_PROCESSES
} from './machine/model-builders';
import { buildEntryButton as buildPanelEntryButton, createDrawer } from './ui/panels';
import { assertCadFileSize } from './shared/input-limits';
import { recordDiagnosticError, setDiagnosticOperation } from './shared/diagnostics';
import { identifyCadModelObjects, type CadModelObjectIdentity, type CadProjectIdentity } from './project-archive/identity';
import { cadImportFailureView, parseCadImportTransaction } from './cad/import-transaction';

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
let plcSyncModulesEnabled = (): { plcgen: boolean; plcSync: boolean } => ({ plcgen: false, plcSync: false });
let parametricImportModuleEnabled = false;
let parametricHistoryModuleEnabled = false;
let projectPortableModuleEnabled = false;
let root: HTMLElement | null = null;
let overlayOpen = false;
let busy = false;
let dragDepth = 0;
let noticeTimer = 0;
let worker: Worker | null = null;
let workerSequence = 0;
let currentFileName = '';
let currentProjectIdentity: CadProjectIdentity | null = null;
let currentProjectStorageKey = `session:${Date.now()}:${Math.random().toString(36).slice(2)}`;
let currentModelObjectIdentities: CadModelObjectIdentity[] = [];
let stressConclusions: StressConclusion[] = [];
let interference: InterferencePanelHandle | null = null;
let commission: CommissionPanelHandle | null = null;
let kinematics: KinematicsUiHandle | null = null;
let parametric: ParametricUiHandle | null = null;
let plcGenUi: PlcGenUiHandle | null = null;
let plcGenUiLoad: Promise<PlcGenUiHandle> | null = null;
let mechUiReady = false;
let stressTabObserver: MutationObserver | null = null;
type ExportFormat = 'pdf' | 'dxf' | 'glb' | 'obj' | 'csv' | 'xlsx';
const pendingWorker = new Map<number, { resolve(result: CadImportResult): void; reject(error: Error): void }>();
type RemovedComponentSnapshot =
  | { location: 'plate'; placement: import('./enclosure/layout').Placement }
  | { location: 'bom'; snapshot: NonNullable<ReturnType<CadViewer['detachPart']>> };
const removedComponentSnapshots = new Map<string, RemovedComponentSnapshot>();
let removedComponentSequence = 0;
let lastPlcGeneratedAt = '';

function activatePlcGenUi(manager: ReturnType<typeof createModuleManager>): Promise<PlcGenUiHandle> {
  if (plcGenUi) {
    plcGenUi.setEnabled(manager.getStatus('plcgen').enabled);
    return Promise.resolve(plcGenUi);
  }
  if (!plcGenUiLoad) {
    plcGenUiLoad = import('./plcgen/ui').then(({ initPlcGenUi }) => {
      plcGenUi = initPlcGenUi({
        getConfig: () => commission?.getMachineConfig() ?? null,
        enabled: manager.getStatus('plcgen').enabled
      });
      return plcGenUi;
    }).catch((error: unknown) => {
      plcGenUiLoad = null;
      throw error;
    });
  }
  return plcGenUiLoad.then((handle) => {
    handle.setEnabled(manager.getStatus('plcgen').enabled);
    return handle;
  });
}

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
        <span class="cad-domain-sw" role="group" aria-label="设计域切换">
          <button type="button" class="cad-domain-btn is-active" data-cad-domain="mech" title="机械域">机械</button>
          <button type="button" class="cad-domain-btn" data-cad-domain="elec" title="电气域：切回工作台的电气侧，当前工程作为上下文">电气</button>
        </span>
        <button type="button" class="cad-btn" data-cad-action="fit">${ICONS.fit}<span>缩放到适合</span></button>
        <button type="button" class="cad-btn" data-cad-action="wire">${ICONS.wire}<span>线框</span></button>
        <button type="button" class="cad-btn" data-cad-action="kinematics" id="cadKinematicsToggle">${ICONS.kinematics}<span>运动学</span></button>
        <button type="button" class="cad-btn" data-cad-action="parametric" id="cadParametricToggle"${parametricImportModuleEnabled ? '' : ' hidden'}>${ICONS.parametric}<span>参数化</span></button>
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
            <span class="cad-export-sep" data-project-archive-entry${projectPortableModuleEnabled && window.desktop?.projectArchive ? '' : ' hidden'}></span>
            <button type="button" data-project-archive="export-cad" data-project-archive-entry${projectPortableModuleEnabled && window.desktop?.projectArchive ? '' : ' hidden'}><span>导出可支持工程状态</span><em>.acproj</em></button>
            <button type="button" data-project-archive="preview" data-project-archive-entry${projectPortableModuleEnabled && window.desktop?.projectArchive ? '' : ' hidden'}><span>校验/预览工程档案</span><em>只读</em></button>
          </div>
        </div>
        <button type="button" class="cad-btn" data-cad-action="close">${ICONS.close}<span>关闭</span></button>
      </div>
      <div class="cad-spacer"></div>
      <div class="cad-file-wrap">
        <div class="cad-file-info" id="cadFileInfo">未打开文件</div>
        <button type="button" class="cad-file-caret" data-project-menu-toggle aria-haspopup="listbox" aria-expanded="false" title="工程列表">▾</button>
        <div class="cad-project-menu" id="cadProjectMenu" role="listbox" hidden></div>
      </div>
    </header>
    <main class="cad-main">
      <aside class="cad-sidebar">
        <div class="cad-side-tabs" role="tablist" aria-label="CAD 侧栏">
          <button type="button" class="cad-side-tab is-active" data-cad-side="parts" role="tab" aria-selected="true">零件</button>
          <button type="button" class="cad-side-tab" data-cad-side="bom" role="tab" aria-selected="false">BOM</button>
          <button type="button" class="cad-side-tab" data-cad-side="io" role="tab" aria-selected="false">IO 点位</button>
          <button type="button" class="cad-side-tab" data-cad-side="stress" role="tab" aria-selected="false">受力</button>
        </div>
        <div class="cad-side-pane" id="cadPartsPane">
          <div class="cad-side-head"><span>零件列表</span><b id="cadPartCount">0</b></div>
          <div class="cad-parts" id="cadParts">
            <div class="cad-parts-empty">打开或拖入 STEP / IGES / BREP / STL / OBJ / GLTF / GLB / DXF / DWG 文件</div>
          </div>
          <div class="cad-detail" id="cadDetail">
            <div class="cad-detail-empty">单击零件查看包围盒与尺寸</div>
          </div>
        </div>
        <div class="cad-side-pane" id="cadBomPane" hidden>
          <div class="cad-side-head"><span>机型 BOM</span><b id="cadBomCount">0</b></div>
          <div class="cad-machine-table" id="cadBomRows">
            <div class="cad-parts-empty">应用机型方案后显示真实型号 BOM</div>
          </div>
        </div>
        <div class="cad-side-pane" id="cadIoPane" hidden>
          <div class="cad-side-head"><span>PLC IO 点位</span><b id="cadIoCount">0</b></div>
          <div class="cad-machine-note" id="cadIoMeta">应用机型方案后读取 io-map</div>
          <div class="cad-machine-table" id="cadIoRows">
            <div class="cad-parts-empty">尚无机型点位</div>
          </div>
        </div>
        <div class="cad-side-pane" id="cadStressPane" hidden></div>
      </aside>
      <section class="cad-viewport">
        <div class="cad-host" id="cadHost"></div>
        <div class="cad-empty" id="cadEmpty">
          <div class="cad-empty-ico">${ICONS.cube}</div>
          <div class="cad-empty-title">把 CAD 文件拖到窗口任意位置</div>
          <div class="cad-empty-sub">STEP / IGES / BREP 由 OCCT WASM 在 Worker 中解析<br>STL / OBJ / GLTF / GLB 使用 three.js 异步加载<br>DXF 直接读线段；DWG 需本机转换器（见 dmaged 提示）</div>
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
      <aside class="cad-parametric-drawer" id="cadParametricDrawer" hidden></aside>
    </main>
    <dialog id="cadProjectArchivePreview" class="cad-project-archive-dialog" aria-labelledby="cadProjectArchivePreviewTitle">
      <div class="cad-project-archive-dialog-head">
        <div><h2 id="cadProjectArchivePreviewTitle">工程档案只读预览</h2><p>内容已通过结构、依赖与 SHA-256 校验；本操作不会应用或覆盖当前工程。</p></div>
        <button type="button" class="cad-project-archive-close" data-project-archive-close aria-label="关闭预览">×</button>
      </div>
      <pre id="cadProjectArchivePreviewBody"></pre>
    </dialog>
    <footer class="cad-footer">
      <span id="cadStats">就绪 · <strong>0</strong> 个零件</span>
      <span class="cad-footer-flex"></span>
      <span class="cad-unit-note">单位按源文件 mm 解释 · 未做隐式缩放</span>
    </footer>`;
  document.body.appendChild(root);

  root.addEventListener('click', (event) => {
    event.stopPropagation();
    if ((event.target as HTMLElement).closest('[data-project-archive-close]')) {
      const preview = document.getElementById('cadProjectArchivePreview') as HTMLDialogElement | null;
      preview?.close();
      return;
    }
    const domainBtn = (event.target as HTMLElement).closest<HTMLElement>('[data-cad-domain]');
    if (domainBtn) {
      if (domainBtn.dataset.cadDomain === 'elec') {
        // 覆盖层是全屏的，电气的入口在外壳顶栏；这里把人送回去并带上当前工程上下文
        const project = lastOpenedProject;
        try {
          if (project) {
            const sheet = buildElecSheet(project);
            (window as unknown as { ElecDomain?: { setSchematic?: (payload: unknown) => boolean } }).ElecDomain?.setSchematic?.({
              svg: sheet.svg,
              meta: { project: project.name, drawingNo: 'EL-CV-001', generated: true, devices: [] }
            });
            if (!sheet.deliverable) {
              const errors = sheet.issues.filter((issue) => issue.severity === 'error');
              showNotice(`电气图已生成，但校验有 ${errors.length} 项问题：${errors[0]?.message ?? ''}`, true);
            }
          }
        } catch (error) {
          console.warn('[cad] 生成电气图失败', error);
        }
        closeOverlay();
        try {
          (window as unknown as { ElecDomain?: { setDomain?: (domain: string) => void } }).ElecDomain?.setDomain?.('elec');
        } catch (error) {
          console.warn('[cad] 切换到电气域失败', error);
        }
        window.dispatchEvent(new CustomEvent('automation-cad-domain', { detail: { domain: 'elec', project } }));
      }
      return;
    }
    const projectToggle = (event.target as HTMLElement).closest<HTMLElement>('[data-project-menu-toggle]');
    if (projectToggle) {
      toggleProjectMenu();
      return;
    }
    const projectDelete = (event.target as HTMLElement).closest<HTMLElement>('[data-project-delete]');
    if (projectDelete) {
      event.preventDefault();
      const id = projectDelete.dataset.projectDelete ?? '';
      if (id && window.desktop?.projects) {
        void window.desktop.projects.remove(id).then((removed) => {
          if (!removed.ok) showNotice(removed.message ?? '删除失败', true);
          return refreshProjectMenu();
        });
      }
      return;
    }
    const projectOpen = (event.target as HTMLElement).closest<HTMLElement>('[data-project-open]');
    if (projectOpen) {
      const id = projectOpen.dataset.projectOpen ?? '';
      if (id) void openSavedProject(id);
      return;
    }
    if (!(event.target as HTMLElement).closest('.cad-file-wrap')) toggleProjectMenu(false);
    const archiveAction = (event.target as HTMLElement).closest<HTMLElement>('[data-project-archive]');
    if (archiveAction) {
      toggleExportMenu(false);
      if (archiveAction.dataset.projectArchive === 'export-cad') void exportPortableProjectArchive();
      else if (archiveAction.dataset.projectArchive === 'preview') void chooseAndPreviewPortableArchive();
      return;
    }
    const sideTab = (event.target as HTMLElement).closest<HTMLElement>('[data-cad-side]');
    if (sideTab) {
      const value = sideTab.dataset.cadSide;
      const pane = value === 'stress' || value === 'bom' || value === 'io' ? value : 'parts';
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
      else {
        parametric?.close();
        handle.open();
      }
    } else if (action === 'parametric') {
      if (!parametricImportModuleEnabled) {
        showNotice(PARAMETRIC_MODULE_DISABLED_MESSAGE, true);
        return;
      }
      const handle = ensureParametricUi();
      if (handle.isOpen()) handle.close();
      else {
        kinematics?.close();
        handle.open();
      }
    } else if (action === 'export-menu') {
      toggleExportMenu();
    } else if (action === 'close') closeOverlay();
  });
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
}

function activateSidePane(pane: 'parts' | 'bom' | 'io' | 'stress'): void {
  const partsPane = document.getElementById('cadPartsPane');
  const bomPane = document.getElementById('cadBomPane');
  const ioPane = document.getElementById('cadIoPane');
  const stressPane = document.getElementById('cadStressPane');
  if (partsPane) partsPane.hidden = pane !== 'parts';
  if (bomPane) bomPane.hidden = pane !== 'bom';
  if (ioPane) ioPane.hidden = pane !== 'io';
  if (stressPane) stressPane.hidden = pane !== 'stress';
  root?.querySelectorAll<HTMLElement>('[data-cad-side]').forEach((button) => {
    const active = button.dataset.cadSide === pane;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (pane === 'bom') renderMachineBomPane();
  if (pane === 'io') void loadMachineIoPane();
}

function renderMachineBomPane(): void {
  const host = document.getElementById('cadBomRows');
  const count = document.getElementById('cadBomCount');
  if (!host) return;
  const rows = viewer?.getBomRows() ?? [];
  if (count) count.textContent = String(rows.length);
  if (rows.length === 0) {
    host.innerHTML = '<div class="cad-parts-empty">应用机型方案后显示真实型号 BOM</div>';
    return;
  }
  host.innerHTML = `<table class="cad-machine-table-el cad-bom-table">
      <thead><tr><th>#</th><th>名称 / 型号</th><th>数量</th><th>来源</th></tr></thead>
      <tbody>${rows.map((row) => {
        const source = row.source === 'machine-design'
          ? (row.note?.match(/来源包：([^\s·]+)/)?.[1] ?? 'machine-design')
          : 'CAD';
        return `<tr data-bom-row="${row.no}">
          <td class="cad-machine-no">${String(row.no).padStart(2, '0')}</td>
          <td class="cad-machine-main"><b>${escapeCadHtml(row.name)}</b><span>${escapeCadHtml(row.spec)}</span>${row.note ? `<em>${escapeCadHtml(row.note)}</em>` : ''}</td>
          <td class="cad-machine-qty">${escapeCadHtml(String(row.qty))}</td>
          <td class="cad-machine-source">${escapeCadHtml(source)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

async function loadMachineIoPane(): Promise<void> {
  const host = document.getElementById('cadIoRows');
  const count = document.getElementById('cadIoCount');
  const meta = document.getElementById('cadIoMeta');
  if (!host) return;
  if (!window.desktop?.machine?.ioMap) {
    host.innerHTML = '<div class="cad-parts-empty">IO 点位仅在桌面版可用</div>';
    return;
  }
  host.innerHTML = '<div class="cad-parts-empty">正在读取机型点位…</div>';
  try {
    const result = await window.desktop.machine.ioMap() as {
      ok?: boolean;
      message?: string;
      rows?: Array<Record<string, unknown>>;
      machine?: { name?: string; stations?: number; actuators?: number; sensors?: number };
    };
    if (!result?.ok) {
      if (count) count.textContent = '0';
      if (meta) meta.textContent = result?.message ?? '尚无机型点位';
      host.innerHTML = `<div class="cad-parts-empty">${escapeCadHtml(result?.message ?? '尚无机型点位')}</div>`;
      return;
    }
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (count) count.textContent = String(rows.length);
    if (meta) {
      const machine = result.machine ?? {};
      meta.textContent = `${machine.name ?? '机型方案'} · ${machine.stations ?? 0} 工位 / ${machine.actuators ?? 0} 执行机构 / ${machine.sensors ?? 0} 传感器 · io-map.csv 同源`;
    }
    host.innerHTML = `<table class="cad-machine-table-el cad-io-table">
        <thead><tr><th>点位</th><th>方向</th><th>归属 / 类型</th><th>地址</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td class="cad-machine-point">${escapeCadHtml(String(row.point ?? ''))}</td>
          <td class="cad-machine-dir" data-dir="${escapeCadHtml(String(row.direction ?? ''))}">${escapeCadHtml(String(row.direction ?? ''))}</td>
          <td class="cad-machine-main"><b>${escapeCadHtml(String(row.owner ?? ''))}</b><span>${escapeCadHtml(String(row.type ?? ''))}</span><em>${escapeCadHtml(String(row.station ?? ''))}</em></td>
          <td class="cad-machine-address">${escapeCadHtml(String(row.address ?? ''))}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (meta) meta.textContent = message;
    host.innerHTML = `<div class="cad-parts-empty">${escapeCadHtml(message)}</div>`;
  }
}

function escapeCadHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    };
    return entities[character] ?? character;
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
  const rows = viewer?.getBomRows() ?? [];
  return rows.map((row, index) => ({
    index: index + 1,
    name: row.name,
    model: row.spec,
    quantity: row.qty,
    material: row.mat,
    note: row.note ?? (row.source === 'machine-design'
      ? `来源：machine-design；分类：${row.category ?? '未分类'}`
      : '来自当前 CAD 模型')
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
  const modules = plcSyncModulesEnabled();
  const plc = buildOptionalSyncPlcPayload(
    commission?.getMachineConfig() ?? null,
    modules.plcgen,
    modules.plcSync
  );
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
    }),
    ...(plc ? { plc } : {})
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
    getGeometry: () => ensureViewer().getKinematicsGeometry(),
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

function ensureParametricUi(): ParametricUiHandle {
  if (parametric) return parametric;
  const container = requiredElement('cadParametricDrawer');
  parametric = initParametricUi({
    container,
    viewer: ensureViewer(),
    getSourceFile: () => currentFileName,
    getProjectId: () => currentProjectIdentity?.projectId ?? '',
    getProjectStorageKey: () => currentProjectStorageKey,
    loadStl: async (filePath: string): Promise<CadImportResult> => {
      if (!window.desktop) throw new Error('桌面文件接口不可用');
      const bytes = await window.desktop.readFileBuffer(filePath);
      return await parseBuffer(toArrayBuffer(bytes), 'parametric.stl');
    },
    isEnabled: () => parametricImportModuleEnabled,
    isHistoryEnabled: () => parametricHistoryModuleEnabled,
    notify: showNotice,
    onOpenChange: (open) => {
      document.getElementById('cadParametricToggle')?.classList.toggle('is-active', open);
    }
  });
  return parametric;
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

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`CAD UI 节点不存在：${id}`);
  return element;
}

function openOverlay(): void {
  closeEnclosure();
  buildOverlay();
  if (!root) return;
  overlayOpen = true;
  root.hidden = false;
  initMechUi();
  // 顶栏工程列表：打开覆盖层时预热，点 ▾ 立刻有内容
  void refreshProjectMenu();
  ensureViewer().setActive(true);
  if (parametric?.isOpen()) kinematics?.close();
  else ensureKinematicsUi().open();
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


/** 工程库条目（与主进程 electron/projects.ts 的 ProjectRecord 对齐） */
interface ProjectMenuRecord {
  id: string;
  name: string;
  parts: number;
  massKg: number | null;
  envelope: [number, number, number] | null;
  createdAt: string;
  /** 零件清单（外壳结构树用） */
  partsList?: Array<{ file: string; name: string }>;
  /** 机型参数（生成电气图用） */
  params?: Record<string, number>;
}

/**
 * 工程库（顶栏文件名右侧 ▾）：列出已保存的整机工程，点击重新装配。
 * 数据源是主进程 userData/projects（每个工程一个目录：project.json + STEP/STL + 逐件 STL）。
 */
async function refreshProjectMenu(): Promise<void> {
  const menu = document.getElementById('cadProjectMenu');
  const toggle = document.querySelector<HTMLElement>('[data-project-menu-toggle]');
  if (!menu) return;
  if (!window.desktop?.projects) {
    if (toggle) toggle.hidden = true;
    return;
  }
  let records: ProjectMenuRecord[] = [];
  try {
    records = await window.desktop.projects.list();
  } catch (error) {
    console.warn('[projects] 读取工程列表失败', error);
  }
  if (records.length === 0) {
    menu.innerHTML = '<div class="cad-project-empty">还没有保存的工程 · 用智能体 build_machine_model 生成，或导出 .acproj</div>';
    return;
  }
  menu.innerHTML = records
    .map((record) => {
      const meta = [
        `${record.parts} 件`,
        record.massKg !== null ? `${record.massKg} kg` : null,
        record.envelope ? `${Math.round(record.envelope[0])}×${Math.round(record.envelope[1])}×${Math.round(record.envelope[2])}` : null,
        formatProjectTime(record.createdAt)
      ]
        .filter(Boolean)
        .join(' · ');
      // 用 div+role 而不是 button：里面还要放删除按钮，嵌套 button 会被解析器拆开
      return `<div class="cad-project-item" data-project-open="${escapeCadHtml(record.id)}" role="option" tabindex="0">
        <span class="cad-project-name">${escapeCadHtml(record.name)}</span>
        <span class="cad-project-meta">${escapeCadHtml(meta)}</span>
        <button type="button" class="cad-project-del" data-project-delete="${escapeCadHtml(record.id)}" title="删除该工程">×</button>
      </div>`;
    })
    .join('');
}

function formatProjectTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toggleProjectMenu(open?: boolean): void {
  const menu = document.getElementById('cadProjectMenu');
  const toggle = document.querySelector<HTMLElement>('[data-project-menu-toggle]');
  if (!menu) return;
  const next = open ?? menu.hidden;
  menu.hidden = !next;
  if (toggle) toggle.setAttribute('aria-expanded', String(next));
  if (next) void refreshProjectMenu();
}

/** 打开已保存的工程：逐件 STL 重新装配成零件树，不是单个合并网格。 */
/**
 * 由工程生成电气原理图数据。
 * 驱动功率来自 conveyor-synth 的真实阻力/功率估算（不是拍脑袋），
 * 传感器来自零件清单里的光电支架，IO 由 schematic.ts 统一排布。
 */
/**
 * 工程 → 电路 → ERC → 版面 → SVG，全在 elec 引擎里完成。
 * 这里只负责把工程参数翻译成机型描述，不画任何一条线。
 */
function buildElecSheet(project: ProjectMenuRecord): { svg: string; deliverable: boolean; issues: Array<{ severity: string; code: string; message: string }> } {
  const params = {
    lengthMm: Number(project.params?.lengthMm ?? 2000),
    widthMm: Number(project.params?.widthMm ?? 300),
    beltHeightMm: Number(project.params?.beltHeightMm ?? 850),
    pulleyDiameterMm: Number(project.params?.pulleyDiameterMm ?? 50),
    beltThicknessMm: Number(project.params?.beltThicknessMm ?? 4),
    frameSectionMm: Number(project.params?.frameSectionMm ?? 40)
  };
  let powerKw = 0.04;
  try {
    const drive = estimateConveyorDrive(params, {});
    powerKw = Math.max(0.04, Math.round((drive.motorW / 1000) * 100) / 100);
  } catch (error) {
    console.warn('[elec] 驱动估算失败，回退 0.04 kW', error);
  }
  const pulleyRadiusM = Math.max(0.01, params.pulleyDiameterMm / 2 / 1000);
  const rpm = Math.max(1, Math.round((60 * 0.2) / (2 * Math.PI * pulleyRadiusM)));
  const ratio = Math.max(1, Math.round((1400 / rpm) * 10) / 10);
  const protection = selectMotorProtection(powerKw);

  const names = (project.partsList ?? []).map((item) => item.name);
  const sensors: Array<{ tag: string; label: string; address: string }> = [];
  if (names.some((name) => name.includes('进料'))) sensors.push({ tag: '-PE1', label: '进料检测', address: 'I0.3' });
  if (names.some((name) => name.includes('出料'))) sensors.push({ tag: '-PE2', label: '出料检测', address: 'I0.4' });
  if (sensors.length === 0) sensors.push({ tag: '-PE1', label: '工件到位', address: 'I0.3' });

  const circuit = buildMachineCircuit({
    project: project.name,
    drive: { powerKw, rpm, ratio },
    sensors,
    controls: { estop: true, startStop: true, lamp: true },
    selection: {
      breaker: protection.breaker,
      contactor: protection.contactor,
      thermal: protection.thermal,
      currentA: protection.currentA,
      thermalSetA: protection.thermalSetA
    },
    drawingNo: 'EL-CV-001'
  });
  const sheet = renderSheet(circuit, {
    project: project.name,
    drawingNo: 'EL-CV-001',
    page: '1 / 1',
    date: new Date().toISOString().slice(0, 10),
    notes: [
      `线体 ${Math.round(params.lengthMm)}×${Math.round(params.widthMm)} mm · 皮带面高 ${Math.round(params.beltHeightMm)} mm`,
      `零件 ${project.parts} 件 · 总质量 ${project.massKg ?? '—'} kg`
    ]
  });
  return {
    svg: sheet.svg,
    deliverable: sheet.deliverable,
    // 图面自检（断线/压字/漏画/明细表不一致）与 ERC 同等对待：任何一项都会让 deliverable=false
    issues: [
      ...sheet.issues.map((issue) => ({ severity: issue.severity, code: issue.code, message: issue.message })),
      ...sheet.problems.map((problem) => {
        const code = /^\[([A-Z_]+)\]/.exec(problem)?.[1] ?? 'LAYOUT';
        return { severity: 'error', code, message: problem.replace(/^\[[A-Z_]+\]\s*/, '') };
      })
    ]
  };
}

/** 最近打开的工程：外壳冷启动时恢复卡片用 */
let lastOpenedProject: ProjectMenuRecord | null = null;

async function openSavedProject(id: string): Promise<ProjectMenuRecord | null> {
  if (!window.desktop?.projects) return null;
  const result = await window.desktop.projects.open(id);
  if (!result.ok || !result.record) {
    showNotice(result.message ?? '打开工程失败', true);
    return null;
  }
  const items = result.partPaths ?? [];
  if (items.length === 0) {
    showNotice('工程里没有零件网格，可能只保存了 STEP', true);
    return null;
  }
  try {
    const buffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
    for (const item of items) {
      const bytes = await window.desktop.readFileBuffer(item.path);
      buffers.push({ buffer: toArrayBuffer(bytes), name: item.name });
    }
    const merged = await parseStandardCadBuffers(buffers, 'STL');
    const label = `${result.record.name}（${merged.meshes.length} 件）`;
    openOverlay();
    ensureViewer().load(merged, label);
    currentFileName = label;
    displayFileInfo(label);
    const partCount = document.getElementById('cadPartCount');
    if (partCount) partCount.textContent = String(merged.stats.meshCount);
    try {
      interference?.run([]);
    } catch (error) {
      console.warn('[projects] 干涉检查初始化失败', error);
    }
    setEmptyVisible(false);
    toggleProjectMenu(false);
    showNotice(`${label} 已载入 · ${merged.stats.triangleCount} 个三角面`, false);
    lastOpenedProject = {
      id: result.record.id,
      name: result.record.name,
      parts: merged.meshes.length,
      massKg: result.record.massKg,
      envelope: result.record.envelope,
      createdAt: result.record.createdAt,
      partsList: (result.record.partsList ?? []).map((item: { file: string; name: string }) => ({ file: item.file, name: item.name })),
      params: result.record.params ?? {}
    };
    return lastOpenedProject;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
    return null;
  }
}

/** 把生成结果存成工程目录（同名覆盖），让它出现在下拉里、下次能直接打开。 */
async function saveProjectToLibrary(input: {
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: number | null;
  envelope: [number, number, number] | null;
  material: string[];
  stepPath: string | null;
  stlPath: string | null;
  partPaths: Array<{ name: string; path: string }>;
}): Promise<{ ok: boolean; message?: string }> {
  if (!window.desktop?.projects) return { ok: false, message: '工程库接口不可用' };
  try {
    const saved = await window.desktop.projects.save(input);
    await refreshProjectMenu();
    return { ok: saved.ok, ...(saved.message ? { message: saved.message } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function setEmptyVisible(visible: boolean): void {
  const empty = document.getElementById('cadEmpty');
  if (empty) empty.hidden = !visible;
}
function showCadImportFailure(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const view = cadImportFailureView(Boolean(currentFileName));
  busy = false;
  updateLoading(view.loadingErrorVisible, `${prefix}：${message}`, true);
  setEmptyVisible(view.emptyStateVisible);
}
function resolveWasmUrl(): string {
  if (/^(data:|blob:|https?:|file:)/i.test(wasmAssetUrl)) return wasmAssetUrl;
  const base = window.desktop?.extensionBaseUrl || new URL('./', window.location.href).href;
  const relative = wasmAssetUrl.replace(/^\.?\//, '');
  return new URL(relative, base).href;
}

function disposeCadWorker(reason = 'shutdown'): void {
  const error = new Error(`CAD 解析已取消：${reason}`);
  for (const pending of pendingWorker.values()) pending.reject(error);
  pendingWorker.clear();
  worker?.terminate();
  worker = null;
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
    recordDiagnosticError('CAD_WORKER_ERROR', error, { event: event.message ?? '' });
    disposeCadWorker('worker-error');
  };
  return worker;
}

async function parseInWorker(buffer: ArrayBuffer, name: string): Promise<CadImportResult> {
  const id = ++workerSequence;
  setDiagnosticOperation('cad:parse-worker');
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
  assertCadFileSize(name, buffer.byteLength);
  if (busy) {
    throw new Error('已有文件正在解析，请稍候');
  }
  openOverlay();
  setBusy(true, `正在解析 ${name}…`);
  setEmptyVisible(false);
  try {
    let nextModelObjectIdentities: CadModelObjectIdentity[] = [];
    const transaction = await parseCadImportTransaction({
      sourceName: name,
      sourceBytes: new Uint8Array(buffer),
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value)
      },
      parse: () => parseBuffer(buffer, name),
      apply: async (result, candidateIdentity) => {
        if (candidateIdentity) {
          try {
            nextModelObjectIdentities = await identifyCadModelObjects(candidateIdentity.projectId, candidateIdentity.sourceSha256, result.meshes);
          } catch (identityError) {
            console.warn('[project-identity] CAD 网格无法建立稳定对象映射；运动学跨导入恢复将保持关闭', identityError);
          }
        }
        ensureViewer().load(result, name);
      },
      onIdentityError: (identityError) => {
        console.warn('[project-identity] 无法建立持久工程身份；本次使用临时隔离状态桶', identityError);
      }
    });
    const result = transaction.result;
    const nextIdentity = transaction.identity;
    const nextStorageKey = nextIdentity?.projectId ?? `session:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (nextIdentity) {
      result.meshes.forEach((mesh, index) => {
        const objectId = nextModelObjectIdentities[index]?.objectId;
        if (objectId) mesh.stableObjectId = objectId;
      });
    } else {
      nextModelObjectIdentities = [];
    }
    currentFileName = name;
    currentProjectIdentity = nextIdentity;
    currentProjectStorageKey = nextStorageKey;
    currentModelObjectIdentities = nextModelObjectIdentities;
    refreshProjectArchiveControls();
    const kinematicsMeshes = ensureViewer().getKinematicsMeshes();
    ensureKinematicsUi().setSource(name, kinematicsMeshes, nextIdentity?.projectId, nextStorageKey);
    parametric?.setSource(name, nextIdentity?.projectId, nextStorageKey);
    interference?.run([]);
    displayFileInfo(name);
    const partCount = document.getElementById('cadPartCount');
    if (partCount) partCount.textContent = String(result.stats.meshCount);
    setBusy(false);
    setEmptyVisible(false);
    showNotice(nextIdentity
      ? `${name} 已加载 · ${result.stats.triangleCount} 个三角面 · 工程 ${nextIdentity.projectId}`
      : `${name} 已加载 · ${result.stats.triangleCount} 个三角面 · 未能建立持久身份，旧状态未恢复`, !nextIdentity);
    return result;
  } catch (error) {
    showCadImportFailure('打开失败', error);
    console.error('[cad] 导入失败', error);
    throw error;
  }
}

/** 图纸（DXF/DWG）处理句柄；初始化失败时保持 null，走原有实体管线。 */
let drawingUi: DrawingHandle | null = null;

function isDrawingName(name: string): boolean {
  return /\.(dxf|dwg)$/i.test(name);
}

/** 图纸走线框管线；返回 true 表示已接管（调用方不要再走实体网格解析）。 */
async function openDrawingPath(path: string): Promise<boolean> {
  if (!isDrawingName(path)) return false;
  if (!drawingUi) {
    showNotice('图纸面板未就绪（3D 视图不可用），无法打开图纸', true);
    return true;
  }
  const result = await drawingUi.open(path);
  showNotice(result.message, !result.ok);
  return true;
}

/**
 * 整机模型构建入口（智能体工具 build_machine_model 与脚本 API 共用）。
 *
 * 机型经 MODEL_BUILDERS 注册表分发；输送机走参数化内核：28 件真实零件逐件导出 STL，
 * 再在视口里装配成 28 个独立零件（零件树可见、干涉检查可用）。
 */
async function buildMachineModel(input: unknown): Promise<Record<string, unknown>> {
  const request = (typeof input === 'object' && input !== null ? input : {}) as {
    process?: unknown;
    params?: unknown;
    name?: unknown;
    load?: unknown;
  };
  const process = typeof request.process === 'string' && request.process.trim() ? request.process.trim() : 'conveyor';
  const builder = pickModelBuilder(process);
  if (!builder) {
    const rulesHint = RULES_ONLY_PROCESSES.includes(process as never)
      ? '：该工艺属于「工位 + 机构」结构，请用 apply_machine_design（规则几何，秒级、带特征树）'
      : '';
    return {
      ok: false,
      code: 'NO_PARAMETRIC_BUILDER',
      message: `「${process}」暂无参数化整机生成器${rulesHint}。可用机型：${Object.keys(MODEL_BUILDERS).join('、')}`
    };
  }
  if (builder.engine !== 'parametric') {
    return { ok: false, code: 'ENGINE_UNSUPPORTED', message: `机型「${process}」的构建器不是参数化引擎` };
  }
  const normalized = normalizeModelParams(builder, request.params);
  if (!normalized.ok) return { ok: false, code: 'INVALID_ARGUMENT', message: normalized.message };

  const params = toConveyorParams(normalized.params);
  const parts = buildConveyorParts(params);
  const doc = conveyorAssembly(parts);

  if (!window.desktop?.parametric) return { ok: false, code: 'UNAVAILABLE', message: '参数化内核接口不可用' };
  const status = await window.desktop.parametric.status();
  if (status.status !== 'ready') {
    const started = await window.desktop.parametric.start();
    if (!started.ok) return { ok: false, code: 'UNAVAILABLE', message: `建模内核启动失败：${started.message ?? started.status}` };
  }
  const built = await window.desktop.parametric.build(doc, { perPart: true });
  if (!built.ok) return { ok: false, code: 'BUILD_FAILED', message: built.message ?? '建模失败' };

  const modelLabel = typeof request.name === 'string' && request.name.trim()
    ? request.name.trim()
    : `${builder.label.split('（')[0] ?? '整机'} ${Math.round(params.lengthMm)}×${Math.round(params.widthMm)}`;
  const instanceStats = (built.stats?.instances ?? []) as Array<{ id: string; volumeMm3: number }>;
  const volumes: Record<string, number> = {};
  for (const item of instanceStats) volumes[item.id] = item.volumeMm3;
  const bom = conveyorBom(parts, volumes);
  const massKg = Math.round(bom.reduce((sum, row) => sum + (row.massKg ?? 0) * row.qty, 0) * 100) / 100;

  // 逐件 STL 装配成独立零件：零件树、干涉检查、运动学都按零件工作
  const perPart = (built.files?.parts ?? []) as Array<{ id: string; name: string; stl?: { path?: string; bytes?: number } }>;
  let loadedParts = 0;
  let loadMessage: string | undefined;
  if (request.load !== false && perPart.length > 0) {
    try {
      const buffers: Array<{ buffer: ArrayBuffer; name: string }> = [];
      for (const item of perPart) {
        const path = item.stl?.path;
        if (!path) continue;
        const bytes = await window.desktop.readFileBuffer(path);
        buffers.push({ buffer: toArrayBuffer(bytes), name: item.name });
      }
      const merged = await parseStandardCadBuffers(buffers, 'STL');
      const label = `${modelLabel}（${merged.meshes.length} 件）`;
      // 必须走 ensureViewer()：视口是懒创建的，直接访问 viewer 变量会静默不加载
      openOverlay();
      ensureViewer().load(merged, label);
      currentFileName = label;
      displayFileInfo(label);
      const partCount = document.getElementById('cadPartCount');
      if (partCount) partCount.textContent = String(merged.stats.meshCount);
      try {
        interference?.run([]);
      } catch (error) {
        console.warn('[build_machine_model] 干涉检查初始化失败', error);
      }
      setEmptyVisible(false);
      showNotice(`${label} 已装配 · ${merged.stats.triangleCount} 个三角面`, false);
      loadedParts = merged.meshes.length;
    } catch (error) {
      loadMessage = error instanceof Error ? error.message : String(error);
    }
  }

  // 存成工程：出现在顶栏 ▾ 里，下次可直接打开（同名覆盖，参数变了不会堆一堆副本）
  const savedProject = await saveProjectToLibrary({
    name: modelLabel,
    process: builder.process,
    params: normalized.params,
    parts: parts.length,
    massKg,
    envelope: conveyorEnvelope(parts) as [number, number, number],
    material: [...new Set(parts.map((part) => MATERIAL_LABEL[part.material]))],
    stepPath: (built.files?.step as { path?: string } | undefined)?.path ?? null,
    stlPath: (built.files?.stl as { path?: string } | undefined)?.path ?? null,
    partPaths: perPart
      .map((item) => ({ name: item.name, path: item.stl?.path ?? '' }))
      .filter((item) => item.path.length > 0)
  });

  return {
    ok: true,
    engine: builder.engine,
    process: builder.process,
    project: savedProject.ok ? { name: modelLabel, saved: true } : { name: modelLabel, saved: false, message: savedProject.message },
    parts: parts.length,
    loadedParts,
    solids: built.stats?.solids ?? null,
    volumeMm3: built.stats?.volumeMm3 ?? null,
    envelope: conveyorEnvelope(parts),
    massKg,
    material: [...new Set(parts.map((part) => MATERIAL_LABEL[part.material]))],
    bom,
    buildMs: built.buildMs ?? null,
    files: {
      step: (built.files?.step as { bytes?: number } | undefined)?.bytes ?? null,
      stl: (built.files?.stl as { bytes?: number } | undefined)?.bytes ?? null,
      partCount: perPart.length
    },
    ...(normalized.message ? { warnings: [normalized.message] } : {}),
    ...(loadMessage ? { loadMessage } : {})
  };
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
    // A second concurrent open must not clear the first import's busy state.
    if (!busy) showCadImportFailure('读取失败', error);
    throw error;
  }
}

async function importPath(path: string): Promise<void> {
  const name = fileNameFromPath(path);
  try {
    if (await openDrawingPath(path)) return;
    await loadCadPath(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showNotice(message, true);
  }
}

async function importDroppedFile(file: File): Promise<void> {
  const supported = /\.(step|stp|iges|igs|brep|stl|obj|gltf|glb|dxf|dwg)$/i.test(file.name);
  if (!supported) {
    showNotice(`不支持的文件类型：${file.name}`, true);
    return;
  }
  try {
    assertCadFileSize(file.name, file.size);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDiagnosticError('CAD_FILE_REJECTED', error, { fileName: file.name, bytes: file.size });
    showNotice(message, true);
    return;
  }
  if (window.desktop) {
    try {
      const path = window.desktop.getPathForFile(file);
      if (path) {
        if (await openDrawingPath(path)) return;
        await importPath(path);
        return;
      }
    } catch (error) {
      // 浏览器预览或非本地文件时退回 File.arrayBuffer。
      console.debug(`[DROP_FILE_PATH_FALLBACK]`, { site: 'desktop/src/extension.ts:852' }, error);
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

function createPortableProjectExportSnapshot(): DesktopProjectExportSnapshot | null {
  const identity = currentProjectIdentity;
  if (!identity) return null;
  const excludedState: string[] = [];
  let featureTreeJson: string | null = null;
  if (!parametricImportModuleEnabled) {
    excludedState.push('feature-tree-module-disabled');
  } else if (!parametric) {
    excludedState.push('feature-tree-not-loaded');
  } else {
    const doc = parametric.getDoc();
    if (typeof doc.sourceFile !== 'string' || doc.sourceFile.trim() !== identity.sourceName) excludedState.push('feature-tree-source-mismatch');
    else featureTreeJson = serializeDoc(doc);
  }

  let kinematicsJson: string | null = null;
  const annotation = kinematics?.getAnnotation();
  if (annotation?.version === 2 && annotation.projectId === identity.projectId) {
    kinematicsJson = serializeAnnotation(annotation);
  } else if (annotation?.parts.length) {
    excludedState.push('kinematics-stable-object-binding-unavailable');
  } else {
    excludedState.push('kinematics-not-loaded');
  }

  const viewState = viewer?.getPortableViewState() ?? null;
  const viewStateJson = viewState ? JSON.stringify(viewState) : null;
  if (!viewStateJson) excludedState.push('cad-view-state-unavailable');
  return {
    projectId: identity.projectId,
    sourceName: identity.sourceName,
    sourceSha256: identity.sourceSha256,
    sourceSize: identity.sourceSize,
    modelObjects: currentModelObjectIdentities
      .filter((entry): entry is typeof entry & { objectId: string } => entry.objectId !== null)
      .map(({ objectId, name, path, geometrySha256 }) => ({ objectId, name, path, geometrySha256 })),
    featureTreeJson,
    kinematicsJson,
    viewStateJson,
    excludedState
  };
}

function describePortableStateExclusions(codes: readonly string[]): string[] {
  const labels: Record<string, string> = {
    'feature-tree-module-disabled': '参数化模块关闭，未收录特征树',
    'feature-tree-not-loaded': '特征树状态未加载',
    'feature-tree-source-mismatch': '特征树来源与当前 CAD 不匹配',
    'kinematics-stable-object-binding-unavailable': '运动学缺少无歧义 stable objectId 映射',
    'kinematics-not-loaded': '运动学标注未加载',
    'cad-view-state-unavailable': '无法安全采集 CAD 视角状态'
  };
  return codes.map((code) => labels[code] ?? code);
}

async function exportPortableProjectArchive(): Promise<void> {
  if (!projectPortableModuleEnabled) {
    showNotice('功能模块「project.portable」当前已关闭。', true);
    return;
  }
  const api = window.desktop?.projectArchive;
  if (!api) {
    showNotice('工程档案文件操作仅在桌面版可用。', true);
    return;
  }
  const snapshot = createPortableProjectExportSnapshot();
  if (!snapshot) {
    showNotice('无法安全导出：当前 CAD 尚无持久工程身份，已禁用导出；请重新导入 CAD 后重试。', true);
    return;
  }
  try {
    const result = await api.exportProject(snapshot);
    if (!result.ok) {
      if (result.code !== 'CANCELED') showNotice(result.message, true);
      return;
    }
    const value = result.value;
    const included = Object.entries(value.includedState).filter(([, includedState]) => includedState).map(([key]) => key).join('、') || '无状态';
    const excluded = value.excludedState.length ? `；未收录：${describePortableStateExclusions(value.excludedState).join('；')}` : '';
    showNotice(`已创建 ${value.path}（含 CAD 原件与候选状态：${included}；schema v2，导入仍为只读预览${excluded}）`);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function openPortableArchivePreview(preview: DesktopProjectArchivePreview): void {
  const dialog = document.getElementById('cadProjectArchivePreview') as HTMLDialogElement | null;
  const body = document.getElementById('cadProjectArchivePreviewBody');
  if (!dialog || !body) {
    showNotice('档案预览界面不可用。', true);
    return;
  }
  const stateLines = [
    `参数化特征树：${preview.state.featureTree ? '档案中有候选数据；尚未应用' : '不包含'}`,
    `运动学标注：${preview.state.kinematics ? '档案中有候选数据；stable objectId 已校验，但尚未针对本机 CAD 重导入验证' : '不包含'}`,
    `视角状态：${preview.state.viewState ? '档案中有候选数据；当前视口未应用' : '不包含'}`
  ];
  const dependencyLines = preview.dependencies.length > 0
    ? preview.dependencies.map((item) => `- ${item.originalName} (${item.format}, ${item.size} bytes, SHA-256 ${item.sha256})`)
    : ['- 无'];
  const omittedStateLines = preview.omittedState.length
    ? describePortableStateExclusions(preview.omittedState).map((reason) => `- ${reason}`)
    : ['- 无'];
  const identityLines = preview.project.identity
    ? [
        `来源身份：${preview.project.identity.sourceName} · ${preview.project.identity.sourceSize} bytes`,
        `源 SHA-256：${preview.project.identity.sourceSha256}`,
        `稳定模型对象：${preview.project.identity.modelObjects.length} 个（相同几何重复对象不分配 ID）`
      ]
    : ['来源身份：旧版 schema 无稳定 source identity'];
  body.textContent = [
    `项目名称：${preview.project.name}`,
    `档案 ID：${preview.project.id}`,
    `档案/Core schema：${preview.schemaVersion}/${preview.coreSchemaVersion}`,
    `创建版本/时间：${preview.appVersion} · ${preview.createdAt}`,
    ...identityLines,
    '',
    '状态候选：',
    ...stateLines,
    '',
    '未收录状态：',
    ...omittedStateLines,
    '',
    'CAD 依赖：',
    ...dependencyLines,
    '',
    `完整性：${preview.integrity.algorithm} (${preview.integrity.authenticity})，仅校验条目与 manifest 一致性。`,
    `尚不支持：${preview.unsupported.join('、')}`,
    '',
    '此处只显示经过校验的候选清单，不会导入、重建或覆盖当前工程。'
  ].join('\n');
  if (!dialog.open) dialog.showModal();
}

async function chooseAndPreviewPortableArchive(): Promise<void> {
  if (!projectPortableModuleEnabled) {
    showNotice('功能模块「project.portable」当前已关闭。', true);
    return;
  }
  const api = window.desktop?.projectArchive;
  if (!api) {
    showNotice('工程档案文件操作仅在桌面版可用。', true);
    return;
  }
  try {
    const result = await api.preview();
    if (!result.ok) {
      if (result.code !== 'CANCELED') showNotice(result.message, true);
      return;
    }
    openPortableArchivePreview(result.value);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), true);
  }
}

function refreshProjectArchiveControls(): void {
  const button = root?.querySelector<HTMLButtonElement>('[data-project-archive="export-cad"]');
  if (!button) return;
  button.disabled = !projectPortableModuleEnabled || !window.desktop?.projectArchive || !currentProjectIdentity;
  button.title = currentProjectIdentity
    ? '导出当前持久身份对应的可支持状态与 CAD 原件'
    : '尚未加载可建立持久身份的 CAD；请重新导入后再导出';
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

function persistedEnclosurePlate(): {
  width: number;
  height: number;
  rails: unknown[];
  placed?: number;
  placements?: unknown[];
} | null {
  try {
    const raw = window.localStorage.getItem('automationcad.enclosure.v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const source = parsed as Record<string, unknown>;
    const plate = source.plate && typeof source.plate === 'object' ? source.plate as Record<string, unknown> : null;
    if (!plate) return null;
    const width = Number(plate.width);
    const height = Number(plate.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return {
      width,
      height,
      rails: Array.isArray(plate.rails) ? plate.rails : [],
      ...(Array.isArray(source.placements) ? {
        placed: source.placements.length,
        placements: source.placements
      } : {})
    };
  } catch (error) {
    recordDiagnosticError('ENCLOSURE_PERSIST_READ_FAILED', error, { site: 'desktop/src/extension.ts' });
    return null;
  }
}

function findEnclosurePlacement(
  ref: string | undefined,
  partId: string | undefined
): import('./enclosure/layout').Placement | null {
  const state = enclosureState();
  if (!state) return null;
  if (ref) {
    const byId = state.placements.find((item) => item.id === ref || item.tag === ref);
    if (byId) return byId;
  }
  if (partId) {
    return state.placements.find((item) => item.partId === partId) ?? null;
  }
  return null;
}

function findBomIndex(
  target: CadViewer,
  ref: string | undefined,
  partId: string | undefined
): number {
  const rows = target.getBomRows();
  if (ref) {
    if (/^\d+$/.test(ref)) {
      const index = Number(ref) - 1;
      if (index >= 0 && index < rows.length) return index;
    }
    const byName = rows.findIndex((row) => row.name === ref || row.spec === ref);
    if (byName >= 0) return byName;
    const byRowPart = rows.findIndex((row) => row.partId === ref);
    if (byRowPart >= 0) return byRowPart;
  }
  if (partId) return rows.findIndex((row) => row.partId === partId);
  return -1;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 以 SHA-256 替换二进制数组内容，绝不把 CAD 网格或工程明细传入磁盘存储。 */
async function fingerprintMaterial(value: unknown, ancestors = new Set<object>()): Promise<unknown> {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('工程摘要包含非有限数');
    return value;
  }
  if (value === undefined) return null;
  if (typeof value !== 'object') throw new Error('工程摘要包含不支持的数据');
  if (ancestors.has(value)) throw new Error('工程摘要包含循环引用');
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    return {
      binaryType: Object.getPrototypeOf(value)?.constructor?.name ?? 'TypedArray',
      byteLength: bytes.byteLength,
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    };
  }
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value.slice(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    return {
      binaryType: 'ArrayBuffer',
      byteLength: bytes.byteLength,
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const entry of value) output.push(await fingerprintMaterial(entry, nextAncestors));
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('工程摘要包含非普通对象');
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) output[key] = await fingerprintMaterial(source[key], nextAncestors);
  return output;
}

async function projectCheckpointFingerprint(): Promise<string | null> {
  if (!agentBridgeReady() || !viewer || !commission || !globalThis.crypto?.subtle) return null;
  try {
    let persistedEnclosure: { plate: unknown; placements: unknown } | null = null;
    const saved = window.localStorage.getItem('automationcad.enclosure.v1');
    if (saved !== null) {
      const parsed = JSON.parse(saved) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const source = parsed as Record<string, unknown>;
      const plate = source.plate;
      if (!plate || typeof plate !== 'object' || Array.isArray(plate) || !Array.isArray(source.placements)) return null;
      persistedEnclosure = { plate, placements: source.placements };
    }
    const liveEnclosure = enclosureState();
    const enclosureSnapshot = liveEnclosure
      ? { plate: liveEnclosure.plate, placements: liveEnclosure.placements }
      : persistedEnclosure;
    const material = {
      schema: 1,
      machine: commission.getMachineConfig(),
      cad: viewer.getCheckpointFingerprintMaterial(),
      bom: viewer.getBomRows(),
      enclosure: enclosureSnapshot
    };
    const normalized = await fingerprintMaterial(material);
    const serialized = JSON.stringify(normalized);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // 无法完整读取或哈希当前工程时，调用方必须拒绝恢复。
    return null;
  }
}

function agentBridgeReady(): boolean {
  return Boolean(root && window.__AUTOMATION_CAD_EXTENSION_READY__ === true);
}

function agentBridgeUnavailable(): { ok: false; message: string } {
  return { ok: false, message: '渲染层尚未就绪' };
}

type AgentUiSelection = {
  kind: 'component' | 'mesh' | 'placement' | 'feature';
  id: string;
  label: string;
};

/** 采集当前最相关选中项：底板 → 运动学网格 → 参数化特征 → CAD 零件。 */
function currentAgentSelection(): AgentUiSelection | null {
  try {
    if (isEnclosureOpen()) {
      const selected = enclosureState()?.selected;
      if (selected) {
        return {
          kind: 'placement',
          id: selected.id,
          label: selected.tag ?? selected.model ?? selected.partId ?? selected.id
        };
      }
    }
  } catch (error) {
    // 某个面板未就绪时继续尝试下一个。
    console.warn(`[EXTENSION_PANEL_BOOTSTRAP_FAILED]`, { site: 'desktop/src/extension.ts:989' }, error);
  }
  try {
    if (kinematics?.isOpen()) {
      const mesh = kinematics.state().selectedMeshes[0];
      if (mesh) return { kind: 'mesh', id: String(mesh.id), label: mesh.name };
    }
  } catch (error) {
    // ignore
    console.warn(`[SELECTION_SNAPSHOT_FAILED]`, { site: 'desktop/src/extension.ts:997' }, error);
  }
  try {
    if (parametric?.isOpen()) {
      const state = parametric.state();
      if (state.selected) {
        const doc = parametric.getDoc();
        const feature = doc.instances
          .flatMap((instance) => instance.features)
          .find((entry) => entry.id === state.selected);
        return {
          kind: 'feature',
          id: state.selected,
          label: feature?.name ?? state.selected
        };
      }
    }
  } catch (error) {
    // ignore
    console.warn(`[AGENT_VIEWER_SCENE_FAILED]`, { site: 'desktop/src/extension.ts:1015' }, error);
  }
  try {
    const snapshot = viewer?.getSelectionSnapshot();
    if (snapshot) return { kind: 'component', id: snapshot.name, label: snapshot.name };
  } catch (error) {
    // ignore
    console.warn(`[AGENT_VIEWER_SELECTION_FAILED]`, { site: 'desktop/src/extension.ts:1021' }, error);
  }
  return null;
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
    appendMachineBomRows: (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') {
        return { ok: false, message: 'BOM 草稿参数不合法' };
      }
      const source = payload as Record<string, unknown>;
      if (!Array.isArray(source.rows)) return { ok: false, message: 'BOM 草稿行必须是数组' };
      try {
        const batchId = typeof source.batchId === 'string' ? source.batchId : '';
        const added = ensureViewer().appendDraftBomRows(source.rows as Parameters<CadViewer['appendDraftBomRows']>[0], batchId);
        return { ok: true, added, total: ensureViewer().getBomRows().length };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    removeMachineBomRows: (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      const batchId = payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).batchId
        : undefined;
      if (typeof batchId !== 'string' || !batchId.trim()) {
        return { ok: false, message: 'BOM 批次 id 不能为空' };
      }
      try {
        const removed = ensureViewer().removeDraftBomRowsByBatch(batchId);
        return { ok: true, removed };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    applyMachineConfig: (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!commission) return { ok: false, message: '联调面板尚未就绪' };
      if (!payload || typeof payload !== 'object') {
        return { ok: false, message: '机型配置参数不合法' };
      }
      const source = payload as Record<string, unknown>;
      try {
        const layout = source.layout === 'single' || source.layout === 'linear' || source.layout === 'dial'
          || source.layout === 'gantry' || source.layout === 'dual' || source.layout === 'hybrid'
          || source.layout === 'cell'
          ? source.layout
          : null;
        commission.setMachineConfig(source.config ? source.config as MachineConfig : null, layout);
        const config = commission.getMachineConfig();
        return {
          ok: true,
          machine: {
            id: config.id,
            name: config.name,
            stations: config.stations.length,
            actuators: config.actuators.length,
            sensors: config.sensors.length
          }
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    getPlcGenConfig: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        return commission?.getMachineConfig() ?? null;
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    getProjectContext: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        const domainButton = document.querySelector<HTMLElement>('.domsw-btn.is-active');
        const domain = domainButton?.dataset.domain ?? document.body.dataset.domain ?? null;
        const activeView = Array.from(document.querySelectorAll<HTMLElement>('.view')).find((element) => !element.hidden);
        const view = activeView?.dataset.view ?? null;
        const selection = currentAgentSelection();
        let machine: { id: string; name: string; stations: number; actuators: number; sensors: number } | null = null;
        try {
          const config = commission?.getMachineConfig();
          if (config) {
            machine = {
              id: config.id,
              name: config.name,
              stations: config.stations.length,
              actuators: config.actuators.length,
              sensors: config.sensors.length
            };
          }
        } catch {
          machine = null;
        }
        const enclosure = enclosureState();
        const storedPlate = enclosure ? null : persistedEnclosurePlate();
        const bomRows = viewer?.getBomRows() ?? [];
        const hasCadModel = (viewer?.getSceneParts() ?? []).length > 0;
        const plate = enclosure
          ? {
              width: enclosure.plate.width,
              height: enclosure.plate.height,
              rails: enclosure.plate.rails,
              placed: enclosure.placed,
              overlaps: enclosure.overlap,
              placements: enclosure.placements
            }
          : storedPlate;
        return {
          domain,
          view,
          selection,
          machine,
          plate,
          bomRows: bomRows.length,
          hasCadModel,
          units: root ? 'mm' : null
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    getProjectCheckpointFingerprint: () => projectCheckpointFingerprint(),
    getAdvisorState: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        const bomRows = viewer?.getBomRows() ?? [];
        const scene = viewer?.getSceneParts() ?? [];
        const enclosure = enclosureState();
        const storedPlate = enclosure ? null : persistedEnclosurePlate();
        const placements: Array<{ partId?: unknown }> = enclosure
          ? enclosure.placements
          : Array.isArray(storedPlate?.placements)
            ? storedPlate.placements.filter((item): item is { partId?: unknown } =>
                Boolean(item && typeof item === 'object'))
            : [];
        const placedPartIds = new Set(placements
          .map((item) => typeof item.partId === 'string' ? item.partId : '')
          .filter(Boolean));
        const unplaced = bomRows.filter((row) =>
          typeof row.partId === 'string' && row.partId.length > 0 && !placedPartIds.has(row.partId)
        ).length;
        const elec = window.__ElecCheckPanel?.result?.() ?? null;
        const costState = window.__CostPanel?.state?.();
        const currentSignature = bomSignatureFromRows(bomRows);
        const lastSignature = costState && 'bomSignature' in costState && typeof costState.bomSignature === 'string'
          ? costState.bomSignature
          : '';
        const hasCadModel = scene.length > 0;
        const conflicts = hasCadModel && interference ? (interference.hasRun() ? interference.getHits().length : null) : null;
        const plcPanelGenerated = window.__PlcGenPanel?.uiState?.().generated === true;
        return {
          bomRows: bomRows.length,
          unplaced,
          conflicts,
          missingDimensions: 0,
          hasCadModel,
          elecCheckPassed: elec ? elec.counts.error === 0 : null,
          elecIssueCount: elec ? elec.counts.error : 0,
          costStale: Boolean(lastSignature) && lastSignature !== currentSignature,
          plcGenerated: Boolean(lastPlcGeneratedAt) || plcPanelGenerated
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    markPlcGenerated: () => {
      lastPlcGeneratedAt = new Date().toISOString();
      return { ok: true };
    },
    insertComponent: (part: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!part || typeof part !== 'object') return { ok: false, message: '零件参数不合法' };
      const source = part as Record<string, unknown>;
      const id = typeof source.id === 'string' ? source.id.trim() : '';
      const model = typeof source.model === 'string' ? source.model.trim() : '';
      const category = typeof source.category === 'string' ? source.category.trim() : '';
      if (!id || !model || !category) return { ok: false, message: '缺少必填参数：零件 id/model/category' };
      try {
        const name = model || id;
        const meshIndex = ensureViewer().addPlaceholderPart(name, id);
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
    placeEnclosurePart: async (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') return { ok: false, code: 'INVALID_ARGUMENT', message: '放置参数不合法' };
      const source = payload as Record<string, unknown>;
      const partId = typeof source.partId === 'string' ? source.partId.trim() : '';
      const x = Number(source.x);
      const y = Number(source.y);
      if (!partId) return { ok: false, code: 'INVALID_ARGUMENT', message: 'partId 不能为空' };
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, code: 'INVALID_ARGUMENT', message: 'x/y 坐标必须是毫米数值' };
      }
      try {
        return await placePartInEnclosure(partId, x, y, {
          rotate: source.rotate === true,
          railSnap: source.railSnap !== false
        });
      } catch (error) {
        return { ok: false, code: 'RENDERER_ERROR', message: error instanceof Error ? error.message : String(error) };
      }
    },
    removeEnclosurePart: (placementId: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (typeof placementId !== 'string' || !placementId.trim()) {
        return { ok: false, message: 'placementId 不能为空' };
      }
      try {
        return removeEnclosurePart(placementId.trim());
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    updateComponent: (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') return { ok: false, code: 'INVALID_ARGUMENT', message: '更新参数不合法' };
      const source = payload as Record<string, unknown>;
      const target = source.target === 'plate' || source.target === 'bom' ? source.target : 'auto';
      const ref = typeof source.ref === 'string' && source.ref.trim() ? source.ref.trim() : undefined;
      const matchPartId = typeof source.matchPartId === 'string' && source.matchPartId.trim()
        ? source.matchPartId.trim()
        : undefined;
      const model = typeof source.model === 'string' && source.model.trim() ? source.model.trim() : undefined;
      const newPartId = typeof source.newPartId === 'string' && source.newPartId.trim() ? source.newPartId.trim() : undefined;
      const qty = Number.isInteger(source.qty) && Number(source.qty) > 0 ? Number(source.qty) : undefined;
      const remark = typeof source.remark === 'string' ? source.remark : undefined;

      const placement = target !== 'bom' ? findEnclosurePlacement(ref, matchPartId) : null;
      if (placement) {
        const before = { ...placement };
        const result = updateEnclosurePlacement(placement.id, {
          ...(model ? { model } : {}),
          ...(newPartId ? { partId: newPartId } : {}),
          ...(qty !== undefined ? { qty } : {}),
          ...(remark !== undefined ? { note: remark } : {}),
          ...(Number.isFinite(source.w) && Number(source.w) > 0 ? { w: Number(source.w) } : {}),
          ...(Number.isFinite(source.h) && Number(source.h) > 0 ? { h: Number(source.h) } : {})
        });
        if (!result.ok) return result;
        return {
          ok: true,
          location: 'plate',
          targetRef: placement.id,
          before,
          updated: result.placement,
          warnings: []
        };
      }

      if (target === 'plate') {
        return { ok: false, code: 'NOT_PLACED', message: '底板中没有匹配的元器件' };
      }
      try {
        const targetViewer = ensureViewer();
        const index = findBomIndex(targetViewer, ref, matchPartId);
        if (index < 0) {
          return { ok: false, code: 'NOT_PLACED', message: 'BOM 中没有匹配的元器件' };
        }
        const beforeRow = targetViewer.getBomRows()[index];
        if (!beforeRow) return { ok: false, code: 'NOT_PLACED', message: 'BOM 行不存在' };
        const before = {
          model: beforeRow.name,
          ...(beforeRow.partId ? { partId: beforeRow.partId } : {}),
          qty: beforeRow.qty,
          ...(beforeRow.note ? { note: beforeRow.note } : {})
        };
        const updated = targetViewer.updateBomRow(index, {
          ...(model ? { model } : {}),
          ...(newPartId ? { partId: newPartId } : {}),
          ...(qty !== undefined ? { qty } : {}),
          ...(remark !== undefined ? { note: remark } : {})
        });
        if (!updated) return { ok: false, code: 'NOT_PLACED', message: 'BOM 行不存在' };
        return {
          ok: true,
          location: 'bom',
          targetRef: String(index + 1),
          before,
          updated,
          warnings: []
        };
      } catch (error) {
        return { ok: false, code: 'RENDERER_ERROR', message: error instanceof Error ? error.message : String(error) };
      }
    },
    removeProjectComponent: (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') return { ok: false, code: 'INVALID_ARGUMENT', message: '移除参数不合法' };
      const source = payload as Record<string, unknown>;
      const target = source.target === 'plate' || source.target === 'bom' ? source.target : 'auto';
      const ref = typeof source.ref === 'string' && source.ref.trim() ? source.ref.trim() : undefined;
      const matchPartId = typeof source.matchPartId === 'string' && source.matchPartId.trim()
        ? source.matchPartId.trim()
        : undefined;

      const placement = target !== 'bom' ? findEnclosurePlacement(ref, matchPartId) : null;
      if (placement) {
        const settled = removeEnclosurePart(placement.id);
        if (!settled.ok) return { ok: false, code: 'NOT_PLACED', message: settled.message ?? '移除失败' };
        const token = `plate-${Date.now().toString(36)}-${++removedComponentSequence}`;
        removedComponentSnapshots.set(token, { location: 'plate', placement: { ...placement } });
        return {
          ok: true,
          location: 'plate',
          targetRef: placement.id,
          removed: { id: placement.id, partId: placement.partId, model: placement.model },
          undoToken: token
        };
      }
      if (target === 'plate') {
        return { ok: false, code: 'NOT_PLACED', message: '底板中没有匹配的元器件' };
      }
      try {
        const targetViewer = ensureViewer();
        const index = findBomIndex(targetViewer, ref, matchPartId);
        if (index < 0) {
          return { ok: false, code: 'NOT_PLACED', message: 'BOM 中没有匹配的元器件' };
        }
        const row = targetViewer.getBomRows()[index];
        const snapshot = targetViewer.detachPart(index);
        if (!snapshot) return { ok: false, code: 'NOT_PLACED', message: 'BOM 行不存在' };
        const token = `bom-${Date.now().toString(36)}-${++removedComponentSequence}`;
        removedComponentSnapshots.set(token, { location: 'bom', snapshot });
        return {
          ok: true,
          location: 'bom',
          targetRef: String(index + 1),
          removed: row
            ? { no: row.no, name: row.name, partId: row.partId ?? null, qty: row.qty }
            : { no: index + 1 },
          undoToken: token
        };
      } catch (error) {
        return { ok: false, code: 'RENDERER_ERROR', message: error instanceof Error ? error.message : String(error) };
      }
    },
    restoreProjectComponent: (value: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      const token = Array.isArray(value) ? value[0] : value;
      if (typeof token !== 'string' || !token.trim()) {
        return { ok: false, code: 'NOT_PLACED', message: '撤销令牌不能为空' };
      }
      const snapshot = removedComponentSnapshots.get(token.trim());
      if (!snapshot) {
        return { ok: false, code: 'NOT_PLACED', message: '撤销快照不存在或已使用' };
      }
      const ok = snapshot.location === 'plate'
        ? restoreEnclosurePlacement(snapshot.placement)
        : Boolean(viewer?.restoreDetachedPart(snapshot.snapshot));
      if (!ok) return { ok: false, code: 'NOT_PLACED', message: '恢复元器件失败' };
      removedComponentSnapshots.delete(token.trim());
      return { ok: true };
    },
    exportArtifact: async (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') return { ok: false, code: 'INVALID_ARGUMENT', message: '导出参数不合法' };
      const source = payload as Record<string, unknown>;
      const kind = source.kind;
      if (kind !== 'pdf' && kind !== 'dxf' && kind !== 'glb' && kind !== 'bom') {
        return { ok: false, code: 'UNSUPPORTED_FORMAT', message: '导出格式仅支持 pdf / dxf / glb / bom' };
      }
      try {
        const format: ExportFormat = kind === 'bom' ? 'csv' : kind;
        const built = await buildExport(format);
        if (kind === 'glb') {
          if (!(built.data instanceof Uint8Array)) {
            return { ok: false, code: 'EXPORT_FAILED', message: 'GLB 导出结果不是字节数组' };
          }
          return {
            ok: true,
            kind,
            data: base64FromBytes(built.data),
            encoding: 'base64',
            suggestedName: built.name
          };
        }
        if (typeof built.data !== 'string') {
          return { ok: false, code: 'EXPORT_FAILED', message: '文本导出结果不是字符串' };
        }
        return { ok: true, kind, data: built.data, encoding: 'utf8', suggestedName: built.name };
      } catch (error) {
        return { ok: false, code: 'EXPORT_FAILED', message: error instanceof Error ? error.message : String(error) };
      }
    },
    exportCostFile: async (payload: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (!payload || typeof payload !== 'object') {
        return { ok: false, code: 'WRITE_FAILED', message: '导出参数不合法' };
      }
      const source = payload as Record<string, unknown>;
      if (source.format !== 'pdf' && source.format !== 'csv') {
        return { ok: false, code: 'UNSUPPORTED_FORMAT', message: '导出格式仅支持 pdf 或 csv' };
      }
      if (!window.desktop?.exportCostFile) {
        return { ok: false, code: 'DENIED', message: '桌面版导出接口不可用' };
      }
      let data: string | Uint8Array;
      if (source.encoding === 'base64') {
        if (typeof source.data !== 'string' || !source.data) {
          return { ok: false, code: 'WRITE_FAILED', message: '导出数据不能为空' };
        }
        try {
          const binary = atob(source.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          data = bytes;
        } catch {
          return { ok: false, code: 'WRITE_FAILED', message: 'PDF 数据解码失败' };
        }
      } else {
        if (typeof source.data !== 'string') {
          return { ok: false, code: 'WRITE_FAILED', message: '导出数据必须是字符串或字节数组' };
        }
        data = source.data;
      }
      try {
        return await window.desktop.exportCostFile({
          format: source.format,
          ...(typeof source.fileName === 'string' ? { fileName: source.fileName } : {}),
          overwrite: source.overwrite === true,
          data,
          ...(typeof source.suggestedName === 'string' ? { suggestedName: source.suggestedName } : {})
        });
      } catch (error) {
        return {
          ok: false,
          code: 'WRITE_FAILED',
          message: `成本报告写入失败：${error instanceof Error ? error.message : String(error)}`
        };
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
    suggestKinematics: () => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      try {
        const handle = ensureKinematicsUi();
        const before = handle.state();
        const result = handle.suggest();
        return {
          sourceFile: before.sourceFile,
          meshes: before.meshes.length,
          existingParts: before.parts.length,
          summary: describeSuggestions(result),
          stats: result.stats,
          suggestions: result.suggestions,
          lowConfidence: result.lowConfidence,
          skipped: result.skipped.slice(0, 10).map((item) => ({ name: item.name, reason: item.reason }))
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    buildMachineModel: async (payload: unknown) => await buildMachineModel(payload),
    importPath: async (path: unknown) => {
      if (!agentBridgeReady()) return agentBridgeUnavailable();
      if (typeof path !== 'string' || !path.trim()) return { ok: false, message: 'CAD 文件路径不能为空' };
      try {
        if (isDrawingName(path.trim())) {
          const result = await openDrawingPath(path.trim());
          return result
            ? { ok: true, meshCount: 0, triangleCount: 0, drawing: true }
            : { ok: false, message: '图纸打开失败' };
        }
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
  window.addEventListener('pagehide', () => {
    disposeCadWorker('pagehide');
    window.clearTimeout(noticeTimer);
    viewer?.dispose();
    viewer = null;
    commission?.dispose();
    commission = null;
  }, { once: true });
}

function init(): void {
  injectStyles();
  const appearanceReady = window.desktop?.appearance?.get()
    .then((config) => applyAppearance(config))
    .catch((error: unknown) => {
      console.error('[appearance] 读取界面缩放/渲染质量失败，使用默认值', error);
    }) ?? Promise.resolve();
  buildEntryButton();
  initFactoryPanel();
  commission = initCommissionPanel({
    onExportReport: async () => {
      await exportPdfReport();
    }
  });
  initPackPanel();
  initElecLibraryPanel();
  const moduleStorage: KeyValueStorage = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value)
  };
  const moduleManager = createModuleManager(moduleStorage);
  const elecCheckPanel = initElecCheckPanel({ enabled: moduleManager.getStatus('elec.validation').enabled });
  const initialCostEnabled = moduleManager.getStatus('cost.estimation').enabled;
  const costPanel = initCostPanel({ enabled: !window.desktop && initialCostEnabled });
  const updatePanel = initUpdatePanel();
  const publishCostEstimationState = (states: ModuleStatus[]): void => {
    const desiredEnabled = states.find((module) => module.id === 'cost.estimation')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncCostEstimationEnabled(desiredEnabled);
      const enabled = desiredEnabled && (!window.desktop || accepted === true);
      costPanel.setEnabled(enabled);
      if (window.desktop && accepted !== true) {
        console.error('[modules] 主进程未接受 cost.estimation 状态；成本计算与报告保持关闭');
      }
    } catch (error) {
      costPanel.setEnabled(false);
      console.error('[modules] cost.estimation 状态同步失败；成本计算与报告保持关闭', error);
    }
  };
  plcSyncModulesEnabled = () => ({
    plcgen: moduleManager.getStatus('plcgen').enabled,
    plcSync: moduleManager.getStatus('factory.plc-sync').enabled
  });
  commission?.setIoTestsEnabled(moduleManager.getStatus('commission.io-test').enabled);
  const publishSystemUpdateState = (states: ModuleStatus[]): void => {
    const desiredEnabled = states.find((module) => module.id === 'system.update')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncSystemUpdateEnabled(desiredEnabled);
      const enabled = Boolean(window.desktop && accepted === true && desiredEnabled);
      updatePanel.setEnabled(enabled);
      if (window.desktop && accepted !== true) {
        console.error('[modules] 主进程未接受 system.update 状态；更新界面与 IPC 保持关闭');
      }
    } catch (error) {
      updatePanel.setEnabled(false);
      console.error('[modules] system.update 状态同步失败；更新界面与 IPC 保持关闭', error);
    }
  };
  const publishPlcgenState = (states: ModuleStatus[]): void => {
    const enabled = states.find((module) => module.id === 'plcgen')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncPlcgenEnabled(enabled);
      if (window.desktop && !accepted) {
        console.error('[modules] 主进程未接受 PLC 模块状态；Agent 工具将保持关闭');
      }
    } catch (error) {
      console.error('[modules] PLC 模块状态同步失败；Agent 工具将保持关闭', error);
    }
  };
  const publishElecValidationState = (states: ModuleStatus[]): void => {
    const desiredEnabled = states.find((module) => module.id === 'elec.validation')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncElecValidationEnabled(desiredEnabled);
      const enabled = desiredEnabled && (!window.desktop || accepted === true);
      elecCheckPanel.setEnabled(enabled);
      if (window.desktop && accepted !== true) {
        console.error('[modules] 主进程未接受 elec.validation 状态；电气校验保持关闭');
      }
    } catch (error) {
      elecCheckPanel.setEnabled(false);
      console.error('[modules] elec.validation 状态同步失败；电气校验保持关闭', error);
    }
  };
  const publishPlcSyncState = (states: ModuleStatus[]): void => {
    const enabled = states.find((module) => module.id === 'factory.plc-sync')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncFactoryPlcSyncEnabled(enabled);
      if (window.desktop && !accepted) {
        console.error('[modules] 主进程未接受智慧工厂 PLC 同步模块状态；PLC 同步将保持关闭');
      }
    } catch (error) {
      console.error('[modules] 智慧工厂 PLC 同步模块状态同步失败；PLC 同步将保持关闭', error);
    }
  };
  const publishParametricImportState = (states: ModuleStatus[]): void => {
    parametricImportModuleEnabled = states.find((module) => module.id === 'cad.parametric-import')?.enabled === true;
    const toggle = document.getElementById('cadParametricToggle');
    const badge = document.getElementById('cadParametricStatus');
    if (toggle) toggle.hidden = !parametricImportModuleEnabled;
    if (badge && !parametricImportModuleEnabled) badge.hidden = true;
    if (!parametricImportModuleEnabled) parametric?.close();
    try {
      const accepted = window.desktop?.modules.syncParametricImportEnabled(parametricImportModuleEnabled);
      if (window.desktop && !accepted) {
        parametricImportModuleEnabled = false;
        if (toggle) toggle.hidden = true;
        parametric?.close();
        console.error('[modules] 主进程未接受参数化模块状态；参数化功能保持关闭');
      }
    } catch (error) {
      parametricImportModuleEnabled = false;
      if (toggle) toggle.hidden = true;
      parametric?.close();
      console.error('[modules] 参数化模块状态同步失败；参数化功能保持关闭', error);
    }
  };
  const publishParametricHistoryState = (states: ModuleStatus[]): void => {
    parametricHistoryModuleEnabled =
      parametricImportModuleEnabled && states.find((module) => module.id === 'parametric.history')?.enabled === true;
    parametric?.refreshHistoryState();
  };
  const publishAgentResumeState = (states: ModuleStatus[]): void => {
    const enabled = states.find((module) => module.id === 'agent.resume')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncAgentResumeEnabled(enabled);
      if (!accepted) throw new Error('主进程未接受模块状态');
      setAgentResumeModuleEnabled(enabled);
    } catch (error) {
      setAgentResumeModuleEnabled(false);
      console.error('[modules] Agent 跨重启恢复状态同步失败；checkpoint 与恢复功能保持关闭', error);
    }
  };
  const publishProjectPortableState = (states: ModuleStatus[]): void => {
    projectPortableModuleEnabled = states.find((module) => module.id === 'project.portable')?.enabled === true;
    try {
      const accepted = window.desktop?.modules.syncProjectPortableEnabled(projectPortableModuleEnabled);
      if (window.desktop && !accepted) {
        projectPortableModuleEnabled = false;
        console.error('[modules] 主进程未接受 project.portable 状态；工程档案操作保持关闭');
      }
    } catch (error) {
      projectPortableModuleEnabled = false;
      console.error('[modules] project.portable 状态同步失败；工程档案操作保持关闭', error);
    }
    root?.querySelectorAll<HTMLElement>('[data-project-archive-entry]').forEach((entry) => {
      entry.hidden = !projectPortableModuleEnabled || !window.desktop?.projectArchive;
    });
    refreshProjectArchiveControls();
    if (!projectPortableModuleEnabled) {
      const preview = document.getElementById('cadProjectArchivePreview') as HTMLDialogElement | null;
      if (preview?.open) preview.close();
    }
  };
  publishPlcgenState(moduleManager.list());
  publishElecValidationState(moduleManager.list());
  publishCostEstimationState(moduleManager.list());
  publishPlcSyncState(moduleManager.list());
  publishParametricImportState(moduleManager.list());
  publishParametricHistoryState(moduleManager.list());
  publishAgentResumeState(moduleManager.list());
  publishProjectPortableState(moduleManager.list());
  publishSystemUpdateState(moduleManager.list());
  moduleManager.subscribe((states: ModuleStatus[]) => {
    const enabled = states.find((module) => module.id === 'plcgen')?.enabled === true;
    commission?.setIoTestsEnabled(states.find((module) => module.id === 'commission.io-test')?.enabled === true);
    publishPlcgenState(states);
    publishElecValidationState(states);
    publishCostEstimationState(states);
    publishPlcSyncState(states);
    publishParametricImportState(states);
    publishParametricHistoryState(states);
    publishAgentResumeState(states);
    publishProjectPortableState(states);
    publishSystemUpdateState(states);
    if (enabled) {
      void activatePlcGenUi(moduleManager).catch((error: unknown) => {
        console.error('[modules] PLC 程序模块加载失败', error);
      });
    } else {
      plcGenUi?.setEnabled(false);
    }
  });
  initModuleSettingsUi({ manager: moduleManager });
  Object.defineProperty(window, '__ModuleRegistry', {
    value: Object.freeze({
      list: () => moduleManager.list(),
      getStatus: (id: string) => moduleManager.getStatus(id),
      setEnabled: (id: string, enabled: boolean) => moduleManager.setEnabled(id, enabled)
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  initEnclosureUi();
  initSyncPanel({ buildPayload: buildSyncPayload });
  initAgentPanel();
  buildOverlay();
  refreshProjectArchiveControls();
  initMechUi();
  injectStressTab();
  let orbitHandle: ReturnType<typeof initOrbitView> | null = null;
  try {
    orbitHandle = initOrbitView();
  } catch (error) {
    // 主视口 3D 注入失败时保留原型等轴测视图，不影响其他扩展。
    console.warn('[orbit] 主视口 3D 初始化失败，保留等轴测视图', error);
  }
  // 标准件装配：拖进 3D 落位（不走 agent）
  let assemblyUi: ReturnType<typeof initAssemblyUi> | null = null;
  try {
    const assemblyView = orbitHandle?.assemblyView() ?? null;
    if (assemblyView) {
      if (!document.getElementById('acp-assembly-styles')) {
        const style = document.createElement('style');
        style.id = 'acp-assembly-styles';
        style.textContent = assemblyStyles();
        document.head.appendChild(style);
      }
      assemblyUi = initAssemblyUi({ view: assemblyView });
      buildPanelEntryButton(
        'assemblyEntryButton',
        '装配',
        '<svg viewBox="0 0 16 16" class="ico"><path d="M3 3h5v5H3zM8 8h5v5H8zM9 8l3-3"/></svg>',
        () => assemblyUi?.open()
      );
      Object.defineProperty(window, 'AutomationCadAssembly', {
        value: Object.freeze(assemblyUi),
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  } catch (error) {
    console.warn('[assembly] 标准件装配初始化失败', error);
  }
  // 2D 图纸（DXF/DWG）：贴到 3D 视图当参考底图
  try {
    if (!document.getElementById('acp-drawing-styles')) {
      const style = document.createElement('style');
      style.id = 'acp-drawing-styles';
      style.textContent = drawingStyles();
      document.head.appendChild(style);
    }
    drawingUi = initDrawingUi({
      view: () => orbitHandle?.assemblyView() ?? null,
      beforeOpen: () => {
        openOverlay();
        setEmptyVisible(false);
      },
      mountDrawer: (body) => {
        const handle = createDrawer('drawingDrawer', '图纸', 'DXF / DWG 底图');
        handle.body.appendChild(body);
        return handle;
      }
    });
    buildPanelEntryButton(
      'drawingEntryButton',
      '图纸',
      '<svg viewBox="0 0 16 16" class="ico"><path d="M2 13V3h12v10zM2 6h12M6 6v7"/></svg>',
      () => drawingUi?.show()
    );
    Object.defineProperty(window, 'AutomationCadDrawing', {
      value: Object.freeze(drawingUi),
      writable: false,
      configurable: false,
      enumerable: false
    });
  } catch (error) {
    console.warn('[drawing] 图纸面板初始化失败', error);
  }
  bindWindowEvents();
  // 外壳文件的「文件菜单」用它列工程/重新打开：app.js → AutomationCadProjects
  Object.defineProperty(window, 'AutomationCadProjects', {
    value: Object.freeze({
      list: () => window.desktop?.projects?.list() ?? Promise.resolve([]),
      open: (id: string) => openSavedProject(id),
      remove: (id: string) => window.desktop?.projects?.remove(id) ?? Promise.resolve({ ok: false }),
      current: () => currentFileName,
      currentId: () => lastOpenedProject?.id ?? null,
      /** 外壳选了工程后直接跳到 CAD 视图，而不是停在外壳画布 */
      show: () => {
        openOverlay();
        if (root) {
          root.hidden = false;
          root.style.zIndex = '2147483000';
        }
        return true;
      },
      lastOpened: () => lastOpenedProject
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });

  Object.defineProperty(window, 'AutomationCadConveyor', {
    value: Object.freeze({
      // 兼容旧脚本入口；内部走通用构造器（process=conveyor）
      build: (params: Partial<ConveyorParams>) => buildMachineModel({ process: 'conveyor', params })
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  Object.defineProperty(window, 'AutomationCadKinematics', {
    value: Object.freeze({
      open: (): void => {
        parametric?.close();
        if (!overlayOpen) openOverlay();
        else ensureKinematicsUi().open();
      },
      close: (): void => ensureKinematicsUi().close(),
      state: () => ensureKinematicsUi().state(),
      addMovingPart: (meshIds: readonly number[], name?: string): string => ensureKinematicsUi().addMovingPart(meshIds, name),
      updatePart: (id: string, patch: Parameters<KinematicsUiHandle['updatePart']>[1]): void =>
        ensureKinematicsUi().updatePart(id, patch),
      slide: (id: string, percent: number) => ensureKinematicsUi().slide(id, percent),
      save: (): boolean => ensureKinematicsUi().save(),
      getAnnotation: () => ensureKinematicsUi().getAnnotation(),
      getValidation: () => ensureKinematicsUi().getValidation(),
      suggest: () => ensureKinematicsUi().suggest(),
      suggestions: () => ensureKinematicsUi().suggestions(),
      acceptSuggestion: (id: string): string | null => ensureKinematicsUi().acceptSuggestion(id),
      dismissSuggestion: (id: string): void => ensureKinematicsUi().dismissSuggestion(id)
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  Object.defineProperty(window, 'AutomationCadParametric', {
    value: Object.freeze({
      open: (): void => {
        if (!parametricImportModuleEnabled) {
          showNotice(PARAMETRIC_MODULE_DISABLED_MESSAGE, true);
          return;
        }
        if (!overlayOpen) openOverlay();
        kinematics?.close();
        ensureParametricUi().open();
      },
      close: (): void => parametric?.close(),
      state: () => ensureParametricUi().state(),
      historyState: () => parametric?.historyState() ?? {
        enabled: parametricHistoryModuleEnabled,
        undoCount: 0,
        redoCount: 0
      },
      undo: (): boolean => parametricHistoryModuleEnabled && (parametric?.undo() ?? false),
      redo: (): boolean => parametricHistoryModuleEnabled && (parametric?.redo() ?? false),
      setSource: (sourceFile: string): void => {
        if (!parametricImportModuleEnabled) throw new Error(PARAMETRIC_MODULE_DISABLED_MESSAGE);
        const sameLoadedSource = sourceFile.trim() === currentFileName;
        ensureParametricUi().setSource(
          sourceFile,
          sameLoadedSource ? currentProjectIdentity?.projectId : undefined,
          sameLoadedSource ? currentProjectStorageKey : `session:${Date.now()}:${Math.random().toString(36).slice(2)}`
        );
      },
      setDoc: (doc: Parameters<ParametricUiHandle['setDoc']>[0]): void => {
        if (!parametricImportModuleEnabled) throw new Error(PARAMETRIC_MODULE_DISABLED_MESSAGE);
        ensureParametricUi().setDoc(doc);
      },
      getDoc: () => ensureParametricUi().getDoc(),
      build: () => parametricImportModuleEnabled
        ? ensureParametricUi().build()
        : Promise.resolve(parametricModuleDisabledBuildResult())
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  window.AutomationCadViewer = {
      /** 渲染诊断：线框开关、材质、光照、相机（排查"看不见实体"用） */
      describeScene: () => ensureViewer().describeScene(),
      toggleWireframe: () => ensureViewer().toggleWireframe(),
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
  void window.desktop?.machine?.active?.().then((result) => {
    if (!result?.ok || !result.design || typeof result.design !== 'object') return;
    const config = (result.design as Record<string, unknown>).config;
    if (config && typeof config === 'object') {
      commission?.setMachineConfig(config as MachineConfig);
    }
  }).catch(() => {
    // active 指针缺失或损坏时保持内置样机，不影响启动。
  });
  if (moduleManager.getStatus('plcgen').enabled) {
    void Promise.all([activatePlcGenUi(moduleManager), appearanceReady]).then(() => {
      window.__AUTOMATION_CAD_EXTENSION_READY__ = true;
    }).catch((error: unknown) => {
      console.error('[modules] PLC 程序模块加载失败，面板保持不可用', error);
      window.__AUTOMATION_CAD_EXTENSION_READY__ = true;
    });
  } else {
    void appearanceReady.finally(() => {
      window.__AUTOMATION_CAD_EXTENSION_READY__ = true;
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
