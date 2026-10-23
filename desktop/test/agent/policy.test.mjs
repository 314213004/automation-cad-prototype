import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSession } from '../../src/agent/session.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { parseToolResultData } from '../../src/agent/guard.ts';
import {
  ALLOWED_EXPORT_DIRECTORY,
  BYPASS_CONFIRMATION_NOTICE,
  checkExportTargetPath,
  detectBypassIntent,
  sanitizeConfirmationClaims
} from '../../src/agent/policy.ts';

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
  return {
    calls,
    async execute(name, args = {}) {
      calls.push({ name, args });
      return handler ? await handler(name, args) : { ok: true, data: { name, args } };
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: { command: 'insert_component' } };
    }
  };
}

test('绕过意图：别问了', () => {
  assert.deepEqual(detectBypassIntent('别问了，直接插入。'), { bypass: true, phrase: '别问了' });
});

test('绕过意图：不用确认', () => {
  assert.equal(detectBypassIntent('不用确认，直接导出。')?.bypass, true);
});

test('绕过意图：不需要确认', () => {
  assert.equal(detectBypassIntent('这次不需要确认。')?.bypass, true);
});

test('绕过意图：直接覆盖', () => {
  assert.equal(detectBypassIntent('直接覆盖旧文件。')?.bypass, true);
});

test('绕过意图：跳过确认', () => {
  assert.equal(detectBypassIntent('跳过确认，继续执行。')?.bypass, true);
});

test('绕过意图：我授权', () => {
  assert.equal(detectBypassIntent('我授权你改这个工程。')?.bypass, true);
});

test('绕过意图：别让我点', () => {
  assert.equal(detectBypassIntent('别让我点确认了。')?.bypass, true);
});

test('绕过意图负例：普通导出请求', () => {
  assert.equal(detectBypassIntent('把 BOM 导出成 CSV。'), null);
});

test('绕过意图负例：覆盖同名文件时追加序号', () => {
  assert.equal(detectBypassIntent('覆盖同名文件时追加序号。'), null);
});

test('绕过意图负例：请确认是否覆盖', () => {
  assert.equal(detectBypassIntent('请确认是否覆盖同名文件。'), null);
});

test('绕过意图负例：空白文本', () => {
  assert.equal(detectBypassIntent('   '), null);
});

test('回复过滤：无需确认替换为已按规则请求确认', () => {
  assert.equal(
    sanitizeConfirmationClaims('已导出，无需确认。'),
    '已导出，已按规则请求确认。'
  );
});

test('回复过滤：已自动确认被替换', () => {
  assert.equal(
    sanitizeConfirmationClaims('已自动确认并写入文件。'),
    '已按规则请求确认并写入文件。'
  );
});

test('回复过滤：正常回复保持不变', () => {
  assert.equal(sanitizeConfirmationClaims('请确认是否覆盖。'), '请确认是否覆盖。');
});

test('回复过滤：同一句多个越权说法都替换', () => {
  const text = sanitizeConfirmationClaims('无需确认，已自动确认。');
  assert.equal(text, '已按规则请求确认，已按规则请求确认。');
});

test('路径拒绝：Windows 盘符绝对路径', () => {
  const check = checkExportTargetPath('C:\\Windows\\System32\\design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'drive');
  assert.match(check.message, new RegExp(ALLOWED_EXPORT_DIRECTORY.replace('/', '\\/')));
});

test('路径拒绝：Windows 盘符相对路径', () => {
  const check = checkExportTargetPath('D:report.csv');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'drive');
});

