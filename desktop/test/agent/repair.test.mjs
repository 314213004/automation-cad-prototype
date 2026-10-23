import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairToolCall, validateToolArguments } from '../../src/agent/repair.ts';
import { buildFallbackReply, buildRetryPrompt, fallbackCandidates, parseFallbackCandidates } from '../../src/agent/retry.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { emptyAgentContext } from '../../src/agent/context.ts';
import { formatAuditLine } from '../../src/agent/audit.ts';

const searchSchema = {
  type: 'object',
  properties: { q: { type: 'string' }, category: { type: 'string' } },
  required: ['q'],
  additionalProperties: false
};

const updateSchema = {
  type: 'object',
  properties: {
    ref: { type: 'string' },
    partId: { type: 'string' },
    qty: { type: 'integer', minimum: 1 },
    target: { type: 'string', enum: ['auto', 'plate', 'bom'] }
  },
  additionalProperties: false
};

const placeSchema = {
  type: 'object',
  properties: {
    partId: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    rotate: { type: 'boolean' }
  },
  required: ['partId', 'x', 'y'],
  additionalProperties: false
};

test('repair: 剥离 ```json 代码围栏与围栏外解释', () => {
  const result = repairToolCall('这是调用：\n```json\n{"q":"SMC"}\n```\n请执行', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.includes('stripped code fence'));
  assert.ok(result.repairs.includes('stripped surrounding text'));
});

test('repair: 剥离前后解释文字', () => {
  const result = repairToolCall('这是结果：{"q":"SMC"}，请执行。', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.includes('stripped surrounding text'));
});

test('repair: 单引号转双引号', () => {
  const result = repairToolCall("{'q':'SMC'}", searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.some((item) => /single quotes/.test(item)));
});

test('repair: 删除尾逗号', () => {
  const result = repairToolCall('{"q":"SMC",}', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.some((item) => /trailing commas/.test(item)));
});

test('repair: 删除 // 注释且不误伤字符串里的 URL', () => {
  const commented = repairToolCall('{"q":"SMC" // 型号\n}', searchSchema);
  assert.equal(commented.ok, true);
  assert.ok(commented.repairs.some((item) => /comments/.test(item)));
  const url = repairToolCall('{"q":"http://example.com/a"}', searchSchema);
  assert.equal(url.ok, true);
  assert.equal(url.call.args.q, 'http://example.com/a');
  assert.equal(url.repairs.length, 0);
});

test('repair: number 字段的 "120mm" 转 120', () => {
  const result = repairToolCall('{"partId":"p1","x":"120mm","y":40}', placeSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.x, 120);
  assert.ok(result.repairs.some((item) => /120mm/.test(item)));
});

