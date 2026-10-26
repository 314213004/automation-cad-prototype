import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileOps,
  emptyDoc,
  summarize,
  validateFeatures,
  type AssemblyDoc,
  type CompiledAssembly,
  type FeatureDoc,
  type FeatureNode
} from '../src/parametric/features.ts';

const UPDATED = '2026-10-23T12:00:00+08:00';

function doc(features: FeatureNode[], overrides: Partial<FeatureDoc> = {}): FeatureDoc {
  return { schemaVersion: 1, updatedAt: UPDATED, features, ...overrides };
}

function box(overrides: Record<string, unknown> = {}, extra: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: 'f1',
    type: 'box',
    name: '底板',
    params: { length: 120, width: 80, height: 8, ...overrides },
    ...extra
  };
}

function holes(overrides: Record<string, unknown> = {}, extra: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: 'f2',
    type: 'holes',
    name: '安装孔',
    params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]], ...overrides },
    ...extra
  };
}

test('特征树：空树返回中文错误', () => {
  const errors = validateFeatures(doc([]));
  assert.ok(errors.some((message) => message.includes('特征树为空')));
});

test('特征树：合法底板与孔无错误', () => {
  assert.deepEqual(validateFeatures(doc([box(), holes()])), []);
});

test('特征树：重复 id 全量报出并指出序号', () => {
  const errors = validateFeatures(doc([box(), holes({}, { id: 'f1' })]));
  assert.ok(errors.some((message) => message.includes('id「f1」') && message.includes('重复')));
});

test('特征树：未知类型被拒绝', () => {
  const errors = validateFeatures(doc([
    { id: 'f1', type: 'cone' as FeatureNode['type'], name: '锥体', params: {} }
  ]));
  assert.ok(errors.some((message) => message.includes('未知特征类型')));
});

test('特征树：box 缺少必填参数', () => {
  const errors = validateFeatures(doc([box({ length: undefined })]));
  assert.ok(errors.some((message) => message.includes('length') && message.includes('缺少')));
});

test('特征树：参数为非数字或非正数时全部返回', () => {
  const errors = validateFeatures(doc([box({ length: '120', width: 0, height: -8 })]));
  assert.ok(errors.some((message) => message.includes('length') && message.includes('数字')));
  assert.ok(errors.some((message) => message.includes('width') && message.includes('大于 0')));
  assert.ok(errors.some((message) => message.includes('height') && message.includes('大于 0')));
});

test('特征树：holes.positions 为空被拒绝', () => {
  const errors = validateFeatures(doc([box(), holes({ positions: [] })]));
  assert.ok(errors.some((message) => message.includes('孔位不能为空')));
});

test('特征树：holes.positions 必须为二元数组', () => {
  const errors = validateFeatures(doc([box(), holes({ positions: [[0, 0], [1, 2, 3]] })]));
  assert.ok(errors.some((message) => message.includes('[x, y] 二元数组')));
});

test('特征树：孔位出底板包围盒时报错', () => {
  const errors = validateFeatures(doc([box(), holes({ positions: [[61, 0]] })]));
  assert.ok(errors.some((message) => message.includes('底板包围盒外')));
});

test('特征树：非居中底板的坐标范围从 0 开始', () => {
  const errors = validateFeatures(doc([
    box({ centered: false }),
    holes({ positions: [[-1, 20]] })
  ]));
  assert.ok(errors.some((message) => message.includes('底板包围盒外')));
});

test('特征树：孔间距小于孔径按示例格式报错', () => {
  const errors = validateFeatures(doc([box(), holes({ positions: [[-22, 0], [-18, 0]] })]));
  assert.ok(errors.includes('第 2 个特征（安装孔）：孔间距 4.0 mm 小于孔径 6.0 mm'));
});

test('特征树：孔间距等于孔径允许', () => {
  const errors = validateFeatures(doc([box(), holes({ positions: [[-3, 0], [3, 0]] })]));
  assert.deepEqual(errors, []);
});

test('特征树：fillet 半径超过最小板厚一半时报错', () => {
  const errors = validateFeatures(doc([
    box({ height: 8 }),
    { id: 'f2', type: 'fillet', name: '圆角', params: { radius: 4.1, edges: '|Z' } }
  ]));
  assert.ok(errors.some((message) => message.includes('圆角半径') && message.includes('一半')));
});

