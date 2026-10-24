import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { buildMcpServer } from '../../src/agent/mcp.ts';
import { DesktopRpcProxy, DesktopRpcUnavailableError } from '../../src/agent/mcp-proxy.ts';

let sandbox;
let registry;
let desktopServer;
let desktopPort;
let received;
const token = 'local-test-token-should-not-leak';

function createRegistry() {
  return new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
}

async function connectedClient(proxy) {
  const tools = new AgentTools(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(tools, { name: 'mcp-proxy-test', version: '1.0.0' }, { proxy });
  const client = new Client({ name: 'mcp-proxy-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-mcp-proxy-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0', categories: ['气缸'], partsCount: 1,
    categories: ['气缸', '气爪', '断路器', '传感器'],
    partsCount: 1
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  registry = createRegistry();
  writeFileSync(join(sandbox, 'agent-token'), token, { encoding: 'utf8', mode: 0o600 });

  desktopServer = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received = {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      const id = received.body.id ?? null;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: '{"ok":true,"meshIndex":2}' }],
          structuredContent: { ok: true, meshIndex: 2, name: '定位气缸' },
          isError: false
        }
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
  });
  await new Promise((resolve) => desktopServer.listen(0, '127.0.0.1', resolve));
  desktopPort = desktopServer.address().port;
});

after(async () => {
  await new Promise((resolve) => desktopServer.close(resolve));
  rmSync(sandbox, { recursive: true, force: true });
});

test('MCP 代理把写工具原样转发到桌面 RPC 并返回结构化结果', async () => {
  const proxy = new DesktopRpcProxy({ userDataDir: sandbox, port: desktopPort });
  const connection = await connectedClient(proxy);
  try {
    const result = await connection.client.callTool({
      name: 'insert_component',
      arguments: { partId: 'MXQ20-50', name: '定位气缸' }
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.meshIndex, 2);
    assert.equal(received.authorization, `Bearer ${token}`);
    assert.equal(received.body.method, 'tools/call');
    assert.equal(received.body.params.name, 'insert_component');
    assert.deepEqual(received.body.params.arguments, { partId: 'MXQ20-50', name: '定位气缸' });
  } finally {
    await connection.close();
  }
});

test('MCP 代理拒绝向非回环 HTTP 主机发送本地 token', async () => {
  let fetchCalls = 0;
  const proxy = new DesktopRpcProxy({
    userDataDir: sandbox,
    host: 'mcp.example.com',
    port: desktopPort,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('不应发起请求');
    }
  });
  await assert.rejects(
    () => proxy.callTool('get_bom', {}),
    (error) => {
      assert.ok(error instanceof DesktopRpcUnavailableError);
      assert.doesNotMatch(error.message, new RegExp(token));
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

test('桌面不可达时只读工具回退本地 registry', async () => {
  const emptyUserData = join(sandbox, 'not-running');
  mkdirSync(emptyUserData, { recursive: true });
  const connection = await connectedClient(new DesktopRpcProxy({ userDataDir: emptyUserData }));
  try {
    const result = await connection.client.callTool({ name: 'list_components', arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.count, 1);
    assert.equal(result.structuredContent.components[0].id, 'MXQ20-50');
  } finally {
    await connection.close();
  }
});

test('桌面不可达时写工具返回 DESKTOP_NOT_RUNNING 中文提示', async () => {
  const emptyUserData = join(sandbox, 'not-running-2');
  mkdirSync(emptyUserData, { recursive: true });
  const connection = await connectedClient(new DesktopRpcProxy({ userDataDir: emptyUserData }));
  try {
    for (const name of ['insert_component', 'import_cad', 'undo_last', 'get_bom', 'run_interference_check']) {
      const result = await connection.client.callTool({ name, arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, 'DESKTOP_NOT_RUNNING');
      assert.equal(result.structuredContent.message, '请先启动 AutomationCAD 桌面应用，再调用该工具');
    }
  } finally {
    await connection.close();
  }
});

test('桌面 RPC 超时归类为不可达且错误不包含 token', async () => {
  const slow = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    setTimeout(() => {
      response.end('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":true}}}');
    }, 300);
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const port = slow.address().port;
  try {
    const proxy = new DesktopRpcProxy({ userDataDir: sandbox, port, timeoutMs: 40 });
    await assert.rejects(
      () => proxy.callTool('get_bom', {}),
      (error) => {
        assert.ok(error instanceof DesktopRpcUnavailableError);
        assert.match(error.message, /超时/);
        assert.doesNotMatch(error.message, new RegExp(token));
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => slow.close(resolve));
  }
});
