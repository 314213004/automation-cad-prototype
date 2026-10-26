/**
 * 整机布局编辑：覆盖层 UI（DOM + three 交互）。纯计算全部在 model/drag/snap/align/collision/numeric/measure。
 *
 * 宿主（目前是整机设计向导第 4 步）提供 getDesign / commit：编辑器只产出新的 MachineDesign，
 * 由宿主写回草稿主数据、记入统一撤销时间线并持久化。编辑器不保存任何位姿副本。
 */
import styles from './layout-editor.css?inline';
import type { MachineDesign } from '../machine/synth.ts';
import type { MachineGeometry } from '../machine/geometry.ts';
import type { MachineFootprintRequirement } from '../machine/spec.ts';
import { generatedGeometryForDesign, geometryForDesign } from '../design/footprint.ts';
import { layoutHistory } from '../orbit/ui.ts';
import {
  boxToRect,
  buildLayoutModel,
  describeSelection,
  editableStations,
  nextSelection,
  refineLayoutCollisions,
  runLayoutChecks,
  selectedPartIds,
  writeStationPoses,
  type LayoutChecks,
  type LayoutModel,
  type LayoutPose,
  type SelectionItem,
  type SelectMode
} from './model.ts';
import { beginDrag, dragFrame, dragToPose, posesFromDeltas, type DragResult, type DragStart, type SnapSettings } from './drag.ts';
import { alignDeltas, distributeDeltas, linearArrayDeltas, ALIGN_LABELS, type AlignMode } from './align.ts';
import { baselinePairs, bodiesFromGeometry, detectCollisions } from './collision.ts';
import { appendNumericKey, applyNumericEntry, formatDragReadout, parseNumericEntry, type DragHandle } from './numeric.ts';
import { measurePicks, type MeasurePick } from './measure.ts';
import { GRID_STEPS_MM, ANGLE_STEPS_DEG } from './snap.ts';
import { LayoutEditorView, type ViewPreset } from './view.ts';

export interface LayoutEditorHost {
  getDesign(): MachineDesign | null;
  /** 写回主数据（并记入撤销时间线、持久化）；返回 false 表示宿主拒绝 */
  commit(next: MachineDesign, label: string, mergeKey?: string): boolean;
  footprintRequirement(): MachineFootprintRequirement | null;
  notify(message: string, error?: boolean): void;
}

export interface LayoutEditorHandle {
  refresh(): void;
  close(): void;
  isOpen(): boolean;
}

interface DragSession {
  start: DragStart;
  handle: DragHandle;
  buffer: string;
  last: DragResult | null;
  /** gizmo 拖动（鼠标）或键盘会话（X/Y/R + 数字） */
  source: 'gizmo' | 'keyboard';
  proxyStart: [number, number, number];
  finished: boolean;
}

let enabled = true;
let active: { handle: LayoutEditorHandle; close(): void } | null = null;

export function setLayoutEditorEnabled(value: boolean): void {
  enabled = value;
  if (!value) active?.close();
}

export function isLayoutEditorEnabled(): boolean {
  return enabled;
}

