import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRICEBOOK_EXAMPLE_SOURCE,
  isUsablePricebookItem,
  parsePricebook,
  validatePricebook
} from '../src/cost/pricebook.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;

const builtin = JSON.parse(
  readFileSync(new URL('../../packs/builtin/pricebook-cn/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;

function book(): Record<string, any> {
  return structuredClone(fixture);
}

test('价格簿：合法 fixture 通过校验并保留币种与费率', () => {
  const result = validatePricebook(book());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.items['PART-QF']?.list, 78);
  assert.equal(result.labor.panelWiringPerPoint, 12);
  assert.equal(result.accessories.wirePerMeter['2.5'], 4.8);
});

test('价格簿：schemaVersion 必须为 1', () => {
  const value = book();
  value.schemaVersion = 2;
  assert.throws(() => validatePricebook(value), /schemaVersion 必须为 1/);
});

test('价格簿：币种必须是 3 个字母', () => {
  for (const currency of ['CN', 'RMB1', 156]) {
    const value = book();
    value.currency = currency;
    assert.throws(() => validatePricebook(value), /currency 必须是 3 个字母的币种代码/);
  }
});

test('价格簿：updatedAt 必须带时区', () => {
  const value = book();
  value.updatedAt = '2026-10-23T00:00:00';
  assert.throws(() => validatePricebook(value), /updatedAt 必须带时区/);
});

test('价格簿：updatedAt 必须是合法日期', () => {
  const value = book();
  value.updatedAt = '2026-13-40T00:00:00+08:00';
  assert.throws(() => validatePricebook(value), /updatedAt 必须带时区/);
});

test('价格簿：pricebook 自身 updatedAt 允许 Z 结尾', () => {
  const value = book();
  value.updatedAt = '2026-10-22T16:00:00Z';
  assert.doesNotThrow(() => validatePricebook(value));
});

test('价格簿：目录价必须是非负有限数', () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, '78']) {
    const value = book();
    value.items['PART-QF'].list = amount;
    assert.throws(() => validatePricebook(value), /list 必须是非负有限数/);
  }
});

test('价格簿：阶梯价金额也必须非负有限', () => {
  const negative = book();
  negative.items['PART-QF'].tiers[0].price = -0.01;
  assert.throws(() => validatePricebook(negative), /tiers\[0\]\.price 必须是非负有限数/);

  const infinite = book();
  infinite.items['PART-QF'].tiers[1].price = Number.POSITIVE_INFINITY;
  assert.throws(() => validatePricebook(infinite), /tiers\[1\]\.price 必须是非负有限数/);
});

test('价格簿：tiers.minQty 必须唯一', () => {
  const value = book();
  value.items['PART-QF'].tiers[1].minQty = 1;
  assert.throws(() => validatePricebook(value), /minQty 必须严格递增且唯一/);
});

test('价格簿：tiers.minQty 必须严格递增', () => {
  const value = book();
  value.items['PART-QF'].tiers = [
    { minQty: 10, price: 68 },
    { minQty: 5, price: 60 }
  ];
  assert.throws(() => validatePricebook(value), /minQty 必须严格递增且唯一/);
});

test('价格簿：tiers.minQty 必须是正整数', () => {
  for (const minQty of [0, -1, 1.5, '10']) {
    const value = book();
    value.items['PART-QF'].tiers[0].minQty = minQty;
    assert.throws(() => validatePricebook(value), /minQty 必须是正整数/);
  }
});

test('价格簿：人工费率必须非负有限', () => {
  const value = book();
  value.labor.assemblyHourly = -120;
  assert.throws(() => validatePricebook(value), /labor\.assemblyHourly 必须是非负有限数/);
});

test('价格簿：辅材费率与线缆分档必须非负有限', () => {
  const rail = book();
  rail.accessories.dinRail35PerMeter = Number.NaN;
  assert.throws(() => validatePricebook(rail), /dinRail35PerMeter 必须是非负有限数/);

  const wire = book();
  wire.accessories.wirePerMeter['4'] = -7.5;
  assert.throws(() => validatePricebook(wire), /wirePerMeter\.4 必须是非负有限数/);
});

test('价格簿：缺省 labor 与 accessories 时填入工程默认值', () => {
  const value = book();
  delete value.labor;
  delete value.accessories;
  const result = validatePricebook(value);
  assert.equal(result.labor.panelWiringPerPoint, 12);
  assert.equal(result.accessories.dinRail35PerMeter, 18);
  assert.match(result.labor.source ?? '', /工程默认值，非官方报价/);
});

test('价格簿：JSON 语法错误返回中文错误', () => {
  assert.throws(() => parsePricebook('{ bad json'), /价格簿不是合法 JSON/);
});

test('内置价格簿：4 条示例条目均明确标注且不参与真实报告', () => {
  const result = validatePricebook(builtin);
  const entries = Object.entries(result.items);
  assert.equal(entries.length, 4);
  for (const [, item] of entries) {
    assert.equal(item.source, PRICEBOOK_EXAMPLE_SOURCE);
    assert.equal(item.example, true);
    assert.equal(isUsablePricebookItem(item), false);
  }
});

test('内置价格簿：人工与辅材默认值注明非官方报价', () => {
  const result = validatePricebook(builtin);
  assert.match(result.labor.source ?? '', /工程默认值，非官方报价/);
  assert.match(result.accessories.source ?? '', /工程默认值，非官方报价/);
  assert.match(result.source, /示例，需替换|工程默认值/);
});