test('特征树：fillet 半径等于最小板厚一半允许，多板取最小厚度', () => {
  const ok = validateFeatures(doc([
    box({ height: 10 }),
    box({ length: 20, width: 20, height: 6 }, { id: 'f2', name: '凸台' }),
    { id: 'f3', type: 'fillet', name: '圆角', params: { radius: 3, edges: 'all' } }
  ]));
  assert.deepEqual(ok, []);

  const bad = validateFeatures(doc([
    box({ height: 10 }),
    box({ length: 20, width: 20, height: 6 }, { id: 'f2', name: '凸台' }),
    { id: 'f3', type: 'fillet', name: '圆角', params: { radius: 3.1, edges: 'all' } }
  ]));
  assert.ok(bad.some((message) => message.includes('最小板厚 6.0 mm')));
});

test('特征树：updatedAt 必须带时区', () => {
  const errors = validateFeatures(doc([box()], { updatedAt: '2026-10-23T12:00:00' }));
  assert.ok(errors.some((message) => message.includes('updatedAt 必须带时区')));
});

test('特征树：updatedAt 非法日期同样被拒绝', () => {
  const errors = validateFeatures(doc([box()], { updatedAt: '不是日期+08:00' }));
  assert.ok(errors.some((message) => message.includes('updatedAt 必须带时区')));
});

test('compileOps：按特征树顺序输出且保持参数形状', () => {
  const source = doc([
    box(),
    { id: 'f2', type: 'cylinder', name: '凸台', params: { diameter: 20, height: 10, at: [0, 0, 4] } },
    holes(),
    { id: 'f3', type: 'slot', name: '腰孔', params: { length: 50, width: 18 } },
    { id: 'f4', type: 'fillet', name: '圆角', params: { radius: 3 } }
  ]);
  assert.deepEqual(compileOps(source), [
    { op: 'box', length: 120, width: 80, height: 8 },
    { op: 'cylinder', diameter: 20, height: 10, at: [0, 0, 4] },
    { op: 'holes', diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] },
    { op: 'slot', length: 50, width: 18 },
    { op: 'fillet', radius: 3 }
  ]);
});

function counterbore(overrides: Record<string, unknown> = {}, extra: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: 'f3',
    type: 'counterbore',
    name: '沉头孔',
    params: {
      diameter: 6,
      cbDiameter: 11,
      cbDepth: 5,
      depth: 'through',
      positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]],
      ...overrides
    },
    ...extra
  };
}

test('特征树：counterbore 合法参数无错误', () => {
  assert.deepEqual(validateFeatures(doc([box(), counterbore()])), []);
});

test('特征树：沉头直径不大于通孔直径时报错（切不出台阶）', () => {
  const errors = validateFeatures(doc([box(), counterbore({ cbDiameter: 6 })]));
  assert.match(errors.join('；'), /沉头直径 6(\.0)? mm 必须大于通孔直径 6(\.0)? mm/);
});

test('特征树：沉头深度不小于板厚时报错（会切穿板面）', () => {
  const errors = validateFeatures(doc([box(), counterbore({ cbDepth: 8 })]));
  assert.match(errors.join('；'), /沉头深 8(\.0)? mm 不小于板厚 8(\.0)? mm/);
});

test('特征树：沉窝超出底板边界按沉头半径判定', () => {
  const errors = validateFeatures(doc([box(), counterbore({ positions: [[58, 0]] })]));
  assert.match(errors.join('；'), /沉窝 \(5?8(\.0)?, 0(\.0)?\) 超出底板边界/);
});

test('特征树：沉窝间距小于沉头直径时报错（台阶互切）', () => {
  const errors = validateFeatures(doc([box(), counterbore({ positions: [[-5, 0], [5, 0]] })]));
  assert.match(errors.join('；'), /沉窝间距 10(\.0)? mm 小于沉头直径 11(\.0)? mm/);
});

test('compileOps：counterbore 输出孔位与沉头参数', () => {
  const ops = compileOps(doc([box(), counterbore()]));
  assert.deepEqual(ops[1], {
    op: 'counterbore',
    diameter: 6,
    cbDiameter: 11,
    cbDepth: 5,
    positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]],
    depth: 'through'
  });
});

