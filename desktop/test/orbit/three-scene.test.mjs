import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { applyParamEdit, buildAssembly } from '../../src/orbit/model.ts';
import {
  HIGHLIGHT_COLORS,
  applyHighlight,
  buildAssemblyGroup,
  buildInterferenceGroup,
  buildSectionPlane,
  partIdOf,
  partMeshes
} from '../../src/orbit/three-scene.ts';
import { detectInterferences } from '../../src/mech/interference.ts';

const INPUTS = { bore: 32, stroke: 50, inserted: [{ id: 'ins1', x: 4, y: 2, z: 8, w: 20, d: 20, h: 20 }], overrides: {} };

function worldBox(root, id) {
  const group = root.children.find((c) => c.userData.partId === id);
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  group.children.forEach((mesh) => {
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('three 场景：每零件一个 Group，网格世界包围盒与模型 bbox 一致（圆柱沿 Z）', () => {
  const asm = buildAssembly(INPUTS);
  const root = buildAssemblyGroup(asm);
  assert.equal(root.children.length, 7);
  assert.equal(partMeshes(root).length, 9, '底板1+导轨1+滑台1+气缸3+杆1+开关1+插入1');
  for (const part of asm.parts) {
    const box = worldBox(root, part.id);
    [0, 1, 2].forEach((axis) => {
      near(box.min.getComponent(axis), part.bbox.min[axis], 1e-4);
      near(box.max.getComponent(axis), part.bbox.max[axis], 1e-4);
    });
  }
});

test('属性编辑 → three 网格：底板加厚 4 mm 后重建，导轨网格整体上移 4 mm', () => {
  const before = worldBox(buildAssemblyGroup(buildAssembly(INPUTS)), 'rail');
  const edited = applyParamEdit(INPUTS, 'base', 'thickness', 12);
  assert.equal(edited.ok, true);
  const after = worldBox(buildAssemblyGroup(buildAssembly({ ...INPUTS, overrides: edited.overrides })), 'rail');
  near(after.min.z - before.min.z, 4);
  near(after.max.z - before.max.z, 4);
});

test('高亮：选中/悬停/干涉命中/幽灵态写入材质，不重建网格', () => {
  const root = buildAssemblyGroup(buildAssembly(INPUTS));
  const meshCount = partMeshes(root).length;
  const status = applyHighlight(root, { selected: ['cyl', 'rod'], hover: 'base', hit: null, ghostOthers: false });
  assert.equal(status.cyl, 'selected');
  assert.equal(status.rod, 'selected');
  assert.equal(status.base, 'hover');
  assert.equal(status.rail, 'normal');
  const cylMesh = partMeshes(root).find((m) => m.userData.partId === 'cyl');
  assert.equal(cylMesh.material.emissive.getHex(), HIGHLIGHT_COLORS.selected);
  const check = applyHighlight(root, { selected: [], hover: null, hit: 'sensor', ghostOthers: true });
  assert.equal(check.sensor, 'hit');
  assert.equal(check.base, 'ghost');
  const baseMesh = partMeshes(root).find((m) => m.userData.partId === 'base');
  assert.equal(baseMesh.material.transparent, true);
  assert.ok(baseMesh.material.opacity < 0.5);
  applyHighlight(root, { selected: [], hover: null, hit: null, ghostOthers: false });
  assert.equal(baseMesh.material.transparent, false);
  assert.equal(cylMesh.material.emissive.getHex(), 0);
  assert.equal(partMeshes(root).length, meshCount);
});

test('拾取映射：射线命中子网格 / 边线可回溯到零件 id', () => {
  const root = buildAssemblyGroup(buildAssembly(INPUTS));
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(92, 36, 500), new THREE.Vector3(0, 0, -1));
  const hits = ray.intersectObjects(partMeshes(root), false);
  assert.equal(partIdOf(hits[0].object), 'rod', '从正上方看到的第一个零件是活塞杆');
  const edges = partMeshes(root)[0].getObjectByName('edges');
  assert.equal(partIdOf(edges), partMeshes(root)[0].userData.partId);
  assert.equal(partIdOf(null), null);
});

test('干涉叠加层与剖切面：重叠体位置/尺寸来自 detectInterferences', () => {
  const asm = buildAssembly({ ...INPUTS, inserted: [{ id: 'ins1', x: 80, y: 30, z: 30, w: 20, d: 20, h: 20 }] });
  const hits = detectInterferences(asm.parts.map((p) => ({ name: p.id, bbox: p.bbox })));
  assert.ok(hits.some((h) => [h.a, h.b].includes('ins1')), '插入件压进滑台应被初筛出来');
  const overlay = buildInterferenceGroup(hits);
  assert.equal(overlay.children.length, hits.length);
  near(overlay.children[0].position.x, hits[0].center[0]);
  const plane = buildSectionPlane(asm.sectionX, asm.bounds);
  near(plane.position.x, 92);
  assert.equal(buildInterferenceGroup([]).children.length, 0);
});
