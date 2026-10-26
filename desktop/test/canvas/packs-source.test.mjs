import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildPaletteSections,
  paletteItemFromPack,
  ruleForCategory,
  summarizePackCoverage,
  CATEGORY_RULES
} from '../../src/canvas/packs-source.ts';

const PACKS_DIR = new URL('../../../packs/builtin/', import.meta.url);

function readPackParts() {
  const parts = [];
  for (const entry of readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(new URL(`${entry.name}/parts.json`, PACKS_DIR), 'utf8'));
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : parsed.parts ?? parsed.items ?? [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      parts.push({
        id: item.id,
        model: item.model,
        category: item.category,
        vendor: item.vendor,
        specs: item.specs,
        dims: item.dims
      });
    }
  }
  return parts;
}

test('ruleForCategory：机械品类有规则，纯电气件不进画布', () => {
  assert.equal(ruleForCategory('气缸').kind, 'actuator');
  assert.equal(ruleForCategory('气爪').kind, 'gripper');
  assert.equal(ruleForCategory('工业相机').kind, 'vision');
  assert.equal(ruleForCategory('滚珠丝杠').kind, 'linear');
  assert.equal(ruleForCategory('工业铝型材').kind, 'frame');
  assert.equal(ruleForCategory('断路器'), null, '断路器不是装配节点');
  assert.equal(ruleForCategory('PLC'), null);
  assert.equal(ruleForCategory('不存在的品类'), null);
});

test('paletteItemFromPack：型号/partId/端口/质量按品类规则给出，且不带价格', () => {
  const item = paletteItemFromPack({
    id: 'MHZ2-20D',
    model: 'MHZ2-20D',
    category: '气爪',
    vendor: 'SMC',
    dims: { w: 84, h: 42, d: 60 }
  });
  assert.ok(item);
  assert.equal(item.partId, 'MHZ2-20D');
  assert.equal(item.label, 'MHZ2-20D');
  assert.equal(item.kind, 'gripper');
  assert.equal(item.portIn.family, 'plate', '气爪装在法兰面');
  assert.equal(item.portOut.family, 'tip', '气爪输出是末端接口');
  assert.deepEqual(item.dimsMm, [84, 42, 60]);
  assert.equal(item.massKg, 0.9);
  assert.match(item.spec, /质量取品类默认 0\.9kg/);
  assert.equal('price' in item, false, '模组库不得带价格');
  assert.equal('cost' in item, false);
});

test('paletteItemFromPack：缺外形退回品类默认尺寸；缺型号/id 返回 null', () => {
  const noDims = paletteItemFromPack({ id: 'CDQ2B20-30DZ', model: 'CDQ2B20-30DZ', category: '气缸' });
  assert.ok(noDims);
  assert.deepEqual(noDims.dimsMm, [80, 62, 195]);
  assert.equal(paletteItemFromPack({ id: '', model: 'X', category: '气缸' }), null);
  assert.equal(paletteItemFromPack({ id: 'X', model: '', category: '气缸' }), null);
  assert.equal(paletteItemFromPack({ id: 'X', model: 'X', category: '断路器' }), null);
});

test('buildPaletteSections：按规则分组、组内按型号排序、超限只展示前 N 件但保留 total', () => {
  const parts = [
    { id: 'c3', model: 'Z-气缸', category: '气缸' },
    { id: 'c1', model: 'A-气缸', category: '气缸' },
    { id: 'c2', model: 'M-气缸', category: '气缸' },
    { id: 'g1', model: 'B-气爪', category: '气爪' },
    { id: 'e1', model: 'iC65N', category: '断路器' }
  ];
  const sections = buildPaletteSections(parts, 2);
  assert.deepEqual(sections.map((section) => section.label), ['气动执行器', '末端执行器']);
  const air = sections[0];
  assert.equal(air.total, 3);
  assert.deepEqual(air.items.map((item) => item.label), ['A-气缸', 'M-气缸']);
  assert.deepEqual(sections[1].items.map((item) => item.label), ['B-气爪']);
  // 纯电气件不会出现在模组库
  assert.equal(sections.some((section) => section.items.some((item) => item.label === 'iC65N')), false);
});

test('真实 packs：能映射出可上画布的机械件，且每类都有总数', () => {
  const parts = readPackParts();
  assert.ok(parts.length > 300, `packs 元件太少：${parts.length}`);
  const coverage = summarizePackCoverage(parts);
  assert.ok(coverage.mountable >= 40, `可上画布元件太少：${coverage.mountable}`);
  assert.ok(coverage.sections >= 3, `分组太少：${coverage.sections}`);

  const sections = buildPaletteSections(parts);
  const labels = sections.map((section) => section.label);
  assert.ok(labels.includes('气动执行器'));
  assert.ok(labels.includes('视觉'));
  // 每件都必须带 partId（价格按它查价格簿），且没有价格字段
  for (const section of sections) {
    for (const item of section.items) {
      assert.equal(typeof item.partId, 'string');
      assert.equal('price' in item, false);
    }
  }
  // 规则表自带说明，避免以后加品类忘了写默认值
  for (const rule of CATEGORY_RULES) {
    assert.ok(rule.defaultMassKg > 0);
    assert.ok(rule.defaultDimsMm.every((value) => value > 0));
  }
});
