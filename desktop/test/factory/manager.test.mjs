import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { FactoryManager } from '../../src/factory/manager.ts';

class FakeAdapter {
  constructor(kind) {
    this.kind = kind;
    this.state = 'disconnected';
    this.connected = 0;
    this.disconnected = 0;
  }
  async connect() { this.state = 'connected'; this.connected += 1; }
  async disconnect() { this.state = 'disconnected'; this.disconnected += 1; }
  async browse() { return [{ id: 's1', name: '工位', children: [] }]; }
  async readTags(ids) { return Object.fromEntries(ids.map((id) => [id, { id, value: 1, quality: 'good', timestamp: new Date().toISOString() }])); }
  async writeTag() {}
  subscribe(_ids, callback) { callback({ id: 's1.t', value: 1, quality: 'good', timestamp: new Date().toISOString() }); return () => {}; }
  status() { return this.state; }
}

let sandbox;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = null;
});

function makeManager() {
  sandbox = mkdtempSync(join(tmpdir(), 'factory-manager-test-'));
  const created = [];
  const manager = new FactoryManager({
    configFile: join(sandbox, 'factory.json'),
    timeoutMs: 2000,
    createAdapter: (kind) => {
      const adapter = new FakeAdapter(kind);
      created.push(adapter);
      return adapter;
    }
  });
  return { manager, created, configFile: join(sandbox, 'factory.json') };
}

test('manager 按 kind 切换适配器并广播状态', async () => {
  const { manager, created } = makeManager();
  const statuses = [];
  manager.on('status', (status) => statuses.push(status.status + ':' + String(status.kind)));

  const first = await manager.connect({ kind: 'demo' });
  assert.equal(first.ok, true);
  assert.equal(manager.getStatus().status, 'connected');
  const second = await manager.connect({ kind: 'opcua', endpointUrl: 'opc.tcp://127.0.0.1:4840' });
  assert.equal(second.ok, true);
  assert.equal(manager.getStatus().kind, 'opcua');
  assert.equal(manager.getStatus().status, 'connected');
  const demo = created.find((adapter) => adapter.kind === 'demo');
  assert.equal(demo.disconnected, 1, '切换时应断开旧适配器');
  assert.ok(statuses.includes('connected:demo'));
  assert.ok(statuses.includes('connected:opcua'));

  const browse = await manager.browse();
  assert.equal(browse.ok, true);
  assert.equal(browse.data[0].id, 's1');
  assert.equal((await manager.readTags(['s1.t'])).ok, true);
  assert.deepEqual(await manager.writeTag('s1.t', 2), { ok: true, data: null });

  const off = await manager.disconnect();
  assert.equal(off.ok, true);
  assert.equal(manager.getStatus().status, 'disconnected');
});

test('manager 连接失败返回中文错误而不抛出', async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'factory-manager-fail-'));
  const manager = new FactoryManager({
    configFile: join(sandbox, 'factory.json'),
    timeoutMs: 500,
    createAdapter: () => ({
      kind: 'opcua',
      async connect() { throw new Error('OPC UA 连接失败：目标不可达'); },
      async disconnect() {},
      async browse() { return []; },
      async readTags() { return {}; },
      async writeTag() {},
      subscribe() { return () => {}; },
      status() { return 'error'; }
    })
  });
  const result = await manager.connect({ kind: 'opcua', endpointUrl: 'opc.tcp://127.0.0.1:1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /目标不可达/);
  assert.equal(manager.getStatus().status, 'error');
  const read = await manager.readTags(['x']);
  assert.equal(read.ok, false);
  assert.match(read.message, /尚未连接/);
});

test('manager 将配置持久化到 factory.json 且默认隐藏密码', async () => {
  const { manager, configFile } = makeManager();
  const result = await manager.connect({ kind: 'demo' });
  assert.equal(result.ok, true);
  const raw = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(raw.kind, 'demo');

  const status = manager.getStatus();
  assert.equal(status.config.kind, 'demo');
  assert.equal(status.config.password, undefined);

  const saved = manager.readConfigFile();
  assert.equal(saved.kind, 'demo');
  assert.equal(manager.getConfig().ok, true);

  writeFileSync(configFile, '{bad json', 'utf8');
  assert.throws(() => manager.readConfigFile(), /factory\.json 解析失败/);
  const fresh = new FactoryManager({ configFile, timeoutMs: 200 });
  const read = fresh.getConfig();
  assert.equal(read.ok, false);
  assert.match(read.message, /factory\.json 解析失败/);
});


test('manager 对慢操作应用超时并返回中文错误', async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'factory-manager-timeout-'));
  const manager = new FactoryManager({
    configFile: join(sandbox, 'factory.json'),
    timeoutMs: 30,
    createAdapter: () => ({
      kind: 'demo',
      async connect() {},
      async disconnect() {},
      async browse() {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [];
      },
      async readTags() { return {}; },
      async writeTag() {},
      subscribe() { return () => {}; },
      status() { return 'connected'; }
    })
  });
  assert.equal((await manager.connect({ kind: 'demo' })).ok, true);
  const result = await manager.browse();
  assert.equal(result.ok, false);
  assert.match(result.message, /浏览点位.*超时/);
});
