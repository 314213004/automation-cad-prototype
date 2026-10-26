// 参数化抽屉里的「工程图（FreeCAD）」分区：出图入口、进度、结果、过期标记、未安装提示。
// 只访问 DOM 与 window.desktop.drawings；过期判定复用 stale.ts 纯逻辑（不为每次编辑走 IPC）。
import type { AssemblyDoc } from '../parametric/features.ts';
import { drawingStatus, planDrawingParts, type DrawingManifest, type DrawingPartMeta, type DrawingStatusReport } from './stale.ts';

export const DRAWINGS_STORAGE_KEY = 'automationcad.drawings.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface DrawingsPrefs {
  version: 1;
  titleBlock: { designer: string; company: string };
  autoRegenerate: boolean;
  meta: Record<string, Record<string, DrawingPartMeta>>;
}

type DrawingsApi = NonNullable<Window['desktop']>['drawings'];

export interface DrawingsUiOptions {
  host: HTMLElement;
  getDoc: () => AssemblyDoc | null;
  getSelectedInstanceId: () => string | null;
  getProjectKey: () => string;
  isEnabled: () => boolean;
  notify?: (message: string, error?: boolean) => void;
  storage?: StorageLike | null;
  api?: () => DrawingsApi | undefined;
  pollMs?: number;
  autoDelayMs?: number;
}

export interface DrawingsUiState {
  enabled: boolean;
  freecadAvailable: boolean;
  freecadVersion: string | null;
  freecadReason: string;
  projectKey: string;
  parts: number;
  fresh: number;
  stale: number;
  missing: number;
  job: { jobId: string; state: string; done: number; total: number; message: string } | null;
  autoRegenerate: boolean;
}

export interface DrawingsUiHandle {
  refresh(): Promise<void>;
  setEnabled(enabled: boolean): void;
  state(): DrawingsUiState;
  generate(scope: 'selected' | 'all' | 'stale'): Promise<{ ok: boolean; message: string; jobId?: string }>;
  report(): DrawingStatusReport | null;
  destroy(): void;
}

const STATUS_LABEL: Record<string, string> = { fresh: '最新', stale: '过期', missing: '未出图' };
const ACTIVE_STATES = new Set(['queued', 'preparing', 'running']);

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readPrefs(storage: StorageLike | null): DrawingsPrefs {
  const base: DrawingsPrefs = { version: 1, titleBlock: { designer: '', company: '' }, autoRegenerate: false, meta: {} };
  if (!storage) return base;
  try {
    const raw = JSON.parse(storage.getItem(DRAWINGS_STORAGE_KEY) ?? 'null') as Partial<DrawingsPrefs> | null;
    if (!raw || raw.version !== 1) return base;
    return {
      version: 1,
      titleBlock: {
        designer: typeof raw.titleBlock?.designer === 'string' ? raw.titleBlock.designer : '',
        company: typeof raw.titleBlock?.company === 'string' ? raw.titleBlock.company : ''
      },
      autoRegenerate: raw.autoRegenerate === true,
      meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
    };
  } catch {
    return base;
  }
}

