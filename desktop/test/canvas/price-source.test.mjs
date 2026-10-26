import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { validatePricebook } from '../../src/cost/pricebook.ts';
import {
  createPricebookLookup,
  describePriceSource,
  summarizePricebook
} from '../../src/canvas/price-source.ts';

const NOW = new Date('2026-10-26T00:00:00+08:00');

function book(items) {
  return { currency: 'CNY', updatedAt: '2026-10-24T00:00:00+08:00', source: '测试价格簿', items };
}

test('createPricebookLookup：命中 list 价，查不到返回 null', () => {
  const lookup = createPricebookLookup(book({ 'MHZ2-20D': { list: 1109 } }));
  assert.equal(lookup('MHZ2-20D'), 1109);
  assert.equal(lookup('不存在'), null);
  assert.equal(lookup(''), null);
});

test('createPricebookLookup：示例条目与示例来源一律不计价', () => {
  const lookup = createPricebookLookup(
    book({
      A: { list: 100, example: true },
      B: { list: 100, source: '示例，需替换' }
    })
  );
  assert.equal(lookup('A'), null);
  assert.equal(lookup('B'), null);
});

test('createPricebookLookup：非正/非有限单价不计价（不把 0 当成免费）', () => {
  const lookup = createPricebookLookup(book({ A: { list: 0 }, B: { list: Number.NaN }, C: { list: -5 } }));
  assert.equal(lookup('A'), null);
  assert.equal(lookup('B'), null);
  assert.equal(lookup('C'), null);
});

test('createPricebookLookup：阶梯价按数量取满足条件的最高 minQty', () => {
  const items = { A: { list: 100, tiers: [{ minQty: 10, price: 90 }, { minQty: 50, price: 80 }] } };
  assert.equal(createPricebookLookup(book(items), { qty: 1 })('A'), 100);
  assert.equal(createPricebookLookup(book(items), { qty: 10 })('A'), 90);
  assert.equal(createPricebookLookup(book(items), { qty: 99 })('A'), 80);
});

test('createPricebookLookup：空书 / 缺 items 时不猜价', () => {
  assert.equal(createPricebookLookup(null)('A'), null);
  assert.equal(createPricebookLookup({ items: null })('A'), null);
  assert.equal(createPricebookLookup({})('A'), null);
});

test('summarizePricebook：分别统计可计价、示例、过期条目', () => {
  const summary = summarizePricebook(
    book({
      fresh: { list: 100, checkedAt: '2026-10-20' },
      stale: { list: 200, checkedAt: '2025-01-01' },
      example: { list: 300, example: true },
      invalid: { list: 0 }
    }),
    { now: NOW }
  );
  assert.ok(summary);
  assert.equal(summary.usable, 2, 'fresh + stale 都算可计价，invalid 不算');
  assert.equal(summary.examples, 1);
  assert.equal(summary.stale, 1);
  assert.equal(summary.currency, 'CNY');
  assert.equal(summary.updatedAt, '2026-10-24T00:00:00+08:00');
  assert.equal(summarizePricebook(null), null);
});

test('describePriceSource：说清可计价条数/示例/更新日/过期，未接入时明说', () => {
  const text = describePriceSource({
    currency: 'CNY',
    updatedAt: '2026-10-24T00:00:00+08:00',
    usable: 64,
    examples: 3,
    stale: 2,
    source: '真实条目'
  });
  assert.match(text, /内置价格簿 64 项可计价/);
  assert.match(text, /示例 3 项已排除/);
  assert.match(text, /更新 2026-10-24/);
  assert.match(text, /2 条超 180 天/);
  assert.match(describePriceSource(null), /未接入/);
});

test('真实内置价格簿：能解析、可计价条数 > 0、MHZ2-20D 有真实价', () => {
  const raw = JSON.parse(readFileSync(new URL('../../../packs/builtin/pricebook-cn/pricebook.json', import.meta.url), 'utf8'));
  const parsed = validatePricebook(raw);
  const summary = summarizePricebook(parsed, { now: NOW });
  assert.ok(summary);
  assert.ok(summary.usable >= 50, `可计价条目太少：${summary.usable}`);
  const lookup = createPricebookLookup(parsed);
  assert.equal(lookup('MHZ2-20D'), 1109);
  assert.ok(lookup('SV660PS5R5I') > 0);
  assert.equal(lookup('不存在的型号-xyz'), null);
});
