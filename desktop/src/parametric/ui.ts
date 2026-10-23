// 参数化特征树抽屉：编辑特征树、按 type 渲染参数表单、防抖重建并载入 STL。
// 边界：只组织 UI 与调用既有 IPC；几何编译与校验仍在 features.ts / sidecar。

import type { CadImportResult } from '../shared/types';
import type { CadViewer } from '../cad/viewer';
import {
  summarize,
  toAssembly,
  validateFeatures,
  type AssemblyDoc,
  type FeatureDoc,
  type FeatureNode,
  type FeatureType,
  type PartInstance
} from './features.ts';
import {
  FEATURE_SPECS,
  FEATURE_TYPES,
  addFeature,
  addInstance,
  createParametricStore,
  debouncePlan,
  deserializeDoc,
  docBounds,
  featureBounds,
  findFeature,
  formatBuildStatus,
  instanceFeatures,
  makeDoc,
  makeAssembly,
  moveFeature,
  removeFeature,
  removeInstance,
  renameInstance,
  renameFeature,
  serializeDoc,
  setInstancePartId,
  setSuppressed,
  storageBucketKey,
  updateInstanceTransform,
  updateParams,
  type StorageLike
} from './model.ts';
import { bomToCsv, toBom, toCostInput } from './bom.ts';

export interface ParametricUiStatus {
  status: 'stopped' | 'starting' | 'ready' | 'unavailable' | 'crashed';
  message: string;
  version?: string;
}

export interface ParametricBuildLike {
  ok: boolean;
  code?: 'UNAVAILABLE' | 'TIMEOUT' | 'BUILD_FAILED';
  message?: string;
  stats?: Record<string, unknown>;
  buildMs?: number;
  files?: Record<string, unknown>;
}

export interface ParametricUiOptions {
  container: HTMLElement;
  viewer: CadViewer;
  getSourceFile: () => string;
  /** 复用查看器现有 STL 解析路径（readFileBuffer + parseStandardCadBuffer）。 */
  loadStl: (path: string) => Promise<CadImportResult>;
  notify?: (message: string, error?: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  storage?: StorageLike;
  now?: () => number;
  debounceMs?: number;
}

export interface ParametricUiState {
  sourceFile: string;
  features: number;
  instances: number;
  bomRows: number;
  selected: string | null;
  validationErrors: number;
  status: ParametricUiStatus['status'];
  statusLabel: string;
  buildStatus: string;
  building: boolean;
  stlLoaded: boolean;
  ghost: boolean;
}

export interface ParametricUiHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  setSource(sourceFile: string): void;
  setDoc(doc: FeatureDoc | AssemblyDoc): void;
  getDoc(): AssemblyDoc;
  build(): Promise<ParametricBuildLike>;
  state(): ParametricUiState;
}

const STATUS_LABELS: Record<ParametricUiStatus['status'], string> = {
  stopped: '未启动',
  starting: '启动中',
  ready: '就绪',
  unavailable: '不可用',
  crashed: '不可用'
};

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return entities[character] ?? character;
  });
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberText(value: unknown, fallback = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

function safeBaseName(value: string): string {
  const base = (value || 'untitled').replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 80);
  return base || 'untitled';
}

function pathOf(files: Record<string, unknown> | undefined, format: 'step' | 'stl'): string | null {
  const entry = files?.[format];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const path = (entry as Record<string, unknown>).path;
  return typeof path === 'string' && path.trim() ? path : null;
}

function copyFeatures(features: readonly FeatureNode[]): FeatureNode[] {
  return JSON.parse(JSON.stringify(features)) as FeatureNode[];
}

function blankInstance(id: string, name: string): PartInstance {
  return { id, name, transform: { x: 0, y: 0, z: 0, rz: 0 }, features: [] };
}

