import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  TurnCallDeduper,
  canonicalArgs,
  dedupeToolCalls,
  normalizeNumericString
} from '../../src/agent/dedupe.ts';
import {
  DEFAULT_PARALLEL_CONCURRENCY,
  hasResultDependency,
  planExecutionBatches,
  resultDependencyIndexes,
  runReadOnlyBatch
} from '../../src/agent/parallel.ts';
import {
  DEFAULT_RESULT_CACHE_TTL_MS,
  ToolResultCache
} from '../../src/agent/cache.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { parseToolResultData } from '../../src/agent/guard.ts';
import { formatAuditLine } from '../../src/agent/audit.ts';

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
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
      return typeof response === 'function' ? await response(messages) : response;
    }
  };
}

function createBus(handler) {
  const calls = [];
  const events = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls,
    events,
    get maxActive() {
      return maxActive;
    },
    async execute(name, args = {}) {
      calls.push({ name, args });
      events.push(`${name}:start`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (handler) return await handler(name, args);
        return { ok: true, data: { name, args } };
      } finally {
        active -= 1;
        events.push(`${name}:end`);
      }
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: { command: 'insert_component' } };
    }
  };
}

function createSession(llm, bus, overrides = {}) {
  return new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    maxIterations: 6,
    offlineFallback: false,
    ...overrides
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolMessages(messages) {
  return messages.filter((message) => message.role === 'tool');
}

function contextFor(machine) {
  return {
    domain: 'elec',
    view: '底板',
    selection: null,
    machine: { name: machine, stations: 1, actuators: 0, sensors: 0 },
    plate: { width: 600, height: 400, placed: 0, overlaps: 0 },
    recentActions: [],
    units: 'mm',
    bomRows: 1,
    hasCadModel: false,
    placements: []
  };
}

test('去重参数：键排序、空白压缩与数字字符串归一', () => {
  assert.equal(
    canonicalArgs({ b: ' 1.0 ', a: '  SMC   气缸 ' }),
    canonicalArgs({ a: 'SMC 气缸', b: '1' })
  );
  assert.equal(normalizeNumericString(' 01.500 '), '1.5');
  assert.equal(normalizeNumericString('24V'), '24V');
  assert.equal(canonicalArgs({ x: 40 }), canonicalArgs({ x: ' 40.0 ' }));
  assert.notEqual(canonicalArgs({ x: '1' }), canonicalArgs({ x: '2' }));
});

test('去重决策：同键第二次调用复用首次结果', () => {
  const deduper = new TurnCallDeduper({ isWrite: () => false });
  const decisions = deduper.plan([
    { tool: 'search_components', args: { q: 'SMC' } },
    { tool: 'search_components', args: { q: ' SMC ' } }
  ]);
  assert.equal(decisions[0].action, 'execute');
  assert.equal(decisions[1].action, 'reuse');
  assert.equal(decisions[1].duplicateOf, 0);
  deduper.complete(decisions[0], { ok: true, data: { count: 2 } });
  const next = deduper.plan([{ tool: 'search_components', args: { q: 'SMC' } }]);
  assert.equal(next[0].action, 'reuse');
  assert.equal(next[0].hasResult, true);
  assert.deepEqual(next[0].result, { ok: true, data: { count: 2 } });
});

test('去重决策：不同参数不合并', () => {
  const { decisions, stats } = dedupeToolCalls([
    { tool: 'search_components', args: { q: 'SMC' } },
    { tool: 'search_components', args: { q: 'Festo' } }
  ], { isWrite: () => false });
  assert.deepEqual(decisions.map((item) => item.action), ['execute', 'execute']);
  assert.equal(stats.reused, 0);
});

test('去重决策：写工具即使参数相同也每次独立执行', () => {
  const { decisions } = dedupeToolCalls([
    { tool: 'update_component', args: { ref: 'QF1', model: 'NXB-63' } },
    { tool: 'update_component', args: { ref: 'QF1', model: 'NXB-63' } }
  ], { isWrite: (tool) => tool === 'update_component' });
  assert.deepEqual(decisions.map((item) => item.action), ['execute', 'execute']);
  assert.deepEqual(decisions.map((item) => item.write), [true, true]);
});

test('去重上限：单轮第 13 次调用返回 overflow', () => {
  const inputs = Array.from({ length: DEFAULT_MAX_TOOL_CALLS_PER_TURN + 1 }, (_item, index) => ({
    tool: 'list_components',
    args: { category: `c${index}` }
  }));
  const { decisions, stats } = dedupeToolCalls(inputs, { isWrite: () => false });
  assert.equal(decisions.length, DEFAULT_MAX_TOOL_CALLS_PER_TURN + 1);
  assert.equal(decisions.slice(0, 12).every((item) => item.action === 'execute'), true);
  assert.equal(decisions.at(-1).action, 'overflow');
  assert.equal(stats.overflows, 1);
  assert.equal(stats.executed, 12);
});

test('并行执行：结果顺序与输入顺序一致', async () => {
  const summary = await runReadOnlyBatch([0, 1, 2], async (item) => {
    await sleep(item === 0 ? 30 : 2);
    return item * 10;
  }, { concurrency: 3 });
  assert.deepEqual(summary.results.map((item) => item.value), [0, 10, 20]);
  assert.equal(summary.failed, 0);
  assert.equal(summary.maxConcurrency, 3);
});

test('并行执行：默认并发度为 3', async () => {
  let active = 0;
  let maxActive = 0;
  const summary = await runReadOnlyBatch(Array.from({ length: 6 }, (_item, index) => index), async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active -= 1;
    return 'ok';
  });
  assert.equal(DEFAULT_PARALLEL_CONCURRENCY, 3);
  assert.equal(maxActive, 3);
  assert.equal(summary.maxConcurrency, 3);
});

