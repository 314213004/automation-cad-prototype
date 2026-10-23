import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClarify } from '../../src/machine/clarify.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

test('信息完整：不追问', () => {
  const result = buildClarify(parseMachineBrief('设计一台三工位锁螺丝机，节拍 20 件/分钟'));
  assert.deepEqual(result, { needs: [], question: null });
});

test('工艺未知且缺工位/节拍：最多问 2 项', () => {
  const result = buildClarify(parseMachineBrief('帮我设计一台机器'));
  assert.deepEqual(result.needs, ['process', 'stations']);
  assert.equal(result.needs.length, 2);
  assert.match(result.question, /哪类工艺/);
  assert.match(result.question, /默认按 2 工位生成/);
  assert.doesNotMatch(result.question, /目标节拍/);
});

test('工艺已知但缺工位与节拍：问工位和节拍', () => {
  const result = buildClarify(parseMachineBrief('随便设计一台检测机'));
  assert.deepEqual(result.needs, ['stations', 'cycle']);
  assert.match(result.question, /几个工位/);
  assert.match(result.question, /默认按 2 工位生成/);
  assert.match(result.question, /默认按 10 件\/分钟生成/);
});

test('关键词已给出工艺时不追问工艺', () => {
  const result = buildClarify(parseMachineBrief('做一台锁螺丝机'));
  assert.equal(result.needs.includes('process'), false);
  assert.match(result.question, /几个工位/);
});

test('执行机构/传感器缺失不触发追问', () => {
  const result = buildClarify(parseMachineBrief('两工位锁螺丝机，20 件/分钟'));
  assert.deepEqual(result.needs, []);
  assert.equal(result.question, null);
});

test('缺节拍但工位已知：只问节拍，带默认值', () => {
  const result = buildClarify(parseMachineBrief('两工位包装机'));
  assert.deepEqual(result.needs, ['cycle']);
  assert.match(result.question, /目标节拍/);
  assert.match(result.question, /默认按 10 件\/分钟生成/);
});

test('工艺与节拍已知、只缺工位：只问工位', () => {
  const result = buildClarify(parseMachineBrief('设计一台点胶机，20 件/分钟'));
  assert.deepEqual(result.needs, ['stations']);
  assert.match(result.question, /几个工位/);
  assert.doesNotMatch(result.question, /哪类工艺|目标节拍/);
});

test('工艺未知但工位/节拍已知：问工艺，不再问其他项', () => {
  const result = buildClarify(parseMachineBrief('两工位，20 件/分钟，帮我设计一台机器'));
  assert.deepEqual(result.needs, ['process']);
  assert.match(result.question, /哪类工艺/);
});

test('needs 只包含三项白名单且结果确定', () => {
  const brief = parseMachineBrief('随便设计一台设备');
  const first = buildClarify(brief);
  const second = buildClarify(brief);
  assert.deepEqual(first, second);
  assert.ok(first.needs.every((need) => ['process', 'stations', 'cycle'].includes(need)));
  assert.ok(first.needs.length <= 2);
});
