import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  REPORT_FILES,
  SOURCE_FILES,
  buildReport,
  extractKnownGaps,
  generateReport,
  loadReportSources,
  renderMarkdown,
  renderSvg,
  verifyReport
} from '../../scripts/agent-report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const FIXED_NOW = new Date('2026-10-23T15:00:00.000Z');
const TEST_COUNT = {
  value: 1042,
  source: 'desktop/test/**/*.test.*（fixture）',
  generatedAt: '2026-10-23T14:59:00.000Z',
  passed: true
};
const TMP_AUDIT = 'docs/desktop/eval/not-present-audit.jsonl';

function loadSources() {
  return loadReportSources(ROOT, { auditFile: TMP_AUDIT });
}

function build(sources = loadSources()) {
  return buildReport(sources, { now: FIXED_NOW, testCount: TEST_COUNT });
}

function clone(value) {
  return structuredClone(value);
}

test('真实源文件：总览数字来自三个评测 JSON', () => {
  const sources = loadSources();
  const report = build(sources);
  assert.equal(verifyReport(report, sources), true);
  assert.equal(report.overview.toolCount.value, 21);
  assert.equal(report.overview.toolCount.source, 'docs/desktop/eval/latest.json#dataset.toolCoverage');
  assert.equal(report.overview.singleTurn.total.value, 36);
  assert.equal(report.overview.singleTurn.matched.value, 36);
  assert.equal(report.overview.singleTurn.accuracy.value, 1);
  // 延迟与多轮计数随评测重跑变化：断言「报告等于源 json」，而不是写死某次数字
  assert.equal(report.overview.singleTurn.p50Ms.value, sources.live.data.p50Ms);
  const multi = sources.multiturn?.data ?? {};
  assert.equal(report.overview.multiTurn.total.value, multi.total);
  assert.equal(report.overview.multiTurn.passed.value, multi.passed);
  assert.equal(report.overview.multiTurn.turnPassed.value, multi.turnPassed);
  assert.equal(report.overview.offline.metrics.intent.correct.value, 106);
  assert.equal(report.overview.testCount.value, 1042);
});

test('分组表：5 组与源 byCategory 一致且总数等于单轮总数', () => {
  const sources = loadSources();
  const report = build(sources);
  assert.deepEqual(report.groups.map((group) => group.label), ['查询', '操作', '流程', '拒绝/澄清', '机型']);
  const byCategory = sources.live.data.byCategory;
  for (const group of report.groups) {
    assert.equal(group.total, byCategory[group.key].total);
    assert.equal(group.matched, byCategory[group.key].matched);
    assert.equal(group.accuracy, byCategory[group.key].matched / byCategory[group.key].total);
    assert.equal(group.p50Ms, byCategory[group.key].p50Ms);
    assert.equal(group.p95Ms, byCategory[group.key].p95Ms);
  }
  assert.equal(report.groups.reduce((sum, group) => sum + group.total, 0), report.overview.singleTurn.total.value);
});

test('数字一致性：修改源 JSON 后报告随之变化', () => {
  const sources = clone(loadSources());
  sources.live.data.total = 30;
  sources.live.data.matched = 27;
  sources.live.data.byCategory.query.matched = 7;
  sources.live.data.byCategory.query.total = 8;
  const report = build(sources);
  assert.equal(report.overview.singleTurn.matched.value, 27);
  assert.equal(report.overview.singleTurn.accuracy.value, 0.9);
  assert.equal(report.groups.find((group) => group.key === 'query').matched, 7);
  assert.equal(verifyReport(report, sources), true);
  assert.ok(renderSvg(report).includes('27/30'));
});

test('数字一致性：篡改报告数字会被 verifyReport 拒绝', () => {
  const sources = loadSources();
  const report = build(sources);
  report.overview.singleTurn.matched.value += 1;
  assert.throws(() => verifyReport(report, sources), /单轮 matched 与源数据不一致/);
});

test('缺失源：写「缺失：<文件>」且仍可生成', () => {
  const sources = clone(loadSources());
  sources.live.status = 'missing';
  sources.live.reason = '文件不存在';
  sources.live.data = null;
  const report = build(sources);
  assert.equal(report.overview.singleTurn.total.missing, true);
  assert.equal(report.overview.singleTurn.total.value, null);
  assert.ok(report.missing.some((item) => item.file === SOURCE_FILES.live));
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes(`缺失：${SOURCE_FILES.live}`));
  assert.ok(markdown.includes('缺失数据源'));
  assert.equal(verifyReport(report, sources), true);
});

test('Markdown：每个总览/分组数字都有来源文件与生成时间', () => {
  const sources = loadSources();
  const report = build(sources);
  const markdown = renderMarkdown(report);
  for (const stamp of [
    sources.live.data.finishedAt,
    sources.multiturn.data.finishedAt,
    sources.offline.data.generatedAt
  ]) {
    assert.ok(markdown.includes(stamp), `Markdown 缺少生成时间 ${stamp}`);
  }
  assert.ok(markdown.includes(SOURCE_FILES.live));
  assert.ok(markdown.includes(SOURCE_FILES.multiturn));
  assert.ok(markdown.includes(SOURCE_FILES.offline));
  assert.ok(markdown.includes('| 查询 | 8 / 8 |'));
  assert.ok(markdown.includes('| 拒绝/澄清 | 6 / 6 |'));
});