test('并行执行：并发度可配置为 2', async () => {
  let active = 0;
  let maxActive = 0;
  const summary = await runReadOnlyBatch([1, 2, 3, 4], async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(8);
    active -= 1;
    return item;
  }, { concurrency: 2 });
  assert.equal(maxActive, 2);
  assert.equal(summary.maxConcurrency, 2);
});

test('依赖识别：模板占位符引用前序结果', () => {
  assert.deepEqual(resultDependencyIndexes({ q: '{{1.data.items[0]}}' }), [1]);
  assert.deepEqual(resultDependencyIndexes({ path: '${2}' }), [2]);
  assert.equal(hasResultDependency({ q: 'SMC' }), false);
  assert.equal(hasResultDependency({ q: '{{0.data}}' }), true);
});

test('批次规划：只读并发、写工具屏障、写后串行、依赖单独串行', () => {
  const batches = planExecutionBatches([
    { tool: 'search_components', args: { q: 'SMC' }, readOnly: true },
    { tool: 'get_bom', args: {}, readOnly: true },
    { tool: 'insert_component', args: { partId: 'X' }, readOnly: false },
    { tool: 'search_components', args: { q: '{{0.data.q}}' }, readOnly: true, index: 3 },
    { tool: 'list_components', args: {}, readOnly: true }
  ]);
  assert.deepEqual(batches.map((batch) => batch.indexes), [[0, 1], [2], [3], [4]]);
  assert.deepEqual(batches.map((batch) => batch.reason), ['read-only', 'write', 'write-barrier', 'write-barrier']);
  assert.equal(batches[0].concurrent, true);
  assert.equal(batches[2].concurrent, false);
});

test('并行失败：其他调用完成且错误不被吞掉', async () => {
  const summary = await runReadOnlyBatch(['ok', 'bad'], async (item) => {
    await sleep(item === 'ok' ? 15 : 2);
    if (item === 'bad') throw new Error('注入失败');
    return { ok: true, data: item };
  }, { concurrency: 2 });
  assert.equal(summary.results[0].ok, true);
  assert.deepEqual(summary.results[0].value, { ok: true, data: 'ok' });
  assert.equal(summary.results[1].ok, false);
  assert.match(summary.results[1].error.message, /注入失败/);
  assert.equal(summary.failed, 1);
});

