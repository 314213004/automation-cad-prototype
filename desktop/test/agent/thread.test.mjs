import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentThread,
  augmentContextWithThreadReference,
  denialTarget,
  findDenial,
  formatDenialPrompt,
  formatThreadContext,
  nextIncompleteStep,
  normalizeDenials,
  projectFingerprint,
  removeDenial,
  resolveThreadReference,
  runPlan
} from '../../src/agent/thread.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { resolveReference } from '../../src/agent/reference.ts';

function context(overrides = {}) {
  return {
    domain: 'elec',
    view: '底板',
    selection: { kind: 'placement', id: 'p1', label: 'QF1' },
    machine: { name: '烟包机', stations: 3, actuators: 6, sensors: 8 },
    plate: { width: 600, height: 400, placed: 2, overlaps: 0 },
    recentActions: [],
    units: 'mm',
    bomRows: 6,
    hasCadModel: true,
    placements: [
      { id: 'p1', label: 'QF1', x: 20, y: 30, w: 36, h: 80 },
      { id: 'p2', label: 'KM1', x: 80, y: 30, w: 36, h: 80 }
    ],
    ...overrides
  };
}

function state(fingerprint, completedSteps = [], extra = {}) {
  return {
    turnId: 1,
    projectFingerprint: fingerprint,
    intent: 'modify',
    targets: ['QF1'],
    completedSteps,
    lastReplySummary: '上一轮已完成',
    ...extra
  };
}

function plan(tools = ['get_bom', 'run_cost_report', 'export_cost_report']) {
  return {
    steps: tools.map((tool) => ({
      tool,
      args: tool === 'export_cost_report' ? { format: 'csv' } : {},
      why: 'test',
      readOnly: tool === 'get_bom' || tool === 'run_cost_report'
    })),
    confidence: 1
  };
}

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
      return { ok: true, data: { command: 'update_component' } };
    }
  };
}

test('工程指纹包含机型/BOM/放置数/CAD 四项', () => {
  assert.equal(projectFingerprint(context()), 'machine=烟包机;bom=6;placed=2;cad=1');
});

test('机型变化会生成新指纹', () => {
  const changed = context({ machine: { name: '装盒机', stations: 3, actuators: 6, sensors: 8 } });
  assert.notEqual(projectFingerprint(context()), projectFingerprint(changed));
});

test('BOM 行数变化会生成新指纹', () => {
  assert.notEqual(projectFingerprint(context()), projectFingerprint(context({ bomRows: 7 })));
});

test('底板放置数变化会生成新指纹', () => {
  assert.notEqual(projectFingerprint(context()), projectFingerprint(context({
    plate: { width: 600, height: 400, placed: 3, overlaps: 0 }
  })));
});

test('CAD 模型有无变化会生成新指纹', () => {
  assert.notEqual(projectFingerprint(context()), projectFingerprint(context({ hasCadModel: false })));
});

test('完全相同的工程指纹不报告差异', () => {
  const current = projectFingerprint(context());
  const prompt = formatThreadContext(state(current), context());
  assert.match(prompt, /工程指纹：与上一轮一致/);
  assert.doesNotMatch(prompt, /工程已变化/);
});

test('状态写入后可读且是深拷贝', () => {
  const thread = new AgentThread();
  const written = thread.write(state(projectFingerprint(context())));
  assert.equal(thread.read()?.turnId, 1);
  written.targets.push('KM1');
  assert.deepEqual(thread.read()?.targets, ['QF1']);
});

test('每轮 finish 自增 turnId', () => {
  const thread = new AgentThread();
  thread.finish({ reply: '第一轮', context: context(), completedSteps: [] });
  thread.finish({ reply: '第二轮', context: context(), completedSteps: [] });
  assert.equal(thread.read()?.turnId, 2);
});

test('clear 清空线程状态', () => {
  const thread = new AgentThread();
  thread.finish({ reply: 'ok', context: context(), completedSteps: [] });
  thread.clear();
  assert.equal(thread.read(), null);
});

test('没有上一轮状态时不注入线程提示', () => {
  assert.equal(formatThreadContext(null, context()), '');
});

test('线程提示包含上一轮意图/对象/步骤/摘要', () => {
  const thread = new AgentThread();
  const finished = thread.finish({
    intent: 'modify',
    context: context(),
    completedSteps: [{ step: 1, index: 0, tool: 'update_component', args: { ref: 'QF1' }, ok: true, wrote: true }],
    reply: '已把 QF1 改成 NXB-63'
  });
  const prompt = formatThreadContext(finished, context());
  assert.match(prompt, /第 1 轮/);
  assert.match(prompt, /意图 modify/);
  assert.match(prompt, /QF1/);
  assert.match(prompt, /update_component/);
  assert.match(prompt, /上一轮结果：已完成/);
  assert.match(prompt, /已把 QF1 改成 NXB-63/);
});

