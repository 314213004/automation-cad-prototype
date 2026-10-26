import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { WRITE_TOOLS, requiresWriteConfirmation } from '../../src/agent/router.ts';

const tools = new AgentTools({ listParts: () => [] });

test('build_canvas_assembly 已注册，且算写操作（需要确认）', () => {
  assert.equal(tools.has('build_canvas_assembly'), true);
  assert.equal(WRITE_TOOLS.has('build_canvas_assembly'), true);
  assert.equal(requiresWriteConfirmation('build_canvas_assembly'), true);
});

test('schema：name/open/graph 可选，不给 graph 时用当前草稿', () => {
  const schema = tools.summaries().find((tool) => tool.name === 'build_canvas_assembly')?.inputSchema;
  assert.ok(schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['graph', 'name', 'open']);
  assert.equal(schema.required, undefined, '全部可选：默认读画布草稿');
  assert.match(
    tools.summaries().find((tool) => tool.name === 'build_canvas_assembly').description,
    /示意装配/,
    '描述必须写明是示意体，避免被当真实几何'
  );
});

test('参数校验：空 name / 非布尔 open / graph 非对象都拒绝', async () => {
  for (const args of [{ name: '  ' }, { open: 'yes' }, { graph: [] }, { graph: 42 }]) {
    const result = await tools.call('build_canvas_assembly', args);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID_ARGUMENT');
  }
});

test('命令层：成功时把 payload 转给渲染桥，返回工程信息', async () => {
  const calls = [];
  const bus = createAgentCommandBus(
    { listParts: () => [] },
    {
      call: async (method, args) => {
        calls.push({ method, args });
        return { ok: true, projectId: 'p1', name: 'X（示意装配）', parts: 5, envelope: [6000, 2900, 1800], massKg: null };
      }
    }
  );
  const result = await bus.execute('build_canvas_assembly', { name: '缓存线', open: false });
  assert.equal(result.ok, true);
  assert.equal(result.data.parts, 5);
  assert.deepEqual(result.data.envelope, [6000, 2900, 1800]);
  assert.deepEqual(calls[0], { method: 'buildCanvasAssembly', args: [{ name: '缓存线', open: false }] });
});

test('命令层：未知参数被拒（防止 LLM 传 process 之类不存在的字段）', async () => {
  const bus = createAgentCommandBus({ listParts: () => [] }, { call: async () => ({ ok: true }) });
  const rejected = await bus.execute('build_canvas_assembly', { process: 'conveyor' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_ARGUMENT');
  assert.match(rejected.error.message, /未知参数/);
});

test('命令层：渲染桥报 EMPTY_CANVAS 时冒泡成失败（不假装成功）', async () => {
  const bus = createAgentCommandBus(
    { listParts: () => [] },
    { call: async () => ({ ok: false, code: 'EMPTY_CANVAS', message: '画布是空的：需要至少一个工位才能生成装配' }) }
  );
  const result = await bus.execute('build_canvas_assembly', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EMPTY_CANVAS');
  assert.match(result.error.message, /画布是空的/);
});