test('缓存：TTL 内命中并返回年龄', () => {
  let now = 1_000;
  const cache = new ToolResultCache({ ttlMs: 30_000, now: () => now });
  assert.equal(cache.set('get_bom', {}, 'fp-a', { ok: true, data: { rows: 3 } }), true);
  now += 1_500;
  const hit = cache.get('get_bom', {}, 'fp-a');
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.result, { ok: true, data: { rows: 3 } });
  assert.equal(hit.ageMs, 1_500);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 0, invalidations: 0, size: 1 });
});

test('缓存：超过 30 秒 TTL 自动失效', () => {
  let now = 0;
  const cache = new ToolResultCache({ now: () => now });
  cache.set('list_components', { category: '气缸' }, 'fp-a', { ok: true, data: { count: 1 } });
  now = DEFAULT_RESULT_CACHE_TTL_MS;
  const miss = cache.get('list_components', { category: '气缸' }, 'fp-a');
  assert.equal(miss.hit, false);
  assert.equal(cache.size(), 0);
});

test('缓存：工程指纹变化时不命中旧结果', () => {
  let now = 1_000;
  const cache = new ToolResultCache({ now: () => now });
  cache.set('get_project_context', {}, 'machine=A;bom=1;placed=0;cad=0', { ok: true, data: { machine: 'A' } });
  now += 500;
  assert.equal(cache.get('get_project_context', {}, 'machine=B;bom=1;placed=0;cad=0').hit, false);
  assert.equal(cache.size(), 0);
});

test('缓存：写操作后清空，失败结果与非缓存工具不写入', () => {
  const now = () => 1_000;
  const cache = new ToolResultCache({ now });
  cache.set('get_bom', {}, 'fp', { ok: true, data: { rows: 1 } });
  cache.set('get_bom', { stale: true }, 'fp', { ok: false, code: 'BOOM' });
  cache.set('search_components', { q: 'SMC' }, 'fp', { ok: true, data: {} });
  assert.equal(cache.size(), 1);
  assert.equal(cache.invalidateAfterWrite('insert_component'), 1);
  assert.equal(cache.get('get_bom', {}, 'fp').hit, false);
  assert.deepEqual(cache.stats(), { hits: 0, misses: 1, invalidations: 1, size: 0 });
});

test('会话：同轮跨迭代的重复 search_components 只执行一次并标 reused', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('s1', 'search_components', { q: 'SMC' })] },
    { content: '', toolCalls: [toolCall('s2', 'search_components', { q: ' SMC ' })] },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => ({ ok: true, data: { name, count: 2 } }));
  const session = createSession(llm, bus);
  assert.equal(await session.run('搜索 SMC'), '完成');
  assert.deepEqual(bus.calls.map((call) => call.name), ['search_components']);
  const tools = toolMessages(llm.calls[2]);
  assert.equal(tools.length, 2);
  const reused = parseToolResultData(tools[1].content);
  assert.equal(reused?.reused, true);
  assert.equal(reused?.reuseSource, 'dedupe');
  assert.equal(session.efficiency().reused, 1);
});

test('会话：同一响应里的重复调用只执行一次', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('b1', 'search_components', { q: 'iC65N' }),
        toolCall('b2', 'search_components', { q: 'iC65N ' }),
        toolCall('b3', 'search_components', { q: 'iC65N' })
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { count: 1 } }));
  const session = createSession(llm, bus);
  await session.run('搜索 iC65N');
  assert.equal(bus.calls.length, 1);
  const tools = toolMessages(llm.calls[1]);
  assert.equal(tools.length, 3);
  assert.equal(parseToolResultData(tools[1].content)?.reused, true);
  assert.equal(parseToolResultData(tools[2].content)?.reused, true);
  assert.equal(session.efficiency().reused, 2);
});

