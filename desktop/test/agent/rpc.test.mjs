import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools } from '../../src/agent/tools.ts';
import { AgentRpcServer, createAgentToken, createAgentTokenFile } from '../../src/agent/rpc.ts';

let sandbox;
let server;
let url;
let token;

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-rpc-test-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0'
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  const registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
  token = createAgentToken();
  server = new AgentRpcServer({
    tools: new AgentTools(registry),
    token,
    version: '0.1.0-test',
    host: '127.0.0.1',
    port: 0
  });
  const info = await server.start();
  url = info.url;
});

after(async () => {
  await server.stop();
  rmSync(sandbox, { recursive: true, force: true });
});

test('无 token 访问返回 401', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  assert.equal(response.status, 401);
});

test('错误 token 访问返回 401', async () => {
  const response = await fetch(`${url}/health`, {
    headers: { authorization: 'Bearer wrong-token' }
  });
  assert.equal(response.status, 401);
});

test('有 token 能列出 18 个工具与健康信息', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.tools.length, 18);

  const health = await fetch(`${url}/health`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.toolCount, 18);
  assert.equal(healthBody.version, '0.1.0-test');
});

test('未知工具返回 -32601', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} }
    })
  });
  const body = await response.json();
  assert.equal(body.error.code, -32601);
});

test('有 token 能调用 list_components', async () => {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_components', arguments: {} }
    })
  });
  const body = await response.json();
  assert.equal(body.result.structuredContent.count, 1);
  assert.equal(body.result.isError, false);
});

test('Agent token 文件权限为 600（仅 POSIX；Windows 无 POSIX 位）', { skip: process.platform === 'win32' }, () => {
  const tokenDir = join(sandbox, 'agent-token-test');
  const created = createAgentTokenFile(tokenDir);
  assert.equal(statSync(created.tokenFile).mode & 0o777, 0o600);
  assert.equal(created.token.length, 43);
});
