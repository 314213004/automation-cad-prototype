// 画布拓扑：端口兼容判定、规范化、插转接板、删节点。
// 全部是纯函数：返回新对象，不就地改入参（原型 insertAdapterPlateForEdge 会顺手挪下游节点
// 的 x 坐标，这里去掉该副作用，规格书第 4 节不变量 2）。
import type {
  AdapterParams,
  CanvasEdge,
  CanvasNode,
  MachineGraph,
  MountFamily,
  MountPort,
  PortField
} from './types.ts';

/** 兼容判定必须逐个比对的字段。少比一个就会出现「假的兼容」。 */
export const PORT_FIELDS: readonly PortField[] = [
  'family',
  'holeDiaMm',
  'pitchXMm',
  'pitchYMm',
  'count'
];

const MOUNT_FAMILIES: readonly MountFamily[] = [
  'grid',
  'slider',
  'body',
  'plate',
  'dial',
  'floor',
  'optical',
  'tip'
];

const NODE_KINDS: readonly CanvasNode['kind'][] = [
  'frame',
  'indexer',
  'linear',
  'actuator',
  'gripper',
  'vision',
  'adapter'
];

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export function clonePort(port: MountPort): MountPort {
  return {
    family: port.family,
    holeDiaMm: port.holeDiaMm,
    pitchXMm: port.pitchXMm,
    pitchYMm: port.pitchYMm,
    count: port.count
  };
}

/**
 * 端口是否兼容：**五个字段全部相等**才算真兼容。
 * 不做浮点容差——端口数值来自元件库规格（M5 孔距 60），带容差会把
 * 60 与 60.5 判成同一接口，而实物装不上。
 */
export function portsCompatible(outPort: MountPort, inPort: MountPort): boolean {
  if (!outPort || !inPort) return false;
  for (const field of PORT_FIELDS) {
    if (outPort[field] !== inPort[field]) return false;
  }
  return true;
}

/** 列出不相等字段，用于标红与报错文案。 */
export function portDiff(outPort: MountPort, inPort: MountPort): PortField[] {
  const diff: PortField[] = [];
  for (const field of PORT_FIELDS) {
    if (outPort[field] !== inPort[field]) diff.push(field);
  }
  return diff;
}

