import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundsFromPositions,
  detectInterferences,
  interferencePairKey
} from '../../src/mech/interference.ts';

function box(min, max) {
  return { min, max };
}

test('相交立方体输出重叠量、中心与体积', () => {
  const hits = detectInterferences([
    { name: 'A', bbox: box([0, 0, 0], [10, 10, 10]) },
    { name: 'B', bbox: box([5, 5, 5], [15, 15, 15]) }
  ]);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].overlap, [5, 5, 5]);
  assert.deepEqual(hits[0].center, [7.5, 7.5, 7.5]);
  assert.equal(hits[0].volumeApprox, 125);
  assert.equal(hits[0].severity, 'warning');
});

test('相切（任一轴重叠为 0）不算干涉', () => {
  const hits = detectInterferences([
    { name: 'A', bbox: box([0, 0, 0], [10, 10, 10]) },
    { name: 'B', bbox: box([10, 0, 0], [20, 10, 10]) }
  ]);
  assert.deepEqual(hits, []);
});

test('三件互相交返回三对且按体积降序', () => {
  const hits = detectInterferences([
    { name: 'A', bbox: box([0, 0, 0], [10, 10, 10]) },
    { name: 'B', bbox: box([5, 5, 5], [15, 15, 15]) },
    { name: 'C', bbox: box([8, 8, 8], [18, 18, 18]) }
  ]);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((hit) => hit.volumeApprox), [343, 125, 8]);
  assert.deepEqual(hits.map((hit) => [hit.a, hit.b]), [['B', 'C'], ['A', 'B'], ['A', 'C']]);
});

test('ignoredPairs 按排序后的名字键忽略指定零件对', () => {
  const parts = [
    { name: 'Z', bbox: box([0, 0, 0], [10, 10, 10]) },
    { name: 'A', bbox: box([2, 2, 2], [12, 12, 12]) },
    { name: 'M', bbox: box([4, 4, 4], [14, 14, 14]) }
  ];
  assert.equal(interferencePairKey('Z', 'A'), 'A|Z');
  const hits = detectInterferences(parts, { ignoredPairs: ['A|Z'] });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((hit) => new Set([hit.a, hit.b]).size === 2));
  assert.ok(!hits.some((hit) => [hit.a, hit.b].sort().join('|') === 'A|Z'));
});

test('任一轴重叠超过 5mm 或体积超过 1000mm³ 判为 error 并优先排序', () => {
  const hits = detectInterferences([
    { name: 'large', bbox: box([0, 0, 0], [20, 20, 20]) },
    { name: 'small', bbox: box([18, 18, 18], [22, 22, 22]) },
    { name: 'near', bbox: box([14, 14, 14], [25, 25, 25]) }
  ]);
  assert.deepEqual([hits[0].a, hits[0].b], ['large', 'near']);
  assert.equal(hits[0].severity, 'error');
  assert.ok(hits.length >= 2);
  for (let index = 1; index < hits.length; index += 1) {
    assert.ok(hits[index - 1].volumeApprox >= hits[index].volumeApprox);
  }
});

test('boundsFromPositions 计算顶点包围盒并拒绝空数据', () => {
  const bbox = boundsFromPositions([0, 0, 0, 10, -2, 5]);
  assert.deepEqual(bbox, { min: [0, -2, 0], max: [10, 0, 5] });
  assert.throws(() => boundsFromPositions([]), /3 的倍数/);
});
