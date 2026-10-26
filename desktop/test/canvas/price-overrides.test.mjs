import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANVAS_PRICING_SCHEMA,
  MAX_UNIT_PRICE_YUAN,
  createOverrideLookup,
  emptyManualPrices,
  parseManualPrices,
  removeManualPrice,
  setManualPrice,
  summarizeOverrides,
  validateUnitPrice
} from '../../src/canvas/price-overrides.ts';

const NOW = '2026-10-26T12:00:00+08:00';

test('setManualPrice：写入后可查，原书不变（纯函数）', () => {
  const book = emptyManualPrices();
  const result = setManualPrice(book, 'adapter-A', 320, NOW, ' 钣金折弯件 ');
  assert.equal(result.error, null);
  assert.equal(result.book.items['adapter-A'].unitPriceYuan, 320);
  assert.equal(result.book.items['adapter-A'].note, '钣金折弯件');
  assert.deepEqual(book.items, {}, '入参不能被改');
});

test('validateUnitPrice：0 / 负数 / NaN / 超大都被拒并给中文原因', () => {
  assert.match(validateUnitPrice(0), /必须大于 0/);
  assert.match(validateUnitPrice(-5), /必须大于 0/);
  assert.match(validateUnitPrice(Number.NaN), /必须是数字/);
  assert.match(validateUnitPrice(MAX_UNIT_PRICE_YUAN + 1), /疑似录错/);
  assert.equal(validateUnitPrice(0.01), null);
});

test('setManualPrice：非法价格整条拒绝，不把原值改坏', () => {
  const book = setManualPrice(emptyManualPrices(), 'p1', 100, NOW).book;
  const bad = setManualPrice(book, 'p1', -1, NOW);
  assert.match(bad.error, /必须大于 0/);
  assert.equal(bad.book.items['p1'].unitPriceYuan, 100);
});

test('parseManualPrices：坏条目丢弃并报出，好条目保留', () => {
  const raw = {
    schema: CANVAS_PRICING_SCHEMA,
    items: {
      ok: { partId: 'ok', unitPriceYuan: 12.5, updatedAt: NOW },
      zero: { partId: 'zero', unitPriceYuan: 0, updatedAt: NOW },
      junk: 'nope'
    }
  };
  const parsed = parseManualPrices(raw);
  assert.equal(parsed.rejected, false);
  assert.deepEqual(Object.keys(parsed.book.items), ['ok']);
  assert.equal(parsed.issues.length, 2);
});

test('parseManualPrices：schema 不匹配整份拒绝，不猜不迁移', () => {
  const parsed = parseManualPrices({ schema: 'other/1', items: {} });
  assert.equal(parsed.rejected, true);
  assert.match(parsed.issues[0].message, /schema 不匹配/);
  assert.deepEqual(parsed.book.items, {});
});

test('createOverrideLookup：手工价优先于价格簿，都没有返回 null', () => {
  const manual = setManualPrice(emptyManualPrices(), 'MHZ2-20D', 999, NOW).book;
  const lookup = createOverrideLookup(manual, (partId) => (partId === 'MHZ2-20D' ? 268 : partId === 'x' ? 10 : null));
  assert.equal(lookup('MHZ2-20D'), 999);
  assert.equal(lookup('x'), 10);
  assert.equal(lookup('unknown'), null);
  assert.equal(lookup(''), null);
});

test('removeManualPrice：删掉后回落到价格簿', () => {
  const book = setManualPrice(emptyManualPrices(), 'p1', 50, NOW).book;
  const cleared = removeManualPrice(book, 'p1');
  assert.equal(createOverrideLookup(cleared, () => 7)('p1'), 7);
  assert.equal(removeManualPrice(cleared, 'p1'), cleared, '不存在时原样返回');
});

test('summarizeOverrides：条数与最近更新时间', () => {
  let book = setManualPrice(emptyManualPrices(), 'a', 10, '2026-10-01T00:00:00+08:00').book;
  book = setManualPrice(book, 'b', 20, NOW).book;
  assert.deepEqual(summarizeOverrides(book), { count: 2, latest: NOW });
  assert.deepEqual(summarizeOverrides(emptyManualPrices()), { count: 0, latest: null });
});
