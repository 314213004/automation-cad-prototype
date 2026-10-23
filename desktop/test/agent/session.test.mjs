import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSession } from '../../src/agent/session.ts';
import { parseToolResultData } from '../../src/agent/guard.ts';

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
      if (typeof response === 'function') return await response(messages);
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
      if (handler) return await handler(name, args);
      return { ok: true, data: { name, args } };
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
    ...overrides
  });
}

test('会话 0 次工具调用时直接返回助手文本', async () => {
  const llm = createLlm([{ content: '你好，我可以帮助设计。', toolCalls: [] }]);
  const bus = createBus();
  const session = createSession(llm, bus);
  const reply = await session.run('你好');
  assert.equal(reply, '你好，我可以帮助设计。');
  assert.equal(bus.calls.length, 0);
  assert.deepEqual(session.history().map((message) => message.role), ['user', 'assistant']);
});

test('会话 1 次工具调用后继续生成最终文本', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'list_components', { category: '气缸' })] },
    { content: '找到 1 个气缸。', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: true, data: { count: 1, components: [{ id: 'MXQ20-50' }] } }));
  const session = createSession(llm, bus);
  const reply = await session.run('列出气缸');
  assert.equal(reply, '找到 1 个气缸。');
  assert.deepEqual(bus.calls, [{ name: 'list_components', args: { category: '气缸' } }]);
  const toolMessage = llm.calls[1].find((message) => message.role === 'tool');
  assert.equal(toolMessage.name, 'list_components');
  assert.equal(toolMessage.tool_call_id, 'call-1');
  assert.match(toolMessage.content, /tool_result_data/);
  assert.equal(parseToolResultData(toolMessage.content)?.data?.count, 1);
});

test('会话 2 次工具调用按顺序执行并回灌结果', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-1', 'search_components', { q: 'SMC' })] },
    { content: '', toolCalls: [toolCall('call-2', 'get_bom')] },
    { content: '已完成。', toolCalls: [] }
  ]);
  const bus = createBus();
  const session = createSession(llm, bus);
  const reply = await session.run('搜索并读取 BOM');
  assert.equal(reply, '已完成。');
  assert.deepEqual(bus.calls.map((call) => call.name), ['search_components', 'get_bom']);
  assert.equal(llm.calls.length, 3);
});

test('超过最大轮数返回约定提示', async () => {
  let round = 0;
  const llm = createLlm([
    () => {
      round += 1;
      return { content: '', toolCalls: [toolCall(`call-x-${round}`, 'list_components', { q: `r${round}` })] };
    }
  ]);
  const bus = createBus();
  const session = createSession(llm, bus, { maxIterations: 3 });
  const reply = await session.run('一直调用工具');
  assert.equal(reply, '已达到最大工具调用轮数（3），请缩小任务范围');
  assert.equal(llm.calls.length, 3);
  assert.equal(bus.calls.length, 3);
});

test('工具失败结果原样回灌给模型且对话继续', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-fail', 'get_bom')] },
    { content: '读取失败，请稍后再试。', toolCalls: [] }
  ]);
  const bus = createBus(async () => ({ ok: false, error: { code: 'BOOM', message: '业务失败' } }));
  const session = createSession(llm, bus);
  const reply = await session.run('读取 BOM');
  assert.equal(reply, '读取失败，请稍后再试。');
  const toolMessage = llm.calls[1].find((message) => message.role === 'tool');
  const parsed = parseToolResultData(toolMessage.content);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.error.code, 'BOOM');
  assert.equal(parsed.error.message, '业务失败');
});

test('写工具确认被拒绝时不执行命令并返回 USER_DENIED', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-insert', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '已取消插入。', toolCalls: [] }
  ]);
  const bus = createBus();
  const prompts = [];
  const session = createSession(llm, bus, {
    confirmWrite: async (name, args) => {
      prompts.push({ name, args });
      return false;
    }
  });
  const reply = await session.run('插入一个气缸');
  assert.equal(reply, '已取消插入。');
  assert.equal(bus.calls.length, 0);
  assert.deepEqual(prompts, [{ name: 'insert_component', args: { partId: 'MXQ20-50' } }]);
  const toolMessage = llm.calls[1].find((message) => message.role === 'tool');
  const parsed = parseToolResultData(toolMessage.content);
  assert.equal(parsed?.ok, false);
  assert.equal(parsed?.code, 'USER_DENIED');
});

