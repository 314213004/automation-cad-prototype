import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchemeReport } from '../../src/canvas/summary-report.ts';
import { machineMetrics } from '../../src/canvas/metrics.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

test('buildSchemeReport：CT/UPH 与 machineMetrics（evaluateFlow）完全一致', () => {
  const graph = demoCanvasGraph();
  const lookup = () => null;
  const report = buildSchemeReport(graph, lookup);
  const metrics = machineMetrics(graph, { priceLookup: lookup });
  assert.equal(report.cycleSeconds, metrics.cycleSeconds);
  assert.equal(report.unitsPerHour, metrics.unitsPerHour);
  assert.match(report.text, new RegExp(`整机 CT：${metrics.cycleSeconds.toFixed(2)} s/件`));
  assert.match(report.text, /evaluateFlow，不是各步时间相加/);
});

test('buildSchemeReport：缺价逐条列出且声明不完全统计', () => {
  const report = buildSchemeReport(demoCanvasGraph(), (partId) => (partId === 'frame-4040-800x650' ? 2800 : null));
  assert.ok(report.pendingQuoteCount > 0);
  assert.match(report.text, /待询价清单：/);
  assert.match(report.text, /不完全统计/);
  assert.equal(report.totalCostYuan, 2800);
});

test('buildSchemeReport：价格齐全时不出现「不完全统计」', () => {
  const report = buildSchemeReport(demoCanvasGraph(), () => 100);
  assert.equal(report.pendingQuoteCount, 0);
  assert.equal(report.text.includes('不完全统计'), false);
  assert.match(report.text, /价格齐全/);
});

test('buildSchemeReport：章节完整，含包络/端口/口径声明', () => {
  const report = buildSchemeReport(demoCanvasGraph(), () => null);
  assert.deepEqual(report.sections, ['概况', '节拍与产能', '占地与排布', '端口与转接板', '成本', '控制点', '口径声明']);
  assert.match(report.text, /包络：1160×650 mm（含运动行程包络，非静态外形）/);
  assert.match(report.text, /端口不匹配边：1 条/);
  assert.match(report.text, /不代表干涉/);
  assert.match(report.text, /需询价后更新/);
});

test('buildSchemeReport：目标产能给出达成/缺口（按 evaluateFlow）', () => {
  const graph = { ...demoCanvasGraph(), targetPerMin: 100 };
  const report = buildSchemeReport(graph, () => null);
  assert.match(report.text, /目标产能：100\.00 件\/分钟；实际 80\.00 件\/分钟（缺口 20\.00/);
});

test('buildSchemeReport：未注入 priceLookup 直接报错（不许内置价）', () => {
  assert.throws(() => buildSchemeReport(demoCanvasGraph(), undefined), /priceLookup 必须由调用方注入/);
});
