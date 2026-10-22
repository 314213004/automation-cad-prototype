import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CadImportResult, CadMeshData } from '../shared/types';
import { boundsFromPositions, type InterferencePart } from '../mech/interference';
import { probeWebGL } from './webgl';

export interface CadSelectionInfo {
  index: number;
  name: string;
  triangleCount: number;
  dimensions: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface CadScenePart {
  name: string;
  triangles: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface CadBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
}

export interface CadKinematicsMesh {
  id: number;
  name: string;
  triangles: number;
  center: [number, number, number];
  size: [number, number, number];
}

export interface CadKinematicsPose {
  offset: [number, number, number];
  rotationRad: number;
  axis: 'x' | 'y' | 'z';
}

export interface CadViewerOptions {
  container: HTMLElement;
  partsElement: HTMLElement;
  detailElement: HTMLElement;
  onStats?: (text: string) => void;
  onSelect?: (info: CadSelectionInfo | null) => void;
}

interface LoadedPart {
  data: CadMeshData;
  mesh: THREE.Mesh;
  triangleCount: number;
}

const DEFAULT_COLORS = [0x7f8b96, 0x9aa6b2, 0xb5a078, 0x6f9e9a, 0xa77e8d, 0x8e9b74];

export class CadViewer {
  private readonly container: HTMLElement;
  private readonly partsElement: HTMLElement;
  private readonly detailElement: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1_000_000);
  private renderer: THREE.WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private resizeObserver: ResizeObserver | null = null;
  private readonly group = new THREE.Group();
  private readonly selectionBox = new THREE.Box3();
  private selectionHelper: THREE.Box3Helper | null = null;
  private grid: THREE.GridHelper | null = null;
  private parts: LoadedPart[] = [];
  private modelParts: InterferencePart[] = [];
  private importedResult: CadImportResult | null = null;
  private selected: number | null = null;
  private pointerDown = { x: 0, y: 0 };
  private wireframe = false;
  private active = false;
  private degraded = false;
  private fallbackElement: HTMLElement | null = null;
  private onStats: ((text: string) => void) | undefined;
  private onSelect: ((info: CadSelectionInfo | null) => void) | undefined;
  private animationRunning = false;