test('工程变化时提示不要沿用旧结论并列出差异', () => {
  const previous = state(projectFingerprint(context()));
  const changed = context({
    machine: { name: '装盒机', stations: 3, actuators: 6, sensors: 8 },
    bomRows: 7,
    plate: { width: 600, height: 400, placed: 3, overlaps: 0 }
  });
  const prompt = formatThreadContext(previous, changed);
  assert.match(prompt, /工程已变化，不要沿用旧结论/);
  assert.match(prompt, /机型 烟包机 → 装盒机/);
  assert.match(prompt, /BOM 行数 6 → 7/);
  assert.match(prompt, /底板放置数 2 → 3/);
});

test('未确认操作在下一轮提示中优先询问是否继续', () => {
  const previous = state(projectFingerprint(context()), [], {
    pendingConfirm: {
      tool: 'update_component',
      args: { ref: 'QF1', qty: 2 },
      stepIndex: 0,
      reason: 'timeout'
    }
  });
  const prompt = formatThreadContext(previous, context());
  assert.match(prompt, /未确认操作/);
  assert.match(prompt, /确认超时/);
  assert.match(prompt, /是否继续上次未确认的操作/);
  assert.match(prompt, /不得执行/);
});

test('用户拒绝后的提示明确禁止自动重试', () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'insert_component', args: {}, ok: false, code: 'USER_DENIED', wrote: false }
  ]);
  const prompt = formatThreadContext(previous, context());
  assert.match(prompt, /上一轮结果：未完成/);
  assert.match(prompt, /用户已拒绝：insert_component/);
  assert.match(prompt, /不要自动重试/);
});

test('nextIncompleteStep 跳过成功步骤并在失败处重试', () => {
  assert.equal(nextIncompleteStep([], 3), 0);
  assert.equal(nextIncompleteStep([
    { step: 1, index: 0, tool: 'a', ok: true, wrote: false },
    { step: 2, index: 1, tool: 'b', ok: true, wrote: false }
  ], 3), 2);
  assert.equal(nextIncompleteStep([
    { step: 1, index: 0, tool: 'a', ok: true, wrote: false },
    { step: 2, index: 1, tool: 'b', ok: false, code: 'BOOM', wrote: false }
  ], 3), 1);
  assert.equal(nextIncompleteStep([
    { step: 1, index: 0, tool: 'a', ok: true, wrote: false },
    { step: 3, index: 2, tool: 'c', ok: true, wrote: false }
  ], 3), 1);
});

test('runPlan 续跑跳过已完成步骤', async () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'get_bom', args: {}, ok: true, wrote: false }
  ]);
  const executed = [];
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous,
    currentContext: context(),
    confirmPlan: async () => true,
    execute: async (step, index) => {
      executed.push(index);
      return { ok: true, data: { index } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.resumedFrom, 1);
  assert.equal(result.skippedSteps, 1);
  assert.deepEqual(executed, [1, 2]);
});

test('指纹变化时拒绝续跑且不执行任何工具', async () => {
  const previous = state(projectFingerprint(context()));
  const changed = context({ machine: { name: '装盒机', stations: 3, actuators: 6, sensors: 8 } });
  let executed = 0;
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous,
    currentContext: changed,
    execute: async () => {
      executed += 1;
      return { ok: true };
    }
  });
  assert.equal(result.refused, true);
  assert.equal(result.stale, true);
  assert.equal(executed, 0);
  assert.deepEqual(result.changed, ['机型 烟包机 → 装盒机']);
  assert.match(result.summary, /工程已变化/);
  assert.match(result.summary, /请重跑前置步骤/);
});

test('没有上一轮状态时拒绝续跑', async () => {
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous: null,
    currentContext: context(),
    execute: async () => ({ ok: true })
  });
  assert.equal(result.refused, true);
  assert.match(result.summary, /没有可续跑/);
});

test('全部步骤已完成时续跑为空操作', async () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'get_bom', ok: true, wrote: false },
    { step: 2, index: 1, tool: 'run_cost_report', ok: true, wrote: false },
    { step: 3, index: 2, tool: 'export_cost_report', ok: true, wrote: true }
  ]);
  let executed = 0;
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous,
    currentContext: context(),
    execute: async () => {
      executed += 1;
      return { ok: true };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.resumedFrom, 3);
  assert.equal(executed, 0);
  assert.match(result.summary, /无需续跑/);
});

