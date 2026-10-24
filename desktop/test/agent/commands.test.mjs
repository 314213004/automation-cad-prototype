import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import {
  CommandBus,
  RendererBridge,
  SIMPLE_BOM_NOTE,
  createAgentCommandBus
} from '../../src/agent/commands.ts';

let sandbox;
let registry;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-commands-test-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0',
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} },
    { id: 'MHZ2-20', model: 'MHZ2-20.stp', category: '气爪', specs: {} }
  ]));
  registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

function createFakeBridge(handler) {
  const calls = [];
  return {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      return await handler(method, args);
    }
  };
}

test('命令总线注册并执行成功后记录历史', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  bus.register({
    name: 'ping',
    async run(args) {
      return { ok: true, data: { value: args.value } };
    }
  });
  const result = await bus.execute('ping', { value: 42 });
  assert.deepEqual(result, { ok: true, data: { value: 42 } });
  assert.equal(bus.history().length, 1);
  assert.equal(bus.history()[0].name, 'ping');
  assert.equal(bus.history()[0].ok, true);
  assert.doesNotThrow(() => new Date(bus.history()[0].at).toISOString());
});

test('重复注册命令会抛出中文错误', () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  const command = { name: 'same', async run() { return { ok: true }; } };
  bus.register(command);
  assert.throws(() => bus.register(command), /重复注册命令/);
});

test('未知命令返回 UNKNOWN_COMMAND 且不记录历史', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  const result = await bus.execute('missing');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNKNOWN_COMMAND');
  assert.equal(bus.history().length, 0);
});

test('命令返回失败会写入失败历史', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  bus.register({
    name: 'fail',
    async run() {
      return { ok: false, error: { code: 'BOOM', message: '业务失败' } };
    }
  });
  const result = await bus.execute('fail');
  assert.deepEqual(result, { ok: false, error: { code: 'BOOM', message: '业务失败' } });
  assert.equal(bus.history()[0].ok, false);
});

test('命令抛异常会转成结构化错误并记录失败', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  bus.register({
    name: 'throws',
    async run() {
      throw new Error('底层失败');
    }
  });
  const result = await bus.execute('throws');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'COMMAND_FAILED');
  assert.match(result.error.message, /底层失败/);
  assert.equal(bus.history()[0].ok, false);
});

test('undoLast 调用最后一次命令的 undo 令牌', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  const undone = [];
  bus.register({
    name: 'write',
    async run() {
      return { ok: true, data: { id: 1 }, undoToken: 'token-1' };
    },
    async undo(token) {
      undone.push(token);
    }
  });
  await bus.execute('write');
  const result = await bus.undoLast();
  assert.equal(result.ok, true);
  assert.deepEqual(undone, ['token-1']);
});

test('没有可撤销命令时返回 NOTHING_TO_UNDO', async () => {
  const bus = new CommandBus({ registry, bridge: createFakeBridge(async () => ({ ok: true })) });
  const result = await bus.undoLast();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOTHING_TO_UNDO');
});

test('insert_component 在 registry 中找不到 partId 时返回 PART_NOT_FOUND', async () => {
  const bus = createAgentCommandBus(registry, createFakeBridge(async () => ({ ok: true })));
  const result = await bus.execute('insert_component', { partId: 'NOT-EXIST' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PART_NOT_FOUND');
});

test('import_cad 拒绝非 CAD 扩展名', async () => {
  const bus = createAgentCommandBus(registry, createFakeBridge(async () => ({ ok: true })));
  const result = await bus.execute('import_cad', { path: join(sandbox, 'drawing.txt') });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'UNSUPPORTED_FORMAT');
});

test('import_cad 对不存在的 CAD 文件返回 FILE_NOT_FOUND', async () => {
  const bus = createAgentCommandBus(registry, createFakeBridge(async () => ({ ok: true })));
  const result = await bus.execute('import_cad', { path: join(sandbox, 'missing.stp') });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FILE_NOT_FOUND');
});

test('RendererBridge 超时返回中文 RENDERER_TIMEOUT', async () => {
  const bridge = new RendererBridge(() => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: () => new Promise(() => {})
    }
  }), 20);
  await assert.rejects(
    () => bridge.call('getBom'),
    (error) => error.code === 'RENDERER_TIMEOUT' && /渲染层调用超时/.test(error.message)
  );
});

test('RendererBridge 在窗口不存在时返回中文错误', async () => {
  const bridge = new RendererBridge(() => null);
  await assert.rejects(
    () => bridge.call('getBom'),
    (error) => error.code === 'RENDERER_UNAVAILABLE' && /窗口不存在或已销毁/.test(error.message)
  );
});

test('get_bom 在空模型时返回空数组与简化说明', async () => {
  const bridge = createFakeBridge(async (method) => method === 'getBom' ? [] : { ok: true });
  const bus = createAgentCommandBus(registry, bridge);
  const result = await bus.execute('get_bom');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.rows, []);
  assert.equal(result.data.note, SIMPLE_BOM_NOTE);
});

test('insert_component 成功后 undo 会调用 removeComponent', async () => {
  const bridge = createFakeBridge(async (method, args) => {
    if (method === 'insertComponent') return { ok: true, meshIndex: 3, name: args[0].model };
    if (method === 'removeComponent') return { ok: true };
    return { ok: false, message: `unexpected ${method}` };
  });
  const bus = createAgentCommandBus(registry, bridge);
  const result = await bus.execute('insert_component', { partId: 'MXQ20-50', name: '定位气缸' });
  assert.equal(result.ok, true);
  assert.equal(result.data.meshIndex, 3);
  assert.equal(result.data.name, '定位气缸');
  assert.deepEqual(bridge.calls[0].args[0], {
    id: 'MXQ20-50',
    model: '定位气缸',
    category: '气缸'
  });

  const undone = await bus.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(bridge.calls[1], { method: 'removeComponent', args: [3] });
});
