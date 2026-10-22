import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DemoFactoryAdapter } from '../../src/factory/demo.ts';

let adapter;

afterEach(async () => {
  await adapter?.disconnect();
  adapter = null;
});

test('demo 适配器可连接、浏览并读取 2 个工位 × 4 个点位', async () => {
  adapter = new DemoFactoryAdapter();
  assert.equal(adapter.status(), 'disconnected');
  await adapter.connect({ kind: 'demo' });
  assert.equal(adapter.status(), 'connected');
  const stations = await adapter.browse();
  assert.equal(stations.length, 2);
  for (const station of stations) {
    assert.equal(station.children.length, 4);
    const values = await adapter.readTags(station.children.map((tag) => tag.id));
    assert.equal(Object.keys(values).length, 4);
    for (const tag of station.children) assert.equal(values[tag.id].quality, 'good');
  }
  const press = await adapter.browse('press-station');
  assert.equal(press.length, 4);
  assert.equal((await adapter.readTags(['press.run']))['press.run'].value, true);
});

test('demo 适配器写入只允许可写点位', async () => {
  adapter = new DemoFactoryAdapter();
  await adapter.connect({ kind: 'demo' });
  await adapter.writeTag('press.run', false);
  assert.equal((await adapter.readTags(['press.run']))['press.run'].value, false);
  await assert.rejects(() => adapter.writeTag('press.good', 1), /不可写/);
  await assert.rejects(() => adapter.writeTag('nope', true), /点位不存在/);
  await assert.rejects(() => adapter.writeTag('press.run', 1), /布尔值/);
});

test('demo 适配器每秒推送订阅回调', async () => {
  adapter = new DemoFactoryAdapter();
  await adapter.connect({ kind: 'demo' });
  const seen = [];
  const unsubscribe = adapter.subscribe(['press.run', 'press.good'], (value) => seen.push(value));
  assert.equal(seen.length, 2, '订阅后应立即推送当前值');
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.ok(seen.length >= 4, `1 秒后应收到变化，实际 ${seen.length}`);
  assert.ok(seen.some((value) => value.id === 'press.good'));
  unsubscribe();
  const count = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(seen.length, count, '取消订阅后不应继续回调');
});
