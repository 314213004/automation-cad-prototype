// 导出物：只生成**文本**，不执行、不落盘、不调内核。
//
// 三个交付物：
//   1. Machine Graph JSON —— 稳定字段顺序，供下游 IR/回放/回归比对；
//   2. build123d Python 脚本 —— 文本，含转接板参数化孔位，需外部 build123d + OCCT 环境执行；
//   3. IEC 61131-3 ST —— 优先复用 plcgen（generatePlcSt），缺点位数据时降级为
//      「只导出 Graph JSON IR + supported:false + reason」，绝不另写一套 ST 模板。
//
// 边界（对外表述口径）：build123d 真实建模未落地，这里只是生成请求参数；
// ST 需要 plcgen 机型配置（点位地址/机构类型/安全回路），画布节点只有 IO 点数。
import { generatePlcSt } from '../plcgen/st.ts';
import { precheck } from '../plcgen/precheck.ts';
import type { PlcGenConfig } from '../plcgen/types.ts';
import { findMismatchedEdges, isAdapterNode, portDiff } from './graph.ts';
import type { PriceLookup } from './metrics.ts';
import type { CanvasNode, MachineGraph, MountPort } from './types.ts';

/** 导出 schema 版本；改字段必须升版本，避免下游静默错读。 */
export const MACHINE_GRAPH_SCHEMA_VERSION = '1.0.0-canvas-graph';

function portJson(port: MountPort): Record<string, string | number> {
  // 字段顺序固定：family → holeDiaMm → pitchXMm → pitchYMm → count
  return {
    family: port.family,
    holeDiaMm: port.holeDiaMm,
    pitchXMm: port.pitchXMm,
    pitchYMm: port.pitchYMm,
    count: port.count
  };
}

function nodeJson(node: CanvasNode): Record<string, unknown> {
  // 固定字段顺序：标识 → 几何 → 端口 → 节拍/质量 → 画布坐标 → 可选字段
  const payload: Record<string, unknown> = { id: node.id, kind: node.kind, name: node.name, spec: node.spec };
  if (node.partId !== undefined) payload.partId = node.partId;
  payload.dimsMm = [node.dimsMm[0], node.dimsMm[1], node.dimsMm[2]];
  payload.portIn = portJson(node.portIn);
  payload.portOut = portJson(node.portOut);
  payload.strokeMm = node.strokeMm;
  payload.leadMm = node.leadMm;
  payload.massKg = node.massKg;
  payload.stepSec = node.stepSec;
  payload.io = { di: node.io.di, do: node.io.do, desc: node.io.desc };
  payload.pos = { x: node.pos.x, y: node.pos.y };
  payload.ortho = { x: node.ortho.x, y: node.ortho.y };
  if (node.station !== undefined) payload.station = node.station;
  if (node.adapter !== undefined) payload.adapter = node.adapter;
  if (node.adapterParams !== undefined) {
    payload.adapterParams = {
      fromPort: portJson(node.adapterParams.fromPort),
      toPort: portJson(node.adapterParams.toPort),
      plateDimsMm: [
        node.adapterParams.plateDimsMm[0],
        node.adapterParams.plateDimsMm[1],
        node.adapterParams.plateDimsMm[2]
      ],
      thicknessMm: node.adapterParams.thicknessMm,
      material: node.adapterParams.material,
      counterBore: node.adapterParams.counterBore,
      dowelDiaMm: node.adapterParams.dowelDiaMm,
      massKg: node.adapterParams.massKg,
      costYuan: node.adapterParams.costYuan
    };
  }
  if (node.notes !== undefined) payload.notes = node.notes;
  return payload;
}

/**
 * 统一整机拓扑 IR（Machine Graph JSON）。
 *
 * 稳定字段顺序 + 边按 (from, to, id) 排序：同一张图无论边数组顺序如何，输出的字节一致，
 * 才能做黄金样例回归。节点顺序保持不变——拓扑链序是有语义的。
 * 不含任何金额：金额必须走调用方注入的价格查询（metrics.costSummary）。
 */