test('会话：写工具同参数连续两次仍独立确认与执行', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('w1', 'update_component', { ref: 'QF1', model: 'NXB-63' }),
        toolCall('w2', 'update_component', { ref: 'QF1', model: 'NXB-63' })
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { updated: true } }));
  let confirms = 0;
  const session = createSession(llm, bus, {
    confirmWrite: async () => {
      confirms += 1;
      return true;
    }
  });
  await session.run('连续改两次 QF1');
  assert.equal(confirms, 2);
  assert.deepEqual(bus.calls.map((call) => call.name), ['update_component', 'update_component']);
});

test('会话：单轮超过 12 次工具调用返回 TOO_MANY_TOOL_CALLS', async () => {
  const calls = Array.from({ length: 13 }, (_item, index) =>
    toolCall(`m${index}`, 'list_components', { category: `c${index}` })
  );
  const llm = createLlm([
    { content: '', toolCalls: calls },
    { content: '请拆分任务。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  const session = createSession(llm, bus, { audit: (record) => audit.push(record) });
  await session.run('执行很多查询');
  assert.equal(bus.calls.length, 12);
  const tools = toolMessages(llm.calls[1]);
  assert.equal(tools.length, 13);
  const overflow = parseToolResultData(tools[12].content);
  assert.equal(overflow?.code, 'TOO_MANY_TOOL_CALLS');
  assert.match(overflow?.message ?? '', /拆分为多轮/);
  assert.equal(audit.some((entry) => entry.code === 'TOO_MANY_TOOL_CALLS'), true);
  assert.equal(session.efficiency().overflows, 1);
});

test('会话：同响应的两个只读调用并行执行且回灌顺序不变', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('p1', 'search_components', { q: 'SMC' }),
        toolCall('p2', 'get_bom')
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => {
    await sleep(name === 'search_components' ? 30 : 5);
    return { ok: true, data: { name } };
  });
  const session = createSession(llm, bus, { parallelConcurrency: 3 });
  await session.run('并行查询');
  assert.equal(bus.maxActive, 2);
  assert.equal(session.efficiency().parallelBatches, 1);
  assert.deepEqual(toolMessages(llm.calls[1]).map((message) => message.name), ['search_components', 'get_bom']);
});

test('会话：参数依赖自动降级为串行', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('d1', 'list_components', { category: '气缸' }),
        toolCall('d2', 'search_components', { q: '{{0.data.q}}' })
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => {
    await sleep(10);
    return { ok: true, data: { name } };
  });
  const session = createSession(llm, bus, { parallelConcurrency: 3 });
  await session.run('依赖查询');
  assert.equal(bus.maxActive, 1);
  assert.equal(session.efficiency().parallelBatches, 0);
  assert.deepEqual(bus.events, [
    'list_components:start', 'list_components:end',
    'search_components:start', 'search_components:end'
  ]);
});

test('会话：写工具作为屏障，后续只读在写完成后执行', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('w1', 'search_components', { q: 'SMC' }),
        toolCall('w2', 'insert_component', { partId: 'MXQ20-50' }),
        toolCall('w3', 'get_bom')
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => ({ ok: true, data: { name } }));
  const session = createSession(llm, bus);
  await session.run('写入后读取');
  assert.deepEqual(bus.calls.map((call) => call.name), ['search_components', 'insert_component', 'get_bom']);
  assert.deepEqual(bus.events, [
    'search_components:start', 'search_components:end',
    'insert_component:start', 'insert_component:end',
    'get_bom:start', 'get_bom:end'
  ]);
});

