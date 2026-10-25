import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { estimatePower } from '../../src/machine/power.ts';
import {
  DEFAULT_MACHINE_PRICING,
  estimateCost,
  parseMachinePricing
} from '../../src/machine/cost-model.ts';
import { readMachinePricing } from '../../electron/pricing.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { mapMachineBom } from '../../src/machine/bom-map.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { serializeToolResult, toolResultByteLimit } from '../../src/agent/trim.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const builtinDir = join(repoRoot, 'packs', 'builtin');
const fixtureBook = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'pricebook.json'), 'utf8'));

function loadParts() {
  const parts = [];
  for (const packId of ['iec-cn', 'smc-cn']) {
    const rows = JSON.parse(readFileSync(join(builtinDir, packId, 'parts.json'), 'utf8'));
    for (const row of rows) {
      parts.push({
        id: row.id,
        model: row.model,
        category: row.category,
        specs: row.specs ?? {},
        ...(typeof row.price === 'number' ? { price: row.price } : {}),
        packId
      });
    }
  }
  return parts;
}

const parts = loadParts();

function power(items, options = {}) {
  return estimatePower({
    items,
    voltage: '380VAC',
    simultaneity: 1,
    loadFactor: 1,
    efficiency: 1,
    cosPhi: 0.9,
    ...options
  });
}

function design(overrides = {}) {
  return {
    config: {
      stations: ['ST1', 'ST2'],
      actuators: [{ kind: 'gripper' }, { kind: 'gripper' }],
      sensors: [{ point: 'ST1-PRX-S1' }]
    },
    form: { id: 'linear-2', name: '双工位直线', layout: 'linear' },
    bomDraft: {
      items: [
        { kind: 'actuator', name: '气爪', qty: 2, partId: 'MHZ2-20D', packId: 'smc-cn', role: 'gripper' },
        { kind: 'electrical', name: '伺服驱动器', qty: 1, partId: 'SV660PS5R5I', packId: 'iec-cn', role: 'servo' },
        { kind: 'electrical', name: '伺服电机', qty: 1, partId: 'MS1H1-75B30CB', packId: 'iec-cn', role: 'servo' }
      ]
    },
    ...overrides
  };
}

function onePartDesign(partId, qty = 1) {
  return {
    config: { stations: [] },
    form: { id: 'test', name: '测试', layout: 'single' },
    bomDraft: {
      items: [{ kind: 'electrical', name: '测试断路器', qty, partId, packId: 'iec-cn', role: 'other' }]
    }
  };
}

function costBook(items) {
  return {
    schemaVersion: 2,
    currency: 'CNY',
    updatedAt: '2026-10-24T00:00:00+08:00',
    source: '测试价格簿',
    items,
    labor: { panelWiringPerPoint: 12, terminalPerWire: 1.5, assemblyHourly: 120 },
    accessories: { dinRail35PerMeter: 18, wireDuctPerMeter: 22, wirePerMeter: { '2.5': 4.8 } }
  };
}

function pricedItem(overrides = {}) {
  return {
    model: 'QF-TEST',
    category: '断路器',
    list: 100,
    source: 'https://example.com/qf-test',
    sourceType: 'distributor',
    checkedAt: '2026-10-24',
    taxIncluded: true,
    note: '测试来源',
    ...overrides
  };
}

test('功率：220V 单相电流按 I=P/(U×cosφ)', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 1000 }], { voltage: '220VAC' });
  assert.ok(Math.abs(result.totalKw - 1) < 1e-9);
  assert.ok(Math.abs(result.totalVa - 1000 / 0.9) < 1e-3);
  assert.ok(Math.abs(result.currentA - 1000 / (220 * 0.9)) < 1e-3);
});

test('功率：380V 三相电流按 I=P/(√3×U×cosφ)', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 1000 }]);
  assert.ok(Math.abs(result.currentA - 1000 / (Math.sqrt(3) * 380 * 0.9)) < 1e-3);
});