export function buildMachineGraphJson(graph: MachineGraph): string {
  const nodes = graph.nodes.map((node) => nodeJson(node));
  const edges = [...graph.edges]
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to }))
    .sort((left, right) =>
      left.from.localeCompare(right.from, 'en') ||
      left.to.localeCompare(right.to, 'en') ||
      left.id.localeCompare(right.id, 'en')
    );
  const mismatches = findMismatchedEdges(graph);
  const payload: Record<string, unknown> = {
    schemaVersion: MACHINE_GRAPH_SCHEMA_VERSION,
    schemeId: graph.schemeId
  };
  if (graph.title !== undefined) payload.title = graph.title;
  payload.layout = graph.layout ?? 'single';
  payload.summary = {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    adapterCount: graph.nodes.filter((node) => isAdapterNode(node)).length,
    mismatchedEdgeCount: mismatches.length
  };
  payload.nodes = nodes;
  payload.edges = edges;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// build123d
// ---------------------------------------------------------------------------

export interface Build123dOptions {
  /** 导出文件名（assembly 里的 export_step 用），缺省 'machine_assembly.step'。 */
  outputStep?: string;
  /** 板外形圆角半径 mm，缺省取 min(6, 板厚)。 */
  cornerRadiusMm?: number;
}

function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(safe) ? `n_${safe}` : safe;
}

function fmtNum(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

interface GridLayout {
  cols: number;
  rows: number;
}

/** 孔阵列简化排布：2 孔 1×2，4 孔 2×2，6 孔 2×3，单孔居中。 */
function gridLayout(count: number): GridLayout {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count % 2 === 0) return { cols: 2, rows: Math.ceil(count / 2) };
  return { cols: 1, rows: count };
}

function adapterFunctionName(node: CanvasNode): string {
  // adapter 节点 id 常形如 n_adapter_A__B，去掉前缀避免 build_adapter_n_adapter_A__B
  const bare = node.id.replace(/^n_adapter_/, '').replace(/^adapter_/, '');
  return `build_adapter_${sanitizeId(bare)}`;
}

