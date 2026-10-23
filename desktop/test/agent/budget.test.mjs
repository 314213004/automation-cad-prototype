import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TOTAL_BUDGET,
  addTokenUsage,
  emptyTokenUsage,
  estimateCostView,
  estimateTokens,
  formatCost,
  formatTokenCount,
  pack,
  resolveModelPrice,
  truncateToTokens
} from '../../src/agent/budget.ts';
import { formatAuditLine } from '../../src/agent/audit.ts';
import { AgentSession } from '../../src/agent/session.ts';

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function createBus(handler) {
  return {
    calls: [],
    async execute(name, args = {}) {
      this.calls.push({ name, args });
      return handler ? await handler(name, args) : { ok: true, data: {} };
    },
    async undoLast() {
      return { ok: true, data: {} };
    }
  };
}

test('token 估算：160 个汉字约 100 tokens', () => {
  assert.equal(estimateTokens('中'.repeat(160)), 100);
  assert.equal(Math.abs(estimateTokens('中'.repeat(160)) - 160 / 1.6) <= 1, true);
});

test('token 估算：400 个 ASCII 字符约 100 tokens', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens(''), 0);
});

test('token 估算：中英混合按 1.6 / 4 字符分别折算', () => {
  assert.equal(estimateTokens(`${'中'.repeat(16)}${'a'.repeat(40)}`), 20);
});

test('token 截断：结果不超预算且保留完整码点', () => {
  const truncated = truncateToTokens('中文上下文'.repeat(200), 40);
  assert.ok(estimateTokens(truncated) <= 40);
  assert.equal(truncated.includes('\uFFFD'), false);
});

test('装包：未超预算时保持原文且不产生 dropped', () => {
  const packed = pack({
    system: '系统策略：写操作必须确认。',
    selection: '选中：QF1',
    memory: '最近：get_bom → OK',
    docs: '文档命中 1 条',
    toolResults: '{"ok":true}',
    history: '用户：你好'
  });
  assert.equal(packed.dropped.length, 0);
  assert.equal(packed.used <= DEFAULT_TOTAL_BUDGET, true);
  for (const name of ['system', 'selection', 'memory', 'docs', 'toolResults', 'history']) {
    assert.match(packed.text, new RegExp(`\\[${name}\\]`));
  }
});

test('装包：总量超限先丢 history，再丢 docs，最后 toolResults', () => {
  const packed = pack({
    system: 'S'.repeat(20),
    history: 'H'.repeat(2000),
    docs: 'D'.repeat(2000),
    toolResults: 'T'.repeat(2000)
  }, { total: 400 });
  assert.equal(packed.used <= 400, true);
  const order = packed.dropped.map((entry) => entry.section);
  assert.ok(order.indexOf('history') !== -1);
  assert.ok(order.indexOf('history') < order.indexOf('docs'));
  assert.ok(order.indexOf('docs') < order.indexOf('toolResults'));
});

test('装包：system 策略段即使超总量也永不裁剪', () => {
  const system = '系统策略不可裁剪。'.repeat(160);
  const packed = pack({
    system,
    docs: '文档'.repeat(500),
    history: '历史'.repeat(500)
  }, { total: 80 });
  assert.equal(packed.text.includes(system), true);
  assert.ok(packed.dropped.some((entry) => entry.code === 'system_protected' && entry.section === 'system'));
  assert.ok(packed.dropped.some((entry) => entry.section === 'history'));
});

test('装包：单档上限触发长列表首尾各 5 条 + total', () => {
  const items = Array.from({ length: 23 }, (_unused, index) => `item-${index} ${'x'.repeat(20)}`);
  const packed = pack({
    system: 'sys',
    toolResults: { items, total: 23 }
  }, { total: 100, listHead: 5, listTail: 5 });
  assert.equal(packed.used <= 100, true);
  for (let index = 0; index < 5; index += 1) assert.match(packed.text, new RegExp(`item-${index}\\b`));
  for (let index = 18; index < 23; index += 1) assert.match(packed.text, new RegExp(`item-${index}\\b`));
  assert.match(packed.text, /共 23 条/);
});

