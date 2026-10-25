/**
 * 可旋转的 three.js 主视口（渲染器 + 相机 + OrbitControls）。按需渲染：只在相机/模型/高亮变化时画一帧。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { probeWebGL } from '../cad/webgl';
import {
  isEmptyBounds,
  nearestStandardView,
  orthoFrustum,
  orthoToPerspectiveDistance,
  perspectiveToOrthoHalfHeight,
  poseAlong,
  poseForView,
  projectAxes,
  type StandardView,
  type Vec3
} from './camera.ts';
import type { Assembly } from './model.ts';
import { partsInRect, rectFromPoints, type ScreenRect } from './marquee.ts';
import {
  applyHighlight,
  buildAssemblyGroup,
  buildInterferenceGroup,
  buildSectionPlane,
  disposeObject,
  partIdOf,
  partMeshes,
  type HighlightState
} from './three-scene.ts';
import type { InterferenceHit } from '../mech/interference.ts';
import {
  DRAG_PIXEL_RATIO,
  effectivePixelRatio,
  normalizeRenderQuality,
  resolveEffectiveQuality,
  type RenderQuality
} from './quality.ts';
import { isCredibleFrameSample, isSoftwareRenderer, type RenderStats } from '../shared/render-stats.ts';
import { clientPointToNdc, isClickSelect, isStaleDrag } from './pointer.ts';
import type { AssemblyInstance, SurfaceHit } from '../assembly/instances.ts';

/**
 * 排队中的渲染帧最大等待时长。页面被遮挡/最小化时 rAF 不触发，超过这个窗口就认为该帧已失效，
 * 否则 renderQueued 会永久为 true，后续所有 requestRender 都被丢弃（画面像卡死，松手才跳一下）。
 */
const RENDER_QUEUE_WATCHDOG_MS = 500;

/** 控制器重建的最小间隔：重建会丢弃控制器内部的拖动状态，短时间反复重建会让视口完全失去响应。 */
const CONTROLS_REBUILD_MIN_INTERVAL_MS = 1500;

export type Projection = 'perspective' | 'orthographic';

export interface OrbitViewOptions {
  host: HTMLElement;
  onPick?: (partId: string | null, event: PointerEvent) => void;
  onHover?: (partId: string | null) => void;
  onRender?: (view: OrbitView) => void;
  /** 拖动结束与每 5 秒一次的渲染指标；由 UI 层转发到主进程。 */
  onStats?: (stats: RenderStats) => void;
  onDragEnd?: (stats: RenderStats) => void;
  /** 框选结束（拖拽超过 5 px）：客户端像素矩形 */
  onMarquee?: (rect: ScreenRect) => void;
  /** 拖拽中显示的框（复用原型舞台里的 `.marquee` 元素） */
  marqueeBox?: HTMLElement | null;
}

export interface OrbitViewState {
  view: StandardView | null;
  projection: Projection;
  target: Vec3;
  position: Vec3;
  distance: number;
  clipping: boolean;
  renders: number;
  marqueeMode: boolean;
  render: RenderQualityDiagnostics;
}

export interface RenderQualityDiagnostics {
  configuredQuality: RenderQuality;
  quality: RenderQuality;
  pixelRatio: number;
  draggingPixelRatio: number;
  antialias: boolean;
  dragging: boolean;
  autoDowngraded: boolean;
  parts: number;
}

const FOV = 40;

export type OrbitViewResult = { ok: true; view: OrbitView } | { ok: false; reason: string };