test('SVG：5 组条形图 + KPI 行全部由报告数据驱动', () => {
  const sources = clone(loadSources());
  sources.multiturn.data.passed = 4;
  sources.multiturn.data.passRate = 4 / 6;
  const report = build(sources);
  const svg = renderSvg(report);
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('fill="#0b1220"'));
  for (const label of ['查询', '操作', '流程', '拒绝/澄清', '机型']) assert.ok(svg.includes(label));
  assert.ok(svg.includes('>21<'));
  assert.ok(svg.includes('1,042'));
  assert.ok(svg.includes('36/36'));
  assert.ok(svg.includes('4/6'));
  assert.ok(svg.includes('真实模型单轮 36 条'));
  assert.ok(!svg.includes('<script'));
});

test('已知缺口：从 BACKLOG 自动摘取 Agent 相关条目', () => {
  const sources = loadSources();
  const gaps = extractKnownGaps(sources.backlog.text, {
    source: sources.backlog.file,
    generatedAt: sources.backlog.mtime
  });
  assert.ok(gaps.length >= 2);
  assert.ok(gaps.some((gap) => gap.text.includes('真实模型拒绝/澄清类')));
  assert.ok(gaps.some((gap) => gap.text.includes('离线意图路由是关键词规则')));
  assert.ok(gaps.every((gap) => gap.source === SOURCE_FILES.backlog));
  assert.ok(gaps.every((gap) => gap.generatedAt));
  assert.ok(!gaps.some((gap) => gap.text.includes('冒烟环境无 GPU')));
  assert.ok(gaps.every((gap) => Number.isInteger(gap.line) && gap.line > 0));
});

test('文件产出：md / json / svg 非空且 JSON 读回一致', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-report-test-'));
  try {
    mkdirSync(join(temp, 'docs/desktop/eval'), { recursive: true });
    for (const relative of [SOURCE_FILES.live, SOURCE_FILES.multiturn, SOURCE_FILES.offline]) {
      copyFileSync(join(ROOT, relative), join(temp, relative));
    }
    mkdirSync(join(temp, 'docs/desktop'), { recursive: true });
    copyFileSync(join(ROOT, SOURCE_FILES.backlog), join(temp, SOURCE_FILES.backlog));
    mkdirSync(join(temp, 'desktop/src/agent'), { recursive: true });
    copyFileSync(join(ROOT, SOURCE_FILES.tools), join(temp, SOURCE_FILES.tools));
    mkdirSync(join(temp, 'desktop/electron'), { recursive: true });
    copyFileSync(join(ROOT, SOURCE_FILES.main), join(temp, SOURCE_FILES.main));
    const emptyUserData = join(temp, 'userData');
    mkdirSync(emptyUserData);
    const result = generateReport({
      root: temp,
      now: FIXED_NOW,
      testCount: TEST_COUNT,
      userDataDir: emptyUserData
    });
    for (const relative of Object.values(REPORT_FILES)) {
      const absolute = join(temp, relative);
      assert.ok(existsSync(absolute), `缺少输出 ${relative}`);
      assert.ok(statSync(absolute).size > 0, `输出为空 ${relative}`);
    }
    const json = JSON.parse(readFileSync(join(temp, REPORT_FILES.json), 'utf8'));
    assert.deepEqual(json, result.report);
    assert.ok(readFileSync(join(temp, REPORT_FILES.md), 'utf8').includes('Agent 能力报告'));
    assert.ok(readFileSync(join(temp, REPORT_FILES.svg), 'utf8').includes('分组准确率'));
    assert.ok(result.report.missing.some((item) => item.file.endsWith('agent-audit.jsonl')));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('缺失源 CLI：打印 WARN、报告写「缺失」且退出码为 0', () => {
  const temp = mkdtempSync(join(tmpdir(), 'agent-report-missing-'));
  try {
    const script = join(ROOT, 'desktop/scripts/agent-report.mjs');
    const result = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        AGENT_REPORT_ROOT: temp,
        AGENT_REPORT_USER_DATA: join(temp, 'userData')
      }
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.status, 0, output);
    assert.ok(output.includes('WARN 缺失：docs/desktop/eval/agent-live.json'), output);
    assert.ok(output.includes('AGENT_REPORT_EXIT_OK_WITH_MISSING'), output);
    for (const relative of Object.values(REPORT_FILES)) {
      const absolute = join(temp, relative);
      assert.ok(existsSync(absolute), `缺少输出 ${relative}`);
      assert.ok(statSync(absolute).size > 0, `输出为空 ${relative}`);
    }
    const markdown = readFileSync(join(temp, REPORT_FILES.md), 'utf8');
    assert.ok(markdown.includes('缺失：docs/desktop/eval/agent-live.json'));
    const svg = readFileSync(join(temp, REPORT_FILES.svg), 'utf8');
    assert.ok(svg.includes('缺失'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
