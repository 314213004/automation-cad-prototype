import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { clientPointToNdc } from '../../src/orbit/pointer.ts';

test('zoom=1.15：点击 getBoundingClientRect 中心仍命中视口中心的零件', () => {
  // 布局尺寸 800×600，CSS zoom 1.15 后 rect 是 920×690，不能用 clientWidth 直接除。
  const rect = { left: 100, top: 50, width: 800 * 1.15, height: 600 * 1.15 };
  const ndc = clientPointToNdc(rect.left + rect.width / 2, rect.top + rect.height / 2, rect);
  assert.ok(ndc);
  assert.ok(Math.abs(ndc.x) < 1e-12 && Math.abs(ndc.y) < 1e-12);

  const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const part = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  part.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  assert.equal(raycaster.intersectObject(part, false).length, 1);
  assert.equal(clientPointToNdc(0, 0, { left: 0, top: 0, width: 0, height: 10 }), null);
});