export class OrbitView {
  canvas!: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspective = new THREE.PerspectiveCamera(FOV, 1, 0.5, 100_000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100_000, 100_000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  private controls!: OrbitControls;
  private assemblyRoot: THREE.Group | null = null;
  private overlayRoot: THREE.Group | null = null;
  private sectionPlane: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private assembly: Assembly | null = null;
  private highlight: HighlightState = { selected: [], hover: null, hit: null, ghostOthers: false };
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private clipping = false;
  private showSection = false;
  private renderQueued = false;
  private renders = 0;
  private lastHover: string | null = null;
  private down: { x: number; y: number; button: number } | null = null;
  private readonly resizeObserver: ResizeObserver;
  private disposed = false;
  private readonly options: OrbitViewOptions;
  private contextLost = false;
  /** 用户还没动过相机时，宿主首次可见/尺寸变化会按当前标准视图重新取景（隐藏视图初始化时宽高为 0）。 */
  private autoFit = true;
  private lastView: StandardView = 'iso';
  /** 粘滞框选模式（工具条「框选」按钮）；否则 Shift+左键拖拽临时框选 */
  private marqueeMode = false;
  private marqueeDrag: { x: number; y: number; active: boolean; pointerId: number } | null = null;
  private qualitySetting: RenderQuality = 'standard';
  private rendererAntialias = true;
  private dragging = false;
  private dragRestoreTimer = 0;
  private dragPrevFrameAt = 0;
  private dragFrames = 0;
  private dragTotalFrameMs = 0;
  private dragMaxFrameMs = 0;
  private dragDroppedFrames = 0;
  private renderQueuedAt = 0;
  /** 装配实例（标准件代理体）与拖入时的预览体；与装配模型分开管理，互不覆盖。 */
  private readonly assemblyInstances = new THREE.Group();
  private assemblyGhost: THREE.Mesh | null = null;
  /** 2D 图纸（DXF/DWG）的线框层，和实体模型分开，便于单独开关。 */
  private drawingLayer: THREE.LineSegments | null = null;
  private readonly inputCounters = { pointerDowns: 0, pointerUps: 0, pointerMoves: 0, wheels: 0 };
  private controlsRebuilds = 0;
  private lastControlsRebuildAt = 0;
  private lastDragAt: string | null = null;
  private glRenderer = '';
  private softwareRendering = false;
  private statsTimer = 0;
  private panMode = false;
  onContextLost: (() => void) | null = null;

  static create(options: OrbitViewOptions): OrbitViewResult {
    const capability = probeWebGL(() => document.createElement('canvas'));
    if (!capability.ok) return { ok: false, reason: capability.reason ?? 'WebGL 不可用' };
    try {
      return { ok: true, view: new OrbitView(options) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private constructor(options: OrbitViewOptions) {
    this.options = options;
    this.host = options.host;
    this.createRenderer();

    this.scene.add(new THREE.HemisphereLight(0xf1f5f9, 0x2a2d31, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1.2, -1.6, 2.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9c6d2, 0.6);
    fill.position.set(-1.4, 1.2, 0.8);
    this.scene.add(fill);

    this.scene.add(this.assemblyInstances);

    this.perspective.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    this.createControls(new THREE.Vector3());
    if (this.softwareRendering) {
      const rebuildAntialias = this.rendererAntialias;
      this.qualitySetting = 'flow';
      if (rebuildAntialias) this.rebuildRenderer();
      else this.applyRenderQuality();
    }
    // 框选要先于 OrbitControls 拿到 pointerdown：在宿主捕获阶段截获，移动/抬起在 window 捕获阶段跟踪。
    this.host.addEventListener('pointerdown', this.onMarqueeDown, true);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.statsTimer = window.setInterval(() => this.options.onStats?.(this.renderStats()), 5000);
  }

  private createRenderer(): void {
    const quality = this.resolveQuality().quality;
    const antialias = quality !== 'flow';
    this.renderer = new THREE.WebGLRenderer({
      antialias,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.rendererAntialias = antialias;
    this.renderer.setPixelRatio(effectivePixelRatio(window.devicePixelRatio || 1, quality, this.dragging));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    const context = this.renderer.getContext();
    let masked = '';
    let unmasked = '';
    try {
      masked = String(context.getParameter(context.RENDERER) ?? '');
      const debugInfo = context.getExtension('WEBGL_debug_renderer_info') as {
        UNMASKED_RENDERER_WEBGL: number;
      } | null;
      if (debugInfo) unmasked = String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
    } catch {
      // 扩展在隐私模式/旧驱动下可能不可读；能力摘要作为兜底。
    }
    const capabilitySummary = `WebGL${this.renderer.capabilities.isWebGL2 ? '2' : '1'} · maxTexture=${this.renderer.capabilities.maxTextureSize}`;
    this.glRenderer = [unmasked, masked]
      .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index)
      .join(' / ') || capabilitySummary;
    this.softwareRendering = isSoftwareRenderer(this.glRenderer);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'orbit-canvas';
    this.host.appendChild(this.canvas);
    this.bindCanvasEvents();
  }

  private bindCanvasEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheelCount, { passive: true });
    // 兜底：指针在画布外抬起、系统取消、窗口失焦时，canvas 收不到 pointerup，
    // OrbitControls 也就不会发 'end'，拖动状态会永久卡住。
    window.addEventListener('pointerup', this.onGlobalPointerEnd, true);
    window.addEventListener('pointercancel', this.onGlobalPointerEnd, true);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('pointermove', this.onGlobalPointerMove, true);
    // 只拦 click / dblclick，避免原型的舞台点击委托抢走 3D 选中。
    //
    // pointer* 一律不拦：OrbitControls 在拖动期间是把 pointermove / pointerup 绑在
    // document 上的，画布上 stopPropagation 会让事件冒泡不到 document —— 表现就是
    // 「画布内按住拖动不转、移到画布外才转」，并且它收不到 pointerup，状态永久停在
    // ROTATE（滚轮失效、不按键也跟动）。原型的框选已在 app.js 里跳过 .orbit-canvas。
    ['click', 'dblclick'].forEach((type) => {
      this.canvas.addEventListener(type, (event) => event.stopPropagation());
    });
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
  }

  private createControls(target: THREE.Vector3): void {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.applyPanMode();
    this.controls.target.copy(target);
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => {
      this.autoFit = false;
      this.beginDrag();
    });
    this.controls.addEventListener('end', () => this.endDrag());
    this.controls.update();
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  setAssembly(assembly: Assembly, options: { fit?: boolean } = {}): void {
    const first = this.assembly === null;
    this.assembly = assembly;
    this.applyRenderQuality();
    if (this.assemblyRoot) {
      this.scene.remove(this.assemblyRoot);
      disposeObject(this.assemblyRoot);
    }
    this.assemblyRoot = buildAssemblyGroup(assembly);
    this.scene.add(this.assemblyRoot);
    this.clipPlane.constant = assembly.sectionX;
    this.applyClipping();
    this.rebuildGrid();
    this.rebuildSection();
    applyHighlight(this.assemblyRoot, this.highlight);
    if (first || options.fit) this.setStandardView('iso');
    this.settle();
  }

  setHighlight(state: HighlightState): void {
    this.highlight = { ...state, selected: [...state.selected] };
    if (this.assemblyRoot) applyHighlight(this.assemblyRoot, this.highlight);
    this.requestRender();
  }

  setInterference(hits: readonly InterferenceHit[] | null): void {
    if (this.overlayRoot) {
      this.scene.remove(this.overlayRoot);
      disposeObject(this.overlayRoot);
      this.overlayRoot = null;
    }
    if (hits && hits.length) {
      this.overlayRoot = buildInterferenceGroup(hits);
      this.scene.add(this.overlayRoot);
    }
    this.settle();
  }

  setSectionVisible(visible: boolean): void {
    this.showSection = visible;
    this.rebuildSection();
    this.settle();
  }

  setClipping(on: boolean): void {
    this.clipping = on;
    this.applyClipping();
    this.settle();
  }

  setPanMode(on: boolean): void {
    this.panMode = on;
    this.applyPanMode();
  }

  private applyPanMode(): void {
    if (!this.controls) return;
    this.controls.mouseButtons = {
      LEFT: this.panMode ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: this.panMode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN
    };
  }

  private resolveQuality(): { quality: RenderQuality; autoDowngraded: boolean } {
    const resolved = resolveEffectiveQuality(this.qualitySetting, this.assembly?.parts.length ?? 0);
    return this.softwareRendering ? { quality: 'flow', autoDowngraded: resolved.autoDowngraded } : resolved;
  }

  setRenderQuality(quality: RenderQuality): void {
    this.qualitySetting = normalizeRenderQuality(quality);
    this.applyRenderQuality();
    this.requestRender();
  }

  renderQualityInfo(): RenderQualityDiagnostics {
    const resolved = this.resolveQuality();
    return {
      configuredQuality: this.qualitySetting,
      quality: resolved.quality,
      pixelRatio: effectivePixelRatio(window.devicePixelRatio || 1, resolved.quality, this.dragging),
      draggingPixelRatio: effectivePixelRatio(window.devicePixelRatio || 1, resolved.quality, true),
      antialias: this.rendererAntialias,
      dragging: this.dragging,
      autoDowngraded: resolved.autoDowngraded,
      parts: this.assembly?.parts.length ?? 0
    };
  }

  private applyRenderQuality(): void {
    if (!this.renderer) return;
    const resolved = this.resolveQuality();
    const antialias = resolved.quality !== 'flow';
    if (!this.dragging && antialias !== this.rendererAntialias) {
      this.rebuildRenderer();
      return;
    }
    this.renderer.setPixelRatio(effectivePixelRatio(window.devicePixelRatio || 1, resolved.quality, this.dragging));
  }

  /** antialias 是构造参数：跨 MSAA 边界时重建 renderer，场景和相机对象保持不变。 */
  private rebuildRenderer(): void {
    // 拖动中重建会换掉 canvas，OrbitControls 拿不到 pointerup → 拖动状态永久卡住。
    if (this.dragging) return;
    const target = this.controls.target.clone();
    this.controls.dispose();
    this.renderer.dispose();
    this.canvas.remove();
    this.createRenderer();
    this.createControls(target);
    this.resize();
    this.requestRender();
  }

  private beginDrag(): void {
    // 上一次没收到 end（例如指针在画布外抬起）时先收敛，避免状态叠加。
    if (this.dragging) this.endDrag();
    this.dragging = true;
    this.dragPrevFrameAt = performance.now();
    this.dragFrames = 0;
    this.dragTotalFrameMs = 0;
    this.dragMaxFrameMs = 0;
    this.dragDroppedFrames = 0;
    window.clearTimeout(this.dragRestoreTimer);
    this.renderer.setPixelRatio(DRAG_PIXEL_RATIO);
    this.requestRender();
  }

  private endDrag(): void {
    // 状态必须同步落下：像素比、帧统计、质量回升都读 dragging。
    // 以前把 dragging=false 放进 200ms 定时器，pointerup 一旦没落到当前 canvas（拖动中重建过
    // 渲染器就是这种情况），定时器里的状态就永远不生效 —— 表现为松手后一直停在 0.8 拖动档。
    this.dragging = false;
    this.dragPrevFrameAt = 0;
    this.lastDragAt = new Date().toISOString();
    this.options.onDragEnd?.(this.renderStats());
    window.clearTimeout(this.dragRestoreTimer);
    this.dragRestoreTimer = window.setTimeout(() => {
      this.applyRenderQuality();
      this.requestRender();
    }, 200);
  }

  private aspect(): number {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    return w / h;
  }

  private currentDistance(): number {
    if (this.camera === this.perspective) return this.perspective.position.distanceTo(this.controls.target);
    const halfHeight = (this.ortho.top - this.ortho.bottom) / 2;
    return orthoToPerspectiveDistance(halfHeight, this.ortho.zoom, FOV);
  }

  private applyPose(position: Vec3, target: Vec3, distance: number): void {
    this.controls.target.set(target[0], target[1], target[2]);
    this.perspective.position.set(position[0], position[1], position[2]);
    this.ortho.position.set(position[0], position[1], position[2]);
    this.syncOrthoFrustum(distance);
    this.ortho.zoom = 1;
    this.perspective.lookAt(this.controls.target);
    this.ortho.lookAt(this.controls.target);
    this.perspective.updateProjectionMatrix();
    this.ortho.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** 正交视锥按透视在目标处的可见高度设置，保证切换投影时模型大小不跳。 */
  private syncOrthoFrustum(distance: number): void {
    const halfHeight = perspectiveToOrthoHalfHeight(distance, FOV);
    const aspect = this.aspect();
    this.ortho.left = -halfHeight * aspect;
    this.ortho.right = halfHeight * aspect;
    this.ortho.top = halfHeight;
    this.ortho.bottom = -halfHeight;
  }

  setStandardView(view: StandardView): void {
    const bounds = this.assembly?.bounds;
    if (!bounds) return;
    this.lastView = view;
    const pose = poseForView(view, bounds, FOV, this.aspect());
    this.applyPose(pose.position, pose.target, pose.distance);
  }

  fitAll(): void {
    const bounds = this.assembly?.bounds;
    if (!bounds || isEmptyBounds(bounds)) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const vec: Vec3 = dir.lengthSq() > 0 ? [dir.x, dir.y, dir.z] : [1, -1, 1];
    const pose = poseAlong(vec, [0, 0, 1], bounds, FOV, this.aspect());
    this.applyPose(pose.position, pose.target, pose.distance);
    if (this.camera === this.ortho) {
      const frustum = orthoFrustum(pose.distance * Math.tan((FOV * Math.PI) / 360), this.aspect(), 1);
      this.ortho.left = frustum.left; this.ortho.right = frustum.right;
      this.ortho.top = frustum.top; this.ortho.bottom = frustum.bottom;
      this.ortho.updateProjectionMatrix();
    }
  }

  /** 贴 2D 图纸线框层；返回画了多少条线段。 */
  setDrawingLayer(segments: ReadonlyArray<{ points: readonly number[] }>, options: { color?: number } = {}): number {
    this.clearDrawingLayer();
    if (segments.length === 0) return 0;
    const positions = new Float32Array(segments.length * 6);
    segments.forEach((segment, index) => {
      for (let i = 0; i < 6; i += 1) positions[index * 6 + i] = segment.points[i] ?? 0;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    const material = new THREE.LineBasicMaterial({ color: options.color ?? 0x86b6de, transparent: true, opacity: 0.9 });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'drawing-layer';
    this.scene.add(lines);
    this.drawingLayer = lines;
    this.requestRender();
    return segments.length;
  }

  /** 图纸层诊断：线框是否在场景里、包围盒、相机范围（排查"看不见"用）。 */
  drawingDiagnostics(): {
    has: boolean;
    segments: number;
    bounds: { min: Vec3; max: Vec3 } | null;
    camera: { position: Vec3; target: Vec3; near: number; far: number };
    /** 包围盒 8 个角投影到 NDC 后的范围；与 [-1,1] 有交集说明在屏幕上 */
    ndc: { min: Vec3; max: Vec3 } | null;
    onScreen: boolean;
    render: { calls: number; lines: number; triangles: number };
  } {
    const geometry = this.drawingLayer?.geometry;
    const position = geometry?.getAttribute('position');
    const bounds = this.drawingBounds();
    let ndc: { min: Vec3; max: Vec3 } | null = null;
    let onScreen = false;
    if (bounds) {
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      this.camera.updateMatrixWorld();
      const xs: [number, number] = [bounds.min[0] ?? 0, bounds.max[0] ?? 0];
      const ys: [number, number] = [bounds.min[1] ?? 0, bounds.max[1] ?? 0];
      const zs: [number, number] = [bounds.min[2] ?? 0, bounds.max[2] ?? 0];
      for (const x of xs) {
        for (const y of ys) {
          for (const z of zs) {
            const projected = new THREE.Vector3(x, y, z).project(this.camera);
            // 只看 z 在视锥内的角（-1..1）
            if (projected.z < -1 || projected.z > 1) continue;
            const values: Vec3 = [projected.x, projected.y, projected.z];
            for (let axis = 0; axis < 3; axis += 1) {
              const value = values[axis] ?? 0;
              min[axis] = Math.min(min[axis] ?? Infinity, value);
              max[axis] = Math.max(max[axis] ?? -Infinity, value);
            }
          }
        }
      }
      if (Number.isFinite(min[0])) {
        ndc = { min, max };
        onScreen = min[0] <= 1 && max[0] >= -1 && min[1] <= 1 && max[1] >= -1;
      }
    }
    const info = this.renderer.info.render;
    return {
      has: Boolean(this.drawingLayer),
      segments: position ? position.count / 2 : 0,
      bounds,
      camera: {
        position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
        target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
        near: this.camera.near,
        far: this.camera.far
      },
      ndc,
      onScreen,
      render: { calls: info.calls, lines: info.lines, triangles: info.triangles }
    };
  }

  clearDrawingLayer(): void {
    if (!this.drawingLayer) return;
    this.scene.remove(this.drawingLayer);
    disposeObject(this.drawingLayer);
    this.drawingLayer = null;
    this.requestRender();
  }

  drawingBounds(): { min: Vec3; max: Vec3 } | null {
    const box = this.drawingLayer?.geometry.boundingBox;
    if (!box) return null;
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null;
    return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  }

  /**
   * 按场景尺度放宽相机的 near/far。
   * 默认 far=100m，而工地/建筑图纸动辄几公里（实测一张 DWG 跨度 3.4e6 mm），
   * 不放宽的话线框在视锥外，看起来就是「什么都没画」。
   */
  private adaptCameraRange(radius: number): void {
    const near = Math.max(0.1, radius / 5000);
    const far = Math.max(100_000, radius * 40);
    this.perspective.near = near;
    this.perspective.far = far;
    this.ortho.near = -far;
    this.ortho.far = far;
    this.perspective.updateProjectionMatrix();
    this.ortho.updateProjectionMatrix();
  }

  private drawingRadius(bounds: { min: Vec3; max: Vec3 } | null): number {
    if (!bounds) return 0;
    return Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2;
  }

  /** 把相机对准图纸范围；没有图纸时返回 false。 */
  fitDrawing(): boolean {
    const bounds = this.drawingBounds();
    if (!bounds) return false;
    const radius = this.drawingRadius(bounds);
    if (radius > 0) this.adaptCameraRange(radius);
    const pose = poseAlong([1, -1, 1], [0, 0, 1], bounds, FOV, this.aspect());
    this.applyPose(pose.position, pose.target, pose.distance);
    return true;
  }

  setProjection(projection: Projection): void {
    if (projection === this.projection()) return;
    const target = this.controls.target.clone();
    const dir = this.camera.position.clone().sub(target).normalize();
    if (projection === 'orthographic') {
      const distance = this.perspective.position.distanceTo(target);
      this.ortho.position.copy(this.perspective.position);
      this.ortho.quaternion.copy(this.perspective.quaternion);
      this.syncOrthoFrustum(distance);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      const distance = this.currentDistance();
      this.perspective.position.copy(target).addScaledVector(dir, distance);
      this.perspective.quaternion.copy(this.ortho.quaternion);
      this.perspective.updateProjectionMatrix();
      this.camera = this.perspective;
    }
    this.controls.object = this.camera;
    this.controls.update();
    this.requestRender();
  }

  projection(): Projection {
    return this.camera === this.ortho ? 'orthographic' : 'perspective';
  }

  /** 世界坐标 → 宿主元素内百分比（干涉气泡定位用）。 */
  projectToHost(point: Vec3): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(point[0], point[1], point[2]).project(this.camera);
    return { x: (v.x + 1) * 50, y: (1 - v.y) * 50, visible: v.z > -1 && v.z < 1 };
  }

  /** 世界 X/Y/Z 轴在屏幕上的方向（右下角坐标轴指示器）。 */
  axes(): ReturnType<typeof projectAxes> {
    const e = this.camera.matrixWorld.elements;
    return projectAxes([e[0] as number, e[1] as number, e[2] as number], [e[4] as number, e[5] as number, e[6] as number]);
  }

  state(): OrbitViewState {
    const p = this.camera.position;
    const t = this.controls.target;
    const dir: Vec3 = [p.x - t.x, p.y - t.y, p.z - t.z];
    let view: StandardView | null = null;
    try { view = nearestStandardView(dir); } catch { view = null; }
    return {
      view,
      projection: this.projection(),
      target: [t.x, t.y, t.z],
      position: [p.x, p.y, p.z],
      distance: this.currentDistance(),
      clipping: this.clipping,
      renders: this.renders,
      marqueeMode: this.marqueeMode,
      render: this.renderQualityInfo()
    };
  }

  pick(clientX: number, clientY: number): string | null {
    if (!this.assemblyRoot) return null;
    const rect = this.canvas.getBoundingClientRect();
    const point = clientPointToNdc(clientX, clientY, rect);
    if (!point) return null;
    this.ndc.set(point.x, point.y);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObjects(partMeshes(this.assemblyRoot), false);
    for (const hit of hits) {
      if (this.clipping && hit.point.x > this.clipPlane.constant + 1e-6) continue;
      const id = partIdOf(hit.object);
      if (id) return id;
    }
    return null;
  }

  /** 标准件代理体：盒体直出，圆柱的轴向对齐本场景的 +Z（CylinderGeometry 默认 +Y）。 */
  private buildInstanceMesh(instance: AssemblyInstance, ghost: boolean): THREE.Mesh {
    const [sx, sy, sz] = instance.dims.size;
    const geometry = instance.dims.shape === 'cylinder' && instance.dims.diameter !== null
      ? new THREE.CylinderGeometry(instance.dims.diameter / 2, instance.dims.diameter / 2, sz, 24)
      : new THREE.BoxGeometry(sx, sy, sz);
    if (instance.dims.shape === 'cylinder') geometry.rotateZ(Math.PI / 2); // 轴向 +Y → +X
    const material = new THREE.MeshStandardMaterial({
      color: instance.dims.estimated ? 0xd08a3a : 0x4a90c2,
      metalness: 0.25,
      roughness: 0.55,
      transparent: ghost,
      opacity: ghost ? 0.45 : 1,
      depthWrite: !ghost
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(instance.position[0], instance.position[1], instance.position[2]);
    mesh.quaternion.set(instance.quaternion[0], instance.quaternion[1], instance.quaternion[2], instance.quaternion[3]);
    if (ghost) mesh.renderOrder = 10;
    else mesh.userData.assemblyId = instance.id;
    return mesh;
  }

  /** 重建装配实例层（与装配模型/干涉叠加层互不影响）。 */
  setAssemblyInstances(items: readonly AssemblyInstance[]): void {
    for (const child of [...this.assemblyInstances.children]) {
      this.assemblyInstances.remove(child);
      disposeObject(child);
    }
    this.assemblyGhost = null;
    for (const item of items) this.assemblyInstances.add(this.buildInstanceMesh(item, false));
    this.requestRender();
  }

  /** 拖入预览体：传 null 清除。 */
  previewAssemblyInstance(item: AssemblyInstance | null): void {
    if (this.assemblyGhost) {
      this.assemblyInstances.remove(this.assemblyGhost);
      disposeObject(this.assemblyGhost);
      this.assemblyGhost = null;
    }
    if (item) {
      this.assemblyGhost = this.buildInstanceMesh(item, true);
      this.assemblyInstances.add(this.assemblyGhost);
    }
    this.requestRender();
  }

  /** 客户端坐标 → 命中点 + 法向（先打已有零件，未命中退到 Z=0 基准面）。 */
  pickAssemblyHit(clientX: number, clientY: number): SurfaceHit | null {
    const ndc = clientPointToNdc(clientX, clientY, this.canvas.getBoundingClientRect());
    if (!ndc) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const targets: THREE.Object3D[] = [];
    if (this.assemblyRoot) targets.push(this.assemblyRoot);
    for (const child of this.assemblyInstances.children) {
      if (child !== this.assemblyGhost) targets.push(child);
    }
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (hit) {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      const normal = hit.face
        ? hit.face.normal.clone().applyMatrix3(normalMatrix).normalize()
        : new THREE.Vector3(0, 0, 1);
      return { point: [hit.point.x, hit.point.y, hit.point.z], normal: [normal.x, normal.y, normal.z] };
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, point)) return null;
    return { point: [point.x, point.y, 0], normal: [0, 0, 1] };
  }

  setMarqueeMode(on: boolean): void {
    this.marqueeMode = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
  }

  /** 客户端像素矩形内的零件（命中规则同原型框选：屏幕包围矩形相交）。 */
  partsInClientRect(rect: ScreenRect): string[] {
    if (!this.assembly) return [];
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return [];
    this.camera.updateMatrixWorld();
    return partsInRect(this.assembly, this.camera, { left: r.left, top: r.top, width: r.width, height: r.height }, rect,
      this.clipping ? this.clipPlane.constant : null);
  }

  requestRender(): void {
    // 页面被遮挡/最小化时 rAF 不触发，renderQueued 会一直为 true，之后所有渲染请求都被丢掉
    // （表现为「拖动时画面不动、松手后才跳一下」）。超过一个看门狗窗口就认为那帧已经失效。
    if (this.renderQueued) {
      if (performance.now() - this.renderQueuedAt < RENDER_QUEUE_WATCHDOG_MS) return;
      this.renderQueued = false;
    }
    this.renderQueued = true;
    this.renderQueuedAt = performance.now();
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  /**
   * 新材质 / 裁剪平面会触发着色器重编译；软件 GL（swiftshader）与部分驱动并行编译时，
   * 首帧可能画空。按需渲染没有持续循环，所以在编译窗口后补两帧。
   */
  private settle(): void {
    this.requestRender();
    [120, 500].forEach((ms) => window.setTimeout(() => this.requestRender(), ms));
  }

  renderNow(): void {
    if (this.disposed || this.contextLost) return;
    if (!this.host.clientWidth || !this.host.clientHeight) return;
    const frameAt = performance.now();
    if (this.dragging && this.dragPrevFrameAt > 0) {
      const delta = frameAt - this.dragPrevFrameAt;
      // 只有「窗口可见 + 间隔落在单帧预算内」才算一帧。按需渲染下两次 renderNow 之间
      // 可能夹着遮挡/最小化/CPU 挂起造成的数秒空档，那不是帧时间，计入会得出「平均 7 秒一帧」的假结论。
      if (isCredibleFrameSample(delta, document.visibilityState)) {
        this.dragFrames += 1;
        this.dragTotalFrameMs += delta;
        this.dragMaxFrameMs = Math.max(this.dragMaxFrameMs, delta);
      } else {
        this.dragDroppedFrames += 1;
      }
    }
    if (this.dragging) this.dragPrevFrameAt = frameAt;
    this.renderer.render(this.scene, this.camera);
    this.renders += 1;
    this.options.onRender?.(this);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 当前视图的真实渲染指标；三角形数来自最近一帧 renderer.info.render.triangles。 */
  renderStats(): RenderStats {
    const resolved = this.resolveQuality();
    return {
      glRenderer: this.glRenderer,
      isSoftware: this.softwareRendering,
      pixelRatio: effectivePixelRatio(window.devicePixelRatio || 1, resolved.quality, this.dragging),
      quality: resolved.quality,
      partCount: this.assembly?.parts.length ?? 0,
      triangleCount: this.renderer?.info.render.triangles ?? 0,
      dragFrames: this.dragFrames,
      dragAvgFrameMs: this.dragFrames > 0 ? Math.round((this.dragTotalFrameMs / this.dragFrames) * 100) / 100 : 0,
      dragMaxFrameMs: Math.round(this.dragMaxFrameMs * 100) / 100,
      dragDroppedFrames: this.dragDroppedFrames,
      lastDragAt: this.lastDragAt,
      input: {
        ...this.inputCounters,
        controlsRebuilds: this.controlsRebuilds,
        dragging: this.dragging,
        camera: `${this.camera.position.x.toFixed(2)},${this.camera.position.y.toFixed(2)},${this.camera.position.z.toFixed(2)}`
      }
    };
  }

  resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const halfHeight = (this.ortho.top - this.ortho.bottom) / 2 || 1;
    this.ortho.left = -halfHeight * (w / h);
    this.ortho.right = halfHeight * (w / h);
    this.ortho.updateProjectionMatrix();
    if (this.autoFit && this.assembly) {
      this.setStandardView(this.lastView);
      return;
    }
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.statsTimer);
    window.clearTimeout(this.dragRestoreTimer);
    this.resizeObserver.disconnect();
    this.host.removeEventListener('pointerdown', this.onMarqueeDown, true);
    window.removeEventListener('pointerup', this.onGlobalPointerEnd, true);
    window.removeEventListener('pointercancel', this.onGlobalPointerEnd, true);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('pointermove', this.onGlobalPointerMove, true);
    this.endMarquee();
    this.controls.dispose();
    if (this.assemblyRoot) disposeObject(this.assemblyRoot);
    if (this.overlayRoot) disposeObject(this.overlayRoot);
    for (const child of [...this.assemblyInstances.children]) disposeObject(child);
    if (this.drawingLayer) disposeObject(this.drawingLayer);
    this.renderer.dispose();
    this.canvas.remove();
  }

  private applyClipping(): void {
    if (!this.assemblyRoot) return;
    const planes = this.clipping ? [this.clipPlane] : [];
    this.assemblyRoot.traverse((obj) => {
      const material = (obj as THREE.Mesh).material as THREE.Material | undefined;
      if (material && !Array.isArray(material)) {
        material.clippingPlanes = planes;
        material.clipShadows = false;
        material.side = this.clipping ? THREE.DoubleSide : THREE.FrontSide;
        material.needsUpdate = true;
      }
    });
  }

  private rebuildGrid(): void {
    if (!this.assembly) return;
    if (this.grid) {
      this.scene.remove(this.grid);
      disposeObject(this.grid);
    }
    const b = this.assembly.bounds;
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 100) * 1.6;
    const step = 16;
    const divisions = Math.max(4, Math.ceil(span / step));
    const grid = new THREE.GridHelper(divisions * step, divisions, 0x474e55, 0x393f45);
    grid.rotateX(Math.PI / 2);
    grid.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, Math.min(0, b.min[2]) - 0.05);
    grid.raycast = () => undefined;
    this.grid = grid;
    this.scene.add(grid);
  }

  private rebuildSection(): void {
    if (this.sectionPlane) {
      this.scene.remove(this.sectionPlane);
      disposeObject(this.sectionPlane);
      this.sectionPlane = null;
    }
    if (!this.showSection || !this.assembly) return;
    this.sectionPlane = buildSectionPlane(this.assembly.sectionX, this.assembly.bounds);
    this.scene.add(this.sectionPlane);
  }

  private readonly onMarqueeDown = (event: PointerEvent): void => {
    if (event.target !== this.canvas || event.button !== 0) return;
    if (!this.marqueeMode && !event.shiftKey) return;
    event.stopPropagation();
    event.preventDefault();
    this.marqueeDrag = { x: event.clientX, y: event.clientY, active: false, pointerId: event.pointerId };
    window.addEventListener('pointermove', this.onMarqueeMove, true);
    window.addEventListener('pointerup', this.onMarqueeUp, true);
    window.addEventListener('pointercancel', this.onMarqueeCancel, true);
  };

  private readonly onMarqueeMove = (event: PointerEvent): void => {
    const drag = this.marqueeDrag;
    if (!drag) return;
    event.stopPropagation();
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.active && Math.hypot(dx, dy) < 5) return;
    drag.active = true;
    const box = this.options.marqueeBox;
    if (!box) return;
    const r = this.host.getBoundingClientRect();
    box.hidden = false;
    box.style.left = `${Math.min(drag.x, event.clientX) - r.left}px`;
    box.style.top = `${Math.min(drag.y, event.clientY) - r.top}px`;
    box.style.width = `${Math.abs(dx)}px`;
    box.style.height = `${Math.abs(dy)}px`;
  };

  private readonly onMarqueeUp = (event: PointerEvent): void => {
    const drag = this.marqueeDrag;
    if (!drag) return;
    event.stopPropagation();
    this.endMarquee();
    if (!drag.active) {
      // 没拖动：按普通点击拾取
      this.options.onPick?.(this.pick(event.clientX, event.clientY), event);
      return;
    }
    this.options.onMarquee?.(rectFromPoints(drag.x, drag.y, event.clientX, event.clientY));
  };

  private readonly onMarqueeCancel = (): void => {
    this.endMarquee();
  };

  private endMarquee(): void {
    this.marqueeDrag = null;
    window.removeEventListener('pointermove', this.onMarqueeMove, true);
    window.removeEventListener('pointerup', this.onMarqueeUp, true);
    window.removeEventListener('pointercancel', this.onMarqueeCancel, true);
    if (this.options.marqueeBox) this.options.marqueeBox.hidden = true;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.inputCounters.pointerDowns += 1;
    this.down = { x: event.clientX, y: event.clientY, button: event.button };
    try {
      // 捕获指针，保证画布外抬起也能收到 pointerup。
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // 部分合成事件没有可捕获的 pointerId，忽略即可。
    }
  };

  /**
   * 重建控制器以清掉 OrbitControls 的内部交互状态。
   *
   * OrbitControls 把「正在拖动」记在私有 state 里：`onMouseWheel` 第一行就是 `state !== NONE → return`，
   * 所以一旦漏掉一次 pointerup，滚轮缩放会整体失效，鼠标移动还会继续转。它没有公开的重置手段，
   * 重建实例是唯一干净的做法（相机与 target 保持不变）。
   */
  private resetControlsState(): void {
    if (!this.controls || this.dragging) return;
    // 节流：重建会打断进行中的拖动，短时间反复重建反而让视口更"死"。
    if (performance.now() - this.lastControlsRebuildAt < CONTROLS_REBUILD_MIN_INTERVAL_MS) return;
    this.lastControlsRebuildAt = performance.now();
    this.controlsRebuilds += 1;
    const target = this.controls.target.clone();
    this.controls.dispose();
    this.createControls(target);
    this.requestRender();
  }

  /**
   * 自愈：拖动标记还在但已经没有按下的指针时，结束拖动并重建控制器。
   * 重建是唯一能清掉 OrbitControls 私有状态的公开手段（它是事件处理期间丢帧/丢 pointerup 的唯一后果）。
   */
  private healStaleDrag(): void {
    if (!isStaleDrag(this.dragging, this.down !== null)) return;
    this.endDrag();
    this.resetControlsState();
  }

  private readonly onGlobalPointerEnd = (event: PointerEvent): void => {
    // 画布内（含指针捕获后重定向到画布）的抬起由 onPointerUp 处理：它要用 this.down 判断
    // 是「点击选中」还是「拖拽旋转」。在 window 捕获阶段抢先清空会让点击选中彻底失效。
    if (event.target !== this.canvas) this.down = null;
    // 这个监听在捕获阶段、早于 OrbitControls 自己的 pointerup 处理，此刻还看不出它有没有收到。
    // 推迟到本轮事件派发结束后再判：若 dragging 仍为 true，说明 OrbitControls 漏掉了这次抬起，
    // 内部 state 停在 ROTATE（滚轮失效、不按键也跟动），结束拖动并重建控制器把它清掉。
    window.setTimeout(() => {
      if (!this.dragging) return;
      this.endDrag();
      this.resetControlsState();
    }, 0);
  };

  private readonly onWindowBlur = (): void => {
    if (this.dragging) this.endDrag();
    this.down = null;
  };

  private readonly onGlobalPointerMove = (): void => {
    // 指针在画布外移动时也要检查：僵死状态下画面会"不按键也跟动"，必须在任意一次移动时自愈。
    this.healStaleDrag();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.inputCounters.pointerUps += 1;
    const down = this.down;
    this.down = null;
    if (!isClickSelect(down, event)) return;
    this.options.onPick?.(this.pick(event.clientX, event.clientY), event);
  };

  private hoverFrame = 0;
  private readonly onPointerMove = (event: PointerEvent): void => {
    this.inputCounters.pointerMoves += 1;
    this.healStaleDrag();
    if (this.down || this.hoverFrame) return;
    const { clientX, clientY } = event;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const id = this.pick(clientX, clientY);
      if (id === this.lastHover) return;
      this.lastHover = id;
      this.options.onHover?.(id);
    });
  };

  private readonly onWheelCount = (): void => {
    this.inputCounters.wheels += 1;
  };

  private readonly onPointerLeave = (): void => {
    if (this.lastHover === null) return;
    this.lastHover = null;
    this.options.onHover?.(null);
  };
}
