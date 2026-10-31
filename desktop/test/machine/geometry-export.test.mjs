import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { generateMachineGeometry } from '../../src/machine/geometry.ts';
import {
  buildMachineSolids,
  geometryToGltf,
  geometryToSidecarAssemblies,
  geometryToStl,
  geometryTriangleCount,
  partLocalMesh,
  partSidecarFeatures
} from '../../src/machine/geometry-export.ts';
import { MAX_ASSEMBLY_CHUNK, compileOps, validateFeatures } from '../../src/parametric/features.ts';

const UPDATED_AT = '2026-10-24T01:00:00+08:00';

function geometryFor(brief = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服', options = {}) {
  return generateMachineGeometry(synthMachine(parseMachineBrief(brief), options));
}

test('导出 STL：二进制长度 = 84 + 50×三角形数，法向为单位向量，顶点包络 = 几何 bounds', () => {
  const geometry = geometryFor();
  const stl = geometryToStl(geometry);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const count = view.getUint32(80, true);
  assert.equal(count, geometryTriangleCount(geometry));
  assert.equal(stl.byteLength, 84 + 50 * count);
  assert.match(new TextDecoder().decode(stl.slice(0, 80)), /AutomationCAD machine-geometry design-screw-3st mm/);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t += 1) {
    const offset = 84 + t * 50;
    const n = [0, 1, 2].map((k) => view.getFloat32(offset + k * 4, true));
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-3, `第 ${t} 个三角形法向`);
    for (let v = 0; v < 3; v += 1) {
      for (let k = 0; k < 3; k += 1) {
        const value = view.getFloat32(offset + 12 + (v * 3 + k) * 4, true);
        min[k] = Math.min(min[k], value);
        max[k] = Math.max(max[k], value);
      }
    }
  }
  for (let k = 0; k < 3; k += 1) {
    // 圆柱按多边形近似，顶点只会落在 bounds 内侧。
    assert.ok(min[k] >= geometry.bounds.min[k] - 0.01 && max[k] <= geometry.bounds.max[k] + 0.01, `axis ${k}`);
  }
  // Z 由方形零件（地面立腿、门架）决定，必须精确。
  assert.ok(Math.abs(min[2] - geometry.bounds.min[2]) < 0.01);
  assert.ok(Math.abs(max[2] - geometry.bounds.max[2]) < 0.01);
});

test('导出网格：圆柱沿声明轴向，盒体 12 个三角形', () => {
  const box = partLocalMesh({ shape: { type: 'box', size: [10, 20, 30] } });
  assert.equal(box.positions.length / 9, 12);
  const cylinder = partLocalMesh({ shape: { type: 'cylinder', radius: 6, length: 45, axis: 'y' } }, 16);
  assert.equal(cylinder.positions.length / 9, 16 * 4);
  const extent = [0, 1, 2].map((k) => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = k; i < cylinder.positions.length; i += 3) {
      low = Math.min(low, cylinder.positions[i]);
      high = Math.max(high, cylinder.positions[i]);
    }
    return Math.round((high - low) * 1000) / 1000;
  });
  assert.deepEqual(extent, [12, 45, 12]);
});

test('导出 glTF：2.0、节点 = 零件 + 根、根节点 Z→Y 旋转、缓冲长度与 data URI 一致、extras 带运动轴', () => {
  const geometry = geometryFor();
  const gltf = geometryToGltf(geometry);
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.nodes.length, geometry.parts.length + 1);
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  assert.equal(root.children.length, geometry.parts.length);
  assert.ok(Math.abs(root.rotation[0] + Math.SQRT1_2) < 1e-9);
  assert.equal(root.extras.moving.length, geometry.moving.length);
  assert.deepEqual(root.extras.envelopeMm, geometry.envelope);
  const buffer = gltf.buffers[0];
  const decoded = Buffer.from(buffer.uri.split(',')[1], 'base64');
  assert.equal(decoded.byteLength, buffer.byteLength);
  for (const view of gltf.bufferViews) assert.ok(view.byteOffset + view.byteLength <= buffer.byteLength);
  for (const mesh of gltf.meshes) {
    const accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION];
    assert.equal(accessor.min.length, 3);
    assert.equal(accessor.count % 3, 0);
  }
  const names = gltf.nodes.slice(0, -1).map((node) => node.name);
  assert.deepEqual(names, geometry.parts.map((part) => part.id));
  const rod = gltf.nodes.find((node) => node.extras?.moving && node.name.endsWith('-table'));
  assert.ok(rod, '旋转台面应标记 moving');
  // 单位换算为米。
  const top = gltf.nodes.find((node) => node.name === 'frame-top');
  assert.equal(top.translation[2], 0.84);
});

