/**
 * 主视口 three.js 注入扩展：原型文件零改动。
 *
 * 数据来源（原型 `state` 不导出）：
 * - 结构树：`window.ProtoApi.getTree()`；
 * - 选中 / 悬停 / 干涉命中：原型写在等轴测 SVG `g.part` 上的 `data-sel / data-hover / data-hit`；
 * - 缸径 / 行程：气缸面板输入框（精确），否则从重新挂载的 SVG 反算并吸附到已知值；
 * - 插入件坐标：复刻原型确定性的 `findFreePlacement()`。
 * 反向：3D 拾取 → 在 SVG 对应 `g.part` 上派发 click / mouseover，交给原型自己的
 * `selectPart / applyIssue` 处理，因此结构树、属性面板、状态栏、撤销栈全部沿用原型逻辑。
 */
import orbitStyles from './orbit.css?inline';
import { detectInterferences, type InterferenceHit } from '../mech/interference.ts';
import { isStandardView, VIEW_LABELS, type StandardView } from './camera.ts';
import {
  applyParamEdit,
  buildAssembly,
  effectiveBore,
  effectiveParams,
  effectiveStroke,
  paramSchema,
  replicatePlacements,
  resetPartOverrides,
  type Assembly,
  type AssemblyInputs,
  type EditResult,
  type InsertedBox,
  type ParamOverrides
} from './model.ts';
import {
  BORE_TOLERANCE,
  boreFromEllipseRx,
  pushCandidate,
  snapValue,
  STANDARD_BORES,
  STANDARD_STROKES,
  STROKE_TOLERANCE,
  strokeFromRodPath
} from './proto-sync.ts';
import { insertedIdsFromTree, nodeForPart, resolveSelection, type ProtoTreeNode } from './selection.ts';
import type { HighlightState } from './three-scene.ts';
import { OrbitView, type OrbitViewState, type Projection } from './view.ts';

type StageKind = 'assembly' | 'check';

interface StageSlot {
  kind: StageKind;
  stage: HTMLElement;
  svg: SVGSVGElement;
  view: OrbitView | null;
  fallbackReason: string | null;
  bar: HTMLElement | null;
}

export interface OrbitPublicState {
  mode: 'webgl' | 'fallback' | 'partial';
  reasons: string[];
  bore: number;
  stroke: number;
  boreExact: boolean;
  strokeExact: boolean;
  parts: Array<{ id: string; bbox: { min: number[]; max: number[] } }>;
  selected: string[];
  selectedNode: string | null;
  hover: string | null;
  hit: string | null;
  overrides: ParamOverrides;
  interference: Array<{ a: string; b: string; severity: string }>;
  views: Partial<Record<StageKind, OrbitViewState | null>>;
  rebuilds: number;
}

export interface OrbitHandle {
  state(): OrbitPublicState;
  setView(view: StandardView, stage?: StageKind): boolean;
  setProjection(projection: Projection, stage?: StageKind): boolean;
  fit(stage?: StageKind): boolean;
  select(partId: string, stage?: StageKind): boolean;
  setParam(partId: string, key: string, value: unknown): EditResult;
  resetPart(partId: string): void;
  sync(): void;
}

declare global {
  interface Window {
    AutomationCadOrbit?: OrbitHandle;
  }
}

interface ProtoApiLike {
  version?: number;
  getTree?: () => unknown;
}

const VIEW_BUTTONS: StandardView[] = ['front', 'top', 'right', 'iso'];

let slots: StageSlot[] = [];
let overrides: ParamOverrides = {};
let borePool: number[] = [...STANDARD_BORES, 32];
let strokePool: number[] = [...STANDARD_STROKES, 50];
let current = { bore: 32, stroke: 50, boreExact: true, strokeExact: true };
let inserted: InsertedBox[] = [];
let assembly: Assembly | null = null;
let hits: InterferenceHit[] = [];
let tree: ProtoTreeNode[] = [];
let highlight: Record<StageKind, HighlightState> = {
  assembly: { selected: [], hover: null, hit: null, ghostOthers: false },
  check: { selected: [], hover: null, hit: null, ghostOthers: true }
};
let selectedNode: string | null = null;
let rebuilds = 0;
let rebuildQueued = false;
let highlightQueued = false;
let editTimer = 0;
let handle: OrbitHandle | null = null;

