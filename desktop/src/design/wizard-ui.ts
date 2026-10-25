import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import styles from './wizard.css?inline';
import type { Placement } from '../enclosure/layout.ts';
import { buildEntryButton } from '../ui/panels.ts';
import { generateMachineGeometry } from '../machine/geometry.ts';
import { buildThreeMachine, disposeThreeMachine, type ThreeMachine } from '../machine/geometry-three.ts';
import { geometryToStl, partWorldTriangles } from '../machine/geometry-export.ts';
import { completeDesign } from './synthesis.ts';
import { toCsv, type BomRow } from '../export/bom.ts';
import { renderReportHtml } from '../export/report.ts';
import { generateProject } from '../plcgen/generate.ts';
import { buildMachineCircuit } from '../elec/machine-circuit.ts';
import { renderSheet } from '../elec/sheet.ts';
import { buildMachineIoMap } from '../machine/io-map.ts';
import { selectMotorProtection } from '../elec/protection.ts';
import type { ComponentPart } from '../shared/types.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { validateMachineConfig } from '../commission/machine-config.ts';
import { generateCandidates } from './candidates.ts';
import { autoLayout, inspectLayout, movePlacement, type DesignCanvasSize } from './layout.ts';
import { reviewDesign, type DesignReview } from './review.ts';
import { saveDesignProject } from './save-service.ts';
import {
  briefToMachineBrief, canAdvance, configFromStations, DESIGN_STEPS, DESIGN_STEP_LABELS,
  emptyBrief, initialDraft, nextStep, parseDesignDraft, pointsFromConfig, prevStep,
  selectCandidate, stationsFromDesign, validateStep, withBrief, withCandidates, withPlacements,
  withStations, type ActuatorDraft, type DesignDraft, type DesignProcess, type IncomingForm,
  type LoadingMethod, type MachineBriefInput, type StationDraft
} from './wizard-state.ts';
import {
  allocateActuatorPoints, allocateSensorPoint, allPoints, bindPartFields, filterPartsForKind,
  filterSensorParts, validatePartBindings, validatePointConflicts
} from './parts.ts';

export interface DesignWizardOptions {
  onSaved(id: string): Promise<void>;
  openProject(id: string): Promise<unknown>;
  notify(message: string, error?: boolean): void;
}

let activeWizard: { open(): void; close(): void } | null = null;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function numberText(value: number): string { return Number.isFinite(value) ? String(value) : ''; }
function geometryFor(design: MachineDesign): ReturnType<typeof generateMachineGeometry> {
  return generateMachineGeometry(design, { process: design.config.id.match(/design-([a-z]+)-/)?.[1] as never, layout: design.form.geometry.kind === 'conveyor' ? 'linear' : design.form.geometry.kind });
}
function bomRows(design: MachineDesign): BomRow[] {
  return design.bomDraft.items.map((item, index) => ({ index: index + 1, name: item.name, model: item.model ?? '待选型', quantity: item.qty, material: item.kind === 'electrical' ? '电气件' : '标准件', ...(item.note ? { note: item.note } : {}) }));
}