test('写工具 export_cost_report 执行前请求二次确认', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-export', 'export_cost_report', { format: 'csv' })] },
    { content: '报价单已导出。', toolCalls: [] }
  ]);
  const bus = createBus();
  const prompts = [];
  const session = createSession(llm, bus, {
    confirmWrite: async (name, args) => {
      prompts.push({ name, args });
      return true;
    }
  });
  const reply = await session.run('导出一份 CSV 报价单');
  assert.equal(reply, '报价单已导出。');
  assert.deepEqual(prompts, [{ name: 'export_cost_report', args: { format: 'csv' } }]);
  assert.deepEqual(bus.calls, [{ name: 'export_cost_report', args: { format: 'csv' } }]);
});

test('历史只保留最近 20 条消息', async () => {
  const llm = createLlm([{ content: '收到', toolCalls: [] }]);
  const bus = createBus();
  const session = createSession(llm, bus);
  for (let index = 0; index < 12; index += 1) {
    await session.run(`消息 ${index}`);
  }
  const history = session.history();
  assert.equal(history.length, 20);
  assert.equal(history.at(-2).role, 'user');
  assert.equal(history.at(-1).role, 'assistant');
  assert.equal(history.at(-2).content, '消息 11');
});

function denialContext() {
  return {
    domain: 'elec',
    view: '底板',
    selection: { kind: 'placement', id: 'p1', label: 'QF1' },
    machine: { name: '烟包机', stations: 3, actuators: 6, sensors: 8 },
    plate: { width: 600, height: 400, placed: 2, overlaps: 0 },
    recentActions: [],
    units: 'mm',
    bomRows: 2,
    hasCadModel: true,
    placements: [
      { id: 'p1', label: 'QF1', model: 'iC65N-C16-1P', x: 20, y: 30, w: 36, h: 80 },
      { id: 'p2', label: 'KM1', model: 'LC1D09', x: 80, y: 30, w: 45, h: 80 }
    ]
  };
}

test('跨轮拒绝：用户拒绝后写入 denials 并带审计字段', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('d1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已取消修改。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => false,
    audit: (record) => audit.push(record)
  });
  await session.run('把 QF1 改成 NXB-63');
  const denial = session.threadState()?.denials?.[0];
  assert.equal(denial?.tool, 'update_component');
  assert.equal(denial?.target, 'QF1');
  assert.equal(denial?.reason, 'user');
  assert.equal(denial?.turnId, '1');
  assert.match(denial?.at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  const record = audit.find((entry) => entry.code === 'USER_DENIED' && entry.tool === 'update_component');
  assert.equal(record?.target, 'QF1');
  assert.equal(record?.denialReason, 'user');
  assert.equal(record?.deniedTurnId, '1');
  assert.equal(bus.calls.length, 0);
});

test('跨轮拒绝：下一轮不带明确同意时执行层短路且不弹确认', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('d1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已取消修改。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('d2', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '这次没有执行，需要你明确同意。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  let confirms = 0;
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => {
      confirms += 1;
      return false;
    },
    audit: (record) => audit.push(record)
  });
  await session.run('把 QF1 改成 NXB-63');
  await session.run('继续');
  assert.equal(confirms, 1);
  assert.equal(bus.calls.length, 0);
  const toolMessage = llm.calls[3].filter((message) => message.role === 'tool').at(-1);
  const parsed = parseToolResultData(toolMessage.content);
  assert.equal(parsed?.code, 'USER_DENIED_PREVIOUSLY');
  assert.match(parsed?.message ?? '', /你在第 1 轮拒绝过这个操作，需要明确同意才会重试/);
  const prompt = llm.calls[2][0].content;
  assert.match(prompt, /跨轮拒绝记忆/);
  assert.match(prompt, /update_component\(QF1\)（用户拒绝，第 1 轮）/);
  const blocked = audit.find((entry) => entry.code === 'USER_DENIED_PREVIOUSLY');
  assert.equal(blocked?.target, 'QF1');
  assert.equal(blocked?.denialReason, 'user');
  assert.equal(blocked?.deniedTurnId, '1');
});