test('功率：同时系数降低计算负荷', () => {
  const full = power([{ role: 'other', qty: 1, ratedW: 1000 }], { simultaneity: 1 });
  const half = power([{ role: 'other', qty: 1, ratedW: 1000 }], { simultaneity: 0.5 });
  assert.ok(Math.abs(half.totalKw * 2 - full.totalKw) < 1e-6);
});

test('功率：负载率降低计算负荷', () => {
  const full = power([{ role: 'other', qty: 1, ratedW: 1000 }], { loadFactor: 1 });
  const quarter = power([{ role: 'other', qty: 1, ratedW: 1000 }], { loadFactor: 0.25 });
  assert.ok(Math.abs(quarter.totalKw * 4 - full.totalKw) < 1e-6);
});

test('功率：效率按 P_in=P_out/η 折算', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 1000 }], { efficiency: 0.8 });
  assert.ok(Math.abs(result.totalKw - 1.25) < 1e-9);
});

test('功率：cosφ 同时影响视在功率与电流', () => {
  const low = power([{ role: 'other', qty: 1, ratedW: 1000 }], { cosPhi: 0.8 });
  const high = power([{ role: 'other', qty: 1, ratedW: 1000 }], { cosPhi: 1 });
  assert.ok(Math.abs(low.totalVa - 1250) < 1e-6);
  assert.ok(Math.abs(low.currentA / high.currentA - 1.25) < 1e-3);
});

test('功率：断路器按 1.25 倍向上取标准档', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 5000 }], { voltage: '220VAC' });
  assert.ok(result.currentA * 1.25 > 25 && result.currentA * 1.25 <= 32);
  assert.equal(result.breakerSuggestion.rating, 32);
});

test('功率：380V 建议 3P，220V 建议 1P', () => {
  assert.equal(power([{ role: 'other', qty: 1, ratedW: 1000 }]).breakerSuggestion.poles, 3);
  assert.equal(
    power([{ role: 'other', qty: 1, ratedW: 1000 }], { voltage: '220VAC' }).breakerSuggestion.poles,
    1
  );
});

test('功率：24V 负载超过电源 70% 时告警', () => {
  const result = power([
    { role: 'sensor', qty: 1, ratedW: 200 },
    { role: 'psu', qty: 1, ratedW: 250 }
  ]);
  assert.equal(result.dc24?.loadW, 200);
  assert.equal(result.dc24?.supplyW, 250);
  assert.ok(result.warnings.some((line) => /24 VDC 电源余量不足/.test(line)));
});

test('功率：24V 负载低于 70% 时不告警且给出余量', () => {
  const result = power([
    { role: 'sensor', qty: 1, ratedW: 100 },
    { role: 'psu', qty: 1, ratedW: 350 }
  ]);
  assert.equal(result.dc24?.marginPct, 71.4);
  assert.equal(result.warnings.some((line) => /24 VDC 电源余量不足/.test(line)), false);
});

test('功率：缺额定功率时告警并使用类别默认值', () => {
  const result = power([{ role: 'gripper', qty: 2 }]);
  assert.ok(result.warnings.some((line) => /缺少额定功率/.test(line)));
  assert.ok(result.assumptions.some((line) => /夹爪 2 件按 15 W/.test(line)));
  assert.ok(result.byGroup.some((group) => group.name === '夹爪' && group.ratedW === 30));
});

test('功率：已选断路器小于计算电流时告警', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 3000 }], {
    voltage: '220VAC',
    selectedBreakerA: 6
  });
  assert.ok(result.warnings.some((line) => /超过已选总进线断路器/.test(line)));
});

test('功率：已选断路器余量超过 60% 时提示可降档', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 1000 }], {
    voltage: '220VAC',
    selectedBreakerA: 16
  });
  assert.ok(result.warnings.some((line) => /余量.*超过 60%，可评估降一档/.test(line)));
});

test('功率：24VDC 主回路按直流计算且建议 1P', () => {
  const result = power([{ role: 'other', qty: 1, ratedW: 240 }], { voltage: '24VDC' });
  assert.ok(Math.abs(result.currentA - 10) < 1e-9);
  assert.equal(result.breakerSuggestion.poles, 1);
});