export function initDrawingsUi(options: DrawingsUiOptions): DrawingsUiHandle {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const api = options.api ?? (() => window.desktop?.drawings);
  const pollMs = options.pollMs ?? 1500;
  const autoDelayMs = options.autoDelayMs ?? 3000;
  const prefs = readPrefs(storage);
  const host = options.host;
  let enabled = options.isEnabled();
  let info: DesktopFreecadInfo | null = null;
  let manifest: DrawingManifest | null = null;
  let manifestKey = '';
  let report: DrawingStatusReport | null = null;
  let lastDocSignature = '';
  let job: DesktopDrawingJobSnapshot | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  host.classList.add('cad-param-section', 'cad-dwg');
  host.dataset.drawingsSection = '1';
  host.innerHTML = `
    <div class="cad-param-section-head"><span>工程图（FreeCAD）</span><b data-dwg-count>0</b></div>
    <div class="cad-dwg-status">
      <span class="cad-param-dot" data-dwg-dot></span>
      <span data-dwg-status>正在检测 FreeCAD…</span>
    </div>
    <div class="cad-dwg-hint" data-dwg-hint hidden></div>
    <div class="cad-dwg-tools">
      <button type="button" class="cad-btn" data-dwg-detect>重新检测</button>
      <button type="button" class="cad-btn" data-dwg-choose>指定 freecadcmd 路径…</button>
    </div>
    <div class="cad-dwg-title">
      <label>设计 <input data-dwg-designer maxlength="40" placeholder="设计者"></label>
      <label>单位 <input data-dwg-company maxlength="60" placeholder="公司/单位"></label>
    </div>
    <div class="cad-dwg-parts" data-dwg-parts><div class="cad-param-empty">特征树为空，先新增实体再出图。</div></div>
    <div class="cad-dwg-actions">
      <button type="button" class="cad-btn cad-btn-primary" data-dwg-gen="selected">选中零件出图</button>
      <button type="button" class="cad-btn" data-dwg-gen="all">全部出图</button>
      <button type="button" class="cad-btn" data-dwg-gen="stale">重出过期</button>
      <button type="button" class="cad-btn" data-dwg-cancel hidden>取消</button>
      <button type="button" class="cad-btn" data-dwg-reveal>图纸目录</button>
    </div>
    <label class="cad-dwg-auto"><input type="checkbox" data-dwg-auto> 参数改动后自动重出过期图纸</label>
    <div class="cad-dwg-progress" data-dwg-progress></div>`;

  const q = <T extends HTMLElement>(selector: string): T => {
    const node = host.querySelector<T>(selector);
    if (!node) throw new Error(`工程图分区节点缺失：${selector}`);
    return node;
  };
  const dot = q<HTMLElement>('[data-dwg-dot]');
  const statusText = q<HTMLElement>('[data-dwg-status]');
  const hint = q<HTMLElement>('[data-dwg-hint]');
  const count = q<HTMLElement>('[data-dwg-count]');
  const partsBox = q<HTMLElement>('[data-dwg-parts]');
  const progress = q<HTMLElement>('[data-dwg-progress]');
  const designer = q<HTMLInputElement>('[data-dwg-designer]');
  const company = q<HTMLInputElement>('[data-dwg-company]');
  const autoInput = q<HTMLInputElement>('[data-dwg-auto]');
  const cancelButton = q<HTMLButtonElement>('[data-dwg-cancel]');
  const genButtons = [...host.querySelectorAll<HTMLButtonElement>('[data-dwg-gen]')];
  designer.value = prefs.titleBlock.designer;
  company.value = prefs.titleBlock.company;
  autoInput.checked = prefs.autoRegenerate;

  const notify = (message: string, error = false): void => options.notify?.(message, error);
  const savePrefs = (): void => {
    try {
      storage?.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // 本地偏好写失败不影响出图
    }
  };
  const projectKey = (): string => options.getProjectKey().trim() || 'untitled';
  const metaFor = (): Record<string, DrawingPartMeta> => prefs.meta[projectKey()] ?? {};
  const jobActive = (): boolean => Boolean(job && ACTIVE_STATES.has(job.state));

  function docOrNull(): AssemblyDoc | null {
    if (!enabled) return null;
    try {
      return options.getDoc();
    } catch {
      return null;
    }
  }

  function recompute(): void {
    const doc = docOrNull();
    if (!doc || !manifest) {
      report = null;
      return;
    }
    report = drawingStatus(manifest, planDrawingParts(doc, { meta: metaFor() }));
  }

  function renderStatus(): void {
    const available = Boolean(info?.available);
    dot.dataset.state = !enabled ? 'unavailable' : available ? 'ready' : info ? 'unavailable' : 'starting';
    statusText.textContent = !enabled
      ? '工程图模块已关闭'
      : !info
        ? '正在检测 FreeCAD…'
        : available
          ? `FreeCAD ${info.version ?? ''} 可用${info.source === 'configured' ? '（设置路径）' : ''}`
          : `FreeCAD 不可用：${info.reason}`;
    statusText.title = info?.path ?? '';
    hint.hidden = !enabled || !info || available;
    hint.textContent = info && !available ? `出图已禁用，建模不受影响。${info.installHint}` : '';
    const busy = jobActive();
    for (const button of genButtons) button.disabled = !enabled || !available || busy;
    cancelButton.hidden = !busy;
  }

  function renderParts(): void {
    const doc = docOrNull();
    const plan = doc ? planDrawingParts(doc, { meta: metaFor() }) : null;
    count.textContent = String(plan?.parts.length ?? 0);
    if (!plan || plan.parts.length === 0) {
      partsBox.innerHTML = `<div class="cad-param-empty">${enabled ? '特征树为空，先新增实体再出图。' : '模块已关闭'}</div>`;
      return;
    }
    const statusByKey = new Map((report?.parts ?? []).map((item) => [item.partKey, item]));
    const meta = metaFor();
    partsBox.innerHTML = `
      <div class="cad-dwg-row cad-dwg-row-head"><span>零件</span><span>材料</span><span>图号</span><span>状态</span><span></span></div>
      ${plan.parts.map((part) => {
        const status = statusByKey.get(part.partKey);
        const state = status?.status ?? 'missing';
        const entry = status?.entry;
        const files = entry?.files ?? {};
        return `<div class="cad-dwg-row" data-dwg-part="${escapeHtml(part.partKey)}">
          <span title="${escapeHtml(part.partKey)}">${escapeHtml(part.name)}${part.quantity > 1 ? ` ×${part.quantity}` : ''}${part.conflict ? ' ⚠' : ''}</span>
          <input data-dwg-meta="material" value="${escapeHtml(meta[part.partKey]?.material ?? '')}" placeholder="如 6061-T6" maxlength="40">
          <input data-dwg-meta="drawingNo" value="${escapeHtml(meta[part.partKey]?.drawingNo ?? '')}" placeholder="${escapeHtml(part.partId)}" maxlength="40">
          <span class="cad-dwg-badge" data-state="${state}" title="${escapeHtml(status?.reason ?? '')}">${STATUS_LABEL[state] ?? state}</span>
          <span class="cad-dwg-open">
            <button type="button" data-dwg-open="pdf" ${files.pdf ? '' : 'disabled'}>PDF</button>
            <button type="button" data-dwg-open="dxf" ${files.dxf ? '' : 'disabled'}>DXF</button>
            <button type="button" data-dwg-open="dir" ${entry ? '' : 'disabled'}>目录</button>
          </span>
        </div>`;
      }).join('')}
      ${report && report.orphans.length > 0 ? `<div class="cad-dwg-orphans">另有 ${report.orphans.length} 张图纸对应的零件已不在特征树中（文件保留）</div>` : ''}`;
  }

  function renderProgress(): void {
    if (!job) {
      progress.textContent = report && (report.staleKeys.length || report.missingKeys.length)
        ? `过期 ${report.staleKeys.length} · 未出图 ${report.missingKeys.length}`
        : '';
      return;
    }
    const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
    progress.textContent = ACTIVE_STATES.has(job.state) ? `${job.message}（${pct}%）` : job.message;
    progress.dataset.state = job.state;
  }

  function render(): void {
    renderStatus();
    renderParts();
    renderProgress();
    host.hidden = !enabled;
  }

  async function loadManifest(force = false): Promise<void> {
    const drawings = api();
    const key = projectKey();
    if (!drawings || !enabled) return;
    if (!force && manifest && manifestKey === key) return;
    const listed = await drawings.list(key);
    if (listed.ok) {
      manifest = listed.manifest;
      manifestKey = key;
    }
  }

  async function refresh(): Promise<void> {
    const drawings = api();
    if (!drawings || !enabled) {
      render();
      return;
    }
    const status = info ? await drawings.freecadStatus() : await drawings.detectFreecad();
    if (status.ok) info = status.info;
    if (status.ok && !status.info.checkedAt) {
      const detected = await drawings.detectFreecad();
      if (detected.ok) info = detected.info;
    }
    await loadManifest(true);
    recompute();
    render();
  }

  async function generate(scope: 'selected' | 'all' | 'stale'): Promise<{ ok: boolean; message: string; jobId?: string }> {
    const drawings = api();
    if (!drawings || !enabled) return { ok: false, message: '工程图模块不可用' };
    const doc = docOrNull();
    if (!doc) return { ok: false, message: '参数化特征树不可用' };
    const selected = options.getSelectedInstanceId();
    if (scope === 'selected' && !selected) return { ok: false, message: '请先在「装配实体」里选中一个零件' };
    const response = await drawings.generate({
      projectKey: projectKey(),
      doc,
      ...(scope === 'selected' && selected ? { instanceIds: [selected] } : {}),
      ...(scope === 'stale' ? { onlyStale: true } : {}),
      meta: metaFor(),
      titleBlock: { designer: prefs.titleBlock.designer, company: prefs.titleBlock.company }
    });
    if (!response.ok) {
      if (response.info) info = response.info;
      render();
      return { ok: false, message: response.message };
    }
    job = {
      jobId: response.jobId, label: '', state: 'queued', total: response.partKeys.length, done: 0,
      currentPartId: null, message: '排队中', createdAt: new Date().toISOString(), finishedAt: null
    };
    for (const warning of response.warnings) notify(warning, true);
    render();
    return { ok: true, message: `已提交 ${response.partKeys.length} 个零件`, jobId: response.jobId };
  }

  async function onGenerateClick(scope: 'selected' | 'all' | 'stale'): Promise<void> {
    const result = await generate(scope);
    if (!result.ok) notify(result.message, true);
  }

  function onJob(snapshot: DesktopDrawingJobSnapshot): void {
    if (job && snapshot.jobId !== job.jobId && ACTIVE_STATES.has(job.state)) return;
    job = snapshot;
    if (snapshot.finishedAt) {
      const failures = snapshot.outcome?.parts.filter((entry) => !entry.result.ok) ?? [];
      notify(snapshot.message + (failures[0]?.result.error ? `：${failures[0].result.error}` : ''), snapshot.state !== 'succeeded');
      void loadManifest(true).then(() => {
        recompute();
        render();
      });
    }
    render();
  }

  function scheduleAuto(): void {
    if (!prefs.autoRegenerate || !info?.available || jobActive()) return;
    if (!report || report.staleKeys.length === 0) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (report && report.staleKeys.length > 0 && !jobActive()) void generate('stale');
    }, autoDelayMs);
  }

  function tick(): void {
    if (!enabled) return;
    const key = projectKey();
    if (key !== manifestKey) {
      void loadManifest(true).then(() => {
        recompute();
        render();
      });
      return;
    }
    const doc = docOrNull();
    const signature = doc ? JSON.stringify(doc.instances) + JSON.stringify(metaFor()) : '';
    if (signature === lastDocSignature) return;
    lastDocSignature = signature;
    // 输入框聚焦时不重绘零件表，避免打断输入
    const focused = document.activeElement;
    recompute();
    if (!(focused instanceof HTMLInputElement && partsBox.contains(focused))) renderParts();
    renderProgress();
    scheduleAuto();
  }

  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    const drawings = api();
    if (button.dataset.dwgGen) {
      void onGenerateClick(button.dataset.dwgGen as 'selected' | 'all' | 'stale');
    } else if (button.hasAttribute('data-dwg-detect')) {
      info = null;
      render();
      void drawings?.detectFreecad().then((res) => {
        if (res.ok) info = res.info;
        else notify(res.message, true);
        render();
      });
    } else if (button.hasAttribute('data-dwg-choose')) {
      void drawings?.chooseFreecadPath().then((res) => {
        if (res.ok) info = res.info;
        else if (res.code !== 'CANCELED') notify(res.message, true);
        if (!res.ok && res.info) info = res.info;
        render();
      });
    } else if (button.hasAttribute('data-dwg-cancel')) {
      if (job) void drawings?.cancel(job.jobId);
    } else if (button.hasAttribute('data-dwg-reveal')) {
      void drawings?.reveal(projectKey()).then((res) => {
        if (!res.ok) notify(res.message, true);
      });
    } else if (button.dataset.dwgOpen) {
      const row = button.closest<HTMLElement>('[data-dwg-part]');
      const partKey = row?.dataset.dwgPart;
      if (!partKey || !drawings) return;
      const kind = button.dataset.dwgOpen;
      const action = kind === 'dir'
        ? drawings.reveal(projectKey(), partKey)
        : drawings.open(projectKey(), partKey, kind as DesktopDrawingFormat);
      void action.then((res) => {
        if (!res.ok) notify(res.message, true);
      });
    }
  });
  host.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;
    if (target === designer || target === company) {
      prefs.titleBlock = { designer: designer.value.trim(), company: company.value.trim() };
      savePrefs();
      return;
    }
    if (target === autoInput) {
      prefs.autoRegenerate = autoInput.checked;
      savePrefs();
      scheduleAuto();
      return;
    }
    const field = target.dataset.dwgMeta as 'material' | 'drawingNo' | undefined;
    const partKey = target.closest<HTMLElement>('[data-dwg-part]')?.dataset.dwgPart;
    if (!field || !partKey) return;
    const key = projectKey();
    prefs.meta[key] = { ...(prefs.meta[key] ?? {}) };
    prefs.meta[key][partKey] = { ...(prefs.meta[key][partKey] ?? {}), [field]: target.value.trim().slice(0, 40) };
    savePrefs();
    lastDocSignature = '';
    tick();
  });

  const drawings = api();
  if (drawings) unsubscribe = drawings.onJob(onJob);
  pollTimer = setInterval(tick, pollMs);
  render();
  void refresh();

  return {
    refresh,
    setEnabled(next: boolean): void {
      enabled = next;
      if (!next && autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
      lastDocSignature = '';
      render();
      if (next) void refresh();
    },
    state(): DrawingsUiState {
      return {
        enabled,
        freecadAvailable: Boolean(info?.available),
        freecadVersion: info?.version ?? null,
        freecadReason: info?.reason ?? '',
        projectKey: projectKey(),
        parts: report?.parts.length ?? 0,
        fresh: report?.parts.filter((part) => part.status === 'fresh').length ?? 0,
        stale: report?.staleKeys.length ?? 0,
        missing: report?.missingKeys.length ?? 0,
        job: job ? { jobId: job.jobId, state: job.state, done: job.done, total: job.total, message: job.message } : null,
        autoRegenerate: prefs.autoRegenerate
      };
    },
    generate,
    report: () => report,
    destroy(): void {
      if (pollTimer) clearInterval(pollTimer);
      if (autoTimer) clearTimeout(autoTimer);
      unsubscribe?.();
      host.innerHTML = '';
    }
  };
}
