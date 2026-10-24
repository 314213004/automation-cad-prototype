import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuditLog, formatAuditLine } from '../../src/agent/audit.ts';
import {
  AUDIT_RETENTION_FILE,
  DEFAULT_AUDIT_RETENTION,
  createAuditFileWriter,
  listRotatedIndexes,
  loadAuditRetention,
  normalizeAuditRetention,
  pruneAuditFiles,
  readAuditEntries,
  rotateAuditFile,
  rotatedAuditPath
} from '../../src/agent/audit-store.ts';
import { listRotatedAuditFiles, loadReportSources, buildReport } from '../../scripts/agent-report.mjs';

const KB = 1024;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-audit-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setAge(path, days, now = Date.now()) {
  const time = new Date(now - days * 86_400_000);
  utimesSync(path, time, time);
}

test('保留参数：默认 5 MB × 5 份 × 90 天，非法值回落默认，越界值夹紧', () => {
  assert.deepEqual(normalizeAuditRetention(), { maxBytes: 5 * 1024 * 1024, maxFiles: 5, retentionDays: 90 });
  assert.deepEqual(normalizeAuditRetention(null), DEFAULT_AUDIT_RETENTION);
  assert.deepEqual(
    normalizeAuditRetention({ maxBytes: 'big', maxFiles: Number.NaN, retentionDays: -3 }),
    { maxBytes: 5 * 1024 * 1024, maxFiles: 5, retentionDays: 0 }
  );
  assert.deepEqual(
    normalizeAuditRetention({ maxBytes: 10, maxFiles: 999, retentionDays: 30.7 }),
    { maxBytes: 64 * KB, maxFiles: 50, retentionDays: 30 }
  );
});

test('保留参数：从 userData/agent-audit-retention.json 读取，缺失或损坏时用默认值', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(loadAuditRetention(dir), DEFAULT_AUDIT_RETENTION);
  writeFileSync(join(dir, AUDIT_RETENTION_FILE), JSON.stringify({ maxBytes: 1024 * KB, maxFiles: 3, retentionDays: 30 }));
  assert.deepEqual(loadAuditRetention(dir), { maxBytes: 1024 * KB, maxFiles: 3, retentionDays: 30 });
  writeFileSync(join(dir, AUDIT_RETENTION_FILE), '{坏 json');
  assert.deepEqual(loadAuditRetention(dir), DEFAULT_AUDIT_RETENTION);
});

test('轮转文件名：agent-audit.jsonl → agent-audit.N.jsonl，只认本文件的编号', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  assert.equal(rotatedAuditPath(file, 2), join(dir, 'agent-audit.2.jsonl'));
  for (const name of ['agent-audit.1.jsonl', 'agent-audit.3.jsonl', 'agent-audit.x.jsonl', 'agent-audit-smoke.1.jsonl', 'agent-audit.2.json']) {
    writeFileSync(join(dir, name), '');
  }
  assert.deepEqual(listRotatedIndexes(file), [1, 3]);
});

test('按大小轮转：超过 maxBytes 滚动为 .1/.2，只保留 maxFiles 份，读取按时间顺序拼接', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  let tick = Date.parse('2026-10-24T00:00:00.000Z');
  const now = () => new Date((tick += 1000));
  const write = createAuditFileWriter(file, { retention: { maxBytes: 64 * KB, maxFiles: 2, retentionDays: 0 }, now });
  const audit = createAuditLog({ write, now });
  const padding = 'x'.repeat(900);
  for (let index = 0; index < 300; index += 1) {
    audit.record({ tool: 'get_bom', ok: index % 7 !== 0, message: `#${index} ${padding}` });
  }
  assert.ok(existsSync(file));
  assert.ok(existsSync(rotatedAuditPath(file, 1)));
  assert.ok(existsSync(rotatedAuditPath(file, 2)));
  assert.equal(existsSync(rotatedAuditPath(file, 3)), false, '超出 maxFiles 的份数应被删除');
  for (const path of [file, rotatedAuditPath(file, 1), rotatedAuditPath(file, 2)]) {
    assert.ok(statSync(path).size <= 64 * KB, `${path} 不应超过 maxBytes`);
  }

  const { entries, files } = readAuditEntries(file, { maxFiles: 2 });
  assert.deepEqual(files, [rotatedAuditPath(file, 2), rotatedAuditPath(file, 1), file]);
  assert.ok(entries.length > 100 && entries.length < 300, `只保留部分历史，实际 ${entries.length}`);
  const sorted = [...entries].map((entry) => entry.at).sort();
  assert.deepEqual(entries.map((entry) => entry.at), sorted, '最旧轮转 → 当前，整体按时间升序');
  assert.match(entries.at(-1).message, /^#299 /, '最后一条是最新写入');
  // 每行都是完整 JSON：轮转只在行边界发生。
  for (const path of files) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) JSON.parse(line);
  }
});