test('成本：机械件按价格簿单价 × 数量', () => {
  const result = estimateCost(design(), { parts, pricebook: fixtureBook, pricing: DEFAULT_MACHINE_PRICING });
  assert.equal(result.material, 1712);
  assert.ok(result.lines.some((line) => line.name === '气爪' && line.unit === 856 && line.subtotal === 1712));
});

test('成本：电气件优先查价格簿', () => {
  const book = {
    ...fixtureBook,
    items: {
      ...fixtureBook.items,
      'SV660PS5R5I': { list: 900, source: '测试价' },
      'MS1H1-75B30CB': { list: 500, source: '测试价' }
    }
  };
  const result = estimateCost(design(), { pricebook: book, pricing: DEFAULT_MACHINE_PRICING });
  assert.equal(result.electrical, 1400);
});

test('成本：伺服缺少电机时按同数量补齐驱动器', () => {
  const source = design();
  source.bomDraft.items = [
    { kind: 'actuator', name: '伺服电机', qty: 2, partId: 'MS1H1-75B30CB', packId: 'iec-cn', role: 'servo' }
  ];
  const book = {
    ...fixtureBook,
    items: {
      'SV660PS5R5I': { list: 900, source: '测试价' },
      'MS1H1-75B30CB': { list: 500, source: '测试价' }
    }
  };
  const result = estimateCost(source, { pricebook: book, pricing: DEFAULT_MACHINE_PRICING });
  assert.ok(result.lines.some((line) => line.name === '伺服驱动器' && line.qty === 2 && line.subtotal === 1800));
  assert.ok(result.lines.some((line) => line.name === '伺服电机' && line.qty === 2 && line.subtotal === 1000));
  assert.equal(result.electrical, 2800);
});

test('成本：伺服缺少驱动器时按同数量补齐电机', () => {
  const source = design();
  source.bomDraft.items = [
    { kind: 'actuator', name: '伺服驱动器', qty: 1, partId: 'SV660PS5R5I', packId: 'iec-cn', role: 'servo' }
  ];
  const book = {
    ...fixtureBook,
    items: { 'MS1H1-75B30CB': { list: 500, source: '测试价' } }
  };
  const result = estimateCost(source, { pricebook: book, pricing: DEFAULT_MACHINE_PRICING });
  assert.ok(result.lines.some((line) => line.name === '伺服电机' && line.qty === 1));
  assert.ok(result.missingCount >= 1, '驱动器仍应因缺价计入 missing');
});

test('成本：缺价行不计入合计并计入 missingCount', () => {
  const source = design();
  source.bomDraft.items.push({
    kind: 'actuator',
    name: '定制夹具',
    qty: 2,
    role: 'other'
  });
  const result = estimateCost(source, { pricebook: fixtureBook, pricing: DEFAULT_MACHINE_PRICING });
  assert.equal(result.missingCount, 4);
  assert.ok(result.warnings.some((line) => /缺价/.test(line)));
  assert.equal(result.lines.find((line) => line.name === '定制夹具')?.subtotal, 0);
});

test('成本：priceMeta 统计覆盖行数与缺价名称/partId', () => {
  const source = {
    config: { stations: [] },
    form: { id: 'test', name: '测试', layout: 'single' },
    bomDraft: {
      items: [
        { kind: 'actuator', name: '气爪', qty: 2, partId: 'MHZ2-20D', packId: 'smc-cn', role: 'gripper' },
        { kind: 'electrical', name: '伺服驱动器', qty: 1, partId: 'SV660PS5R5I', packId: 'iec-cn', role: 'servo' },
        { kind: 'electrical', name: '伺服电机', qty: 1, partId: 'MS1H1-75B30CB', packId: 'iec-cn', role: 'servo' }
      ]
    }
  };
  const book = costBook({
    'MHZ2-20D': pricedItem({ model: 'MHZ2-20D', category: '气爪' })
  });
  const result = estimateCost(source, { pricebook: book, pricing: DEFAULT_MACHINE_PRICING, now: '2026-10-24' });
  assert.equal(result.priceMeta.totalCount, 3);
  assert.equal(result.priceMeta.pricedCount, 1);
  assert.equal(result.priceMeta.coveragePct, 33.3);
  assert.deepEqual(result.priceMeta.missing, [
    { partId: 'SV660PS5R5I', name: '伺服驱动器' },
    { partId: 'MS1H1-75B30CB', name: '伺服电机' }
  ]);
});

