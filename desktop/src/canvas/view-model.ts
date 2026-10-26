// 画布工作台 · 纯视图模型（无 DOM，可 node 单测）
//
// 这一层只做「图 → 屏幕上的数字」：拓扑布局、2D 正交投影、甘特条、画板对比、
// 汇总指标、转接板默认工厂。DOM 结构、事件、样式全在 workbench.ts。
//
// 口径不许在这里自创：
//   - 整机 CT/UPH 一律来自 metrics.machineMetrics（其内部走 machine/flow.ts evaluateFlow）；
//   - 金额一律来自注入的 priceLookup，缺省 () => null 表示「全部待询价」；
//   - 转接板默认工厂给尺寸/质量（几何+材料密度可算），**价格恒为 null**，等询价。
import { findMismatchedEdges, isAdapterNode } from './graph.ts';
import { machineMetrics, type AxisSizingResult, type PriceLookup } from './metrics.ts';
import type { AdapterFactory, AdapterFactorySpec } from './graph.ts';
import type { CanvasNode, FlowLayout, MachineGraph, MountPort } from './types.ts';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface WorkbenchViewOptions {
  /** 价格查询；缺省全部视为待询价（不写死任何单价）。 */
  priceLookup?: PriceLookup;
  targetPerMin?: number;
  /** 拓扑卡片宽高（px）。 */
  nodeWidthPx?: number;
  nodeHeightPx?: number;
  /** 拓扑层横向/纵向间距（px）。 */
  columnGapPx?: number;
  rowGapPx?: number;
  /** 2D 正交视图每毫米像素数，缺省 0.32。 */
  pxPerMm?: number;
}

export interface TopologyNodeBox {
  id: string;
  name: string;
  spec: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 该节点参与的边里有不匹配 → 卡片描橙。 */
  mismatch: boolean;
  adapter: boolean;
  portInLabel: string;
  portOutLabel: string;
  massKg: number;
  stepSec: number;
  strokeMm: number;
  leadMm: number;
  partId: string | null;
}

export interface TopologyEdgePath {
  id: string;
  from: string;
  to: string;
  /** SVG path d。 */
  d: string;
  /** 是否端口不兼容（要串转接板）。 */
  mismatched: boolean;
  /** ⚡ 按钮位置（边中点）。 */
  badgeX: number;
  badgeY: number;
  diffFields: string[];
}

export interface TopologyView {
  width: number;
  height: number;
  nodes: TopologyNodeBox[];
  edges: TopologyEdgePath[];
  mismatchCount: number;
  adapterCount: number;
}

export interface OrthoStation {
  id: string;
  name: string;
  /** 画布坐标（px，已含内边距）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 毫米尺寸与坐标，便于标尺/导出对账。 */
  mmX: number;
  mmY: number;
  mmWidth: number;
  mmHeight: number;
  adapter: boolean;
  /** 运动包络宽度（mm）：行程方向展开，非运动件为 0。 */
  envelopeWidthMm: number;
  envelopeHeightMm: number;
}

export interface OrthoView {
  width: number;
  height: number;
  scale: number;
  stations: OrthoStation[];
  /** 全部工位的毫米包围盒，便于「适应窗口」。 */
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number };
  /** 是否触到布局边界（mm 画布 3000×2500 之类由调用方给）。 */
  notes: string[];
}

export interface GanttRow {
  nodeId: string;
  name: string;
  startSec: number;
  durationSec: number;
  /** 条在 0..1 的相对位置与宽度，供 CSS 直接铺。 */
  leftRatio: number;
  widthRatio: number;
  stepSec: number;
}

export interface GanttView {
  rows: GanttRow[];
  totalSec: number;
  /** 甘特只表达「单步时间」，不是整机产能口径。 */
  note: string;
}

export interface WorkbenchSummary {
  cycleSeconds: number;
  unitsPerHour: number;
  throughputPerMin: number;
  /** 只统计查得到价的节点；缺价不计。 */
  totalCostYuan: number;
  pendingQuoteCount: number;
  costComplete: boolean;
  mismatchCount: number;
  adapterCount: number;
  nodeCount: number;
  bottleneck: string;
  primaryAxis: { nodeId: string; name: string; sizing: AxisSizingResult } | null;
  notes: string[];
}