function protoApi(): ProtoApiLike | undefined {
  return (window as unknown as { ProtoApi?: ProtoApiLike }).ProtoApi;
}

function readTree(): ProtoTreeNode[] {
  try {
    const value = protoApi()?.getTree?.();
    return Array.isArray(value) ? (value as ProtoTreeNode[]) : [];
  } catch {
    return [];
  }
}

function injectStyles(): void {
  if (document.getElementById('automation-cad-orbit-styles')) return;
  const style = document.createElement('style');
  style.id = 'automation-cad-orbit-styles';
  style.textContent = orbitStyles;
  document.head.appendChild(style);
}

function assemblySvg(): SVGSVGElement | null {
  return document.querySelector<SVGSVGElement>('#scene3d');
}

function svgPart(svg: ParentNode | null, id: string): SVGGElement | null {
  if (!svg) return null;
  return Array.from(svg.querySelectorAll<SVGGElement>('g.part')).find((g) => g.dataset.part === id) ?? null;
}

/* ------------------------------------------------------------- 读原型输入 */

function readCylinderValues(): void {
  const boreInput = document.querySelector<HTMLInputElement>('input[data-field="bore"][data-part="cyl"]');
  const strokeInput = document.querySelector<HTMLInputElement>('input[data-field="stroke"][data-part="cyl"]');
  const svg = assemblySvg();

  const boreNumber = boreInput ? Number(boreInput.value) : NaN;
  if (boreInput && Number.isFinite(boreNumber) && boreInput.value.trim() !== '') {
    current.bore = boreNumber;
    current.boreExact = true;
    borePool = pushCandidate(borePool, boreNumber);
  } else {
    const ellipse = svgPart(svg, 'cyl')?.querySelector('ellipse');
    const rx = ellipse ? Number(ellipse.getAttribute('rx')) : NaN;
    if (Number.isFinite(rx)) {
      const snapped = snapValue(boreFromEllipseRx(rx), borePool, BORE_TOLERANCE, effectiveBore);
      // 夹紧后与当前值等效时保留当前值（例如输入过 80，SVG 画 63）。
      if (effectiveBore(current.bore) !== effectiveBore(snapped.value) || !snapped.exact) {
        current.bore = snapped.value;
        current.boreExact = snapped.exact;
      }
    }
  }

  const strokeNumber = strokeInput ? Number(strokeInput.value) : NaN;
  if (strokeInput && Number.isFinite(strokeNumber) && strokeInput.value.trim() !== '') {
    current.stroke = strokeNumber;
    current.strokeExact = true;
    strokePool = pushCandidate(strokePool, strokeNumber);
  } else {
    const path = svgPart(svg, 'rod')?.querySelector('path:not(.hitwash)');
    const derived = path ? strokeFromRodPath(path.getAttribute('d') ?? '') : null;
    if (derived !== null && Number.isFinite(derived)) {
      const snapped = snapValue(derived, strokePool, STROKE_TOLERANCE, effectiveStroke);
      if (effectiveStroke(current.stroke) !== effectiveStroke(snapped.value) || !snapped.exact) {
        current.stroke = snapped.value;
        current.strokeExact = snapped.exact;
      }
    }
  }
}

function readInserted(): void {
  const ids = insertedIdsFromTree(tree);
  const svg = assemblySvg();
  inserted = replicatePlacements(ids).map((placement) => {
    const polygons = svgPart(svg, placement.id)?.querySelectorAll('polygon');
    const top = polygons && polygons.length >= 3 ? polygons[2]?.getAttribute('fill') : null;
    return top ? { ...placement, color: top } : { ...placement };
  });
  // 已删除零件的覆盖一并清掉，避免 id 复用时继承旧尺寸。
  const live = new Set(ids);
  Object.keys(overrides).forEach((id) => {
    if (/^ins\d+$/.test(id) && !live.has(id)) overrides = resetPartOverrides(overrides, id);
  });
}

function inputs(): AssemblyInputs {
  return { bore: current.bore, stroke: current.stroke, inserted, overrides };
}