function adapterFunction(node: CanvasNode, cornerRadiusMm: number): string {
  const params = node.adapterParams;
  const [width, height, thickness] = node.dimsMm;
  if (!params) {
    return (
      `def ${adapterFunctionName(node)}():\n` +
      `    """${node.name}：缺 adapterParams，无法参数化生成（仅占位包围盒）"""\n` +
      `    return Box(${fmtNum(width)}, ${fmtNum(height)}, ${fmtNum(thickness)})\n`
    );
  }
  const from = params.fromPort;
  const to = params.toPort;
  const fromGrid = gridLayout(from.count);
  const toGrid = gridLayout(to.count);
  const plateThickness = params.thicknessMm;
  const holeRadiusFrom = from.holeDiaMm / 2;
  const holeRadiusTo = to.holeDiaMm / 2;
  const counterBoreRadius = holeRadiusFrom + 2.5;
  const counterBoreDepth = Number((plateThickness * 0.45).toFixed(2));
  const lines: string[] = [];
  lines.push(`def ${adapterFunctionName(node)}():`);
  lines.push(`    """${node.name}`);
  lines.push(`    端口 A（母件侧 portIn）：${from.family} · 孔 ${from.holeDiaMm}mm · 孔距 ${from.pitchXMm}×${from.pitchYMm}mm · ${from.count} 孔`);
  lines.push(`    端口 B（子件侧 portOut）：${to.family} · 孔 ${to.holeDiaMm}mm · 孔距 ${to.pitchXMm}×${to.pitchYMm}mm · ${to.count} 孔`);
  lines.push(`    材料 ${params.material}，板厚 ${plateThickness}mm。本函数由参数驱动，改孔位无需改脚本。"""`);
  lines.push('    with BuildPart() as plate:');
  lines.push('        with BuildSketch():');
  lines.push(`            RectangleRounded(${fmtNum(width)}, ${fmtNum(height)}, radius=${fmtNum(cornerRadiusMm)})`);
  lines.push(`        Extrude(amount=${fmtNum(plateThickness)})`);
  lines.push(`        # 端口 A 孔阵列（${fromGrid.cols}×${fromGrid.rows}，${params.counterBore ? '沉头孔' : '通孔'}）`);
  lines.push(`        with Locations(GridLocations(${fmtNum(from.pitchXMm)}, ${fmtNum(from.pitchYMm)}, ${fromGrid.cols}, ${fromGrid.rows})):`);
  if (params.counterBore) {
    lines.push(
      `            CounterBoreHole(radius=${fmtNum(holeRadiusFrom)}, counter_bore_radius=${fmtNum(counterBoreRadius)}, counter_bore_depth=${fmtNum(counterBoreDepth)})`
    );
  } else {
    lines.push(`            Hole(radius=${fmtNum(holeRadiusFrom)})`);
  }
  lines.push(`        # 端口 B 孔阵列（${toGrid.cols}×${toGrid.rows}）`);
  if (to.pitchXMm > 0 || to.pitchYMm > 0 || to.count > 1) {
    lines.push(`        with Locations(GridLocations(${fmtNum(to.pitchXMm)}, ${fmtNum(to.pitchYMm)}, ${toGrid.cols}, ${toGrid.rows})):`);
    lines.push(`            Hole(radius=${fmtNum(holeRadiusTo)})`);
  } else {
    lines.push(`        Hole(radius=${fmtNum(holeRadiusTo)})  # 单孔居中（端口 B 无孔距）`);
  }
  if (params.dowelDiaMm > 0) {
    lines.push(`        # 定位销孔（对角布置，Ø${fmtNum(params.dowelDiaMm)}mm）`);
    lines.push(
      `        with Locations(((-${fmtNum(width)} / 2 + 12, -${fmtNum(height)} / 2 + 12), (${fmtNum(width)} / 2 - 12, ${fmtNum(height)} / 2 - 12))):`
    );
    lines.push(`            Hole(radius=${fmtNum(params.dowelDiaMm / 2)})`);
  }
  lines.push('    return plate.part');
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成 build123d Python 脚本文本（**不执行**）。
 *
 * 内容：节点占位包围盒 + 每个转接板一个参数化函数（孔位/沉头/销孔全部来自
 * adapterParams 的两端端口）+ 装配函数 + export_step 调用。
 * 诚实边界：占位体是 Box，不是真实零件外形；转接板真实建模需 build123d 环境执行本脚本。
 */
export function build123dScript(graph: MachineGraph, options: Build123dOptions = {}): string {
  const adapters = graph.nodes.filter((node) => isAdapterNode(node));
  const mismatches = findMismatchedEdges(graph);
  const outputStep = options.outputStep ?? 'machine_assembly.step';
  const lines: string[] = [];

  lines.push('# -*- coding: utf-8 -*-');
  lines.push('# 由 AutomationCAD 无限画布工作台生成（P1 文本导出，生成器不执行本脚本）');
  lines.push(`# 方案：${graph.title ?? graph.schemeId}（schemeId=${graph.schemeId}）`);
  lines.push(`# 构件 ${graph.nodes.length} 件，其中非标转接板 ${adapters.length} 件；端口不兼容直连边 ${mismatches.length} 条`);
  lines.push('# 依赖：build123d + OCCT。缺内核时本脚本只能作为参数单/图纸参数使用，不能声称已建模。');
  lines.push('# 单位：mm。所有孔位由 MountPort 全字段（family/holeDiaMm/pitchXMm/pitchYMm/count）驱动。');
  lines.push('');
  lines.push('from build123d import *');
  lines.push('');

  if (adapters.length === 0) {
    lines.push('# 当前拓扑端口全部匹配，无需转接板。');
    lines.push('');
  }

  for (const adapter of adapters) {
    const cornerRadius = options.cornerRadiusMm ?? Math.min(6, adapter.adapterParams?.thicknessMm ?? 6);
    lines.push(adapterFunction(adapter, cornerRadius));
  }

  lines.push('def build_machine_assembly():');
  lines.push('    """按画布 2D 正交坐标（mm）摆放各构件的占位包围盒；只用于装配定位参考。"""');
  lines.push('    parts = {}');
  for (const node of graph.nodes) {
    const [dx, dy, dz] = node.dimsMm;
    const x = node.ortho.x;
    const y = node.ortho.y;
    lines.push(`    # ${node.id} · ${node.name} · portIn ${node.portIn.family} → portOut ${node.portOut.family}`);
    if (isAdapterNode(node)) {
      lines.push(`    parts["${node.id}"] = ${adapterFunctionName(node)}().moved(Location((${fmtNum(x)}, ${fmtNum(y)}, 0)))`);
    } else {
      lines.push(
        `    parts["${node.id}"] = Box(${fmtNum(dx)}, ${fmtNum(dy)}, ${fmtNum(dz)}).moved(Location((${fmtNum(x)}, ${fmtNum(y)}, ${fmtNum(dz / 2)})))`
      );
    }
  }
  lines.push('    return Compound(children=list(parts.values()))');
  lines.push('');
  lines.push('');
  lines.push('if __name__ == "__main__":');
  lines.push('    assy = build_machine_assembly()');
  lines.push(`    export_step(assy, "${outputStep}")`);
  lines.push('    print("exported:", "' + outputStep + '")');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PLC ST
// ---------------------------------------------------------------------------

export interface PlcStOptions {
  /**
   * plcgen 机型配置（点位地址、机构类型、工位、安全回路）。由调用方注入——
   * 画布节点只有 IO 点数，编造点位地址会生成跑不起来的程序。
   */
  plcConfig?: PlcGenConfig;
  /** 取哪个生成文件的正文，缺省 'src/OB1_Main.st'（主程序）。 */
  file?: string;
}

export interface PlcStResult {
  supported: boolean;
  /** supported=false 时的人话原因（会直接显示给用户）。 */
  reason: string;
  /** supported=true 时的 ST 正文；false 时 null。 */
  content: string | null;
  /** supported=false 时给下游的 IR（Graph JSON），可作为 plcgen 输入的前置数据。 */
  graphIr: string | null;
  /** plcgen 生成的全部文件（supported=true 时非空）。 */
  files: Array<{ path: string; content: string }>;
}

/**
 * IEC 61131-3 ST 导出。
 *
 * 两条路：
 * - 有 plcConfig → 直接调 plcgen 的 generatePlcSt（同一个生成器，不复制模板）；
 * - 没有 plcConfig → 返回 supported:false + 原因 + Graph JSON IR，让人去补点位，
 *   而不是拿 IO 点数编一套假地址。
 */
export function plcSt(graph: MachineGraph, options: PlcStOptions = {}): PlcStResult {
  const mismatches = findMismatchedEdges(graph);
  if (!options.plcConfig) {
    const graphIr = buildMachineGraphJson(graph);
    return {
      supported: false,
      reason:
        '画布节点只记录 IO 点数（io.di / io.do），没有 PLC 点位地址、执行机构类型与安全回路配置；' +
        'plcgen 需要 PlcGenConfig（commission 机型配置），从点数编造地址会生成跑不起来的程序。' +
        `请注入 plcConfig 后重试；当前图为 ${graph.nodes.length} 节点 / ${mismatches.length} 条端口不兼容边。`,
      content: null,
      graphIr,
      files: []
    };
  }

  let files: Array<{ path: string; content: string }>;
  try {
    // 先用 plcgen 自己的预检把关：缺急停/安全门等硬伤时不生成"看着像代码"的 ST，
    // 而是明确降级为「补配置」，避免交付一份跑不起来的程序。
    const checked = precheck(options.plcConfig);
    if (checked.errors.length > 0) {
      return {
        supported: false,
        reason:
          `plcgen 预检未通过（${checked.errors.length} 项）：` +
          checked.errors.slice(0, 3).map((issue) => `${issue.code} ${issue.message}`).join('；') +
          '。请补齐点位/安全回路后重试。',
        content: null,
        graphIr: buildMachineGraphJson(graph),
        files: []
      };
    }
    const result = generatePlcSt({ config: options.plcConfig });
    files = result.files.map((file) => ({ path: file.path, content: file.content }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      supported: false,
      reason: `plcgen 拒绝了该机型配置：${message}`,
      content: null,
      graphIr: buildMachineGraphJson(graph),
      files: []
    };
  }
  if (files.length === 0) {
    return {
      supported: false,
      reason: 'plcgen 未产出任何 ST 文件（配置里没有可生成的机构/点位）。',
      content: null,
      graphIr: buildMachineGraphJson(graph),
      files: []
    };
  }
  const wanted = options.file ?? 'src/OB1_Main.st';
  const target = files.find((file) => file.path === wanted) ?? files[0];
  return {
    supported: true,
    reason: `已复用 plcgen 生成 ${files.length} 个 ST 文件（正文取自 ${target?.path ?? wanted}）。`,
    content: target?.content ?? null,
    graphIr: null,
    files
  };
}

// ---------------------------------------------------------------------------
// 端口兼容报告（给导出预览用的人话摘要）
// ---------------------------------------------------------------------------

export interface PortReportLine {
  edgeId: string;
  fromId: string;
  toId: string;
  compatible: boolean;
  detail: string;
}

/** 逐边列出端口对比结果，导出预览与冒烟断言都用它。 */
export function portReport(graph: MachineGraph): PortReportLine[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      return {
        edgeId: edge.id,
        fromId: edge.from,
        toId: edge.to,
        compatible: false,
        detail: '端点不存在'
      };
    }
    const diff = portDiff(from.portOut, to.portIn);
    return {
      edgeId: edge.id,
      fromId: edge.from,
      toId: edge.to,
      compatible: diff.length === 0,
      detail: diff.length === 0 ? '端口全字段匹配' : `不匹配字段：${diff.join('、')}`
    };
  });
}


