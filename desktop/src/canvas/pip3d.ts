// 画布工作台 · 3D 预览（P4 第一步）
//
// 只画**概念占位体**：按节点的 dimsMm 与 ortho 坐标画盒子，转接板用橙色区分，直线轴
// 额外画一条运动包络线框。这不是型号级几何，也没有 B-Rep / 干涉能力——界面上必须这么写。
//
// 实现取舍：不用 cad/viewer.ts（它吃 CadImportResult 网格，画布这边没有网格数据），
// 用一份轻量 three 场景 + 自写球坐标轨道，避免为占位体引入整套导入管线。
import * as THREE from 'three';
import { isAdapterNode } from './graph.ts';
import { pipDirtyIds, pipNodeIdsChanged, snapshotPipGraph } from './canvas3d-sync.ts';
import type { MachineGraph } from './types.ts';

const MM = 1 / 1000;

export interface PipBox {
  id: string;
  name: string;
  /** 盒中心（米），y 为离地高度中心。 */
  center: [number, number, number];
  /** 盒尺寸（米）。 */
  size: [number, number, number];
  /** 运动包络尺寸（米）；无行程时与 size 相同。 */
  envelope: [number, number, number];
  adapter: boolean;
  selected: boolean;
}

/**
 * 纯几何映射：mm → m、盒子落地（y = h/2）、直线轴包络沿 X 展开行程。
 * 抽出来是为了不依赖 WebGL 也能单测。
 */
export function buildPipBoxes(graph: MachineGraph, selectedId: string | null): PipBox[] {
  return graph.nodes.map((node) => {
    const [w, h, d] = node.dimsMm;
    const moving = node.kind === 'linear' && node.strokeMm > 0;
    return {
      id: node.id,
      name: node.name,
      center: [(node.ortho.x + w / 2) * MM, (h / 2) * MM, (node.ortho.y + d / 2) * MM],
      size: [w * MM, h * MM, d * MM],
      envelope: moving ? [(w + node.strokeMm) * MM, h * MM, d * MM] : [w * MM, h * MM, d * MM],
      adapter: isAdapterNode(node),
      selected: node.id === selectedId
    };
  });
}

export interface PipScene {
  status: 'ready' | 'unavailable';
  reason: string;
  /** 用最新图重建盒子，并同步选中高亮。 */
  update(graph: MachineGraph, selectedId: string | null): void;
  /**
   * 增量更新：只重建 dirtyIds 里的盒子（节点已删除时只移除），其余盒子不动、
   * 材质不重建；选中变化时只改新旧选中盒的材质颜色。首次渲染（无盒子）时退回全量。
   */
  updateIncremental(graph: MachineGraph, selectedId: string | null, dirtyIds: readonly string[]): void;
  focus(nodeId: string | null): void;
  resetView(): void;
  setWireframe(wireframe: boolean): void;
  dispose(): void;
}

interface OrbitState {
  yaw: number;
  pitch: number;
  distance: number;
  target: THREE.Vector3;
}

const BACKGROUND = 0x161a1d;