/* ------------------------------------------------------------- 重建 / 高亮 */

function rebuild(): void {
  tree = readTree();
  readCylinderValues();
  readInserted();
  assembly = buildAssembly(inputs());
  try {
    hits = detectInterferences(assembly.parts.map((part) => ({ name: part.id, bbox: part.bbox })));
  } catch {
    hits = [];
  }
  rebuilds += 1;
  slots.forEach((slot) => {
    if (!slot.view || !assembly) return;
    slot.view.setAssembly(assembly);
    if (slot.kind === 'check') {
      slot.view.setSectionVisible(true);
      slot.view.setInterference(hits);
    }
  });
  updateHuds();
  refreshGeometryReadouts();
  syncHighlight();
}

function scheduleRebuild(): void {
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    rebuild();
  });
}

function svgIds(svg: SVGSVGElement, attr: 'sel' | 'hover' | 'hit'): string[] {
  return Array.from(svg.querySelectorAll<SVGGElement>('g.part'))
    .filter((g) => g.dataset[attr] === '1')
    .map((g) => g.dataset.part ?? '')
    .filter(Boolean);
}

function selectedTreeRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-panel="left"][data-for="assembly"] .tree-row.is-sel');
}

function syncHighlight(): void {
  const row = selectedTreeRow();
  selectedNode = row?.dataset.node ?? null;
  slots.forEach((slot) => {
    const svgSel = svgIds(slot.svg, 'sel');
    const hover = svgIds(slot.svg, 'hover')[0] ?? null;
    const hit = svgIds(slot.svg, 'hit')[0] ?? null;
    const state: HighlightState = slot.kind === 'assembly'
      ? { selected: resolveSelection(tree, svgSel, selectedNode), hover, hit: null, ghostOthers: false }
      : { selected: [], hover: null, hit, ghostOthers: hit !== null };
    highlight[slot.kind] = state;
    slot.view?.setHighlight(state);
  });
}

function scheduleHighlight(): void {
  if (highlightQueued) return;
  highlightQueued = true;
  queueMicrotask(() => {
    highlightQueued = false;
    syncHighlight();
  });
}

/* ------------------------------------------------------------- 3D → 原型 */

function dispatchToProto(slot: StageSlot, partId: string, type: 'click' | 'mouseover'): boolean {
  const g = svgPart(slot.svg, partId);
  if (!g) return false;
  g.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  return true;
}

function onPick(slot: StageSlot, partId: string | null): void {
  if (!partId) return;
  if (!dispatchToProto(slot, partId, 'click')) return;
  if (slot.kind === 'assembly') {
    const nodeId = nodeForPart(tree, partId);
    const row = nodeId
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-panel="left"][data-for="assembly"] .tree-row'))
        .find((item) => item.dataset.node === nodeId)
      : null;
    row?.scrollIntoView?.({ block: 'nearest' });
  }
}

function onHover(slot: StageSlot, partId: string | null): void {
  if (slot.kind !== 'assembly') return;
  if (partId) dispatchToProto(slot, partId, 'mouseover');
  else slot.stage.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, view: window }));
}

/* ------------------------------------------------------------- HUD / 工具条 */

function updateHuds(): void {
  slots.forEach((slot) => {
    if (!slot.view) return;
    const spans = slot.stage.querySelectorAll<HTMLElement>('.vp-hud > span');
    const state = slot.view.state();
    if (slot.kind === 'assembly') {
      const label = state.view ? VIEW_LABELS[state.view] : '自由视角';
      if (spans[0] && spans[0].textContent !== label) spans[0].textContent = label;
      if (spans[2] && spans[2].textContent !== 'WebGL') spans[2].textContent = 'WebGL';
      const proj = state.projection === 'perspective' ? '透视开' : '透视关';
      if (spans[4] && spans[4].textContent !== proj) spans[4].textContent = proj;
    } else if (assembly && spans[2]) {
      const text = `X=${Math.round(assembly.sectionX * 10) / 10}`;
      if (spans[2].textContent !== text) spans[2].textContent = text;
    }
    slot.bar?.querySelectorAll<HTMLElement>('[data-orbit-view]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.orbitView === state.view);
    });
    slot.bar?.querySelectorAll<HTMLElement>('[data-orbit-proj]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.orbitProj === state.projection);
    });
    const chip = slot.bar?.querySelector<HTMLElement>('[data-orbit-hits]');
    if (chip) {
      chip.hidden = slot.kind !== 'check';
      chip.textContent = `包围盒初筛 ${hits.length} 处`;
      chip.title = hits.map((hit) => `${hit.a} ↔ ${hit.b}`).join('\n') || '无重叠';
    }
  });
}