export function initParametricUi(options: ParametricUiOptions): ParametricUiHandle {
  const storage = options.storage ?? defaultStorage();
  const store = storage ? createParametricStore(storage) : null;
  const { container, viewer } = options;
  const now = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? 300;

  let sourceFile = options.getSourceFile().trim();
  let instances: PartInstance[] = [blankInstance('p1', '零件 1')];
  let selectedInstanceId: string | null = 'p1';
  let doc: FeatureDoc = makeDoc([], {
    ...(sourceFile ? { sourceFile } : {}),
    now: now()
  });
  let selectedId: string | null = null;
  let renamingId: string | null = null;
  let validationErrors: string[] = [];
  let statusView: ParametricUiStatus = { status: 'stopped', message: '参数化建模内核未启动' };
  let autoRebuild = true;
  let compareOld = true;
  let lastBuildMs: number | undefined;
  let lastStats: Record<string, unknown> | undefined;
  let lastFiles: Record<string, unknown> | undefined;
  let lastBuildError = '';
  let stlLoaded = false;
  let building = false;
  let pendingBuild = false;
  let debounceTimer = 0;

  container.classList.add('cad-parametric-drawer');
  container.innerHTML = `
    <header class="cad-param-head">
      <div class="cad-param-title">
        <b>参数化</b>
        <span data-param-source>未加载来源文件</span>
      </div>
      <button type="button" class="cad-param-icon" data-param-close aria-label="收起参数化面板">×</button>
    </header>
    <div class="cad-param-statusbar">
      <span class="cad-param-dot" data-param-state-dot></span>
      <b data-param-state-label>未启动</b>
      <span data-param-state-message>参数化建模内核未启动</span>
    </div>
    <div class="cad-param-body">
      <section class="cad-param-section">
        <div class="cad-param-section-head">
          <span>装配实体</span><b data-param-instance-count>1</b>
        </div>
        <div class="cad-param-instances" data-param-instances></div>
        <div class="cad-param-add">
          <button type="button" class="cad-btn" data-param-instance-add>新增实体</button>
        </div>
        <div class="cad-param-instance-form" data-param-instance-form></div>
      </section>
      <section class="cad-param-section">
        <div class="cad-param-section-head">
          <span>特征树</span><b data-param-feature-count>0</b>
        </div>
        <div class="cad-param-add">
          <select data-param-add-type aria-label="选择新特征类型">
            ${FEATURE_TYPES.map((type) =>
              `<option value="${type}">${escapeHtml(FEATURE_SPECS[type].label)}</option>`
            ).join('')}
          </select>
          <button type="button" class="cad-btn cad-btn-primary" data-param-add>新增特征</button>
        </div>
        <div class="cad-param-features" data-param-features>
          <div class="cad-param-empty">还没有特征。先新增底板，再添加孔、槽和圆角。</div>
        </div>
      </section>
      <section class="cad-param-section">
        <div class="cad-param-section-head">
          <span>参数</span><b data-param-summary>0 特征</b>
        </div>
        <div class="cad-param-form" data-param-form>
          <div class="cad-param-empty">选择上方特征后编辑参数。</div>
        </div>
      </section>
      <section class="cad-param-section">
        <div class="cad-param-section-head">
          <span>校验</span><b data-param-issue-count>0</b>
        </div>
        <div class="cad-param-issues" data-param-issues></div>
      </section>
      <section class="cad-param-section">
        <div class="cad-param-section-head">
          <span>BOM</span><b data-param-bom-count>0</b>
        </div>
        <div class="cad-param-bom" data-param-bom></div>
      </section>
      <section class="cad-param-options">
        <label><input type="checkbox" data-param-auto checked> 参数改动 300 ms 后自动重建</label>
        <label><input type="checkbox" data-param-compare checked> 叠加旧模型（半透明）对比</label>
      </section>
    </div>
    <footer class="cad-param-foot">
      <div class="cad-param-buildstatus">
        <b data-param-build-status>尚未重建</b>
        <span data-param-build-hint>重建后显示耗时、面数与体积</span>
      </div>
      <div class="cad-param-actions">
        <button type="button" class="cad-btn cad-btn-primary" data-param-rebuild>重建</button>
        <button type="button" class="cad-btn" data-param-export="step">导出 STEP</button>
        <button type="button" class="cad-btn" data-param-export="stl">导出 STL</button>
        <button type="button" class="cad-btn" data-param-export-bom>导出 BOM</button>
        <button type="button" class="cad-btn" data-param-send-cost>送成本</button>
        <button type="button" class="cad-btn" data-param-save>保存特征树</button>
        <button type="button" class="cad-btn" data-param-load>载入特征树</button>
        <input type="file" accept="application/json,.json" data-param-file hidden>
      </div>
    </footer>`;

  const query = <T extends HTMLElement>(selector: string): T => {
    const node = container.querySelector<T>(selector);
    if (!node) throw new Error(`参数化面板节点缺失：${selector}`);
    return node;
  };
  const sourceLabel = query<HTMLElement>('[data-param-source]');
  const stateDot = query<HTMLElement>('[data-param-state-dot]');
  const stateLabel = query<HTMLElement>('[data-param-state-label]');
  const stateMessage = query<HTMLElement>('[data-param-state-message]');
  const instanceList = query<HTMLElement>('[data-param-instances]');
  const instanceCount = query<HTMLElement>('[data-param-instance-count]');
  const instanceForm = query<HTMLElement>('[data-param-instance-form]');
  const featureList = query<HTMLElement>('[data-param-features]');
  const featureCount = query<HTMLElement>('[data-param-feature-count]');
  const summary = query<HTMLElement>('[data-param-summary]');
  const form = query<HTMLElement>('[data-param-form]');
  const issues = query<HTMLElement>('[data-param-issues]');
  const issueCount = query<HTMLElement>('[data-param-issue-count]');
  const bomList = query<HTMLElement>('[data-param-bom]');
  const bomCount = query<HTMLElement>('[data-param-bom-count]');
  const addType = query<HTMLSelectElement>('[data-param-add-type]');
  const addButton = query<HTMLButtonElement>('[data-param-add]');
  const rebuildButton = query<HTMLButtonElement>('[data-param-rebuild]');
  const saveButton = query<HTMLButtonElement>('[data-param-save]');
  const loadButton = query<HTMLButtonElement>('[data-param-load]');
  const fileInput = query<HTMLInputElement>('[data-param-file]');
  const autoInput = query<HTMLInputElement>('[data-param-auto]');
  const compareInput = query<HTMLInputElement>('[data-param-compare]');
  const buildStatus = query<HTMLElement>('[data-param-build-status]');
  const buildHint = query<HTMLElement>('[data-param-build-hint]');
  const exportButtons = [...container.querySelectorAll<HTMLButtonElement>('[data-param-export]')];
  const exportBomButton = query<HTMLButtonElement>('[data-param-export-bom]');
  const sendCostButton = query<HTMLButtonElement>('[data-param-send-cost]');

  const notify = (message: string, error = false): void => options.notify?.(message, error);

  const api = () => window.desktop?.parametric;

  function currentInstance(): PartInstance | null {
    return instances.find((instance) => instance.id === selectedInstanceId) ?? null;
  }

  function syncSelectedFeatures(): void {
    if (!selectedInstanceId) return;
    instances = instances.map((instance) =>
      instance.id === selectedInstanceId ? { ...instance, features: copyFeatures(doc.features) } : instance
    );
  }

  function currentAssembly(): AssemblyDoc {
    syncSelectedFeatures();
    return {
      schemaVersion: 2,
      ...(sourceFile ? { sourceFile } : {}),
      instances: instances.map((instance) => JSON.parse(JSON.stringify(instance)) as PartInstance),
      updatedAt: doc.updatedAt
    };
  }

  function featureDocFor(instance: PartInstance, updatedAt: string): FeatureDoc {
    return {
      schemaVersion: 1,
      ...(sourceFile ? { sourceFile } : {}),
      features: copyFeatures(instance.features),
      updatedAt
    };
  }

  function applyAssembly(
    next: AssemblyDoc,
    options2: { keepSelection?: boolean; rebuild?: boolean } = {}
  ): void {
    instanceState(next.instances, options2.keepSelection === true, options2.rebuild !== false, next.updatedAt);
  }

  function instanceState(
    nextInstances: PartInstance[],
    keepSelection: boolean,
    rebuild: boolean,
    updatedAt?: string
  ): void {
    instances = nextInstances.map((instance) => JSON.parse(JSON.stringify(instance)) as PartInstance);
    const stillThere = selectedInstanceId && instances.some((instance) => instance.id === selectedInstanceId);
    selectedInstanceId = stillThere ? selectedInstanceId : instances[0]?.id ?? null;
    const instance = currentInstance();
    doc = featureDocFor(instance ?? blankInstance('p1', '零件 1'), updatedAt ?? doc.updatedAt);
    if (!keepSelection || !findFeature(doc, selectedId)) selectedId = doc.features[0]?.id ?? null;
    renamingId = null;
    persist();
    renderAll();
    selectFeature(selectedId);
    if (rebuild) scheduleRebuild();
  }

  function touchSourceLabel(): void {
    sourceLabel.textContent = sourceFile || '未加载来源文件（untitled）';
    sourceLabel.title = sourceFile || 'untitled';
  }

  function persist(): void {
    try {
      store?.set(sourceFile, currentAssembly());
    } catch {
      // localStorage 不可用时仍允许编辑与导出 JSON。
    }
  }

  function validation(): string[] {
    return validateFeatures(currentAssembly());
  }

  function refreshState(): void {
    const label = STATUS_LABELS[statusView.status];
    stateLabel.textContent = label;
    stateMessage.textContent = statusView.message;
    stateDot.dataset.state = statusView.status;
    stateDot.title = statusView.message;
  }

  function refreshFooter(): void {
    const text = formatBuildStatus(lastBuildMs, lastStats ?? null);
    buildStatus.textContent = `${STATUS_LABELS[statusView.status]} · ${text}`;
    buildHint.textContent = building
      ? '正在重建…'
      : lastBuildError || (statusView.status === 'ready'
        ? stlLoaded ? '已载入视口 · 旧模型可开关对比' : '重建后显示耗时、面数与体积'
        : statusView.message);
    const canBuild = statusView.status === 'ready' || statusView.status === 'stopped';
    rebuildButton.disabled = validationErrors.length > 0 || building || !canBuild;
    rebuildButton.textContent = building ? '重建中…' : '重建';
    rebuildButton.title = validationErrors.length > 0
      ? '校验未通过，禁止重建'
      : canBuild
        ? ''
        : statusView.message;
    for (const button of exportButtons) {
      const format = button.dataset.paramExport as 'step' | 'stl' | undefined;
      button.disabled = !format || !pathOf(lastFiles, format);
    }
    exportBomButton.disabled = instances.length === 0;
    sendCostButton.disabled = instances.length === 0;
  }

  function refreshIssues(): void {
    validationErrors = validation();
    issueCount.textContent = String(validationErrors.length);
    issues.innerHTML = validationErrors.length === 0
      ? '<div class="cad-param-ok">校验通过，可重建。</div>'
      : validationErrors.map((message) =>
          `<div class="cad-param-issue"><b>错误</b><span>${escapeHtml(message)}</span></div>`
        ).join('');
  }

  function refreshSummary(): void {
    const assembly = currentAssembly();
    const features = instanceFeatures(assembly);
    const info = summarize({ schemaVersion: 1, features, updatedAt: assembly.updatedAt });
    summary.textContent = info.suppressed > 0
      ? `${assembly.instances.length} 实体 · ${info.features} 特征 · ${info.holes} 孔 · ${info.suppressed} 抑制`
      : `${assembly.instances.length} 实体 · ${info.features} 特征 · ${info.holes} 孔`;
    featureCount.textContent = String(doc.features.length);
    instanceCount.textContent = String(assembly.instances.length);
  }

  function formatTransform(transform: PartInstance['transform']): string {
    const value = (item: unknown): string => typeof item === 'number' && Number.isFinite(item)
      ? String(Math.round(item * 100) / 100)
      : '—';
    return `X ${value(transform.x)} · Y ${value(transform.y)} · Z ${value(transform.z)} · RZ ${value(transform.rz)}`;
  }

  function renderInstances(): void {
    instanceList.innerHTML = instances.map((instance, index) => {
      const selected = instance.id === selectedInstanceId ? ' is-selected' : '';
      const mapped = typeof instance.partId === 'string' && instance.partId.trim()
        ? `<span class="cad-param-mapped">${escapeHtml(instance.partId.trim())}</span>`
        : '<span class="cad-param-unmapped">未映射</span>';
      return `<div class="cad-param-instance${selected}" data-param-instance="${escapeHtml(instance.id)}">
        <button type="button" class="cad-param-instance-main" data-param-instance-select="${escapeHtml(instance.id)}" title="${escapeHtml(instance.name)}">
          <b>${index + 1}</b><span>${escapeHtml(instance.name)}</span>${mapped}
        </button>
        <span class="cad-param-instance-transform">${escapeHtml(formatTransform(instance.transform))}</span>
        <button type="button" class="cad-param-instance-delete" data-param-instance-delete="${escapeHtml(instance.id)}" title="删除实体">×</button>
      </div>`;
    }).join('');
    renderInstanceForm();
  }

  function renderInstanceForm(): void {
    const instance = currentInstance();
    if (!instance) {
      instanceForm.innerHTML = '<div class="cad-param-empty">新增实体后编辑位置与物料号。</div>';
      return;
    }
    instanceForm.innerHTML = `
      <div class="cad-param-grid">
        <label class="cad-param-field"><span>实体名称</span>
          <input type="text" data-param-inst-name value="${escapeHtml(instance.name)}" aria-label="实体名称"></label>
        <label class="cad-param-field"><span>物料号 partId</span>
          <input type="text" data-param-inst-partid value="${escapeHtml(instance.partId ?? '')}" placeholder="留空则标记未映射" aria-label="物料号"></label>
        ${(['x', 'y', 'z', 'rz'] as const).map((axis) => `<label class="cad-param-field"><span>${axis.toUpperCase()}${axis === 'rz' ? ' (°)' : ' (mm)'}</span>
          <input type="number" step="1" data-param-inst-transform="${axis}" value="${numberText(instance.transform[axis], '0')}" aria-label="实体 ${axis}"></label>`).join('')}
      </div>`;
  }

  function refreshBom(): void {
    const rows = toBom(currentAssembly());
    bomCount.textContent = String(rows.length);
    bomList.innerHTML = rows.length === 0
      ? '<div class="cad-param-empty">还没有可汇总的实体。</div>'
      : `<div class="cad-param-bom-head"><span>序号</span><span>名称</span><span>物料号</span><span>规格</span><span>数量</span></div>` +
        rows.map((row) => `<div class="cad-param-bom-row" data-param-bom-row="${row.no}">
          <span>${row.no}</span><span>${escapeHtml(row.name)}</span>
          <span class="${row.unmapped ? 'cad-param-unmapped' : 'cad-param-mapped'}">${row.unmapped ? '未映射' : escapeHtml(row.partId ?? '')}</span>
          <span>${escapeHtml(row.spec)}</span><span>${row.qty}</span>
        </div>`).join('');
  }

  function iconFor(type: FeatureType): string {
    return FEATURE_SPECS[type].icon;
  }

  function featureRow(feature: FeatureNode): string {
    const spec = FEATURE_SPECS[feature.type];
    const selected = feature.id === selectedId ? ' is-selected' : '';
    const suppressed = feature.suppressed === true ? ' is-suppressed' : '';
    const name = renamingId === feature.id
      ? `<input class="cad-param-rename" data-param-rename-input value="${escapeHtml(feature.name)}" aria-label="特征名称">`
      : `<span class="cad-param-feature-name">${escapeHtml(feature.name)}</span>`;
    return `<div class="cad-param-feature${selected}${suppressed}" data-param-feature="${escapeHtml(feature.id)}">
      <button type="button" class="cad-param-feature-main" data-param-select="${escapeHtml(feature.id)}" title="${escapeHtml(feature.name)}">
        <span class="cad-param-feature-icon">${iconFor(feature.type)}</span>
        ${name}
        <span class="cad-param-feature-type">${escapeHtml(spec.label)}</span>
      </button>
      <div class="cad-param-feature-ops">
        <button type="button" data-param-op="up" data-param-id="${escapeHtml(feature.id)}" title="上移">↑</button>
        <button type="button" data-param-op="down" data-param-id="${escapeHtml(feature.id)}" title="下移">↓</button>
        <button type="button" data-param-op="suppress" data-param-id="${escapeHtml(feature.id)}" title="${feature.suppressed === true ? '恢复' : '抑制'}">${feature.suppressed === true ? '恢复' : '抑制'}</button>
        <button type="button" data-param-op="rename" data-param-id="${escapeHtml(feature.id)}" title="重命名">改名</button>
        <button type="button" data-param-op="delete" data-param-id="${escapeHtml(feature.id)}" title="删除">删除</button>
      </div>
    </div>`;
  }

  function renderFeatures(): void {
    featureList.innerHTML = doc.features.length === 0
      ? '<div class="cad-param-empty">还没有特征。先新增底板，再添加孔、槽和圆角。</div>'
      : doc.features.map(featureRow).join('');
    if (renamingId) {
      const input = featureList.querySelector<HTMLInputElement>('[data-param-rename-input]');
      input?.focus();
      input?.select();
    }
  }

  function fieldValue(feature: FeatureNode, key: string): unknown {
    return feature.params[key];
  }

  function fieldControl(feature: FeatureNode, kind: string, key: string, label: string, optionsHtml: string): string {
    if (kind === 'select') return optionsHtml;
    if (kind === 'vector3') {
      const raw = fieldValue(feature, key);
      const values = Array.isArray(raw) ? raw : [0, 0, 0];
      return ['X', 'Y', 'Z'].map((axis, index) =>
        `<span class="cad-param-vector-cell"><i>${axis}</i><input type="number" step="1" data-param-field="${key}" data-param-vector="${index}" value="${numberText(values[index], '0')}" aria-label="${escapeHtml(label)} ${axis}"></span>`
      ).join('');
    }
    const raw = fieldValue(feature, key);
    if (kind === 'number') {
      return `<input type="number" data-param-field="${key}" value="${numberText(raw)}" aria-label="${escapeHtml(label)}">`;
    }
    return `<input type="text" data-param-field="${key}" value="${raw === undefined ? '' : escapeHtml(String(raw))}" aria-label="${escapeHtml(label)}">`;
  }

  function renderForm(): void {
    const feature = findFeature(doc, selectedId);
    if (!feature) {
      form.innerHTML = '<div class="cad-param-empty">选择上方特征后编辑参数。</div>';
      return;
    }
    const spec = FEATURE_SPECS[feature.type];
    const fields = spec.fields.map((field) => {
      if (field.kind === 'select') {
        const current = String(fieldValue(feature, field.key) ?? '');
        const options = (field.options ?? []).map((option) =>
          `<option value="${escapeHtml(option.value)}"${option.value === current ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
        ).join('');
        return `<label class="cad-param-field"><span>${escapeHtml(field.label)}</span>
          <select data-param-field="${field.key}">${options}</select></label>`;
      }
      return `<label class="cad-param-field${field.kind === 'vector3' ? ' is-wide' : ''}">
        <span>${escapeHtml(field.label)}${field.unit ? `<i>${escapeHtml(field.unit)}</i>` : ''}</span>
        <span class="cad-param-control ${field.kind === 'vector3' ? 'is-vector' : ''}">
          ${fieldControl(feature, field.kind, field.key, field.label, '')}
        </span>
      </label>`;
    }).join('');

    const centered = feature.type === 'box'
      ? `<label class="cad-param-inline"><input type="checkbox" data-param-centered${feature.params.centered === false ? '' : ' checked'}> 以原点为中心（XY）</label>`
      : '';
    const positions = feature.type === 'holes'
      ? `<div class="cad-param-holes">
          <div class="cad-param-subhead"><span>孔位 X / Y</span><b>${(feature.params.positions as unknown[] | undefined)?.length ?? 0}</b></div>
          ${holeRows(feature)}
          <button type="button" class="cad-btn" data-param-hole-add>新增孔位</button>
        </div>`
      : '';

    form.innerHTML = `
      <div class="cad-param-form-head">
        <span class="cad-param-feature-icon">${iconFor(feature.type)}</span>
        <b>${escapeHtml(feature.name)}</b>
        <em>${escapeHtml(spec.label)}</em>
      </div>
      <div class="cad-param-grid">${fields}</div>
      ${centered}
      ${positions}`;
  }

  function holeRows(feature: FeatureNode): string {
    const raw = feature.params.positions;
    const positions = Array.isArray(raw) ? raw : [];
    if (positions.length === 0) return '<div class="cad-param-empty">没有孔位，点击下方按钮新增。</div>';
    return positions.map((item, index) => {
      const pair = Array.isArray(item) ? item : [0, 0];
      return `<div class="cad-param-hole-row" data-param-hole="${index}">
        <span class="cad-param-hole-index">${index + 1}</span>
        <input type="number" step="1" data-param-hole-x="${index}" value="${numberText(pair[0], '0')}" aria-label="孔位 ${index + 1} X">
        <input type="number" step="1" data-param-hole-y="${index}" value="${numberText(pair[1], '0')}" aria-label="孔位 ${index + 1} Y">
        <button type="button" data-param-hole-delete="${index}" title="删除孔位">×</button>
      </div>`;
    }).join('');
  }

  function renderAll(): void {
    touchSourceLabel();
    refreshSummary();
    renderInstances();
    renderFeatures();
    renderForm();
    refreshIssues();
    refreshBom();
    refreshState();
    refreshFooter();
  }

  function refreshLight(): void {
    refreshSummary();
    renderInstances();
    renderFeatures();
    refreshIssues();
    refreshBom();
    refreshFooter();
  }

  function selectFeature(id: string | null): void {
    selectedId = id;
    renderFeatures();
    renderForm();
    const feature = findFeature(doc, id);
    const bounds = feature ? featureBounds(feature, doc) ?? docBounds(doc) : null;
    viewer.highlightBounds(bounds);
  }

  function clearDebounce(): void {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
      debounceTimer = 0;
    }
  }

  function scheduleRebuild(): void {
    clearDebounce();
    if (!autoRebuild) return;
    const plan = debouncePlan(now(), now(), { delayMs: debounceMs, enabled: true });
    debounceTimer = window.setTimeout(() => {
      debounceTimer = 0;
      void rebuild();
    }, plan.waitMs);
  }

  function setStatus(next: ParametricUiStatus): void {
    statusView = next;
    refreshState();
    refreshFooter();
  }

  async function ensureStarted(): Promise<void> {
    const parametric = api();
    if (!parametric) {
      setStatus({ status: 'unavailable', message: '参数化建模仅桌面端可用' });
      return;
    }
    try {
      const status = await parametric.status();
      setStatus(status);
      if (status.status !== 'stopped') return;
      setStatus({ status: 'starting', message: '正在启动参数化建模内核…' });
      const started = await parametric.start();
      setStatus({
        status: started.status,
        message: started.message,
        ...(started.version ? { version: started.version } : {})
      });
    } catch (error) {
      setStatus({
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function rebuild(): Promise<ParametricBuildLike> {
    if (building) {
      pendingBuild = true;
      return { ok: false, code: 'BUILD_FAILED', message: '已有重建任务在进行' };
    }
    refreshIssues();
    if (validationErrors.length > 0) {
      refreshFooter();
      return { ok: false, code: 'BUILD_FAILED', message: `校验未通过：${validationErrors.join('；')}` };
    }
    const parametric = api();
    if (!parametric) {
      setStatus({ status: 'unavailable', message: '参数化建模仅桌面端可用' });
      return { ok: false, code: 'UNAVAILABLE', message: '参数化建模仅桌面端可用' };
    }
    if (statusView.status === 'stopped') await ensureStarted();
    if (statusView.status !== 'ready') {
      refreshFooter();
      return { ok: false, code: 'UNAVAILABLE', message: statusView.message };
    }

    building = true;
    lastBuildError = '';
    refreshFooter();
    notify('正在重建参数化模型…');
    try {
      const result = await parametric.build(currentAssembly());
      if (!result.ok) {
        const message = result.message ?? '重建失败';
        lastBuildError = message;
        if (result.code === 'UNAVAILABLE') setStatus({ status: 'unavailable', message });
        notify(message, true);
        return result;
      }
      lastBuildMs = result.buildMs;
      lastStats = result.stats;
      lastFiles = result.files;
      lastBuildError = '';
      stlLoaded = false;
      const stlPath = pathOf(result.files, 'stl');
      if (stlPath) {
        try {
          const parsed = await options.loadStl(stlPath);
          viewer.load(parsed, '参数化重建.stl', { ghost: compareOld });
          viewer.setGhostVisible(compareOld);
          stlLoaded = true;
        } catch (error) {
          notify(`STL 已生成但载入视口失败：${error instanceof Error ? error.message : String(error)}`, true);
        }
      }
      buildStatus.textContent = `${STATUS_LABELS[statusView.status]} · ${formatBuildStatus(lastBuildMs, lastStats ?? null)}`;
      buildHint.textContent = stlLoaded ? '已载入视口 · 旧模型可开关对比' : '已重建 · 未载入视口';
      persist();
      selectedId = selectedId && findFeature(doc, selectedId) ? selectedId : doc.features[0]?.id ?? null;
      selectFeature(selectedId);
      notify(`参数化重建完成 · ${formatBuildStatus(lastBuildMs, lastStats ?? null)}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastBuildError = `重建失败：${message}`;
      notify(`重建失败：${message}`, true);
      return { ok: false, code: 'BUILD_FAILED', message };
    } finally {
      building = false;
      refreshFooter();
      if (pendingBuild) {
        pendingBuild = false;
        void rebuild();
      }
    }
  }

  function readFieldValue(kind: string, raw: string): unknown {
    if (kind === 'text') {
      const text = raw.trim();
      if (!text) return '';
      if (text === 'through') return 'through';
      const value = Number(text);
      return Number.isFinite(value) ? value : text;
    }
    if (kind === 'select') return raw;
    if (!raw.trim()) return '';
    const value = Number(raw);
    return Number.isFinite(value) ? value : raw;
  }

  function applyParamInput(target: HTMLElement): void {
    const feature = findFeature(doc, selectedId);
    if (!feature) return;
    const fieldKey = target.dataset.paramField;
    if (fieldKey) {
      const spec = FEATURE_SPECS[feature.type].fields.find((field) => field.key === fieldKey);
      if (!spec) return;
      if (spec.kind === 'vector3') {
        const index = Number((target as HTMLInputElement).dataset.paramVector);
        const current = Array.isArray(feature.params[fieldKey]) ? [...(feature.params[fieldKey] as unknown[])] : [0, 0, 0];
        current[index] = readFieldValue('number', (target as HTMLInputElement).value);
        doc = updateParams(doc, feature.id, { [fieldKey]: current }, now());
      } else {
        doc = updateParams(doc, feature.id, {
          [fieldKey]: readFieldValue(spec.kind, (target as HTMLInputElement | HTMLSelectElement).value)
        }, now());
      }
    } else if (target.dataset.paramCentered !== undefined) {
      doc = updateParams(doc, feature.id, { centered: (target as HTMLInputElement).checked }, now());
    } else {
      const xIndex = target.dataset.paramHoleX;
      const yIndex = target.dataset.paramHoleY;
      const index = xIndex ?? yIndex;
      if (index === undefined) return;
      const positions = Array.isArray(feature.params.positions)
        ? (feature.params.positions as unknown[]).map((item) => Array.isArray(item) ? [...item] : [0, 0])
        : [];
      const targetIndex = Number(index);
      const row = positions[targetIndex] ?? [0, 0];
      const value = readFieldValue('number', (target as HTMLInputElement).value);
      if (xIndex !== undefined) row[0] = value;
      else row[1] = value;
      positions[targetIndex] = row;
      doc = updateParams(doc, feature.id, { positions }, now());
    }
    persist();
    refreshLight();
    scheduleRebuild();
  }

  function addHole(): void {
    const feature = findFeature(doc, selectedId);
    if (!feature || feature.type !== 'holes') return;
    const positions = Array.isArray(feature.params.positions)
      ? (feature.params.positions as unknown[]).map((item) => Array.isArray(item) ? [...item] : [0, 0])
      : [];
    positions.push([0, 0]);
    doc = updateParams(doc, feature.id, { positions }, now());
    persist();
    refreshLight();
    renderForm();
    scheduleRebuild();
  }

  function deleteHole(index: number): void {
    const feature = findFeature(doc, selectedId);
    if (!feature || feature.type !== 'holes') return;
    const positions = Array.isArray(feature.params.positions)
      ? (feature.params.positions as unknown[]).filter((_item, position) => position !== index)
      : [];
    doc = updateParams(doc, feature.id, { positions }, now());
    persist();
    refreshLight();
    renderForm();
    scheduleRebuild();
  }

  async function exportModel(format: 'step' | 'stl'): Promise<void> {
    const path = pathOf(lastFiles, format);
    if (!path) {
      notify(`没有可导出的 ${format.toUpperCase()}，请先重建`, true);
      return;
    }
    const desktopApi = window.desktop;
    if (!desktopApi) {
      notify('模型导出仅桌面端可用', true);
      return;
    }
    try {
      const bytes = await desktopApi.readFileBuffer(path);
      const result = await desktopApi.exportFile(`${safeBaseName(sourceFile || 'parametric')}.${format}`, bytes);
      if (result.canceled) notify('已取消导出');
      else notify(`${format.toUpperCase()} 已导出：${result.path ?? ''}`);
    } catch (error) {
      notify(`导出 ${format.toUpperCase()} 失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  async function exportBom(): Promise<void> {
    const csv = bomToCsv(toBom(currentAssembly()));
    const desktopApi = window.desktop;
    if (desktopApi) {
      try {
        const result = await desktopApi.exportFile(`${safeBaseName(sourceFile || 'parametric')}.bom.csv`, csv);
        if (result.canceled) notify('已取消导出 BOM');
        else notify(`BOM 已导出：${result.path ?? ''}`);
        return;
      } catch (error) {
        notify(`导出 BOM 失败：${error instanceof Error ? error.message : String(error)}`, true);
        return;
      }
    }
    try {
      await navigator.clipboard?.writeText(csv.replace(/^\uFEFF/, ''));
      notify('BOM CSV 已复制到剪贴板');
    } catch {
      notify('剪贴板不可用，BOM 未导出', true);
    }
  }

  function sendBomToCost(): void {
    const input = toCostInput(currentAssembly());
    const panel = window.__CostPanel;
    if (!panel) {
      notify('成本面板不可用，请先打开成本面板', true);
      return;
    }
    panel.setBom(input, '参数化装配 BOM');
    panel.open();
    notify(`已送成本面板：${input.bom.length} 行；未映射件按 NO_PART_ID 缺价，不猜物料号`);
  }

  async function saveTree(): Promise<void> {
    persist();
    const text = serializeDoc(currentAssembly());
    const desktopApi = window.desktop;
    if (desktopApi) {
      try {
        const result = await desktopApi.exportFile(`${safeBaseName(sourceFile || 'untitled')}.parametric.json`, text);
        if (result.canceled) notify('已保存到本地存储（已取消文件导出）');
        else notify(`特征树已保存：${result.path ?? ''}`);
        return;
      } catch (error) {
        notify(`文件保存失败：${error instanceof Error ? error.message : String(error)}`, true);
        return;
      }
    }
    try {
      await navigator.clipboard?.writeText(text);
      notify('已保存到 localStorage，并复制 JSON 到剪贴板');
    } catch {
      notify('已保存到 localStorage；剪贴板不可用', true);
    }
  }

  function loadTreeText(text: string): void {
    const parsed = deserializeDoc(text, now());
    if (!parsed.ok || !parsed.doc) {
      notify(parsed.errors[0] ?? '特征树载入失败', true);
      return;
    }
    const next = parsed.doc;
    const assembly = toAssembly(next);
    applyAssembly(assembly, { keepSelection: false });
    notify(`已载入 ${assembly.instances.length} 个实体 · ${instanceFeatures(assembly).length} 个特征`);
  }

  function setSource(nextSource: string): void {
    sourceFile = nextSource.trim();
    const saved = store?.get(sourceFile) ?? null;
    const assembly = saved
      ? toAssembly(saved)
      : makeAssembly([blankInstance('p1', '零件 1')], {
          ...(sourceFile ? { sourceFile } : {}),
          now: now()
        });
    instances = assembly.instances;
    selectedInstanceId = instances[0]?.id ?? null;
    const instance = currentInstance();
    doc = instance
      ? featureDocFor(instance, assembly.updatedAt)
      : makeDoc([], { ...(sourceFile ? { sourceFile } : {}), now: now() });
    selectedId = doc.features[0]?.id ?? null;
    renamingId = null;
    lastBuildMs = undefined;
    lastStats = undefined;
    lastFiles = undefined;
    lastBuildError = '';
    stlLoaded = false;
    renderAll();
    selectFeature(selectedId);
  }

  function selectInstance(id: string): void {
    if (id === selectedInstanceId) return;
    syncSelectedFeatures();
    const instance = instances.find((item) => item.id === id);
    if (!instance) return;
    selectedInstanceId = id;
    doc = featureDocFor(instance, doc.updatedAt);
    selectedId = doc.features[0]?.id ?? null;
    persist();
    renderAll();
    selectFeature(selectedId);
  }

  instanceList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-param-instance-delete]');
    if (remove) {
      const id = remove.dataset.paramInstanceDelete ?? '';
      const next = removeInstance(currentAssembly(), id, now());
      if (next.instances.length === instances.length) {
        notify('至少保留一个实体', true);
        return;
      }
      const deletedSelected = id === selectedInstanceId;
      instances = next.instances;
      if (deletedSelected) selectedInstanceId = next.instances[0]?.id ?? null;
      const instance = currentInstance();
      doc = featureDocFor(instance ?? blankInstance('p1', '零件 1'), next.updatedAt);
      selectedId = doc.features[0]?.id ?? null;
      persist();
      renderAll();
      selectFeature(selectedId);
      scheduleRebuild();
      return;
    }
    const select = target.closest<HTMLElement>('[data-param-instance-select]');
    if (select) selectInstance(select.dataset.paramInstanceSelect ?? '');
  });

  instanceForm.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    const instance = currentInstance();
    if (!instance) return;
    const assembly = currentAssembly();
    if (target.dataset.paramInstName !== undefined) {
      instances = renameInstance(assembly, instance.id, target.value, now()).instances;
    } else if (target.dataset.paramInstPartid !== undefined) {
      instances = setInstancePartId(assembly, instance.id, target.value, now()).instances;
    } else {
      const axis = target.dataset.paramInstTransform as 'x' | 'y' | 'z' | 'rz' | undefined;
      if (!axis) return;
      const value = readFieldValue('number', target.value) as number;
      instances = updateInstanceTransform(assembly, instance.id, { [axis]: value }, now()).instances;
    }
    persist();
    renderAll();
    selectFeature(selectedId);
    scheduleRebuild();
  });

  query<HTMLButtonElement>('[data-param-instance-add]').addEventListener('click', () => {
    const result = addInstance(currentAssembly(), { now: now() });
    instances = result.assembly.instances;
    selectedInstanceId = result.instance.id;
    doc = featureDocFor(result.instance, result.assembly.updatedAt);
    selectedId = doc.features[0]?.id ?? null;
    persist();
    renderAll();
    selectFeature(selectedId);
    scheduleRebuild();
  });

  addButton.addEventListener('click', () => {
    const type = addType.value as FeatureType;
    const added = addFeature(doc, type, { now: now() });
    doc = added.doc;
    selectedId = added.feature.id;
    persist();
    renderAll();
    selectFeature(selectedId);
    scheduleRebuild();
  });

  featureList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const op = target.closest<HTMLElement>('[data-param-op]');
    if (op) {
      const id = op.dataset.paramId ?? '';
      const action = op.dataset.paramOp;
      if (action === 'up' || action === 'down') doc = moveFeature(doc, id, action, now());
      else if (action === 'suppress') {
        const feature = findFeature(doc, id);
        if (feature) doc = setSuppressed(doc, id, feature.suppressed !== true, now());
      } else if (action === 'delete') {
        doc = removeFeature(doc, id, now());
        if (selectedId === id) selectedId = doc.features[0]?.id ?? null;
      } else if (action === 'rename') {
        renamingId = renamingId === id ? null : id;
        renderFeatures();
        return;
      }
      persist();
      renderAll();
      selectFeature(selectedId);
      scheduleRebuild();
      return;
    }
    const select = target.closest<HTMLElement>('[data-param-select]');
    if (select) {
      selectFeature(select.dataset.paramSelect ?? null);
      renderForm();
    }
  });

  featureList.addEventListener('keydown', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-param-rename-input]');
    if (!input) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const id = renamingId;
      renamingId = null;
      if (id) {
        doc = renameFeature(doc, id, input.value, now());
        persist();
        renderAll();
        selectFeature(selectedId);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renamingId = null;
      renderFeatures();
    }
  });

  featureList.addEventListener('focusout', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-param-rename-input]');
    if (!input || !renamingId) return;
    const id = renamingId;
    renamingId = null;
    doc = renameFeature(doc, id, input.value, now());
    persist();
    renderAll();
    selectFeature(selectedId);
  });

  form.addEventListener('input', (event) => {
    applyParamInput(event.target as HTMLElement);
  });

  form.addEventListener('change', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-param-field]') || target.matches('[data-param-centered]')) {
      applyParamInput(target);
      if (target.matches('select')) renderForm();
    }
  });

  form.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-param-hole-add]')) {
      addHole();
      return;
    }
    const remove = target.closest<HTMLElement>('[data-param-hole-delete]');
    if (remove) deleteHole(Number(remove.dataset.paramHoleDelete));
  });

  rebuildButton.addEventListener('click', () => {
    void rebuild();
  });

  for (const button of exportButtons) {
    button.addEventListener('click', () => {
      const format = button.dataset.paramExport as 'step' | 'stl' | undefined;
      if (format) void exportModel(format);
    });
  }

  exportBomButton.addEventListener('click', () => {
    void exportBom();
  });

  sendCostButton.addEventListener('click', () => {
    sendBomToCost();
  });

  saveButton.addEventListener('click', () => {
    void saveTree();
  });

  loadButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void file.text().then(loadTreeText).catch((error: unknown) => {
      notify(`读取特征树失败：${error instanceof Error ? error.message : String(error)}`, true);
    });
  });

  autoInput.addEventListener('change', () => {
    autoRebuild = autoInput.checked;
    if (autoRebuild) scheduleRebuild();
    else clearDebounce();
  });

  compareInput.addEventListener('change', () => {
    compareOld = compareInput.checked;
    if (viewer.ghostVisible() || !compareOld) viewer.setGhostVisible(compareOld);
  });

  query<HTMLButtonElement>('[data-param-close]').addEventListener('click', () => {
    container.hidden = true;
    viewer.highlightBounds(null);
    options.onOpenChange?.(false);
  });

  api()?.onStatus((next) => {
    setStatus(next);
  });

  const handle: ParametricUiHandle = {
    open(): void {
      container.hidden = false;
      options.onOpenChange?.(true);
      void ensureStarted();
    },
    close(): void {
      container.hidden = true;
      clearDebounce();
      viewer.highlightBounds(null);
      options.onOpenChange?.(false);
    },
    isOpen(): boolean {
      return !container.hidden;
    },
    setSource(nextSource: string): void {
      setSource(nextSource);
    },
    setDoc(next: FeatureDoc | AssemblyDoc): void {
      applyAssembly(toAssembly(next), { keepSelection: false });
    },
    getDoc(): AssemblyDoc {
      return JSON.parse(serializeDoc(currentAssembly())) as AssemblyDoc;
    },
    build: rebuild,
    state(): ParametricUiState {
      return {
        sourceFile: storageBucketKey(sourceFile),
        features: instanceFeatures(currentAssembly()).length,
        instances: instances.length,
        bomRows: toBom(currentAssembly()).length,
        selected: selectedId,
        validationErrors: validationErrors.length,
        status: statusView.status,
        statusLabel: STATUS_LABELS[statusView.status],
        buildStatus: formatBuildStatus(lastBuildMs, lastStats ?? null),
        building,
        stlLoaded,
        ghost: viewer.ghostVisible()
      };
    }
  };

  setSource(sourceFile);
  autoInput.checked = autoRebuild;
  compareInput.checked = compareOld;
  void ensureStarted();
  return handle;
}