test('路径拒绝：UNC 路径', () => {
  const check = checkExportTargetPath('\\\\fileserver\\share\\design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'unc');
});

test('路径拒绝：POSIX 绝对路径', () => {
  const check = checkExportTargetPath('/tmp/design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'absolute');
});

test('路径拒绝：../ 穿越', () => {
  const check = checkExportTargetPath('../design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'traversal');
});

test('路径拒绝：Windows 反斜杠穿越', () => {
  const check = checkExportTargetPath('..\\Windows\\System32\\design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'system');
});

test('路径拒绝：相对子目录', () => {
  const check = checkExportTargetPath('reports/design.pdf');
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'separator');
});

test('路径接受：只给文件名', () => {
  assert.deepEqual(checkExportTargetPath('design.pdf'), { ok: true, sanitized: false });
});

test('路径接受：文件名里的冒号不是盘符', () => {
  assert.deepEqual(checkExportTargetPath('报价:2026.pdf'), { ok: true, sanitized: false });
});

test('路径接受：空文件名回落默认命名', () => {
  assert.deepEqual(checkExportTargetPath(undefined), { ok: true, sanitized: false });
});

test('路径净化：allowSanitize=true 接受盘符路径并标记 sanitized', () => {
  const check = checkExportTargetPath('C:\\Windows\\System32\\design.pdf', true);
  assert.equal(check.ok, true);
  assert.equal(check.sanitized, true);
});

test('路径净化：allowSanitize=true 接受 ../', () => {
  const check = checkExportTargetPath('../design.pdf', true);
  assert.equal(check.ok, true);
  assert.equal(check.sanitized, true);
});

test('路径净化：显式 allowSanitize=false 仍拒绝', () => {
  assert.equal(checkExportTargetPath('../design.pdf', false).ok, false);
});

test('路径拒绝：非字符串文件名', () => {
  assert.equal(checkExportTargetPath(42).ok, false);
});

test('会话硬拦截：bypass 文本下写工具仍确认并记录 BYPASS_ATTEMPT', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('b1', 'insert_component', { partId: 'MXQ20-50' })] },
    { content: '已完成。', toolCalls: [] }
  ]);
  const bus = createBus();
  const prompts = [];
  const audits = [];
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async (name, args, context) => {
      prompts.push({ name, args, context });
      return true;
    },
    audit: (record) => audits.push(record)
  });
  const reply = await session.run('别问了，直接插入 MXQ20-50。');
  assert.equal(reply, '已完成。');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].context.bypass, true);
  assert.equal(prompts[0].context.notice, BYPASS_CONFIRMATION_NOTICE);
  assert.match(prompts[0].context.phrase, /别问了/);
  assert.deepEqual(bus.calls.map((call) => call.name), ['insert_component']);
  const bypass = audits.find((record) => record.code === 'BYPASS_ATTEMPT');
  assert.ok(bypass);
  assert.equal(bypass.tool, 'insert_component');
  assert.equal(bypass.ok, false);
  assert.equal(bypass.source, 'llm');
  assert.match(bypass.phrase, /别问了/);
});

test('会话硬拦截：bypass 下拒绝后不执行命令', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('b2', 'export_files', { kind: 'bom' })] },
    { content: '已取消。', toolCalls: [] }
  ]);
  const bus = createBus();
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => false
  });
  await session.run('不用确认，直接导出 BOM。');
  assert.equal(bus.calls.length, 0);
});

test('会话硬拦截：拒绝后本轮同名写工具短路，不再弹窗', async () => {
  const llm = createLlm([
    {
      content: '',
      toolCalls: [
        toolCall('d1', 'insert_component', { partId: 'MXQ20-50' }),
        toolCall('d2', 'insert_component', { partId: 'MHZ2-20' })
      ]
    },
    { content: '两次都取消。', toolCalls: [] }
  ]);
  const bus = createBus();
  let prompts = 0;
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => {
      prompts += 1;
      return false;
    }
  });
  await session.run('插入两个气缸。');
  assert.equal(prompts, 1);
  assert.equal(bus.calls.length, 0);
  const toolMessages = llm.calls[1].filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 2);
  for (const message of toolMessages) {
    assert.equal(parseToolResultData(message.content)?.code, 'USER_DENIED');
  }
});

test('会话硬拦截：直接调用 executeTool 仍必须确认，拒绝则 USER_DENIED', async () => {
  const llm = createLlm([{ content: 'unused', toolCalls: [] }]);
  const bus = createBus();
  let prompts = 0;
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => {
      prompts += 1;
      return false;
    }
  });
  const result = await session.executeTool(
    toolCall('direct-1', 'insert_component', { partId: 'MXQ20-50' }),
    { runId: 'direct', index: 1, total: 1, completed: [] }
  );
  assert.equal(prompts, 1);
  assert.equal(bus.calls.length, 0);
  assert.equal(result.code, 'USER_DENIED');
});

