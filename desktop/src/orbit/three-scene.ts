/**
 * Assembly → three.js 场景对象。只用 three 核心（无渲染器 / DOM），可在 Node 单测中构建与检查。
 */
import * as THREE from 'three';
import type { Assembly, PartSpec, Prim } from './model.ts';
import type { InterferenceHit } from '../mech/interference.ts';

export interface HighlightState {
  selected: readonly string[];
  hover: string | null;
  /** 干涉校核视图当前问题零件（红色） */
  hit: string | null;
  /** 干涉视图：非问题零件半透明 */
  ghostOthers: boolean;
}

export const HIGHLIGHT_COLORS = {
  selected: 0x14b8a6,
  hover: 0x5eead4,
  hit: 0xf04438,
  edge: 0x1b1f23,
  edgeSelected: 0x2dd4bf,
  interference: 0xf04438,
  section: 0x4e9cf5
} as const;

const CYL_SEGMENTS = 40;

function primMesh(prim: Prim): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  const position = new THREE.Vector3();
  if (prim.type === 'box') {
    const sx = prim.max[0] - prim.min[0];
    const sy = prim.max[1] - prim.min[1];
    const sz = prim.max[2] - prim.min[2];
    geometry = new THREE.BoxGeometry(sx, sy, sz);
    position.set((prim.min[0] + prim.max[0]) / 2, (prim.min[1] + prim.max[1]) / 2, (prim.min[2] + prim.max[2]) / 2);
  } else {
    const height = prim.z1 - prim.z0;
    geometry = new THREE.CylinderGeometry(prim.r, prim.r, height, CYL_SEGMENTS);
    // three 的圆柱沿 Y 轴；装配体 Z 向上，旋到 Z。
    geometry.rotateX(Math.PI / 2);
    position.set(prim.center[0], prim.center[1], (prim.z0 + prim.z1) / 2);
  }
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(prim.color),
    metalness: 0.35,
    roughness: 0.55,
    emissive: new THREE.Color(0x000000)
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 30),
    new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLORS.edge, transparent: true, opacity: 0.85 })
  );
  edges.name = 'edges';
  edges.raycast = () => undefined;
  mesh.add(edges);
  return mesh;
}

/** 一个零件 = 一个 Group（userData.partId），子 Mesh 也带 partId 便于射线拾取。 */
export function buildPartGroup(part: PartSpec): THREE.Group {
  const group = new THREE.Group();
  group.name = `part:${part.id}`;
  group.userData.partId = part.id;
  group.userData.origin = part.origin;
  part.prims.forEach((prim) => {
    const mesh = primMesh(prim);
    mesh.userData.partId = part.id;
    mesh.userData.baseColor = prim.color;
    group.add(mesh);
  });
  return group;
}

export function buildAssemblyGroup(assembly: Assembly): THREE.Group {
  const root = new THREE.Group();
  root.name = 'proto-assembly';
  assembly.parts.forEach((part) => root.add(buildPartGroup(part)));
  return root;
}

export function partMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && typeof obj.userData.partId === 'string') out.push(obj as THREE.Mesh);
  });
  return out;
}

export function partIdOf(obj: THREE.Object3D | null | undefined): string | null {
  let cur: THREE.Object3D | null | undefined = obj;
  while (cur) {
    if (typeof cur.userData.partId === 'string') return cur.userData.partId as string;
    cur = cur.parent;
  }
  return null;
}

/** 把选中/悬停/干涉状态写到材质上（不重建网格）。返回每个零件的最终状态，便于测试。 */
export function applyHighlight(root: THREE.Object3D, state: HighlightState): Record<string, 'selected' | 'hover' | 'hit' | 'ghost' | 'normal'> {
  const result: Record<string, 'selected' | 'hover' | 'hit' | 'ghost' | 'normal'> = {};
  partMeshes(root).forEach((mesh) => {
    const id = mesh.userData.partId as string;
    const material = mesh.material as THREE.MeshStandardMaterial;
    let status: 'selected' | 'hover' | 'hit' | 'ghost' | 'normal' = 'normal';
    if (state.hit === id) status = 'hit';
    else if (state.ghostOthers) status = 'ghost';
    else if (state.selected.includes(id)) status = 'selected';
    else if (state.hover === id) status = 'hover';
    result[id] = status;

    const emissive = status === 'hit' ? HIGHLIGHT_COLORS.hit
      : status === 'selected' ? HIGHLIGHT_COLORS.selected
        : status === 'hover' ? HIGHLIGHT_COLORS.hover : 0x000000;
    material.emissive.setHex(emissive);
    material.emissiveIntensity = status === 'hit' ? 0.75 : status === 'selected' ? 0.55 : status === 'hover' ? 0.25 : 0;
    material.transparent = status === 'ghost';
    material.opacity = status === 'ghost' ? 0.28 : 1;
    material.depthWrite = status !== 'ghost';
    const edges = mesh.getObjectByName('edges') as THREE.LineSegments | undefined;
    if (edges) {
      const em = edges.material as THREE.LineBasicMaterial;
      em.color.setHex(status === 'selected' || status === 'hit' ? HIGHLIGHT_COLORS.edgeSelected : HIGHLIGHT_COLORS.edge);
      if (status === 'hit') em.color.setHex(HIGHLIGHT_COLORS.hit);
      em.opacity = status === 'ghost' ? 0.3 : 0.85;
    }
  });
  return result;
}

/** 干涉初筛结果 → 红色半透明重叠体。 */
export function buildInterferenceGroup(hits: readonly InterferenceHit[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'interference-overlay';
  hits.forEach((hit, index) => {
    const geometry = new THREE.BoxGeometry(
      Math.max(hit.overlap[0], 0.5), Math.max(hit.overlap[1], 0.5), Math.max(hit.overlap[2], 0.5)
    );
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLORS.interference, transparent: true, opacity: 0.35, depthTest: false
    }));
    mesh.position.set(hit.center[0], hit.center[1], hit.center[2]);
    mesh.renderOrder = 30;
    mesh.name = `hit:${index}:${hit.a}|${hit.b}`;
    mesh.raycast = () => undefined;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLORS.interference, depthTest: false })
    );
    edges.renderOrder = 31;
    edges.raycast = () => undefined;
    mesh.add(edges);
    group.add(mesh);
  });
  return group;
}

/** 剖切面示意（与原型一样立在气缸中心线 X 处）。 */
export function buildSectionPlane(x: number, bounds: Assembly['bounds']): THREE.Mesh {
  const sizeY = (bounds.max[1] - bounds.min[1]) * 1.25 + 20;
  const sizeZ = (bounds.max[2] - bounds.min[2]) * 1.15 + 20;
  const geometry = new THREE.PlaneGeometry(sizeY, sizeZ);
  geometry.rotateY(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color: HIGHLIGHT_COLORS.section, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false
  }));
  mesh.position.set(x, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2 + 4);
  mesh.name = 'section-plane';
  mesh.raycast = () => undefined;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLORS.section, transparent: true, opacity: 0.55 })
  );
  edges.raycast = () => undefined;
  mesh.add(edges);
  return mesh;
}

/** 释放一棵子树的几何与材质。 */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const withGeo = obj as THREE.Mesh;
    if (withGeo.geometry) withGeo.geometry.dispose();
    const material = (withGeo as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}