export function initDesignWizard(options: DesignWizardOptions): { open(): void; close(): void } {
  if (activeWizard) return activeWizard;
  let draft = initialDraft();
  let savedDraft = false;
  let library: ComponentPart[] = [];
  let designSettings: { pricing?: import('../machine/cost-model.ts').MachinePricingLoad; builtinPricebook?: import('../cost/pricebook.ts').Pricebook } = {};
  let selectedStation = 0;
  let review: DesignReview | null = null;
  let notice = '';
  let partPicker: { station: number; kind: 'actuator' | 'sensor'; index: number } | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let threeMachine: ThreeMachine | null = null;
  let animation = 0;
  let resizeObserver: ResizeObserver | null = null;
  let loadVersion = 0;
  const style = document.createElement('style');
  style.id = 'design-wizard-styles';
  style.textContent = styles;
  document.head.appendChild(style);
  const root = document.createElement('section');
  root.id = 'designWizard';
  root.className = 'design-wizard';
  root.hidden = true;
  root.setAttribute('aria-label', '整机设计五步向导');
  document.body.appendChild(root);
  const entry = buildEntryButton('designWizardEntry', '整机设计', '<svg viewBox="0 0 16 16"><path d="M2 12V5l6-3 6 3v7l-6 3zM2 5l6 3 6-3M8 8v7"/></svg>', () => open());
  entry?.classList.add('design-entry');
  const preview = document.createElement('div');
  preview.className = 'design-preview-modal';
  preview.hidden = true;
  preview.innerHTML = '<div class="design-preview-dialog" role="dialog" aria-modal="true" aria-label="整机 3D 预览"><div class="design-preview-head"><h3 id="designPreviewTitle">3D 预览</h3><button type="button" class="design-button" id="designPreviewClose">关闭</button></div><div class="design-preview-host" id="designPreviewHost"></div><p class="design-preview-note">鼠标拖动旋转、滚轮缩放。几何为标准件外形预览，不替代实体干涉与强度校核。</p></div>';
  root.appendChild(preview);
  preview.querySelector('#designPreviewClose')?.addEventListener('click', closePreview);

  function updateEntry(): void {
    if (!entry) return;
    const label = savedDraft && draft.brief.name ? `继续设计（第 ${draft.step} 步）` : '整机设计';
    const text = entry.querySelector('span');
    if (text) text.textContent = label;
    entry.title = label;
    entry.setAttribute('aria-label', label);
  }
  async function saveDraft(): Promise<void> {
    if (!window.desktop?.design) return;
    const result = await window.desktop.design.saveDraft(draft);
    if (!result.ok) throw new Error(result.message ?? '草稿保存失败');
    savedDraft = true;
    updateEntry();
  }
  async function commit(next: DesignDraft, persist = true): Promise<void> {
    draft = next;
    if (persist) await saveDraft();
    render();
  }
  function closePreview(): void {
    preview.hidden = true;
    cancelAnimationFrame(animation);
    resizeObserver?.disconnect();
    resizeObserver = null;
    controls?.dispose();
    controls = null;
    if (threeMachine) disposeThreeMachine(threeMachine);
    threeMachine = null;
    renderer?.dispose();
    renderer?.domElement.remove();
    renderer = null;
    scene = null;
  }
  function openPreview(design: MachineDesign): void {
    closePreview();
    preview.hidden = false;
    const host = preview.querySelector<HTMLElement>('#designPreviewHost');
    if (!host) return;
    const title = preview.querySelector('#designPreviewTitle');
    if (title) title.textContent = `${design.form.name} · 3D 预览`;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      host.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#eaf0f2');
      camera = new THREE.PerspectiveCamera(38, 1, 0.01, 300);
      camera.position.set(8, 7, 10);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x66747c, 2.3));
      const light = new THREE.DirectionalLight(0xffffff, 2.4);
      light.position.set(5, 10, 8);
      scene.add(light);
      scene.add(new THREE.GridHelper(20, 20, 0x8da7ad, 0xc3d0d5));
      threeMachine = buildThreeMachine(geometryFor(design), { targetSpan: 7 });
      scene.add(threeMachine.root);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 1, 0);
      controls.update();
      const resize = (): void => {
        if (!renderer || !camera || host.clientWidth === 0 || host.clientHeight === 0) return;
        renderer.setSize(host.clientWidth, host.clientHeight, false);
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      const frame = (): void => {
        if (preview.hidden) return;
        controls?.update();
        if (renderer && scene && camera) renderer.render(scene, camera);
        animation = requestAnimationFrame(frame);
      };
      frame();
    } catch (error) {
      host.textContent = `3D 预览不可用：${errorMessage(error)}`;
      options.notify(`3D 预览不可用：${errorMessage(error)}`, true);
    }
  }
  function field(name: string, label: string, control: string, example: string, wide = false): string {
    return `<label class="design-field${wide ? ' wide' : ''}" data-field="${name}"><span>${label}</span>${control}<small>${example}</small><span class="design-error" data-error-for="${name}"></span></label>`;
  }
  function renderBrief(): string {
    const brief = draft.brief;
    const vendors = [...new Set(library.map((part) => part.vendor).filter((vendor): vendor is string => Boolean(vendor)))].sort();
    return `<h2>第 1 步 · 需求</h2><p class="design-help">从产品与工艺开始，后续每一步都能回退。留空工位数和占地，将使用方案推荐值。</p><form class="design-form" id="designBriefForm" novalidate>
      ${field('name', '产品/机型名称 *', `<input name="name" value="${escapeHtml(brief.name)}" placeholder="例如：连接器自动锁螺丝机" required>`, '必填；示例：连接器自动锁螺丝机', true)}
      ${field('incoming', '来料形式', `<select name="incoming">${[['bulk','散料'],['tray','托盘'],['aligned','整列'],['reel','卷料']].map(([key,label]) => `<option value="${key}" ${brief.incoming === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '示例：振动盘供给的散料')}
      ${field('process', '工艺类型', `<select name="process">${[['screw','锁螺丝'],['dispense','点胶'],['inspection','检测'],['assembly','装配'],['packaging','包装']].map(([key,label]) => `<option value="${key}" ${brief.process === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '使用现有 5 类工艺模板')}
      ${field('cyclePerMin', '目标产能（件/分钟）*', `<input name="cyclePerMin" type="number" min="0.01" step="0.1" value="${numberText(brief.cyclePerMin)}">`, '必须大于 0；示例：20')}
      ${field('stations', '期望工位数', `<input name="stations" type="number" min="1" max="12" step="1" value="${brief.stations ?? ''}" placeholder="自动推荐">`, '1–12 的整数，可留空')}
      ${field('load', '上下料方式', `<select name="load">${[['manual','人工'],['conveyor','输送线'],['robot','机械手']].map(([key,label]) => `<option value="${key}" ${brief.load === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '示例：机械手上下料')}
      ${field('footprint', '占地限制：长 × 宽（mm）', `<div class="design-inline"><input name="lengthMm" type="number" min="1" value="${brief.footprint?.lengthMm ?? ''}" placeholder="长，例如 3000"><span>×</span><input name="widthMm" type="number" min="1" value="${brief.footprint?.widthMm ?? ''}" placeholder="宽，例如 1800"></div>`, '可留空；需同时填写两个正数')}
      ${field('voltage', '供电制式', `<select name="voltage"><option value="380VAC" ${brief.voltage === '380VAC' ? 'selected' : ''}>380VAC</option><option value="220VAC" ${brief.voltage === '220VAC' ? 'selected' : ''}>220VAC</option></select>`, '影响功率/电流估算')}
      ${field('brand', '品牌偏好', `<select name="brand"><option value="">不限</option>${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}" ${brief.brand === vendor ? 'selected' : ''}>${escapeHtml(vendor)}</option>`).join('')}</select>`, '可留空；来自已启用元件库 vendor')}
    </form>${notice ? `<div class="design-notice">${escapeHtml(notice)}</div>` : ''}`;
  }
  function renderCandidates(): string {
    return `<h2>第 2 步 · 方案对比</h2><p class="design-help">同一需求、同一 synthMachine 算法生成 3 个不同形态。点击卡片选择主方案；假设与警告全部展开。</p><div class="design-candidates">${(draft.candidates ?? []).map((candidate, index) => {
      const geometry = geometryFor(candidate);
      const selected = draft.selectedIndex === index;
      return `<article class="design-candidate ${selected ? 'selected' : ''}" data-candidate="${index}" tabindex="0" role="button" aria-pressed="${selected}"><h3>${escapeHtml(candidate.form.name)}</h3><div class="design-candidate-id">${escapeHtml(candidate.form.id)}</div><div class="design-metrics">
        <div><span>工位数</span><b>${candidate.config.stations.length}</b></div><div><span>产能</span><b class="${candidate.cycle.meetsTarget ? 'design-good' : 'design-bad'}">${candidate.cycle.partsPerMinute.toFixed(2)} 件/分钟 · ${candidate.cycle.meetsTarget ? '达标' : '未达标'}</b></div>
        <div><span>占地</span><b>${Math.round(geometry.envelope[0])} × ${Math.round(geometry.envelope[1])} mm</b></div><div><span>装机功率 / 电流</span><b>${candidate.power.totalKw.toFixed(2)} kW / ${candidate.power.currentA.toFixed(2)} A</b></div>
        <div><span>成本合计</span><b>¥${candidate.cost.total.toFixed(2)}</b></div><div><span>缺价 / BOM</span><b>${candidate.cost.missingCount} 项 / ${candidate.bomDraft.items.length} 行</b></div>
        <div><span>警告条数</span><b>${candidate.warnings.length}</b></div><button type="button" class="design-button" data-preview="${index}">查看 3D 预览</button></div>
        <h3>设计假设（${candidate.assumptions.length}）</h3><ul class="design-text-list">${candidate.assumptions.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul>
        <h3>警告（${candidate.warnings.length}）</h3><ul class="design-text-list warnings">${candidate.warnings.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul></article>`;
    }).join('')}</div>`;
  }
  function renderStations(): string {
    const station = draft.stations[selectedStation];
    const issues = [...validatePartBindings(draft.stations, library), ...validatePointConflicts(draft.stations)];
    return `<h2>第 3 步 · 工位与元件</h2><p class="design-help">直接编辑表格。新增机构/传感器按现有点位规则自动分配；型号搜索最多显示 20 条。</p><div class="design-stations-layout"><aside class="design-panel"><button class="design-button" type="button" data-action="add-station">＋ 添加工位</button><div id="designStationList">${draft.stations.map((item, index) => `<div class="design-station-item ${index === selectedStation ? 'active' : ''}" data-station="${index}"><span class="grow">${escapeHtml(item.name)}<small> · ${item.actuators.length} 机构 / ${item.sensors.length} 传感</small></span><button class="design-icon-button" data-move-station="${index}" data-direction="-1" title="上移">↑</button><button class="design-icon-button" data-move-station="${index}" data-direction="1" title="下移">↓</button><button class="design-icon-button" data-delete-station="${index}" title="删除">×</button></div>`).join('')}</div></aside><div class="design-panel">${station ? `<div class="design-inline"><input aria-label="工位名称" id="designStationName" value="${escapeHtml(station.name)}"><span>执行机构 ${station.actuators.length} · 传感器 ${station.sensors.length}</span></div>
      <h3>执行机构 <button class="design-button" type="button" data-action="add-actuator">＋ 添加</button></h3><div class="design-table-wrap"><table class="design-table"><thead><tr><th>名称</th><th>类型</th><th>绑定型号</th><th>伸出点位</th><th>缩回点位</th><th>夹紧点位</th><th>元件库</th><th></th></tr></thead><tbody>${station.actuators.map((item, index) => `<tr><td><input data-actuator="${index}" data-key="name" value="${escapeHtml(item.name)}"></td><td><select data-actuator="${index}" data-key="kind"><option value="cylinder" ${item.kind === 'cylinder' ? 'selected' : ''}>气缸</option><option value="gripper" ${item.kind === 'gripper' ? 'selected' : ''}>夹爪</option><option value="rotary" ${item.kind === 'rotary' ? 'selected' : ''}>旋转</option></select></td><td><input data-actuator="${index}" data-key="model" value="${escapeHtml(item.model ?? '')}" placeholder="待选型"></td><td><input data-actuator="${index}" data-key="extendPoint" value="${escapeHtml(item.extendPoint ?? '')}"></td><td><input data-actuator="${index}" data-key="retractPoint" value="${escapeHtml(item.retractPoint ?? '')}"></td><td><input data-actuator="${index}" data-key="gripPoint" value="${escapeHtml(item.gripPoint ?? '')}"></td><td><button class="design-button" data-pick-part="actuator" data-index="${index}">选择</button></td><td><button class="design-icon-button" data-delete-actuator="${index}">×</button></td></tr>`).join('')}</tbody></table></div>
      <h3>传感器 <button class="design-button" type="button" data-action="add-sensor">＋ 添加</button></h3><div class="design-table-wrap"><table class="design-table"><thead><tr><th>点位</th><th>安装工位</th><th>绑定型号</th><th>元件库</th><th></th></tr></thead><tbody>${station.sensors.map((item, index) => `<tr><td><input data-sensor="${index}" data-key="point" value="${escapeHtml(item.point)}"></td><td>${escapeHtml(station.name)}</td><td><input data-sensor="${index}" data-key="model" value="${escapeHtml(item.model ?? '')}" placeholder="待选型"></td><td><button class="design-button" data-pick-part="sensor" data-index="${index}">选择</button></td><td><button class="design-icon-button" data-delete-sensor="${index}">×</button></td></tr>`).join('')}</tbody></table></div>` : '<p>请添加工位。</p>'}${renderPartPicker()}${issues.length ? `<div class="design-errors">${issues.map((issue) => `<div><code>${issue.code}</code> ${escapeHtml(issue.message)}</div>`).join('')}</div>` : ''}</div></div>`;
  }
  function renderPartPicker(): string {
    if (!partPicker) return '';
    const station = draft.stations[partPicker.station];
    const item = partPicker.kind === 'actuator' ? station?.actuators[partPicker.index] : station?.sensors[partPicker.index];
    const filtered = partPicker.kind === 'actuator' ? filterPartsForKind(library, (item as ActuatorDraft)?.kind ?? 'cylinder') : filterSensorParts(library);
    const categories = [...new Set(filtered.map((part) => part.category))].sort();
    return `<div class="design-part-picker"><b>从元件库绑定型号</b><div class="design-part-tools"><input id="designPartSearch" placeholder="搜索型号 / 名称 / 品牌" value=""><select id="designPartCategory"><option value="">全部分类</option>${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join('')}</select></div><div id="designPartResults" data-total="${filtered.length}"></div></div>`;
  }
  function renderPartResults(): void {
    const host = root.querySelector('#designPartResults');
    if (!host || !partPicker) return;
    const query = (root.querySelector<HTMLInputElement>('#designPartSearch')?.value ?? '').trim().toLowerCase();
    const category = root.querySelector<HTMLSelectElement>('#designPartCategory')?.value ?? '';
    const station = draft.stations[partPicker.station];
    const item = partPicker.kind === 'actuator' ? station?.actuators[partPicker.index] : station?.sensors[partPicker.index];
    const candidates = (partPicker.kind === 'actuator' ? filterPartsForKind(library, (item as ActuatorDraft)?.kind ?? 'cylinder') : filterSensorParts(library))
      .filter((part) => (!category || part.category === category) && (!query || `${part.model} ${part.category} ${part.vendor ?? ''} ${part.id}`.toLowerCase().includes(query)));
    host.innerHTML = `<p>共 ${candidates.length} 条${candidates.length > 20 ? '，仅显示前 20 条' : ''}</p><div class="design-part-list">${candidates.slice(0, 20).map((part) => `<button type="button" class="design-part" data-bind-part="${escapeHtml(part.id)}" data-pack="${escapeHtml(part.packId ?? '')}"><b>${escapeHtml(part.model)}</b><small>${escapeHtml(part.vendor ?? '—')} · ${escapeHtml(part.category)} · ${escapeHtml(part.packId ?? '')}</small></button>`).join('')}</div>`;
  }
  function canvasSize(): DesignCanvasSize {
    if (draft.brief.footprint) return { width: draft.brief.footprint.lengthMm, height: draft.brief.footprint.widthMm };
    if (draft.design) {
      const envelope = geometryFor(draft.design).envelope;
      return { width: Math.ceil(envelope[0] / 35) * 35, height: Math.ceil(envelope[1] / 35) * 35 };
    }
    return { width: 2100, height: 1050 };
  }
  function renderLayout(): string {
    const size = canvasSize();
    const report = inspectLayout(draft.placements, size);
    const scale = Math.min(1, 1000 / size.width);
    const overlapIds = new Set(report.overlaps.flatMap((pair) => [pair.a, pair.b]));
    const outIds = new Set(report.outOfBounds);
    const rails = Array.from({ length: Math.floor(size.height / 35) + 1 }, (_, index) => `<line class="design-rail" x1="0" y1="${index * 35}" x2="${size.width}" y2="${index * 35}"/>`).join('');
    return `<h2>第 4 步 · 布局</h2><p class="design-help">毫米坐标；拖动按 35 mm 导轨网格吸附。重叠允许继续，但必须确认；越界为错误。</p><div class="design-layout-tools"><button type="button" class="design-button" data-action="auto-layout">自动布局</button><b>${size.width} × ${size.height} mm</b><span>利用率 ${report.utilization}%</span><span>已放置 ${report.placements}（工位 ${report.stations}）</span><span>重叠 ${report.overlaps.length}</span><span>越界 ${report.outOfBounds.length}</span></div>${report.outOfBounds.length ? `<div class="design-errors">越界：${report.outOfBounds.map(escapeHtml).join('、')}</div>` : ''}${report.overlaps.length ? `<div class="design-notice design-conflicts">重叠冲突（允许继续）：${report.overlaps.map((pair) => `${escapeHtml(pair.a)} ↔ ${escapeHtml(pair.b)}`).join('；')}</div>` : ''}<div class="design-canvas"><svg id="designLayoutSvg" width="${size.width * scale}" height="${size.height * scale}" viewBox="0 0 ${size.width} ${size.height}" data-scale="${scale}" aria-label="整机毫米布局画布"><rect width="${size.width}" height="${size.height}" fill="#f8fbfb" stroke="#8aa4ad"/>${rails}${draft.placements.map((item) => `<g data-placement="${escapeHtml(item.id)}"><rect class="design-placement ${item.id.startsWith('station:') ? '' : 'part'} ${overlapIds.has(item.id) ? 'overlap' : ''} ${outIds.has(item.id) ? 'outside' : ''}" x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="3"/><text class="design-placement-label" x="${item.x + 7}" y="${item.y + 20}">${escapeHtml(item.model)}</text><text class="design-placement-label" x="${item.x + 7}" y="${item.y + 37}" font-size="9">${item.x}, ${item.y} mm</text></g>`).join('')}</svg></div>`;
  }
  function renderReview(): string {
    return `<h2>第 5 步 · 校核与产出</h2><p class="design-help">错误阻断保存，警告允许继续。产出一律调用现有 BOM、PLC、电气与 PDF 能力。</p><button class="design-button primary" type="button" data-action="run-review">一键校核</button>${review ? `<p>错误 ${review.errors} · 警告 ${review.warnings} · 通过 ${review.passed}</p><div class="design-review-groups">${(['error','warning','pass'] as const).map((severity) => `<section class="design-review-group ${severity}"><h3>${severity === 'error' ? '错误（阻断）' : severity === 'warning' ? '警告（可继续）' : '通过'}</h3>${review?.items.filter((item) => item.severity === severity).map((item) => `<div class="design-review-item"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div>`).join('') || '<p>无</p>'}</section>`).join('')}</div>` : '<p class="design-help">尚未校核。</p>'}<h3>交付产出</h3><div class="design-deliverables"><button class="design-button" data-output="bom">生成 BOM</button><button class="design-button" data-output="plc">生成 PLC 工程</button><button class="design-button" data-output="elec">生成电气原理图</button><button class="design-button" data-output="pdf">导出 PDF 报告</button></div><div id="designOutput" class="design-output"></div><button class="design-button primary" data-action="save-project" ${review?.errors ? 'disabled' : ''}>保存为工程</button>`;
  }
  function renderErrors(): string {
    const errors = validateStep(draft);
    return errors.length ? `<div class="design-errors" id="designValidationErrors">${errors.map((error) => `<div>${escapeHtml(error)}</div>`).join('')}</div>` : '';
  }
  function render(): void {
    if (root.hidden) return;
    closePreview();
    selectedStation = Math.min(selectedStation, Math.max(0, draft.stations.length - 1));
    const content = draft.step === 1 ? renderBrief() : draft.step === 2 ? renderCandidates() : draft.step === 3 ? renderStations() : draft.step === 4 ? renderLayout() : renderReview();
    root.innerHTML = `<header class="design-header"><div><h1>整机设计</h1><p>设计入口 · 从需求到可交付工程</p></div><div class="design-header-actions"><button class="design-button danger" data-action="discard">放弃草稿</button><button class="design-button" data-action="close" aria-label="关闭设计向导">关闭 Esc</button></div></header><ol class="design-steps">${DESIGN_STEPS.map((step) => `<li class="${draft.step === step ? 'active' : draft.step > step ? 'done' : ''}" data-step="${step}"><span class="design-step-number">${step}</span>${DESIGN_STEP_LABELS[step]}</li>`).join('')}</ol><main class="design-main"><div class="design-content">${content}${draft.step < 5 ? renderErrors() : ''}</div></main><footer class="design-footer"><span class="design-save-state">${savedDraft ? `草稿已保存 · ${escapeHtml(draft.updatedAt)}` : '关闭时草稿保留'}</span><span class="spacer"></span><button class="design-button" data-action="prev" ${draft.step === 1 ? 'disabled' : ''}>上一步</button><button class="design-button primary" data-action="next" ${draft.step === 5 ? 'disabled' : ''} title="${canAdvance(draft) ? '' : '点击后校验当前步骤'}">下一步</button></footer>`;
    root.appendChild(preview);
    bindEvents();
    if (partPicker) renderPartResults();
  }
  function readBrief(): MachineBriefInput {
    const form = root.querySelector<HTMLFormElement>('#designBriefForm');
    if (!form) return draft.brief;
    const data = new FormData(form);
    const numberValue = (name: string): number => Number(data.get(name));
    const length = numberValue('lengthMm');
    const width = numberValue('widthMm');
    return {
      name: String(data.get('name') ?? '').trim(), incoming: String(data.get('incoming')) as IncomingForm,
      process: String(data.get('process')) as DesignProcess, cyclePerMin: numberValue('cyclePerMin'),
      stations: String(data.get('stations') ?? '').trim() ? numberValue('stations') : null,
      load: String(data.get('load')) as LoadingMethod,
      footprint: String(data.get('lengthMm') ?? '').trim() || String(data.get('widthMm') ?? '').trim() ? { lengthMm: length, widthMm: width } : null,
      voltage: String(data.get('voltage')) === '220VAC' ? '220VAC' : '380VAC',
      brand: String(data.get('brand') ?? '').trim() || null
    };
  }
  function showBriefErrors(errors: string[]): void {
    const rules: [string, RegExp][] = [['name', /产品\/机型/], ['cyclePerMin', /目标产能/], ['stations', /工位数/], ['footprint', /占地/]];
    for (const [name, pattern] of rules) {
      const message = errors.find((error) => pattern.test(error));
      root.querySelector(`[data-field="${name}"]`)?.classList.toggle('invalid', Boolean(message));
      const target = root.querySelector(`[data-error-for="${name}"]`);
      if (target) target.textContent = message ?? '';
    }
    options.notify(errors[0] ?? '请完善需求', true);
  }
  function mergeStations(generated: StationDraft[], previous: StationDraft[]): { stations: StationDraft[]; kept: number } {
    const old = new Map(previous.map((station) => [station.name, station]));
    let kept = 0;
    const stations = generated.map((station) => {
      const existing = old.get(station.name);
      if (!existing) return station;
      kept += 1;
      return { ...station, name: existing.name, actuators: existing.actuators, sensors: existing.sensors };
    });
    return { stations, kept };
  }
  function updateDesignFromStations(): void {
    if (!draft.design) return;
    const design = draft.design as MachineDesign;
    const config = configFromStations(design, draft.stations);
    draft = withStations(draft, draft.stations);
    draft.design = { ...design, config, points: pointsFromConfig(config) };
    review = null;
  }
  function syncEditedDraft(): void {
    if (draft.step === 1) draft = withBrief(draft, readBrief());
    else if (draft.step === 3) updateDesignFromStations();
    else if (draft.step === 4) draft = withPlacements(draft, draft.placements);
  }
  async function advance(): Promise<void> {
    try {
      syncEditedDraft();
      let errors = validateStep(draft);
      if (draft.step === 3) {
        const issues = [...validatePartBindings(draft.stations, library), ...validatePointConflicts(draft.stations)];
        errors = [...errors, ...issues.map((issue) => issue.message)];
      }
      if (draft.step === 4) {
        const outside = inspectLayout(draft.placements, canvasSize()).outOfBounds;
        if (outside.length) errors.push(`布局越界：${outside.join('、')}`);
      }
      if (errors.length) {
        if (draft.step === 1) showBriefErrors(errors);
        else options.notify(errors.join('；'), true);
        render();
        return;
      }
      if (draft.step === 1) {
        const previous = draft.stations;
        const candidates = generateCandidates(briefToMachineBrief(draft.brief)).map((candidate) => completeDesign(briefToMachineBrief(draft.brief), library, { formId: candidate.form.id, stationCount: candidate.config.stations.length, ...(designSettings.pricing ? { pricingLoad: designSettings.pricing } : {}), ...(designSettings.builtinPricebook ? { builtinPricebook: designSettings.builtinPricebook } : {}) }));
        draft = withCandidates(draft, candidates);
        draft = selectCandidate(draft, 0);
        const merged = mergeStations(draft.stations, previous);
        draft = withStations(draft, merged.stations);
        notice = previous.length ? `需求已修改，候选已重新生成；按名称保留 ${merged.kept} 个工位的编辑明细。` : '';
      } else if (draft.step === 3 && draft.placements.length === 0) {
        draft = withPlacements(draft, autoLayout(draft.stations, canvasSize()));
      }
      draft = nextStep(draft);
      await saveDraft();
      render();
    } catch (error) { console.error('[design-wizard] advance failed', error); options.notify(errorMessage(error), true); }
  }
  async function discard(): Promise<void> {
    if (!window.confirm('确定放弃当前整机设计草稿？此操作不可撤销。')) return;
    await window.desktop?.design.clearDraft();
    draft = initialDraft();
    savedDraft = false;
    review = null;
    notice = '';
    selectedStation = 0;
    updateEntry();
    render();
  }
  function stationAction(action: string): void {
    const stations = clone(draft.stations);
    if (action === 'add-station') {
      const index = stations.length + 1;
      stations.push({ id: `station-${Date.now()}`, name: `工位 ${index}`, actuators: [], sensors: [] });
      selectedStation = stations.length - 1;
    } else if (action === 'add-actuator') {
      const station = stations[selectedStation];
      if (!station) return;
      const index = station.actuators.length;
      const kind = 'cylinder';
      station.actuators.push({ id: `actuator-${Date.now()}`, name: `气缸 ${index + 1}`, kind, station: station.name, ...allocateActuatorPoints(selectedStation, index, kind, allPoints(stations)) });
    } else if (action === 'add-sensor') {
      const station = stations[selectedStation];
      if (!station) return;
      const point = allocateSensorPoint(selectedStation, station.sensors.length + 1, 'proximity', allPoints(stations));
      station.sensors.push({ point, station: station.name, part: station.actuators[0]?.id ?? station.name });
    }
    draft = withStations(draft, stations);
    updateDesignFromStations();
    render();
  }
  async function output(kind: string): Promise<void> {
    if (!draft.design) return;
    const outputNode = root.querySelector('#designOutput');
    try {
      const design = draft.design;
      if (kind === 'bom') {
        const csv = toCsv(bomRows(design));
        const result = await window.desktop?.exportCostFile({ format: 'csv', fileName: `${draft.brief.name}-BOM.csv`, data: csv, suggestedName: `${draft.brief.name}-BOM` });
        if (!result?.ok) throw new Error(result?.message ?? 'BOM 导出失败');
        const drawer = document.createElement('aside');
        drawer.className = 'design-bom-drawer';
        drawer.innerHTML = `<header><h3>BOM · ${design.bomDraft.items.length} 行</h3><button class="design-button">关闭</button></header><p>已落盘：${escapeHtml(result.path ?? '')}</p><div class="design-table-wrap"><table class="design-table"><thead><tr><th>名称</th><th>型号</th><th>数量</th></tr></thead><tbody>${design.bomDraft.items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.model ?? '待选型')}</td><td>${item.qty}</td></tr>`).join('')}</tbody></table></div>`;
        drawer.querySelector('button')?.addEventListener('click', () => drawer.remove());
        root.appendChild(drawer);
        if (outputNode) outputNode.textContent = `BOM 已生成：${result.path ?? ''}`;
      } else if (kind === 'plc') {
        const generated = generateProject({ config: design.config, target: 'generic', bom: bomRows(design) });
        if (!generated.ok) throw new Error(generated.errors.map((issue) => issue.message).join('；'));
        const files = [...generated.files, { path: 'design-io-map.csv', content: buildMachineIoMap(design.config).csv }];
        const result = await window.desktop?.plcgen.exportProject({ machineName: draft.brief.name, target: 'generic', files });
        if (!result?.ok) throw new Error(result?.message ?? 'PLC 导出失败');
        if (outputNode) outputNode.textContent = `PLC 工程已生成（${files.length} 个文件）：${result.zipPath ?? result.path ?? ''}`;
      } else if (kind === 'elec') {
        const protection = selectMotorProtection(design.power.totalKw);
        const circuit = buildMachineCircuit({ project: draft.brief.name, drive: { powerKw: design.power.totalKw, rpm: 1400, ratio: 18 }, sensors: design.config.sensors.map((sensor, index) => ({ tag: `-SQ${index + 1}`, label: sensor.point, address: `I0.${index % 8}` })), controls: { estop: true, startStop: true, lamp: true }, selection: protection, drawingNo: 'EL-DESIGN-001' });
        const sheet = renderSheet(circuit, { project: draft.brief.name, drawingNo: 'EL-DESIGN-001', page: '1 / 1', date: new Date().toISOString().slice(0, 10), notes: [`${design.power.totalKw.toFixed(2)} kW · ${design.power.currentA.toFixed(2)} A · ${design.config.stations.length} 工位`] });
        const result = await window.desktop?.exportFile(`${draft.brief.name}-电气原理图.svg`, sheet.svg);
        if (result?.canceled) return;
        if (outputNode) outputNode.textContent = `电气原理图已生成：${result?.path ?? ''}\n${sheet.deliverable ? 'ERC 与布局检查通过' : `仍有 ${sheet.issues.length} 条图面提示，请复核`}`;
      } else if (kind === 'pdf') {
        if (!review) throw new Error('请先运行一键校核');
        const html = renderReportHtml({ project: { name: draft.brief.name, code: design.config.id, date: new Date().toISOString().slice(0, 10) }, bom: bomRows(design), interference: review.interference, stress: [], note: `整机设计：${design.form.name}；产能 ${review.cycle.throughputPerMin} 件/分钟；${review.power.totalKw} kW / ${review.power.currentA} A；成本 ¥${review.cost.total}。` });
        const result = await window.desktop?.exportReport({ html, projectName: draft.brief.name, page: { size: 'A3', landscape: true } });
        if (outputNode) outputNode.textContent = `PDF 报告已导出：${result?.path ?? ''}`;
      }
    } catch (error) { if (outputNode) outputNode.textContent = `失败：${errorMessage(error)}`; options.notify(errorMessage(error), true); }
  }
  async function saveProject(): Promise<void> {
    if (!draft.design) return;
    if (!review) { options.notify('请先运行一键校核', true); return; }
    if (review.errors) { options.notify('存在阻断错误，不能保存为工程', true); return; }
    try {
      validateMachineConfig(draft.design.config);
      const design = draft.design;
      const geometry = geometryFor(design);
      const stlData = geometryToStl(geometry);
      const result = await saveDesignProject((payload) => window.desktop!.projects.save(payload), () => window.desktop!.design.clearDraft(), {
        name: draft.brief.name, process: draft.brief.process, params: { cyclePerMin: draft.brief.cyclePerMin, stations: draft.stations.length, lengthMm: geometry.envelope[0], widthMm: geometry.envelope[1] },
        parts: geometry.parts.length, massKg: null, envelope: geometry.envelope, material: [], design, config: design.config, stlData,
        placements: draft.placements,
        partData: geometry.parts.map((part) => ({ name: `${part.id}.stl`, data: geometryToStl({ ...geometry, parts: [part] }) }))
      });
      if (!result.ok || !result.id) throw new Error(result.message ?? '工程保存失败');
      const id = result.id;
      savedDraft = false;
      window.__AgentBridge?.applyMachineConfig({ config: design.config, layout: design.form.geometry.kind === 'conveyor' ? 'linear' : design.form.geometry.kind });
      window.__AgentBridge?.appendMachineBomRows({ source: 'design-wizard', batchId: `design-${id}`, rows: bomRows(design).map((row) => ({ no: row.index, name: row.name, spec: row.model, qty: row.quantity, mat: row.material, ...(row.note ? { note: row.note } : {}) })) });
      await options.onSaved(id);
      await options.openProject(id);
      close();
      updateEntry();
    } catch (error) { options.notify(`保存失败：${errorMessage(error)}`, true); }
  }
  function bindEvents(): void {
    root.querySelectorAll<HTMLElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.action;
      if (action === 'close') close(); else if (action === 'discard') void discard();
      else if (action === 'next') void advance(); else if (action === 'prev') { syncEditedDraft(); draft = prevStep(draft); void saveDraft().then(render); }
      else if (action === 'auto-layout') { draft = withPlacements(draft, autoLayout(draft.stations, canvasSize())); render(); }
      else if (action === 'run-review' && draft.design) { const scene = window.__AgentBridge?.ready() ? window.__AgentBridge.getSceneParts() : []; review = reviewDesign(draft.design, scene, library, designSettings.pricing?.pricing, designSettings.builtinPricebook); draft.design.power = review.power; draft.design.cost = review.cost; render(); }
      else if (action === 'save-project') void saveProject();
      else if (action) stationAction(action);
    }));
    root.querySelectorAll<HTMLElement>('[data-output]').forEach((button) => button.addEventListener('click', () => void output(button.dataset.output ?? '')));
    root.querySelectorAll<HTMLElement>('[data-preview]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); const design = draft.candidates?.[Number(button.dataset.preview)]; if (design) openPreview(design); }));
    root.querySelectorAll<HTMLElement>('[data-candidate]').forEach((card) => card.addEventListener('click', () => {
      const index = Number(card.dataset.candidate) as 0 | 1 | 2;
      const preserved = draft.stations;
      draft = selectCandidate(draft, index);
      const merged = mergeStations(draft.stations, preserved);
      draft = withStations(draft, merged.stations);
      review = null;
      render();
    }));
    root.querySelectorAll<HTMLElement>('[data-station]').forEach((item) => item.addEventListener('click', (event) => { if ((event.target as HTMLElement).closest('button')) return; selectedStation = Number(item.dataset.station); render(); }));
    root.querySelector('#designStationName')?.addEventListener('change', (event) => { const station = draft.stations[selectedStation]; if (station) { station.name = (event.target as HTMLInputElement).value; updateDesignFromStations(); render(); } });
    root.querySelectorAll<HTMLElement>('[data-move-station]').forEach((button) => button.addEventListener('click', () => { const from = Number(button.dataset.moveStation); const to = from + Number(button.dataset.direction); if (to < 0 || to >= draft.stations.length) return; const stations = clone(draft.stations); const [item] = stations.splice(from, 1); if (item) stations.splice(to, 0, item); selectedStation = to; draft = withStations(draft, stations); updateDesignFromStations(); render(); }));
    root.querySelectorAll<HTMLElement>('[data-delete-station]').forEach((button) => button.addEventListener('click', () => { draft.stations.splice(Number(button.dataset.deleteStation), 1); updateDesignFromStations(); render(); }));
    for (const type of ['actuator', 'sensor'] as const) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-${type}][data-key]`).forEach((input) => input.addEventListener('change', () => {
        const station = draft.stations[selectedStation]; if (!station) return;
        const index = Number(input.dataset[type]); const item = type === 'actuator' ? station.actuators[index] : station.sensors[index];
        if (!item) return;
        const key = input.dataset.key as 'name' | 'model' | 'point' | 'kind';
        if (key === 'kind' && type === 'actuator') {
          const actuator = item as ActuatorDraft;
          actuator.kind = input.value as ActuatorDraft['kind'];
          delete actuator.extendPoint; delete actuator.retractPoint; delete actuator.gripPoint; delete actuator.point;
          Object.assign(actuator, allocateActuatorPoints(selectedStation, index, actuator.kind, allPoints(draft.stations)));
        } else (item as unknown as Record<string, string>)[key] = input.value;
        updateDesignFromStations(); render();
      }));
      root.querySelectorAll<HTMLElement>(`[data-delete-${type}]`).forEach((button) => button.addEventListener('click', () => { const station = draft.stations[selectedStation]; if (!station) return; (type === 'actuator' ? station.actuators : station.sensors).splice(Number(button.dataset[`delete${type[0]?.toUpperCase()}${type.slice(1)}`]), 1); updateDesignFromStations(); render(); }));
    }
    root.querySelectorAll<HTMLElement>('[data-pick-part]').forEach((button) => button.addEventListener('click', () => { partPicker = { station: selectedStation, kind: button.dataset.pickPart as 'actuator' | 'sensor', index: Number(button.dataset.index) }; render(); }));
    root.querySelector('#designPartSearch')?.addEventListener('input', renderPartResults);
    root.querySelector('#designPartCategory')?.addEventListener('change', renderPartResults);
    root.querySelectorAll<HTMLElement>('[data-bind-part]').forEach((button) => button.addEventListener('click', () => {
      if (!partPicker) return;
      const part = library.find((item) => item.id === button.dataset.bindPart && (item.packId ?? '') === (button.dataset.pack ?? ''));
      const station = draft.stations[partPicker.station]; if (!part || !station) return;
      const item = partPicker.kind === 'actuator' ? station.actuators[partPicker.index] : station.sensors[partPicker.index];
      if (item) Object.assign(item, bindPartFields(part));
      partPicker = null; updateDesignFromStations(); render();
    }));
    const svg = root.querySelector<SVGSVGElement>('#designLayoutSvg');
    svg?.addEventListener('pointerdown', (event) => {
      const group = (event.target as Element).closest<SVGGElement>('[data-placement]');
      if (!group || !svg) return;
      event.preventDefault();
      const id = group.dataset.placement;
      const item = draft.placements.find((placement) => placement.id === id); if (!item) return;
      const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const start = point.matrixTransform(svg.getScreenCTM()?.inverse());
      const origin = { x: item.x, y: item.y };
      group.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent): void => {
        point.x = moveEvent.clientX; point.y = moveEvent.clientY;
        const current = point.matrixTransform(svg.getScreenCTM()?.inverse());
        const replacement = movePlacement(item, origin.x + current.x - start.x, origin.y + current.y - start.y);
        draft.placements = draft.placements.map((placement) => placement.id === id ? replacement : placement);
        const rect = group.querySelector('rect'); const texts = group.querySelectorAll('text');
        rect?.setAttribute('x', String(replacement.x)); rect?.setAttribute('y', String(replacement.y));
        texts[0]?.setAttribute('x', String(replacement.x + 7)); texts[0]?.setAttribute('y', String(replacement.y + 20));
        texts[1]?.setAttribute('x', String(replacement.x + 7)); texts[1]?.setAttribute('y', String(replacement.y + 37));
        if (texts[1]) texts[1].textContent = `${replacement.x}, ${replacement.y} mm`;
      };
      const up = (): void => { group.removeEventListener('pointermove', move); group.removeEventListener('pointerup', up); draft = withPlacements(draft, draft.placements); render(); };
      group.addEventListener('pointermove', move); group.addEventListener('pointerup', up);
    });
  }
  function close(): void { closePreview(); root.hidden = true; updateEntry(); }
  async function open(): Promise<void> {
    const version = ++loadVersion;
    root.hidden = false;
    render();
    try {
      const [parts, stored, settings] = await Promise.all([window.desktop?.packs.listParts() ?? Promise.resolve([]), window.desktop?.design.loadDraft() ?? Promise.resolve({ draft: null, recovered: false }), window.desktop?.design.settings() ?? Promise.resolve({ ok: false } as { ok: boolean; pricing?: import('../machine/cost-model.ts').MachinePricingLoad; builtinPricebook?: import('../cost/pricebook.ts').Pricebook })]);
      if (settings.ok) designSettings = { ...(settings.pricing ? { pricing: settings.pricing } : {}), ...(settings.builtinPricebook ? { builtinPricebook: settings.builtinPricebook } : {}) };
      if (version !== loadVersion) return;
      library = parts;
      if (stored.draft) { draft = parseDesignDraft(stored.draft); savedDraft = true; }
      if (stored.recovered) notice = '草稿文件损坏，已安全回落到第 1 步。';
      if (draft.step === 2 && !draft.design && draft.candidates?.[0]) draft = selectCandidate(draft, 0);
      updateEntry(); render();
    } catch (error) { options.notify(`读取设计草稿失败：${errorMessage(error)}`, true); }
  }
  document.addEventListener('keydown', (event) => {
    if (root.hidden || event.key !== 'Escape') return;
    if (!preview.hidden) closePreview(); else close();
    event.stopPropagation();
  }, true);
  activeWizard = { open: () => void open(), close };
  updateEntry();
  void window.desktop?.design.loadDraft().then((stored) => { if (stored.draft) { draft = parseDesignDraft(stored.draft); savedDraft = true; } updateEntry(); });
  return activeWizard;
}
