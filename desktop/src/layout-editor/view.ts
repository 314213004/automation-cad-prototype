/**
 * 整机布局编辑：three.js 视口（需要 WebGL / DOM，不进 Node 单测）。
 *
 * 场景单位 = mm、Z 向上（与 MachineGeometry 一致，不做缩放）。网格由规则引擎原始几何
 * （generatedGeometryForDesign）建一次，工位位姿只改工位组的变换：
 *   group.position = pivot + t，group.rotation.z = θ，inner.position = −pivot
 * 与 applyStationGeometryLayout 的数学完全一致（先绕原始原点转、再平移）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { MachineGeometry } from '../machine/geometry.ts';
import { partLocalMesh } from '../machine/geometry-export.ts';
import type { LayoutModel, LayoutPose } from './model.ts';
import type { SnapGuide } from './snap.ts';
import type { DragHandle } from './numeric.ts';

export interface PickHit {
  partId: string;
  point: [number, number, number];
  normal?: [number, number, number];
}

export type ViewPreset = 'iso' | 'top' | 'front' | 'right';

interface PartNode {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  stationId: string | null;
}

const SELECT_COLOR = new THREE.Color('#14b8a6');
const RED_COLOR = new THREE.Color('#e11d48');

export class LayoutEditorView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 1_000_000);
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly proxy = new THREE.Object3D();
  private readonly host: HTMLElement;
  private readonly machine = new THREE.Group();
  private readonly overlay = new THREE.Group();
  private readonly stationGroups = new Map<string, { group: THREE.Group; inner: THREE.Group; pivot: [number, number] }>();
  private readonly parts = new Map<string, PartNode>();
  private readonly raycaster = new THREE.Raycaster();
  private grid: THREE.GridHelper | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private bounds = new THREE.Box3();

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = 'le-canvas';
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#e9eff2');
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5d6b72, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3000, -4000, 6000);
    this.scene.add(sun);
    this.scene.add(this.machine, this.overlay, this.proxy);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.9);
    this.gizmo.addEventListener('dragging-changed', (event) => { this.controls.enabled = !(event as unknown as { value: boolean }).value; });
    this.gizmo.addEventListener('change', () => this.requestRender());
    this.scene.add(this.gizmo.getHelper());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  /** 由规则引擎原始几何建网格；model 提供每个工位的枢轴。 */
  setGeometry(generated: MachineGeometry, model: LayoutModel): void {
    this.clearMachine();
    for (const station of model.stations) {
      const group = new THREE.Group();
      group.name = `layout-station:${station.id}`;
      const inner = new THREE.Group();
      inner.position.set(-station.pivot[0], -station.pivot[1], 0);
      group.add(inner);
      this.machine.add(group);
      this.stationGroups.set(station.id, { group, inner, pivot: [station.pivot[0], station.pivot[1]] });
    }
    const geometries = new Map<string, THREE.BufferGeometry>();
    for (const part of generated.parts) {
      const key = part.shape.type === 'box' ? `b:${part.shape.size.join(',')}` : `c:${part.shape.radius},${part.shape.length},${part.shape.axis}`;
      let geometry = geometries.get(key);
      if (!geometry) {
        const local = partLocalMesh(part, 24);
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(local.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(local.normals, 3));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        geometries.set(key, geometry);
      }
      const baseColor = new THREE.Color(part.color);
      const material = new THREE.MeshStandardMaterial({ color: baseColor.clone(), metalness: part.role === 'actuator' ? 0.5 : 0.2, roughness: 0.55 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = part.id;
      mesh.position.set(part.center[0], part.center[1], part.center[2]);
      mesh.rotation.z = THREE.MathUtils.degToRad(part.rotationZDeg);
      mesh.userData.partId = part.id;
      const station = part.stationId ? this.stationGroups.get(part.stationId) : undefined;
      (station ? station.inner : this.machine).add(mesh);
      this.parts.set(part.id, { mesh, material, baseColor, stationId: part.stationId ?? null });
    }
    this.machine.updateMatrixWorld(true);
    this.bounds = new THREE.Box3().setFromObject(this.machine);
    this.updateGrid();
    this.requestRender();
  }

  /** 应用工位位姿（主数据或拖动中的候选值）。 */
  applyPoses(poses: ReadonlyMap<string, LayoutPose>): void {
    for (const [id, pose] of poses) {
      const node = this.stationGroups.get(id);
      if (!node) continue;
      node.group.position.set(node.pivot[0] + pose.xMm, node.pivot[1] + pose.yMm, 0);
      node.group.rotation.set(0, 0, THREE.MathUtils.degToRad(pose.rotationZDeg));
    }
    this.machine.updateMatrixWorld(true);
    this.requestRender();
  }

  setHighlight(selected: ReadonlySet<string>, red: ReadonlySet<string>): void {
    for (const [id, node] of this.parts) {
      const color = node.baseColor.clone();
      let emissive = new THREE.Color(0x000000);
      if (red.has(id)) {
        color.lerp(RED_COLOR, 0.75);
        emissive = RED_COLOR.clone().multiplyScalar(0.35);
      } else if (selected.has(id)) {
        color.lerp(SELECT_COLOR, 0.45);
        emissive = SELECT_COLOR.clone().multiplyScalar(0.25);
      }
      node.material.color.copy(color);
      node.material.emissive.copy(emissive);
    }
    this.requestRender();
  }

  pick(clientX: number, clientY: number): PickHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects([...this.parts.values()].map((node) => node.mesh), false)[0];
    if (!hit) return null;
    const partId = String(hit.object.userData.partId ?? '');
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    return {
      partId,
      point: [hit.point.x, hit.point.y, hit.point.z],
      ...(normal ? { normal: [normal.x, normal.y, normal.z] as [number, number, number] } : {})
    };
  }

  /** 框选：零件世界包络 8 角点投影到屏幕，与框相交即命中（同主视口框选口径）。 */
  partsInScreenRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const left = Math.min(x0, x1) - rect.left;
    const right = Math.max(x0, x1) - rect.left;
    const top = Math.min(y0, y1) - rect.top;
    const bottom = Math.max(y0, y1) - rect.top;
    const out: string[] = [];
    const box = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (const [id, node] of this.parts) {
      box.setFromObject(node.mesh);
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let visible = false;
      for (let i = 0; i < 8; i += 1) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(this.camera);
        if (corner.z > 1) continue;
        visible = true;
        const sx = (corner.x + 1) / 2 * rect.width;
        const sy = (1 - corner.y) / 2 * rect.height;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (visible && minX <= right && maxX >= left && minY <= bottom && maxY >= top) out.push(id);
    }
    return out;
  }

  /** 把 gizmo 挂到代理点（选择中心）；mode='rotate' 只露出绕 Z 环。 */
  attachGizmo(center: [number, number, number] | null, mode: 'translate' | 'rotate'): void {
    if (!center) {
      this.gizmo.detach();
      this.requestRender();
      return;
    }
    this.proxy.position.set(center[0], center[1], center[2]);
    this.proxy.rotation.set(0, 0, 0);
    this.proxy.updateMatrixWorld(true);
    this.gizmo.setMode(mode);
    this.gizmo.showX = mode === 'translate';
    this.gizmo.showY = mode === 'translate';
    this.gizmo.showZ = mode === 'rotate';
    this.gizmo.attach(this.proxy);
    this.requestRender();
  }

  /** 当前拖动手柄（TransformControls.axis → 编辑器手柄）；不支持的手柄返回 null。 */
  activeHandle(): DragHandle | null {
    const axis = this.gizmo.axis;
    if (this.gizmo.mode === 'rotate') return axis === 'Z' ? 'RZ' : null;
    if (axis === 'X' || axis === 'Y' || axis === 'XY') return axis;
    return null;
  }

  /** 结束 TransformControls 的拖动（数值输入回车 / Esc 取消时调用）。 */
  endGizmoDrag(): void {
    const controls = this.gizmo as unknown as { pointerUp?: (pointer: { x: number; y: number; button: number }) => void };
    controls.pointerUp?.({ x: 0, y: 0, button: 0 });
    this.controls.enabled = true;
  }

  setProxy(center: [number, number, number], rotationZDeg: number): void {
    this.proxy.position.set(center[0], center[1], center[2]);
    this.proxy.rotation.set(0, 0, THREE.MathUtils.degToRad(rotationZDeg));
    this.proxy.updateMatrixWorld(true);
    this.requestRender();
  }

  showGuides(guides: readonly SnapGuide[], z: number): void {
    this.clearOverlay('guide');
    for (const guide of guides) {
      const points = guide.axis === 'x'
        ? [new THREE.Vector3(guide.value, guide.from - 60, z), new THREE.Vector3(guide.value, guide.to + 60, z)]
        : [new THREE.Vector3(guide.from - 60, guide.value, z), new THREE.Vector3(guide.to + 60, guide.value, z)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineDashedMaterial({ color: 0xd946ef, dashSize: 18, gapSize: 10, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 10;
      line.userData.overlay = 'guide';
      this.overlay.add(line);
    }
    this.requestRender();
  }

  showOverlapBoxes(boxes: ReadonlyArray<{ min: [number, number, number]; max: [number, number, number] }>): void {
    this.clearOverlay('overlap');
    for (const item of boxes.slice(0, 60)) {
      const box = new THREE.Box3(new THREE.Vector3(...item.min), new THREE.Vector3(...item.max));
      const helper = new THREE.Box3Helper(box, new THREE.Color('#e11d48'));
      (helper.material as THREE.LineBasicMaterial).depthTest = false;
      helper.renderOrder = 11;
      helper.userData.overlay = 'overlap';
      this.overlay.add(helper);
    }
    this.requestRender();
  }

  showMeasure(points: ReadonlyArray<[number, number, number]>): void {
    this.clearOverlay('measure');
    const material = new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false });
    const radius = Math.max(4, this.bounds.getSize(new THREE.Vector3()).length() / 300);
    for (const point of points) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
      dot.position.set(...point);
      dot.renderOrder = 12;
      dot.userData.overlay = 'measure';
      this.overlay.add(dot);
    }
    if (points.length === 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(...point))), new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false }));
      line.renderOrder = 12;
      line.userData.overlay = 'measure';
      this.overlay.add(line);
    }
    this.requestRender();
  }

  /** 世界点 → 宿主内像素坐标（HUD 标签定位）。 */
  toScreen(point: [number, number, number]): { x: number; y: number } | null {
    const v = new THREE.Vector3(...point).project(this.camera);
    if (v.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height };
  }

  /** 视口中心处一个屏幕像素对应的毫米数（特征吸附容差换算）。 */
  mmPerPixel(): number {
    const height = this.renderer.domElement.clientHeight || 1;
    const distance = this.camera.position.distanceTo(this.controls.target);
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / height;
  }

  setView(preset: ViewPreset): void {
    const box = this.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-500, -500, 0), new THREE.Vector3(500, 500, 500)) : this.bounds;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 100);
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dir = preset === 'top' ? new THREE.Vector3(0, -0.0001, 1)
      : preset === 'front' ? new THREE.Vector3(0, -1, 0.0001)
        : preset === 'right' ? new THREE.Vector3(1, 0, 0.0001)
          : new THREE.Vector3(1, -1.2, 0.9);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, distance);
    this.camera.near = Math.max(1, distance / 1000);
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  requestRender(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  renderNow(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.controls.dispose();
    this.clearMachine();
    this.clearOverlay();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private updateGrid(): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const size = this.bounds.isEmpty() ? 2000 : Math.max(this.bounds.max.x - this.bounds.min.x, this.bounds.max.y - this.bounds.min.y) * 1.6;
    const step = size > 4000 ? 500 : size > 1500 ? 100 : 50;
    const span = Math.ceil(size / step) * step;
    this.grid = new THREE.GridHelper(span, Math.round(span / step), 0x8aa1a9, 0xc8d4d9);
    this.grid.rotation.x = Math.PI / 2;
    const center = this.bounds.isEmpty() ? new THREE.Vector3() : this.bounds.getCenter(new THREE.Vector3());
    this.grid.position.set(Math.round(center.x / step) * step, Math.round(center.y / step) * step, 0);
    this.scene.add(this.grid);
  }

  private clearMachine(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    for (const node of this.parts.values()) {
      geometries.add(node.mesh.geometry);
      node.material.dispose();
    }
    geometries.forEach((geometry) => geometry.dispose());
    this.parts.clear();
    this.stationGroups.clear();
    this.machine.clear();
  }

  private clearOverlay(kind?: string): void {
    for (const child of [...this.overlay.children]) {
      if (kind && child.userData.overlay !== kind) continue;
      this.overlay.remove(child);
      const disposable = child as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material };
      disposable.geometry?.dispose();
      disposable.material?.dispose();
    }
  }
}