function drawAxes(slot: StageSlot): void {
  if (!slot.view) return;
  const svg = slot.stage.querySelector<SVGSVGElement>('.vp-axis svg');
  if (!svg) return;
  const axes = slot.view.axes();
  const o = 28, len = 18;
  const colors: Record<string, string> = { x: '#E5797A', y: '#7CC48F', z: '#7AA7E8' };
  const html = (['x', 'y', 'z'] as const).map((key) => {
    const [dx, dy] = axes[key];
    const x = o + dx * len, y = o + dy * len;
    const tx = o + dx * (len + 7), ty = o + dy * (len + 7) + 3;
    return `<path d="M${o} ${o}L${x.toFixed(1)} ${y.toFixed(1)}" stroke="${colors[key]}" stroke-width="1.2"/>` +
      `<text x="${(tx - 2.5).toFixed(1)}" y="${ty.toFixed(1)}" font-size="8" fill="${colors[key]}" font-family="monospace">${key.toUpperCase()}</text>`;
  }).join('');
  if (svg.dataset.orbitAxes !== html) {
    svg.dataset.orbitAxes = html;
    svg.innerHTML = html;
  }
}

function positionCallout(slot: StageSlot): void {
  if (slot.kind !== 'check' || !slot.view || !assembly) return;
  const callout = document.getElementById('checkCallout');
  if (!callout || callout.hidden) return;
  const hit = highlight.check.hit;
  const part = assembly.parts.find((item) => item.id === hit);
  if (!part) return;
  const c: [number, number, number] = [
    (part.bbox.min[0] + part.bbox.max[0]) / 2,
    (part.bbox.min[1] + part.bbox.max[1]) / 2,
    part.bbox.max[2]
  ];
  const p = slot.view.projectToHost(c);
  const left = `${Math.min(92, Math.max(2, p.x)).toFixed(2)}%`;
  const top = `${Math.min(92, Math.max(2, p.y - 4)).toFixed(2)}%`;
  if (callout.style.left !== left) callout.style.left = left;
  if (callout.style.top !== top) callout.style.top = top;
}

function buildBar(slot: StageSlot): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'orbit-bar';
  bar.dataset.orbitBar = slot.kind;
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '3D 视图');
  bar.innerHTML = VIEW_BUTTONS.map((view) =>
    `<button type="button" class="orbit-btn" data-orbit-view="${view}" title="${VIEW_LABELS[view]}">${VIEW_LABELS[view]}</button>`).join('') +
    '<span class="orbit-sep"></span>' +
    '<button type="button" class="orbit-btn" data-orbit-proj="perspective" title="透视投影">透视</button>' +
    '<button type="button" class="orbit-btn" data-orbit-proj="orthographic" title="正交投影">正交</button>' +
    '<span class="orbit-sep"></span>' +
    '<button type="button" class="orbit-btn" data-orbit-fit title="全部可见 (F)">适合</button>' +
    '<span class="orbit-chip" data-orbit-hits hidden></span>';
  bar.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    event.stopPropagation();
    if (!target || !slot.view) return;
    const view = target.dataset.orbitView;
    if (view && isStandardView(view)) slot.view.setStandardView(view);
    else if (target.dataset.orbitProj === 'perspective' || target.dataset.orbitProj === 'orthographic') {
      slot.view.setProjection(target.dataset.orbitProj);
    } else if (target.dataset.orbitFit !== undefined) slot.view.fitAll();
    updateHuds();
  });
  ['pointerdown', 'pointerup'].forEach((type) => bar.addEventListener(type, (event) => event.stopPropagation()));
  return bar;
}

