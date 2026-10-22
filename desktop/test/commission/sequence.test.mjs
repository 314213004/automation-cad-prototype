import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSequence } from '../../src/commission/sequence.ts';

function fakeIo(initial = {}, options = {}) {
  const values = { ...initial };
  const writes = [];
  let time = 0;
  return {
    io: {
      async read(id) {
        if (options.readError) throw new Error(options.readError);
        return values[id];
      },
      async write(id, value) { writes.push([id, value]); values[id] = value; },
      async readAll() { return { ...values }; },
      now: () => time,
      sleep: async (ms) => { time += ms; },
      pollMs: 10
    },
    values,
    writes
  };
}

test('runSequence 依次执行 set 与 wait/expect 并记录耗时', async () => {
  const { io, values, writes } = fakeIo({ X0: false });
  const result = await runSequence([
    { id: 's1', name: '写入', action: 'set', point: 'X0', value: true },
    { id: 's2', name: '确认', action: 'wait', point: 'X0', expect: true }
  ], io);
  assert.equal(result.pass, true);
  assert.deepEqual(writes, [['X0', true]]);
  assert.equal(values.X0, true);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].expected, 'X0 = true');
  assert.equal(result.results[0].actual, 'X0 = true');
  assert.equal(result.failure, undefined);
});

test('runSequence 超时失败即停，并给出阶段/点位/期望/实际', async () => {
  const { io } = fakeIo({ Y0: false });
  const result = await runSequence([
    { id: 's1', name: '等待气缸', action: 'expect', point: 'Y0', expect: true, timeoutMs: 100 },
    { id: 's2', name: '不应执行', action: 'set', point: 'Y0', value: true }
  ], io);
  assert.equal(result.pass, false);
  assert.equal(result.results.length, 1);
  assert.equal(result.failure.stepId, 's1');
  assert.match(result.failure.message, /阶段「等待气缸」超时/);
  assert.match(result.failure.message, /点位 Y0/);
  assert.match(result.failure.message, /期望 true/);
  assert.equal(result.failure.actual, 'Y0 = false');
});

test('runSequence 前置条件失败时不执行写操作', async () => {
  const { io, writes } = fakeIo({ X0: false });
  const result = await runSequence([
    {
      id: 's1',
      name: '主回路',
      precondition: (values) => values.X0 === true ? null : '主回路未闭合',
      action: 'set',
      point: 'Y0',
      value: true
    }
  ], io);
  assert.equal(result.pass, false);
  assert.equal(writes.length, 0);
  assert.match(result.failure.message, /前置条件不满足：主回路未闭合/);
});

test('runSequence 读取异常不吞掉，失败信息包含底层错误', async () => {
  const { io } = fakeIo({}, { readError: 'PLC 通信断开' });
  const result = await runSequence([
    { id: 's1', name: '读取压力', action: 'wait', point: 'X3', expect: true, timeoutMs: 40 }
  ], io);
  assert.equal(result.pass, false);
  assert.match(result.failure.message, /读取失败：PLC 通信断开/);
});

test('runSequence 每步结束回调一次并携带步骤定义', async () => {
  const { io, values } = fakeIo({ X0: false });
  const seen = [];
  io.onStep = (result, step) => {
    seen.push({ stepId: step.id, resultId: result.stepId, pass: result.pass, actual: result.actual });
  };
  const result = await runSequence([
    { id: 's1', name: '写入', action: 'set', point: 'X0', value: true },
    { id: 's2', name: '确认', action: 'wait', point: 'X0', expect: true }
  ], io);
  assert.equal(result.pass, true);
  assert.deepEqual(seen, [
    { stepId: 's1', resultId: 's1', pass: true, actual: 'X0 = true' },
    { stepId: 's2', resultId: 's2', pass: true, actual: 'X0 = true' }
  ]);
  assert.equal(values.X0, true);
});