test('成本：checkedAt 恰好 180 天不标过期，超过 1 秒即标过期', () => {
  const book = costBook({
    'PART-QF': pricedItem({ checkedAt: '2026-04-27' })
  });
  const boundary = estimateCost(onePartDesign('PART-QF'), {
    pricebook: book,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24T00:00:00+08:00'
  });
  assert.equal(boundary.priceMeta.stale.length, 0);
  const stale = estimateCost(onePartDesign('PART-QF'), {
    pricebook: book,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24T00:00:01+08:00'
  });
  assert.deepEqual(stale.priceMeta.stale, [
    { partId: 'PART-QF', name: '测试断路器', checkedAt: '2026-04-27' }
  ]);
  assert.ok(stale.warnings.some((line) => /超过 180 天/.test(line)));
});

test('成本：v1 价格簿旧条目计价但标记来源不明', () => {
  const book = {
    schemaVersion: 1,
    currency: 'CNY',
    updatedAt: '2026-10-24T00:00:00+08:00',
    source: '旧版价格簿',
    items: { 'PART-QF': { list: 88, source: '旧目录价', updatedAt: '2026-09-01T00:00:00+08:00' } },
    labor: { panelWiringPerPoint: 12, terminalPerWire: 1.5, assemblyHourly: 120 },
    accessories: { dinRail35PerMeter: 18, wireDuctPerMeter: 22, wirePerMeter: { '2.5': 4.8 } }
  };
  const result = estimateCost(onePartDesign('PART-QF'), {
    pricebook: book,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24'
  });
  assert.equal(result.priceMeta.pricedCount, 1);
  assert.deepEqual(result.priceMeta.unknownSource, [{ partId: 'PART-QF', name: '测试断路器' }]);
  assert.equal(result.priceMeta.stale.length, 0);
  assert.ok(result.warnings.some((line) => /来源不明/.test(line)));
});

test('成本：v2 新条目有完整来源时不标来源不明', () => {
  const book = costBook({ 'PART-QF': pricedItem() });
  const result = estimateCost(onePartDesign('PART-QF'), {
    pricebook: book,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24'
  });
  assert.equal(result.priceMeta.unknownSource.length, 0);
  assert.equal(result.priceMeta.stale.length, 0);
});

test('成本：taxIncluded=null 的条目照常计价并保留说明', () => {
  const book = costBook({
    'PART-QF': pricedItem({ taxIncluded: null, note: '页面未标注税额' })
  });
  const result = estimateCost(onePartDesign('PART-QF'), {
    pricebook: book,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24'
  });
  assert.equal(result.electrical, 100);
  assert.equal(book.items['PART-QF'].taxIncluded, null);
  assert.match(book.items['PART-QF'].note, /未标注/);
});

test('成本：tiers 按数量取满足条件的最高档', () => {
  const book = costBook({
    'PART-QF': pricedItem({
      list: 100,
      tiers: [{ minQty: 1, price: 100 }, { minQty: 5, price: 90 }, { minQty: 10, price: 80 }]
    })
  });
  for (const [qty, unit] of [[1, 100], [4, 100], [5, 90], [9, 90], [10, 80], [20, 80]]) {
    const result = estimateCost(onePartDesign('PART-QF', qty), {
      pricebook: book,
      pricing: DEFAULT_MACHINE_PRICING,
      now: '2026-10-24'
    });
    assert.equal(result.lines[0]?.unit, unit, `qty=${qty}`);
  }
});

