import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CLICK_SELECT_MAX_DISTANCE, clientPointToNdc, isClickSelect, isStaleDrag } from '../../src/orbit/pointer.ts';

test('僵死拖动判定：标记在拖动但无按下指针时需要自愈', () => {
  assert.equal(isStaleDrag(true, false), true);
  assert.equal(isStaleDrag(true, true), false);
  assert.equal(isStaleDrag(false, false), false);
  assert.equal(isStaleDrag(false, true), false);
});

test('点击选中判定：按下状态缺失或位移过大都不算点击', () => {
  const down = { x: 100, y: 100, button: 0 };
  assert.equal(isClickSelect(down, { clientX: 100, clientY: 100, button: 0 }), true);
  assert.equal(isClickSelect(down, { clientX: 102, clientY: 103, button: 0 }), true);
  // 超过阈值按拖拽处理，不选中
  assert.equal(isClickSelect(down, { clientX: 100 + CLICK_SELECT_MAX_DISTANCE + 1, clientY: 100, button: 0 }), false);
  // 回归：窗口级兜底监听曾把 down 提前清空 → 点击选中整体失效，而悬停高亮仍正常
  assert.equal(isClickSelect(null, { clientX: 100, clientY: 100, button: 0 }), false);
  // 非左键不选中
  assert.equal(isClickSelect({ x: 0, y: 0, button: 2 }, { clientX: 0, clientY: 0, button: 2 }), false);
  assert.equal(isClickSelect(down, { clientX: 100, clientY: 100, button: 2 }), false);
});

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
