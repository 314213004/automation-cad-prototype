/**
 * DXF → 线段。只做「看图」需要的几何：LINE / LWPOLYLINE / POLYLINE / ARC / CIRCLE /
 * ELLIPSE / SPLINE（按控制点折线近似）/ INSERT（递归展开块）。
 *
 * 文字、标注、填充、图案不转几何，只在统计里报数量——避免假装「完整支持 DWG」。
 * 坐标保持 DXF 的 XY 平面（Z 取实体的 elevation，默认 0）。
 */

export interface DxfSegment {
  /** [x1, y1, z1, x2, y2, z2] */
  points: [number, number, number, number, number, number];
  layer: string;
}

export interface DxfStats {
  lines: number;
  arcs: number;
  circles: number;
  polylines: number;
  splines: number;
  inserts: number;
  skippedText: number;
  skippedDimension: number;
  skippedHatch: number;
  /** 圆弧/样条被折线近似时累加的分段数 */
  tessellated: number;
}

export interface DxfDrawing {
  segments: DxfSegment[];
  layers: Array<{ name: string; segments: number }>;
  stats: DxfStats;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

interface DxfEntity {
  type: string;
  values: Array<[number, string]>;
}

type Pairs = Array<[number, string]>;

/** DXF 是「组码 / 值」两行一对的纯文本 */
export function parseDxfPairs(text: string): Pairs {
  const lines = text.split(/\r\n|\n|\r/);
  const pairs: Pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeLine = lines[i] ?? '';
    const valueLine = lines[i + 1] ?? '';
    const code = Number(codeLine.trim());
    if (!Number.isFinite(code)) continue;
    pairs.push([code, valueLine]);
  }
  return pairs;
}

function num(entity: DxfEntity, code: number, fallback = 0): number {
  const found = entity.values.find(([c]) => c === code);
  if (!found) return fallback;
  const value = Number(found[1].trim());
  return Number.isFinite(value) ? value : fallback;
}

function str(entity: DxfEntity, code: number, fallback = ''): string {
  const found = entity.values.find(([c]) => c === code);
  return found ? found[1].trim() : fallback;
}

/** 把一个区段（ENTITIES / BLOCKS 里的一段）切成实体 */
function splitEntities(pairs: Pairs): DxfEntity[] {
  const entities: DxfEntity[] = [];
  let current: DxfEntity | null = null;
  for (const [code, raw] of pairs) {
    if (code === 0) {
      if (current) entities.push(current);
      current = { type: raw.trim().toUpperCase(), values: [] };
      continue;
    }
    if (current) current.values.push([code, raw]);
  }
  if (current) entities.push(current);
  return entities;
}

interface Section {
  name: string;
  entities: DxfEntity[];
}

function splitSections(pairs: Pairs): Section[] {
  const sections: Section[] = [];
  let current: { name: string; pairs: Pairs } | null = null;
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (!pair) continue;
    const [code, value] = pair;
    const upper = value.trim().toUpperCase();
    if (code === 0 && upper === 'SECTION') {
      const namePair = pairs[i + 1];
      current = { name: namePair && namePair[0] === 2 ? namePair[1].trim().toUpperCase() : '', pairs: [] };
      i += 1;
      continue;
    }
    if (code === 0 && upper === 'ENDSEC') {
      if (current) sections.push({ name: current.name, entities: splitEntities(current.pairs) });
      current = null;
      continue;
    }
    if (current) current.pairs.push([code, value]);
  }
  return sections;
}

/**
 * 2D 仿射矩阵：x' = a·x + b·y + e，y' = c·x + d·y + f，z' = z + dz。
 * 嵌套 INSERT 必须用矩阵相乘，否则旋转/缩放的平移量会被算错（实测能把坐标放大到百万级）。
 */
interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  dz: number;
}

const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, dz: 0 };

/** parent ∘ child（先在 child 里放，再经 parent 变换） */
function compose(parent: Transform, child: Transform): Transform {
  return {
    a: parent.a * child.a + parent.b * child.c,
    b: parent.a * child.b + parent.b * child.d,
    c: parent.c * child.a + parent.d * child.c,
    d: parent.c * child.b + parent.d * child.d,
    e: parent.a * child.e + parent.b * child.f + parent.e,
    f: parent.c * child.e + parent.d * child.f + parent.f,
    dz: parent.dz + child.dz
  };
}

