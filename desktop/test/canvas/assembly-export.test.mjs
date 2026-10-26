import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assemblyBoxes,
  assemblyEnvelope,
  boxStl,
  buildAssemblyProject
} from '../../src/canvas/assembly-export.ts';

const port = (family = 'PLATE45') => ({ family, holeDiaMm: 4.5, pitchXMm: 32, pitchYMm: 32, count: 4 });
function node(id, name, dims, x, y, kind = 'linear') {
  return {
    id, name, kind,
    dimsMm: dims,
    massKg: 10,
    portsOut: [port()],
    portsIn: [port()],
    ortho: { x, y },
    origin: { x: 0, y: 0 },
    stepSec: 1,
    notes: ''
  };
}
function graph(nodes) {
  return { schemeId: 's', title: '测试方案', layout: 'linear', transferSeconds: 0.2, nodes, edges: [] };
}

test('assemblyBoxes：按 dimsMm 生成盒体，Z 落地面（中心 = 高/2）', () => {
  const boxes = assemblyBoxes(graph([
    node('A', '入料检测段', [1800, 1400, 900], 0, 0),
    node('B', '堆叠工位', [1500, 1400, 1800], 1900, 0)
  ]));
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0].sizeMm, [1800, 1400, 900]);
  assert.deepEqual(boxes[0].centerMm, [0, 0, 450], '底部贴地');
  assert.deepEqual(boxes[1].centerMm, [1900, 0, 900]);
});

test('assemblyBoxes：画布 Y 向下 → 三维 Y 取反，俯视位置不发散', () => {
  const [box] = assemblyBoxes(graph([node('A', '件', [100, 100, 100], 500, 300)]));
  assert.deepEqual(box.centerMm, [500, -300, 50]);
});

test('assemblyBoxes：尺寸非法（0/负/NaN）跳过，不生成 0 厚零件', () => {
  const boxes = assemblyBoxes(graph([
    node('A', '坏的', [0, 100, 100], 0, 0),
    node('B', '也坏', [100, -1, 100], 0, 0),
    node('C', '好', [100, 100, 100], 0, 0)
  ]));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].nodeId, 'C');
});

test('assemblyEnvelope：包络覆盖所有盒体，含运动后的位置', () => {
  const boxes = assemblyBoxes(graph([
    node('A', 'a', [1000, 1400, 900], 0, 0),
    node('B', 'b', [1000, 1400, 1800], 3000, 0)
  ]));
  assert.deepEqual(assemblyEnvelope(boxes), [4000, 1400, 1800]);
});

test('boxStl：二进制 STL 结构正确（12 三角形 / 684 字节 / 法线单位长）', () => {
  const stl = boxStl([10, 20, 30], [0, 0, 15]);
  assert.equal(stl.byteLength, 84 + 12 * 50);
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert.equal(view.getUint32(80, true), 12, '三角形数写在 80 字节处');
  const nx = view.getFloat32(84, true), ny = view.getFloat32(88, true), nz = view.getFloat32(92, true);
  assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5, '法线归一化');
  // 顶点范围应等于盒体尺寸
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < 12; i += 1) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v += 1) {
      const x = view.getFloat32(base + v * 12, true);
      const z = view.getFloat32(base + v * 12 + 8, true);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  assert.equal(maxX - minX, 10);
  assert.equal(maxZ - minZ, 30);
});

test('boxStl：头顶 80 字节带示意体说明，避免被当真实几何', () => {
  const stl = boxStl([1, 1, 1], [0, 0, 0.5]);
  const header = Buffer.from(stl.buffer, stl.byteOffset, 80).toString('utf8');
  assert.match(header, /placeholder \(schematic, not real geometry\)/);
});

test('buildAssemblyProject：件数/包络/质量口径正确，重名自动去重', () => {
  const draft = buildAssemblyProject(graph([
    node('A', '工位', [100, 100, 100], 0, 0),
    node('B', '工位', [100, 100, 100], 500, 0)
  ]), '缓存线');
  assert.ok(draft);
  assert.equal(draft.parts, 2);
  assert.equal(draft.massKg, null, '示意体不给质量');
  assert.deepEqual(draft.envelope, [600, 100, 100]);
  assert.deepEqual(draft.partData.map((p) => p.name), ['直线·工位', '直线·工位-2']);
  assert.match(draft.name, /缓存线（示意装配）/);
  assert.match(draft.note, /只表达占位与相对位置/);
});

test('buildAssemblyProject：空画布返回 null（UI 提示，不生成空工程）', () => {
  assert.equal(buildAssemblyProject(graph([])), null);
});