  constructor(options: CadViewerOptions) {
    this.container = options.container;
    this.partsElement = options.partsElement;
    this.detailElement = options.detailElement;
    this.onStats = options.onStats;
    this.onSelect = options.onSelect;
    this.scene.background = new THREE.Color(0x2a2d31);
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(0xf1f5f9, 0x2a2d31, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1, -1.4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9c6d2, 0.65);
    fill.position.set(-1.4, 1, 0.7);
    this.scene.add(fill);

    this.camera.up.set(0, 0, 1);
    const capability = probeWebGL(() => document.createElement('canvas'));
    if (!capability.ok) {
      this.enterDegradedMode(capability.reason ?? 'WebGL 不可用', null);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (error) {
      this.enterDegradedMode(
        error instanceof Error ? error.message : String(error),
        null
      );
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'cad-canvas';
    this.container.appendChild(renderer.domElement);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN
    };
    this.controls = controls;

    const selectionHelper = new THREE.Box3Helper(this.selectionBox, 0x14b8a6);
    selectionHelper.visible = false;
    selectionHelper.renderOrder = 20;
    const helperMaterial = selectionHelper.material as THREE.LineBasicMaterial;
    helperMaterial.depthTest = false;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.9;
    this.selectionHelper = selectionHelper;
    this.scene.add(selectionHelper);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.partsElement.addEventListener('click', this.handlePartClick);
    this.resize();
  }

  setActive(active: boolean): void {
    if (this.degraded || !this.renderer) return;
    this.active = active;
    if (active && !this.animationRunning) {
      this.animationRunning = true;
      this.renderer.setAnimationLoop(this.renderFrame);
    } else if (!active && this.animationRunning) {
      this.animationRunning = false;
      this.renderer.setAnimationLoop(null);
    }
    if (active) this.resize();
  }

  load(result: CadImportResult, fileName: string): void {
    this.clearModel();
    this.importedResult = result;
    this.modelParts = result.meshes.map((mesh) => ({
      name: mesh.name,
      bbox: boundsFromPositions(mesh.positions)
    }));
    if (this.degraded) {
      this.loadDegraded(result, fileName);
      return;
    }
    const materialCache = new Map<string, THREE.MeshStandardMaterial>();
    result.meshes.forEach((data, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      if (!data.normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const colorKey = data.color ? data.color.map((v) => v.toFixed(3)).join(',') : 'default';
      let material = materialCache.get(colorKey);
      if (!material) {
        const color = data.color ? new THREE.Color(data.color[0], data.color[1], data.color[2]) : new THREE.Color(DEFAULT_COLORS[index % DEFAULT_COLORS.length]!);
        material = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.2,
          roughness: 0.62,
          wireframe: this.wireframe,
          side: THREE.DoubleSide
        });
        materialCache.set(colorKey, material);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = data.name;
      mesh.userData.partIndex = index;
      mesh.userData.kinematicsBasePosition = mesh.position.clone();
      mesh.userData.kinematicsBaseQuaternion = mesh.quaternion.clone();
      this.group.add(mesh);
      const triangleCount = data.indices
        ? Math.floor(data.indices.length / 3)
        : Math.floor(data.positions.length / 9);
      this.parts.push({ data, mesh, triangleCount });
    });
    this.renderPartList();
    this.fit();
    const bounds = this.totalBounds();
    const size = bounds.getSize(new THREE.Vector3());
    this.onStats?.(
      `${fileName} · ${result.stats.meshCount} 个零件 · ${result.stats.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
      `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} mm · ${result.stats.format}`
    );
    this.renderDetail(null);
  }

  fit(): void {
    if (this.degraded || !this.controls) return;
    const bounds = this.totalBounds();
    if (bounds.isEmpty()) {
      this.camera.position.set(760, -760, 620);
      this.camera.near = 0.1;
      this.camera.far = 100_000;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this.updateGrid(new THREE.Vector3(600, 600, 600));
      return;
    }

    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.5);
    const distance = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.28;
    const direction = new THREE.Vector3(1, -1.2, 0.85).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = Math.max(radius / 10_000, 0.001);
    this.camera.far = Math.max(radius * 100, 1000);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.updateGrid(sphere.center, radius * 2.4);
  }

  toggleWireframe(): boolean {
    if (this.degraded) return false;
    this.wireframe = !this.wireframe;
    for (const part of this.parts) {
      const material = part.mesh.material as THREE.MeshStandardMaterial;
      material.wireframe = this.wireframe;
      material.needsUpdate = true;
    }
    return this.wireframe;
  }

  getModelParts(): InterferencePart[] {
    return this.modelParts.map((part) => ({
      name: part.name,
      bbox: {
        min: [...part.bbox.min],
        max: [...part.bbox.max]
      }
    }));
  }

  getSceneParts(): CadScenePart[] {
    return this.parts.map((part) => {
      const box = this.partBounds(part);
      return {
        name: part.data.name,
        triangles: part.triangleCount,
        bbox: {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z]
        }
      };
    });
  }

  getSelectionSnapshot(): { name: string; bbox: number[] } | null {
    if (this.selected === null) return null;
    const part = this.parts[this.selected];
    if (!part) return null;
    const box = this.partBounds(part);
    return {
      name: part.data.name,
      bbox: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
    };
  }

  getBomRows(): CadBomRow[] {
    return this.modelParts.map((part, index) => ({
      no: index + 1,
      name: part.name,
      spec: part.name,
      qty: 1,
      mat: '—'
    }));
  }

  /** 运动学标注网格树的数据源；id 使用 parts 索引。 */
  getKinematicsMeshes(): CadKinematicsMesh[] {
    if (this.parts.length === 0 && this.importedResult) {
      return this.importedResult.meshes.map((mesh, index) => {
        const bbox = boundsFromPositions(mesh.positions);
        const center: [number, number, number] = [
          (bbox.min[0] + bbox.max[0]) / 2,
          (bbox.min[1] + bbox.max[1]) / 2,
          (bbox.min[2] + bbox.max[2]) / 2
        ];
        const size: [number, number, number] = [
          bbox.max[0] - bbox.min[0],
          bbox.max[1] - bbox.min[1],
          bbox.max[2] - bbox.min[2]
        ];
        return {
          id: index,
          name: mesh.name,
          triangles: mesh.indices ? Math.floor(mesh.indices.length / 3) : Math.floor(mesh.positions.length / 9),
          center,
          size
        };
      });
    }
    return this.parts.map((part, index) => {
      const box = this.partBounds(part);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      return {
        id: index,
        name: part.data.name,
        triangles: part.triangleCount,
        center: [center.x, center.y, center.z],
        size: [size.x, size.y, size.z]
      };
    });
  }

  /** 按动件姿态移动/旋转网格；pivot 为合并包围盒中心。 */
  setKinematicsPose(
    meshIds: readonly number[],
    pose: CadKinematicsPose,
    pivot: [number, number, number]
  ): void {
    if (this.degraded) return;
    const pivotVector = new THREE.Vector3(pivot[0], pivot[1], pivot[2]);
    const offset = new THREE.Vector3(pose.offset[0], pose.offset[1], pose.offset[2]);
    const axisVector =
      pose.axis === 'x' ? new THREE.Vector3(1, 0, 0) : pose.axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const rotation = new THREE.Quaternion().setFromAxisAngle(axisVector, pose.rotationRad);
    for (const id of meshIds) {
      const part = this.parts[id];
      if (!part) continue;
      const mesh = part.mesh;
      const basePosition = (mesh.userData.kinematicsBasePosition as THREE.Vector3 | undefined) ?? mesh.position.clone();
      const baseQuaternion =
        (mesh.userData.kinematicsBaseQuaternion as THREE.Quaternion | undefined) ?? mesh.quaternion.clone();
      const relative = basePosition.clone().sub(pivotVector).applyQuaternion(rotation);
      mesh.position.copy(relative.add(pivotVector).add(offset));
      mesh.quaternion.copy(rotation.clone().multiply(baseQuaternion));
      mesh.updateMatrixWorld(true);
    }
  }

  resetKinematics(meshIds: readonly number[]): void {
    if (this.degraded) return;
    for (const id of meshIds) {
      const part = this.parts[id];
      if (!part) continue;
      const mesh = part.mesh;
      const basePosition = (mesh.userData.kinematicsBasePosition as THREE.Vector3 | undefined) ?? mesh.position.clone();
      const baseQuaternion =
        (mesh.userData.kinematicsBaseQuaternion as THREE.Quaternion | undefined) ?? mesh.quaternion.clone();
      mesh.position.copy(basePosition);
      mesh.quaternion.copy(baseQuaternion);
      mesh.updateMatrixWorld(true);
    }
  }

  addPlaceholderPart(name: string): number {
    if (this.degraded || !this.renderer) {
      throw new Error('当前环境不支持 WebGL，无法插入占位件');
    }
    const displayName = name.trim();
    if (!displayName) throw new Error('占位件名称不能为空');

    const currentBounds = this.totalBounds();
    const centerX = currentBounds.isEmpty() ? 10 : currentBounds.max.x + 12;
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(DEFAULT_COLORS[this.parts.length % DEFAULT_COLORS.length] ?? 0x14b8a6),
      metalness: 0.22,
      roughness: 0.58,
      wireframe: this.wireframe,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = displayName;
    mesh.position.set(centerX, 0, 10);
    mesh.userData.placeholder = true;
    mesh.userData.kinematicsBasePosition = mesh.position.clone();
    mesh.userData.kinematicsBaseQuaternion = mesh.quaternion.clone();

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.9 })
    );
    edges.name = `${displayName}-wire`;
    mesh.add(edges);
    mesh.updateMatrixWorld(true);

    const index = this.parts.length;
    mesh.userData.partIndex = index;
    const data: CadMeshData = {
      name: displayName,
      positions: new Float32Array(),
      normals: null,
      indices: null
    };
    this.parts.push({ data, mesh, triangleCount: 12 });
    this.group.add(mesh);
    const box = this.partBounds({ data, mesh, triangleCount: 12 });
    this.modelParts.push({
      name: displayName,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z]
      }
    });
    this.renderPartList();
    this.syncPartCount();
    this.selectPart(index);
    return index;
  }

  removePart(index: number): boolean {
    if (this.degraded || !Number.isInteger(index)) return false;
    const part = this.parts[index];
    if (!part) return false;

    this.group.remove(part.mesh);
    part.mesh.traverse((object) => {
      const renderable = object as THREE.Mesh;
      renderable.geometry?.dispose();
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of materials) {
        if (!material) continue;
        const shared = this.parts.some((candidate, candidateIndex) =>
          candidateIndex !== index && candidate.mesh.material === material
        );
        if (!shared) material.dispose();
      }
    });

    this.parts.splice(index, 1);
    this.modelParts.splice(index, 1);
    this.parts.forEach((candidate, candidateIndex) => {
      candidate.mesh.userData.partIndex = candidateIndex;
    });
    this.selected = null;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    this.renderPartList();
    this.renderDetail(null);
    this.syncPartCount();
    return true;
  }

  getExportRoot(): THREE.Object3D {
    if (this.parts.length > 0) return this.group;
    if (!this.importedResult) throw new Error('请先打开 CAD 文件再导出 3D 模型');
    const group = new THREE.Group();
    group.name = 'AutomationCAD-Model';
    this.importedResult.meshes.forEach((data, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.slice(), 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
      if (!data.normals) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: DEFAULT_COLORS[index % DEFAULT_COLORS.length] ?? 0x7f8b96 })
      );
      mesh.name = data.name;
      group.add(mesh);
    });
    return group;
  }

  highlightNames(names: readonly string[], focus = false): boolean {
    if (this.degraded || !this.selectionHelper) return false;
    const wanted = new Set(names);
    const indices: number[] = [];
    this.parts.forEach((part, index) => {
      if (wanted.has(part.data.name)) indices.push(index);
    });
    if (indices.length === 0) return false;

    const selection = new THREE.Box3();
    for (const index of indices) {
      const part = this.parts[index];
      if (!part) continue;
      part.mesh.geometry.computeBoundingBox();
      const box = part.mesh.geometry.boundingBox?.clone().applyMatrix4(part.mesh.matrixWorld);
      if (box) selection.union(box);
    }
    if (selection.isEmpty()) return false;

    this.selected = indices[0] ?? null;
    this.selectionBox.copy(selection);
    this.selectionHelper.box.copy(selection);
    this.selectionHelper.visible = true;
    this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => {
      const index = Number((row as HTMLElement).dataset.partIndex);
      row.classList.toggle('is-selected', indices.includes(index));
    });
    const first = indices[0];
    if (first !== undefined) {
      const part = this.parts[first];
      if (part) this.renderDetail(this.selectionInfo(part, first));
    }
    if (focus && this.controls) {
      const center = selection.getCenter(new THREE.Vector3());
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(offset);
      this.controls.update();
    }
    return true;
  }

  selectPart(index: number | null, focus = false): void {
    if (this.degraded) return;
    if (!this.selectionHelper) return;
    if (index === null || !this.parts[index]) {
      this.selected = null;
      this.selectionHelper.visible = false;
      this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => row.classList.remove('is-selected'));
      this.renderDetail(null);
      return;
    }
    this.selected = index;
    const part = this.parts[index];
    if (!part) return;
    part.mesh.geometry.computeBoundingBox();
    if (part.mesh.geometry.boundingBox) {
      this.selectionBox.copy(part.mesh.geometry.boundingBox).applyMatrix4(part.mesh.matrixWorld);
      this.selectionHelper.box.copy(this.selectionBox);
      this.selectionHelper.visible = true;
    }
    this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => {
      row.classList.toggle('is-selected', Number((row as HTMLElement).dataset.partIndex) === index);
    });
    if (focus) {
      const controls = this.controls;
      if (!controls) return;
      const center = this.selectionBox.getCenter(new THREE.Vector3());
      const currentOffset = this.camera.position.clone().sub(controls.target);
      controls.target.copy(center);
      this.camera.position.copy(center).add(currentOffset);
      controls.update();
    }
    this.renderDetail(this.selectionInfo(part, index));
  }

  dispose(): void {
    this.setActive(false);
    this.resizeObserver?.disconnect();
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
      this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    }
    this.partsElement.removeEventListener('click', this.handlePartClick);
    this.clearModel();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.fallbackElement?.remove();
    this.fallbackElement = null;
  }

  private readonly renderFrame = (): void => {
    if (!this.active || !this.renderer || !this.controls) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private totalBounds(): THREE.Box3 {
    const bounds = new THREE.Box3();
    if (this.parts.length === 0) return bounds;
    for (const part of this.parts) {
      const partBox = this.partBounds(part);
      if (!partBox.isEmpty()) bounds.union(partBox);
    }
    return bounds;
  }

  private partBounds(part: LoadedPart): THREE.Box3 {
    part.mesh.updateMatrixWorld(true);
    part.mesh.geometry.computeBoundingBox();
    return part.mesh.geometry.boundingBox?.clone().applyMatrix4(part.mesh.matrixWorld) ?? new THREE.Box3();
  }

  private updateGrid(center: THREE.Vector3, radius?: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const span = Math.max(radius ?? center.length() * 1.5, 20);
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const size = Math.ceil(span / (step * 5)) * step * 10;
    this.grid = new THREE.GridHelper(size, 20, 0x59616a, 0x3b4046);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(center.x, center.y, center.z - span * 0.06);
    this.scene.add(this.grid);
  }

  private updateGridForSize(size: THREE.Vector3): void {
    const maxSize = Math.max(size.x, size.y, size.z, 10);
    this.updateGrid(new THREE.Vector3(), maxSize);
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private renderPartList(): void {
    this.partsElement.innerHTML = '';
    this.parts.forEach((part, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cad-part-row';
      row.dataset.partIndex = String(index);
      row.innerHTML = `<span class="cad-part-index">${String(index + 1).padStart(2, '0')}</span><span class="cad-part-name"></span><span class="cad-part-tris">${part.triangleCount}</span>`;
      const name = row.querySelector('.cad-part-name');
      if (name) name.textContent = part.data.name;
      this.partsElement.appendChild(row);
    });
  }

  private syncPartCount(): void {
    const count = document.getElementById('cadPartCount');
    if (count) count.textContent = String(this.parts.length);
  }

  private renderDetail(info: CadSelectionInfo | null): void {
    this.onSelect?.(info);
    if (!info) {
      this.detailElement.innerHTML = '<div class="cad-detail-empty">单击零件查看包围盒与尺寸</div>';
      return;
    }
    this.detailElement.innerHTML = `
      <div class="cad-detail-title"></div>
      <dl class="cad-detail-grid">
        <dt>尺寸</dt><dd>${info.dimensions.map((value) => value.toFixed(3)).join(' × ')} mm</dd>
        <dt>三角面</dt><dd>${info.triangleCount.toLocaleString('zh-CN')}</dd>
        <dt>X 范围</dt><dd>${info.bounds.min[0].toFixed(3)} → ${info.bounds.max[0].toFixed(3)}</dd>
        <dt>Y 范围</dt><dd>${info.bounds.min[1].toFixed(3)} → ${info.bounds.max[1].toFixed(3)}</dd>
        <dt>Z 范围</dt><dd>${info.bounds.min[2].toFixed(3)} → ${info.bounds.max[2].toFixed(3)}</dd>
      </dl>`;
    const title = this.detailElement.querySelector('.cad-detail-title');
    if (title) title.textContent = info.name;
  }

  private selectionInfo(part: LoadedPart, index: number): CadSelectionInfo {
    const box = this.partBounds(part);
    const size = box.getSize(new THREE.Vector3());
    return {
      index,
      name: part.data.name,
      triangleCount: part.triangleCount,
      dimensions: [size.x, size.y, size.z],
      bounds: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z]
      }
    };
  }

  private readonly handlePartClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.cad-part-row');
    if (!row) return;
    const index = Number(row.dataset.partIndex);
    if (Number.isInteger(index)) this.selectPart(index, true);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.renderer) return;
    if (event.button !== 0) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    if (moved > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.group.children, false)[0];
    if (!hit) {
      this.selectPart(null);
      return;
    }
    const index = Number(hit.object.userData.partIndex);
    if (Number.isInteger(index)) this.selectPart(index);
  };

  private clearModel(): void {
    this.selected = null;
    this.modelParts = [];
    this.importedResult = null;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      const material = part.mesh.material as THREE.Material;
      material.dispose();
      this.group.remove(part.mesh);
    }
    this.parts = [];
    this.partsElement.innerHTML = '';
    this.renderDetail(null);
  }

  private enterDegradedMode(reason: string, result: CadImportResult | null, fileName?: string): void {
    this.degraded = true;
    this.container.innerHTML = '';
    const panel = document.createElement('div');
    panel.id = 'cadWebglFallback';
    panel.className = 'cad-webgl-fallback';
    panel.dataset.reason = reason;
    panel.dataset.meshCount = result ? String(result.stats.meshCount) : '0';
    panel.dataset.triangleCount = result ? String(result.stats.triangleCount) : '0';
    panel.innerHTML = `
      <div class="cad-fallback-ico">${this.fallbackIcon()}</div>
      <div class="cad-fallback-title">当前环境不支持 WebGL，无法显示 3D 模型</div>
      <div class="cad-fallback-sub">文件仍可在后台解析；以下为解析统计，3D 渲染已停用。</div>
      <dl class="cad-fallback-stats">
        <dt>文件</dt><dd data-cad-fallback="file">${fileName ? this.escapeHtml(fileName) : '未打开文件'}</dd>
        <dt>零件数</dt><dd data-cad-fallback="meshes">${result ? result.stats.meshCount : 0}</dd>
        <dt>三角面</dt><dd data-cad-fallback="triangles">${result ? result.stats.triangleCount.toLocaleString('zh-CN') : 0}</dd>
        <dt>包围盒</dt><dd data-cad-fallback="bounds">${result ? this.boundsText(result) : '—'}</dd>
        <dt>原因</dt><dd class="cad-fallback-reason">${this.escapeHtml(reason)}</dd>
      </dl>`;
    this.container.appendChild(panel);
    this.fallbackElement = panel;
    this.partsElement.innerHTML = '<div class="cad-parts-empty">WebGL 不可用，零件树暂停显示</div>';
    this.detailElement.innerHTML = '<div class="cad-detail-empty">当前环境不支持 3D 渲染，已切换为解析统计视图。</div>';
    if (result) {
      const bounds = this.rawBounds(result);
      this.onStats?.(
        `${fileName ?? 'CAD 文件'} · ${result.stats.meshCount} 个零件 · ` +
        `${result.stats.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
        `${bounds.sizeText} mm · ${result.stats.format} · WebGL 不可用`
      );
    }
  }