test('装包：超限时 history 从最旧一条开始丢', () => {
  const packed = pack({
    system: 'sys',
    history: Array.from({ length: 4 }, (_unused, index) => `old-${index}-${'x'.repeat(40)}`)
  }, { total: 30, listHead: 5, listTail: 5 });
  assert.equal(packed.used <= 30, true);
  assert.equal(packed.text.includes('old-0-'), false);
  assert.match(packed.text, /old-3-/);
});

test('装包：裁剪原因可读且带档位与数量', () => {
  const items = Array.from({ length: 30 }, (_unused, index) => `doc-${index} ${'说明'.repeat(20)}`);
  const packed = pack({ system: 'sys', docs: { items, total: 30 } }, {
    total: 200,
    caps: { docs: 60 },
    listHead: 5,
    listTail: 5
  });
  assert.ok(packed.dropped.length > 0);
  const reason = packed.dropped.map((entry) => entry.reason).join('\n');
  assert.match(reason, /docs/);
  assert.match(reason, /首尾各 5\/5 条|已截断/);
  assert.match(reason, /共 30 条|tokens/);
});

test('装包：docs 来源数与列表裁剪一致', () => {
  const items = Array.from({ length: 14 }, (_unused, index) => `doc-${index} ${'x'.repeat(200)}`);
  const packed = pack({ system: 'sys', docs: { items, total: 14 } }, {
    total: 600,
    listHead: 5,
    listTail: 5
  });
  assert.ok(packed.docsSources <= 10);
  assert.equal(packed.docsSources, 10);
});

test('token 累计：estimated 一旦出现即保持为 true', () => {
  const real = { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false, requests: 1 };
  const estimated = { promptTokens: 3, completionTokens: 2, totalTokens: 5, estimated: true, requests: 1 };
  const sum = addTokenUsage(real, estimated);
  assert.equal(sum.totalTokens, 20);
  assert.equal(sum.requests, 2);
  assert.equal(sum.estimated, true);
  assert.equal(emptyTokenUsage().totalTokens, 0);
});

test('费用：价格表精确匹配与最长前缀匹配', () => {
  const book = {
    currency: 'CNY',
    unit: 1000,
    models: {
      'gpt-4o': { input: 10, output: 30 },
      'gpt-4o-mini': { input: 1, output: 2 }
    }
  };
  assert.deepEqual(resolveModelPrice(book, 'gpt-4o-mini'), { input: 1, output: 2 });
  assert.deepEqual(resolveModelPrice(book, 'gpt-4o-mini-2026-01'), { input: 1, output: 2 });
  assert.equal(resolveModelPrice(book, 'unknown-model'), null);
});

test('费用：已知模型按输入/输出分别计价并格式化', () => {
  const view = estimateCostView({
    currency: 'CNY',
    unit: 1000,
    models: { 'gpt-test': { input: 1, output: 2 } }
  }, 'gpt-test', 100, 20);
  assert.equal(view.known, true);
  assert.equal(view.amount, 0.14);
  assert.equal(view.display, '¥0.1400');
});

test('费用：未知模型显示 —，零价模型显示 ¥0.0000', () => {
  const unknown = estimateCostView({
    currency: 'CNY',
    unit: 1000,
    models: { 'gpt-test': { input: 1, output: 2 } }
  }, 'other-model', 100, 20);
  assert.equal(unknown.known, false);
  assert.equal(unknown.display, '—');
  assert.equal(formatCost(null), '—');
  const zero = estimateCostView({
    currency: 'CNY',
    unit: 1000,
    models: { free: { input: 0, output: 0 } }
  }, 'free', 999, 999);
  assert.equal(zero.display, '¥0.0000');
});