test('轮转后脱敏不变：密钥字段与裸 sk-/Bearer 在所有份数里都被掩码', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  const write = createAuditFileWriter(file, { retention: { maxBytes: 64 * KB, maxFiles: 3, retentionDays: 0 } });
  const audit = createAuditLog({ write });
  for (let index = 0; index < 120; index += 1) {
    audit.record({
      tool: 'export_cost_report',
      ok: true,
      args: { apiKey: 'sk-live-should-not-leak-123456', note: 'y'.repeat(800) },
      message: 'Bearer abc.def.ghi 以及 sk-proj-ABCDEFGHIJ'
    });
  }
  assert.ok(existsSync(rotatedAuditPath(file, 1)), '本用例需要至少发生一次轮转');
  const raw = [file, ...listRotatedIndexes(file).map((index) => rotatedAuditPath(file, index))]
    .map((path) => readFileSync(path, 'utf8'))
    .join('');
  assert.equal(raw.includes('should-not-leak'), false);
  assert.equal(raw.includes('abc.def.ghi'), false);
  assert.equal(raw.includes('ABCDEFGHIJ'), false);
  assert.ok(raw.includes('****'));
});

test('读取：轮转文件里的坏行与非审计行跳过，不影响其余记录', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  writeFileSync(
    rotatedAuditPath(file, 1),
    `${formatAuditLine({ tool: 'get_bom', ok: true }, new Date('2026-10-01T00:00:00Z'))}\n{坏行\n{"foo":1}\n`
  );
  writeFileSync(file, `${formatAuditLine({ tool: 'run_cost_report', ok: false, code: 'X' }, new Date('2026-10-02T00:00:00Z'))}\n`);
  writeFileSync(rotatedAuditPath(file, 9), `${formatAuditLine({ tool: 'stale', ok: true })}\n`);
  const { entries, files } = readAuditEntries(file, { maxFiles: 5 });
  assert.deepEqual(entries.map((entry) => entry.tool), ['get_bom', 'run_cost_report']);
  assert.equal(files.length, 2, '编号超过 maxFiles 的残留不读');
  assert.deepEqual(readAuditEntries(join(dir, 'missing.jsonl')), { entries: [], files: [] });
});

test('保留期清理：过期轮转文件、过期当前文件与超编号残留被删除，未过期保留；0 天表示不清理', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  const now = new Date('2026-10-24T02:00:00Z');
  const line = `${formatAuditLine({ tool: 'get_bom', ok: true })}\n`;
  for (const index of [1, 2, 3, 7]) writeFileSync(rotatedAuditPath(file, index), line);
  writeFileSync(file, line);
  setAge(rotatedAuditPath(file, 1), 10, now.getTime());
  setAge(rotatedAuditPath(file, 2), 95, now.getTime());
  setAge(rotatedAuditPath(file, 3), 200, now.getTime());
  setAge(rotatedAuditPath(file, 7), 1, now.getTime());
  setAge(file, 1, now.getTime());

  const disabled = pruneAuditFiles(file, normalizeAuditRetention({ maxFiles: 10, retentionDays: 0 }), now);
  assert.deepEqual(disabled.removed, []);

  const result = pruneAuditFiles(file, normalizeAuditRetention({ maxFiles: 5, retentionDays: 90 }), now);
  assert.deepEqual(result.removed.sort(), [2, 3, 7].map((index) => rotatedAuditPath(file, index)).sort());
  assert.deepEqual(listRotatedIndexes(file), [1]);
  assert.ok(existsSync(file));

  setAge(file, 120, now.getTime());
  pruneAuditFiles(file, normalizeAuditRetention({ retentionDays: 90 }), now);
  assert.equal(existsSync(file), false, '整份过期的当前文件也清理');
});