test('会话：get_bom 跨轮命中会话缓存并写 cacheHit 审计', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('c1', 'get_bom')] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('c2', 'get_bom')] },
    { content: '第二轮完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { rows: 3 } }));
  const audit = [];
  const session = createSession(llm, bus, { audit: (record) => audit.push(record) });
  await session.run('读 BOM');
  await session.run('再读 BOM');
  assert.equal(bus.calls.filter((call) => call.name === 'get_bom').length, 1);
  const secondTurnTools = toolMessages(llm.calls[3]);
  const reused = parseToolResultData(secondTurnTools.at(-1).content);
  assert.equal(reused?.reused, true);
  assert.equal(reused?.cacheHit, true);
  const hitAudit = audit.find((entry) => entry.tool === 'get_bom' && entry.cacheHit === true);
  assert.ok(hitAudit);
  assert.equal(session.efficiency().cacheHits, 1);
});

test('会话：缓存超过 TTL 后重新执行', async () => {
  let now = 1_000;
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('t1', 'get_bom')] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('t2', 'get_bom')] },
    { content: '第二轮完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { rows: 1 } }));
  const session = createSession(llm, bus, { now: () => now });
  await session.run('读 BOM');
  now += DEFAULT_RESULT_CACHE_TTL_MS + 1;
  await session.run('再读 BOM');
  assert.equal(bus.calls.filter((call) => call.name === 'get_bom').length, 2);
});

test('会话：写工具执行后缓存立即失效', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('i1', 'get_bom')] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('i2', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '第二轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('i3', 'get_bom')] },
    { content: '第三轮完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => ({ ok: true, data: { name } }));
  const session = createSession(llm, bus);
  await session.run('读 BOM');
  await session.run('插入气缸');
  await session.run('再读 BOM');
  assert.equal(bus.calls.filter((call) => call.name === 'get_bom').length, 2);
});

test('会话：工程指纹变化导致缓存未命中', async () => {
  let machine = 'A';
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('f1', 'get_bom')] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('f2', 'get_bom')] },
    { content: '第二轮完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { rows: 1 } }));
  const session = createSession(llm, bus, { contextProvider: async () => contextFor(machine) });
  await session.run('读 BOM');
  machine = 'B';
  await session.run('再读 BOM');
  assert.equal(bus.calls.filter((call) => call.name === 'get_bom').length, 2);
});

test('会话：缓存不跨 AgentSession', async () => {
  const bus = createBus(async () => ({ ok: true, data: { rows: 2 } }));
  const first = createSession(createLlm([
    { content: '', toolCalls: [toolCall('n1', 'get_bom')] },
    { content: '完成', toolCalls: [] }
  ]), bus);
  const second = createSession(createLlm([
    { content: '', toolCalls: [toolCall('n2', 'get_bom')] },
    { content: '完成', toolCalls: [] }
  ]), bus);
  await first.run('读 BOM');
  await second.run('读 BOM');
  assert.equal(bus.calls.filter((call) => call.name === 'get_bom').length, 2);
});

test('会话：并行只读失败不吞错误，另一调用仍完成', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('e1', 'search_components', { q: 'SMC' }),
        toolCall('e2', 'get_bom')
      ]
    },
    { content: '有一步失败。', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => {
    await sleep(name === 'search_components' ? 20 : 2);
    if (name === 'get_bom') return { ok: false, error: { code: 'BOOM', message: 'BOM 读取失败' } };
    return { ok: true, data: { name } };
  });
  const session = createSession(llm, bus, { audit: () => {} });
  await session.run('并行读取');
  const tools = toolMessages(llm.calls[1]);
  assert.equal(tools.length, 2);
  assert.equal(parseToolResultData(tools[0].content)?.ok, true);
  const failed = parseToolResultData(tools[1].content);
  assert.equal(failed?.ok, false);
  assert.equal(failed?.error.code, 'BOOM');
  assert.equal(session.efficiency().maxConcurrency, 2);
});