export interface ArtboardSummary {
  layout: FlowLayout;
  label: string;
  cycleSeconds: number;
  unitsPerHour: number;
  totalCostYuan: number;
  pendingQuoteCount: number;
  mismatchCount: number;
  inertiaRatio: number | null;
  bottleneck: string;
  note: string;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const PORT_NAMES: Record<MountPort['family'], string> = {
  grid: '网格面',
  slider: '滑块面',
  body: '本体面',
  plate: '法兰面',
  dial: '转盘面',
  floor: '地脚',
  optical: '光学口',
  tip: '末端'
};

/** 端口的人话标签：family · 孔 Ø · 孔距 · 孔数。 */
export function formatPort(port: MountPort): string {
  const pitch = port.count <= 1 || (port.pitchXMm === 0 && port.pitchYMm === 0)
    ? '单孔'
    : `${port.pitchXMm}×${port.pitchYMm}mm`;
  return `${PORT_NAMES[port.family]}(${port.family}) · Ø${port.holeDiaMm} · ${pitch} · ${port.count} 孔`;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

// ---------------------------------------------------------------------------
// 拓扑布局
// ---------------------------------------------------------------------------

/**
 * 按「最长的从入口到该节点的路径」分列：列 = 深度，行 = 同列内的顺序。
 * 不引入布局库、不做力导向——节点数是个位数到几十，确定性布局更好断言。
 * 环（非法的强连通）按已访问截断，不递归死循环。
 */
export function topologyDepth(graph: MachineGraph): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from) || !indegree.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of graph.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  }
  // 全环图没有入度为 0 的点：兜底从第一个节点起算，避免整图消失。
  if (queue.length === 0 && graph.nodes.length > 0) {
    const first = graph.nodes[0] as CanvasNode;
    depth.set(first.id, 0);
    queue.push(first.id);
  }
  let guard = 0;
  while (queue.length > 0 && guard < 10_000) {
    guard += 1;
    const id = queue.shift() as string;
    const current = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      const candidate = current + 1;
      if ((depth.get(next) ?? -1) < candidate) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }
  for (const node of graph.nodes) if (!depth.has(node.id)) depth.set(node.id, 0);
  return depth;
}

export function buildTopologyView(graph: MachineGraph, options: WorkbenchViewOptions = {}): TopologyView {
  const width = options.nodeWidthPx ?? 196;
  const height = options.nodeHeightPx ?? 96;
  const columnGap = options.columnGapPx ?? 88;
  const rowGap = options.rowGapPx ?? 30;
  const padding = 40;
  const depth = topologyDepth(graph);
  const perColumn = new Map<number, number>();
  const boxes = new Map<string, TopologyNodeBox>();

  const mismatches = findMismatchedEdges(graph);
  const mismatchEdges = new Set(mismatches.map((item) => item.edgeId));
  const nodesWithMismatch = new Set<string>();
  for (const mismatch of mismatches) {
    nodesWithMismatch.add(mismatch.fromId);
    nodesWithMismatch.add(mismatch.toId);
  }

  let maxDepth = 0;
  for (const node of graph.nodes) {
    const column = depth.get(node.id) ?? 0;
    maxDepth = Math.max(maxDepth, column);
    const row = perColumn.get(column) ?? 0;
    perColumn.set(column, row + 1);
    boxes.set(node.id, {
      id: node.id,
      name: node.name,
      spec: node.spec,
      kind: node.kind,
      x: padding + column * (width + columnGap),
      y: padding + row * (height + rowGap),
      width,
      height,
      mismatch: nodesWithMismatch.has(node.id),
      adapter: isAdapterNode(node),
      portInLabel: formatPort(node.portIn),
      portOutLabel: formatPort(node.portOut),
      massKg: node.massKg,
      stepSec: node.stepSec,
      strokeMm: node.strokeMm,
      leadMm: node.leadMm,
      partId: node.partId ?? null
    });
  }

  const edges: TopologyEdgePath[] = [];
  for (const edge of graph.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.45);
    const mismatch = mismatches.find((item) => item.edgeId === edge.id);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      d: `M ${round(x1)} ${round(y1)} C ${round(x1 + bend)} ${round(y1)}, ${round(x2 - bend)} ${round(y2)}, ${round(x2)} ${round(y2)}`,
      mismatched: mismatchEdges.has(edge.id),
      badgeX: round((x1 + x2) / 2),
      badgeY: round((y1 + y2) / 2) - 14,
      diffFields: mismatch ? [...mismatch.diffFields] : []
    });
  }

  const maxRow = Math.max(1, ...perColumn.values());
  return {
    width: padding * 2 + (maxDepth + 1) * width + maxDepth * columnGap,
    height: padding * 2 + maxRow * height + (maxRow - 1) * rowGap,
    nodes: [...boxes.values()],
    edges,
    mismatchCount: mismatches.length,
    adapterCount: graph.nodes.filter((node) => isAdapterNode(node)).length
  };
}