test('跨轮拒绝：用户明确同意后清除 denial 并重新走确认', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('d1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已取消修改。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('d2', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已重新确认并执行。', toolCalls: [] }
  ]);
  const bus = createBus();
  const audit = [];
  let confirms = 0;
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => {
      confirms += 1;
      return confirms > 1;
    },
    audit: (record) => audit.push(record)
  });
  await session.run('把 QF1 改成 NXB-63');
  await session.run('我同意，现在就改');
  assert.equal(confirms, 2);
  assert.deepEqual(bus.calls.map((call) => call.name), ['update_component']);
  assert.deepEqual(session.threadState()?.denials, []);
  const cleared = audit.find((entry) => entry.code === 'DENIAL_CLEARED');
  assert.equal(cleared?.consent, true);
  assert.equal(cleared?.target, 'QF1');
  assert.equal(cleared?.deniedTurnId, '1');
});

test('跨轮拒绝：确认超时只留下可重试提示，下一轮可直接重新确认', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('t1', 'update_component', { ref: 'QF1', qty: 2 })] },
    { content: '确认超时。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('t2', 'update_component', { ref: 'QF1', qty: 2 })] },
    { content: '已执行。', toolCalls: [] }
  ]);
  const bus = createBus();
  let confirms = 0;
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => {
      confirms += 1;
      if (confirms === 1) throw new Error('确认超时');
      return true;
    }
  });
  await session.run('把 QF1 数量改成 2');
  assert.equal(session.threadState()?.denials?.[0]?.reason, 'timeout');
  await session.run('继续');
  assert.match(llm.calls[2][0].content, /超时不是永久拒绝/);
  assert.equal(confirms, 2);
  assert.deepEqual(bus.calls.map((call) => call.name), ['update_component']);
  assert.deepEqual(session.threadState()?.denials, []);
});

test('跨轮拒绝：换目标不触发短路', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('g1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已取消。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('g2', 'update_component', { ref: 'KM1', model: 'NXB-63' })] },
    { content: '已修改 KM1。', toolCalls: [] }
  ]);
  const bus = createBus();
  let confirms = 0;
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => {
      confirms += 1;
      return confirms > 1;
    }
  });
  await session.run('把 QF1 改成 NXB-63');
  await session.run('继续');
  assert.equal(confirms, 2);
  assert.deepEqual(bus.calls.map((call) => [call.name, call.args.ref]), [['update_component', 'KM1']]);
  assert.deepEqual(session.threadState()?.denials.map((item) => item.target), ['QF1']);
});

test('跨轮拒绝：换工具不触发短路', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('h1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已取消。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('h2', 'remove_component', { ref: 'QF1' })] },
    { content: '已移除 QF1。', toolCalls: [] }
  ]);
  const bus = createBus();
  let confirms = 0;
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: async () => {
      confirms += 1;
      return confirms > 1;
    }
  });
  await session.run('把 QF1 改成 NXB-63');
  await session.run('继续');
  assert.equal(confirms, 2);
  assert.deepEqual(bus.calls.map((call) => call.name), ['remove_component']);
  assert.deepEqual(session.threadState()?.denials.map((item) => item.tool), ['update_component']);
});

test('跨轮拒绝：策略拦截写为 policy 并同样短路', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('p1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '写操作缺少确认。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('p2', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '需要明确同意。', toolCalls: [] }
  ]);
  const bus = createBus();
  const session = createSession(llm, bus, {
    contextProvider: async () => denialContext(),
    confirmWrite: undefined
  });
  await session.run('把 QF1 改成 NXB-63');
  assert.equal(session.threadState()?.denials?.[0]?.reason, 'policy');
  await session.run('继续');
  const toolMessage = llm.calls[3].filter((message) => message.role === 'tool').at(-1);
  const parsed = parseToolResultData(toolMessage.content);
  assert.equal(parsed?.code, 'USER_DENIED_PREVIOUSLY');
  assert.match(parsed?.message ?? '', /被策略拦截过，需要明确同意才会重试/);
  assert.equal(bus.calls.length, 0);
});
