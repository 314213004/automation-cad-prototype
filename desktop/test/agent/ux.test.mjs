import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateDurationText,
  cancellationText,
  formatDuration,
  runningDurationText,
  stepLabel,
  stepResultText,
  summarizeArguments
} from '../../src/agent/feedback.ts';
import { suggestFailure } from '../../src/agent/suggest.ts';
import {
  auditArgsText,
  auditCsv,
  auditEntryJson,
  auditExportFileName,
  filterAuditEntries,
  limitAuditEntries,
  sortAuditEntries
} from '../../src/agent/audit-view.ts';
import { formatAuditLine } from '../../src/agent/audit.ts';
import { AgentCancelledError, AgentSession } from '../../src/agent/session.ts';
import { executePlan } from '../../src/agent/planner.ts';

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function sessionWith(llm, bus, options = {}) {
  return new AgentSession({
    llm,
    bus,
    confirmWrite: options.confirmWrite ?? (async () => true),
    maxIterations: 6,
    ...options.session
  });
}

function auditEntry(overrides = {}) {
  return {
    at: '2026-10-23T02:00:00.000Z',
    tool: 'search_components',
    ok: true,
    ...overrides
  };
}

test('失败建议 PART_NOT_FOUND：先搜索并复用型号关键词', () => {
  const result = suggestFailure({
    code: 'PART_NOT_FOUND',
    message: '型号不存在：MXQ99',
    tool: 'update_component',
    args: { model: 'MXQ99' }
  });
  assert.match(result.advice, /search_components/);
  assert.match(result.advice, /MXQ99/);
  assert.ok(result.alternatives.some((item) => item.includes('search_components q=MXQ99')));
});

test('失败建议 NO_DIMENSIONS：换有尺寸型号或补录元件库', () => {
  const result = suggestFailure({
    code: 'NO_DIMENSIONS',
    message: '元件缺少尺寸',
    tool: 'place_component',
    args: { partId: 'X-1' }
  });
  assert.match(result.advice, /外形尺寸/);
  assert.ok(result.alternatives.some((item) => /补录|dims/.test(item)));
  assert.ok(result.alternatives.some((item) => /同系列|有尺寸/.test(item)));
});

test('失败建议 UNAVAILABLE / DESKTOP_NOT_RUNNING：分别指向服务与桌面启动', () => {
  const unavailable = suggestFailure({ code: 'UNAVAILABLE', message: '参数化建模内核不可用' });
  assert.match(unavailable.advice, /服务不可用/);
  assert.ok(unavailable.alternatives.some((item) => /sidecar|Python/.test(item)));

  const desktop = suggestFailure({ code: 'DESKTOP_NOT_RUNNING' });
  assert.match(desktop.advice, /启动 AutomationCAD/);
  assert.ok(desktop.alternatives.some((item) => /7420/.test(item)));
});

test('失败建议 PRECHECK_FAILED：指出第一条错误与修复位置', () => {
  const result = suggestFailure({
    code: 'PRECHECK_FAILED',
    message: '预检失败：第 1 条：点位 Y0 重复绑定\n第 2 条：执行机构行程为 0',
    tool: 'run_plc_generate'
  });
  assert.match(result.advice, /第一条错误：第 1 条：点位 Y0 重复绑定/);
  assert.match(result.advice, /修复位置：机型配置的 IO 点位/);
  assert.ok(result.alternatives.some((item) => item.includes('verify_plc_program')));
});

test('失败建议 USER_DENIED：明确未执行并说明如何重新发起', () => {
  const result = suggestFailure({ code: 'USER_DENIED', tool: 'insert_component' });
  assert.match(result.advice, /未执行/);
  assert.match(result.advice, /都没有改动/);
  assert.ok(result.alternatives.some((item) => item.includes('允许')));
});

test('失败建议未知码：通用回落且不编造原因', () => {
  const result = suggestFailure({ code: 'WEIRD_CODE', message: '内部异常', tool: 'get_bom' });
  assert.match(result.advice, /WEIRD_CODE/);
  assert.match(result.advice, /无法判断具体原因/);
  assert.doesNotMatch(result.advice, /型号不存在|尺寸|用户拒绝/);
  assert.ok(result.alternatives.length >= 2);
});

test('耗时格式化：毫秒、秒、分钟与非法值', () => {
  assert.equal(formatDuration(0), '0ms');
  assert.equal(formatDuration(420), '420ms');
  assert.equal(formatDuration(1234), '1.2s');
  assert.equal(formatDuration(61_000), '1m 01s');
  assert.equal(formatDuration(Number.NaN), '—');
  assert.equal(formatDuration(-1), '—');
});

test('参数摘要：敏感字段与裸密钥都脱敏并截断', () => {
  const text = summarizeArguments({ apiKey: 'sk-live-abcdef123456', token: 'tp-123456', q: 'SMC', nested: { password: 'p@ss' } });
  assert.doesNotMatch(text, /abcdef123456|tp-123456|p@ss/);
  assert.match(text, /\*\*\*\*/);
  assert.match(text, /SMC/);
  const long = summarizeArguments({ q: 'x'.repeat(300) }, 40);
  assert.ok(long.length <= 41);
  assert.equal(summarizeArguments({}), '无参数');
});