test('compileOps：跳过 suppressed 特征', () => {
  const source = doc([
    box(),
    holes({}, { suppressed: true }),
    { id: 'f3', type: 'slot', name: '腰孔', params: { length: 50, width: 18 } }
  ]);
  assert.deepEqual(compileOps(source).map((op) => op.op), ['box', 'slot']);
});

test('compileOps：确定性与输入不可变', () => {
  const source = doc([box({ centered: false }), holes({ depth: 4 })]);
  const first = compileOps(source);
  const second = compileOps(source);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const outputPositions = first[1]?.positions as number[][];
  outputPositions[0]![0] = 999;
  assert.deepEqual((source.features[1]?.params.positions as number[][])[0], [-44, -24]);
});

test('compileOps：空特征树返回空数组', () => {
  assert.deepEqual(compileOps(doc([])), []);
});

test('compileOps：重复特征 id 不去重且保持输入顺序', () => {
  const ops = compileOps(doc([
    { id: 'dup', type: 'box', name: '第一块', params: { length: 10, width: 10, height: 2 } },
    { id: 'dup', type: 'box', name: '第二块', params: { length: 20, width: 20, height: 3 } }
  ]));
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((op) => op.length), [10, 20]);
});

test('compileOps：未知特征类型抛出中文错误', () => {
  assert.throws(
    () => compileOps(doc([{ id: 'x', type: 'cone' as FeatureNode['type'], name: '锥体', params: {} }])),
    /未知特征类型「cone」/
  );
});

test('compileOps：空 instances 返回空 ops 与空实例', () => {
  const empty: AssemblyDoc = { schemaVersion: 2, updatedAt: UPDATED, instances: [] };
  assert.deepEqual(compileOps(empty), { ops: [], instances: [] });
});

test('compileOps：Unicode 名称与 partId 原样保留', () => {
  const source: AssemblyDoc = {
    schemaVersion: 2,
    updatedAt: UPDATED,
    instances: [{
      id: 'p1',
      name: '上料机构·一号 🦾',
      partId: 'PART-零件-01',
      transform: { x: 0, y: 0, z: 0, rz: 0 },
      features: [{ id: 'f1', type: 'box', name: '底板⊙', params: { length: 10, width: 10, height: 2 } }]
    }]
  };
  const compiled = compileOps(source) as CompiledAssembly;
  assert.equal(compiled.instances[0]?.name, '上料机构·一号 🦾');
  assert.equal(compiled.instances[0]?.partId, 'PART-零件-01');
  assert.equal(compiled.instances[0]?.ops[0]?.op, 'box');
});

test('compileOps：transform 的 NaN/Infinity 回落为 0', () => {
  const source: AssemblyDoc = {
    schemaVersion: 2,
    updatedAt: UPDATED,
    instances: [{
      id: 'p1',
      name: '异常变换',
      transform: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 5, rz: Number.NEGATIVE_INFINITY },
      features: []
    }]
  };
  const compiled = compileOps(source) as CompiledAssembly;
  assert.deepEqual(compiled.instances[0]?.transform, { x: 0, y: 0, z: 5, rz: 0 });
});

test('summarize：统计特征、孔数与抑制数', () => {
  const source = doc([
    box(),
    holes(),
    { id: 'f3', type: 'slot', name: '腰孔', params: { length: 50, width: 18 } },
    { id: 'f4', type: 'holes', name: '备用孔', params: { diameter: 3, positions: [[0, 0]] }, suppressed: true }
  ]);
  assert.deepEqual(summarize(source), { features: 4, holes: 4, suppressed: 1 });
});

test('emptyDoc：schemaVersion 与带时区的 updatedAt', () => {
  const empty = emptyDoc();
  assert.equal(empty.schemaVersion, 1);
  assert.deepEqual(empty.features, []);
  assert.match(empty.updatedAt, /Z$/);
  assert.equal(Number.isNaN(Date.parse(empty.updatedAt)), false);
});

test('特征树：深度与 edges 参数做白名单校验', () => {
  const errors = validateFeatures(doc([
    box(),
    holes({ depth: 0 }),
    { id: 'f3', type: 'fillet', name: '圆角', params: { radius: 3, edges: 'top' } }
  ]));
  assert.ok(errors.some((message) => message.includes('depth')));
  assert.ok(errors.some((message) => message.includes('edges')));
});