test('sidecar 契约：分块 ≤ 50 实体、每块通过 validateFeatures、实体数 = 零件数、变换 = 零件中心', () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  assert.equal(bundle.instances, geometry.parts.length);
  assert.ok(bundle.chunks.length >= 3);
  const seen = new Set();
  for (const chunk of bundle.chunks) {
    assert.ok(chunk.instances.length <= MAX_ASSEMBLY_CHUNK);
    assert.equal(chunk.schemaVersion, 2);
    assert.deepEqual(validateFeatures(chunk), []);
    const compiled = compileOps(chunk);
    assert.equal(compiled.instances.length, chunk.instances.length);
    for (const instance of chunk.instances) {
      assert.ok(!seen.has(instance.id));
      seen.add(instance.id);
      const part = geometry.parts.find((item) => item.id === instance.id);
      assert.deepEqual([instance.transform.x, instance.transform.y, instance.transform.z, instance.transform.rz], [...part.center, part.rotationZDeg]);
    }
  }
  assert.equal(seen.size, geometry.parts.length);
  const small = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT, maxInstances: 10 });
  assert.equal(small.chunks.length, Math.ceil(geometry.parts.length / 10));
});

test('sidecar 契约：竖直圆柱 = 内接种子方块 + cylinder（精确），水平圆柱记为等截面方棒近似', () => {
  const vertical = partSidecarFeatures({ name: '台面', shape: { type: 'cylinder', radius: 70, length: 12, axis: 'z' } });
  assert.equal(vertical.approximated, false);
  assert.deepEqual(vertical.features.map((feature) => feature.type), ['box', 'cylinder']);
  const seed = vertical.features[0].params;
  assert.ok(Math.hypot(seed.length / 2, seed.width / 2) < 70, '种子方块必须完全落在圆柱内');
  assert.ok(seed.height <= 12);
  assert.deepEqual(vertical.features[1].params, { diameter: 140, height: 12, at: [0, 0, 0] });
  const horizontal = partSidecarFeatures({ name: '接近开关', shape: { type: 'cylinder', radius: 6, length: 45, axis: 'y' } });
  assert.equal(horizontal.approximated, true);
  const { length, width, height } = horizontal.features[0].params;
  assert.equal(width, 45);
  assert.ok(Math.abs(length * height - Math.PI * 36) < 0.05, '截面积相等');
  const geometry = geometryFor();
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  const horizontalIds = geometry.parts
    .filter((part) => part.shape.type === 'cylinder' && part.shape.axis !== 'z')
    .map((part) => part.id);
  assert.deepEqual(bundle.approximated, horizontalIds);
  assert.ok(horizontalIds.length > 0);
});

test('实体化：无内核回退 TS 网格；内核全部成功返回 STEP；任一块失败整体回退不冒充完整', async () => {
  const geometry = geometryFor('八工位锁螺丝机');
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: UPDATED_AT });
  const none = await buildMachineSolids(bundle, undefined);
  assert.equal(none.mode, 'mesh-fallback');
  assert.match(none.message, /回退/);

  const calls = [];
  const ok = await buildMachineSolids(bundle, async (doc) => {
    calls.push(doc.instances.length);
    return { ok: true, files: { step: { path: `/tmp/part-${calls.length}.step`, bytes: 10 } } };
  });
  assert.equal(ok.mode, 'solids');
  assert.equal(ok.built, bundle.chunks.length);
  assert.equal(ok.stepFiles.length, bundle.chunks.length);
  assert.equal(calls.reduce((sum, value) => sum + value, 0), geometry.parts.length);

  let call = 0;
  const failed = await buildMachineSolids(bundle, async () => {
    call += 1;
    if (call === 2) return { ok: false, code: 'UNAVAILABLE', message: '参数化建模内核未启动' };
    return { ok: true, files: { step: { path: '/tmp/a.step' } } };
  });
  assert.equal(failed.mode, 'mesh-fallback');
  assert.equal(failed.built, 1);
  assert.deepEqual(failed.stepFiles, []);
  assert.match(failed.message, /第 2\/\d+ 块实体化失败（参数化建模内核未启动）/);

  const thrown = await buildMachineSolids(bundle, async () => {
    throw new Error('连接被拒绝');
  });
  assert.equal(thrown.mode, 'mesh-fallback');
  assert.match(thrown.message, /连接被拒绝/);
});