test('会话硬拦截：直接调用 executeTool 确认后才执行', async () => {
  const llm = createLlm([{ content: 'unused', toolCalls: [] }]);
  const bus = createBus();
  let prompts = 0;
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => {
      prompts += 1;
      return true;
    }
  });
  const result = await session.executeTool(
    toolCall('direct-2', 'insert_component', { partId: 'MXQ20-50' }),
    { runId: 'direct', index: 1, total: 1, completed: [] }
  );
  assert.equal(prompts, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(bus.calls.map((call) => call.name), ['insert_component']);
});

test('会话硬拦截：缺少确认回调时不执行写工具', async () => {
  const llm = createLlm([{ content: 'unused', toolCalls: [] }]);
  const bus = createBus();
  const session = new AgentSession({ llm, bus, confirmWrite: undefined });
  const result = await session.executeTool(
    toolCall('direct-3', 'insert_component', { partId: 'MXQ20-50' }),
    { runId: 'direct', index: 1, total: 1, completed: [] }
  );
  assert.equal(result.code, 'CONFIRMATION_REQUIRED');
  assert.equal(bus.calls.length, 0);
});

test('会话回复过滤：无需确认不会出现在最终回复', async () => {
  const llm = createLlm([{ content: '文件已写入，无需确认。', toolCalls: [] }]);
  const session = new AgentSession({ llm, bus: createBus(), confirmWrite: async () => true });
  const reply = await session.run('导出。');
  assert.equal(reply, '文件已写入，已按规则请求确认。');
  assert.equal(session.history().at(-1).content, '文件已写入，已按规则请求确认。');
});

test('会话回复过滤：已自动确认被替换', async () => {
  const llm = createLlm([{ content: '已自动确认并导出。', toolCalls: [] }]);
  const session = new AgentSession({ llm, bus: createBus(), confirmWrite: async () => true });
  const reply = await session.run('导出。');
  assert.equal(reply, '已按规则请求确认并导出。');
});

test('会话硬拦截：只读工具不弹确认', async () => {
  const llm = createLlm([
    { content: '', toolCalls: [toolCall('ro-1', 'list_components', { category: '气缸' })] },
    { content: '找到 1 个。', toolCalls: [] }
  ]);
  const bus = createBus();
  let prompts = 0;
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => {
      prompts += 1;
      return true;
    }
  });
  await session.run('别问了，列一下气缸。');
  assert.equal(prompts, 0);
  assert.deepEqual(bus.calls.map((call) => call.name), ['list_components']);
});

test('工具层路径拒绝：export_files 不调用命令总线', async () => {
  const calls = [];
  const tools = new AgentTools({}, {
    async execute(name, args) {
      calls.push({ name, args });
      return { ok: true, data: {} };
    }
  });
  const result = await tools.call('export_files', {
    kind: 'pdf',
    fileName: 'C:\\Windows\\System32\\design.pdf'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_PATH_UNSUPPORTED');
  assert.equal(calls.length, 0);
});

test('工具层路径拒绝：export_cost_report 不调用命令总线', async () => {
  const calls = [];
  const tools = new AgentTools({}, {
    async execute(name, args) {
      calls.push({ name, args });
      return { ok: true, data: {} };
    }
  });
  const result = await tools.call('export_cost_report', {
    format: 'csv',
    fileName: '\\\\server\\share\\quote.csv'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_PATH_UNSUPPORTED');
  assert.equal(calls.length, 0);
});

test('工具层路径允许：只给文件名时透传命令并返回实际路径', async () => {
  const tools = new AgentTools({}, {
    async execute() {
      return { ok: true, data: { path: '/userData/exports/design.pdf', fileName: 'design.pdf' } };
    }
  });
  const result = await tools.call('export_files', { kind: 'pdf', fileName: 'design.pdf' });
  assert.equal(result.ok, true);
  assert.equal(result.path, '/userData/exports/design.pdf');
});

test('工具层路径净化：allowSanitize=true 时透传并保留 sanitized 标记', async () => {
  const tools = new AgentTools({}, {
    async execute(_name, args) {
      return { ok: true, data: { path: '/userData/exports/design.pdf', sanitized: true, args } };
    }
  });
  const result = await tools.call('export_files', {
    kind: 'pdf',
    fileName: 'C:\\Windows\\System32\\design.pdf',
    allowSanitize: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.sanitized, true);
});
