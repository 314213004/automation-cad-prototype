import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { computeCost, type CostReport } from '../src/cost/engine.ts';
import { validatePricebook } from '../src/cost/pricebook.ts';
import {
  MISSING_REASON_LABELS,
  costReportCsv,
  describeCost,
  money,
  moneyWithCurrency,
  renderCostReportHtml
} from '../src/cost/report.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;
const costCase = JSON.parse(
  readFileSync(new URL('./fixtures/cost-case.json', import.meta.url), 'utf8')
) as Record<string, any>;

const NOW = '2026-10-23T12:00:00+08:00';
const book = validatePricebook(fixture);

function report(overrides: Record<string, any> = {}): CostReport {
  return computeCost({ ...costCase, pricebook: book, now: NOW, ...overrides });
}

function emptyReport(): CostReport {
  return computeCost({ bom: [], pricebook: book, now: NOW });
}

const project = { name: '夹具机', code: 'A3-COST', author: '老王', date: '2026-10-23', currency: 'CNY' };

test('金额格式：千分位与两位小数', () => {
  assert.equal(money(0), '0.00');
  assert.equal(money(1398.64), '1,398.64');
  assert.equal(money(1234567.891), '1,234,567.89');
  assert.equal(money(-12.3), '-12.30');
  assert.equal(moneyWithCurrency(1398.64, 'CNY'), '¥1,398.64');
  assert.equal(moneyWithCurrency(10, 'USD'), '$10.00');
  assert.equal(moneyWithCurrency(10, 'HKD'), 'HKD 10.00');
});

test('摘要包含合计、明细行数、缺价与告警数', () => {
  const text = describeCost(report());
  assert.match(text, /合计 ¥1,398\.64/);
  assert.match(text, /明细 6 行/);
  assert.match(text, /缺价 1 项/);
  assert.match(text, /警告 1 条/);
  assert.equal(describeCost(emptyReport()).includes('明细 0 行'), true);
});

test('HTML 报告：标题、元信息与合计一致', () => {
  const html = renderCostReportHtml(project, report());
  assert.match(html, /<title>夹具机 · 机台成本报告<\/title>/);
  assert.match(html, /A3-COST/);
  assert.match(html, /老王/);
  assert.match(html, /2026-10-23/);
  assert.match(html, /1,398\.64/);
  assert.match(html, /@page \{ size: A4 portrait/);
  for (const section of ['总价构成', '硬件明细', '分类小计', '缺价清单', '告警']) {
    assert.equal(html.includes(section), true, `缺少小节：${section}`);
  }
});

test('HTML 报告：明细行数与引擎一致，缺价原因中文化', () => {
  const html = renderCostReportHtml(project, report());
  const bodyRows = html.match(/<td class="mono">/g) ?? [];
  assert.equal(bodyRows.length, 6);
  assert.match(html, /待询价件/);
  assert.match(html, new RegExp(MISSING_REASON_LABELS.NO_PRICE));
});

test('HTML 报告：缺价时结论条带提示样式，全价时不带', () => {
  assert.match(renderCostReportHtml(project, report()), /class="verdict bad"/);
  assert.doesNotMatch(renderCostReportHtml(project, emptyReport()), /class="verdict bad"/);
});

test('HTML 报告：空 BOM 不报错且给出空态文案', () => {
  const html = renderCostReportHtml(project, emptyReport());
  assert.match(html, /没有可计价的物料行/);
  assert.match(html, /全部物料均有价格/);
  assert.match(html, /1,398\.64|0\.00/);
  assert.equal(html.length > 1000, true);
});

test('HTML 报告：项目名/型号中的特殊字符被转义', () => {
  const risky = {
    bom: [{ partId: 'PART-QF', name: '断路器', model: '<img src=x onerror=alert(1)>', qty: 1 }],
    pricebook: book,
    now: NOW
  };
  const html = renderCostReportHtml({ name: '<b>危险</b>' }, computeCost(risky));
  assert.match(html, /&lt;b&gt;危险&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('HTML 报告：币种跟随项目设置', () => {
  const html = renderCostReportHtml({ ...project, currency: 'USD' }, report());
  assert.match(html, /<span>币种<\/span><b>USD<\/b>/);
});

test('CSV：带 UTF-8 BOM、明细 6 行与表头', () => {
  const csv = costReportCsv(report());
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '明细');
  assert.equal(lines[1], '序号,物料号,型号,分类,数量,单价,小计,价格来源,价格天数');
  assert.equal(lines[2], '1,PART-QF,QF-16,断路器,2,78.00,156.00,测试夹具价,52');
});

test('CSV：汇总块含八项金额且合计与引擎一致', () => {
  const csv = costReportCsv(report());
  const totals = report().totals;
  for (const [label, value] of [
    ['硬件', totals.hardware],
    ['辅材', totals.extras],
    ['人工', totals.labor],
    ['小计', totals.subtotal],
    ['加成', totals.markup],
    ['税金', totals.tax],
    ['运费', totals.freight],
    ['合计', totals.grand]
  ] as const) {
    assert.equal(csv.includes(`${label},${(value as number).toFixed(2)}`), true, `汇总缺 ${label}`);
  }
  assert.match(csv, /合计,1398\.64/);
});

test('CSV：缺价、告警块与空态标记', () => {
  const csv = costReportCsv(report());
  assert.match(csv, /\r\n缺价\r\n名称,规格,数量,原因\r\n/);
  assert.match(csv, new RegExp(`待询价件,,1,${MISSING_REASON_LABELS.NO_PRICE}`));
  assert.match(csv, /\r\n告警\r\n内容\r\n/);
  assert.match(csv, /缺价：待询价件（NO_PRICE）/);

  // 价格超过 180 天时效阈值时，告警块必须出现「价格过期」。
  const stale = costReportCsv(computeCost({
    ...costCase,
    pricebook: book,
    now: '2027-06-01T12:00:00+08:00'
  }));
  assert.match(stale, /价格过期：PART-QF/);

  const empty = costReportCsv(emptyReport());
  assert.match(empty, /（无明细）/);
  assert.match(empty, /（无缺价）/);
  assert.match(empty, /（无告警）/);
});

test('CSV：含逗号与引号的字段被正确转义', () => {
  const csv = costReportCsv(computeCost({
    bom: [{ partId: 'PART-QF', name: '断路器', model: 'QF,"16"', category: '断路器, 主回路', qty: 1 }],
    pricebook: book,
    now: NOW
  }));
  assert.match(csv, /"QF,""16"""/);
  assert.match(csv, /"断路器, 主回路"/);
});

test('CSV 与 XML/HTML 不混用：报告 HTML 不含 CSV 分块标记', () => {
  const html = renderCostReportHtml(project, report());
  assert.doesNotMatch(html, /\r\n汇总\r\n/);
  assert.doesNotMatch(html, /^明细\r\n/);
});
