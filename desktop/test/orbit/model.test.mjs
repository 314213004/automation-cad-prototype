import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PARAMS,
  applyParamEdit,
  buildAssembly,
  cylinderRadius,
  effectiveParams,
  paramSchema,
  replicatePlacements,
  resetPartOverrides
} from '../../src/orbit/model.ts';

const BASE_INPUTS = { bore: 32, stroke: 50, inserted: [], overrides: {} };
const part = (asm, id) => asm.parts.find((p) => p.id === id);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function edit(inputs, id, key, value) {
  const result = applyParamEdit(inputs, id, key, value);
  assert.equal(result.ok, true, result.message);
  return { ...inputs, overrides: result.overrides };
}

test('默认参数复刻原型坐标：底板/导轨/滑台/法兰/缸体/活塞杆/磁性开关', () => {
  const asm = buildAssembly(BASE_INPUTS);
  assert.deepEqual(asm.parts.map((p) => p.id), ['base', 'rail', 'carriage', 'cyl', 'rod', 'sensor']);
  assert.deepEqual(part(asm, 'base').bbox, { min: [0, 0, 0], max: [210, 72, 8] });
  assert.deepEqual(part(asm, 'rail').bbox, { min: [12, 24, 8], max: [198, 48, 22] });
  assert.deepEqual(part(asm, 'carriage').bbox, { min: [62, 20, 22], max: [122, 52, 44] });
  const cyl = part(asm, 'cyl');
  assert.deepEqual(cyl.prims[0], { type: 'box', min: [72, 16, 44], max: [112, 56, 51], color: cyl.prims[0].color });
  assert.equal(cyl.prims[1].type, 'cyl');
  near(cyl.prims[1].r, 4 + 32 * 0.32);
  assert.deepEqual([cyl.prims[1].z0, cyl.prims[1].z1], [51, 107]);
  const rod = part(asm, 'rod').prims[0];
  assert.deepEqual([rod.z0, rod.z1], [113, 129]);
  const sensor = part(asm, 'sensor').bbox;
  assert.deepEqual([sensor.min[2], sensor.max[2]], [70, 82]);
  near(sensor.min[1], 36 + cylinderRadius(32) - 3);
  assert.equal(asm.sectionX, 92);
  assert.deepEqual(asm.bounds.min, [0, 0, 0]);
  assert.equal(asm.bounds.max[2], 129);
});

test('属性编辑 → 几何：底板加厚沿叠放链整体抬高上方零件', () => {
  const before = buildAssembly(BASE_INPUTS);
  const after = buildAssembly(edit(BASE_INPUTS, 'base', 'thickness', 12));
  assert.equal(part(after, 'base').bbox.max[2], 12);
  for (const id of ['rail', 'carriage', 'cyl', 'rod', 'sensor']) {
    near(part(after, id).bbox.min[2], part(before, id).bbox.min[2] + 4);
    near(part(after, id).bbox.max[2], part(before, id).bbox.max[2] + 4);
  }
});

test('属性编辑 → 几何：滑台位置 X 带动气缸/活塞杆/磁性开关与剖切面', () => {
  const after = buildAssembly(edit(BASE_INPUTS, 'carriage', 'x', 140));
  assert.deepEqual(part(after, 'carriage').bbox.min.slice(0, 1), [110]);
  near(part(after, 'cyl').prims[1].center[0], 140);
  near(part(after, 'rod').prims[0].center[0], 140);
  near(part(after, 'sensor').bbox.min[0], 136);
  assert.equal(after.sectionX, 140);
  assert.deepEqual(part(after, 'rail').bbox, part(buildAssembly(BASE_INPUTS), 'rail').bbox, '导轨不受滑台位置影响');
});

test('属性编辑 → 几何：缸径/行程（原型字段）改变缸体半径、开关位置与杆长，并按原型夹紧', () => {
  const big = buildAssembly({ ...BASE_INPUTS, bore: 50, stroke: 100 });
  near(part(big, 'cyl').prims[1].r, 4 + 50 * 0.32);
  near(part(big, 'sensor').bbox.min[1], 36 + 4 + 50 * 0.32 - 3);
  near(part(big, 'rod').prims[0].z1, 107 + 16 + 100 * 0.12);
  const clamped = buildAssembly({ ...BASE_INPUTS, bore: 999, stroke: 1 });
  near(part(clamped, 'cyl').prims[1].r, 4 + 63 * 0.32);
  near(part(clamped, 'rod').prims[0].z1, 107 + 16 + 10 * 0.12);
});