export function createPipScene(host: HTMLElement): PipScene {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch (error) {
    const reason = `当前环境不支持 WebGL，3D 预览不可用：${error instanceof Error ? error.message : String(error)}`;
    host.innerHTML = `<p class="cw-pip-fallback">${reason}</p>`;
    return {
      status: 'unavailable',
      reason,
      update: () => undefined,
      updateIncremental: () => undefined,
      focus: () => undefined,
      resetView: () => undefined,
      setWireframe: () => undefined,
      dispose: () => undefined
    };
  }

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(BACKGROUND, 1);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
  const ambient = new THREE.AmbientLight(0xffffff, 1.5);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, 4, 3);
  const fill = new THREE.DirectionalLight(0x88bbcc, 0.8);
  fill.position.set(-3, 2, -2);
  scene.add(ambient, key, fill);

  const grid = new THREE.GridHelper(6, 12, 0x2c3a41, 0x212a30);
  scene.add(grid);

  const orbit: OrbitState = { yaw: -0.7, pitch: 0.55, distance: 3.2, target: new THREE.Vector3(0.5, 0.25, 0.4) };
  const root = new THREE.Group();
  scene.add(root);
  const disposables: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  let boxes = new Map<string, THREE.Mesh>();
  let envelopes = new Map<string, THREE.LineSegments>();
  let lastSelectedId: string | null = null;
  let lastPipGraph: MachineGraph | null = null;

  function resize(): void {
    const width = Math.max(80, host.clientWidth);
    const height = Math.max(60, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  function applyCamera(): void {
    const cosPitch = Math.cos(orbit.pitch);
    camera.position.set(
      orbit.target.x + orbit.distance * cosPitch * Math.cos(orbit.yaw),
      orbit.target.y + orbit.distance * Math.sin(orbit.pitch),
      orbit.target.z + orbit.distance * cosPitch * Math.sin(orbit.yaw)
    );
    camera.lookAt(orbit.target);
  }

  function render(): void {
    applyCamera();
    renderer.render(scene, camera);
  }

  function clearRoot(): void {
    for (const child of [...root.children]) {
      root.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh || (child as THREE.LineSegments).isLineSegments) {
        mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material.dispose();
      }
    }
    for (const geometry of disposables) geometry.dispose();
    for (const material of materials) material.dispose();
    disposables.length = 0;
    materials.length = 0;
    boxes = new Map();
    envelopes = new Map();
    lastSelectedId = null;
    lastPipGraph = null;
  }

  function removeFromArray<T>(arr: T[], item: T): void {
    const idx = arr.indexOf(item);
    if (idx >= 0) arr.splice(idx, 1);
  }

  function disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    removeFromArray(disposables, mesh.geometry);
    const material = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(material)) material.forEach((item) => { item.dispose(); removeFromArray(materials, item); });
    else { material.dispose(); removeFromArray(materials, material); }
  }

  function removeBox(id: string): void {
    const mesh = boxes.get(id);
    if (mesh) {
      root.remove(mesh);
      disposeMesh(mesh);
      boxes.delete(id);
    }
    const envelope = envelopes.get(id);
    if (envelope) {
      root.remove(envelope);
      envelope.geometry.dispose();
      const material = envelope.material as THREE.Material;
      material.dispose();
      envelopes.delete(id);
    }
  }

  function addBox(item: PipBox): void {
    const geometry = new THREE.BoxGeometry(item.size[0], item.size[1], item.size[2]);
    disposables.push(geometry);
    const material = new THREE.MeshStandardMaterial({
      color: item.selected ? 0x35c7b3 : item.adapter ? 0xb9822a : 0x3f5a66,
      metalness: 0.25,
      roughness: 0.65,
      emissive: item.selected ? 0x0f4a44 : 0x000000,
      transparent: true,
      opacity: item.selected ? 0.98 : 0.9
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(item.center[0], item.center[1], item.center[2]);
    mesh.name = item.id;
    mesh.userData.nodeId = item.id;
    root.add(mesh);
    boxes.set(item.id, mesh);
    if (item.envelope[0] > item.size[0] + 1e-6) {
      const envelopeGeometry = new THREE.BoxGeometry(item.envelope[0], item.envelope[1], item.envelope[2]);
      disposables.push(envelopeGeometry);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(envelopeGeometry),
        new THREE.LineDashedMaterial({ color: 0xc0569a, dashSize: 0.01, gapSize: 0.008 })
      );
      edges.position.set(item.center[0] + (item.envelope[0] - item.size[0]) / 2, item.center[1], item.center[2]);
      edges.computeLineDistances();
      root.add(edges);
      envelopes.set(item.id, edges);
    }
  }


  function update(graph: MachineGraph, selectedId: string | null): void {
    // 增量接线（12.2 第二步，放在 pip3d 内部，workbench 不用改调用）：
    // 首次渲染 / 节点集合变化时全量重建；否则只重建几何变了的节点，
    // 选中变化只改材质；什么都没变时跳过。快照是克隆的，避免画布拖拽
    // 原地改 node.ortho 时上次快照也被改掉。
    if (!lastPipGraph || pipNodeIdsChanged(lastPipGraph, graph)) {
      clearRoot();
      const data = buildPipBoxes(graph, selectedId);
      for (const item of data) addBox(item);
      lastSelectedId = selectedId;
      lastPipGraph = snapshotPipGraph(graph);
      render();
      return;
    }
    const dirty = pipDirtyIds(lastPipGraph, graph);
    if (dirty.length === 0 && selectedId === lastSelectedId) return;
    updateIncremental(graph, selectedId, dirty);
    lastPipGraph = snapshotPipGraph(graph);
  }


  function updateIncremental(graph: MachineGraph, selectedId: string | null, dirtyIds: readonly string[]): void {
    if (boxes.size === 0) {
      clearRoot();
      const data = buildPipBoxes(graph, selectedId);
      for (const item of data) addBox(item);
      lastSelectedId = selectedId;
      render();
      return;
    }
    const data = buildPipBoxes(graph, selectedId);
    const byId = new Map(data.map((item) => [item.id, item]));
    for (const id of dirtyIds) {
      const item = byId.get(id);
      removeBox(id);
      if (item) addBox(item);
    }
    if (selectedId !== lastSelectedId) {
      // 选中变化：只改材质，不重建几何。转接板颜色在 addBox 时已按 adapter 定，
      // 这里不改未选中转接板的底色，只改 emissive/opacity，避免把橙色刷成灰色。
      const oldMesh = lastSelectedId ? boxes.get(lastSelectedId) : undefined;
      if (oldMesh) {
        const m = oldMesh.material as THREE.MeshStandardMaterial;
        m.emissive.setHex(0x000000);
        m.opacity = 0.9;
      }
      const newMesh = selectedId ? boxes.get(selectedId) : undefined;
      if (newMesh) {
        const m = newMesh.material as THREE.MeshStandardMaterial;
        m.color.setHex(0x35c7b3);
        m.emissive.setHex(0x0f4a44);
        m.opacity = 0.98;
      }
      lastSelectedId = selectedId;
    }
    render();
  }

  function focus(nodeId: string | null): void {
    if (!nodeId) {
      orbit.target.set(0.5, 0.25, 0.4);
      orbit.distance = 3.2;
      render();
      return;
    }
    const box = boxes.get(nodeId);
    if (!box) return;
    orbit.target.copy(box.position);
    orbit.distance = Math.max(0.6, Math.max(box.geometry.boundingSphere?.radius ?? 0.3, 0.3) * 4);
    render();
  }

  // 手写球坐标轨道：左键旋转、滚轮缩放。够用就不引 controls 依赖。
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  renderer.domElement.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture?.(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    orbit.yaw -= (event.clientX - lastX) * 0.008;
    orbit.pitch = Math.max(-1.2, Math.min(1.35, orbit.pitch + (event.clientY - lastY) * 0.006));
    lastX = event.clientX;
    lastY = event.clientY;
    render();
  });
  const stopDrag = (): void => {
    dragging = false;
  };
  renderer.domElement.addEventListener('pointerup', stopDrag);
  renderer.domElement.addEventListener('pointerleave', stopDrag);
  renderer.domElement.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      orbit.distance = Math.max(0.4, Math.min(40, orbit.distance * (event.deltaY > 0 ? 1.1 : 0.9)));
      render();
    },
    { passive: false }
  );

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  observer?.observe(host);
  resize();

  return {
    status: 'ready',
    reason: '',
    update,
    updateIncremental,
    focus,
    resetView: () => {
      orbit.yaw = -0.7;
      orbit.pitch = 0.55;
      orbit.distance = 3.2;
      orbit.target.set(0.5, 0.25, 0.4);
      render();
    },
    setWireframe: (wireframe: boolean) => {
      for (const material of materials) {
        if (material instanceof THREE.MeshStandardMaterial) material.wireframe = wireframe;
      }
      render();
    },
    dispose: () => {
      observer?.disconnect();
      clearRoot();
      renderer.dispose();
      host.replaceChildren();
    }
  };
}