test('会话：list_components 缓存按规范化参数区分', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('l1', 'list_components', { category: ' 气缸 ' })] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('l2', 'list_components', { category: '气缸' })] },
    { content: '第二轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('l3', 'list_components', { category: '断路器' })] },
    { content: '第三轮完成', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { count: 1 } }));
  const session = createSession(llm, bus);
  await session.run('列气缸');
  await session.run('再列气缸');
  assert.equal(session.efficiency().cacheHits, 1);
  await session.run('列断路器');
  assert.deepEqual(bus.calls.map((call) => call.args.category), [' 气缸 ', '断路器']);
});


test('会话：写工具后的同名只读调用不复用写前结果', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('q1', 'get_bom'),
        toolCall('q2', 'insert_component', { partId: 'MXQ20-50' }),
        toolCall('q3', 'get_bom')
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  let bomReads = 0;
  const bus = createBus(async (name) => {
    if (name === 'get_bom') {
      bomReads += 1;
      return { ok: true, data: { rows: bomReads } };
    }
    return { ok: true, data: { name } };
  });
  const session = createSession(llm, bus);
  await session.run('读 BOM 后插入再读');
  assert.equal(bomReads, 2);
  const tools = toolMessages(llm.calls[1]);
  assert.equal(parseToolResultData(tools[0].content)?.reused, undefined);
  assert.equal(parseToolResultData(tools[2].content)?.reused, undefined);
  assert.equal(parseToolResultData(tools[2].content)?.data.rows, 2);
});

test('会话：写工具后的下一轮同名只读调用重新执行', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('r1', 'get_bom')] },
    { content: '第一轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('r2', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '第二轮完成', toolCalls: [] },
    { content: '', toolCalls: [toolCall('r3', 'get_bom')] },
    { content: '第三轮完成', toolCalls: [] }
  ]);
  let bomReads = 0;
  const bus = createBus(async (name) => {
    if (name === 'get_bom') {
      bomReads += 1;
      return { ok: true, data: { rows: bomReads } };
    }
    return { ok: true, data: { name } };
  });
  const session = createSession(llm, bus);
  await session.run('读 BOM');
  await session.run('插入');
  await session.run('再读 BOM');
  assert.equal(bomReads, 2);
  const third = parseToolResultData(toolMessages(llm.calls[5]).at(-1).content);
  assert.equal(third?.reused, undefined);
  assert.equal(third?.data.rows, 2);
});


test('审计：cacheHit 字段落 NDJSON', () => {
  const line = JSON.parse(formatAuditLine({
    tool: 'get_bom',
    ok: true,
    source: 'llm',
    cacheHit: true,
    elapsedMs: 0
  }));
  assert.equal(line.cacheHit, true);
  assert.equal(line.tool, 'get_bom');
  const normal = JSON.parse(formatAuditLine({ tool: 'get_bom', ok: true }));
  assert.equal(Object.hasOwn(normal, 'cacheHit'), false);
});


test('批次规划：同一响应的写后只读全部串行', async () => {
  const steps = planExecutionBatches([
    { tool: 'insert_component', args: { partId: 'X' }, readOnly: false },
    { tool: 'get_bom', args: {}, readOnly: true },
    { tool: 'run_electrical_check', args: {}, readOnly: true }
  ]);
  assert.deepEqual(steps.map((batch) => batch.indexes), [[0], [1], [2]]);
  assert.equal(steps.every((batch) => batch.concurrent === false), true);

  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('sw1', 'insert_component', { partId: 'MXQ20-50' }),
        toolCall('sw2', 'get_bom'),
        toolCall('sw3', 'run_electrical_check')
      ]
    },
    { content: '完成', toolCalls: [] }
  ]);
  const bus = createBus(async (name) => ({ ok: true, data: { name } }));
  const session = createSession(llm, bus, { parallelConcurrency: 3 });
  await session.run('写入后连续读取');
  assert.equal(bus.maxActive, 1);
  assert.deepEqual(bus.events, [
    'insert_component:start', 'insert_component:end',
    'get_bom:start', 'get_bom:end',
    'run_electrical_check:start', 'run_electrical_check:end'
  ]);
});
