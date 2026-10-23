import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import AdmZip from 'adm-zip';
import type { PlcGenConfig } from '../src/plcgen/types.ts';
import { generateProject } from '../src/plcgen/generate.ts';
import { sha256Hex } from '../src/plcgen/hash.ts';
import { planPlcExportDirectory } from '../src/plcgen/export.ts';
import {
  createHistoryEntry,
  mergePlcHistory,
  parsePlcHistory,
  type PlcHistoryEntry
} from '../src/plcgen/history.ts';
import {
  buildClipboardBundle,
  buildFileTree,
  contentBytes,
  countContentLines,
  formatStatsLine,
  isGenerateDisabled,
  locateIssue,
  previewFile
} from '../src/plcgen/view-model.ts';
import { createZip, listZipEntries, normalizeZipPath } from '../src/shared/zip.ts';

function makeConfig(overrides: Record<string, unknown> = {}): PlcGenConfig {
  return {
    id: 'p83-machine',
    name: 'P8-3 测试机型',
    stations: ['上料', '压装'],
    actuators: [
      {
        id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料',
        extendPoint: 'Y0', retractPoint: 'Y1', travelMm: 40, durationMs: 400
      },
      {
        id: 'cyl-2', name: '压装气缸', kind: 'cylinder', station: '压装',
        extendPoint: 'Y2', retractPoint: 'Y3', travelMm: 30, durationMs: 300
      }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-1' },
      { point: 'X2', station: '压装', part: 'cyl-2' },
      { point: 'X3', station: '压装', part: 'cyl-2' }
    ],
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sequence: [
      { id: 's1', name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { id: 's2', name: '压装伸出', action: 'set', point: 'Y2', condition: 'X2', timeoutMs: 1000 }
    ],
    ...overrides
  } as PlcGenConfig;
}

function historyEntry(hash: string, at = '2026-10-23T10:00:00.000Z'): PlcHistoryEntry {
  return {
    at,
    inputHash: hash,
    files: 11,
    target: 'generic',
    namePrefix: 'p83-machine',
    fileList: [{ path: 'README.md', lines: 20, bytes: 300 }]
  };
}

test('P8-3 SHA-256：纯 JS 实现与 Node crypto 一致', () => {
  for (const sample of ['', 'abc', '中文 PLC', JSON.stringify({ id: 'm1', points: ['X0', 'Y0'] })]) {
    assert.equal(sha256Hex(sample), createHash('sha256').update(sample, 'utf8').digest('hex'));
  }
});

test('P8-3 文件树：目录先于子文件，文件带行数与字节数', () => {
  const rows = buildFileTree([
    { path: 'src/b.st', content: 'A\nB\n' },
    { path: 'README.md', content: '# 说明\n' },
    { path: 'src/a.st', content: 'X\nY\nZ' }
  ]);
  assert.deepEqual(rows.map((row) => row.path), ['README.md', 'src', 'src/a.st', 'src/b.st']);
  assert.equal(rows[1]?.kind, 'dir');
  assert.equal(rows[2]?.depth, 1);
  assert.equal(rows[2]?.lines, 3);
  assert.equal(rows[2]?.bytes, 5);
});

test('P8-3 预览：超过 200 行截断并给出总行数', () => {
  const content = Array.from({ length: 250 }, (_unused, index) => `line-${index + 1}`).join('\n') + '\n';
  const preview = previewFile({ path: 'big.st', content });
  assert.equal(preview.totalLines, 250);
  assert.equal(preview.shownLines, 200);
  assert.equal(preview.truncated, true);
  assert.match(preview.text, /line-200/);
  assert.doesNotMatch(preview.text, /line-201/);
  assert.match(preview.text, /已截断，共 250 行，仅显示前 200 行/);
});

test('P8-3 预览：恰好 200 行不截断且正文原样', () => {
  const content = Array.from({ length: 200 }, (_unused, index) => `L${index + 1}`).join('\n') + '\n';
  const preview = previewFile({ path: 'exact.st', content });
  assert.equal(preview.totalLines, 200);
  assert.equal(preview.truncated, false);
  assert.equal(preview.text, content);
});

test('P8-3 文件大小按 UTF-8 字节计算', () => {
  assert.equal(contentBytes('abc'), 3);
  assert.equal(contentBytes('中文'), 6);
  assert.equal(countContentLines('a\nb\n'), 2);
});

test('P8-3 生成按钮：无配置、未预检、存在 error 均禁用', () => {
  assert.equal(isGenerateDisabled({ hasConfig: false, precheck: null }), true);
  assert.equal(isGenerateDisabled({ hasConfig: true, precheck: null }), true);
  assert.equal(isGenerateDisabled({
    hasConfig: true,
    precheck: { errors: [{ code: 'E', message: '错误' }], warnings: [] }
  }), true);
});

test('P8-3 生成按钮：仅 warning 时可用', () => {
  assert.equal(isGenerateDisabled({
    hasConfig: true,
    precheck: { errors: [], warnings: [{ code: 'W', message: '警告' }] }
  }), false);
});

test('P8-3 底部统计文案固定字段顺序', () => {
  assert.equal(formatStatsLine({ files: 11, tags: 32, steps: 6 }, 120.4), '11 个文件 · 变量 32 · 步序 6 · 生成 120 ms');
});

test('P8-3 问题定位：优先解析 actuators[i] 路径', () => {
  const location = locateIssue({ code: 'X', message: '点位冲突', path: 'actuators[1].extendPoint' }, makeConfig());
  assert.equal(location?.actuatorId, 'cyl-2');
  assert.equal(location?.actuatorName, '压装气缸');
  assert.equal(location?.station, '压装');
});

test('P8-3 问题定位：按问题中的点位反查执行机构', () => {
  const location = locateIssue({ code: 'DOUBLE_COIL', message: '输出点 Y2 被重复赋值' }, makeConfig());
  assert.equal(location?.actuatorId, 'cyl-2');
});

test('P8-3 复制全部：每个文件带路径分隔头', () => {
  const text = buildClipboardBundle([
    { path: 'README.md', content: '说明\n' },
    { path: 'src/OB1_Main.st', content: 'PROGRAM OB1\n' }
  ]);
  assert.match(text, /^===== README\.md =====\n说明/);
  assert.match(text, /===== src\/OB1_Main\.st =====\nPROGRAM OB1/);
});

test('P8-3 历史：同一 inputHash 去重并采用最新一条', () => {
  const first = historyEntry('aaa', '2026-10-23T10:00:00.000Z');
  const second = historyEntry('bbb', '2026-10-23T10:01:00.000Z');
  const repeated = historyEntry('aaa', '2026-10-23T10:02:00.000Z');
  const merged = mergePlcHistory(mergePlcHistory([first], second), repeated);
  assert.deepEqual(merged.map((entry) => entry.inputHash), ['aaa', 'bbb']);
  assert.equal(merged[0]?.at, '2026-10-23T10:02:00.000Z');
});

test('P8-3 历史：最多保留 10 条且新条目在前', () => {
  let history: PlcHistoryEntry[] = [];
  for (let index = 0; index < 12; index += 1) {
    history = mergePlcHistory(history, historyEntry(`hash-${index}`, `2026-10-23T10:${String(index).padStart(2, '0')}:00.000Z`));
  }
  assert.equal(history.length, 10);
  assert.equal(history[0]?.inputHash, 'hash-11');
  assert.equal(history.at(-1)?.inputHash, 'hash-2');
});

test('P8-3 历史：解析保留存储顺序并跳过损坏条目', () => {
  const parsed = parsePlcHistory([
    historyEntry('new'),
    { inputHash: '', at: '', files: 0 },
    historyEntry('old')
  ]);
  assert.deepEqual(parsed.map((entry) => entry.inputHash), ['new', 'old']);
});

test('P8-3 历史条目：文件数由文件清单得出', () => {
  const entry = createHistoryEntry({
    inputHash: 'abc',
    target: 'codesys',
    namePrefix: 'M1',
    at: '2026-10-23T10:00:00.000Z',
    files: [
      { path: 'a.st', lines: 1, bytes: 2 },
      { path: 'b.st', lines: 3, bytes: 4 }
    ]
  });
  assert.equal(entry.files, 2);
  assert.equal(entry.target, 'codesys');
});

test('P8-3 导出目录：机型净化 + yyyyMMdd-HHmm', () => {
  const plan = planPlcExportDirectory({
    exportsRoot: '/tmp/exports/plc',
    machineName: '夹爪/机台:A',
    now: new Date(2026, 9, 23, 9, 5, 12)
  });
  assert.equal(plan.name, '夹爪机台A-20261023-0905');
  assert.equal(plan.path, '/tmp/exports/plc/夹爪机台A-20261023-0905');
  assert.equal(plan.zipName, '夹爪机台A-20261023-0905.zip');
});

test('P8-3 导出目录：同名时追加 -2、-3，不覆盖', () => {
  const root = '/tmp/exports/plc';
  const existing = new Set([
    join(root, 'M1-20261023-0905'),
    join(root, 'M1-20261023-0905-2')
  ]);
  const plan = planPlcExportDirectory({
    exportsRoot: root,
    machineName: 'M1',
    now: new Date(2026, 9, 23, 9, 5),
    exists: (path) => existing.has(path)
  });
  assert.equal(plan.name, 'M1-20261023-0905-3');
});

test('P8-3 ZIP：条目结构、CRC 与 unzip -t 校验通过', () => {
  const entries = [
    { path: 'README.md', content: '说明\n' },
    { path: 'src/OB1_Main.st', content: 'PROGRAM OB1\nEND_PROGRAM\n' }
  ];
  const bytes = createZip(entries);
  const listed = listZipEntries(bytes);
  assert.deepEqual(listed.map((entry) => entry.path), ['README.md', 'src/OB1_Main.st']);
  for (const entry of entries) {
    const header = listed.find((item) => item.path === entry.path);
    assert.equal(header?.size, Buffer.byteLength(entry.content, 'utf8'));
    assert.equal(header?.crc, crc32(Buffer.from(entry.content, 'utf8')));
  }
  const zip = new AdmZip(bytes);
  assert.equal(zip.readAsText('README.md'), '说明\n');

  const directory = mkdtempSync(join(tmpdir(), 'plcgen-zip-'));
  try {
    const zipPath = join(directory, 'plc.zip');
    writeFileSync(zipPath, bytes);
    const output = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    assert.match(output, /No errors detected/i);
    assert.match(output, /README\.md/);
    assert.match(output, /src\/OB1_Main\.st/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('P8-3 ZIP：拒绝绝对路径、路径穿越与重复条目', () => {
  assert.throws(() => normalizeZipPath('/etc/passwd'), /相对路径/);
  assert.throws(() => normalizeZipPath('../outside.st'), /不合法/);
  assert.throws(() => normalizeZipPath('src/../../outside.st'), /不合法/);
  assert.throws(() => createZip([
    { path: 'a.st', content: '1' },
    { path: 'a.st', content: '2' }
  ]), /重复/);
});

test('P8-3 目标平台只改 README，不改变 ST 内容与哈希', () => {
  const generic = generateProject({ config: makeConfig(), target: 'generic', namePrefix: 'M-PREFIX' });
  const siemens = generateProject({ config: makeConfig(), target: 's7-1500', namePrefix: 'S-PREFIX' });
  assert.equal(generic.ok, true);
  assert.equal(siemens.ok, true);
  if (!generic.ok || !siemens.ok) return;

  for (const file of generic.files.filter((item) => item.path !== 'README.md')) {
    const other = siemens.files.find((item) => item.path === file.path);
    assert.equal(other?.content, file.content, `${file.path} 不应受目标平台影响`);
    assert.equal(siemens.stats.hashes[file.path], generic.stats.hashes[file.path]);
  }
  const genericReadme = generic.files.find((file) => file.path === 'README.md')?.content ?? '';
  const siemensReadme = siemens.files.find((file) => file.path === 'README.md')?.content ?? '';
  assert.match(genericReadme, /目标平台：通用 ST/);
  assert.match(genericReadme, /命名前缀：M-PREFIX/);
  assert.match(siemensReadme, /目标平台：西门子 S7-1500/);
  assert.match(siemensReadme, /命名前缀：S-PREFIX/);
});

test('P8-3 生成：预检 error 时不产生文件', () => {
  const result = generateProject({
    config: makeConfig({ safety: { emergencyStop: 'X8' }, sensors: [] })
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.length > 0);
});