/** 原型 vp-tools 里「平移」「剖切」按钮原本只切换高亮态；WebGL 模式下赋予真实行为。 */
function syncVpTools(slot: StageSlot): void {
  if (!slot.view) return;
  const buttons = Array.from(slot.stage.querySelectorAll<HTMLElement>('.vp-tools .vpbtn'));
  const active = (prefix: string): boolean =>
    buttons.some((button) => (button.title || '').startsWith(prefix) && button.classList.contains('is-active'));
  slot.view.setPanMode(active('平移'));
  slot.view.setClipping(active('剖切'));
}

/* ------------------------------------------------------------- 属性面板注入 */

function rightPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-panel="right"][data-for="assembly"]');
}

function currentPanelPart(): string | null {
  const row = selectedTreeRow();
  if (row?.dataset.part) return row.dataset.part;
  const svg = assemblySvg();
  return svg ? svgIds(svg, 'sel')[0] ?? null : null;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function bboxText(partId: string): string {
  const part = assembly?.parts.find((item) => item.id === partId);
  if (!part) return '—';
  const b = part.bbox;
  return `${fmt(b.max[0] - b.min[0])} × ${fmt(b.max[1] - b.min[1])} × ${fmt(b.max[2] - b.min[2])}`;
}

function injectGeometryGroup(): void {
  const panel = rightPanel();
  if (!panel || !slots.some((slot) => slot.kind === 'assembly' && slot.view)) return;
  const body = panel.querySelector<HTMLElement>('.panel-body');
  const pid = currentPanelPart();
  if (!body || !pid || !assembly?.parts.some((part) => part.id === pid)) return;
  const existing = body.querySelector<HTMLElement>('[data-orbit-geom]');
  if (existing && existing.dataset.orbitGeom === pid) return;
  existing?.remove();

  const schema = paramSchema(pid, inputs());
  const values = effectiveParams(pid, inputs());
  const fields = schema.map((def) => `
    <div class="field"><label title="${def.label}">${def.label}</label>
      <span class="ctlr"><input class="ctl mono" type="number" step="any" value="${fmt(values[def.key] ?? 0)}"
        data-orbit-part="${pid}" data-orbit-key="${def.key}" min="${def.min}" max="${def.max}" spellcheck="false">
        <i class="suffix">${def.unit}</i></span></div>`).join('');
  const note = pid === 'cyl'
    ? '缸径 / 行程直接改上方「几何参数」，3D 实时重建。'
    : pid === 'rod' ? '活塞杆随缸径 / 行程联动。' : schema.length ? '修改后沿叠放链联动（底板 → 导轨 → 滑台 → 气缸）。' : '';
  const section = document.createElement('section');
  section.className = 'pgroup orbit-geom';
  section.dataset.pgroup = '';
  section.dataset.orbitGeom = pid;
  section.innerHTML = `
    <button type="button" class="pgroup-head" data-pgroup-head>3D 几何 · 桌面版
      <svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg>
    </button>
    <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">
      ${fields}
      <div class="field"><label>包围盒</label><div class="ctl-ro mono" data-orbit-bbox="${pid}">${bboxText(pid)} <i class="ro-unit">mm</i></div></div>
      ${note ? `<div class="orbit-note">${note}</div>` : ''}
      <div class="orbit-msg" data-orbit-msg></div>
      ${schema.length ? `<button type="button" class="orbit-reset" data-orbit-reset="${pid}">恢复默认</button>` : ''}
    </div></div></div>`;
  body.appendChild(section);
}

function refreshGeometryReadouts(): void {
  document.querySelectorAll<HTMLElement>('[data-orbit-bbox]').forEach((el) => {
    el.innerHTML = `${bboxText(el.dataset.orbitBbox ?? '')} <i class="ro-unit">mm</i>`;
  });
  document.querySelectorAll<HTMLInputElement>('input[data-orbit-part]').forEach((input) => {
    if (document.activeElement === input) return;
    const value = effectiveParams(input.dataset.orbitPart ?? '', inputs())[input.dataset.orbitKey ?? ''];
    if (value !== undefined && Number(input.value) !== value) input.value = fmt(value);
  });
}

function commitEdit(partId: string, key: string, value: unknown): EditResult {
  tree = readTree();
  readInserted();
  const result = applyParamEdit(inputs(), partId, key, value);
  if (result.ok) {
    overrides = result.overrides;
    rebuild();
  }
  return result;
}

function handleGeometryInput(input: HTMLInputElement): void {
  window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    const partId = input.dataset.orbitPart ?? '';
    const key = input.dataset.orbitKey ?? '';
    const result = commitEdit(partId, key, input.value);
    const msg = input.closest('[data-orbit-geom]')?.querySelector<HTMLElement>('[data-orbit-msg]');
    input.classList.toggle('is-invalid', !result.ok);
    input.title = result.ok ? '' : result.message;
    if (msg) msg.textContent = result.ok ? '' : result.message;
  }, 180);
}