// ---------------------------------------------------------------------------
// 2D 正交视图
// ---------------------------------------------------------------------------

export function buildOrthoView(graph: MachineGraph, options: WorkbenchViewOptions = {}): OrthoView {
  const scale = options.pxPerMm ?? 0.32;
  const padding = 48;
  const notes: string[] = [];

  // 包络：直线模组沿行程方向展开一份；旋转/结构件不外扩。
  const stations: OrthoStation[] = graph.nodes.map((node) => {
    const [dx, dy] = node.dimsMm;
    const moving = node.kind === 'linear' && node.strokeMm > 0;
    return {
      id: node.id,
      name: node.name,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      mmX: node.ortho.x,
      mmY: node.ortho.y,
      mmWidth: dx,
      mmHeight: dy,
      adapter: isAdapterNode(node),
      envelopeWidthMm: moving ? dx + node.strokeMm : dx,
      envelopeHeightMm: dy
    };
  });

  if (stations.length === 0) {
    return {
      width: 640,
      height: 360,
      scale,
      stations,
      boundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      notes: ['图中没有节点，2D 视图为空。']
    };
  }

  const minX = Math.min(...stations.map((s) => s.mmX));
  const minY = Math.min(...stations.map((s) => s.mmY));
  const maxX = Math.max(...stations.map((s) => s.mmX + Math.max(s.mmWidth, s.envelopeWidthMm)));
  const maxY = Math.max(...stations.map((s) => s.mmY + Math.max(s.mmHeight, s.envelopeHeightMm)));

  for (const station of stations) {
    station.x = padding + (station.mmX - minX) * scale;
    station.y = padding + (station.mmY - minY) * scale;
    station.width = Math.max(8, station.mmWidth * scale);
    station.height = Math.max(8, station.mmHeight * scale);
  }

  // 重叠检查（毫米级 AABB，和 mech/interference 同口径：相切不算）
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      const a = stations[i] as OrthoStation;
      const b = stations[j] as OrthoStation;
      const overlapX = Math.min(a.mmX + Math.max(a.mmWidth, a.envelopeWidthMm), b.mmX + Math.max(b.mmWidth, b.envelopeWidthMm)) - Math.max(a.mmX, b.mmX);
      const overlapY = Math.min(a.mmY + Math.max(a.mmHeight, a.envelopeHeightMm), b.mmY + Math.max(b.mmHeight, b.envelopeHeightMm)) - Math.max(a.mmY, b.mmY);
      if (overlapX > 0 && overlapY > 0) {
        // 叠层安装（Y 轴压在 X 轴滑块上）在俯视图里本来就重叠，所以这里只报「投影重叠」，
        // 不写成干涉结论 —— 真实装配干涉必须走 3D/B-Rep。
        notes.push(`平面投影重叠：${a.name} ↔ ${b.name} ${round(overlapX)}×${round(overlapY)}mm（含叠层安装，非干涉结论）`);
      }
    }
  }
  if (notes.length === 0) notes.push('平面投影无重叠（仅布局提示，不代表 B-Rep 精确干涉结论）。');

  return {
    width: padding * 2 + (maxX - minX) * scale,
    height: padding * 2 + (maxY - minY) * scale,
    scale,
    stations,
    boundsMm: { minX, minY, maxX, maxY },
    notes
  };
}

