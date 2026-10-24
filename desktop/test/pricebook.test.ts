import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRICEBOOK_EXAMPLE_SOURCE,
  isCheckedAtDate,
  isStalePricebookItem,
  isUsablePricebookItem,
  parsePricebook,
  priceAgeDays,
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

function bookV2(): Record<string, any> {
  const value = book();
  value.schemaVersion = 2;
  for (const [partId, item] of Object.entries(value.items) as Array<[string, Record<string, any>]>) {
    item.model ??= partId;
    item.category ??= '测试件';
    item.source = `https://example.com/${encodeURIComponent(partId)}`;
    item.sourceType = 'distributor';
    item.checkedAt = '2026-10-24';
    item.taxIncluded = true;
  }
  return value;
}

test('价格簿：合法 fixture 通过校验并保留币种与费率', () => {
  const result = validatePricebook(book());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.currency, 'CNY');
  assert.equal(result.items['PART-QF']?.list, 78);
  assert.equal(result.labor.panelWiringPerPoint, 12);
  assert.equal(result.accessories.wirePerMeter['2.5'], 4.8);
});

test('价格簿：schemaVersion 只接受 1 或 2', () => {
  const value = book();
  value.schemaVersion = 3;
  assert.throws(() => validatePricebook(value), /schemaVersion 必须为 1 或 2/);
});

test('价格簿：v2 合法条目保留来源元数据', () => {
  const result = validatePricebook(bookV2());
  assert.equal(result.schemaVersion, 2);
  const item = result.items['PART-QF'];
  assert.equal(item?.sourceType, 'distributor');
  assert.equal(item?.checkedAt, '2026-10-24');
  assert.equal(item?.taxIncluded, true);
  assert.match(item?.source ?? '', /^https:\/\/example\.com\//);
});

test('价格簿：v2 缺少 model 或 category 时拒绝', () => {
  const noModel = bookV2();
  delete noModel.items['PART-QF'].model;
  assert.throws(() => validatePricebook(noModel), /model 必须是非空字符串/);
  const noCategory = bookV2();
  delete noCategory.items['PART-QF'].category;
  assert.throws(() => validatePricebook(noCategory), /category 必须是非空字符串/);
});

test('价格簿：v2 source 必须是可点击的 http(s) URL', () => {
  for (const source of ['本地报价单.xlsx', 'ftp://example.com/price', '']) {
    const value = bookV2();
    value.items['PART-QF'].source = source;
    assert.throws(() => validatePricebook(value), /必须是可打开的 http\(s\) URL/);
  }
});

test('价格簿：v2 sourceType 必须是三种来源类型之一', () => {
  const missing = bookV2();
  delete missing.items['PART-QF'].sourceType;
  assert.throws(() => validatePricebook(missing), /sourceType 必须是/);
  const unknown = bookV2();
  unknown.items['PART-QF'].sourceType = 'web-scrape';
  assert.throws(() => validatePricebook(unknown), /sourceType 必须是/);
});

test('价格簿：v2 checkedAt 必须是合法 YYYY-MM-DD', () => {
  const missing = bookV2();
  delete missing.items['PART-QF'].checkedAt;
  assert.throws(() => validatePricebook(missing), /checkedAt 必须是 YYYY-MM-DD/);
  for (const checkedAt of ['2026-02-30', '2026-10-24T00:00:00+08:00', '20261024']) {
    const value = bookV2();
    value.items['PART-QF'].checkedAt = checkedAt;
    assert.throws(() => validatePricebook(value), /checkedAt 必须是 YYYY-MM-DD/);
  }
});

test('价格簿：v2 taxIncluded 只接受 true/false/null', () => {
  for (const taxIncluded of [0, 1, 'true']) {
    const value = bookV2();
    value.items['PART-QF'].taxIncluded = taxIncluded;
    assert.throws(() => validatePricebook(value), /taxIncluded 必须是 true \/ false \/ null/);
  }
});

test('价格簿：taxIncluded 为 null 时必须在 note 说明', () => {
  const value = bookV2();
  value.items['PART-QF'].taxIncluded = null;
  assert.throws(() => validatePricebook(value), /note 在 taxIncluded 为 null 时必须说明税额情况/);
  value.items['PART-QF'].note = '页面未标注含税状态';
  const result = validatePricebook(value);
  assert.equal(result.items['PART-QF']?.taxIncluded, null);
  assert.match(result.items['PART-QF']?.note ?? '', /未标注/);
});

test('价格簿：v2 明确不含税也可录入', () => {
  const value = bookV2();
  value.items['PART-QF'].taxIncluded = false;
  value.items['PART-QF'].note = '分销商未税价';
  assert.equal(validatePricebook(value).items['PART-QF']?.taxIncluded, false);
});

test('价格簿：v1 旧条目继续可用且不强制新元数据', () => {
  const result = validatePricebook(book());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.items['PART-QF']?.sourceType, undefined);
  assert.equal(result.items['PART-QF']?.checkedAt, undefined);
  assert.equal(isUsablePricebookItem(result.items['PART-QF']!), true);
});