/* ------------------------------------------------------------- 挂载 */

function mountSlot(kind: StageKind, stage: HTMLElement, svg: SVGSVGElement, reasons: string[]): StageSlot {
  const slot: StageSlot = { kind, stage, svg, view: null, fallbackReason: null, bar: null };
  const created = OrbitView.create({
    host: stage,
    onPick: (partId) => onPick(slot, partId),
    onHover: (partId) => onHover(slot, partId),
    onRender: () => {
      drawAxes(slot);
      positionCallout(slot);
      updateHuds();
    }
  });
  if (!created.ok) {
    slot.fallbackReason = created.reason;
    stage.dataset.orbit = 'fallback';
    stage.title = `WebGL 不可用，已降级为等轴测示意：${created.reason}`;
    reasons.push(`${kind}: ${created.reason}`);
    return slot;
  }
  slot.view = created.view;
  // 画布插在 SVG 之后、工具层之前。
  svg.after(created.view.canvas);
  stage.dataset.orbit = 'webgl';
  slot.bar = buildBar(slot);
  stage.appendChild(slot.bar);
  created.view.onContextLost = () => degrade(slot, 'WebGL 上下文丢失');
  syncVpTools(slot);
  new MutationObserver(() => syncVpTools(slot)).observe(stage.querySelector('.vp-tools') ?? stage, {
    attributes: true, subtree: true, attributeFilter: ['class']
  });
  return slot;
}

function degrade(slot: StageSlot, reason: string): void {
  slot.view?.dispose();
  slot.view = null;
  slot.bar?.remove();
  slot.bar = null;
  slot.fallbackReason = reason;
  slot.stage.dataset.orbit = 'fallback';
  slot.stage.title = `WebGL 不可用，已降级为等轴测示意：${reason}`;
  document.querySelectorAll('[data-orbit-geom]').forEach((el) => el.remove());
}

function activeSlot(stage?: StageKind): StageSlot | undefined {
  if (stage) return slots.find((slot) => slot.kind === stage);
  return slots.find((slot) => slot.view && slot.stage.offsetParent !== null) ?? slots.find((slot) => slot.kind === 'assembly');
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && /input|textarea|select/i.test(target.tagName);
}

