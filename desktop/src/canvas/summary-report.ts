// 方案摘要（一页纸文本，给客户/评审用）
//
// 只写能算出来的数：CT/UPH 走 evaluateFlow，包络走 2D 正交，成本只算查得到价的，
// 缺价逐条列出并标「不完全统计」。不写产能承诺、不写干涉结论、不写没询到的价格。
import { costSummary, machineMetrics, type PriceLookup } from './metrics.ts';
import { buildDimensions } from './dimensions.ts';
import { buildOrthoView } from './view-model.ts';
import type { MachineGraph } from './types.ts';

export interface SchemeReport {
  text: string;
  /** 章节标题，便于 UI 折叠或单测断言。 */
  sections: string[];
  pendingQuoteCount: number;
  cycleSeconds: number;
  unitsPerHour: number;
  totalCostYuan: number;
}

function fmt(value: number, digits = 0): string {
  return value.toFixed(digits);
}

export function buildSchemeReport(graph: MachineGraph, priceLookup: PriceLookup): SchemeReport {
  if (typeof priceLookup !== 'function') {
    throw new Error('priceLookup 必须由调用方注入（摘要里不允许出现内置单价）');
  }
  const metrics = machineMetrics(graph, { priceLookup });
  const cost = costSummary(graph, priceLookup);
  const view = buildOrthoView(graph);
  const dims = buildDimensions(view, null);
  const width = Math.round(view.boundsMm.maxX - view.boundsMm.minX);
  const height = Math.round(view.boundsMm.maxY - view.boundsMm.minY);
  const di = graph.nodes.reduce((sum, node) => sum + node.io.di, 0);
  const dCount = graph.nodes.reduce((sum, node) => sum + node.io.do, 0);
  const adapterNodes = graph.nodes.filter((node) => node.kind === 'adapter');
  const adapterMass = adapterNodes.reduce((sum, node) => sum + node.massKg, 0);
  const mismatch = metrics.mismatchCount ?? 0;

  const lines: string[] = [];
  lines.push(`# ${graph.title ?? graph.schemeId}`);
  lines.push('');
  lines.push('## 1. 概况');
  lines.push(`- 方案编号：${graph.schemeId}`);
  lines.push(`- 工位/节点：${graph.nodes.length} 个节点，其中转接板 ${adapterNodes.length} 块`);
  lines.push(`- 布局口径：${graph.layout ?? 'single'}`);
  if (graph.targetPerMin !== undefined) {
    const gap = metrics.throughputPerMin - graph.targetPerMin;
    lines.push(
      `- 目标产能：${fmt(graph.targetPerMin, 2)} 件/分钟；实际 ${fmt(metrics.throughputPerMin, 2)} 件/分钟（${
        gap >= 0 ? `达成 +${fmt(gap, 2)}` : `缺口 ${fmt(Math.abs(gap), 2)}`
      }，按 evaluateFlow 口径）`
    );
  }
  lines.push('');
  lines.push('## 2. 节拍与产能');
  lines.push(`- 整机 CT：${fmt(metrics.cycleSeconds, 2)} s/件（machine/flow.ts evaluateFlow，不是各步时间相加）`);
  lines.push(`- UPH：${fmt(metrics.unitsPerHour, 0)} 件/小时`);
  lines.push('');
  lines.push('## 3. 占地与排布');
  lines.push(`- 包络：${width}×${height} mm（含运动行程包络，非静态外形）`);
  lines.push(`- 工位中心距：${dims.chains.filter((chain) => chain.kind === 'pitch').length} 段`);
  lines.push(
    `- 示意重叠：${dims.overlaps.length} 处（2D 示意坐标，不代表干涉，装配关系需 3D/图纸确认）`
  );
  lines.push('');
  lines.push('## 4. 端口与转接板');
  lines.push(`- 端口不匹配边：${mismatch} 条`);
  lines.push(
    `- 转接板：${adapterNodes.length} 块，合计 ${adapterMass.toFixed(2)} kg（非标机加工件，价格需询价）`
  );
  lines.push('');
  lines.push('## 5. 成本');
  lines.push(
    `- 已计价合计：¥${fmt(cost.totalYuan, 2)}（${cost.pricedNodes} 个节点有价${
      cost.pendingQuote.length > 0 ? `，${cost.pendingQuote.length} 项待询价，总额为不完全统计` : '，价格齐全'
    }）`
  );
  if (cost.pendingQuote.length > 0) {
    lines.push('- 待询价清单：');
    for (const item of cost.pendingQuote) {
      lines.push(`  - ${item.name}（${item.partId ?? '无 partId'}）`);
    }
  }
  lines.push('');
  lines.push('## 6. 控制点');
  lines.push(`- DI：${di} 点，DO：${dCount} 点，合计 ${di + dCount} 点（节点级统计，未分配到具体模块）`);
  lines.push('');
  lines.push('## 7. 口径声明');
  lines.push('- 产能数据来自 evaluateFlow 的布局模型，未含上下料、换型、故障停机等现场损失。');
  lines.push('- 2D 排布为示意坐标，工位包围盒允许重叠；干涉结论需 3D 校核，本摘要不含。');
  lines.push('- 成本只统计已查到的单价，缺价项不计入合计，需询价后更新。');
  lines.push('- 本摘要由画布数据自动生成，不含人工承诺。');

  return {
    text: `${lines.join('\n')}\n`,
    sections: ['概况', '节拍与产能', '占地与排布', '端口与转接板', '成本', '控制点', '口径声明'],
    pendingQuoteCount: cost.pendingQuote.length,
    cycleSeconds: metrics.cycleSeconds,
    unitsPerHour: metrics.unitsPerHour,
    totalCostYuan: cost.totalYuan
  };
}