test('属性编辑 → 几何：导轨/滑台尺寸与开关槽内高度', () => {
  let inputs = edit(BASE_INPUTS, 'rail', 'length', 150);
  inputs = edit(inputs, 'rail', 'height', 20);
  inputs = edit(inputs, 'carriage', 'height', 30);
  inputs = edit(inputs, 'sensor', 'z', 30);
  const asm = buildAssembly(inputs);
  assert.deepEqual(part(asm, 'rail').bbox, { min: [30, 24, 8], max: [180, 48, 28] });
  assert.deepEqual([part(asm, 'carriage').bbox.min[2], part(asm, 'carriage').bbox.max[2]], [28, 58]);
  assert.equal(part(asm, 'sensor').bbox.min[2], 58 + 7 + 30);
});

test('属性编辑校验：非数字、超范围、导轨超底板、滑台脱出导轨均拒绝且不改入参', () => {
  const frozen = JSON.stringify(BASE_INPUTS);
  assert.match(applyParamEdit(BASE_INPUTS, 'base', 'thickness', 'abc').message, /必须是数字/);
  assert.match(applyParamEdit(BASE_INPUTS, 'base', 'thickness', '').message, /必须是数字/);
  assert.match(applyParamEdit(BASE_INPUTS, 'base', 'thickness', 0).message, /超出范围/);
  assert.match(applyParamEdit(BASE_INPUTS, 'rail', 'length', 300).message, /不能超过底板长度/);
  assert.match(applyParamEdit(BASE_INPUTS, 'base', 'width', 20).message, /导轨宽度/);
  assert.match(applyParamEdit(BASE_INPUTS, 'carriage', 'x', 175).message, /脱出导轨.*42–168/);
  assert.match(applyParamEdit(BASE_INPUTS, 'cyl', 'bore', 40).message, /没有可编辑参数/);
  assert.match(applyParamEdit(BASE_INPUTS, 'nope', 'x', 1).message, /没有可编辑参数/);
  assert.equal(applyParamEdit(BASE_INPUTS, 'carriage', 'x', 168).ok, true, '恰好贴到导轨端部允许');
  assert.equal(applyParamEdit(BASE_INPUTS, 'base', 'thickness', ' 10 ').ok, true, '字符串数字可接受');
  assert.equal(JSON.stringify(BASE_INPUTS), frozen);
});

test('参数表与生效值：内置默认、插入件放置、覆盖与恢复默认', () => {
  assert.deepEqual(paramSchema('carriage', BASE_INPUTS).map((d) => d.key), ['length', 'width', 'height', 'x']);
  assert.deepEqual(paramSchema('cyl', BASE_INPUTS), []);
  assert.deepEqual(effectiveParams('base', BASE_INPUTS), DEFAULT_PARAMS.base);
  const ins = { ...BASE_INPUTS, inserted: [{ id: 'ins1', x: 4, y: 2, z: 8, w: 20, d: 20, h: 20 }] };
  assert.deepEqual(paramSchema('ins1', ins).map((d) => d.key), ['w', 'd', 'h', 'x', 'y', 'z']);
  const moved = edit(ins, 'ins1', 'z', 40);
  const asm = buildAssembly(edit(moved, 'ins1', 'h', 35));
  const box = part(asm, 'ins1');
  assert.equal(box.origin, 'inserted');
  assert.deepEqual(box.bbox, { min: [4, 2, 40], max: [24, 22, 75] });
  const reset = { ...moved, overrides: resetPartOverrides(moved.overrides, 'ins1') };
  assert.deepEqual(part(buildAssembly(reset), 'ins1').bbox, { min: [4, 2, 8], max: [24, 22, 28] });
});

test('插入件放置复刻：前两件避开滑台占位，id 顺序保持', () => {
  const placed = replicatePlacements(['ins1', 'ins2', 'ins3']);
  assert.deepEqual(placed.map((p) => [p.id, p.x, p.y, p.z]), [
    ['ins1', 4, 2, 8], ['ins2', 124, 2, 8], ['ins3', 164, 2, 8]
  ]);
  assert.ok(placed.every((p) => p.w === 20 && p.d === 20 && p.h === 20));
});
