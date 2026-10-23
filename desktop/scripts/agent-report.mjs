#!/usr/bin/env node
/**
 * Agent 运行报告生成器（给老王汇报用）
 *
 * 读取：
 *   docs/desktop/eval/agent-live.json       真实模型单轮评测（36 条）
 *   docs/desktop/eval/agent-multiturn.json  真实模型多轮评测（6 个场景）
 *   docs/desktop/eval/latest.json           离线规则评测（61 条）
 *   <userData>/agent-audit.jsonl            审计（存在才读）
 *   docs/desktop/BACKLOG.md                 已知限制/问题摘录
 *   desktop/src/agent/tools.ts              工具注册表
 *
 * 输出：
 *   docs/desktop/AGENT-REPORT.md
 *   docs/desktop/agent-report.json
 *   docs/desktop/agent-report.svg
 *
 * 缺源文件不编造：报告写「缺失：<文件>」，打印 WARN，退出码仍为 0。
 * 生成后会把 json 读回、与内存对象逐字段比对，并校验所有指标与源 json 一致。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(DESKTOP_ROOT, '..');

export const REPORT_FILES = {
  md: 'docs/desktop/AGENT-REPORT.md',
  json: 'docs/desktop/agent-report.json',
  svg: 'docs/desktop/agent-report.svg'
};

export const SOURCE_FILES = {
  live: 'docs/desktop/eval/agent-live.json',
  multiturn: 'docs/desktop/eval/agent-multiturn.json',
  offline: 'docs/desktop/eval/latest.json',
  backlog: 'docs/desktop/BACKLOG.md',
  tools: 'desktop/src/agent/tools.ts',
  main: 'desktop/electron/main.ts'
};

const GROUP_LABELS = {
  query: '查询',
  operation: '操作',
  workflow: '流程',
  refusal: '拒绝/澄清',
  machine: '机型'
};
const GROUP_ORDER = ['query', 'operation', 'workflow', 'refusal', 'machine'];

const CAPABILITY_TOOLS = [
  {
    id: 'list_components',
    capability: '列出元件（按类别 / 数据包）',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'search_components',
    capability: '按型号 / 品牌 / 类别搜索元件',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'search_docs',
    capability: '本地知识检索（离线 RAG）',
    module: 'desktop/src/agent/kb/search.ts',
    unit: 'desktop/test/agent/kb.test.mjs',
    smoke: 'SMOKE_AGENT_KB_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'design_machine',
    capability: '自然语言机型方案合成',
    module: 'desktop/src/machine/synth.ts',
    unit: 'desktop/test/agent/design-machine.test.mjs',
    smoke: 'SMOKE_MACHINE_DESIGN_OK',
    eval: '离线评估'
  },
  {
    id: 'apply_machine_design',
    capability: '机型方案落盘（3D / BOM / PLC 联动，可撤销）',
    module: 'desktop/src/machine/store.ts',
    unit: 'desktop/test/agent/apply-machine-design.test.mjs',
    smoke: 'SMOKE_MACHINE_APPLY_OK',
    eval: '离线评估'
  },
  {
    id: 'import_cad',
    capability: '导入 CAD 文件',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools-v2.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_V2',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'get_bom',
    capability: '读取当前装配体 BOM',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'get_project_context',
    capability: '工程上下文快照',
    module: 'desktop/src/agent/context.ts',
    unit: 'desktop/test/agent/context-memory-trim.test.mjs',
    smoke: 'SMOKE_AGENT_CONTEXT_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'run_interference_check',
    capability: '包围盒干涉初筛',
    module: 'desktop/src/mech/interference.ts',
    unit: 'desktop/test/mech/interference.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'insert_component',
    capability: '插入标准件占位件',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'place_component',
    capability: '底板放置（坐标 / 旋转 / 导轨吸附）',
    module: 'desktop/src/agent/placement.ts',
    unit: 'desktop/test/agent/place-component.test.mjs',
    smoke: 'SMOKE_AGENT_PLACE_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'update_component',
    capability: '修改型号 / 数量 / 备注',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools-v2.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_V2',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'remove_component',
    capability: '移除底板 / BOM 元件',
    module: 'desktop/src/agent/tools.ts',
    unit: 'desktop/test/agent/tools-v2.test.mjs',
    smoke: 'SMOKE_AGENT_TOOLS_V2',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'run_electrical_check',
    capability: '电气校验（线号 / 载流 / 断路器）',
    module: 'desktop/src/elec/check.ts',
    unit: 'desktop/test/agent/elec-check.test.mjs',
    smoke: 'SMOKE_ELEC_CHECK_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'run_cost_report',
    capability: '硬件成本统计',
    module: 'desktop/src/cost/agent.ts',
    unit: 'desktop/test/cost-agent.test.ts',
    smoke: 'SMOKE_COST_AGENT_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'export_cost_report',
    capability: '成本报告落盘（PDF / CSV）',
    module: 'desktop/src/cost/export.ts',
    unit: 'desktop/test/cost-export.test.ts',
    smoke: 'SMOKE_COST_AGENT_EXPORT_OK',
    eval: '单轮真实模型'
  },
  {
    id: 'verify_plc_program',
    capability: 'PLC 程序模拟验证',
    module: 'desktop/src/plcgen/verify.ts',
    unit: 'desktop/test/plcgen.test.ts',
    smoke: 'SMOKE_PLCGEN_SIM_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'run_plc_generate',
    capability: 'PLC 工程生成（11 文件 + ZIP）',
    module: 'desktop/src/plcgen/generate.ts',
    unit: 'desktop/test/plcgen.test.ts',
    smoke: 'SMOKE_PLCGEN_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'export_files',
    capability: '装配体导出（PDF / DXF / GLB / BOM）',
    module: 'desktop/src/export/file.ts',
    unit: 'desktop/test/agent/tools-v2.test.mjs',
    smoke: 'SMOKE_EXPORT_OK',
    eval: '离线评估 + 单轮真实模型'
  },
  {
    id: 'undo_last',
    capability: '撤销最近一次写操作',
    module: 'desktop/src/agent/commands.ts',
    unit: 'desktop/test/agent/place-component.test.mjs',
    smoke: 'SMOKE_AGENT_PLACE_OK',
    eval: '离线评估 + 单轮真实模型'
  }
];

const CAPABILITY_PLATFORM = [
  {
    id: 'offline-router',
    capability: '离线意图路由（7 类意图）',
    module: 'desktop/src/agent/router.ts',
    unit: 'desktop/test/agent/nl-router.test.mjs',
    smoke: 'SMOKE_AGENT_NL_OK',
    eval: '离线评估'
  },
  {
    id: 'planner',
    capability: '多步规划与执行',
    module: 'desktop/src/agent/planner.ts',
    unit: 'desktop/test/agent/planner.test.mjs',
    smoke: 'SMOKE_AGENT_PLAN_OK',
    eval: '离线评估'
  },
  {
    id: 'multi-turn',
    capability: '多轮状态 / 续跑 / 拒绝记忆',
    module: 'desktop/src/agent/thread.ts + session.ts',
    unit: 'desktop/test/agent/thread.test.mjs',
    smoke: 'SMOKE_AGENT_THREAD_OK',
    eval: '多轮真实模型'
  },
  {
    id: 'security-policy',
    capability: '写确认 / 路径策略 / 绕过拦截',
    module: 'desktop/src/agent/policy.ts + session.ts',
    unit: 'desktop/test/agent/policy.test.mjs',
    smoke: 'SMOKE_AGENT_POLICY_OK',
    eval: '单轮真实模型'
  },
  {
    id: 'guard',
    capability: '工具结果抗提示注入',
    module: 'desktop/src/agent/guard.ts',
    unit: 'desktop/test/agent/guard.test.mjs',
    smoke: '—',
    eval: '—'
  },
  {
    id: 'audit',
    capability: '工具审计（NDJSON / 脱敏）',
    module: 'desktop/src/agent/audit.ts + electron/ipc.ts',
    unit: 'desktop/test/agent/ux.test.mjs',
    smoke: 'SMOKE_AGENT_UX_OK',
    eval: '审计文件'
  },
  {
    id: 'budget',
    capability: '上下文预算与 token 成本',
    module: 'desktop/src/agent/budget.ts + pricing.ts',
    unit: 'desktop/test/agent/budget.test.mjs',
    smoke: 'SMOKE_AGENT_BUDGET_OK',
    eval: '—'
  },
  {
    id: 'efficiency',
    capability: '同轮去重 / 只读并行 / 会话缓存',
    module: 'desktop/src/agent/dedupe.ts + parallel.ts + cache.ts',
    unit: 'desktop/test/agent/efficiency.test.mjs',
    smoke: 'SMOKE_AGENT_EFFICIENCY_OK',
    eval: '—'
  },
  {
    id: 'recipes',
    capability: '可复用流程模板',
    module: 'desktop/src/agent/recipes.ts',
    unit: 'desktop/test/agent/recipes.test.mjs',
    smoke: 'SMOKE_AGENT_RECIPE_OK',
    eval: '—'
  },
  {
    id: 'advisor',
    capability: '主动建议（next-best-action）',
    module: 'desktop/src/agent/advisor.ts',
    unit: 'desktop/test/agent/advisor.test.mjs',
    smoke: 'SMOKE_AGENT_ADVISOR_OK',
    eval: '—'
  },
  {
    id: 'repair',
    capability: '工具调用纠错与重试',
    module: 'desktop/src/agent/repair.ts + retry.ts',
    unit: 'desktop/test/agent/repair.test.mjs',
    smoke: 'SMOKE_AGENT_REPAIR_OK',
    eval: '—'
  },
  {
    id: 'live-eval',
    capability: '真实模型单轮评测',
    module: 'desktop/scripts/agent-live.mjs',
    unit: '—',
    smoke: '—',
    eval: '单轮真实模型'
  },
  {
    id: 'multiturn-eval',
    capability: '真实模型多轮评测',
    module: 'desktop/scripts/agent-multiturn.mjs',
    unit: '—',
    smoke: '—',
    eval: '多轮真实模型'
  }
];

function nowIso(value) {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayPath(root, absolute) {
  return relative(root, absolute).replaceAll('\\', '/');
}

export function metric(value, source, generatedAt, missing = false) {
  return {
    value: missing ? null : value,
    source,
    generatedAt: missing ? null : generatedAt,
    missing
  };
}

export function missingMetric(source) {
  return metric(null, `缺失：${source}`, null, true);
}

function sourceStamp(source, root) {
  if (!source || source.status !== 'ok' || !source.data) return null;
  return source.data.finishedAt ?? source.data.generatedAt ?? source.mtime ?? null;
}

function readSource(root, file, kind) {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    return { file, absolute, status: 'missing', reason: '文件不存在', data: null, text: null };
  }
  try {
    const stat = statSync(absolute);
    if (kind === 'text') {
      return { file, absolute, status: 'ok', data: null, text: readFileSync(absolute, 'utf8'), mtime: stat.mtime.toISOString() };
    }
    const data = JSON.parse(readFileSync(absolute, 'utf8'));
    return { file, absolute, status: 'ok', data, text: null, mtime: stat.mtime.toISOString() };
  } catch (error) {
    return {
      file,
      absolute,
      status: 'missing',
      reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      data: null,
      text: null
    };
  }
}

function defaultUserDataDir() {
  if (process.env.AGENT_REPORT_USER_DATA) return resolve(process.env.AGENT_REPORT_USER_DATA);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'AutomationCAD');
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'AutomationCAD');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'AutomationCAD');
}

function resolveAuditSource(root, options = {}) {
  if (options.auditFile) {
    return readSource(root, options.auditFile, 'text');
  }
  const userDataDir = options.userDataDir ?? defaultUserDataDir();
  let accessible = false;
  try {
    accessible = existsSync(userDataDir) && statSync(userDataDir).isDirectory();
  } catch {
    accessible = false;
  }
  if (!accessible) {
    return {
      file: join(userDataDir, 'agent-audit.jsonl'),
      absolute: join(userDataDir, 'agent-audit.jsonl'),
      status: 'unreachable',
      reason: `userData 路径不可达：${userDataDir}`,
      data: null,
      text: null,
      userDataDir
    };
  }
  const file = join(userDataDir, 'agent-audit.jsonl');
  if (!existsSync(file)) {
    return {
      file,
      absolute: file,
      status: 'missing',
      reason: `userData 路径可访问，但审计文件不存在：${file}`,
      data: null,
      text: null,
      userDataDir
    };
  }
  const loaded = readSource(root, file, 'text');
  return { ...loaded, userDataDir };
}

export function extractToolNames(toolsText) {
  if (typeof toolsText !== 'string' || !toolsText) return [];
  const start = toolsText.indexOf('registerDefaults');
  const scope = start >= 0 ? toolsText.slice(start) : toolsText;
  const names = [];
  const seen = new Set();
  for (const match of scope.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)'/g)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function parseAuditText(text) {
  const entries = [];
  const malformed = [];
  for (const [index, line] of String(text ?? '').split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object' && typeof entry.tool === 'string' && typeof entry.at === 'string') {
        entries.push(entry);
      } else {
        malformed.push(index + 1);
      }
    } catch {
      malformed.push(index + 1);
    }
  }
  const tools = {};
  let failed = 0;
  let lastAt = null;
  for (const entry of entries) {
    tools[entry.tool] = (tools[entry.tool] ?? 0) + 1;
    if (entry.ok === false) failed += 1;
    if (!lastAt || entry.at > lastAt) lastAt = entry.at;
  }
  return { total: entries.length, failed, tools, lastAt, malformed };
}

function relativeUserDataLabel(file, root) {
  const absolute = resolve(file);
  return absolute.startsWith(root) ? displayPath(root, absolute) : absolute;
}

export function loadReportSources(root = REPO_ROOT, options = {}) {
  const live = readSource(root, SOURCE_FILES.live, 'json');
  const multiturn = readSource(root, SOURCE_FILES.multiturn, 'json');
  const offline = readSource(root, SOURCE_FILES.offline, 'json');
  const backlog = readSource(root, SOURCE_FILES.backlog, 'text');
  const tools = readSource(root, SOURCE_FILES.tools, 'text');
  const main = readSource(root, SOURCE_FILES.main, 'text');
  const audit = resolveAuditSource(root, options);
  for (const source of [live, multiturn, offline, backlog, tools, main, audit]) {
    if (!source) continue;
    source.displayFile = source.file === audit.file && source.status !== 'ok'
      ? relativeUserDataLabel(source.file, root)
      : source.file;
  }
  return { root, live, multiturn, offline, backlog, tools, main, audit };
}

function scanTestFiles(directory) {
  let count = 0;
  if (!existsSync(directory)) return count;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      count += scanTestFiles(absolute);
      continue;
    }
    if (!/\.test\.(mjs|js|cjs|ts)$/.test(entry.name)) continue;
    const text = readFileSync(absolute, 'utf8');
    const matches = text.match(/^\s*test(?:\.(?:skip|todo|only))?\s*\(/gm);
    count += matches?.length ?? 0;
  }
  return count;
}

export function measureTestCount(options = {}) {
  const generatedAt = new Date().toISOString();
  if (options.testCount !== undefined) {
    return {
      value: options.testCount,
      source: options.testCountSource ?? '调用方提供',
      generatedAt,
      passed: options.testPassed ?? null
    };
  }
  const cwd = options.cwd ?? DESKTOP_ROOT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const matches = [...output.matchAll(/^# tests (\d+)$/gm)];
  if (matches.length > 0) {
    return {
      value: Number(matches.at(-1)[1]),
      source: 'desktop/test/**/*.test.*（`node --test` 实测）',
      generatedAt,
      passed: result.status === 0
    };
  }
  const testDirectory = join(cwd, 'test');
  if (!existsSync(testDirectory)) {
    return {
      value: null,
      source: `缺失：${displayPath(cwd, testDirectory)}`,
      generatedAt: null,
      passed: false,
      note: (result.error?.message ?? '测试目录不存在').slice(0, 300)
    };
  }
  return {
    value: scanTestFiles(testDirectory),
    source: 'desktop/test/**/*.test.*（静态扫描；`node --test` 输出不可用）',
    generatedAt,
    passed: false,
    note: (result.error?.message ?? '未能从 node --test 输出中读到测试数').slice(0, 300)
  };
}