function bindDocument(): void {
  document.addEventListener('input', (event) => {
    const el = event.target as HTMLElement;
    if (!(el instanceof HTMLInputElement)) return;
    if (el.dataset.orbitPart) {
      handleGeometryInput(el);
      return;
    }
    if (el.dataset.part === 'cyl' && el.dataset.field === 'bore') borePool = pushCandidate(borePool, el.value);
    if (el.dataset.part === 'cyl' && el.dataset.field === 'stroke') strokePool = pushCandidate(strokePool, el.value);
    if (el.dataset.sizing === 'stroke') strokePool = pushCandidate(strokePool, el.value);
  });
  document.addEventListener('click', (event) => {
    const t = event.target as HTMLElement | null;
    const reset = t?.closest<HTMLElement>('[data-orbit-reset]');
    if (reset) {
      event.stopPropagation();
      handle?.resetPart(reset.dataset.orbitReset ?? '');
      const group = reset.closest('[data-orbit-geom]');
      group?.querySelectorAll('input.is-invalid').forEach((input) => input.classList.remove('is-invalid'));
      const msg = group?.querySelector<HTMLElement>('[data-orbit-msg]');
      if (msg) msg.textContent = '';
      return;
    }
    const fit = t?.closest<HTMLElement>('[data-vp][data-act="fit"]');
    if (fit) {
      const stage = fit.closest<HTMLElement>('.stage');
      slots.find((slot) => slot.stage === stage)?.view?.fitAll();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (event.key === 'f' || event.key === 'F') activeSlot()?.view?.fitAll();
  });
}

export function initOrbitView(): OrbitHandle {
  if (handle) return handle;
  injectStyles();
  const reasons: string[] = [];
  const pairs: Array<[StageKind, string, string]> = [['assembly', '#stageAssembly', '#scene3d'], ['check', '#stageCheck', '#sceneCheck']];
  slots = [];
  pairs.forEach(([kind, stageSel, svgSel]) => {
    const stage = document.querySelector<HTMLElement>(stageSel);
    const svg = document.querySelector<SVGSVGElement>(svgSel);
    if (!stage || !svg) return;
    slots.push(mountSlot(kind, stage, svg, reasons));
  });

  slots.forEach((slot) => {
    new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList' && record.target === slot.svg)) scheduleRebuild();
      else scheduleHighlight();
    }).observe(slot.svg, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-sel', 'data-hover', 'data-hit'] });
  });
  const left = document.querySelector('[data-panel="left"][data-for="assembly"]');
  if (left) new MutationObserver(scheduleHighlight).observe(left, { childList: true, subtree: true });
  const right = rightPanel();
  if (right) new MutationObserver(() => queueMicrotask(injectGeometryGroup)).observe(right, { childList: true });
  const callout = document.getElementById('checkCallout');
  if (callout) {
    new MutationObserver(() => slots.find((slot) => slot.kind === 'check')?.view?.requestRender())
      .observe(callout, { attributes: true, attributeFilter: ['style', 'hidden'] });
  }
  bindDocument();
  rebuild();
  injectGeometryGroup();

  const mode = (): OrbitPublicState['mode'] => {
    const live = slots.filter((slot) => slot.view).length;
    if (live === 0) return 'fallback';
    return live === slots.length ? 'webgl' : 'partial';
  };

  handle = {
    state: () => ({
      mode: mode(),
      reasons: slots.map((slot) => slot.fallbackReason).filter((r): r is string => !!r),
      bore: current.bore,
      stroke: current.stroke,
      boreExact: current.boreExact,
      strokeExact: current.strokeExact,
      parts: (assembly?.parts ?? []).map((part) => ({ id: part.id, bbox: { min: [...part.bbox.min], max: [...part.bbox.max] } })),
      selected: [...highlight.assembly.selected],
      selectedNode,
      hover: highlight.assembly.hover,
      hit: highlight.check.hit,
      overrides: JSON.parse(JSON.stringify(overrides)) as ParamOverrides,
      interference: hits.map((hit) => ({ a: hit.a, b: hit.b, severity: hit.severity })),
      views: Object.fromEntries(slots.map((slot) => [slot.kind, slot.view ? slot.view.state() : null])),
      rebuilds
    }),
    setView: (view, stage) => {
      const slot = activeSlot(stage);
      if (!slot?.view || !isStandardView(view)) return false;
      slot.view.setStandardView(view);
      updateHuds();
      return true;
    },
    setProjection: (projection, stage) => {
      const slot = activeSlot(stage);
      if (!slot?.view) return false;
      slot.view.setProjection(projection);
      updateHuds();
      return true;
    },
    fit: (stage) => {
      const slot = activeSlot(stage);
      if (!slot?.view) return false;
      slot.view.fitAll();
      return true;
    },
    select: (partId, stage = 'assembly') => {
      const slot = slots.find((item) => item.kind === stage);
      return slot ? dispatchToProto(slot, partId, 'click') : false;
    },
    setParam: (partId, key, value) => commitEdit(partId, key, value),
    resetPart: (partId) => {
      overrides = resetPartOverrides(overrides, partId);
      rebuild();
    },
    sync: () => rebuild()
  };
  Object.defineProperty(window, 'AutomationCadOrbit', {
    value: Object.freeze(handle),
    writable: false,
    configurable: false,
    enumerable: false
  });
  return handle;
}