test('repair: number 字段无单位字符串不转换，交给 schema 拒绝', () => {
  const result = repairToolCall('{"partId":"p1","x":"120","y":40}', placeSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEMA_INVALID');
  assert.equal(result.error.path, 'x');
});

test('repair: 字符串 "true" / "false" 转布尔', () => {
  const yes = repairToolCall('{"partId":"p1","x":1,"y":2,"rotate":"true"}', placeSchema);
  assert.equal(yes.ok, true);
  assert.equal(yes.call.args.rotate, true);
  const no = repairToolCall('{"partId":"p1","x":1,"y":2,"rotate":"false"}', placeSchema);
  assert.equal(no.ok, true);
  assert.equal(no.call.args.rotate, false);
});

test('repair: integer 字段的纯数字字符串 "3" 转 3', () => {
  const result = repairToolCall('{"ref":"QF1","qty":"3"}', updateSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.qty, 3);
  assert.ok(result.repairs.some((item) => /integer/.test(item)));
});

test('repair: "3 个" 不猜成 3，返回中文 schema 路径', () => {
  const result = repairToolCall('{"ref":"QF1","qty":"3 个"}', updateSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEMA_INVALID');
  assert.equal(result.error.path, 'qty');
  assert.equal(result.error.message, '参数 qty 应为整数，收到 "3 个"');
});

test('repair: "很多" 不得猜成 1 或其他合理值', () => {
  const result = repairToolCall('{"ref":"QF1","qty":"很多"}', updateSchema);
  assert.equal(result.ok, false);
  assert.equal(result.call, undefined);
  assert.equal(result.error.code, 'SCHEMA_INVALID');
  assert.match(result.error.message, /收到 "很多"/);
});

test('repair: 必填 partId 缺失时从 ctx.selection.id 回填', () => {
  const result = repairToolCall('{"x":10,"y":20}', placeSchema, { selection: { id: 'sel-1' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { x: 10, y: 20, partId: 'sel-1' });
  assert.ok(result.repairs.includes('filled from selection'));
});

test('repair: 必填 partId 缺失且无选中对象时拒绝', () => {
  const result = repairToolCall('{"x":10,"y":20}', placeSchema, { selection: null });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEMA_INVALID');
  assert.equal(result.error.path, 'partId');
  assert.match(result.error.message, /缺少必填参数 partId/);
});

test('repair: additionalProperties:false 删除未知字段并记录', () => {
  const result = repairToolCall('{"q":"SMC","apiKey":"sk-secret"}', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.some((item) => /removed unknown field apiKey/.test(item)));
});

test('repair: additionalProperties:true 保留扩展字段', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: true };
  const result = repairToolCall('{"q":"SMC","extra":1}', schema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.extra, 1);
  assert.equal(result.repairs.length, 0);
});

test('repair: 字符串里的花括号不破坏平衡扫描', () => {
  const result = repairToolCall('说明{"q":"a}b{c"}结束', searchSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.q, 'a}b{c');
});

test('repair: 两个连续 JSON 对象只取第一个并记录', () => {
  const result = repairToolCall('{"q":"a"} {"q":"b"}', searchSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.q, 'a');
  assert.ok(result.repairs.some((item) => /multiple JSON values/.test(item)));
});

test('repair: 工具调用数组取第一个并记录', () => {
  const result = repairToolCall('[{"q":"a"},{"q":"b"}]', searchSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.q, 'a');
  assert.ok(result.repairs.some((item) => /multiple tool calls/.test(item)));
});

test('repair: 解包 {name, arguments} 信封', () => {
  const result = repairToolCall('{"name":"search_components","arguments":{"q":"SMC"}}', searchSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.name, 'search_components');
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.includes('unwrapped tool call envelope'));
});

test('repair: 截断 JSON 补 1 层 } 成功', () => {
  const result = repairToolCall('{"q":"SMC"', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.call.args, { q: 'SMC' });
  assert.ok(result.repairs.some((item) => /completed truncated JSON/.test(item)));
});

test('repair: 截断时字符串引号与 } 一起补全', () => {
  const result = repairToolCall('{"q":"SMC', searchSchema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.q, 'SMC');
  assert.ok(result.repairs.some((item) => /2 layers/.test(item)));
});

test('repair: 截断超过 3 层返回 TRUNCATED_JSON', () => {
  const result = repairToolCall('{"a":{"b":{"c":{"d":1', searchSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TRUNCATED_JSON');
});

test('repair: 不可补全的截断返回 TRUNCATED_JSON', () => {
  const result = repairToolCall('{"q":', searchSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TRUNCATED_JSON');
});

test('repair: 嵌套数组里的字符串整数按 schema 转换', () => {
  const schema = {
    type: 'object',
    properties: { bom: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' } } } } },
    additionalProperties: false
  };
  const result = repairToolCall('{"bom":[{"qty":"3"}]}', schema);
  assert.equal(result.ok, true);
  assert.equal(result.call.args.bom[0].qty, 3);
});

test('repair: 嵌套路径错误使用点号/下标并给中文提示', () => {
  const schema = {
    type: 'object',
    properties: { bom: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' } } } } },
    additionalProperties: false
  };
  const result = repairToolCall('{"bom":[{"qty":"3 个"}]}', schema);
  assert.equal(result.ok, false);
  assert.equal(result.error.path, 'bom[0].qty');
  assert.match(result.error.message, /参数 bom\[0\]\.qty 应为整数/);
});

test('repair: minimum 校验生效', () => {
  const result = repairToolCall('{"ref":"QF1","qty":0}', updateSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.path, 'qty');
  assert.match(result.error.message, /应不小于 1/);
});

test('repair: enum 校验生效', () => {
  const result = repairToolCall('{"ref":"QF1","target":"platex"}', updateSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.path, 'target');
  assert.match(result.error.message, /auto\|plate\|bom/);
});

test('repair: 空参数与空字符串返回 NO_JSON', () => {
  assert.equal(repairToolCall('', searchSchema).error.code, 'NO_JSON');
  assert.equal(repairToolCall('   ', searchSchema).error.code, 'NO_JSON');
  assert.equal(repairToolCall('没有 JSON', searchSchema).error.code, 'NO_JSON');
});

test('repair: 顶层不是对象时拒绝', () => {
  const result = repairToolCall('[1,2]', searchSchema);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_JSON');
});

test('repair: 干净 JSON 不产生 repairs', () => {
  const result = repairToolCall('{"q":"SMC"}', searchSchema);
  assert.equal(result.ok, true);
  assert.deepEqual(result.repairs, []);
});

test('validateToolArguments: 可单独校验并返回首个错误', () => {
  const ok = validateToolArguments({ q: 'SMC' }, searchSchema);
  assert.deepEqual(ok, { ok: true });
  const bad = validateToolArguments({ q: 1 }, searchSchema);
  assert.equal(bad.ok, false);
  assert.equal(bad.path, 'q');
  assert.match(bad.message, /参数 q 应为字符串/);
});

test('retry: 提示包含固定前缀、原因和「只输出 JSON」', () => {
  const prompt = buildRetryPrompt('参数 qty 应为整数，收到 "3 个"');
  assert.match(prompt, /^上次输出错误：/);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /qty/);
});

test('retry: 回落文案恰好两条候选且可解析', () => {
  const reply = buildFallbackReply('参数 qty 无法解析', '算一下这台机台成本');
  const candidates = parseFallbackCandidates(reply);
  assert.equal(candidates.length, 2);
  assert.match(reply, /没听懂/);
  assert.match(reply, /没有执行任何工具/);
  assert.deepEqual(fallbackCandidates('算一下成本').length, 2);
});

function rawCall(id, name, argumentsText) {
  return { id, type: 'function', function: { name, arguments: argumentsText } };
}

function createLlm(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    }
  };
}

function createBus(handler) {
  const calls = [];
  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      return handler ? await handler(name, args) : { ok: true, data: { name, args } };
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: {} };
    }
  };
}