test('写入器创建时先做保留期清理', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  const now = new Date('2026-10-24T02:00:00Z');
  writeFileSync(rotatedAuditPath(file, 1), `${formatAuditLine({ tool: 'old', ok: true })}\n`);
  setAge(rotatedAuditPath(file, 1), 100, now.getTime());
  const write = createAuditFileWriter(file, { retention: { retentionDays: 90 }, now: () => now });
  assert.equal(existsSync(rotatedAuditPath(file, 1)), false);
  write(formatAuditLine({ tool: 'new', ok: true }, now));
  assert.deepEqual(readAuditEntries(file).entries.map((entry) => entry.tool), ['new']);
});

test('rotateAuditFile：空文件不轮转；非空时 .1 → .2、当前 → .1', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  const options = normalizeAuditRetention({ maxFiles: 3 });
  assert.equal(rotateAuditFile(file, options), false);
  writeFileSync(file, '');
  assert.equal(rotateAuditFile(file, options), false);
  writeFileSync(file, 'A\n');
  writeFileSync(rotatedAuditPath(file, 1), 'B\n');
  assert.equal(rotateAuditFile(file, options), true);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(rotatedAuditPath(file, 1), 'utf8'), 'A\n');
  assert.equal(readFileSync(rotatedAuditPath(file, 2), 'utf8'), 'B\n');
});

test('轮转失败不丢审计：报告 onError，仍追加到当前文件', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'agent-audit.jsonl');
  const errors = [];
  // 让轮转目标 .1 是非空目录：删除/改名都会失败。
  mkdirSync(rotatedAuditPath(file, 1));
  writeFileSync(join(rotatedAuditPath(file, 1), 'keep'), 'x');
  writeFileSync(file, `${'z'.repeat(64 * KB)}\n`);
  const write = createAuditFileWriter(file, {
    retention: { maxBytes: 64 * KB, maxFiles: 1, retentionDays: 0 },
    onError: (error) => errors.push(error)
  });
  write(formatAuditLine({ tool: 'get_bom', ok: true }));
  assert.ok(errors.length >= 1, '轮转失败应回调 onError');
  assert.ok(readFileSync(file, 'utf8').includes('"tool":"get_bom"'), '记录仍写入当前文件');
});

test('Agent 报告：userData 下的轮转审计文件一并计入', (t) => {
  const dir = tempDir(t);
  const userData = join(dir, 'userData');
  mkdirSync(userData);
  const file = join(userData, 'agent-audit.jsonl');
  writeFileSync(rotatedAuditPath(file, 2), `${formatAuditLine({ tool: 'get_bom', ok: true }, new Date('2026-10-01T00:00:00Z'))}\n`);
  writeFileSync(rotatedAuditPath(file, 1), `${formatAuditLine({ tool: 'get_bom', ok: false }, new Date('2026-10-02T00:00:00Z'))}`);
  writeFileSync(file, `${formatAuditLine({ tool: 'run_cost_report', ok: true }, new Date('2026-10-03T00:00:00Z'))}\n`);
  assert.deepEqual(listRotatedAuditFiles(userData), [rotatedAuditPath(file, 2), rotatedAuditPath(file, 1)]);
  const sources = loadReportSources(undefined, { userDataDir: userData });
  assert.equal(sources.audit.status, 'ok');
  const report = buildReport(sources, { now: new Date('2026-10-24T00:00:00Z'), testCount: { value: 1, source: 'fixture', generatedAt: null, passed: true } });
  assert.equal(report.audit.total, 3);
  assert.equal(report.audit.failed, 1);
  assert.deepEqual(report.audit.malformed, []);
  assert.equal(report.audit.lastAt, '2026-10-03T00:00:00.000Z');
});
