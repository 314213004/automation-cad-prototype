#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { buildDesignPackage, sha256Hex } from '../src/sync/package.ts';
import { SyncClient } from '../src/sync/client.ts';
import { GLB_FIXTURE, bomCsv, bomRows } from './fixtures/design-package.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const reportPath = resolve(repoRoot, 'docs/desktop/eval/sync-e2e.json');

const baseUrl = (process.env.SYNC_E2E_BASE_URL ?? 'http://127.0.0.1:8899').replace(/\/+$/, '');
const apiKey = process.env.SYNC_E2E_API_KEY ?? '';
const deviceId = process.env.SYNC_E2E_DEVICE_ID ?? 'DEV-TEST-01';
const projectId = process.env.SYNC_E2E_PROJECT_ID ?? 'asm-sync-e2e';
const backendPid = Number(process.env.SYNC_E2E_BACKEND_PID ?? '0');

const report = {
  generatedAt: new Date().toISOString(),
  ok: false,
  baseUrl,
  deviceId,
  projectId,
  checks: [],
  summary: {},
  error: null
};

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function step(name, fn) {
  try {
    const value = await fn();
    report.checks.push({ name, ok: true });
    return value;
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function backendIsUp() {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function disconnectBackend() {
  if (!Number.isInteger(backendPid) || backendPid <= 0) {
    throw new Error('缺少 SYNC_E2E_BACKEND_PID，无法执行断开后端断言');
  }
  try {
    process.kill(backendPid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await backendIsUp())) return;
    await delay(100);
  }
  try {
    process.kill(backendPid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await backendIsUp())) return;
    await delay(100);
  }
  throw new Error('后端在 15 秒内仍未断开');
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function run() {
  assert.ok(apiKey, '缺少 SYNC_E2E_API_KEY');

  const config = {
    baseUrl,
    apiKey,
    deviceId,
    projectId,
    enabled: true
  };
  const client = new SyncClient(config);

  const v1 = buildDesignPackage({
    projectId,
    projectName: '设计同步端到端测试',
    appVersion: '0.3.0',
    createdAt: '2026-10-23T00:00:00+08:00',
    bom: bomRows(2),
    bomCsv: bomCsv(2),
    glb: GLB_FIXTURE
  });
  const v2 = buildDesignPackage({
    projectId,
    projectName: '设计同步端到端测试',
    appVersion: '0.3.0',
    createdAt: '2026-10-23T00:00:00+08:00',
    bom: bomRows(5),
    bomCsv: bomCsv(5),
    glb: GLB_FIXTURE
  });
  assert.notEqual(v1.zipSha256, v2.zipSha256, '第二版 zip 应与第一版不同');

  const first = await step('upload-v1', async () => {
    const result = await client.uploadPackage(v1.zip, v1.manifest);
    assert.equal(result.ok, true, result.message);
    assert.match(result.packageId ?? '', /^dsp_[0-9a-f]{32}$/);
    assert.equal(result.duplicated, false);
    return result;
  });

  const duplicate = await step('upload-duplicate', async () => {
    const result = await client.uploadPackage(v1.zip, v1.manifest);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.duplicated, true);
    assert.equal(result.packageId, first.packageId);
    return result;
  });

  await step('list-contains-package', async () => {
    const result = await client.listPackages();
    assert.equal(result.ok, true, result.message);
    assert.ok(
      result.items.some((item) => item.packageId === first.packageId && item.projectId === projectId),
      '列表应包含刚上传的设计包'
    );
  });

  const second = await step('upload-v2', async () => {
    const result = await client.uploadPackage(v2.zip, v2.manifest);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.duplicated, false);
    assert.equal(result.version, (first.version ?? 0) + 1);
    return result;
  });

  const difference = await step('diff-bom-qty', async () => {
    const result = await client.diff(second.packageId);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.diff.base.packageId, first.packageId);
    const changed = result.diff.bomChanged.find(
      (row) => row.no === 2 && row.field === 'qty' && row.from === 2 && row.to === 5
    );
    assert.ok(changed, `bomChanged 应包含第 2 行数量 2→5，实际：${JSON.stringify(result.diff.bomChanged)}`);
    return result;
  });

  const downloaded = await step('download-bytes-sha256', async () => {
    const result = await client.downloadPackage(first.packageId);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.bytes, v1.zip.byteLength);
    assert.equal(result.sha256, v1.zipSha256);
    assert.equal(sha256Hex(result.zip), v1.zipSha256);
    assert.equal(result.etag, v1.zipSha256);
    return result;
  });

  await step('backend-disconnect', disconnectBackend);

  await step('offline-upload-error-code', async () => {
    let result;
    try {
      result = await client.uploadPackage(v1.zip, v1.manifest);
    } catch (error) {
      throw new Error(`断开后端后 uploadPackage 抛出了未捕获异常：${error instanceof Error ? error.message : String(error)}`);
    }
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UPLOAD_FAILED');
    assert.equal(result.stage, '上传');
    assert.match(result.message, /[\u4e00-\u9fff]/);
    assert.match(result.message, /上传设计包|超时/);
    return result;
  });

  await step('offline-list-error-code', async () => {
    const result = await client.listPackages();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LIST_FAILED');
    assert.match(result.message, /[\u4e00-\u9fff]/);
  });

  report.summary = {
    packageId: first.packageId,
    version: first.version,
    duplicated: duplicate.duplicated,
    diffChanges: difference.diff.bomChanged.length,
    bytes: downloaded.bytes,
    sha256: downloaded.sha256
  };
}

try {
  await run();
  report.ok = true;
  writeReport();
  const summary = report.summary;
  console.log(
    `SYNC_E2E_OK package=${summary.packageId} dup=${summary.duplicated} diff=${summary.diffChanges} bytes=${summary.bytes}`
  );
} catch (error) {
  report.ok = false;
  report.error = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
  writeReport();
  console.error(`SYNC_E2E_FAIL ${report.error.message}`);
  console.error(`日志：${reportPath}`);
  process.exitCode = 1;
}
