import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';
import { MODEL_BUILDERS, pickModelBuilder } from '../../src/machine/model-builders.ts';

const registry = { listParts: () => [] };

function setup() {
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method !== 'buildMachineModel') return { ok: false, message: `unexpected ${method}` };
      const payload = args?.[0] ?? {};
      if (payload.process === 'screw') {
        return { ok: false, code: 'NO_PARAMETRIC_BUILDER', message: '「screw」暂无参数化整机生成器' };
      }
      return {
        ok: true,
        engine: 'parametric',
        process: payload.process,
        parts: 29,
        loadedParts: 29,
        massKg: 85.41,
        files: { step: 917272, stl: 747284, partCount: 29 }
      };
    }
  };
  const bus = createAgentCommandBus(registry, bridge);
  return { bus, calls, tools: new AgentTools(registry, bus) };
}

test('build_machine_model 已注册、schema 拒绝未知键、且归入写工具', () => {
  const { tools } = setup();
  const tool = tools.summaries().find((item) => item.name === 'build_machine_model');
  assert.ok(tool, '工具未注册');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(tool.inputSchema, 'required'), true);
  assert.deepEqual(tool.inputSchema.required, []);
  for (const key of ['process', 'params', 'name', 'load']) {
    assert.ok(Object.hasOwn(tool.inputSchema.properties, key), `缺少参数 ${key}`);
  }
  assert.equal(WRITE_TOOLS.has('build_machine_model'), true, '会替换视口内容，必须走确认');
  assert.equal(READ_ONLY_TOOLS.has('build_machine_model'), false);
});

test('build_machine_model 默认走输送机，并把参数透传到渲染层', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { params: { lengthMm: 2400 } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'buildMachineModel');
  assert.equal(calls[0].args[0].process, 'conveyor');
  assert.deepEqual(calls[0].args[0].params, { lengthMm: 2400 });
  assert.equal(result.data.parts, 29);
});

test('build_machine_model 校验：params 必须是对象、name 非空、load 布尔、无未知键', async () => {
  const { bus, calls } = setup();
  const cases = [
    [{ params: [1, 2] }, /params 必须是对象/],
    [{ name: '   ' }, /name/],
    [{ load: 'yes' }, /load/],
    [{ 乱写: 1 }, /未知参数/]
  ];
  for (const [args, pattern] of cases) {
    const result = await bus.execute('build_machine_model', args);
    assert.equal(result.ok, false, `${JSON.stringify(args)} 应当被拒绝`);
    assert.match(result.error?.message ?? '', pattern);
  }
  assert.equal(calls.length, 0, '校验失败不能打到渲染层');
});

test('build_machine_model 不支持的机型把注册表边界讲清楚，不伪造模型', async () => {
  const { bus } = setup();
  const result = await bus.execute('build_machine_model', { process: 'screw' });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'NO_PARAMETRIC_BUILDER');
  assert.match(result.error?.message ?? '', /暂无参数化整机生成器/);
});

test('注册表里目前只有输送机，其它工艺必须显式失败而不是回落', () => {
  assert.deepEqual(Object.keys(MODEL_BUILDERS), ['conveyor']);
  for (const process of ['screw', 'dispense', 'assembly', 'inspection', 'packaging']) {
    assert.equal(pickModelBuilder(process), null);
  }
});