test('显式 resumeFrom 从指定步骤继续', async () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'get_bom', ok: true, wrote: false }
  ]);
  const executed = [];
  const result = await runPlan(plan(['get_bom', 'run_cost_report']), {
    resumeFrom: 1,
    previous,
    currentContext: context(),
    execute: async (_step, index) => {
      executed.push(index);
      return { ok: true };
    }
  });
  assert.equal(result.resumedFrom, 1);
  assert.deepEqual(executed, [1]);
});

test('对话状态不能当作计划续跑依据', async () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'update_component', ok: true, wrote: true }
  ], { source: 'chat' });
  let executed = 0;
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous,
    currentContext: context(),
    execute: async () => {
      executed += 1;
      return { ok: true };
    }
  });
  assert.equal(result.refused, true);
  assert.match(result.summary, /不是可续跑的计划/);
  assert.equal(executed, 0);
});

test('计划步骤变化时拒绝沿用完成记录', async () => {
  const previous = state(projectFingerprint(context()), [
    { step: 1, index: 0, tool: 'get_bom', ok: true, wrote: false }
  ], { source: 'plan', planSignature: 'get_bom:{}|old_step:{}' });
  let executed = 0;
  const result = await runPlan(plan(), {
    resumeFrom: 0,
    previous,
    currentContext: context(),
    execute: async () => {
      executed += 1;
      return { ok: true };
    }
  });
  assert.equal(result.refused, true);
  assert.match(result.summary, /计划步骤已变化/);
  assert.equal(executed, 0);
});

test('确认超时会在计划状态中留下 pendingConfirm', async () => {
  const thread = new AgentThread();
  const fingerprint = projectFingerprint(context());
  thread.write(state(fingerprint));
  let executed = 0;
  const result = await runPlan({
    steps: [{ tool: 'update_component', args: { ref: 'QF1' }, why: '', readOnly: false }],
    confidence: 1
  }, {
    previous: thread.read(),
    currentContext: context(),
    thread,
    confirmPlan: async () => {
      throw new Error('确认超时');
    },
    execute: async () => {
      executed += 1;
      return { ok: true };
    }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.confirmOutcome, 'timeout');
  assert.equal(executed, 0);
  assert.equal(thread.read()?.pendingConfirm?.tool, 'update_component');
  assert.equal(thread.read()?.pendingConfirm?.reason, 'timeout');
});

test('用户明确拒绝计划时不留下 pendingConfirm', async () => {
  const thread = new AgentThread();
  thread.write(state(projectFingerprint(context())));
  const result = await runPlan({
    steps: [{ tool: 'update_component', args: { ref: 'QF1' }, why: '', readOnly: false }],
    confidence: 1
  }, {
    previous: thread.read(),
    currentContext: context(),
    thread,
    confirmPlan: async () => false,
    execute: async () => ({ ok: true })
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.confirmOutcome, 'denied');
  assert.equal(thread.read()?.pendingConfirm, undefined);
});

test('跨轮「刚才那个件」可解析上一轮目标', () => {
  const thread = new AgentThread();
  const finished = thread.finish({
    intent: 'modify',
    context: context(),
    completedSteps: [{ step: 1, index: 0, tool: 'update_component', args: { ref: 'QF1' }, ok: true, wrote: true }],
    reply: '已修改 QF1'
  });
  const noSelection = context({ selection: null, recentActions: [] });
  assert.equal(resolveReference('把刚才那个件数量改成 2', noSelection).target, null);
  const resolution = resolveThreadReference('把刚才那个件数量改成 2', noSelection, finished);
  assert.equal(resolution.target?.id, 'p1');
  assert.equal(resolution.target?.label, 'QF1');
});

test('没有线程目标时不改写上下文', () => {
  const original = context({ selection: null });
  const changed = augmentContextWithThreadReference('把刚才那个件改一下', original, null);
  assert.equal(changed, original);
});

test('多轮改型号→撤销→改数量全流程保留上下文', async () => {
  const contextProvider = () => context({ selection: null, recentActions: [] });
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('c1', 'update_component', { ref: 'QF1', model: 'NXB-63' })] },
    { content: '已把 QF1 改成 NXB-63。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('c2', 'undo_last', {})] },
    { content: '已撤销上一次型号修改。', toolCalls: [] },
    { content: '', toolCalls: [toolCall('c3', 'update_component', { ref: 'QF1', qty: 2 })] },
    { content: '已把 QF1 数量改成 2。', toolCalls: [] }
  ]);
  const bus = createBus();
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    contextProvider
  });

  await session.run('把 QF1 的型号改成 NXB-63');
  const firstState = session.threadState();
  assert.equal(firstState?.targets.includes('QF1'), true);
  assert.equal(firstState?.completedSteps[0]?.tool, 'update_component');

  await session.run('撤销刚才的修改');
  const secondState = session.threadState();
  assert.equal(secondState?.turnId, 2);
  assert.equal(secondState?.completedSteps[0]?.tool, 'undo_last');
  const secondPrompt = llm.calls[2][0].content;
  assert.match(secondPrompt, /上一轮会话/);
  assert.match(secondPrompt, /update_component/);
  assert.match(secondPrompt, /QF1/);

  const reply = await session.run('接着把刚才那个件数量改成 2');
  assert.equal(reply, '已把 QF1 数量改成 2。');
  assert.deepEqual(bus.calls.map((call) => call.name), ['update_component', 'undo_last', 'update_component']);
  assert.deepEqual(bus.calls[2].args, { ref: 'QF1', qty: 2 });
  const thirdPrompt = llm.calls[4][0].content;
  assert.match(thirdPrompt, /undo_last/);
  assert.match(thirdPrompt, /QF1/);
  assert.match(thirdPrompt, /工程指纹：与上一轮一致/);
  assert.equal(session.threadState()?.lastReplySummary, '已把 QF1 数量改成 2。');
});