  private loadDegraded(result: CadImportResult, fileName: string): void {
    const bounds = this.rawBounds(result);
    this.enterDegradedMode(this.fallbackElement?.dataset.reason ?? 'WebGL 不可用', result, fileName);
    const boundsCell = this.fallbackElement?.querySelector<HTMLElement>('[data-cad-fallback="bounds"]');
    if (boundsCell) boundsCell.textContent = `${bounds.sizeText} mm`;
  }

  private rawBounds(result: CadImportResult): {
    min: [number, number, number];
    max: [number, number, number];
    sizeText: string;
  } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const mesh of result.meshes) {
      const positions = mesh.positions;
      for (let index = 0; index + 2 < positions.length; index += 3) {
        const x = positions[index]!;
        const y = positions[index + 1]!;
        const z = positions[index + 2]!;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    if (!Number.isFinite(min[0])) {
      return { min: [0, 0, 0], max: [0, 0, 0], sizeText: '0 × 0 × 0' };
    }
    const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return { min, max, sizeText: size.map((value) => value.toFixed(3)).join(' × ') };
  }

  private boundsText(result: CadImportResult): string {
    return `${this.rawBounds(result).sizeText} mm`;
  }

  private escapeHtml(value: string): string {
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

  private fallbackIcon(): string {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14"/><path d="M3.4 12.6L12.6 3.4"/></svg>';
  }
}