function rate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function buildLiveReport(sources) {
  const source = sources.live;
  const file = source.file;
  const generatedAt = sourceStamp(source, sources.root);
  if (source.status !== 'ok' || !isPlainObject(source.data)) {
    return {
      total: missingMetric(file),
      matched: missingMetric(file),
      accuracy: missingMetric(file),
      toolAccuracy: missingMetric(file),
      confirmRate: missingMetric(file),
      clarifyRate: missingMetric(file),
      refusalRate: missingMetric(file),
      p50Ms: missingMetric(file),
      p95Ms: missingMetric(file)
    };
  }
  const data = source.data;
  return {
    total: metric(Number(data.total), file, generatedAt),
    matched: metric(Number(data.matched), file, generatedAt),
    accuracy: metric(rate(Number(data.matched), Number(data.total)), file, generatedAt),
    toolAccuracy: metric(data.toolAccuracy === undefined ? null : Number(data.toolAccuracy), file, generatedAt),
    confirmRate: metric(data.confirmRate === undefined ? null : Number(data.confirmRate), file, generatedAt),
    clarifyRate: metric(data.clarifyRate === undefined ? null : Number(data.clarifyRate), file, generatedAt),
    refusalRate: metric(data.refusalRate === undefined ? null : Number(data.refusalRate), file, generatedAt),
    p50Ms: metric(Number(data.p50Ms), file, generatedAt),
    p95Ms: metric(Number(data.p95Ms), file, generatedAt)
  };
}