test('步骤文案：n/N、10 秒提示、完成卡片与 3 步汇总', () => {
  assert.equal(stepLabel(2, 5, 'place_component'), '正在执行 `place_component` · 第 2/5 步');
  assert.match(runningDurationText(Date.now() - 10_500), /仍在执行，可取消/);
  assert.doesNotMatch(runningDurationText(Date.now() - 500), /可取消/);
  assert.match(stepResultText({ tool: 'get_bom', ok: true, elapsedMs: 1200, code: 'OK' }), /✓ get_bom · 成功 · 耗时 1.2s · 结果码 OK/);
  assert.equal(aggregateDurationText([100, 200]), '');
  assert.equal(aggregateDurationText([100, 200, 300]), '连续 3 步汇总耗时 600ms');
});

test('取消文案：无写入时明确说未写入任何更改', () => {
  const text = cancellationText({ completed: [] });
  assert.equal(text, '已取消，未写入任何更改');
  const readOnly = cancellationText({ completed: [{ step: 1, tool: 'get_bom', ok: true, wrote: false }] });
  assert.match(readOnly, /^已取消，未写入任何更改/);
});

test('取消文案：已写入时列出完成步骤；写操作中断但结果未知时不谎称安全', () => {
  const text = cancellationText({
    completed: [
      { step: 1, tool: 'place_component', ok: true, code: 'OK', wrote: true },
      { step: 2, tool: 'run_electrical_check', ok: true, code: 'OK', wrote: false }
    ]
  });
  assert.match(text, /已完成的步骤：第 1 步 place_component/);
  assert.match(text, /undo_last/);
  const unknown = cancellationText({ completed: [], currentTool: 'export_files', currentToolMayWrite: true });
  assert.match(unknown, /是否写入未能确认/);
  assert.doesNotMatch(unknown, /未写入任何更改/);
});

test('审计排序与筛选：时间倒序、按工具/结果过滤', () => {
  const entries = [
    auditEntry({ at: '2026-10-23T01:00:00.000Z', tool: 'a' }),
    auditEntry({ at: '2026-10-23T03:00:00.000Z', tool: 'b' }),
    auditEntry({ at: '2026-10-23T02:00:00.000Z', tool: 'a', ok: false, code: 'X' })
  ];
  assert.deepEqual(sortAuditEntries(entries).map((entry) => entry.tool), ['b', 'a', 'a']);
  assert.deepEqual(filterAuditEntries(entries, { tool: 'a' }).map((entry) => entry.code ?? 'OK'), ['X', 'OK']);
  assert.deepEqual(filterAuditEntries(entries, { result: 'fail' }).map((entry) => entry.tool), ['a']);
  assert.equal(filterAuditEntries(entries, { tool: 'missing' }).length, 0);
});

test('审计上限：超过 200 条丢弃更早记录并回报数量', () => {
  const entries = Array.from({ length: 205 }, (_unused, index) => auditEntry({
    at: new Date(Date.UTC(2026, 9, 23, 0, 0, index)).toISOString(),
    tool: `tool-${index}`
  }));
  const limited = limitAuditEntries(entries, 200);
  assert.equal(limited.entries.length, 200);
  assert.equal(limited.total, 205);
  assert.equal(limited.dropped, 5);
  assert.equal(limited.entries[0].tool, 'tool-204');
});

test('审计 CSV：复用参数摘要、转义引号并带 UTF-8 BOM', () => {
  const csv = auditCsv([
    auditEntry({
      tool: 'search_components',
      args: { q: 'a,"b"', apiKey: 'sk-live-abcdef123456' },
      elapsedMs: 1234,
      message: '查询成功 a,"b"'
    })
  ]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv, /"时间","工具","参数摘要","结果码","结果","耗时","来源","消息"/);
  assert.match(csv, /"1\.2s"/);
  assert.match(csv, /"查询成功 a,""b"""/);
  assert.doesNotMatch(csv, /abcdef123456/);
});

test('审计文件名：净化后仅保留 CSV 基名', () => {
  const name = auditExportFileName('2026-10-23T06:30:00Z');
  assert.match(name, /^agent-audit-\d{8}-\d{4}\.csv$/);
  assert.ok(!name.includes('/') && !name.includes('..'));
});

test('单条完整 JSON：嵌套参数与消息里的密钥都掩码', () => {
  const json = auditEntryJson(auditEntry({
    tool: 'export_files',
    args: { token: 'tp-123456789', nested: { authorization: 'Bearer abcdef' } },
    message: '使用 sk-live-abcdef123456 调用失败'
  }));
  assert.doesNotMatch(json, /tp-123456789|abcdef123456|Bearer abcdef/);
  assert.match(json, /"\*\*\*\*"/);
  assert.match(json, /"tool": "export_files"/);
  assert.equal(auditArgsText(auditEntry({ args: { apiKey: 'sk-live-x', q: 'SMC' } })).includes('sk-live-x'), false);
});