test('确认超时后下一轮注入未确认操作并在结束后清除', async () => {
  const contextProvider = () => context();
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('c1', 'update_component', { ref: 'QF1', qty: 2 })] },
    { content: '确认超时，未执行修改。', toolCalls: [] },
    { content: '请先确认是否继续上次未确认的修改。', toolCalls: [] }
  ]);
  const bus = createBus();
  let confirms = 0;
  const session = new AgentSession({
    llm,
    bus,
    contextProvider,
    confirmWrite: async () => {
      confirms += 1;
      throw new Error('确认超时');
    }
  });
  await session.run('把 QF1 数量改成 2');
  assert.equal(confirms, 1);
  assert.equal(session.threadState()?.pendingConfirm?.reason, 'timeout');
  assert.equal(bus.calls.length, 0);
  assert.match(session.history().at(-1)?.content ?? '', /确认超时/);

  await session.run('继续上次未确认的操作');
  const prompt = llm.calls[2][0].content;
  assert.match(prompt, /未确认操作/);
  assert.match(prompt, /是否继续上次未确认的操作/);
  assert.equal(session.threadState()?.pendingConfirm, undefined);
});

test('用户拒绝写操作后下一轮不自动重试', async () => {
  const contextProvider = () => context();
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('c1', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '已取消插入。', toolCalls: [] },
    { content: '上次操作已被拒绝，需要你明确要求才会重试。', toolCalls: [] }
  ]);
  const bus = createBus();
  let confirms = 0;
  const session = new AgentSession({
    llm,
    bus,
    contextProvider,
    confirmWrite: async () => {
      confirms += 1;
      return false;
    }
  });
  await session.run('插入一个气缸');
  assert.equal(session.threadState()?.pendingConfirm, undefined);
  assert.equal(session.threadState()?.completedSteps[0]?.code, 'USER_DENIED');

  await session.run('继续');
  assert.equal(confirms, 1);
  assert.equal(bus.calls.length, 0);
  const prompt = llm.calls[2][0].content;
  assert.match(prompt, /用户已拒绝：insert_component/);
  assert.match(prompt, /不要自动重试/);
});

test('会话 clear 同时清空线程状态', async () => {
  const llm = createLlm([{ content: '收到', toolCalls: [] }]);
  const session = new AgentSession({ llm, bus: createBus(), confirmWrite: async () => true, contextProvider: () => context() });
  await session.run('你好');
  assert.equal(session.threadState()?.turnId, 1);
  session.clear();
  assert.equal(session.threadState(), null);
});

