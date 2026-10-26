import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holePatternFromMountPort, planAdapterGeometry } from '../../src/mech/adapter-synth.ts';
import { buildFastenerBomItems } from '../../src/cost/fastener-bom.ts';

const parent = (pitchX, pitchY, normal = [0, 0, 1]) => ({
  portId: 'parent', boltSize: 'M5', throughDiaMm: 5.5, cboreDiaMm: 8.5, cboreDepthMm: 5,
  tapMinorDiaMm: 4.2, pitchXMm: pitchX, pitchYMm: pitchY, normal
});
const child = (pitchX, pitchY, normal = [0, 0, 1]) => ({
  portId: 'child', boltSize: 'M5', throughDiaMm: 5.5, cboreDiaMm: 8.5, cboreDepthMm: 5,
  tapMinorDiaMm: 4.2, pitchXMm: pitchX, pitchYMm: pitchY, normal
});

test('孔距充足时走 12mm 平板通孔', () => {
  // 母件 60x60、子件 40x40：最近孔心距 10*sqrt(2)=14.14，壁厚 14.14-(8.5/2+4.2/2)=7.79
  const r = planAdapterGeometry(parent(60, 60), child(40, 40));
  assert.equal(r.strategy.kind, 'flat_through');
  assert.equal(r.strategy.thicknessMm, 12);
  assert.ok(r.minClearanceMm >= 2.5);
});

test('孔距接近时走加厚盲孔或偏置，不直接出平板', () => {
  // 母件 40x40、子件 36x36：最近孔心距约 2.83，壁厚为负，通孔柱面壁厚仍为负 -> 偏置
  const r = planAdapterGeometry(parent(40, 40), child(36, 36));
  assert.equal(r.strategy.kind, 'flat_offset');
  assert.deepEqual(r.strategy.offsetMm, [0, 16]);
});

test('法向量正交时走 L 型带肋角座', () => {
  const r = planAdapterGeometry(parent(60, 60, [0, 0, 1]), child(60, 60, [1, 0, 0]));
  assert.equal(r.strategy.kind, 'l_bracket_gusset');
  assert.equal(r.strategy.thicknessMm, 12);
  assert.ok(r.strategy.flangeHeightMm >= 75);
});

test('MountPort 转换用仓库 ISO 4762 表（M5 沉头 8.5，不是文档的 9.5）', () => {
  const p = holePatternFromMountPort({ pitchXMm: 60, pitchYMm: 60, holeDiaMm: 5.5 }, 'M5', [0, 0, 1], 'p1');
  assert.equal(p.cboreDiaMm, 8.5);
  assert.equal(p.tapMinorDiaMm, 4.2);
});

test('紧固件 BOM：3 项、数量与国标件号正确', () => {
  const items = buildFastenerBomItems('adapter-1', 'M5', 'M4');
  assert.equal(items.length, 3);
  assert.equal(items[0].partId, 'GB70.1-M5x16');
  assert.equal(items[0].qty, 4);
  assert.equal(items[1].partId, 'GB70.1-M4x12');
  assert.equal(items[2].partId, 'GB120.2-D4x14');
  assert.equal(items[2].qty, 2);
  assert.ok(items.every((it) => it.parentNodeId === 'adapter-1'));
});

test('孔壁略不足时走加厚盲孔（18mm，盲深 10mm）', () => {
  // 母件 60x60、子件 48x48：最近孔心距 6*sqrt(2)=8.49，壁厚 8.49-6.35=2.14 <2.5，
  // 通孔柱面壁厚 2.14+1.5=3.64 >=2.5 -> 盲孔
  const r = planAdapterGeometry(parent(60, 60), child(48, 48));
  assert.equal(r.strategy.kind, 'flat_blind_thick');
  assert.equal(r.strategy.thicknessMm, 18);
  assert.equal(r.strategy.blindDepthMm, 10);
});