/** INSERT 自身的局部变换：平移 + 旋转 + 缩放 */
function insertTransform(ins: DxfEntity): Transform {
  const cos = Math.cos((num(ins, 50) * Math.PI) / 180);
  const sin = Math.sin((num(ins, 50) * Math.PI) / 180);
  const sx = num(ins, 41, 1) || 1;
  const sy = num(ins, 42, 1) || 1;
  return {
    a: cos * sx,
    b: -sin * sy,
    c: sin * sx,
    d: cos * sy,
    e: num(ins, 10),
    f: num(ins, 20),
    dz: num(ins, 30)
  };
}

function apply(point: [number, number, number], t: Transform): [number, number, number] {
  return [t.a * point[0] + t.b * point[1] + t.e, t.c * point[0] + t.d * point[1] + t.f, point[2] + t.dz];
}

function circlesToSegments(cx: number, cy: number, cz: number, radius: number, startAngle: number, endAngle: number): Array<[number, number, number, number, number, number]> {
  const sweep = Math.abs(endAngle - startAngle);
  const steps = Math.max(8, Math.min(180, Math.ceil((sweep / (Math.PI * 2)) * 72)));
  const out: Array<[number, number, number, number, number, number]> = [];
  let prev: [number, number, number] = [
    cx + radius * Math.cos(startAngle),
    cy + radius * Math.sin(startAngle),
    cz
  ];
  for (let i = 1; i <= steps; i += 1) {
    const angle = startAngle + ((endAngle - startAngle) * i) / steps;
    const next: [number, number, number] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), cz];
    out.push([prev[0], prev[1], prev[2], next[0], next[1], next[2]]);
    prev = next;
  }
  return out;
}

interface CollectContext {
  segments: DxfSegment[];
  stats: DxfStats;
  blocks: Map<string, DxfEntity[]>;
  layerCounts: Map<string, number>;
}

function push(ctx: CollectContext, points: [number, number, number, number, number, number], layer: string, transform: Transform): void {
  const a = apply([points[0], points[1], points[2]], transform);
  const b = apply([points[3], points[4], points[5]], transform);
  ctx.segments.push({ points: [a[0], a[1], a[2], b[0], b[1], b[2]], layer });
  ctx.layerCounts.set(layer, (ctx.layerCounts.get(layer) ?? 0) + 1);
}