test('费用：格式化保留四位小数并显示货币符号', () => {
  assert.equal(formatCost(0), '¥0.0000');
  assert.equal(formatCost(0.0123), '¥0.0123');
  assert.equal(formatCost(0.00001), '¥<0.0001');
  assert.equal(formatCost(0.02, 'USD'), '$0.0200');
});

test('tokens 展示：千位分隔与大数缩写', () => {
  assert.equal(formatTokenCount(1234), '1,234');
  assert.equal(formatTokenCount(12345), '12.3k');
  assert.equal(formatTokenCount(1234567), '1.23M');
  assert.equal(formatTokenCount(-1), '0');
});

test('会话：usage 缺失时回落估算并标注 estimated', async () => {
  const session = new AgentSession({
    llm: { async chat() { return { content: '好的', toolCalls: [] }; } },
    bus: createBus(),
    confirmWrite: async () => true,
    model: 'unknown-model'
  });
  await session.run('你好');
  const usage = session.usage();
  assert.equal(usage.turn.estimated, true);
  assert.ok(usage.turn.promptTokens > 0);
  assert.ok(usage.turn.completionTokens > 0);
  assert.equal(usage.turn.requests, 1);
  assert.equal(usage.cost.turn.display, '—');
});

test('会话：端点回传 usage 时使用真实值并累计本会话', async () => {
  let turn = 0;
  const session = new AgentSession({
    llm: {
      async chat() {
        turn += 1;
        return turn === 1
          ? { content: '第一轮', toolCalls: [], usage: { promptTokens: 100, completionTokens: 20 } }
          : { content: '第二轮', toolCalls: [], usage: { promptTokens: 40, completionTokens: 10 } };
      }
    },
    bus: createBus(),
    confirmWrite: async () => true,
    model: 'gpt-test',
    pricing: { currency: 'CNY', unit: 1000, models: { 'gpt-test': { input: 1, output: 2 } } }
  });
  await session.run('第一轮');
  assert.equal(session.usage().turn.totalTokens, 120);
  assert.equal(session.usage().turn.estimated, false);
  assert.equal(session.usage().cost.turn.display, '¥0.1400');
  await session.run('第二轮');
  assert.equal(session.usage().turn.totalTokens, 50);
  assert.equal(session.usage().session.totalTokens, 170);
  assert.equal(session.usage().session.requests, 2);
});

test('审计：带 tokens 字段与 docs 来源数', async () => {
  const lines = [];
  let turn = 0;
  const session = new AgentSession({
    llm: {
      async chat() {
        turn += 1;
        return turn === 1
          ? {
              content: '',
              toolCalls: [toolCall('c1', 'search_docs', { query: 'D2' })],
              usage: { promptTokens: 50, completionTokens: 10 }
            }
          : { content: '完成', toolCalls: [], usage: { promptTokens: 60, completionTokens: 5 } };
      }
    },
    bus: createBus(async () => ({ ok: true, data: { hits: [{ source: 'a' }, { source: 'b' }] } })),
    confirmWrite: async () => true,
    model: 'gpt-test',
    pricing: { currency: 'CNY', unit: 1000, models: { 'gpt-test': { input: 1, output: 2 } } },
    audit: (record) => lines.push(formatAuditLine(record))
  });
  await session.run('查一下文档');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.tool, 'search_docs');
  assert.equal(entry.promptTokens, 50);
  assert.equal(entry.completionTokens, 10);
  assert.equal(entry.estimated, false);
  assert.equal(entry.docsSources, 2);
});

test('审计：formatAuditLine 保留 tokens 与 docsSources', () => {
  const line = formatAuditLine({
    tool: 'search_docs',
    ok: true,
    promptTokens: 12.9,
    completionTokens: 3,
    estimated: true,
    docsSources: 2
  }, new Date('2026-10-23T00:00:00Z'));
  const entry = JSON.parse(line);
  assert.equal(entry.promptTokens, 12);
  assert.equal(entry.completionTokens, 3);
  assert.equal(entry.estimated, true);
  assert.equal(entry.docsSources, 2);
});
