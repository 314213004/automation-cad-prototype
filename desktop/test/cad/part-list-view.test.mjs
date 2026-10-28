import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPartListEntries, filterPartList, partGroupLabel } from '../../src/cad/part-list-view.ts';

const parts = [
  { name: '立柱-左前', path: ['光伏缓存堆叠单元', '机架'] },
  { name: '立柱-右前', path: ['光伏缓存堆叠单元', '机架'] },
  { name: '链条-近侧', path: ['光伏缓存堆叠单元', '升降单元'] },
  { name: '自由件' }
];

test('partGroupLabel：取路径前两级；无路径归「未分层」', () => {
  assert.equal(partGroupLabel(['总装', '机架', '细节']), '总装 > 机架');
  assert.equal(partGroupLabel([]), '未分层');
  assert.equal(partGroupLabel(undefined), '未分层');
  assert.equal(partGroupLabel(['', '  ']), '未分层');
});

test('buildPartListEntries：先组头后零件，组内保持原索引顺序', () => {
  const entries = buildPartListEntries(parts);
  assert.deepEqual(entries.map((e) => (e.kind === 'group' ? `G:${e.label}(${e.count})` : `P${e.index}`)), [
    'G:光伏缓存堆叠单元 > 机架(2)', 'P0', 'P1',
    'G:光伏缓存堆叠单元 > 升降单元(1)', 'P2',
    'G:未分层(1)', 'P3'
  ]);
});

test('filterPartList：空 query 不过滤（active=false，全部命中）', () => {
  const result = filterPartList(parts, '   ');
  assert.equal(result.active, false);
  assert.equal(result.matched.size, parts.length);
});

test('filterPartList：按名字命中（大小写不敏感）+ 记录命中分组', () => {
  const result = filterPartList(parts, '立柱');
  assert.equal(result.active, true);
  assert.deepEqual([...result.matched], [0, 1]);
  assert.deepEqual([...result.groups], ['光伏缓存堆叠单元 > 机架']);
});

test('filterPartList：按装配路径命中（搜「升降」能搜到链条）', () => {
  const result = filterPartList(parts, '升降');
  assert.deepEqual([...result.matched], [2]);
});

test('filterPartList：没有命中时集合为空，不抛错', () => {
  const result = filterPartList(parts, '不存在的东西');
  assert.equal(result.active, true);
  assert.equal(result.matched.size, 0);
  assert.equal(result.groups.size, 0);
});
