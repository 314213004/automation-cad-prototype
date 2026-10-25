import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODEL_BUILDERS,
  pickModelBuilder,
  normalizeModelParams,
  toConveyorParams,
  RULES_ONLY_PROCESSES
} from '../../src/machine/model-builders.ts';

test('注册表：输送机走参数化引擎，参数清单非空', () => {
  const builder = pickModelBuilder('conveyor');
  assert.ok(builder);
  assert.equal(builder.engine, 'parametric');
  assert.ok(builder.params.length >= 4);
  assert.ok(builder.params.some((spec) => spec.name === 'lengthMm'));
});

test('注册表：没有构建器的机型返回 null，而不是抛错或伪造', () => {
  assert.equal(pickModelBuilder('screw'), null);
  assert.equal(pickModelBuilder(undefined), null);
  assert.equal(pickModelBuilder('不存在的工艺'), null);
  for (const process of RULES_ONLY_PROCESSES) {
    assert.equal(MODEL_BUILDERS[process], undefined, `${process} 不应有参数化构建器`);
  }
});

test('参数：缺省值自动补齐', () => {
  const builder = pickModelBuilder('conveyor');
  const result = normalizeModelParams(builder, {});
  assert.equal(result.ok, true);
  assert.equal(result.params.lengthMm, 2000);
  assert.equal(result.params.widthMm, 300);
});

test('参数：越界夹紧并说明，不静默接受', () => {
  const builder = pickModelBuilder('conveyor');
  const result = normalizeModelParams(builder, { lengthMm: 99999, widthMm: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.params.lengthMm, 12000);
  assert.equal(result.params.widthMm, 100);
  assert.match(result.message ?? '', /超出/);
});

test('参数：非数字报错，未知键回传不静默丢弃', () => {
  const builder = pickModelBuilder('conveyor');
  assert.equal(normalizeModelParams(builder, { lengthMm: 'abc' }).ok, false);
  const withUnknown = normalizeModelParams(builder, { lengthMm: 1500, 乱写: 1 });
  assert.deepEqual(withUnknown.ignored, ['乱写']);
  assert.match(withUnknown.message ?? '', /忽略未知参数/);
});

test('toConveyorParams 只取已知键，缺的落回默认', () => {
  const params = toConveyorParams({ lengthMm: 1500 });
  assert.equal(params.lengthMm, 1500);
  assert.equal(params.widthMm, 300);
  assert.equal(params.beltHeightMm, 850);
});