test('跨轮拒绝：同工具同目标去重，后者覆盖并忽略目标大小写', () => {
  const normalized = normalizeDenials([
    { tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:01Z', reason: 'user', turnId: '1' },
    { tool: 'update_component', target: 'qf1', at: '2026-10-23T00:00:02Z', reason: 'timeout', turnId: '2' }
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].reason, 'timeout');
  assert.equal(normalized[0].turnId, '2');
  assert.equal(normalized[0].target, 'qf1');
});

test('跨轮拒绝：只保留最近 10 条', () => {
  const denials = Array.from({ length: 13 }, (_unused, index) => ({
    tool: 'update_component',
    target: `QF${index + 1}`,
    at: `2026-10-23T00:00:${String(index).padStart(2, '0')}Z`,
    reason: 'user',
    turnId: String(index + 1)
  }));
  const normalized = normalizeDenials(denials);
  assert.equal(normalized.length, 10);
  assert.equal(normalized[0].target, 'QF4');
  assert.equal(normalized.at(-1).target, 'QF13');
});

test('跨轮拒绝：partId / 型号命中放置件时归一成位号', () => {
  const placements = context().placements.map((item, index) => index === 0
    ? { ...item, model: 'iC65N-C16-1P' }
    : item);
  assert.equal(denialTarget({ partId: 'iC65N-C16-1P' }, context({ placements })), 'QF1');
  assert.equal(denialTarget({ ref: 'qf1' }, context({ placements })), 'QF1');
  assert.equal(denialTarget({ ref: 'KM1' }, context({ placements })), 'KM1');
});

test('跨轮拒绝：find / remove 按工具与目标精确命中', () => {
  const denials = [{
    tool: 'update_component',
    target: 'QF1',
    at: '2026-10-23T00:00:00Z',
    reason: 'user',
    turnId: '2'
  }];
  assert.equal(findDenial(denials, 'update_component', 'qf1')?.turnId, '2');
  assert.equal(findDenial(denials, 'update_component', 'KM1'), null);
  assert.equal(findDenial(denials, 'remove_component', 'QF1'), null);
  assert.deepEqual(removeDenial(denials, 'update_component', 'QF1'), []);
  assert.equal(removeDenial(denials, 'update_component', 'KM1').length, 1);
});

test('跨轮拒绝：finish 未传 denials 时保留，显式快照可清空', () => {
  const thread = new AgentThread();
  const denial = { tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:00Z', reason: 'user', turnId: '1' };
  thread.finish({ reply: '第一次拒绝', context: context(), completedSteps: [], denials: [denial] });
  assert.deepEqual(thread.read()?.denials.map((item) => item.target), ['QF1']);
  thread.finish({ reply: '第二次保留', context: context(), completedSteps: [] });
  assert.deepEqual(thread.read()?.denials.map((item) => item.target), ['QF1']);
  thread.finish({ reply: '明确同意后清空', context: context(), completedSteps: [], denials: [] });
  assert.deepEqual(thread.read()?.denials, []);
});

test('跨轮拒绝：提示注入包含工具、目标、轮次与明确同意条件', () => {
  const prompt = formatDenialPrompt([
    { tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:00Z', reason: 'user', turnId: '2' },
    { tool: 'remove_component', target: 'KM1', at: '2026-10-23T00:00:01Z', reason: 'policy', turnId: '3' }
  ]).join('\n');
  assert.match(prompt, /本会话已被拒绝：update_component\(QF1\)（用户拒绝，第 2 轮）/);
  assert.match(prompt, /remove_component\(KM1\)（策略拦截，第 3 轮）/);
  assert.match(prompt, /除非用户明确说『我同意\/现在就改』，不得再次调用同一工具同一目标/);
});

test('跨轮拒绝：超时提示可重试但不进入永久拒绝文案', () => {
  const prompt = formatDenialPrompt([
    { tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:00Z', reason: 'timeout', turnId: '2' }
  ]).join('\n');
  assert.match(prompt, /本会话曾有确认超时：update_component\(QF1\)（确认超时，第 2 轮）/);
  assert.match(prompt, /超时不是永久拒绝/);
  assert.doesNotMatch(prompt, /本会话已被拒绝/);
});

test('跨轮拒绝：工程指纹变化后 denial 保留且提示工程已变化', () => {
  const previous = state(projectFingerprint(context()), [], {
    denials: [{ tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:00Z', reason: 'user', turnId: '1' }]
  });
  const changed = context({ machine: { name: '装盒机', stations: 3, actuators: 6, sensors: 8 }, bomRows: 9 });
  const prompt = formatThreadContext(previous, changed);
  assert.match(prompt, /本会话已被拒绝：update_component\(QF1\)/);
  assert.match(prompt, /工程已变化，不要沿用旧结论/);
});

test('跨轮拒绝：cloneThreadState 深拷贝 denials', () => {
  const thread = new AgentThread();
  thread.finish({
    reply: '拒绝',
    context: context(),
    completedSteps: [],
    denials: [{ tool: 'update_component', target: 'QF1', at: '2026-10-23T00:00:00Z', reason: 'user', turnId: '1' }]
  });
  const read = thread.read();
  read.denials[0].target = 'KM1';
  assert.equal(thread.read()?.denials[0]?.target, 'QF1');
});
