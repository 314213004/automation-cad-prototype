import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConveyorParts, conveyorBom, conveyorEnvelope, DEFAULT_CONVEYOR } from '../../src/machine/conveyor-assembly.ts';
import { detectBufferLayers } from '../../src/machine/spec.ts';

const single = buildConveyorParts({ ...DEFAULT_CONVEYOR, lengthMm: 3000, widthMm: 1200, layers: 1 });
const layered = buildConveyorParts({ ...DEFAULT_CONVEYOR, lengthMm: 3000, widthMm: 1200, layers: 3, layerPitchMm: 400 });

test('层数解析：只认显式「N 层」，无线索返回 null', () => {
  assert.equal(detectBufferLayers('做一台 3 层立体缓存机台'), 3);
  assert.equal(detectBufferLayers('三层缓存线，12 个储位'), 3);
  assert.equal(detectBufferLayers('层数：4 的缓存库'), 4);
  assert.equal(detectBufferLayers('缓存机台，节拍 15 件/分钟'), null);
  assert.equal(detectBufferLayers('12 层超高层'), null, '超出 1~8 不认');
});

test('layers=1 保持普通输送线（不凭空长托架）', () => {
  assert.equal(layered.length > single.length, true);
  assert.equal(single.every((part) => !/托条|托板|升降|缓存立柱/.test(part.name)), true);
});

test('3 层缓存：每层都有托条/托板/传动辊/挡停/到位光电，且只有一套升降机构', () => {
  const names = layered.map((part) => part.name);
  for (const layer of [2, 3]) {
    assert.ok(names.includes(`第 ${layer} 层托条（左）`), `缺第 ${layer} 层左托条`);
    assert.ok(names.includes(`第 ${layer} 层托板`), `缺第 ${layer} 层托板`);
    assert.ok(names.includes(`第 ${layer} 层传动辊（进）`), `缺第 ${layer} 层进料辊`);
    assert.ok(names.includes(`第 ${layer} 层挡停板`), `缺第 ${layer} 层挡停`);
    assert.ok(names.includes(`第 ${layer} 层到位光电`), `缺第 ${layer} 层到位光电`);
  }
  // 底层是输送线本身，不再有「第 1 层托板」
  assert.equal(names.includes('第 1 层托板'), false);
  assert.equal(names.filter((name) => name === '升降台').length, 1);
  assert.equal(names.filter((name) => name === '升降减速电机').length, 1);
  assert.equal(names.filter((name) => /缓存立柱/.test(name)).length, 4);
});

test('包络随层数长高，长宽不被托架撑爆', () => {
  const [sl, sw, sh] = conveyorEnvelope(single);
  const [ml, mw, mh] = conveyorEnvelope(layered);
  assert.ok(mh > sh + 700, `3 层应比单层高至少 2 个层距：单层 ${sh} / 三层 ${mh}`);
  assert.ok(Math.abs(ml - sl) < 200, `长度不该被层结构拉长：${sl} → ${ml}`);
  assert.ok(mw < sw + 400, `宽度只外扩立柱：${sw} → ${mw}`);
});

test('BOM 不按层复制皮带/滚筒/电机（只有一条皮带线）', () => {
  const bom = conveyorBom(layered, {});
  const count = (pattern) => bom.filter((row) => pattern.test(row.name)).reduce((sum, row) => sum + row.qty, 0);
  assert.equal(count(/皮带上行程/), 1);
  assert.equal(count(/主动滚筒/), 1);
  assert.equal(bom.filter((row) => row.name === '减速电机').reduce((sum, row) => sum + row.qty, 0), 1, '底层驱动电机只有一个；升降电机是另一个件');
  assert.equal(bom.filter((row) => row.name === '升降减速电机').length, 1);
  assert.ok(count(/层托板/) === 2, '两层储位 = 两块托板');
});