function buildMultiTurnReport(sources) {
  const source = sources.multiturn;
  const file = source.file;
  const generatedAt = sourceStamp(source, sources.root);
  if (source.status !== 'ok' || !isPlainObject(source.data)) {
    return {
      total: missingMetric(file),
      passed: missingMetric(file),
      accuracy: missingMetric(file),
      turnTotal: missingMetric(file),
      turnPassed: missingMetric(file),
      p50Ms: missingMetric(file),
      p95Ms: missingMetric(file),
      threshold: missingMetric(file),
      gate: missingMetric(file)
    };
  }
  const data = source.data;
  return {
    total: metric(Number(data.total), file, generatedAt),
    passed: metric(Number(data.passed), file, generatedAt),
    accuracy: metric(Number(data.passRate), file, generatedAt, data.passRate === undefined),
    turnTotal: metric(Number(data.turnTotal), file, generatedAt),
    turnPassed: metric(Number(data.turnPassed), file, generatedAt),
    p50Ms: metric(Number(data.p50Ms), file, generatedAt),
    p95Ms: metric(Number(data.p95Ms), file, generatedAt),
    threshold: metric(Number(data.threshold), file, generatedAt),
    gate: metric(data.gate === true ? 1 : 0, file, generatedAt)
  };
}

function buildOfflineReport(sources) {
  const source = sources.offline;
  const file = source.file;
  const generatedAt = sourceStamp(source, sources.root);
  if (source.status !== 'ok' || !isPlainObject(source.data)) {
    return {
      total: missingMetric(file),
      passed: missingMetric(file),
      metrics: {}
    };
  }
  const data = source.data;
  const metrics = {};
  for (const [key, value] of Object.entries(data.metrics ?? {})) {
    metrics[key] = {
      correct: metric(Number(value.correct), file, generatedAt),
      total: metric(Number(value.total), file, generatedAt),
      rate: metric(Number(value.rate), file, generatedAt)
    };
  }
  return {
    total: metric(Number(data.dataset?.count ?? data.metrics?.intent?.total), file, generatedAt),
    passed: metric(data.passed === true ? 1 : 0, file, generatedAt),
    metrics
  };
}