export function refreshLayoutEditor(): void {
  active?.handle.refresh();
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureStyles(): void {
  if (document.getElementById('layout-editor-styles')) return;
  const style = document.createElement('style');
  style.id = 'layout-editor-styles';
  style.textContent = styles;
  document.head.appendChild(style);
}

export function openLayoutEditor(host: LayoutEditorHost): LayoutEditorHandle | null {
  if (!enabled) {
    host.notify('整机布局 3D 编辑模块已在「模块设置」中关闭。', true);
    return null;
  }
  if (active) {
    active.handle.refresh();
    return active.handle;
  }
  ensureStyles();
  const root = document.createElement('section');
  root.className = 'le-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '整机布局 3D 编辑');
  root.innerHTML = `<header class="le-bar">
    <h2>整机布局 · 3D 编辑</h2>
    <span class="le-group"><span>选择</span><button class="le-btn" data-le-select="station" aria-pressed="true" title="点零件选中整个工位">工位</button><button class="le-btn" data-le-select="part" aria-pressed="false" title="点选单个零件（移动仍作用于所属工位）">零件</button></span>
    <span class="le-group"><span>操作</span><button class="le-btn" data-le-mode="translate" aria-pressed="true" title="移动（W）">移动</button><button class="le-btn" data-le-mode="rotate" aria-pressed="false" title="绕 Z 旋转（E）">旋转 Z</button><button class="le-btn" data-le-measure aria-pressed="false" title="两点/两面临时测量（M）">测量</button></span>
    <span class="le-group"><span>吸附</span><select data-le-grid aria-label="网格步长"><option value="0">网格关</option>${GRID_STEPS_MM.map((step) => `<option value="${step}" ${step === 10 ? 'selected' : ''}>${step} mm</option>`).join('')}</select><select data-le-angle aria-label="角度步长"><option value="0">角度关</option>${ANGLE_STEPS_DEG.map((step) => `<option value="${step}" ${step === 15 ? 'selected' : ''}>${step}°</option>`).join('')}</select><label title="对齐其它工位/机架包络的边与中线"><input type="checkbox" data-le-feature checked> 边/中线</label></span>
    <span class="le-group"><span>对齐</span>${(Object.keys(ALIGN_LABELS) as AlignMode[]).map((mode) => `<button class="le-btn" data-le-align="${mode}" title="${ALIGN_LABELS[mode]}">${({ left: '左', centerX: '中X', right: '右', bottom: '底', centerY: '中Y', top: '顶' } as const)[mode]}</button>`).join('')}<button class="le-btn" data-le-distribute="x" title="沿 X 等间隙分布（≥3）">分布X</button><button class="le-btn" data-le-distribute="y" title="沿 Y 等间隙分布（≥3）">分布Y</button></span>
    <span class="le-group"><span>阵列</span><select data-le-array-axis aria-label="阵列方向"><option value="x">X</option><option value="y">Y</option></select><input type="number" data-le-array-pitch value="500" step="any" aria-label="阵列间距 mm"><button class="le-btn" data-le-array title="按选择顺序等间距排列选中工位">排列</button></span>
    <span class="le-group"><span>视图</span><button class="le-btn" data-le-view="iso">等轴测</button><button class="le-btn" data-le-view="top">俯视</button><button class="le-btn" data-le-view="front">前视</button></span>
    <span class="le-group"><button class="le-btn" data-le-undo title="撤销（Ctrl+Z，与主视口同一时间线）">撤销</button><button class="le-btn" data-le-redo title="重做（Ctrl+Y）">重做</button></span>
    <button class="le-btn le-close" data-le-close title="关闭（编辑已实时写回草稿）">完成</button>
  </header>
  <div class="le-body">
    <div class="le-viewport" data-le-viewport><div class="le-hint">左键拖动旋转视角 · 点选/Ctrl 多选 · Shift 拖框选 · 拖 gizmo 时可直接键入数值回车，Esc 取消 · 未拖动时按 X / Y / R 再输入数值</div><div class="le-hud" data-le-hud></div></div>
    <aside class="le-side">
      <section class="le-section" data-le-props></section>
      <section class="le-section"><h3>校验 <small data-le-check-summary></small></h3><div style="display:flex;gap:6px;margin-bottom:8px"><button class="le-side-btn" data-le-refine title="对包络命中的零件对做截面求交">精检干涉体积</button></div><div data-le-refine-result class="le-note"></div><ul class="le-checks" data-le-checks></ul><p class="le-note">碰撞为零件形体包络（OBB）检测，只报编辑引入的新增干涉；精检为概念占位体原始形体的解析求交（盒-盒精确），未接 build123d 布尔运算。位姿改动后，向导第 5 步「一键校核」需重新运行。</p></section>
    </aside>
  </div>`;
  document.body.appendChild(root);
  const viewport = root.querySelector<HTMLElement>('[data-le-viewport]') as HTMLElement;
  const hud = root.querySelector<HTMLElement>('[data-le-hud]') as HTMLElement;

  let view: LayoutEditorView;
  try {
    view = new LayoutEditorView(viewport);
  } catch (error) {
    root.querySelector('.le-body')!.innerHTML = `<div class="le-blocked">3D 视口不可用（WebGL）：${escapeHtml(errorMessage(error))}。仍可在向导第 4 步俯视图中用数值编辑工位位姿。</div>`;
    root.querySelector('[data-le-close]')?.addEventListener('click', () => root.remove());
    host.notify(`3D 布局编辑不可用：${errorMessage(error)}`, true);
    return null;
  }

  let design: MachineDesign | null = null;
  let generated: MachineGeometry | null = null;
  let geometry: MachineGeometry | null = null;
  let model: LayoutModel | null = null;
  let checks: LayoutChecks | null = null;
  let selection: SelectionItem[] = [];
  let selectMode: SelectMode = 'station';
  let transformMode: 'translate' | 'rotate' = 'translate';
  let measureMode = false;
  let measurePicksList: MeasurePick[] = [];
  let measureText = '';
  let session: DragSession | null = null;
  let liveRed = new Set<string>();
  let baseline = new Set<string>();
  let collisionFrame = 0;
  let firstView = true;
  let closed = false;

  const snapSettings = (): SnapSettings => ({
    gridMm: Number(root.querySelector<HTMLSelectElement>('[data-le-grid]')?.value ?? 0),
    angleDeg: Number(root.querySelector<HTMLSelectElement>('[data-le-angle]')?.value ?? 0),
    features: root.querySelector<HTMLInputElement>('[data-le-feature]')?.checked ?? false,
    toleranceMm: view.mmPerPixel() * 8
  });

  function stationPoses(): Map<string, LayoutPose> {
    return new Map((model?.stations ?? []).map((station) => [station.id, station.pose]));
  }

  function rebuild(): void {
    if (closed) return;
    design = host.getDesign();
    if (!design) {
      hud.textContent = '当前没有已选设计方案，无法编辑整机布局。';
      return;
    }
    try {
      const nextGenerated = generatedGeometryForDesign(design);
      geometry = geometryForDesign(design);
      model = buildLayoutModel(design, geometry);
      if (nextGenerated !== generated) {
        generated = nextGenerated;
        baseline = baselinePairs(bodiesFromGeometry(generated));
        view.setGeometry(generated, model);
        selection = selection.filter((item) => item.kind === 'station' ? model!.stations.some((station) => station.id === item.id) : model!.parts.some((part) => part.id === item.id));
      }
      view.applyPoses(stationPoses());
      checks = runLayoutChecks(design, { footprintRequirement: host.footprintRequirement(), geometry });
      liveRed = new Set();
      if (firstView) { view.setView('iso'); firstView = false; }
    } catch (error) {
      hud.textContent = `几何生成或校验失败：${errorMessage(error)}`;
      return;
    }
    renderPanels();
    refreshHighlight();
    attachGizmo();
    view.showGuides([], 0);
    view.showOverlapBoxes(checks?.collisions.pairs.map((pair) => pair.overlap) ?? []);
    hud.textContent = measureMode ? measureText || '测量：点击第一个点/面' : '';
  }

  function refreshHighlight(): void {
    if (!model) return;
    const selected = new Set(selectedPartIds(model, selection));
    const red = new Set([...(checks?.redParts ?? []), ...liveRed]);
    view.setHighlight(selected, red);
  }

  function selectionCenter(ids: readonly string[]): [number, number, number] | null {
    if (!model || ids.length === 0) return null;
    const start = beginDrag(model, ids);
    const top = Math.max(...start.stations.map((station) => station.bounds.max[2]));
    return [start.center[0], start.center[1], top + 20];
  }

  function attachGizmo(): void {
    if (!model || measureMode) { view.attachGizmo(null, transformMode); return; }
    const ids = editableStations(model, selection);
    view.attachGizmo(selectionCenter(ids), transformMode);
  }

  function renderPanels(): void {
    if (!model) return;
    const props = root.querySelector<HTMLElement>('[data-le-props]') as HTMLElement;
    const info = describeSelection(model, selection);
    const pose = info.editable?.pose;
    props.innerHTML = `<h3>${escapeHtml(info.title)}</h3>${info.rows.length ? `<dl class="le-rows">${info.rows.map((row) => `<dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd>`).join('')}</dl>` : ''}${info.editable && pose ? `<div class="le-pose" data-le-pose="${escapeHtml(info.editable.stationId)}"><label>X 偏移 mm<input type="number" step="any" data-le-pose-key="xMm" value="${pose.xMm}"></label><label>Y 偏移 mm<input type="number" step="any" data-le-pose-key="yMm" value="${pose.yMm}"></label><label>RZ °<input type="number" step="any" data-le-pose-key="rotationZDeg" value="${pose.rotationZDeg}"></label></div>` : ''}<p class="le-note">${escapeHtml(info.note)}</p>`;
    props.querySelectorAll<HTMLInputElement>('[data-le-pose-key]').forEach((input) => input.addEventListener('change', () => {
      const stationId = input.closest<HTMLElement>('[data-le-pose]')?.dataset.lePose;
      const station = model?.stations.find((item) => item.id === stationId);
      const key = input.dataset.lePoseKey as keyof LayoutPose;
      const value = input.valueAsNumber;
      if (!station || !Number.isFinite(value)) { host.notify('请输入有限数值', true); rebuild(); return; }
      commit(new Map([[station.id, { ...station.pose, [key]: value }]]), `${station.name} ${key === 'rotationZDeg' ? 'RZ' : key === 'xMm' ? 'X' : 'Y'} = ${value}`, `${station.identity}:${key}`);
    }));
    const list = root.querySelector<HTMLElement>('[data-le-checks]') as HTMLElement;
    const items = checks?.items ?? [];
    const errors = items.filter((item) => item.severity === 'error').length;
    const warnings = items.filter((item) => item.severity === 'warning').length;
    const summary = root.querySelector<HTMLElement>('[data-le-check-summary]');
    if (summary) summary.textContent = `错误 ${errors} · 警告 ${warnings}`;
    list.innerHTML = items.map((item, index) => `<li class="le-check" data-severity="${item.severity}" data-le-check="${index}"><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></li>`).join('');
    list.querySelectorAll<HTMLElement>('[data-le-check]').forEach((element) => element.addEventListener('click', () => {
      const item = items[Number(element.dataset.leCheck)];
      if (!item) return;
      selection = item.unitIds.length ? item.unitIds.map((id) => ({ kind: 'station' as const, id })) : item.partIds.map((id) => ({ kind: 'part' as const, id }));
      renderPanels(); refreshHighlight(); attachGizmo();
    }));
    const refine = root.querySelector<HTMLButtonElement>('[data-le-refine]');
    if (refine) refine.disabled = !checks?.collisions.pairs.length;
    const peek = layoutHistory.peek();
    const undo = root.querySelector<HTMLButtonElement>('[data-le-undo]');
    const redo = root.querySelector<HTMLButtonElement>('[data-le-redo]');
    if (undo) undo.title = peek.undo ? `撤销：${peek.undo}（Ctrl+Z）` : '撤销（Ctrl+Z，与主视口同一时间线）';
    if (redo) redo.title = peek.redo ? `重做：${peek.redo}（Ctrl+Y）` : '重做（Ctrl+Y）';
  }

  function commit(poses: ReadonlyMap<string, LayoutPose>, label: string, mergeKey?: string): void {
    const current = host.getDesign();
    if (!current || poses.size === 0) { rebuild(); return; }
    try {
      const next = writeStationPoses(current, poses);
      if (!host.commit(next, label, mergeKey)) host.notify('布局修改未写回（宿主拒绝）', true);
    } catch (error) {
      host.notify(`布局修改未写回：${errorMessage(error)}`, true);
    }
    rebuild();
  }

  /* ------------------------------------------------------- 拖动会话 */

  function startSession(source: DragSession['source'], handle: DragHandle): boolean {
    if (!model) return false;
    const ids = editableStations(model, selection);
    if (ids.length === 0) return false;
    const start = beginDrag(model, ids);
    session = { start, handle, buffer: '', last: null, source, proxyStart: [view.proxy.position.x, view.proxy.position.y, view.proxy.position.z], finished: false };
    updateHud();
    return true;
  }

  function updateHud(): void {
    if (!session) return;
    const primary = session.start.stations[0];
    if (!primary) return;
    const current = session.last?.poses.get(primary.id) ?? primary.pose;
    hud.textContent = `${primary.name}${session.start.stations.length > 1 ? ` 等 ${session.start.stations.length} 个工位` : ''} · ${formatDragReadout(session.handle, primary.pose, current, session.buffer)}${liveRed.size ? ` · ⚠ 包络干涉 ${liveRed.size} 件` : ''}`;
  }

  function scheduleLiveCollision(poses: ReadonlyMap<string, LayoutPose>): void {
    if (collisionFrame) cancelAnimationFrame(collisionFrame);
    collisionFrame = requestAnimationFrame(() => {
      collisionFrame = 0;
      if (!session || !design) return;
      try {
        const candidate = geometryForDesign(writeStationPoses(design, poses));
        const report = detectCollisions(bodiesFromGeometry(candidate), { baseline, focusUnits: new Set(poses.keys()) });
        liveRed = new Set(report.partIds);
        view.showOverlapBoxes(report.pairs.map((pair) => pair.overlap));
      } catch {
        liveRed = new Set();
      }
      checks = checks ? { ...checks, redParts: [] } : checks;
      refreshHighlight();
      updateHud();
    });
  }

  function previewResult(result: DragResult): void {
    if (!session) return;
    session.last = result;
    view.applyPoses(result.poses);
    const [px, py, pz] = session.proxyStart;
    view.setProxy([px + result.delta.dx, py + result.delta.dy, pz], result.delta.dRotationZDeg);
    const z = Math.max(...session.start.stations.map((station) => station.bounds.max[2])) + 2;
    view.showGuides(result.guides, z);
    scheduleLiveCollision(result.poses);
    updateHud();
  }

  function finishSession(apply: boolean): void {
    if (!session || session.finished) return;
    const current = session;
    current.finished = true;
    session = null;
    if (current.source === 'gizmo') view.endGizmoDrag();
    if (collisionFrame) { cancelAnimationFrame(collisionFrame); collisionFrame = 0; }
    if (!apply || !current.last) { rebuild(); return; }
    const primary = current.start.stations[0];
    const verb = current.handle === 'RZ' ? '旋转' : '移动';
    const label = `${verb} ${primary?.name ?? ''}${current.start.stations.length > 1 ? ` 等 ${current.start.stations.length} 个工位` : ''}`;
    const changed = new Map([...current.last.poses].filter(([id, pose]) => {
      const before = current.start.stations.find((station) => station.id === id)?.pose;
      return !before || before.xMm !== pose.xMm || before.yMm !== pose.yMm || before.rotationZDeg !== pose.rotationZDeg;
    }));
    if (changed.size === 0) { rebuild(); return; }
    commit(changed, label);
  }

  function applyTyped(): void {
    if (!session) return;
    const parsed = parseNumericEntry(session.buffer);
    const primary = session.start.stations[0];
    if (!parsed.ok || !primary) { host.notify(parsed.ok ? '无可编辑工位' : parsed.error, true); return; }
    const target = applyNumericEntry(parsed.entry, session.handle, primary.pose);
    if (!target.ok) { host.notify(target.error, true); return; }
    session.last = dragToPose(session.start, target.pose);
    finishSession(true);
  }

  view.gizmo.addEventListener('mouseDown', () => {
    const handle = view.activeHandle();
    if (!handle) return;
    startSession('gizmo', handle);
  });
  view.gizmo.addEventListener('objectChange', () => {
    if (!session || session.source !== 'gizmo' || session.finished) return;
    const [px, py] = session.proxyStart;
    const raw = {
      dx: view.proxy.position.x - px,
      dy: view.proxy.position.y - py,
      dRotationZDeg: view.proxy.rotation.z * 180 / Math.PI
    };
    previewResult(dragFrame(session.start, session.handle, raw, snapSettings()));
  });
  view.gizmo.addEventListener('mouseUp', () => {
    if (session && session.source === 'gizmo' && !session.finished) finishSession(true);
  });

  /* ------------------------------------------------------- 指针：点选 / 框选 / 测量 */

  let down: { x: number; y: number; marquee: HTMLElement | null } | null = null;
  const canvas = view.renderer.domElement;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || view.gizmo.axis !== null) return;
    down = { x: event.clientX, y: event.clientY, marquee: null };
    if (event.shiftKey && !measureMode) {
      view.controls.enabled = false;
      const marquee = document.createElement('div');
      marquee.className = 'le-marquee';
      viewport.appendChild(marquee);
      down.marquee = marquee;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!down?.marquee) return;
    const rect = viewport.getBoundingClientRect();
    Object.assign(down.marquee.style, {
      left: `${Math.min(down.x, event.clientX) - rect.left}px`, top: `${Math.min(down.y, event.clientY) - rect.top}px`,
      width: `${Math.abs(event.clientX - down.x)}px`, height: `${Math.abs(event.clientY - down.y)}px`
    });
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!down || !model) { down = null; return; }
    const start = down;
    down = null;
    if (start.marquee) {
      start.marquee.remove();
      view.controls.enabled = true;
      const hits = view.partsInScreenRect(start.x, start.y, event.clientX, event.clientY);
      let next: SelectionItem[] = event.ctrlKey || event.metaKey ? [...selection] : [];
      for (const id of hits) {
        const part = model.parts.find((item) => item.id === id);
        if (!part) continue;
        const item: SelectionItem = selectMode === 'station' && part.unitId !== 'frame' ? { kind: 'station', id: part.unitId } : { kind: 'part', id };
        if (selectMode === 'station' && part.unitId === 'frame') continue;
        if (!next.some((existing) => existing.kind === item.kind && existing.id === item.id)) next.push(item);
      }
      selection = next;
      renderPanels(); refreshHighlight(); attachGizmo();
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    const hit = view.pick(event.clientX, event.clientY);
    if (measureMode) {
      if (!hit) return;
      const part = model.parts.find((item) => item.id === hit.partId);
      measurePicksList = measurePicksList.length >= 2 ? [] : measurePicksList;
      measurePicksList.push({ point: hit.point, ...(hit.normal ? { normal: hit.normal } : {}), label: part?.name ?? hit.partId });
      view.showMeasure(measurePicksList.map((pick) => pick.point));
      if (measurePicksList.length === 2) {
        const result = measurePicks(measurePicksList[0]!, measurePicksList[1]!);
        measureText = `测量：${measurePicksList[0]!.label} → ${measurePicksList[1]!.label} · ${result.text}`;
      } else {
        measureText = `测量：已取 ${measurePicksList[0]!.label}，再点第二个点/面`;
      }
      hud.textContent = measureText;
      return;
    }
    selection = nextSelection(model, selection, hit?.partId ?? null, { additive: event.ctrlKey || event.metaKey, mode: selectMode });
    renderPanels(); refreshHighlight(); attachGizmo();
  });

  /* ------------------------------------------------------- 工具条 */

  function setPressed(selector: string, value: string, attr: string): void {
    root.querySelectorAll<HTMLElement>(selector).forEach((button) => button.setAttribute('aria-pressed', String(button.getAttribute(attr) === value)));
  }
  function setTransformMode(mode: 'translate' | 'rotate'): void {
    transformMode = mode;
    setPressed('[data-le-mode]', mode, 'data-le-mode');
    attachGizmo();
  }
  function setMeasure(on: boolean): void {
    measureMode = on;
    measurePicksList = [];
    measureText = '';
    root.querySelector('[data-le-measure]')?.setAttribute('aria-pressed', String(on));
    view.showMeasure([]);
    hud.textContent = on ? '测量：点击第一个点/面（两平行面给面距，否则给点距）' : '';
    attachGizmo();
  }
  root.querySelectorAll<HTMLElement>('[data-le-select]').forEach((button) => button.addEventListener('click', () => {
    selectMode = button.dataset.leSelect === 'part' ? 'part' : 'station';
    setPressed('[data-le-select]', selectMode, 'data-le-select');
  }));
  root.querySelectorAll<HTMLElement>('[data-le-mode]').forEach((button) => button.addEventListener('click', () => setTransformMode(button.dataset.leMode === 'rotate' ? 'rotate' : 'translate')));
  root.querySelector('[data-le-measure]')?.addEventListener('click', () => setMeasure(!measureMode));
  root.querySelectorAll<HTMLElement>('[data-le-view]').forEach((button) => button.addEventListener('click', () => view.setView(button.dataset.leView as ViewPreset)));
  root.querySelector('[data-le-undo]')?.addEventListener('click', () => { const r = layoutHistory.undo(); if (!r.ok) host.notify(r.message, true); rebuild(); });
  root.querySelector('[data-le-redo]')?.addEventListener('click', () => { const r = layoutHistory.redo(); if (!r.ok) host.notify(r.message, true); rebuild(); });
  root.querySelector('[data-le-close]')?.addEventListener('click', () => close());
  const selectedItems = (): Array<{ id: string; rect: ReturnType<typeof boxToRect> }> => {
    if (!model) return [];
    return editableStations(model, selection).map((id) => {
      const station = model!.stations.find((item) => item.id === id)!;
      return { id, rect: boxToRect(station.bounds) };
    });
  };
  const runBatch = (label: string, compute: () => Map<string, { dx: number; dy: number }>): void => {
    if (!model) return;
    try {
      const poses = posesFromDeltas(model, compute());
      if (poses.size === 0) { host.notify(`${label}：位置已满足，无需移动`); return; }
      commit(poses, label);
    } catch (error) {
      host.notify(errorMessage(error), true);
    }
  };
  root.querySelectorAll<HTMLElement>('[data-le-align]').forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.leAlign as AlignMode;
    runBatch(ALIGN_LABELS[mode], () => alignDeltas(selectedItems(), mode));
  }));
  root.querySelectorAll<HTMLElement>('[data-le-distribute]').forEach((button) => button.addEventListener('click', () => {
    const axis = button.dataset.leDistribute === 'y' ? 'y' : 'x';
    runBatch(`沿 ${axis.toUpperCase()} 等距分布`, () => distributeDeltas(selectedItems(), axis));
  }));
  root.querySelector('[data-le-array]')?.addEventListener('click', () => {
    const axis = root.querySelector<HTMLSelectElement>('[data-le-array-axis]')?.value === 'y' ? 'y' : 'x';
    const pitch = root.querySelector<HTMLInputElement>('[data-le-array-pitch]')?.valueAsNumber ?? Number.NaN;
    runBatch(`沿 ${axis.toUpperCase()} 阵列排布 ${pitch} mm`, () => linearArrayDeltas(selectedItems(), axis, pitch));
  });
  root.querySelector('[data-le-refine]')?.addEventListener('click', () => {
    const out = root.querySelector<HTMLElement>('[data-le-refine-result]');
    if (!geometry || !checks || !out) return;
    const refined = refineLayoutCollisions(geometry, checks.collisions);
    const quality = { exact: '精确', 'polygon-approx': '多边形近似', 'upper-bound': '上界' } as const;
    out.innerHTML = refined.length
      ? refined.slice(0, 20).map((item) => `${escapeHtml(item.a)} ↔ ${escapeHtml(item.b)}：${Math.round(item.volumeMm3)} mm³（${quality[item.quality]}）`).join('<br>')
      : '无包络命中，无需精检。';
  });

  /* ------------------------------------------------------- 键盘 */

  const onKey = (event: KeyboardEvent): void => {
    if (closed || root.hidden) return;
    const target = event.target;
    const inField = target instanceof HTMLElement && Boolean(target.closest('input, textarea, select'));
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        if (inField) return;
        if (!layoutHistory.bound()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          const result = key === 'z' && !event.shiftKey ? layoutHistory.undo() : layoutHistory.redo();
          if (!result.ok) host.notify(result.message, true);
        }
        // 主视口时间线已在更早的捕获监听里处理；结果通过宿主 applier 写回后刷新
        queueMicrotask(rebuild);
        return;
      }
      if (key === 'a' && !inField && model) {
        event.preventDefault();
        selection = model.stations.map((station) => ({ kind: 'station' as const, id: station.id }));
        renderPanels(); refreshHighlight(); attachGizmo();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session) finishSession(false);
      else if (measureMode) setMeasure(false);
      else if (selection.length) { selection = []; renderPanels(); refreshHighlight(); attachGizmo(); }
      else close();
      return;
    }
    if (inField) return;
    if (session) {
      if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); applyTyped(); return; }
      const next = appendNumericKey(session.buffer, event.key);
      if (next !== null) {
        event.preventDefault();
        event.stopImmediatePropagation();
        session.buffer = next;
        updateHud();
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'w') setTransformMode('translate');
    else if (key === 'e') setTransformMode('rotate');
    else if (key === 'm') setMeasure(!measureMode);
    else if (key === 'x' || key === 'y' || key === 'r') {
      if (startSession('keyboard', key === 'x' ? 'X' : key === 'y' ? 'Y' : 'RZ')) {
        event.preventDefault();
        hud.textContent = `${hud.textContent}（键盘：输入数值回车）`;
      }
    }
  };
  window.addEventListener('keydown', onKey, true);

  function close(): void {
    if (closed) return;
    closed = true;
    if (session) finishSession(false);
    window.removeEventListener('keydown', onKey, true);
    view.dispose();
    root.remove();
    active = null;
  }

  const handle: LayoutEditorHandle = { refresh: rebuild, close, isOpen: () => !closed };
  active = { handle, close };
  exposeDebugApi(() => ({
    open: !closed,
    selection: [...selection],
    poses: Object.fromEntries(stationPoses()),
    checks: checks ? { errors: checks.items.filter((item) => item.severity === 'error').length, collisions: checks.collisions.pairs.length, redUnits: checks.redUnits } : null,
    history: layoutHistory.counts()
  }), {
    select(ids: string[]) { selection = ids.map((id) => ({ kind: 'station' as const, id })); renderPanels(); refreshHighlight(); attachGizmo(); return true; },
    setPose(stationId: string, pose: LayoutPose) { commit(new Map([[stationId, pose]]), `设置 ${stationId} 位姿`); return true; },
    setView(preset: ViewPreset) { view.setView(preset); return true; },
    /** 工位包络顶面中心的客户区坐标（自动化脚本点选用） */
    screenOf(stationId: string) {
      const station = model?.stations.find((item) => item.id === stationId);
      if (!station) return null;
      const point = view.toScreen([(station.bounds.min[0] + station.bounds.max[0]) / 2, (station.bounds.min[1] + station.bounds.max[1]) / 2, station.bounds.max[2]]);
      const rect = view.renderer.domElement.getBoundingClientRect();
      return point ? { x: rect.left + point.x, y: rect.top + point.y } : null;
    },
    hud: () => hud.textContent,
    render() { view.renderNow(); return view.renderer.domElement.toDataURL('image/png'); },
    close
  });
  rebuild();
  return handle;
}

let debugApi: { state: () => unknown; actions: Record<string, unknown> } | null = null;
function exposeDebugApi(state: () => unknown, actions: Record<string, unknown>): void {
  debugApi = { state, actions };
  if (Object.prototype.hasOwnProperty.call(window, 'AutomationCadLayoutEditor')) return;
  Object.defineProperty(window, 'AutomationCadLayoutEditor', {
    value: Object.freeze({
      state: () => debugApi?.state() ?? { open: false },
      call: (name: string, ...args: unknown[]) => {
        const fn = debugApi?.actions[name];
        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown)(...args) : null;
      }
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
}

export function closeLayoutEditor(): void {
  active?.close();
}
