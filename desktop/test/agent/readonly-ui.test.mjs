import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditSummaryText,
  buildPlanPreview,
  buildReceipt,
  describeAuditEntry,
  summarizeTurn
} from '../../src/agent/preview.ts';
import { AgentSession } from '../../src/agent/session.ts';

test('计划预览：只读指令标可离线，写指令标需联网确认', () => {
  const read = buildPlanPreview('列一下所有接触器');
  assert.equal(read.tone, 'read');
  assert.equal(read.tool, 'list_components');
  assert.equal(read.readOnly, true);
  assert.equal(read.offlineAllowed, true);
  assert.match(read.title, /只读 · list_components/);
  assert.match(read.hint, /断网时仍可执行/);
  assert.deepEqual(read.args, { category: '接触器' });

  const compute = buildPlanPreview('这台机台成本多少');
  assert.equal(compute.tone, 'read');
  assert.equal(compute.tool, 'run_cost_report');
  assert.equal(compute.intentLabel, '计算');
});

test('计划预览：写操作不进入离线通道，缺参数直接点出来', () => {
  const insert = buildPlanPreview('插入一个气缸');
  assert.equal(insert.tone, 'write');
  assert.equal(insert.tool, 'insert_component');
  assert.equal(insert.readOnly, false);
  assert.equal(insert.offlineAllowed, false);
  assert.deepEqual(insert.missing, ['partId']);
  assert.match(insert.hint, /缺参数：partId/);
  assert.match(insert.hint, /联网/);

  const exportPlan = buildPlanPreview('导出报价单 CSV');
  assert.equal(exportPlan.tone, 'write');
  assert.equal(exportPlan.tool, 'export_cost_report');
  assert.equal(exportPlan.offlineAllowed, false);
  assert.match(exportPlan.hint, /联网并在弹窗中确认/);
});

test('计划预览：空输入与超纲给可操作的下一步，不报错', () => {
  const empty = buildPlanPreview('   ');
  assert.equal(empty.tone, 'none');
  assert.equal(empty.tool, null);
  assert.match(empty.title, /等待输入/);

  const outOfScope = buildPlanPreview('今天天气怎么样');
  assert.equal(outOfScope.tone, 'none');
  assert.equal(outOfScope.intent, 'out_of_scope');
  assert.match(outOfScope.hint, /元件清单|BOM/);
});

test('本轮统计：只数 tool 消息，ok=false 计失败', () => {
  const summary = summarizeTurn([
    { role: 'user', content: '算成本' },
    { role: 'assistant', content: null },
    { role: 'tool', content: JSON.stringify({ ok: true, lines: 3 }) },
    { role: 'tool', content: JSON.stringify({ ok: false, code: 'NO_RESULT' }) },
    { role: 'tool', content: '纯文本结果' }
  ]);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.failures, 1);
  assert.deepEqual(summarizeTurn([]), { toolCalls: 0, failures: 0 });
});

test('统一回执：在线与离线同一套字段，只有通道与提示不同', () => {
  const online = buildReceipt({ mode: 'online', elapsedMs: 1234, toolCalls: 2 });
  assert.equal(online.tone, 'is-ok');
  assert.equal(online.modeLabel, '在线模型');
  assert.equal(online.text, '在线模型 · 耗时 1.2s · 工具 2 次');
  assert.match(online.note, /写操作会先弹出确认/);

  const offline = buildReceipt({ mode: 'offline', elapsedMs: 420, toolCalls: 1, failures: 1 });
  assert.equal(offline.tone, 'is-warn');
  assert.equal(offline.text, '离线规则 · 耗时 420ms · 工具 1 次 · 失败 1 次');
  assert.match(offline.note, /只执行只读工具/);

  const broken = buildReceipt({ mode: 'online', elapsedMs: Number.NaN, toolCalls: Number.NaN });
  assert.match(broken.text, /耗时 —/);
  assert.match(broken.text, /工具 0 次/);
});

test('审计行：成功/失败与来源都可读，空审计有明确文案', () => {
  const okRow = describeAuditEntry({
    at: '2026-10-23T02:00:00.000Z',
    tool: 'run_cost_report',
    ok: true,
    source: 'offline'
  });
  assert.equal(okRow.tone, 'is-ok');
  assert.match(okRow.title, /run_cost_report · 成功/);
  assert.match(okRow.meta, /离线规则/);

  const failRow = describeAuditEntry({
    at: '2026-10-23T02:01:00.000Z',
    tool: 'search_components',
    ok: false,
    code: 'NO_RESULT',
    source: 'llm'
  });
  assert.equal(failRow.tone, 'is-error');
  assert.match(failRow.meta, /在线模型/);
  assert.match(failRow.meta, /错误码 NO_RESULT/);

  assert.equal(auditSummaryText(null), '暂无审计记录');
  assert.equal(auditSummaryText({ total: 0, failed: 0, tools: {}, lastAt: null }), '暂无审计记录');
  const text = auditSummaryText({ total: 3, failed: 1, tools: { a: 3 }, lastAt: '2026-10-23T02:00:00.000Z' });
  assert.match(text, /共 3 条 · 失败 1/);
});

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('会话模式：默认在线，离线降级后回 offline，清空后复位', async () => {
  const failing = {
    async chat() {
      throw new Error('断网');
    }
  };
  const bus = {
    calls: [],
    async execute(name, args = {}) {
      this.calls.push({ name, args });
      return { ok: true, data: { name } };
    },
    async undoLast() {
      return { ok: true, data: {} };
    }
  };
  const session = new AgentSession({ llm: failing, bus, confirmWrite: async () => false });
  assert.equal(session.mode(), 'online');
  const reply = await session.run('列一下所有接触器');
  assert.match(reply, /离线规则路由/);
  assert.equal(session.mode(), 'offline');
  session.clear();
  assert.equal(session.mode(), 'online');

  const online = new AgentSession({
    llm: { async chat() { return { content: '好的', toolCalls: [] }; } },
    bus,
    confirmWrite: async () => false
  });
  await online.run('算一下成本');
  assert.equal(online.mode(), 'online');
});

test('会话模式：离线时写指令不走离线通道，抛原始错误且模式保持在线', async () => {
  const session = new AgentSession({
    llm: { async chat() { throw new Error('模型不可用'); } },
    bus: { async execute() { throw new Error('不应执行'); }, async undoLast() { throw new Error('不应执行'); } },
    confirmWrite: async () => false
  });
  await assert.rejects(() => session.run('插入一个气缸'), /模型不可用/);
  assert.equal(session.mode(), 'online');
});

test('会话工具调用：在线路径正常回包并保持 online 模式', async () => {
  const responses = [
    { content: '', toolCalls: [toolCall('c1', 'run_cost_report', {})] },
    { content: '成本约 1398.64', toolCalls: [] }
  ];
  let index = 0;
  const session = new AgentSession({
    llm: { async chat() { return responses[Math.min(index++, responses.length - 1)]; } },
    bus: { async execute() { return { ok: true, data: { grand: 1398.64 } }; }, async undoLast() { return { ok: true, data: {} }; } },
    confirmWrite: async () => false
  });
  const reply = await session.run('这台机台成本多少');
  assert.equal(reply, '成本约 1398.64');
  assert.equal(session.mode(), 'online');
});
