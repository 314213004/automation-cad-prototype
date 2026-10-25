#!/usr/bin/env node
/**
 * 局域网联调探测：验证 /health、tools/list 与只读 list_components。
 *
 * 用法：
 *   node scripts/lan-debug-probe.mjs --url http://192.168.2.10:7420 --token-file ~/.config/AutomationCAD/agent-token
 *   node scripts/lan-debug-probe.mjs --url http://127.0.0.1:7420 --token "…"
 *
 * token-file 优先于 --token；任一步失败退出码为 1，并输出中文原因。
 */

import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`局域网探测失败：${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split('=', 2);
    if (name !== '--url' && name !== '--token-file' && name !== '--token') {
      throw new Error(`未知参数：${argument}`);
    }
    const value = inline ?? argv[index + 1];
    if (!value) throw new Error(`参数 ${name} 缺少值`);
    result[name.slice(2)] = value;
    if (inline === undefined) index += 1;
  }
  return result;
}

function resolveToken(options) {
  if (options['token-file']) {
    try {
      const token = readFileSync(options['token-file'], 'utf8').trim();
      if (!token) throw new Error('文件为空');
      return token;
    } catch (error) {
      throw new Error(`读取 token 文件失败：${options['token-file']}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  if (options.token) return options.token.trim();
  throw new Error('必须提供 --token-file 或 --token（优先 token-file）');
}

async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`无法连接 ${url}：${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error : JSON.stringify(body);
    throw new Error(`HTTP ${response.status}：${detail}`);
  }
  return body;
}

async function main() {
  let options;
  let token;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!options.url) throw new Error('缺少 --url，例如 --url http://192.168.2.10:7420');
    token = resolveToken(options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  let base;
  try {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https');
    base = parsed.href.replace(/\/+$/, '');
  } catch (error) {
    fail(`--url 非法：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };

  try {
    const health = await fetchJson(`${base}/health`, { headers });
    if (!health?.ok) throw new Error(`健康检查返回异常：${JSON.stringify(health).slice(0, 200)}`);
    console.log(
      `健康检查：版本=${health.version ?? '—'} 工具数=${health.toolCount ?? '—'} ` +
      `监听=${health.host ?? '—'}:${health.port ?? '—'} 局域网=${health.lanEnabled ? 'on' : 'off'} ` +
      `CDP=${health.cdpPort ?? 'off'}`
    );
  } catch (error) {
    fail(`GET /health 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  let toolNames;
  try {
    const listed = await fetchJson(`${base}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    if (listed?.error) throw new Error(listed.error.message ?? JSON.stringify(listed.error));
    const tools = listed?.result?.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list 未返回 tools 数组');
    toolNames = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
    console.log(`工具列表：${toolNames.length} 个 → ${toolNames.join(', ')}`);
  } catch (error) {
    fail(`POST /rpc tools/list 失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    const called = await fetchJson(`${base}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_components', arguments: { limit: 3 } }
      })
    });
    if (called?.error) throw new Error(called.error.message ?? JSON.stringify(called.error));
    const result = called?.result?.structuredContent;
    if (!result || result.ok === false) throw new Error(result?.message ?? 'list_components 返回失败');
    const components = Array.isArray(result.components) ? result.components : [];
    const shown = components.slice(0, 3);
    const summary = shown.map((part) => part?.model ?? part?.id ?? '(未命名)').join(', ');
    console.log(`只读调用：list_components count=${result.count ?? components.length} limit=3 shown=${shown.length}`);
    console.log(`结果摘要：${summary || '（无元器件）'}`);
    console.log('局域网探测成功（LAN_DEBUG_OK）');
  } catch (error) {
    fail(`POST /rpc list_components 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

await main();