// ---------------------------------------------------------------------------
// 甘特（只表达单步时间，不承担产能）
// ---------------------------------------------------------------------------

export function buildGanttView(graph: MachineGraph): GanttView {
  const rows: GanttRow[] = [];
  let cursor = 0;
  for (const node of graph.nodes) {
    if (isAdapterNode(node)) continue;
    if (!(node.stepSec > 0)) continue;
    rows.push({
      nodeId: node.id,
      name: node.name,
      startSec: round(cursor, 3),
      durationSec: node.stepSec,
      leftRatio: 0,
      widthRatio: 0,
      stepSec: node.stepSec
    });
    cursor += node.stepSec;
  }
  const total = cursor;
  for (const row of rows) {
    row.leftRatio = total > 0 ? row.startSec / total : 0;
    row.widthRatio = total > 0 ? row.durationSec / total : 1;
  }
  return {
    rows,
    totalSec: round(total, 3),
    note:
      rows.length === 0
        ? '没有 stepSec > 0 的运动节点，甘特为空。'
        : `甘特合计 ${round(total, 2)}s 是「单步时间串行相加」，仅用于排动作顺序；整机 CT/UPH 以 evaluateFlow 的布局口径为准。`
  };
}

// ---------------------------------------------------------------------------
// 汇总与画板
// ---------------------------------------------------------------------------

export function buildSummary(graph: MachineGraph, options: WorkbenchViewOptions = {}): WorkbenchSummary {
  const priceLookup: PriceLookup = options.priceLookup ?? (() => null);
  const metrics = machineMetrics(graph, {
    priceLookup,
    ...(options.targetPerMin !== undefined ? { targetPerMin: options.targetPerMin } : {})
  });
  const bottleneck = metrics.flow?.bottleneck
    ? `工位 ${metrics.flow.bottleneck.station}：${metrics.flow.bottleneck.op}（${round(metrics.flow.bottleneck.seconds, 2)}s）`
    : '—';
  return {
    cycleSeconds: metrics.cycleSeconds,
    unitsPerHour: metrics.unitsPerHour,
    throughputPerMin: metrics.throughputPerMin,
    totalCostYuan: metrics.cost.totalYuan,
    pendingQuoteCount: metrics.cost.pendingQuote.length,
    costComplete: metrics.cost.complete,
    mismatchCount: metrics.mismatchCount,
    adapterCount: metrics.adapterCount,
    nodeCount: metrics.nodeCount,
    bottleneck,
    primaryAxis: metrics.primaryAxis,
    notes: metrics.notes
  };
}

const ARTBOARD_LAYOUTS: Array<{ layout: FlowLayout; label: string; note: string }> = [
  { layout: 'single', label: '单工位串行', note: '全部工序在一个工位完成：CT = 工序时间之和，最保守。' },
  { layout: 'linear', label: '直线多工位', note: '每节点一个工位：CT ≈ 最慢工位 + 工位间转移。' },
  { layout: 'dial', label: '转盘分度', note: '每节点一个工位：CT ≈ 最慢工位 + 分度时间。' }
];

/**
 * 多画板：**同一张拓扑**分别在三种产能口径下的真实评估结果。
 * 不是「AI 生成的 3 个候选方案」——候选方案要等 P3 接 design/synthesis，
 * 现在不伪造三套不同 BOM 的画板。
 */
