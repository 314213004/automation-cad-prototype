// 孔语义（特征树 → 工程图作业 holes[]）：提取、螺纹规范化、哈希、作业校验。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_HOLE_POSITIONS,
  MAX_HOLE_SPECS,
  holeSpecsOf,
  holesHashOf,
  normalizeThread,
  threadNominal,
  validateHoleSpecs
} from '../../src/drawings/holes.ts';

const adapter = () => [
  { id: 'f1', type: 'box', name: '底板', params: { length: 200, width: 120, height: 15 } },
  { id: 'f2', type: 'counterbore', name: '沉孔', params: { diameter: 6.6, cbDiameter: 11, cbDepth: 6.5, positions: [[-85, -45], [85, -45], [-85, 45], [85, 45]] } },
  { id: 'f3', type: 'holes', name: '销孔', params: { diameter: 8, positions: [[-40, 0], [40, 0]] } },
  { id: 'f4', type: 'slot', name: '腰形槽', params: { length: 60, width: 12 } },
  { id: 'f5', type: 'fillet', name: '倒圆', params: { radius: 5 } }
];

const flange = () => [
  { id: 'c1', type: 'cylinder', name: '法兰', params: { diameter: 130, height: 16 } },
  { id: 'c2', type: 'holes', name: '中心孔', params: { diameter: 40, positions: [[0, 0]] } },
  { id: 'c3', type: 'holes', name: '螺纹孔', params: { diameter: 5, depth: 12, thread: 'm6', threadDepth: 10, positions: [[0, 30], [0, -30]] } }
];

test('normalizeThread / threadNominal：大小写、细牙写法统一为 M8×1，非法返回 null', () => {
  assert.equal(normalizeThread('m6'), 'M6');
  assert.equal(normalizeThread(' M8x1 '), 'M8×1');
  assert.equal(normalizeThread('M8*1.25'), 'M8×1.25');
  assert.equal(normalizeThread('M8×1'), 'M8×1');
  for (const bad of ['', '6', 'M', 'M0', 'M200', 'G1/4', null, 6, undefined]) assert.equal(normalizeThread(bad), null, String(bad));
  assert.equal(threadNominal('M10x1.25'), 10);
  assert.equal(threadNominal('x'), null);
});

test('holeSpecsOf：沉孔/通孔/腰形槽按特征树顺序提取，非孔特征跳过', () => {
  const specs = holeSpecsOf(adapter());
  assert.deepEqual(specs.map((spec) => spec.kind), ['counterbore', 'hole', 'slot']);
  assert.deepEqual(specs[0], { featureId: 'f2', kind: 'counterbore', positions: [[-85, -45], [85, -45], [-85, 45], [85, 45]], diameter: 6.6, through: true, cbDiameter: 11, cbDepth: 6.5 });
  assert.deepEqual(specs[1], { featureId: 'f3', kind: 'hole', positions: [[-40, 0], [40, 0]], diameter: 8, through: true });
  assert.deepEqual(specs[2], { featureId: 'f4', kind: 'slot', positions: [[0, 0]], through: true, length: 60, width: 12 });
});

test('holeSpecsOf：螺纹盲孔带规范化螺纹与螺纹深；抑制特征、参数不全、非法孔位被跳过', () => {
  const specs = holeSpecsOf(flange());
  assert.deepEqual(specs[1], { featureId: 'c3', kind: 'hole', positions: [[0, 30], [0, -30]], diameter: 5, through: false, depth: 12, thread: 'M6', threadDepth: 10 });
  const odd = holeSpecsOf([
    { id: 'a', type: 'holes', name: 'x', suppressed: true, params: { diameter: 5, positions: [[0, 0]] } },
    { id: 'b', type: 'holes', name: 'x', params: { diameter: 5, depth: -1, positions: [[0, 0]] } },
    { id: 'c', type: 'holes', name: 'x', params: { diameter: 0, positions: [[0, 0]] } },
    { id: 'd', type: 'holes', name: 'x', params: { diameter: 5, positions: [[0, Number.NaN], 'x'] } },
    { id: 'e', type: 'counterbore', name: 'x', params: { diameter: 5, positions: [[0, 0]] } },
    { id: 'f', type: 'holes', name: 'x', params: { diameter: 5, thread: 'G1/4', positions: [[1, 2]] } },
    { id: 'g', type: 'slot', name: 'x', params: { length: 10 } },
    null
  ]);
  assert.deepEqual(odd, [{ featureId: 'f', kind: 'hole', positions: [[1, 2]], diameter: 5, through: true }]);
  assert.deepEqual(holeSpecsOf(undefined), []);
});

test('holesHashOf：不含 featureId；改螺纹、螺纹深、孔径、孔位都会变', () => {
  const base = holesHashOf(holeSpecsOf(flange()));
  const renamed = flange().map((feature) => ({ ...feature, id: `${feature.id}-x`, name: `改名${feature.name}` }));
  assert.equal(holesHashOf(holeSpecsOf(renamed)), base);
  const tweak = (params) => flange().map((feature) => feature.id === 'c3' ? { ...feature, params: { ...feature.params, ...params } } : feature);
  for (const params of [{ thread: 'M8' }, { threadDepth: 8 }, { diameter: 5.2 }, { positions: [[0, 31], [0, -30]] }, { depth: 14 }]) {
    assert.notEqual(holesHashOf(holeSpecsOf(tweak(params))), base, JSON.stringify(params));
  }
});

test('validateHoleSpecs：未提供合法；字段缺失/非法全部报中文错误', () => {
  assert.deepEqual(validateHoleSpecs(undefined, '零件 A'), []);
  assert.deepEqual(validateHoleSpecs(holeSpecsOf(adapter()), '零件 A'), []);
  assert.deepEqual(validateHoleSpecs(holeSpecsOf(flange()), '零件 A'), []);
  assert.deepEqual(validateHoleSpecs({}, '零件 A'), ['零件 A holes 必须是数组']);
  const errors = validateHoleSpecs([
    1,
    { kind: 'boss', positions: [[0, 0]], through: true, diameter: 5 },
    { kind: 'hole', positions: [], through: true, diameter: 5 },
    { kind: 'hole', positions: [[0, 0]], through: false, diameter: 5 },
    { kind: 'slot', positions: [[0, 0]], through: true, length: 10, width: 12 },
    { kind: 'counterbore', positions: [[0, 0]], through: true, diameter: 5 },
    { kind: 'hole', positions: [[0, 0]], through: 'yes', diameter: 5, thread: 'm6', threadDepth: 0 }
  ], '零件 A');
  for (const fragment of ['第 1 组孔不是对象', 'kind 非法', 'positions 必须是非空', '盲孔缺少 depth', '总长不能小于槽宽',
    '沉孔缺少 cbDiameter/cbDepth', 'through 必须是布尔值', 'thread 非法', 'threadDepth 非法']) {
    assert.ok(errors.some((error) => error.includes(fragment)), `${fragment} ∉ ${errors.join(' | ')}`);
  }
  const many = Array.from({ length: MAX_HOLE_SPECS + 1 }, () => ({ kind: 'hole', positions: [[0, 0]], through: true, diameter: 5 }));
  assert.ok(validateHoleSpecs(many, 'A').some((error) => error.includes(`最多 ${MAX_HOLE_SPECS} 组`)));
  const dense = [{ kind: 'hole', positions: Array.from({ length: MAX_HOLE_POSITIONS + 1 }, (_, i) => [i, 0]), through: true, diameter: 1 }];
  assert.ok(validateHoleSpecs(dense, 'A').some((error) => error.includes(`最多 ${MAX_HOLE_POSITIONS} 个`)));
});
