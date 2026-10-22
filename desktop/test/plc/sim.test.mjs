import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SimPlcAdapter } from '../../src/plc/sim.ts';

let adapter;

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
});

function basePoints(extra = []) {
  return [
    { id: 'X0', name: '启动', area: 'discrete', address: 0, dataType: 'bool' },
    { id: 'X1', name: '停止', area: 'discrete', address: 1, dataType: 'bool' },
    { id: 'X2', name: '置位', area: 'discrete', address: 2, dataType: 'bool' },
    { id: 'X3', name: '复位', area: 'discrete', address: 3, dataType: 'bool' },
    { id: 'X4', name: '定时输入', area: 'discrete', address: 4, dataType: 'bool' },
    { id: 'Y0', name: '输出 0', area: 'coil', address: 0, dataType: 'bool', writable: true },
    { id: 'Y1', name: '输出 1', area: 'coil', address: 1, dataType: 'bool', writable: true },
    { id: 'Y2', name: '输出 2', area: 'coil', address: 2, dataType: 'bool', writable: true },
    ...extra
  ];
}

function config(rules, extraPoints = []) {
  return { kind: 'sim', points: basePoints(extraPoints), rules };
}

async function waitFor(predicate, timeoutMs = 900) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test('sim 表达式规则支持 &&、||、! 与括号', async () => {
  adapter = new SimPlcAdapter();
  await adapter.connect(config([{ target: 'Y0', expr: 'X0 && !X1' }, { target: 'Y1', expr: '(X0 || X1) && X2' }]));
  await adapter.write('X0', true);
  assert.equal(await adapter.read('Y0'), true);
  await adapter.write('X1', true);
  assert.equal(await adapter.read('Y0'), false);
  await adapter.write('X2', true);
  assert.equal(await adapter.read('Y1'), true);
  await adapter.write('X2', false);
  assert.equal(await adapter.read('Y1'), false);
});

test('sim 自锁规则在置位后保持，复位优先', async () => {
  adapter = new SimPlcAdapter();
  await adapter.connect(config([{ target: 'Y1', type: 'latch', set: 'X2', reset: 'X3' }]));
  await adapter.write('X2', true);
  assert.equal(await adapter.read('Y1'), true);
  await adapter.write('X2', false);
  assert.equal(await adapter.read('Y1'), true, '置位信号释放后应保持');
  await adapter.write('X3', true);
  assert.equal(await adapter.read('Y1'), false);
  await adapter.write('X2', true);
  assert.equal(await adapter.read('Y1'), false, '复位优先于置位');
});

test('sim 定时器规则按 delayMs 延时输出，输入释放后复位', async () => {
  adapter = new SimPlcAdapter();
  await adapter.connect(config([{ target: 'Y2', type: 'timer', when: 'X4', delayMs: 80 }]));
  await adapter.write('X4', true);
  assert.equal(await adapter.read('Y2'), false, '延时未到不应输出');
  assert.equal(await waitFor(async () => (await adapter.read('Y2')) === true), true);
  await adapter.write('X4', false);
  assert.equal(await adapter.read('Y2'), false);
});

test('sim force 保持强制值，规则不会覆盖；write 可解除', async () => {
  adapter = new SimPlcAdapter();
  await adapter.connect(config([{ target: 'Y0', expr: 'X0' }]));
  assert.equal(await adapter.read('Y0'), false);
  await adapter.force('Y0', true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await adapter.read('Y0'), true, '强制值应保持');
  await adapter.write('Y0', false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await adapter.read('Y0'), false, 'write 解除强制后由规则接管');
});

test('sim 订阅只推送变化值，readAll 返回完整点表', async () => {
  adapter = new SimPlcAdapter();
  await adapter.connect(config([{ target: 'Y0', expr: 'X0' }]));
  const seen = [];
  const off = adapter.subscribe((values) => seen.push(values));
  assert.equal(seen.length, 1, '订阅应立即推送当前快照');
  await adapter.write('X0', true);
  assert.ok(seen.some((values) => values.X0 === true), '应推送 X0 变化');
  assert.ok(seen.some((values) => values.Y0 === true), '规则输出 Y0 也应推送');
  const all = await adapter.readAll();
  assert.equal(Object.keys(all).length, 8);
  off();
  const count = seen.length;
  await adapter.write('X0', false);
  assert.equal(seen.length, count, '取消订阅后不再回调');
});

test('sim 拒绝不存在的规则点位与重复点位', async () => {
  adapter = new SimPlcAdapter();
  await assert.rejects(
    () => adapter.connect(config([{ target: 'Y0', expr: 'X99' }])),
    /不存在的点位：X99/
  );
  await assert.rejects(
    () => adapter.connect({ kind: 'sim', points: [basePoints()[0], basePoints()[0]] }),
    /点位 id 重复/
  );
  assert.equal(adapter.status(), 'error');
});