export function buildArtboards(graph: MachineGraph, options: WorkbenchViewOptions = {}): ArtboardSummary[] {
  const priceLookup: PriceLookup = options.priceLookup ?? (() => null);
  return ARTBOARD_LAYOUTS.map(({ layout, label, note }) => {
    const variant: MachineGraph = {
      ...graph,
      layout,
      ...(layout === 'dial' ? { indexSeconds: graph.indexSeconds ?? 0.6 } : {}),
      ...(layout === 'linear' ? { transferSeconds: graph.transferSeconds ?? 0.2 } : {})
    };
    const metrics = machineMetrics(variant, { priceLookup });
    return {
      layout,
      label,
      cycleSeconds: metrics.cycleSeconds,
      unitsPerHour: metrics.unitsPerHour,
      totalCostYuan: metrics.cost.totalYuan,
      pendingQuoteCount: metrics.cost.pendingQuote.length,
      mismatchCount: metrics.mismatchCount,
      inertiaRatio: metrics.primaryAxis ? metrics.primaryAxis.sizing.inertiaRatio : null,
      bottleneck: metrics.flow?.bottleneck
        ? `工位 ${metrics.flow.bottleneck.station}`
        : '—',
      note
    };
  });
}

// ---------------------------------------------------------------------------
// 转接板默认工厂（几何/质量可算，价格恒为 null）
// ---------------------------------------------------------------------------

export interface AdapterFactoryDefaults {
  /** 板边相对孔阵列外扩的余量 mm，缺省 15。 */
  edgeMarginMm?: number;
  /** 板厚 mm，缺省 12。 */
  thicknessMm?: number;
  /** 材料密度 kg/m³，缺省 2700（6061-T6 铝合金）。 */
  densityKgM3?: number;
  material?: string;
  /** 定位销孔径 mm，缺省 0（不设销孔）。 */
  dowelDiaMm?: number;
}

/**
 * 默认转接板工厂：外形 = 两端孔阵列的较大者 + 两侧余量；厚度/密度给定；
 * 质量 = 体积 × 密度；**costYuan 恒为 null**（必须走询价，禁止内置单价）。
 */
export function createDefaultAdapterFactory(defaults: AdapterFactoryDefaults = {}): AdapterFactory {
  const margin = defaults.edgeMarginMm ?? 15;
  const thickness = defaults.thicknessMm ?? 12;
  const density = defaults.densityKgM3 ?? 2700;
  const material = defaults.material ?? '6061-T6';
  const dowel = defaults.dowelDiaMm ?? 0;
  return (request) => {
    const spanX = Math.max(request.fromPort.pitchXMm, request.toPort.pitchXMm);
    const spanY = Math.max(request.fromPort.pitchYMm, request.toPort.pitchYMm);
    const width = round(Math.max(60, spanX + margin * 2), 1);
    const height = round(Math.max(50, spanY + margin * 2), 1);
    const volumeM3 = (width * height * thickness) / 1e9;
    return {
      plateDimsMm: [width, height, thickness],
      thicknessMm: thickness,
      material,
      massKg: round(volumeM3 * density, 3),
      costYuan: null,
      counterBore: true,
      dowelDiaMm: dowel
    };
  };
}

/** 检查器预览：如果对这条边插板，默认工厂会给出什么。边不匹配时才有意义。 */
export function adapterSpecPreview(graph: MachineGraph, edgeId: string, defaults: AdapterFactoryDefaults = {}): AdapterFactorySpec | null {
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return null;
  const from = graph.nodes.find((node) => node.id === edge.from);
  const to = graph.nodes.find((node) => node.id === edge.to);
  if (!from || !to) return null;
  if (findMismatchedEdges(graph).every((item) => item.edgeId !== edgeId)) return null;
  return createDefaultAdapterFactory(defaults)({
    edge,
    from,
    to,
    fromPort: from.portOut,
    toPort: to.portIn,
    diffFields: [],
    existingIds: graph.nodes.map((node) => node.id)
  });
}

/** BOM 行（只描述需要买什么/问什么价，不含单价）。 */
export interface BomLine {
  nodeId: string;
  name: string;
  partId: string | null;
  qty: number;
  adapter: boolean;
  priceState: 'priced' | 'pending';
  spec: string;
}

export function buildBomLines(graph: MachineGraph, priceLookup: PriceLookup): BomLine[] {
  return graph.nodes.map((node) => {
    const priced = node.partId !== undefined && priceLookup(node.partId) !== null;
    return {
      nodeId: node.id,
      name: node.name,
      partId: node.partId ?? null,
      qty: 1,
      adapter: isAdapterNode(node),
      priceState: priced ? 'priced' : 'pending',
      spec: node.spec
    };
  });
}
