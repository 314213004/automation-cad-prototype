import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentRpcServer, createAgentToken, restartAgentServer } from '../../src/agent/rpc.ts';

const execFileAsync = promisify(execFile);
let sandbox;
let server;
let token;
let url;
const audit = [];

function tools() {
  const summary = {
    name: 'list_components',
    description: 'test read tool',
    inputSchema: { type: 'object', properties: {} }
  };
  return {
    list: () => [summary],
    summaries: () => [summary],
    has: (name) => name === summary.name,
    async call(name, args) {
      return {
        ok: true,
        count: 3,
        name,
        args,
        components: [{ id: 'MXQ20-50', model: 'MXQ20-50' }]
      };
    }
  };
}

async function getHealth(target, authToken = token) {
  const response = await fetch(`${target}/health`, {
    headers: { authorization: `Bearer ${authToken}` }
  });
  return { status: response.status, body: await response.json() };
}

function externalIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-lan-rpc-'));
  token = createAgentToken();
  server = new AgentRpcServer({
    tools: tools(),
    token,
    version: '0.1.0-lan-test',
    host: '127.0.0.1',
    port: 0,
    lanEnabled: false,
    allowlist: ['192.168.0.0/16'],
    cdpPort: null,
    audit: (record) => audit.push(record)
  });
  const info = await server.start();
  url = info.url;
});

after(async () => {
  await server.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

test('/health 返回监听/白名单/CDP，且不泄露 token', async () => {
  const health = await getHealth(url);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.body).sort(), [
    'allowlist', 'cdpPort', 'host', 'lanEnabled', 'ok', 'port', 'toolCount', 'version'
  ]);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, '0.1.0-lan-test');
  assert.equal(health.body.host, '127.0.0.1');
  assert.equal(health.body.lanEnabled, false);
  assert.deepEqual(health.body.allowlist, ['192.168.0.0/16']);
  assert.equal(health.body.cdpPort, null);
  assert.equal(JSON.stringify(health.body).includes(token), false);
  assert.equal(Object.hasOwn(health.body, 'token'), false);
});

test('热重启后 host 变化且服务继续可用，审计带 remoteAddress/origin', async () => {
  const info = await restartAgentServer(server, '0.0.0.0', {
    lanEnabled: true,
    allowlist: ['192.168.0.0/16'],
    cdpPort: 9222
  });
  assert.equal(info.host, '0.0.0.0');
  const health = await getHealth(`http://127.0.0.1:${info.port}`);
  assert.equal(health.status, 200);
  assert.equal(health.body.host, '0.0.0.0');
  assert.equal(health.body.lanEnabled, true);
  assert.equal(health.body.cdpPort, 9222);

  const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_components', arguments: { limit: 3 } }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.structuredContent.ok, true);
  const record = audit.at(-1);
  assert.equal(record.tool, 'list_components');
  assert.equal(record.origin, 'local');
  assert.equal(record.remoteAddress, '127.0.0.1');
});

test('局域网来源未命中白名单返回 403 并审计', { skip: !externalIpv4() }, async () => {
  const address = externalIpv4();
  assert.ok(address);
  const info = await restartAgentServer(server, '0.0.0.0', {
    lanEnabled: true,
    allowlist: ['10.0.0.0/8'],
    cdpPort: null
  });
  const target = `http://${address}:${info.port}`;
  const denied = await getHealth(target);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { ok: false, error: 'LAN_NOT_ALLOWED' });
  const record = audit.at(-1);
  assert.equal(record.tool, 'lan_access_check');
  assert.equal(record.code, 'LAN_NOT_ALLOWED');
  assert.equal(record.origin, 'lan');
  assert.equal(record.remoteAddress, address);
});

test('远程写工具仍必须经过桌面确认，不能静默执行', { skip: !externalIpv4() }, async () => {
  const address = externalIpv4();
  assert.ok(address);
  const calls = [];
  const confirmations = [];
  const summary = {
    name: 'insert_component',
    description: 'test write tool',
    inputSchema: { type: 'object', properties: {} }
  };
  const remote = new AgentRpcServer({
    tools: {
      list: () => [summary],
      summaries: () => [summary],
      has: (name) => name === 'insert_component',
      async call(name, args) {
        calls.push({ name, args });
        return { ok: true };
      }
    },
    token,
    version: '0.1.0-lan-write-test',
    host: '0.0.0.0',
    port: 0,
    lanEnabled: true,
    allowlist: [`${address}/32`],
    cdpPort: null,
    confirmWrite: async (name, args) => {
      confirmations.push({ name, args });
      return false;
    }
  });
  const info = await remote.start();
  try {
    const response = await fetch(`http://${address}:${info.port}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'insert_component', arguments: { partId: 'MXQ20-50' } }
      })
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.structuredContent.code, 'USER_DENIED');
    assert.equal(confirmations.length, 1);
    assert.equal(calls.length, 0);
  } finally {
    await remote.stop();
  }
});

test('端口冲突返回中文错误', async () => {
  const occupancy = new AgentRpcServer({
    tools: tools(),
    token,
    version: 'occupancy',
    host: '127.0.0.1',
    port: 0
  });
  const occupied = await occupancy.start();
  const conflicting = new AgentRpcServer({
    tools: tools(),
    token,
    version: 'conflict',
    host: '127.0.0.1',
    port: occupied.port
  });
  try {
    await assert.rejects(conflicting.start(), /Agent 端口被占用/);
  } finally {
    await occupancy.stop();
  }
});

test('lan-debug-probe.mjs 对真实 HTTP 服务完成 health/tools/list/只读调用', async () => {
  const isolated = new AgentRpcServer({
    tools: tools(),
    token,
    version: '0.1.0-probe-test',
    host: '127.0.0.1',
    port: 0,
    lanEnabled: false,
    allowlist: ['192.168.0.0/16'],
    cdpPort: null
  });
  const info = await isolated.start();
  const tokenFile = join(sandbox, 'probe-token');
  writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  try {
    const probe = fileURLToPath(new URL('../../scripts/lan-debug-probe.mjs', import.meta.url));
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      probe,
      '--url',
      info.url,
      '--token-file',
      tokenFile
    ], { timeout: 15_000 });
    assert.match(stdout, /健康检查：版本=0\.1\.0-probe-test 工具数=1 监听=127\.0\.0\.1:\d+/);
    assert.match(stdout, /工具列表：1 个 → list_components/);
    assert.match(stdout, /只读调用：list_components count=3 limit=3 shown=1/);
    assert.match(stdout, /结果摘要：MXQ20-50/);
    assert.match(stdout, /LAN_DEBUG_OK/);
    assert.equal(stderr, '');
  } finally {
    await isolated.stop();
  }
});