// ---------------------------------------------------------------------------
// BOM CSV
// ---------------------------------------------------------------------------

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface BomCsvResult {
  csv: string;
  /** 有价行数 / 待询价行数 / 已计价合计。 */
  pricedRows: number;
  pendingRows: number;
  totalYuan: number;
}

/**
 * BOM CSV（文本，不落盘）。列顺序固定：序号,名称,型号,数量,单价,小计,状态,备注。
 * 缺价行单价/小计留空、状态写「待询价」，末尾汇总行标注「不完全统计」——
 * 缺价既不能当 0，也不能从表里悄悄消失。
 */
export function buildBomCsv(graph: MachineGraph, priceLookup: PriceLookup): BomCsvResult {
  const rows: string[] = ['序号,名称,型号,数量,单价,小计,状态,备注'];
  let pricedRows = 0;
  let pendingRows = 0;
  let total = 0;
  let index = 1;
  for (const node of graph.nodes) {
    const partId = node.partId ?? '';
    const price = partId ? priceLookup(partId) : null;
    const priced = typeof price === 'number' && Number.isFinite(price) && price >= 0;
    if (priced) {
      pricedRows += 1;
      total += price as number;
    } else {
      pendingRows += 1;
    }
    rows.push(
      [
        csvCell(index),
        csvCell(node.name),
        csvCell(partId || '待选型'),
        csvCell(1),
        priced ? csvCell((price as number).toFixed(2)) : '',
        priced ? csvCell((price as number).toFixed(2)) : '',
        csvCell(priced ? '已计价' : '待询价'),
        csvCell(isAdapterNode(node) ? '非标转接板' : node.spec)
      ].join(',')
    );
    index += 1;
  }
  rows.push('');
  rows.push(
    [
      csvCell('合计'),
      csvCell(`已计价 ${pricedRows} 行`),
      csvCell(`待询价 ${pendingRows} 行`),
      '',
      '',
      csvCell(total.toFixed(2)),
      csvCell(pendingRows > 0 ? '不完全统计' : '价格齐全'),
      csvCell(pendingRows > 0 ? '缺价行不计入合计，需询价后更新' : '')
    ].join(',')
  );
  return { csv: `${rows.join('\n')}\n`, pricedRows, pendingRows, totalYuan: Number(total.toFixed(2)) };
}
