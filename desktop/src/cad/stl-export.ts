// 网格 → 二进制 STL（导入模型"存为工程"用）
//
// 纯数值实现，不依赖 three：调用方把 BufferGeometry 的 position/index 摊平成数组传进来，
// 便于 node --test 直接验证字节结构；three 只在 viewer 里取属性。

/** 三角形法线（右手定则），长度为 0 时退化成 (0,0,1)，避免 NaN 写进 STL。 */
export function triangleNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number
): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!Number.isFinite(len) || len === 0) return [0, 0, 1];
  return [nx / len, ny / len, nz / len];
}

/**
 * positions: 每 3 个 float 一个顶点（xyz），长度必须能被 3 整除。
 * indices: 可为 null（非索引几何，按顺序每 3 个顶点一个三角形）或 32 位索引数组。
 * 返回 84 + 50*三角形数 字节的二进制 STL；三角形数为 0 时返回 null（不生成空 STL）。
 */
export function geometryToBinaryStl(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null,
  header = 'cad-import mesh (uploaded model)'
): Uint8Array | null {
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertexCount / 3);
  if (triCount <= 0) return null;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  for (let i = 0; i < 80; i += 1) view.setUint8(i, i < header.length ? header.charCodeAt(i) & 0x7f : 32);
  view.setUint32(80, triCount, true);
  let offset = 84;
  for (let t = 0; t < triCount; t += 1) {
    const i0 = indices ? (indices[t * 3] ?? 0) : t * 3;
    const i1 = indices ? (indices[t * 3 + 1] ?? 0) : t * 3 + 1;
    const i2 = indices ? (indices[t * 3 + 2] ?? 0) : t * 3 + 2;
    const ax = positions[i0 * 3] ?? 0, ay = positions[i0 * 3 + 1] ?? 0, az = positions[i0 * 3 + 2] ?? 0;
    const bx = positions[i1 * 3] ?? 0, by = positions[i1 * 3 + 1] ?? 0, bz = positions[i1 * 3 + 2] ?? 0;
    const cx = positions[i2 * 3] ?? 0, cy = positions[i2 * 3 + 1] ?? 0, cz = positions[i2 * 3 + 2] ?? 0;
    const [nx, ny, nz] = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    const verts = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let i = 0; i < 9; i += 1) view.setFloat32(offset + i * 4, verts[i] ?? 0, true);
    offset += 36;
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/** 包络（mm）：接收 {min,max} 数组，返回 [宽, 深, 高]；空集返回 null。 */
export function unionEnvelope(
  boxes: Array<{ min: [number, number, number]; max: [number, number, number] }>
): [number, number, number] | null {
  if (boxes.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, box.min[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, box.max[axis] ?? 0);
    }
  }
  const round = (value: number): number => Math.round(value * 10) / 10;
  return [round((max[0] ?? 0) - (min[0] ?? 0)), round((max[1] ?? 0) - (min[1] ?? 0)), round((max[2] ?? 0) - (min[2] ?? 0))];
}

/** 零件名去重（同名零件加 -2/-3），用于 partsList 与磁盘文件名。 */
export function uniquePartNames(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw) => {
    const base = (raw || '零件').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}