test('成本：六工位案例真实价格簿覆盖 ≥ 8/12 行', () => {
  const machineCase = JSON.parse(readFileSync(join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json'), 'utf8'));
  const builtin = JSON.parse(readFileSync(join(builtinDir, 'pricebook-cn', 'pricebook.json'), 'utf8'));
  const result = estimateCost(machineCase.design, {
    parts,
    builtinPricebook: builtin,
    pricing: DEFAULT_MACHINE_PRICING,
    now: '2026-10-24T23:59:59+08:00'
  });
  assert.equal(result.priceMeta.totalCount, 12);
  assert.ok(result.priceMeta.pricedCount >= 8, `实际覆盖 ${result.priceMeta.pricedCount}/12`);
  assert.equal(result.priceMeta.missing.length, result.missingCount);
  assert.deepEqual(
    result.priceMeta.missing.map((entry) => entry.partId).sort(),
    ['CP1E-N40DR-A', 'F3SG-4SRA0640-14', 'MS1H1-75B30CB']
  );
});

test('成本：方案卡显示覆盖率、缺价、过期与来源不明', () => {
  const ui = readFileSync(join(repoRoot, 'desktop', 'src', 'agent', 'ui.ts'), 'utf8');
  assert.match(ui, /已计价 \$\{pricedCount\}\/\$\{totalCount\} 行（覆盖率 \$\{coverage\}%）、缺价 \$\{missingCount \?\? 0\} 项、过期 \$\{staleCount\} 项/);
  assert.match(ui, /来源不明 \$\{unknownSourceCount\} 项/);
});

test('成本：人工随工位数线性变化', () => {
  const two = estimateCost(design(), { pricing: DEFAULT_MACHINE_PRICING, stationCount: 2 });
  const four = estimateCost(design(), { pricing: DEFAULT_MACHINE_PRICING, stationCount: 4 });
  assert.equal(four.labor, two.labor * 2);
  assert.equal(two.laborDetail.stations, 2);
  assert.equal(four.laborDetail.stations, 4);
});

test('成本：人工参数可配置并写入 assumptions', () => {
  const pricing = {
    ...DEFAULT_MACHINE_PRICING,
    labor: {
      ratePerHour: 200,
      mechanicalHoursPerStation: 10,
      electricalHoursPerStation: 5,
      debugHoursPerStation: 5
    }
  };
  const result = estimateCost(design(), { pricing });
  assert.equal(result.labor, 2 * 20 * 1.1 * 200);
  assert.ok(result.assumptions.some((line) => /200 元\/h/.test(line)));
  assert.equal(result.total, result.material + result.electrical + result.labor);
});

test('成本：byCategory 分出机械件/电气件并统计缺价', () => {
  const result = estimateCost(design(), { parts, pricebook: fixtureBook, pricing: DEFAULT_MACHINE_PRICING });
  const material = result.byCategory.find((entry) => entry.category === '机械件');
  const electrical = result.byCategory.find((entry) => entry.category === '电气件');
  assert.ok(material && material.count >= 1);
  assert.ok(electrical && electrical.count >= 2);
  assert.equal(material.missing, 0);
});

test('成本：边界说明明确不替代报价引擎', () => {
  const result = estimateCost(design(), { pricing: DEFAULT_MACHINE_PRICING });
  assert.match(result.boundary, /不替代 cost\/engine\.ts/);
  assert.ok(result.assumptions.some((line) => /方案阶段粗估/.test(line)));
});

test('参数文件：缺失时回落默认值并写 assumptions', () => {
  const load = readMachinePricing(undefined);
  assert.equal(load.source, 'defaults');
  assert.deepEqual(load.pricing, DEFAULT_MACHINE_PRICING);
  assert.ok(load.assumptions.some((line) => /默认值/.test(line)));
});

test('参数文件：合法 JSON 覆盖同时系数与工时单价', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-pricing-'));
  try {
    writeFileSync(join(root, 'machine-pricing.json'), JSON.stringify({
      power: { simultaneity: 0.8, loadFactor: 0.5, efficiency: 0.85, cosPhi: 0.92 },
      labor: { ratePerHour: 180, mechanicalHoursPerStation: 7, electricalHoursPerStation: 5, debugHoursPerStation: 3 }
    }));
    const load = readMachinePricing(root);
    assert.equal(load.source, 'file');
    assert.equal(load.pricing.power.simultaneity, 0.8);
    assert.equal(load.pricing.labor.ratePerHour, 180);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('参数文件：非法字段逐项回落并告警', () => {
  const parsed = parseMachinePricing({
    power: { simultaneity: 2, cosPhi: -1 },
    labor: { ratePerHour: 'a' }
  });
  assert.equal(parsed.pricing.power.simultaneity, DEFAULT_MACHINE_PRICING.power.simultaneity);
  assert.equal(parsed.pricing.power.cosPhi, DEFAULT_MACHINE_PRICING.power.cosPhi);
  assert.equal(parsed.pricing.labor.ratePerHour, DEFAULT_MACHINE_PRICING.labor.ratePerHour);
  assert.equal(parsed.warnings.length, 3);
});

test('接入：synthMachine 生成 power/cost，BOM 映射后可复算', () => {
  const brief = parseMachineBrief('三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服');
  const seeded = synthMachine(brief, {
    parts,
    pricing: DEFAULT_MACHINE_PRICING,
    builtinPricebook: fixtureBook
  });
  assert.ok(seeded.power.totalKw > 0);
  assert.ok(seeded.power.currentA > 0);
  assert.ok(seeded.cost.total > 0);
  assert.ok(seeded.cost.assumptions.some((line) => /人工\/调试/.test(line)));
  const mapped = mapMachineBom(seeded, parts);
  seeded.bomDraft = { items: mapped.items };
  const mappedCost = estimateCost(seeded, {
    parts,
    builtinPricebook: fixtureBook,
    pricing: DEFAULT_MACHINE_PRICING
  });
  assert.ok(mappedCost.missingCount > 0);
  assert.equal(mappedCost.missingCount, mappedCost.lines.filter((line) => line.priceSource === '缺失').length);
});

test('接入：design_machine 方案卡所需字段完整', async () => {
  const sales = JSON.parse(readFileSync(join(builtinDir, 'pricebook-cn', 'pricebook.json'), 'utf8'));
  const tools = new AgentTools(
    { listParts: () => parts },
    undefined,
    { loadBuiltinPricebook: () => sales }
  );
  const result = await tools.call('design_machine', {
    brief: '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套 750W 伺服 + 1 个气爪 + 1 个到位检测 + 安全光栅'
  });
  assert.equal(result.ok, true);
  assert.ok(result.design.power.totalKw > 0);
  assert.ok(result.design.power.currentA > 0);
  assert.ok(result.design.power.breakerSuggestion.rating > 0);
  assert.ok(result.design.power.dc24);
  assert.equal(typeof result.design.cost.material, 'number');
  assert.equal(typeof result.design.cost.electrical, 'number');
  assert.equal(typeof result.design.cost.labor, 'number');
  assert.equal(typeof result.design.cost.total, 'number');
  assert.equal(typeof result.design.cost.missingCount, 'number');
  assert.equal(result.design.cost.total, result.design.cost.material + result.design.cost.electrical + result.design.cost.labor);
});

test('接入：design_machine 结果超过 10 KB 仍完整保留给方案卡', async () => {
  const sales = JSON.parse(readFileSync(join(builtinDir, 'pricebook-cn', 'pricebook.json'), 'utf8'));
  const tools = new AgentTools(
    { listParts: () => parts },
    undefined,
    { loadBuiltinPricebook: () => sales }
  );
  const result = await tools.call('design_machine', {
    brief: '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套 750W 伺服 + 1 个气爪 + 1 个到位检测 + 安全光栅'
  });
  const raw = JSON.stringify(result);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 10 * 1024, '测试夹具应超过通用 10 KB 上限');
  const serialized = serializeToolResult(result, toolResultByteLimit('design_machine'));
  assert.equal(serialized.truncated, false);
  const parsed = JSON.parse(serialized.text);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.design.power.totalKw > 0);
  assert.ok(parsed.design.cost.total > 0);
});