test('session: 围栏包裹的参数先 repair 再执行，并写修复审计', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [rawCall('c1', 'search_components', '```json\n{"q":"SMC"}\n```')] },
    { content: '找到 SMC。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    toolSchemas: { search_components: searchSchema },
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('搜索 SMC');
  assert.equal(reply, '找到 SMC。');
  assert.deepEqual(bus.calls, [{ name: 'search_components', args: { q: 'SMC' } }]);
  const repaired = audit.find((entry) => entry.code === 'TOOL_CALL_REPAIRED');
  assert.ok(repaired);
  assert.equal(repaired.retries, 0);
  assert.ok(repaired.repairs.some((item) => /code fence/.test(item)));
});

test('session: 首次 schema 失败后重试一次成功，审计记录次数与原因', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [rawCall('bad', 'update_component', '{"ref":"QF1","qty":"很多"}')] },
    { content: '', toolCalls: [rawCall('good', 'update_component', '{"ref":"QF1","qty":2}')] },
    { content: '数量已改为 2。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    toolSchemas: { update_component: updateSchema },
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('把 QF1 数量改成 2');
  assert.equal(reply, '数量已改为 2。');
  assert.equal(llm.calls.length, 3);
  const retryMessages = llm.calls[1];
  assert.match(retryMessages.at(-1).content, /上次输出错误：/);
  assert.match(retryMessages.at(-1).content, /只输出 JSON/);
  assert.deepEqual(bus.calls, [{ name: 'update_component', args: { ref: 'QF1', qty: 2 } }]);
  const invalid = audit.find((entry) => entry.code === 'TOOL_CALL_INVALID');
  const retried = audit.find((entry) => entry.code === 'TOOL_CALL_RETRY_OK');
  assert.equal(invalid.retries, 0);
  assert.match(invalid.reason, /qty/);
  assert.equal(retried.retries, 1);
  assert.equal(retried.ok, true);
  assert.match(retried.reason, /qty/);
});

