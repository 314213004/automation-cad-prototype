import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSession } from '../../src/agent/session.ts';

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
  assert.match(toolMessage.content, /"count":1/);
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
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('call-x', 'list_components')] }
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
  const parsed = JSON.parse(toolMessage.content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'BOOM');
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
  const parsed = JSON.parse(toolMessage.content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'USER_DENIED');
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