function buildGroups(sources) {
  const source = sources.live;
  const file = source.file;
  const generatedAt = sourceStamp(source, sources.root);
  const byCategory = source.status === 'ok' && isPlainObject(source.data) ? source.data.byCategory : null;
  return GROUP_ORDER.map((key) => {
    const category = byCategory && isPlainObject(byCategory[key]) ? byCategory[key] : null;
    if (!category) {
      return {
        key,
        label: GROUP_LABELS[key],
        total: null,
        matched: null,
        accuracy: null,
        p50Ms: null,
        p95Ms: null,
        refusalRate: null,
        source: `缺失：${file}`,
        generatedAt: null,
        missing: true
      };
    }
    return {
      key,
      label: GROUP_LABELS[key],
      total: Number(category.total),
      matched: Number(category.matched),
      accuracy: rate(Number(category.matched), Number(category.total)),
      p50Ms: Number(category.p50Ms),
      p95Ms: Number(category.p95Ms),
      refusalRate: category.refusalRate === undefined ? null : Number(category.refusalRate),
      source: file,
      generatedAt,
      missing: false
    };
  });
}

function toolCoverage(sources) {
  const offline = sources.offline;
  const registryNames = extractToolNames(sources.tools.status === 'ok' ? sources.tools.text : '');
  if (offline.status === 'ok' && Array.isArray(offline.data?.dataset?.toolCoverage)) {
    return {
      names: offline.data.dataset.toolCoverage.map(String),
      registryNames,
      count: offline.data.dataset.toolCoverage.length,
      source: `${offline.file}#dataset.toolCoverage`,
      generatedAt: sourceStamp(offline, sources.root)
    };
  }
  return {
    names: registryNames,
    registryNames,
    count: registryNames.length,
    source: SOURCE_FILES.tools,
    generatedAt: sources.tools.status === 'ok' ? sources.tools.mtime : null
  };
}

function statusForCapability(row, sources, coverage, context) {
  const unitExists = row.unit !== '—' && existsSync(resolve(sources.root, row.unit));
  const smokeExists = row.smoke !== '—' && sources.main.status === 'ok' && sources.main.text.includes(row.smoke);
  const evalExpected = row.eval !== '—';
  const evalReady = !evalExpected
    || (row.eval.includes('离线') && sources.offline.status === 'ok')
    || (row.eval.includes('单轮') && sources.live.status === 'ok')
    || (row.eval.includes('多轮') && sources.multiturn.status === 'ok')
    || (row.eval.includes('审计') && sources.audit.status === 'ok');
  const covered = coverage.names.includes(row.id);
  if (row.id === 'multi-turn' && context.multiTurn?.total?.value && context.multiTurn.passed?.value !== undefined) {
    const passed = context.multiTurn.passed.value;
    const total = context.multiTurn.total.value;
    if (passed < total) return `⚠️ 达阈值但有失败场景（${passed}/${total}）`;
  }
  if (row.id === 'live-eval' && context.live?.total?.value) {
    return context.live.matched.value === context.live.total.value
      ? `✅ ${context.live.matched.value}/${context.live.total.value}`
      : `⚠️ ${context.live.matched.value}/${context.live.total.value}`;
  }
  if (row.id === 'multiturn-eval' && context.multiTurn?.total?.value) {
    return context.multiTurn.passed.value === context.multiTurn.total.value
      ? `✅ ${context.multiTurn.passed.value}/${context.multiTurn.total.value}`
      : `⚠️ ${context.multiTurn.passed.value}/${context.multiTurn.total.value}`;
  }
  const evidenceCount = Number(unitExists) + Number(smokeExists) + Number(evalReady);
  if (row.eval.includes('离线') && sources.offline.status !== 'ok') return '⚠️ 数据缺失';
  if (row.eval.includes('单轮') && sources.live.status !== 'ok') return '⚠️ 数据缺失';
  if (row.eval.includes('多轮') && sources.multiturn.status !== 'ok') return '⚠️ 数据缺失';
  const isTool = CAPABILITY_TOOLS.some((item) => item.id === row.id);
  if (isTool && !covered) return '⚠️ 评测未覆盖';
  if (evidenceCount >= 2) return '✅ 已实现';
  if (evidenceCount === 1) return '⚠️ 部分验证';
  return '⚠️ 未验证';
}

function buildCapabilities(sources, coverage, context) {
  const rows = [...CAPABILITY_TOOLS, ...CAPABILITY_PLATFORM];
  return rows.map((row) => {
    const verification = [];
    if (row.unit !== '—') verification.push(`单测 ${row.unit.replace('desktop/test/', '')}`);
    if (row.smoke !== '—') verification.push(`smoke ${row.smoke}`);
    if (row.eval !== '—') verification.push(`eval ${row.eval}`);
    return {
      id: row.id,
      capability: row.capability,
      module: row.module,
      verification,
      status: statusForCapability(row, sources, coverage, context),
      tools: CAPABILITY_TOOLS.some((tool) => tool.id === row.id) ? [row.id] : []
    };
  });
}

const AGENT_GAP_PATTERN = /Agent|智能体|模型|拒绝|澄清|意图|离线|审计|MCP|JSON-RPC|评测|工具|确认|token|prompt/i;