test('价格簿：v2 currency 必须为 CNY', () => {
  const value = bookV2();
  value.currency = 'USD';
  assert.throws(() => validatePricebook(value), /currency 必须为 CNY/);
});

test('价格簿：isCheckedAtDate 严格拒绝非法日期', () => {
  assert.equal(isCheckedAtDate('2026-10-24'), true);
  assert.equal(isCheckedAtDate('2024-02-29'), true);
  assert.equal(isCheckedAtDate('2026-02-29'), false);
  assert.equal(isCheckedAtDate('2026-13-01'), false);
});

test('价格簿：180 天边界与过期判定', () => {
  const item = {
    list: 1,
    sourceType: 'distributor' as const,
    checkedAt: '2026-04-27',
    taxIncluded: true
  };
  assert.equal(priceAgeDays(item, '2026-10-24T00:00:00+08:00'), 180);
  assert.equal(isStalePricebookItem(item, '2026-10-24T00:00:00+08:00'), false);
  assert.equal(isStalePricebookItem(item, '2026-10-24T00:00:01+08:00'), true);
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

test('内置价格簿：示例条目保留但不污染真实条目统计', () => {
  const result = validatePricebook(builtin);
  const examples = Object.entries(result.items).filter(([, item]) => item.example === true);
  const usable = Object.entries(result.items).filter(([, item]) => isUsablePricebookItem(item));
  assert.equal(examples.length, 4);
  assert.ok(usable.length >= 60, `真实条目应 ≥ 60，实际 ${usable.length}`);
  assert.equal(examples.length + usable.length, Object.keys(result.items).length);
  for (const [, item] of examples) {
    assert.equal(item.source, PRICEBOOK_EXAMPLE_SOURCE);
    assert.equal(item.example, true);
    assert.equal(isUsablePricebookItem(item), false);
  }
});

test('内置价格簿：每条真实条目都有可核实来源与 CNY 语义', () => {
  const result = validatePricebook(builtin);
  assert.equal(result.currency, 'CNY');
  const usable = Object.entries(result.items).filter(([, item]) => isUsablePricebookItem(item));
  for (const [partId, item] of usable) {
    assert.ok(item.model, `${partId} 缺 model`);
    assert.ok(item.category, `${partId} 缺 category`);
    assert.match(item.source ?? '', /^https?:\/\//, `${partId} 来源不是 URL`);
    assert.ok(['official-list', 'distributor', 'quote'].includes(item.sourceType ?? ''), `${partId} sourceType 非法`);
    assert.equal(isCheckedAtDate(item.checkedAt ?? ''), true, `${partId} checkedAt 非法`);
    assert.ok(item.taxIncluded === true || item.taxIncluded === false || item.taxIncluded === null, `${partId} taxIncluded 非法`);
    if (item.taxIncluded === null) assert.ok((item.note ?? '').trim(), `${partId} 税额未标注但缺 note`);
  }
});

test('内置价格簿：人工与辅材默认值注明非官方报价', () => {
  const result = validatePricebook(builtin);
  assert.match(result.labor.source ?? '', /工程默认值，非官方报价/);
  assert.match(result.accessories.source ?? '', /工程默认值，非官方报价/);
  assert.match(result.source, /示例，需替换|工程默认值/);
});
