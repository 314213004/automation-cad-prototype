import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runBrepInterferenceScript } from '../../electron/parametric.ts';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fakeScript(body) {
  const dir = mkdtempSync(join(tmpdir(), 'brep-test-'));
  dirs.push(dir);
  const script = join(dir, 'fake.py');
  writeFileSync(script, body, 'utf8');
  return script;
}

test('runBrepInterferenceScript：解析脚本最后一行 JSON', async () => {
  const script = fakeScript('import json,sys\nprint("noise")\nprint(json.dumps({"ok": True, "parts": 3, "hits": [{"a":"A","b":"B","volumeMm3":12.5,"ratio":0.01,"severity":"轻微"}], "elapsedMs": 7}))\n');
  const result = await runBrepInterferenceScript({ python: 'python3', script, stepPath: '/tmp/x.stp' });
  assert.equal(result.ok, true);
  assert.equal(result.parts, 3);
  assert.equal(result.hits?.[0]?.volumeMm3, 12.5);
});

test('runBrepInterferenceScript：脚本输出非 JSON → BAD_OUTPUT，不抛异常', async () => {
  const script = fakeScript('print("Traceback: boom")\n');
  const result = await runBrepInterferenceScript({ python: 'python3', script, stepPath: '/tmp/x.stp' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_OUTPUT');
  assert.match(result.message, /Traceback/);
});

test('runBrepInterferenceScript：脚本无输出 → NO_OUTPUT，带上 stderr 末尾', async () => {
  const script = fakeScript('import sys\nsys.stderr.write("OCP missing")\nsys.exit(3)\n');
  const result = await runBrepInterferenceScript({ python: 'python3', script, stepPath: '/tmp/x.stp' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_OUTPUT');
  assert.match(result.message, /OCP missing/);
});

test('runBrepInterferenceScript：超时会杀进程并返回 TIMEOUT', async () => {
  const script = fakeScript('import time\ntime.sleep(10)\n');
  const started = Date.now();
  const result = await runBrepInterferenceScript({ python: 'python3', script, stepPath: '/tmp/x.stp', timeoutMs: 800 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TIMEOUT');
  assert.ok(Date.now() - started < 5000, '不应真的等 10 秒');
});

test('runBrepInterferenceScript：解释器不存在 → SPAWN_FAILED', async () => {
  const script = fakeScript('print("{}")\n');
  const result = await runBrepInterferenceScript({ python: '/nonexistent/python', script, stepPath: '/tmp/x.stp' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SPAWN_FAILED');
});