function collect(entities: DxfEntity[], ctx: CollectContext, transform: Transform, depth: number): void {
  for (const entity of entities) {
    const layer = str(entity, 8, '0');
    switch (entity.type) {
      case 'LINE': {
        push(ctx, [num(entity, 10), num(entity, 20), num(entity, 30), num(entity, 11), num(entity, 21), num(entity, 31)], layer, transform);
        ctx.stats.lines += 1;
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const xs = entity.values.filter(([c]) => c === 10).map(([, v]) => Number(v));
        const ys = entity.values.filter(([c]) => c === 20).map(([, v]) => Number(v));
        const closed = (num(entity, 70) & 1) === 1;
        const z = num(entity, 30);
        const at = (index: number): [number, number] => [xs[index] ?? 0, ys[index] ?? 0];
        for (let i = 0; i + 1 < xs.length; i += 1) {
          const a = at(i);
          const b = at(i + 1);
          push(ctx, [a[0], a[1], z, b[0], b[1], z], layer, transform);
        }
        if (closed && xs.length > 2) {
          const last = at(xs.length - 1);
          const first = at(0);
          push(ctx, [last[0], last[1], z, first[0], first[1], z], layer, transform);
        }
        ctx.stats.polylines += 1;
        break;
      }
      case 'VERTEX': {
        // POLYLINE 的顶点由外层处理；独立 VERTEX 常见于 POLYLINE 之后，这里忽略。
        break;
      }
      case 'ARC': {
        const start = (num(entity, 50) * Math.PI) / 180;
        const end = (num(entity, 51) * Math.PI) / 180;
        const cz = num(entity, 30);
        const segments = circlesToSegments(num(entity, 10), num(entity, 20), cz, num(entity, 40), start, end);
        ctx.stats.tessellated += segments.length;
        for (const segment of segments) push(ctx, segment, layer, transform);
        ctx.stats.arcs += 1;
        break;
      }
      case 'CIRCLE': {
        const segments = circlesToSegments(num(entity, 10), num(entity, 20), num(entity, 30), num(entity, 40), 0, Math.PI * 2);
        ctx.stats.tessellated += segments.length;
        for (const segment of segments) push(ctx, segment, layer, transform);
        ctx.stats.circles += 1;
        break;
      }
      case 'ELLIPSE': {
        const cx = num(entity, 10);
        const cy = num(entity, 20);
        const cz = num(entity, 30);
        const rx = num(entity, 11);
        const ry = num(entity, 21);
        const ratio = num(entity, 40, 1);
        const start = num(entity, 41, 0);
        const end = num(entity, 42, Math.PI * 2);
        const steps = 72;
        const radius = Math.hypot(rx, ry);
        const segments: Array<[number, number, number, number, number, number]> = [];
        let prev: [number, number, number] = [cx + radius * Math.cos(start), cy + radius * ratio * Math.sin(start), cz];
        for (let i = 1; i <= steps; i += 1) {
          const angle = start + ((end - start) * i) / steps;
          const next: [number, number, number] = [cx + radius * Math.cos(angle), cy + radius * ratio * Math.sin(angle), cz];
          segments.push([prev[0], prev[1], prev[2], next[0], next[1], next[2]]);
          prev = next;
        }
        ctx.stats.tessellated += segments.length;
        for (const segment of segments) push(ctx, segment, layer, transform);
        break;
      }
      case 'SPLINE': {
        const xs = entity.values.filter(([c]) => c === 10).map(([, v]) => Number(v));
        const ys = entity.values.filter(([c]) => c === 20).map(([, v]) => Number(v));
        // 控制点直接连折线：形状够用，不做 B 样条求值
        for (let i = 0; i + 1 < xs.length; i += 1) {
          push(ctx, [xs[i] ?? 0, ys[i] ?? 0, 0, xs[i + 1] ?? 0, ys[i + 1] ?? 0, 0], layer, transform);
        }
        ctx.stats.splines += 1;
        break;
      }
      case 'INSERT': {
        ctx.stats.inserts += 1;
        if (depth >= 6) break;
        const name = str(entity, 2);
        const block = ctx.blocks.get(name);
        if (!block) break;
        collect(block, ctx, compose(transform, insertTransform(entity)), depth + 1);
        break;
      }
      case 'TEXT':
      case 'MTEXT':
        ctx.stats.skippedText += 1;
        break;
      case 'DIMENSION':
        ctx.stats.skippedDimension += 1;
        break;
      case 'HATCH':
        ctx.stats.skippedHatch += 1;
        break;
      default:
        break;
    }
  }
}

export function parseDxf(text: string): DxfDrawing {
  const pairs = parseDxfPairs(text);
  const sections = splitSections(pairs);
  const blocks = new Map<string, DxfEntity[]>();
  for (const section of sections) {
    if (section.name !== 'BLOCKS') continue;
    // BLOCKS 段里 0=BLOCK 开始、0=ENDBLK 结束，中间是该块实体
    let name = '';
    let bucket: DxfEntity[] | null = null;
    for (const entity of section.entities) {
      if (entity.type === 'BLOCK') {
        name = str(entity, 2);
        bucket = [];
        continue;
      }
      if (entity.type === 'ENDBLK') {
        if (bucket && name) blocks.set(name, bucket);
        bucket = null;
        name = '';
        continue;
      }
      if (bucket) bucket.push(entity);
    }
  }
  const ctx: CollectContext = {
    segments: [],
    blocks,
    layerCounts: new Map(),
    stats: {
      lines: 0, arcs: 0, circles: 0, polylines: 0, splines: 0, inserts: 0,
      skippedText: 0, skippedDimension: 0, skippedHatch: 0, tessellated: 0
    }
  };
  for (const section of sections) {
    if (section.name !== 'ENTITIES') continue;
    collect(section.entities, ctx, IDENTITY, 0);
  }
  const bounds = boundsOf(ctx.segments);
  return {
    segments: ctx.segments,
    stats: ctx.stats,
    bounds,
    layers: [...ctx.layerCounts.entries()]
      .map(([name, segments]) => ({ name, segments }))
      .sort((a, b) => b.segments - a.segments)
  };
}

function boundsOf(segments: DxfSegment[]): DxfDrawing['bounds'] {
  if (segments.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const segment of segments) {
    for (let i = 0; i < 3; i += 1) {
      const a = segment.points[i] ?? 0;
      const b = segment.points[i + 3] ?? 0;
      min[i] = Math.min(min[i] ?? Infinity, a, b);
      max[i] = Math.max(max[i] ?? -Infinity, a, b);
    }
  }
  return { min, max };
}