test('session: 重试后仍失败回落为两条候选指令，不执行任何工具', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [rawCall('bad1', 'update_component', '{"ref":"QF1","qty":"很多"}')] },
    { content: '', toolCalls: [rawCall('bad2', 'update_component', '{"ref":"QF1","qty":"更多"}')] }
  ]);
  const bus = createBus();
  const audit = [];
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    toolSchemas: { update_component: updateSchema },
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('把 QF1 数量改一下');
  assert.equal(llm.calls.length, 2);
  assert.equal(bus.calls.length, 0);
  assert.match(reply, /没听懂/);
  assert.match(reply, /候选 1：/);
  assert.match(reply, /候选 2：/);
  assert.equal(parseFallbackCandidates(reply).length, 2);
  assert.equal(audit.filter((entry) => entry.code === 'TOOL_CALL_INVALID').length, 1);
  const fallback = audit.find((entry) => entry.code === 'TOOL_CALL_FALLBACK');
  assert.equal(fallback.retries, 1);
  assert.match(fallback.reason, /qty/);
});

test('session: partId 从上下文选中对象回填后再执行', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [rawCall('p1', 'place_component', '{"x":10,"y":20}')] },
    { content: '已放置。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  const context = {
    ...emptyAgentContext(),
    selection: { kind: 'placement', id: 'p1', label: 'QF1' }
  };
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    contextProvider: () => context,
    toolSchemas: { place_component: placeSchema },
    audit: (record) => audit.push(record)
  });
  const reply = await session.run('把选中的东西放到底板 10,20');
  assert.equal(reply, '已放置。');
  assert.deepEqual(bus.calls, [{ name: 'place_component', args: { x: 10, y: 20, partId: 'p1' } }]);
  assert.ok(audit.some((entry) => entry.repairs?.some((item) => /filled from selection/.test(item))));
});

test('session: 重试失败后不继续消耗 maxIterations', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [rawCall('bad1', 'update_component', '{"qty":"很多"}')] },
    { content: '', toolCalls: [rawCall('bad2', 'update_component', '{"qty":"更多"}')] }
  ]);
  const bus = createBus();
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    maxIterations: 6,
    toolSchemas: { update_component: updateSchema }
  });
  const reply = await session.run('改数量');
  assert.match(reply, /候选 1：/);
  assert.equal(llm.calls.length, 2);
});

test('audit: NDJSON 行保留 retries/reason/repairs 并继续脱敏', () => {
  const line = formatAuditLine({
    tool: 'update_component',
    ok: false,
    code: 'TOOL_CALL_INVALID',
    source: 'llm',
    message: '参数 qty 应为整数，收到 "3 个"',
    reason: 'apiKey=sk-live-secret 参数 qty 无法解析',
    retries: 1,
    repairs: ['removed unknown field apiKey', 'converted "3" to 3 (integer)']
  });
  const parsed = JSON.parse(line);
  assert.equal(parsed.retries, 1);
  assert.match(parsed.reason, /qty/);
  assert.doesNotMatch(parsed.reason, /sk-live-secret/);
  assert.deepEqual(parsed.repairs, [
    'removed unknown field apiKey',
    'converted "3" to 3 (integer)'
  ]);
});