function portProblems(port: unknown, label: string): string[] {
  if (typeof port !== 'object' || port === null) return [`${label} 不是对象`];
  const candidate = port as Partial<MountPort>;
  const problems: string[] = [];
  if (!candidate.family || !MOUNT_FAMILIES.includes(candidate.family)) {
    problems.push(`${label}.family 非法（${String(candidate.family)}）`);
  }
  for (const field of ['holeDiaMm', 'pitchXMm', 'pitchYMm'] as const) {
    const value = candidate[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${label}.${field} 必须是 >= 0 的有限数`);
    }
  }
  const count = candidate.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    problems.push(`${label}.count 必须是非负整数`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 规范化
// ---------------------------------------------------------------------------

export type GraphIssueCode =
  | 'INVALID_NODE'
  | 'DUPLICATE_NODE_ID'
  | 'INVALID_EDGE'
  | 'DUPLICATE_EDGE_ID'
  | 'DUPLICATE_EDGE'
  | 'ORPHAN_EDGE'
  | 'SELF_LOOP'
  | 'ADAPTER_DEGREE'
  | 'PORT_MISMATCH';

export interface GraphIssue {
  code: GraphIssueCode;
  message: string;
  id?: string;
}

export interface NormalizeResult {
  graph: MachineGraph;
  /** 被清理/被修正的内容，调用方应展示给用户，不要静默吞掉。 */
  issues: GraphIssue[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pointProblems(point: unknown, label: string): string[] {
  if (typeof point !== 'object' || point === null) return [`${label} 不是对象`];
  const candidate = point as { x?: unknown; y?: unknown };
  return isFiniteNumber(candidate.x) && isFiniteNumber(candidate.y)
    ? []
    : [`${label} 必须是 {x, y} 有限数`];
}

function nodeProblems(node: unknown, index: number): string[] {
  if (typeof node !== 'object' || node === null) return [`nodes[${index}] 不是对象`];
  const candidate = node as Partial<CanvasNode>;
  const problems: string[] = [];
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
    problems.push(`nodes[${index}].id 必须是非空字符串`);
  }
  if (!candidate.kind || !NODE_KINDS.includes(candidate.kind)) {
    problems.push(`nodes[${index}].kind 非法（${String(candidate.kind)}）`);
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    problems.push(`nodes[${index}].name 必须是非空字符串`);
  }
  problems.push(...portProblems(candidate.portIn, `nodes[${index}].portIn`));
  problems.push(...portProblems(candidate.portOut, `nodes[${index}].portOut`));
  for (const field of ['strokeMm', 'leadMm', 'massKg', 'stepSec'] as const) {
    const value = candidate[field];
    if (!isFiniteNumber(value) || value < 0) {
      problems.push(`nodes[${index}].${field} 必须是 >= 0 的有限数`);
    }
  }
  const dims = candidate.dimsMm;
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((item: unknown) => !isFiniteNumber(item) || item < 0)) {
    problems.push(`nodes[${index}].dimsMm 必须是三个 >= 0 的有限数`);
  }
  problems.push(...pointProblems(candidate.pos, `nodes[${index}].pos`));
  problems.push(...pointProblems(candidate.ortho, `nodes[${index}].ortho`));
  return problems;
}

export function cloneNode(node: CanvasNode): CanvasNode {
  const copy: CanvasNode = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    spec: typeof node.spec === 'string' ? node.spec : '',
    portIn: clonePort(node.portIn),
    portOut: clonePort(node.portOut),
    strokeMm: node.strokeMm,
    leadMm: node.leadMm,
    massKg: node.massKg,
    stepSec: node.stepSec,
    dimsMm: [node.dimsMm[0], node.dimsMm[1], node.dimsMm[2]],
    io: {
      di: node.io?.di ?? 0,
      do: node.io?.do ?? 0,
      desc: node.io?.desc ?? ''
    },
    pos: { x: node.pos.x, y: node.pos.y },
    ortho: { x: node.ortho.x, y: node.ortho.y }
  };
  if (node.partId !== undefined) copy.partId = node.partId;
  if (node.adapter !== undefined) copy.adapter = node.adapter;
  if (node.adapterParams !== undefined) copy.adapterParams = cloneAdapterParams(node.adapterParams);
  if (node.station !== undefined) copy.station = node.station;
  if (node.notes !== undefined) copy.notes = node.notes;
  return copy;
}

export function cloneAdapterParams(params: AdapterParams): AdapterParams {
  return {
    fromPort: clonePort(params.fromPort),
    toPort: clonePort(params.toPort),
    plateDimsMm: [params.plateDimsMm[0], params.plateDimsMm[1], params.plateDimsMm[2]],
    thicknessMm: params.thicknessMm,
    material: params.material,
    counterBore: params.counterBore,
    dowelDiaMm: params.dowelDiaMm,
    massKg: params.massKg,
    costYuan: params.costYuan
  };
}

function cloneEdge(edge: CanvasEdge): CanvasEdge {
  return { id: edge.id, from: edge.from, to: edge.to };
}

function copyGraphOptions(source: MachineGraph, target: MachineGraph): void {
  if (source.title !== undefined) target.title = source.title;
  if (source.layout !== undefined) target.layout = source.layout;
  if (source.targetPerMin !== undefined) target.targetPerMin = source.targetPerMin;
  if (source.transferSeconds !== undefined) target.transferSeconds = source.transferSeconds;
  if (source.indexSeconds !== undefined) target.indexSeconds = source.indexSeconds;
  if (source.lanes !== undefined) target.lanes = source.lanes;
}

/**
 * 深拷贝图（不校验）。所有导出/指标函数都先克隆，保证不改调用方对象。
 */
export function cloneGraph(graph: MachineGraph): MachineGraph {
  const copy: MachineGraph = {
    schemeId: graph.schemeId,
    nodes: graph.nodes.map((node) => cloneNode(node)),
    edges: graph.edges.map((edge) => cloneEdge(edge))
  };
  copyGraphOptions(graph, copy);
  return copy;
}

/**
 * 校验 + 去重 id + 清理孤儿边 + 保证入边出边一致。
 *
 * 处理规则（顺序固定，便于测试断言）：
 * 1. 非法节点整条丢弃（记录 INVALID_NODE），不尝试修补数值。
 * 2. 重复节点 id 保留首个，后者丢弃（DUPLICATE_NODE_ID）。
 * 3. 边：非法字段丢弃（INVALID_EDGE）；端点不存在丢弃（ORPHAN_EDGE）；
 *    自环丢弃（SELF_LOOP）；重复边 id 保留首个（DUPLICATE_EDGE_ID）；
 *    同一对 (from,to) 重复走线只留首个（DUPLICATE_EDGE）。
 * 4. 输出图的邻接表由边集唯一重建：每条边恰好贡献一次出度与一次入度，
 *    因此不可能出现「有边无入度」的半截邻接（这就是「入边出边一致」）。
 */
export function normalizeGraph(graph: MachineGraph): NormalizeResult {
  const issues: GraphIssue[] = [];
  if (!graph || typeof graph !== 'object') {
    throw new Error('画布图不能为空');
  }
  const schemeId = typeof graph.schemeId === 'string' && graph.schemeId.trim() !== ''
    ? graph.schemeId
    : 'scheme-unnamed';
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];

  const nodes: CanvasNode[] = [];
  const nodeIds = new Set<string>();
  rawNodes.forEach((node, index) => {
    const problems = nodeProblems(node, index);
    if (problems.length > 0) {
      issues.push({
        code: 'INVALID_NODE',
        message: `节点被丢弃：${problems.join('；')}`,
        ...(typeof (node as { id?: unknown })?.id === 'string'
          ? { id: (node as { id: string }).id }
          : {})
      });
      return;
    }
    const candidate = node as CanvasNode;
    if (nodeIds.has(candidate.id)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        message: `节点 id 重复，保留首个：${candidate.id}`,
        id: candidate.id
      });
      return;
    }
    nodeIds.add(candidate.id);
    nodes.push(cloneNode(candidate));
  });

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  rawEdges.forEach((edge, index) => {
    if (
      typeof edge !== 'object' ||
      edge === null ||
      typeof edge.id !== 'string' ||
      edge.id.trim() === '' ||
      typeof edge.from !== 'string' ||
      typeof edge.to !== 'string'
    ) {
      issues.push({
        code: 'INVALID_EDGE',
        message: `edges[${index}] 字段非法，已丢弃`,
        ...(typeof (edge as { id?: unknown })?.id === 'string'
          ? { id: (edge as { id: string }).id }
          : {})
      });
      return;
    }
    if (edge.from === edge.to) {
      issues.push({ code: 'SELF_LOOP', message: `自环边已丢弃：${edge.id}`, id: edge.id });
      return;
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      issues.push({
        code: 'ORPHAN_EDGE',
        message: `孤儿边已清理：${edge.id}（${edge.from} → ${edge.to}）`,
        id: edge.id
      });
      return;
    }
    if (edgeIds.has(edge.id)) {
      issues.push({ code: 'DUPLICATE_EDGE_ID', message: `边 id 重复，保留首个：${edge.id}`, id: edge.id });
      return;
    }
    const pairKey = `${edge.from}\u0000${edge.to}`;
    if (pairs.has(pairKey)) {
      issues.push({
        code: 'DUPLICATE_EDGE',
        message: `同一对节点的重复连线已丢弃：${edge.id}（${edge.from} → ${edge.to}）`,
        id: edge.id
      });
      return;
    }
    edgeIds.add(edge.id);
    pairs.add(pairKey);
    edges.push(cloneEdge(edge));
  });

  const normalized: MachineGraph = { schemeId, nodes, edges };
  copyGraphOptions(graph, normalized);

  // 邻接表唯一由边集重建：入边出边一致性的唯一事实来源。
  // 边集已经过端点校验，因此这里只需校验「每条边都能被邻接表各数到一次」。
  const adjacency = buildAdjacency(normalized);
  const countedOut = [...adjacency.outgoing.values()].reduce((sum, list) => sum + list.length, 0);
  const countedIn = [...adjacency.incoming.values()].reduce((sum, list) => sum + list.length, 0);
  if (countedOut !== edges.length || countedIn !== edges.length) {
    issues.push({
      code: 'ORPHAN_EDGE',
      message: `邻接表与边集不一致：出度 ${countedOut} / 入度 ${countedIn} / 边 ${edges.length}`
    });
  }
  for (const nodeId of adjacency.outgoing.keys()) {
    if (!nodeIds.has(nodeId)) {
      issues.push({ code: 'ORPHAN_EDGE', message: `邻接表引用了不存在的节点：${nodeId}`, id: nodeId });
    }
  }

  return { graph: normalized, issues };
}

/** 邻接表：出边/入边各自的边 id 列表，键恒为图内实际存在的节点。 */
export interface Adjacency {
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
}

export function buildAdjacency(graph: MachineGraph): Adjacency {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from);
    const inc = incoming.get(edge.to);
    if (out) out.push(edge.id);
    if (inc) inc.push(edge.id);
  }
  return { incoming, outgoing };
}

export function findNode(graph: MachineGraph, nodeId: string): CanvasNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function isAdapterNode(node: CanvasNode): boolean {
  return node.kind === 'adapter' || node.adapter === true;
}

// ---------------------------------------------------------------------------
// 端口不匹配检测
// ---------------------------------------------------------------------------

export interface EdgeMismatch {
  edgeId: string;
  fromId: string;
  toId: string;
  /** 上游节点的出口端口。 */
  outPort: MountPort;
  /** 下游节点的入口端口。 */
  inPort: MountPort;
  /** 不相等字段名（非空）。 */
  diffFields: PortField[];
  message: string;
}

/** 找出所有「直连但不兼容」的边。每条都必须串一个 adapter。 */
export function findMismatchedEdges(graph: MachineGraph): EdgeMismatch[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const mismatches: EdgeMismatch[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue; // 孤儿边交给 normalizeGraph 报，不在指标里制造假数据
    if (portsCompatible(from.portOut, to.portIn)) continue;
    const diffFields = portDiff(from.portOut, to.portIn);
    mismatches.push({
      edgeId: edge.id,
      fromId: from.id,
      toId: to.id,
      outPort: clonePort(from.portOut),
      inPort: clonePort(to.portIn),
      diffFields,
      message:
        `${from.name}(${from.id}).portOut 与 ${to.name}(${to.id}).portIn 不兼容：` +
        diffFields
          .map((field) => `${field} ${String(from.portOut[field])} ≠ ${String(to.portIn[field])}`)
          .join('，')
    });
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// 插入转接板
// ---------------------------------------------------------------------------

/** 工厂入参：两端真实节点与端口，用于按孔位算板型；价格/质量/尺寸由工厂给出。 */
export interface AdapterRequest {
  edge: CanvasEdge;
  from: CanvasNode;
  to: CanvasNode;
  /** = from.portOut（克隆） */
  fromPort: MountPort;
  toPort: MountPort;
  /** 端口差异字段，工厂可据此决定是否做异径/偏心板。 */
  diffFields: PortField[];
  /** 图内已占用 id，工厂给固定 id 时用于避让。 */
  existingIds: readonly string[];
}

/** 工厂产出：几何 + 质量 + 询价结果。**不含任何内置单价**。 */
export interface AdapterFactorySpec {
  id?: string;
  name?: string;
  spec?: string;
  plateDimsMm: [number, number, number];
  thicknessMm: number;
  /** 材料牌号，缺省 '6061-T6'。 */
  material?: string;
  massKg: number;
  /** 询价结果（元）；null = 待询价，不允许在此写死数字。 */
  costYuan: number | null;
  counterBore?: boolean;
  dowelDiaMm?: number;
  pos?: { x: number; y: number };
  ortho?: { x: number; y: number };
  partId?: string;
}

export type AdapterFactory = (request: AdapterRequest) => AdapterFactorySpec;

export interface InsertAdapterResult {
  graph: MachineGraph;
  inserted: boolean;
  adapterId: string | null;
  /** 未插入时给出人话原因；插入时给出插入摘要。 */
  reason: string;
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function assertAdapterSpec(spec: AdapterFactorySpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('转接板工厂必须返回对象');
  const dims = spec.plateDimsMm;
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((item) => !isFiniteNumber(item) || item <= 0)) {
    throw new Error('转接板 plateDimsMm 必须是三个大于 0 的有限数（mm）');
  }
  if (!isFiniteNumber(spec.thicknessMm) || spec.thicknessMm <= 0) {
    throw new Error('转接板 thicknessMm 必须大于 0（mm）');
  }
  if (!isFiniteNumber(spec.massKg) || spec.massKg < 0) {
    throw new Error('转接板 massKg 必须是 >= 0 的有限数（kg）');
  }
  if (spec.costYuan !== null && (!isFiniteNumber(spec.costYuan) || spec.costYuan < 0)) {
    throw new Error('转接板 costYuan 必须是 >= 0 的有限数或 null（待询价）');
  }
  if (spec.dowelDiaMm !== undefined && (!isFiniteNumber(spec.dowelDiaMm) || spec.dowelDiaMm < 0)) {
    throw new Error('转接板 dowelDiaMm 必须是 >= 0 的有限数（mm）');
  }
}

/**
 * 把一条不匹配的边拆成「from → adapter → to」两条匹配边。
 *
 * 硬约束：
 * - 只动被拆的那条边与新节点，**其它节点坐标一律不变**；
 * - 端口已全字段匹配时拒绝插入（返回 inserted=false），避免叠转接板；
 * - 新节点的 portIn = from.portOut、portOut = to.portIn，两端端口参数同时写进
 *   adapterParams，作为 build123d 生成请求的入参。
 */
export function insertAdapterForEdge(
  graph: MachineGraph,
  edgeId: string,
  factory: AdapterFactory
): InsertAdapterResult {
  const base = cloneGraph(graph);
  const edge = base.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) throw new Error(`边 ${edgeId} 不存在，无法插入转接板`);
  const from = findNode(base, edge.from);
  const to = findNode(base, edge.to);
  if (!from || !to) throw new Error(`边 ${edgeId} 的端点在图中不存在`);

  if (portsCompatible(from.portOut, to.portIn)) {
    return {
      graph: base,
      inserted: false,
      adapterId: null,
      reason: `端口已全字段匹配（${from.portOut.family}，孔 ${from.portOut.holeDiaMm}mm，孔距 ${from.portOut.pitchXMm}×${from.portOut.pitchYMm}mm），无需转接板`
    };
  }

  const fromPort = clonePort(from.portOut);
  const toPort = clonePort(to.portIn);
  const diffFields = portDiff(fromPort, toPort);
  const existingIds = [...base.nodes.map((node) => node.id), ...base.edges.map((item) => item.id)];
  const spec = factory({
    edge: cloneEdge(edge),
    from: cloneNode(from),
    to: cloneNode(to),
    fromPort: clonePort(fromPort),
    toPort: clonePort(toPort),
    diffFields: [...diffFields],
    existingIds
  });
  assertAdapterSpec(spec);

  const taken = new Set(existingIds);
  const adapterId = uniqueId(spec.id ?? `n_adapter_${from.id}__${to.id}`, taken);
  taken.add(adapterId);

  const pos = spec.pos ?? {
    x: Math.round((from.pos.x + to.pos.x) / 2),
    y: Math.round((from.pos.y + to.pos.y) / 2) + 8
  };
  const ortho = spec.ortho ?? {
    x: (from.ortho.x + to.ortho.x) / 2,
    y: (from.ortho.y + to.ortho.y) / 2
  };

  const adapterParams: AdapterParams = {
    fromPort: clonePort(fromPort),
    toPort: clonePort(toPort),
    plateDimsMm: [spec.plateDimsMm[0], spec.plateDimsMm[1], spec.plateDimsMm[2]],
    thicknessMm: spec.thicknessMm,
    material: spec.material ?? '6061-T6',
    counterBore: spec.counterBore ?? true,
    dowelDiaMm: spec.dowelDiaMm ?? 0,
    massKg: spec.massKg,
    costYuan: spec.costYuan
  };

  const adapter: CanvasNode = {
    id: adapterId,
    kind: 'adapter',
    name: spec.name ?? `转接板 ${from.name} → ${to.name}`,
    spec:
      spec.spec ??
      `${adapterParams.material} 厚 ${adapterParams.thicknessMm}mm · ` +
        `配打 ${fromPort.family}(${fromPort.holeDiaMm}mm/${fromPort.pitchXMm}×${fromPort.pitchYMm}×${fromPort.count}) → ` +
        `${toPort.family}(${toPort.holeDiaMm}mm/${toPort.pitchXMm}×${toPort.pitchYMm}×${toPort.count})`,
    portIn: clonePort(fromPort),
    portOut: clonePort(toPort),
    strokeMm: 0,
    leadMm: 0,
    massKg: spec.massKg,
    stepSec: 0,
    dimsMm: [spec.plateDimsMm[0], spec.plateDimsMm[1], spec.plateDimsMm[2]],
    io: { di: 0, do: 0, desc: '非标转接板：无 IO，仅机械连接' },
    adapter: true,
    adapterParams,
    pos: { x: pos.x, y: pos.y },
    ortho: { x: ortho.x, y: ortho.y }
  };
  if (spec.partId !== undefined) adapter.partId = spec.partId;

  const inEdgeId = uniqueId(`e_${adapterId}_in`, taken);
  taken.add(inEdgeId);
  const outEdgeId = uniqueId(`e_${adapterId}_out`, taken);

  const edges: CanvasEdge[] = [];
  for (const candidate of base.edges) {
    if (candidate.id === edgeId) {
      edges.push({ id: inEdgeId, from: edge.from, to: adapterId });
      edges.push({ id: outEdgeId, from: adapterId, to: edge.to });
      continue;
    }
    edges.push(cloneEdge(candidate));
  }

  const inserted: MachineGraph = { ...base, nodes: [...base.nodes, adapter], edges };

  // 后置断言：拆完两条边都必须匹配，否则是插入逻辑自身有 bug。
  if (!portsCompatible(from.portOut, adapter.portIn)) {
    throw new Error(`内部错误：${inEdgeId} 插入后仍然端口不匹配`);
  }
  if (!portsCompatible(adapter.portOut, to.portIn)) {
    throw new Error(`内部错误：${outEdgeId} 插入后仍然端口不匹配`);
  }

  return {
    graph: inserted,
    inserted: true,
    adapterId,
    reason: `已插入转接板 ${adapterId}（差异字段：${diffFields.join('、')}）`
  };
}

export interface InsertAllResult {
  graph: MachineGraph;
  adapterIds: string[];
  skipped: Array<{ edgeId: string; reason: string }>;
}

/** 一键补齐：按当前不匹配边逐个插板（原型 autoFixAllMismatches 的纯逻辑版）。 */
export function insertAdaptersForAllMismatches(
  graph: MachineGraph,
  factory: AdapterFactory
): InsertAllResult {
  let current = cloneGraph(graph);
  const adapterIds: string[] = [];
  const skipped: Array<{ edgeId: string; reason: string }> = [];
  const initial = findMismatchedEdges(current);
  for (const mismatch of initial) {
    const result = insertAdapterForEdge(current, mismatch.edgeId, factory);
    current = result.graph;
    if (result.inserted && result.adapterId) adapterIds.push(result.adapterId);
    else skipped.push({ edgeId: mismatch.edgeId, reason: result.reason });
  }
  return { graph: current, adapterIds, skipped };
}

// ---------------------------------------------------------------------------
// 删除节点
// ---------------------------------------------------------------------------

export interface RemoveNodeResult {
  graph: MachineGraph;
  /** 被删掉的边 id（含连带清理）。 */
  removedEdges: string[];
  /** 删的是转接板且有唯一上下游时，恢复出的直连边；null = 没有恢复。 */
  restoredEdge: CanvasEdge | null;
  /** 因失去一端连接而被清理的空转接板。 */
  prunedAdapters: string[];
  issues: GraphIssue[];
}

/**
 * 删节点：清理所有相关边；若删掉的是串在中间的转接板，把「上游 → 下游」重新直连。
 *
 * 为什么要恢复直连：转接板存在的唯一理由是消解端口不匹配。删掉它之后如果不恢复
 * 直连，这条「装配关系」就从图上消失了——用户会以为问题解决了，其实只是看不见。
 * 恢复直连后 findMismatchedEdges 会立刻把这条边重新标红（规格书第 4 节不变量 3）。
 */
export function removeNode(graph: MachineGraph, nodeId: string): RemoveNodeResult {
  const base = cloneGraph(graph);
  const target = findNode(base, nodeId);
  if (!target) throw new Error(`节点 ${nodeId} 不存在，无法删除`);

  const issues: GraphIssue[] = [];
  const removedEdges: string[] = [];
  const inEdges = base.edges.filter((edge) => edge.to === nodeId);
  const outEdges = base.edges.filter((edge) => edge.from === nodeId);
  for (const edge of [...inEdges, ...outEdges]) removedEdges.push(edge.id);

  let nodes = base.nodes.filter((node) => node.id !== nodeId);
  let edges = base.edges
    .filter((edge) => edge.from !== nodeId && edge.to !== nodeId)
    .map((edge) => cloneEdge(edge));

  let restoredEdge: CanvasEdge | null = null;
  if (isAdapterNode(target) && inEdges.length === 1 && outEdges.length === 1) {
    const upstreamEdge = inEdges[0];
    const downstreamEdge = outEdges[0];
    if (upstreamEdge && downstreamEdge) {
      const upstreamExists = nodes.some((node) => node.id === upstreamEdge.from);
      const downstreamExists = nodes.some((node) => node.id === downstreamEdge.to);
      const alreadyLinked = edges.some(
        (edge) => edge.from === upstreamEdge.from && edge.to === downstreamEdge.to
      );
      if (upstreamExists && downstreamExists && !alreadyLinked) {
        const taken = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)]);
        const id = uniqueId(`e_${upstreamEdge.from}__${downstreamEdge.to}`, taken);
        restoredEdge = { id, from: upstreamEdge.from, to: downstreamEdge.to };
        edges.push(restoredEdge);
        issues.push({
          code: 'ADAPTER_DEGREE',
          message: `转接板 ${nodeId} 已删除，恢复直连 ${upstreamEdge.from} → ${downstreamEdge.to}（${id}）；若两端端口仍不匹配，会重新出现在不匹配列表`
        });
      }
    }
  } else if (isAdapterNode(target)) {
    issues.push({
      code: 'ADAPTER_DEGREE',
      message: `转接板 ${nodeId} 的入边 ${inEdges.length} 条、出边 ${outEdges.length} 条，不满足 1 进 1 出，无法恢复直连`
    });
  }

  // 连带清理「只剩一端」的空转接板：它已经代表不了任何装配关系。
  const prunedAdapters: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of [...nodes]) {
      if (!isAdapterNode(node)) continue;
      const inCount = edges.filter((edge) => edge.to === node.id).length;
      const outCount = edges.filter((edge) => edge.from === node.id).length;
      if (inCount === 1 && outCount === 1) continue;
      prunedAdapters.push(node.id);
      for (const edge of edges) {
        if (edge.from === node.id || edge.to === node.id) removedEdges.push(edge.id);
      }
      edges = edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
      nodes = nodes.filter((candidate) => candidate.id !== node.id);
      issues.push({
        code: 'ADAPTER_DEGREE',
        message: `转接板 ${node.id} 只剩 ${inCount} 进 ${outCount} 出，已连带清理`
      });
      changed = true;
    }
  }

  const result: MachineGraph = { ...base, nodes, edges };
  return {
    graph: result,
    removedEdges: [...new Set(removedEdges)],
    restoredEdge,
    prunedAdapters,
    issues
  };
}

/**
 * 结构一致性自检：给 UI/冒烟用的人话清单，不修改图。
 * 与 normalizeGraph 互补——这里假设图已经规范化，只报「拓扑语义」问题。
 */
export function graphConsistencyIssues(graph: MachineGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      issues.push({ code: 'ORPHAN_EDGE', message: `孤儿边：${edge.id}`, id: edge.id });
    }
  }
  const adjacency = buildAdjacency(graph);
  for (const node of graph.nodes) {
    if (!isAdapterNode(node)) continue;
    const inCount = (adjacency.incoming.get(node.id) ?? []).length;
    const outCount = (adjacency.outgoing.get(node.id) ?? []).length;
    if (inCount !== 1 || outCount !== 1) {
      issues.push({
        code: 'ADAPTER_DEGREE',
        message: `转接板 ${node.id} 必须是 1 进 1 出，实际 ${inCount} 进 ${outCount} 出`,
        id: node.id
      });
    }
  }
  for (const mismatch of findMismatchedEdges(graph)) {
    issues.push({ code: 'PORT_MISMATCH', message: mismatch.message, id: mismatch.edgeId });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 复制工位
// ---------------------------------------------------------------------------

export interface DuplicateNodeResult {
  graph: MachineGraph;
  /** 新节点 id（未插入时为 null）。 */
  newNodeId: string | null;
  reason: string;
}

/**
 * 复制一个工位：新 id、名称加「副本」，沿用全部端口/尺寸/节拍/IO，坐标按 offset 偏移。
 * 新节点**不带边**（孤立）——复制出来的工位挂到哪儿由人决定，自动接线等于替人做装配决策。
 * 转接板不复制：转接板是「某一对端口」的产物，复制它必然造成两端对不上。
 */
export function duplicateNode(graph: MachineGraph, nodeId: string, offsetMm: { x: number; y: number } = { x: 0, y: 120 }): DuplicateNodeResult {
  const source = findNode(graph, nodeId);
  if (!source) return { graph, newNodeId: null, reason: `节点 ${nodeId} 不存在，无法复制` };
  if (isAdapterNode(source)) {
    return { graph, newNodeId: null, reason: '转接板不能复制：它只对特定一对端口有效，复制会立刻不匹配' };
  }
  const ids = new Set(graph.nodes.map((node) => node.id));
  // 副本的副本不要变成 -copy-copy：先剥掉已有后缀，再从 -copy / -copy2 往上加
  const stem = nodeId.replace(/-copy\d*$/, '');
  const baseId = `${stem}-copy`;
  let newNodeId = baseId;
  let counter = 2;
  while (ids.has(newNodeId)) {
    newNodeId = `${baseId}${counter}`;
    counter += 1;
  }
  const copy: CanvasNode = {
    ...cloneNode(source),
    id: newNodeId,
    name: `${source.name} 副本`,
    pos: { x: source.pos.x + 40, y: source.pos.y + 60 },
    ortho: { x: source.ortho.x + offsetMm.x, y: source.ortho.y + offsetMm.y }
  };
  return {
    graph: { ...cloneGraph(graph), nodes: [...graph.nodes.map(cloneNode), copy] },
    newNodeId,
    reason: `已复制 ${source.name} → ${copy.name}（孤立节点，需手动连线）`
  };
}