test('会话进度：3 次工具调用各发 start/end，参数脱敏且审计 3 条', async () => {
  const responses = [
    {
      content: '',
      toolCalls: [
        toolCall('c1', 'search_components', { q: 'SMC', apiKey: 'sk-live-abcdef' }),
        toolCall('c2', 'get_bom', {}),
        toolCall('c3', 'run_electrical_check', {})
      ]
    },
    { content: '三步完成', toolCalls: [] }
  ];
  let index = 0;
  const llm = { async chat() { return responses[Math.min(index++, responses.length - 1)]; } };
  const bus = {
    async execute(name) { return { ok: true, data: { name } }; },
    async undoLast() { return { ok: true, data: {} }; }
  };
  const progress = [];
  const audits = [];
  const session = sessionWith(llm, bus, { session: { audit: (record) => audits.push(record) } });
  const reply = await session.run('三步', { runId: 'run-3', onProgress: (event) => progress.push(event) });
  assert.equal(reply, '三步完成');
  const starts = progress.filter((event) => event.phase === 'start');
  const ends = progress.filter((event) => event.phase === 'end');
  assert.equal(starts.length, 3);
  assert.equal(ends.length, 3);
  assert.deepEqual(starts.map((event) => event.index), [1, 2, 3]);
  assert.ok(starts.every((event) => event.total === 3 && event.runId === 'run-3'));
  assert.doesNotMatch(starts[0].argsSummary, /abcdef/);
  assert.equal(audits.length, 3);
  assert.ok(audits.every((record) => typeof record.elapsedMs === 'number' && record.elapsedMs >= 0));
});

test('会话取消：中断挂起工具并抛 AgentCancelledError，未写入', async () => {
  const llm = { async chat() { return { content: '', toolCalls: [toolCall('c1', 'get_bom', {})] }; } };
  const bus = {
    async execute() { return await new Promise(() => {}); },
    async undoLast() { return { ok: true, data: {} }; }
  };
  const controller = new AbortController();
  const session = sessionWith(llm, bus);
  const running = session.run('读 BOM', { signal: controller.signal, runId: 'run-cancel' });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof AgentCancelledError);
    assert.match(error.message, /已取消，未写入任何更改/);
    assert.equal(error.completedSteps.length, 0);
    return true;
  });
});

test('会话取消：已在写步骤完成后取消时列出完成步骤与写入状态', async () => {
  const llm = {
    async chat() {
      return {
        content: '',
        toolCalls: [
          toolCall('c1', 'insert_component', { partId: 'MXQ20-50' }),
          toolCall('c2', 'get_bom', {})
        ]
      };
    }
  };
  const bus = {
    calls: [],
    async execute(name) {
      this.calls.push(name);
      return { ok: true, data: { name } };
    },
    async undoLast() { return { ok: true, data: {} }; }
  };
  const controller = new AbortController();
  const session = sessionWith(llm, bus);
  const running = session.run('插入后读 BOM', {
    signal: controller.signal,
    runId: 'run-written',
    onProgress: (event) => {
      if (event.phase === 'end' && event.index === 1) controller.abort();
    }
  });
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof AgentCancelledError);
    assert.match(error.message, /已完成的步骤：第 1 步 insert_component/);
    assert.equal(error.completedSteps[0].wrote, true);
    return true;
  });
  assert.deepEqual(bus.calls, ['insert_component']);
});

test('审计记录写入带耗时且旧字段兼容', () => {
  const line = formatAuditLine({ tool: 'get_bom', ok: true, elapsedMs: 123.7 }, new Date('2026-10-23T00:00:00Z'));
  const parsed = JSON.parse(line);
  assert.equal(parsed.elapsedMs, 124);
  const legacy = JSON.parse(formatAuditLine({ tool: 'get_bom', ok: true }));
  assert.equal(legacy.elapsedMs, undefined);
});

test('计划取消：保留已完成步骤、停止后续步骤并给出未写入文案', async () => {
  const controller = new AbortController();
  const progress = [];
  const plan = {
    confidence: 0.9,
    steps: [
      { tool: 'get_bom', args: {}, why: '读 BOM', readOnly: true },
      { tool: 'search_components', args: { q: 'SMC' }, why: '查件', readOnly: true },
      { tool: 'run_cost_report', args: {}, why: '算成本', readOnly: true }
    ]
  };
  const result = await executePlan(plan, {
    signal: controller.signal,
    onProgress: (event) => progress.push(event),
    execute: async (step) => {
      if (step.tool === 'search_components') {
        controller.abort();
        return await new Promise(() => {});
      }
      return { ok: true, data: { tool: step.tool } };
    }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 1);
  assert.match(result.summary, /已取消，未写入任何更改/);
  assert.equal(progress.filter((event) => event.phase === 'start').length, 2);
  const cancelledEnd = progress.find((event) => event.phase === 'end' && event.code === 'CANCELLED');
  assert.ok(cancelledEnd);
});
