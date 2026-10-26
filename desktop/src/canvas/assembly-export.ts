// 画布方案 → 整机 3D 装配（示意体）
//
// 目的：把画布上的工位拓扑变成软件自己能打开的三维工程，不再依赖外部脚本手写 project.json。
//
// 诚实边界（很重要，界面与导出都要写）：
//   - 每个工位按 dimsMm 生成一个**长方体示意体**，只表达占位/包络/相对位置，不是真实结构；
//   - 没有孔、没有导轨、没有皮带；不能下料、不能做装配干涉判定（AABB 只能初筛）；
//   - 质量不给（null），因为示意体不等于实物，按体积×密度算出来的数字没有工程意义。
//
// 坐标：画布 ortho.x/y 向下为正、单位 mm；三维取地面 Z=0，盒体中心 z = h/2，
//       x 取 ortho.x、y 取 -ortho.y（画布 Y 向下 → 三维 Y 向前），保证俯视图与画布一致。
import type { MachineGraph } from './types.ts';

export interface AssemblyBox {
  name: string;
  /** 盒体尺寸 mm（X/Y/Z）。 */
  sizeMm: [number, number, number];
  /** 盒体中心 mm（三维坐标，地面 Z=0）。 */
  centerMm: [number, number, number];
  nodeId: string;
  kind: string;
}

export interface AssemblyProjectDraft {
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: null;
  envelope: [number, number, number];
  material: string[];
  partData: Array<{ name: string; data: Uint8Array }>;
  /** 生成说明，写进工程 params 之外的提示（UI toast 用）。 */
  note: string;
}

const MAX_PARTS = 200;

/** 工位类别 → 零件名前缀（结构树按前缀分组，一眼看出这是哪类工位）。 */
const KIND_LABEL: Record<string, string> = {
  linear: '直线',
  actuator: '执行',
  gripper: '夹爪',
  vision: '视觉',
  indexer: '分度',
  frame: '机架',
  adapter: '转接板'
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? '工位';
}

/** 非 adapter 节点 → 示意盒；adapter 也生成薄板盒（厚度取 dimsMm[2]，最薄 6mm）。 */
export function assemblyBoxes(graph: MachineGraph): AssemblyBox[] {
  const boxes: AssemblyBox[] = [];
  for (const node of graph.nodes) {
    const [w, d, h] = node.dimsMm;
    const width = Number.isFinite(w) && w > 0 ? w : 0;
    const depth = Number.isFinite(d) && d > 0 ? d : 0;
    const height = Number.isFinite(h) && h > 0 ? h : 0;
    if (width <= 0 || depth <= 0 || height <= 0) continue;
    const x = Number.isFinite(node.ortho?.x) ? node.ortho.x : 0;
    // 画布 Y 向下 → 三维 Y 取反；-0 归一成 0，避免深比较/显示出现「-0」
    const rawY = Number.isFinite(node.ortho?.y) ? -node.ortho.y : 0;
    const y = rawY === 0 ? 0 : rawY;
    boxes.push({
      name: `${kindLabel(node.kind)}·${node.name}`,
      sizeMm: [width, depth, height],
      centerMm: [x, y, height / 2],
      nodeId: node.id,
      kind: node.kind
    });
    if (boxes.length >= MAX_PARTS) break;
  }
  return boxes;
}

/** 包络（含所有盒体），返回 [宽, 深, 高]。 */
export function assemblyEnvelope(boxes: AssemblyBox[]): [number, number, number] {
  if (boxes.length === 0) return [0, 0, 0];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const box of boxes) {
    const [w, d, h] = box.sizeMm;
    const [cx, cy, cz] = box.centerMm;
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - d / 2);
    maxY = Math.max(maxY, cy + d / 2);
    maxZ = Math.max(maxZ, cz + h / 2);
  }
  return [round1(maxX - minX), round1(maxY - minY), round1(Math.max(0, maxZ))];
}

/** 12 个三角形（每个 3 顶点）构成一个轴对齐长方体。 */
function boxTriangles(size: [number, number, number], center: [number, number, number]): number[][] {
  const [w, d, h] = size;
  const [cx, cy, cz] = center;
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - d / 2, y1 = cy + d / 2;
  const z0 = cz - h / 2, z1 = cz + h / 2;
  const v = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1]
  };
  const faces = [
    [v.a, v.c, v.b], [v.a, v.d, v.c], // 底
    [v.e, v.f, v.g], [v.e, v.g, v.h], // 顶
    [v.a, v.b, v.f], [v.a, v.f, v.e], // 前
    [v.b, v.c, v.g], [v.b, v.g, v.f], // 右
    [v.c, v.d, v.h], [v.c, v.h, v.g], // 后
    [v.d, v.a, v.e], [v.d, v.e, v.h]  // 左
  ];
  return faces.map((face) => face.flat());
}

function normalOf(tri: number[]): [number, number, number] {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri as [number, number, number, number, number, number, number, number, number];
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** 二进制 STL（84 字节头 + 50 字节/三角形）。纯函数，便于单测。 */
export function boxStl(size: [number, number, number], center: [number, number, number]): Uint8Array {
  const tris = boxTriangles(size, center);
  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buffer);
  // STL 头只放 ASCII（中文会被 setUint8 截断成乱码）；示意体说明同时写在工程记录与 UI 里
  const header = 'canvas-assembly-box placeholder (schematic, not real geometry)';
  for (let i = 0; i < 80; i += 1) view.setUint8(i, i < header.length ? header.charCodeAt(i) : 32);
  view.setUint32(80, tris.length, true);
  let offset = 84;
  for (const tri of tris) {
    const [nx, ny, nz] = normalOf(tri);
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (let i = 0; i < 9; i += 1) {
      view.setFloat32(offset + i * 4, tri[i] ?? 0, true);
    }
    offset += 36;
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/** 组装成可直接交给 projects.save 的工程载荷；没有节点返回 null（UI 提示空画布）。 */
export function buildAssemblyProject(graph: MachineGraph, title?: string): AssemblyProjectDraft | null {
  const boxes = assemblyBoxes(graph);
  if (boxes.length === 0) return null;
  const used = new Set<string>();
  const partData = boxes.map((box) => {
    let name = safeName(box.name);
    let n = 2;
    while (used.has(name)) {
      name = `${safeName(box.name)}-${n}`;
      n += 1;
    }
    used.add(name);
    return { name, data: boxStl(box.sizeMm, box.centerMm) };
  });
  const envelope = assemblyEnvelope(boxes);
  const name = (title?.trim() || graph.title || '画布方案').slice(0, 40);
  return {
    name: `${name}（示意装配）`,
    process: 'canvas-assembly',
    params: {
      stations: boxes.length,
      envelopeXmm: envelope[0],
      envelopeYmm: envelope[1],
      envelopeZmm: envelope[2]
    },
    parts: partData.length,
    massKg: null,
    envelope,
    material: ['示意体（占位盒）'],
    partData,
    note: `${partData.length} 个工位示意体，包络 ${envelope[0]}×${envelope[1]}×${envelope[2]}mm；只表达占位与相对位置，不含真实结构`
  };
}