function cleanGapText(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function extractKnownGaps(backlogText, options = {}) {
  const source = options.source ?? SOURCE_FILES.backlog;
  const generatedAt = options.generatedAt ?? null;
  const lines = String(backlogText ?? '').split(/\r?\n/);
  const gaps = [];
  let section = '';
  let inKnownIssues = false;
  let current = null;

  const push = (text, line) => {
    const cleaned = cleanGapText(text);
    if (!cleaned || !AGENT_GAP_PATTERN.test(cleaned)) return;
    gaps.push({
      text: cleaned,
      section,
      line,
      source,
      generatedAt
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#{2,6}\s+(.*)$/);
    if (heading) {
      section = heading[1].trim();
      inKnownIssues = /已知(限制|问题)/.test(section);
      current = null;
      continue;
    }

    const explicitLimit = line.match(/^\s*[-*]?\s*(?:已知限制|限制)[:：]\s*(.+)$/);
    if (explicitLimit) {
      push(explicitLimit[1], index + 1);
      current = null;
      continue;
    }

    if (inKnownIssues) {
      const item = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (item) {
        current = { line: index + 1, text: item[2] };
        push(current.text, current.line);
        continue;
      }
      if (current && /^\s{2,}\S/.test(line)) {
        current.text = `${current.text} ${line.trim()}`;
        const last = gaps.at(-1);
        if (last && last.line === current.line) last.text = cleanGapText(current.text);
      }
    }
  }

  const seen = new Set();
  return gaps.filter((gap) => {
    const key = `${gap.line}:${gap.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function auditReport(sources) {
  const source = sources.audit;
  if (source.status === 'ok') {
    const parsed = parseAuditText(source.text);
    return {
      status: 'ok',
      file: relativeUserDataLabel(source.file, sources.root),
      reason: null,
      total: parsed.total,
      failed: parsed.failed,
      tools: parsed.tools,
      malformed: parsed.malformed,
      lastAt: parsed.lastAt,
      generatedAt: parsed.lastAt ?? source.mtime ?? null
    };
  }
  return {
    status: source.status,
    file: relativeUserDataLabel(source.file, sources.root),
    reason: source.reason ?? '审计文件不可读',
    total: null,
    failed: null,
    tools: {},
    malformed: [],
    lastAt: null,
    generatedAt: null
  };
}

function buildMultiturnScenarios(sources) {
  const source = sources.multiturn;
  if (source.status !== 'ok' || !Array.isArray(source.data?.scenarios)) return [];
  return source.data.scenarios.map((scenario) => ({
    id: String(scenario.id ?? ''),
    title: String(scenario.title ?? ''),
    passed: scenario.passed === true,
    turns: Array.isArray(scenario.turns) ? scenario.turns.length : 0,
    passedTurns: Array.isArray(scenario.turns) ? scenario.turns.filter((turn) => turn.matched === true).length : 0
  }));
}

export function buildReport(sources, options = {}) {
  const now = options.now ?? new Date();
  const generatedAt = new Date(now).toISOString();
  const coverage = toolCoverage(sources);
  const live = buildLiveReport(sources);
  const multiTurn = buildMultiTurnReport(sources);
  const offline = buildOfflineReport(sources);
  const groups = buildGroups(sources);
  const testCount = options.testCount ?? measureTestCount();
  const audit = auditReport(sources);
  const gaps = sources.backlog.status === 'ok'
    ? extractKnownGaps(sources.backlog.text, {
        source: sources.backlog.file,
        generatedAt: sources.backlog.mtime
      })
    : [];
  const missing = [];
  for (const source of [sources.live, sources.multiturn, sources.offline]) {
    if (source.status !== 'ok') missing.push({ file: source.file, reason: source.reason ?? '文件不存在' });
  }
  if (sources.audit.status !== 'ok') {
    missing.push({ file: audit.file, reason: audit.reason });
  }
  const capabilities = buildCapabilities(sources, coverage, { live, multiTurn });

  const report = {
    schemaVersion: 1,
    generatedAt,
    generator: 'desktop/scripts/agent-report.mjs',
    sources: {
      live: {
        file: sources.live.file,
        status: sources.live.status,
        generatedAt: sourceStamp(sources.live, sources.root),
        mode: sources.live.data?.mode ?? null,
        model: sources.live.data?.model ?? null
      },
      multiturn: {
        file: sources.multiturn.file,
        status: sources.multiturn.status,
        generatedAt: sourceStamp(sources.multiturn, sources.root),
        mode: sources.multiturn.data?.mode ?? null,
        model: sources.multiturn.data?.model ?? null
      },
      offline: {
        file: sources.offline.file,
        status: sources.offline.status,
        generatedAt: sourceStamp(sources.offline, sources.root),
        version: sources.offline.data?.version ?? null,
        mode: sources.offline.data?.mode ?? null
      },
      audit: {
        file: audit.file,
        status: audit.status,
        generatedAt: audit.generatedAt
      },
      backlog: {
        file: sources.backlog.file,
        status: sources.backlog.status,
        generatedAt: sources.backlog.mtime ?? null
      },
      tools: {
        file: SOURCE_FILES.tools,
        status: sources.tools.status,
        registryCount: coverage.registryNames.length,
        coverageCount: coverage.count,
        consistent: coverage.registryNames.length === coverage.count
      }
    },
    overview: {
      toolCount: metric(coverage.count, coverage.source, coverage.generatedAt, coverage.count === 0),
      testCount: metric(testCount.value, testCount.source, testCount.generatedAt, !Number.isFinite(testCount.value)),
      testPassed: testCount.passed,
      singleTurn: live,
      multiTurn,
      offline
    },
    groups,
    multiturnScenarios: buildMultiturnScenarios(sources),
    multiturnFailures: Array.isArray(sources.multiturn.data?.failures) ? sources.multiturn.data.failures : [],
    capabilities,
    knownGaps: gaps,
    audit,
    missing
  };
  return report;
}

function walkMetricObjects(node, visitor, path = '') {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walkMetricObjects(value, visitor, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(node)) return;
  if (Object.prototype.hasOwnProperty.call(node, 'value') && Object.prototype.hasOwnProperty.call(node, 'source')) {
    visitor(node, path);
    return;
  }
  for (const [key, value] of Object.entries(node)) walkMetricObjects(value, visitor, path ? `${path}.${key}` : key);
}

function assertMetric(actual, expected, label) {
  assert.ok(actual && typeof actual === 'object', `${label} 缺少指标对象`);
  assert.equal(actual.missing, false, `${label} 被标记为缺失`);
  if (expected === null || expected === undefined) {
    assert.equal(actual.value, null, `${label} 应为 null`);
    return;
  }
  if (typeof expected === 'number' && Number.isNaN(expected)) {
    assert.equal(actual.value, null, `${label} 应为 null`);
    return;
  }
  assert.equal(actual.value, expected, `${label} 与源数据不一致：${actual.value} != ${expected}`);
  assert.ok(actual.source && !actual.source.startsWith('缺失：'), `${label} 缺少来源`);
  assert.ok(actual.generatedAt, `${label} 缺少生成时间`);
}

export function verifyReport(report, sources) {
  if (sources.live.status === 'ok') {
    const data = sources.live.data;
    assertMetric(report.overview.singleTurn.total, Number(data.total), '单轮 total');
    assertMetric(report.overview.singleTurn.matched, Number(data.matched), '单轮 matched');
    assertMetric(report.overview.singleTurn.accuracy, rate(Number(data.matched), Number(data.total)), '单轮 accuracy');
    assertMetric(report.overview.singleTurn.p50Ms, Number(data.p50Ms), '单轮 p50');
    assertMetric(report.overview.singleTurn.p95Ms, Number(data.p95Ms), '单轮 p95');
    for (const group of report.groups) {
      const source = data.byCategory?.[group.key];
      if (!source) continue;
      assert.equal(group.total, Number(source.total), `${group.key} total 与源数据不一致`);
      assert.equal(group.matched, Number(source.matched), `${group.key} matched 与源数据不一致`);
      assert.equal(group.accuracy, rate(Number(source.matched), Number(source.total)), `${group.key} accuracy 与源数据不一致`);
      assert.equal(group.p50Ms, Number(source.p50Ms), `${group.key} p50 与源数据不一致`);
      assert.equal(group.p95Ms, Number(source.p95Ms), `${group.key} p95 与源数据不一致`);
      assert.equal(group.source, sources.live.file, `${group.key} 来源不一致`);
      assert.equal(group.generatedAt, sourceStamp(sources.live, sources.root), `${group.key} 生成时间不一致`);
    }
  }
  if (sources.multiturn.status === 'ok') {
    const data = sources.multiturn.data;
    assertMetric(report.overview.multiTurn.total, Number(data.total), '多轮 total');
    assertMetric(report.overview.multiTurn.passed, Number(data.passed), '多轮 passed');
    assertMetric(report.overview.multiTurn.accuracy, Number(data.passRate), '多轮 accuracy');
    assertMetric(report.overview.multiTurn.turnTotal, Number(data.turnTotal), '多轮 turnTotal');
    assertMetric(report.overview.multiTurn.turnPassed, Number(data.turnPassed), '多轮 turnPassed');
    assertMetric(report.overview.multiTurn.p50Ms, Number(data.p50Ms), '多轮 p50');
    assertMetric(report.overview.multiTurn.p95Ms, Number(data.p95Ms), '多轮 p95');
  }
  if (sources.offline.status === 'ok') {
    const data = sources.offline.data;
    assertMetric(report.overview.offline.total, Number(data.dataset?.count ?? data.metrics?.intent?.total), '离线 total');
    for (const [key, value] of Object.entries(data.metrics ?? {})) {
      const metricGroup = report.overview.offline.metrics[key];
      assert.ok(metricGroup, `离线指标 ${key} 缺失`);
      assertMetric(metricGroup.correct, Number(value.correct), `离线 ${key} correct`);
      assertMetric(metricGroup.total, Number(value.total), `离线 ${key} total`);
      assertMetric(metricGroup.rate, Number(value.rate), `离线 ${key} rate`);
    }
  }
  walkMetricObjects(report.overview, (node, path) => {
    assert.ok(typeof node.source === 'string' && node.source.length > 0, `${path} 缺少来源`);
    if (!node.missing) assert.ok(node.generatedAt, `${path} 缺少生成时间`);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, '报告 JSON 读回不一致');
  return true;
}

function fmtInt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '缺失';
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '缺失';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function fmtMs(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '缺失';
  return `${fmtInt(value)} ms`;
}

function cell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function mdMetricRow(label, value, metricSource, generatedAt, extra = '') {
  return `| ${cell(label)} | ${cell(value)}${extra ? ` ${cell(extra)}` : ''} | ${cell(metricSource)} | ${cell(generatedAt ?? '缺失')} |`;
}

export function renderMarkdown(report) {
  const live = report.overview.singleTurn;
  const multi = report.overview.multiTurn;
  const offline = report.overview.offline;
  const lines = [];
  lines.push('# Agent 能力报告', '');
  lines.push(`> 生成时间：${report.generatedAt} · 生成器：\`${report.generator}\` · 模型：${report.sources.live.model ?? '缺失'}`);
  lines.push(`> 口径：单轮 = 真实模型 ${fmtInt(live.total.value)} 条；多轮 = 真实模型 6 个场景；离线 = 规则路由固定用例。缺数据源时写「缺失：<文件>」，不做推断。`);
  lines.push('');

  lines.push('## 总览', '');
  lines.push('| 指标 | 数值 | 来源文件 | 生成时间 |');
  lines.push('|---|---:|---|---|');
  const toolCount = report.overview.toolCount;
  const testCount = report.overview.testCount;
  lines.push(mdMetricRow('工具数', `${fmtInt(toolCount.value)} 个`, toolCount.source, toolCount.generatedAt));
  lines.push(mdMetricRow('测试数', `${fmtInt(testCount.value)} 条`, testCount.source, testCount.generatedAt));
  lines.push(mdMetricRow('单轮准确率', `${fmtPct(live.accuracy.value)}（${fmtInt(live.matched.value)}/${fmtInt(live.total.value)}）`, live.accuracy.source, live.accuracy.generatedAt));
  lines.push(mdMetricRow('单轮 p50 / p95', `${fmtMs(live.p50Ms.value)} / ${fmtMs(live.p95Ms.value)}`, live.p50Ms.source, live.p50Ms.generatedAt));
  lines.push(mdMetricRow('单轮工具 / 确认 / 澄清', `${fmtPct(live.toolAccuracy.value)} / ${fmtPct(live.confirmRate.value)} / ${fmtPct(live.clarifyRate.value)}`, live.toolAccuracy.source, live.toolAccuracy.generatedAt));
  lines.push(mdMetricRow('多轮准确率', `${fmtPct(multi.accuracy.value)}（${fmtInt(multi.passed.value)}/${fmtInt(multi.total.value)}）`, multi.accuracy.source, multi.accuracy.generatedAt));
  lines.push(mdMetricRow('多轮轮次', `${fmtInt(multi.turnPassed.value)}/${fmtInt(multi.turnTotal.value)}（阈值 ${fmtPct(multi.threshold.value)}）`, multi.turnPassed.source, multi.turnPassed.generatedAt));
  lines.push(mdMetricRow('多轮 p50 / p95', `${fmtMs(multi.p50Ms.value)} / ${fmtMs(multi.p95Ms.value)}`, multi.p50Ms.source, multi.p50Ms.generatedAt));
  const intent = offline.metrics.intent;
  if (intent) {
    lines.push(mdMetricRow('离线意图准确率', `${fmtPct(intent.rate.value)}（${fmtInt(intent.correct.value)}/${fmtInt(intent.total.value)}）`, intent.rate.source, intent.rate.generatedAt));
  }
  lines.push(mdMetricRow('审计条目', report.audit.status === 'ok' ? `${fmtInt(report.audit.total)} 条（失败 ${fmtInt(report.audit.failed)}）` : `缺失：${report.audit.file}`, report.audit.status === 'ok' ? report.audit.file : `缺失：${report.audit.file}`, report.audit.generatedAt));
  lines.push('');

  lines.push('## 分组表现（真实模型单轮）', '');
  lines.push('| 分组 | 通过 / 总数 | 准确率 | p50 | p95 | 来源文件 | 生成时间 |');
  lines.push('|---|---:|---:|---:|---:|---|---|');
  for (const group of report.groups) {
    const extra = group.key === 'refusal' && group.refusalRate !== null ? `（拒绝率 ${fmtPct(group.refusalRate)}）` : '';
    lines.push(`| ${cell(group.label)} | ${group.missing ? '缺失' : `${fmtInt(group.matched)} / ${fmtInt(group.total)}`} | ${fmtPct(group.accuracy)}${extra} | ${fmtMs(group.p50Ms)} | ${fmtMs(group.p95Ms)} | ${cell(group.source)} | ${cell(group.generatedAt ?? '缺失')} |`);
  }
  lines.push('');

  lines.push('## 离线评测（规则路由）', '');
  lines.push('| 指标 | 结果 | 来源文件 | 生成时间 |');
  lines.push('|---|---:|---|---|');
  for (const [key, label] of [['intent', '意图'], ['tools', '工具'], ['params', '参数'], ['refused', '超纲拒绝'], ['multiStep', '多步']]) {
    const item = offline.metrics[key];
    if (!item) continue;
    lines.push(mdMetricRow(label, `${fmtPct(item.rate.value)}（${fmtInt(item.correct.value)}/${fmtInt(item.total.value)}）`, item.rate.source, item.rate.generatedAt));
  }
  lines.push('');

  lines.push('## 多轮场景', '');
  lines.push(`| 场景 | 结果 | 轮次 | 来源文件 | 生成时间 |`);
  lines.push(`|---|---:|---:|---|---|`);
  for (const scenario of report.multiturnScenarios) {
    lines.push(`| ${cell(`${scenario.id} ${scenario.title}`)} | ${scenario.passed ? '✅ 通过' : '❌ 失败'} | ${scenario.passedTurns}/${scenario.turns} | ${cell(report.sources.multiturn.file)} | ${cell(report.sources.multiturn.generatedAt ?? '缺失')} |`);
  }
  if ((report.multiturnFailures ?? []).length > 0) {
    lines.push('', '失败明细：');
    for (const failure of report.multiturnFailures) {
      lines.push(`- **${failure.id} ${failure.title ?? ''}**：${(failure.failedTurns ?? []).map((turn) => `第 ${turn.round} 轮 ${turn.reason}`).join('；')}`);
    }
  }
  lines.push('');

  lines.push('## 能力清单', '');
  lines.push('> 验证方式中的 eval 数字沿用总览/分组表来源：单轮 `agent-live.json`、多轮 `agent-multiturn.json`、离线 `latest.json`（生成时间见对应表格）。');
  lines.push('| 能力 | 对应模块文件 | 验证方式 | 状态 |');
  lines.push('|---|---|---|---|');
  for (const item of report.capabilities) {
    lines.push(`| ${cell(item.capability)}<br>\`${cell(item.id)}\` | ${cell(item.module)} | ${cell(item.verification.join('；'))} | ${cell(item.status)} |`);
  }
  lines.push('');

  lines.push('## 已知缺口（从 BACKLOG 自动摘取）', '');
  if (report.knownGaps.length === 0) {
    lines.push('- 未找到与 Agent 相关的已知限制条目。');
  } else {
    for (const gap of report.knownGaps) {
      lines.push(`- ${gap.text}（来源：\`${gap.source}:${gap.line}\`，生成时间：${gap.generatedAt ?? '缺失'}）`);
    }
  }
  lines.push('');

  lines.push('## 缺失数据源', '');
  if (report.missing.length === 0) {
    lines.push('- 无。');
  } else {
    for (const item of report.missing) {
      lines.push(`- 缺失：${item.file}（${item.reason}）`);
    }
  }
  lines.push('');

  lines.push('## 审计摘要', '');
  if (report.audit.status === 'ok') {
    const topTools = Object.entries(report.audit.tools ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push(`- 文件：\`${report.audit.file}\``);
    lines.push(`- 条目：${fmtInt(report.audit.total)} 条；失败：${fmtInt(report.audit.failed)} 条；最后一条：${report.audit.lastAt ?? '缺失'}`);
    lines.push(`- 工具分布：${topTools.map(([tool, count]) => `\`${tool}\` ${count}`).join('、') || '无'}`);
    lines.push(`- 生成时间：${report.audit.generatedAt ?? '缺失'}`);
  } else {
    lines.push(`- 缺失：${report.audit.file}`);
    lines.push(`- 原因：${report.audit.reason}`);
    lines.push('- 已跳过审计统计，不影响其余报告。');
  }
  lines.push('');
  lines.push('---');
  lines.push(`本报告由 \`npm run agent:report\` 生成；所有评测数字均来自上述源文件，生成后脚本会读回 JSON 并逐项比对。`);
  lines.push('');
  return lines.join('\n');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function svgMetricValue(value, suffix = '', missing = false) {
  if (missing || value === null || value === undefined) return '缺失';
  return `${fmtInt(value)}${suffix}`;
}

export function renderSvg(report) {
  const width = 1120;
  const height = 650;
  const live = report.overview.singleTurn;
  const multi = report.overview.multiTurn;
  const toolCount = report.overview.toolCount;
  const testCount = report.overview.testCount;
  const kpis = [
    { label: '工具', value: svgMetricValue(toolCount.value), sub: '注册表 / 评测覆盖', color: '#38bdf8' },
    { label: '测试数', value: svgMetricValue(testCount.value), sub: 'npm test', color: '#a78bfa' },
    { label: '单轮', value: live.total.missing ? '缺失' : `${fmtInt(live.matched.value)}/${fmtInt(live.total.value)}`, sub: fmtPct(live.accuracy.value), color: '#34d399' },
    { label: '多轮', value: multi.total.missing ? '缺失' : `${fmtInt(multi.passed.value)}/${fmtInt(multi.total.value)}`, sub: fmtPct(multi.accuracy.value), color: '#fbbf24' }
  ];
  const barX = 220;
  const barWidth = 650;
  const barHeight = 34;
  const startY = 330;
  const gap = 62;
  const colors = { query: '#38bdf8', operation: '#34d399', workflow: '#fbbf24', refusal: '#f472b6' };

  const kpiSvg = kpis.map((kpi, index) => {
    const x = 40 + index * 266;
    return `
  <g>
    <rect x="${x}" y="120" width="244" height="112" rx="14" fill="#111c2e" stroke="#22314a"/>
    <rect x="${x}" y="120" width="5" height="112" rx="2.5" fill="${kpi.color}"/>
    <text x="${x + 22}" y="152" fill="#8fa3bf" font-size="15">${escapeXml(kpi.label)}</text>
    <text x="${x + 22}" y="191" fill="#f2f7ff" font-size="32" font-weight="700">${escapeXml(kpi.value)}</text>
    <text x="${x + 22}" y="215" fill="#7f93ad" font-size="13">${escapeXml(kpi.sub)}</text>
  </g>`;
  }).join('');

  const barsSvg = report.groups.map((group, index) => {
    const y = startY + index * gap;
    const value = group.missing ? 0 : Math.max(0, Math.min(1, Number(group.accuracy) || 0));
    const fillWidth = Math.round(barWidth * value);
    const count = group.missing ? '缺失' : `${fmtInt(group.matched)}/${fmtInt(group.total)}`;
    const pct = group.missing ? '缺失' : fmtPct(group.accuracy);
    return `
  <g>
    <text x="40" y="${y + 23}" fill="#dbe7f5" font-size="19" font-weight="600">${escapeXml(group.label)}</text>
    <text x="40" y="${y + 45}" fill="#7086a3" font-size="12">${escapeXml(group.key)}</text>
    <rect x="${barX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="8" fill="#172539"/>
    <rect x="${barX}" y="${y}" width="${fillWidth}" height="${barHeight}" rx="8" fill="${colors[group.key] ?? '#38bdf8'}"/>
    <text x="${barX + barWidth + 16}" y="${y + 23}" fill="#f2f7ff" font-size="18" font-weight="700">${escapeXml(pct)}</text>
    <text x="${barX + barWidth + 86}" y="${y + 23}" fill="#8fa3bf" font-size="14">${escapeXml(count)}</text>
    <text x="${barX + barWidth + 140}" y="${y + 23}" fill="#7086a3" font-size="12">p50 ${escapeXml(group.missing ? '缺失' : fmtMs(group.p50Ms))}</text>
  </g>`;
  }).join('');

  const missingLine = report.missing.length > 0
    ? `缺失：${report.missing.map((item) => item.file).join('、')}`
    : '数据源齐全';
  const model = report.sources.live.model ?? '缺失';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Agent 能力报告</title>
  <desc id="desc">工具 ${escapeXml(svgMetricValue(toolCount.value))}，测试 ${escapeXml(svgMetricValue(testCount.value))}，单轮 ${escapeXml(`${fmtInt(live.matched.value)}/${fmtInt(live.total.value)}`)}，多轮 ${escapeXml(`${fmtInt(multi.passed.value)}/${fmtInt(multi.total.value)}`)}</desc>
  <style>
    text { font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", sans-serif; }
    .mono { font-family: "JetBrains Mono", "Cascadia Code", "Consolas", monospace; }
  </style>
  <rect width="${width}" height="${height}" fill="#0b1220"/>
  <text x="40" y="58" fill="#f2f7ff" font-size="30" font-weight="700">Agent 能力报告</text>
  <text x="40" y="88" fill="#8fa3bf" font-size="15">真实模型单轮 ${escapeXml(svgMetricValue(live.total.value))} 条 · 多轮 ${escapeXml(svgMetricValue(multi.total.value))} 个场景 · 离线规则 ${escapeXml(svgMetricValue(report.overview.offline.total.value))} 条 · 模型 ${escapeXml(model)}</text>
${kpiSvg}
  <text x="40" y="282" fill="#dbe7f5" font-size="20" font-weight="700">分组准确率</text>
  <text x="220" y="282" fill="#7086a3" font-size="13">条形长度 = 通过率；右侧为通过数 / 总数与 p50</text>
${barsSvg}
  <line x1="40" y1="586" x2="1080" y2="586" stroke="#22314a"/>
  <text x="40" y="614" fill="#7086a3" font-size="12">来源：docs/desktop/eval/agent-live.json · agent-multiturn.json · latest.json</text>
  <text x="40" y="635" fill="#7086a3" font-size="12">${escapeXml(missingLine)} · 生成：${escapeXml(report.generatedAt)}</text>
</svg>
`;
}

function verifyOutputs(root, report, markdown, svg) {
  const jsonPath = resolve(root, REPORT_FILES.json);
  const mdPath = resolve(root, REPORT_FILES.md);
  const svgPath = resolve(root, REPORT_FILES.svg);
  for (const file of [jsonPath, mdPath, svgPath]) {
    assert.ok(existsSync(file), `输出文件不存在：${displayPath(root, file)}`);
    assert.ok(statSync(file).size > 0, `输出文件为空：${displayPath(root, file)}`);
  }
  const readBack = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.deepEqual(readBack, report, 'agent-report.json 读回与内存对象不一致');
  const mdText = readFileSync(mdPath, 'utf8');
  const svgText = readFileSync(svgPath, 'utf8');
  for (const group of report.groups) {
    assert.ok(mdText.includes(group.label), `Markdown 缺少分组 ${group.label}`);
    assert.ok(svgText.includes(escapeXml(group.label)), `SVG 缺少分组 ${group.label}`);
  }
  const live = report.overview.singleTurn;
  const multi = report.overview.multiTurn;
  if (!live.total.missing) assert.ok(svgText.includes(`${fmtInt(live.matched.value)}/${fmtInt(live.total.value)}`), 'SVG 缺少单轮 KPI');
  if (!multi.total.missing) assert.ok(svgText.includes(`${fmtInt(multi.passed.value)}/${fmtInt(multi.total.value)}`), 'SVG 缺少多轮 KPI');
  if (!report.overview.toolCount.missing) assert.ok(svgText.includes(svgMetricValue(report.overview.toolCount.value)), 'SVG 缺少工具数');
  if (!report.overview.testCount.missing) assert.ok(svgText.includes(svgMetricValue(report.overview.testCount.value)), 'SVG 缺少测试数');
  return { markdown, svg };
}

function writeReports(root, report) {
  const markdown = renderMarkdown(report);
  const svg = renderSvg(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(resolve(root, 'docs/desktop'), { recursive: true });
  writeFileSync(resolve(root, REPORT_FILES.json), json, 'utf8');
  writeFileSync(resolve(root, REPORT_FILES.md), markdown, 'utf8');
  writeFileSync(resolve(root, REPORT_FILES.svg), svg, 'utf8');
  verifyOutputs(root, report, markdown, svg);
  return { markdown, svg, json };
}

export function generateReport(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const sources = options.sources ?? loadReportSources(root, options);
  const testCount = options.testCount ?? measureTestCount({ cwd: join(root, 'desktop') });
  const report = buildReport(sources, { ...options, testCount });
  verifyReport(report, sources);
  const outputs = writeReports(root, report);
  return { report, sources, outputs };
}

async function main() {
  const root = process.env.AGENT_REPORT_ROOT ? resolve(process.env.AGENT_REPORT_ROOT) : REPO_ROOT;
  let result;
  try {
    result = generateReport({ root });
  } catch (error) {
    console.error(`AGENT_REPORT_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  for (const missing of result.report.missing) {
    console.warn(`WARN 缺失：${missing.file}（${missing.reason}）`);
  }
  if (result.report.overview.testCount.value === null) {
    console.warn('WARN 未能统计测试数');
  }
  console.log(
    `AGENT_REPORT_OK md=${REPORT_FILES.md} json=${REPORT_FILES.json} svg=${REPORT_FILES.svg} `
    + `tools=${result.report.overview.toolCount.value ?? '缺失'} `
    + `tests=${result.report.overview.testCount.value ?? '缺失'} `
    + `single=${result.report.overview.singleTurn.matched.value ?? '缺失'}/${result.report.overview.singleTurn.total.value ?? '缺失'} `
    + `multi=${result.report.overview.multiTurn.passed.value ?? '缺失'}/${result.report.overview.multiTurn.total.value ?? '缺失'}`
  );
  if (result.report.missing.length > 0) {
    console.log(`AGENT_REPORT_EXIT_OK_WITH_MISSING count=${result.report.missing.length}`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
