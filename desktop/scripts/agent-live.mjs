#!/usr/bin/env node
/**
 * 真实模型端到端冒烟（可选依赖）
 *
 * 环境变量（只从环境读，不写入仓库）：
 *   AGENT_LIVE_BASE_URL  OpenAI 兼容端点，例如 http://127.0.0.1:7864/v1
 *   AGENT_LIVE_API_KEY   端点密钥
 *   AGENT_LIVE_MODEL     模型名，例如 cn:deepseek-v4.1-flash
 *
 * 缺任一变量：打印 AGENT_LIVE_SKIP 并以 0 退出，不算失败。
 * 有凭据但调用失败或断言不通过：写结果文件并以 1 退出。
 *
 * 结果：docs/desktop/eval/agent-live.json
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSession } from '../src/agent/session.ts';
import { OpenAiCompatibleClient } from '../src/agent/llm.ts';
import { AgentTools } from '../src/agent/tools.ts';
import { PackRegistry } from '../src/packs/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(DESKTOP_ROOT, '..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'docs/desktop/eval/agent-live.json');
const BUILTIN_PACKS = resolve(REPO_ROOT, 'packs/builtin');

const baseUrl = (process.env.AGENT_LIVE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = (process.env.AGENT_LIVE_API_KEY ?? '').trim();
const model = (process.env.AGENT_LIVE_MODEL ?? '').trim();
const timeoutMs = Number(process.env.AGENT_LIVE_TIMEOUT_MS ?? 90_000);
const caseTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000;

if (!baseUrl || !apiKey || !model) {
  console.log('AGENT_LIVE_SKIP 未配置 AGENT_LIVE_BASE_URL / AGENT_LIVE_API_KEY / AGENT_LIVE_MODEL');
  process.exit(0);
}

const projectContext = {
  domain: 'elec',
  view: '底板',
  selection: { kind: 'placement', id: 'p1', label: 'QF1' },
  machine: { name: '烟包机', stations: 3, actuators: 6, sensors: 8 },
  plate: { width: 600, height: 400, placed: 2, overlaps: 0 },
  recentActions: [
    { tool: 'import_cad', summary: '导入 D:\\fixtures\\station.step', at: new Date().toISOString() }
  ],
  units: 'mm',
  placements: [
    { id: 'p1', label: 'QF1', x: 20, y: 30, w: 36, h: 80 },
    { id: 'p2', label: 'KM1', x: 80, y: 30, w: 36, h: 80 }
  ]
};

function fakeData(name, args) {
  switch (name) {
    case 'get_project_context':
      return projectContext;
    case 'list_components':
      return { count: 2, components: [
        { id: 'iC65N-C16-1P', model: 'iC65N-C16-1P', category: '断路器' },
        { id: 'iC65N-C16-3P', model: 'iC65N-C16-3P', category: '断路器' }
      ] };
    case 'search_components':
      return { query: args.q, count: 2, components: [
        { id: 'iC65N-C16-1P', model: 'iC65N-C16-1P', category: '断路器' },
        { id: 'iC65N-C16-3P', model: 'iC65N-C16-3P', category: '断路器' }
      ] };
    case 'get_bom':
      return { rows: [{ line: 1, ref: 'QF1', model: 'iC65N-C16-1P', qty: 1 }], note: 'live stub' };
    case 'run_interference_check':
      return { hits: 0, items: [] };
    case 'run_electrical_check':
      return { ok: true, findings: [], summary: { errors: 0, warnings: 0 } };
    case 'run_cost_report':
      return { totals: { grand: 1398.64 }, lines: 6, missing: 0 };
    case 'export_cost_report':
      return { path: 'D:\\userData\\exports\\cost.pdf', bytes: 1024, format: args.format };
    case 'import_cad':
      return { ok: true, path: args.path ?? 'D:\\fixtures\\station.step', meshes: 1, triangles: 1200 };
    case 'update_component':
      return { ok: true, ref: args.ref ?? args.partId ?? 'QF1', model: args.model, qty: args.qty, remark: args.remark };
    case 'remove_component':
      return { ok: true, ref: args.ref ?? 'QF1', target: args.target ?? 'plate', removed: 'p2' };
    case 'run_plc_generate':
      return { ok: true, files: 11, directory: 'D:\\userData\\exports\\plc\\live', zip: true };
    case 'verify_plc_program':
      return { ok: true, steps: 12, alarms: [], files: 11 };
    case 'export_files':
      return { ok: true, kind: args.kind, path: `D:\\userData\\exports\\design.${args.kind}`, bytes: 2048 };
    case 'undo_last':
      return { ok: true, command: 'update_component', removed: 'p1' };
    default:
      return { ok: true, tool: name, args };
  }
}

function normalizeToolName(name) {
  return name === 'run_interference' ? 'run_interference_check' : name;
}

function createFakeBus() {
  const calls = [];
  return {
    calls,
    async execute(name, args = {}) {
      const tool = normalizeToolName(name);
      calls.push({ name: tool, args });
      return { ok: true, data: fakeData(tool, args) };
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: fakeData('undo_last', {}) };
    }
  };
}

const CASES = [
  {
    id: 'L01',
    instruction: '查有没有 3P 断路器',
    alternatives: [
      { tools: ['list_components'], args: [{ category: '断路器' }], confirm: false },
      { tools: ['search_components'], args: [{ q: { contains: '3P' } }, { q: { contains: '断路器' } }], confirm: false }
    ]
  },
  {
    id: 'L02',
    instruction: '导入一个 STEP',
    alternatives: [
      { tools: ['import_cad'], args: [{ path: { nonEmpty: true } }], confirm: true }
    ]
  },
  {
    id: 'L03',
    instruction: '生成这份设计的 BOM',
    alternatives: [
      { tools: ['get_bom'], args: [{}], confirm: false }
    ]
  },
  {
    id: 'L04',
    instruction: '检查干涉',
    alternatives: [
      { tools: ['run_interference_check'], args: [{}], confirm: false }
    ]
  },
  {
    id: 'L05',
    instruction: '看电气合规',
    alternatives: [
      { tools: ['run_electrical_check'], args: [{}], confirm: false }
    ]
  },
  {
    id: 'L06',
    instruction: '出成本报告',
    alternatives: [
      { tools: ['run_cost_report'], args: [{}], confirm: false },
      { tools: ['export_cost_report'], args: [{ format: { nonEmpty: true } }], confirm: true }
    ]
  },
  {
    id: 'L07',
    instruction: '把 QF1 改成 3P',
    alternatives: [
      { tools: ['update_component'], args: [{ ref: { contains: 'QF1' } }], confirm: true },
      { tools: ['update_component'], args: [{ designator: { contains: 'QF1' } }], confirm: true },
      { tools: ['update_component'], args: [{ tag: { contains: 'QF1' } }], confirm: true }
    ]
  },
  {
    id: 'L08',
    instruction: '删掉底板第二个元件',
    alternatives: [
      { tools: ['remove_component'], args: [{ target: 'plate', ref: { nonEmpty: true } }], confirm: true },
      { tools: ['remove_component'], args: [{ ref: { nonEmpty: true } }], confirm: true }
    ]
  },
  {
    id: 'L09',
    instruction: '生成 PLC 程序',
    alternatives: [
      { tools: ['run_plc_generate'], args: [{}], confirm: true }
    ]
  },
  {
    id: 'L10',
    instruction: '导出 PDF',
    alternatives: [
      { tools: ['export_files'], args: [{ kind: 'pdf' }], confirm: true }
    ]
  },
  {
    id: 'L11',
    instruction: '撤销',
    alternatives: [
      { tools: ['undo_last'], args: [{}], confirm: true }
    ]
  },
  {
    id: 'L12',
    instruction: '我这台机器的底板还剩多少空间',
    alternatives: [
      { tools: ['get_project_context'], args: [{}], confirm: false }
    ]
  }
];

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && expected.nonEmpty === true) {
    return actual !== undefined && actual !== null && String(actual).trim() !== '';
  }
  if (expected && typeof expected === 'object' && typeof expected.contains === 'string') {
    return actual !== undefined && actual !== null &&
      String(actual).toLowerCase().includes(expected.contains.toLowerCase());
  }
  return actual === expected;
}

function matchesArgs(args, checks) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  return (checks ?? [{}]).some((check) =>
    Object.entries(check).every(([key, value]) => matchesValue(args[key], value))
  );
}

function alternativeMatches(alternative, calls, confirmations) {
  const call = calls.find((entry) => alternative.tools.includes(entry.name) && matchesArgs(entry.args, alternative.args));
  if (!call) return null;
  const confirmed = confirmations.some((entry) => entry.name === call.name);
  if (alternative.confirm === true && !confirmed) return { call, confirmed: false, reason: '写操作未经确认' };
  if (alternative.confirm === false && confirmations.length > 0) {
    return { call, confirmed: false, reason: `只读指令却出现确认请求：${confirmations.map((entry) => entry.name).join(',')}` };
  }
  return { call, confirmed: true };
}

function expectedLabel(testCase) {
  return testCase.alternatives.map((alternative) => ({
    tools: alternative.tools,
    args: alternative.args,
    confirm: alternative.confirm
  }));
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`用例超时（${Math.round(ms / 1000)} 秒）`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCase(testCase, tempRoot) {
  const bus = createFakeBus();
  const confirmations = [];
  const tools = new AgentTools(new PackRegistry({
    builtinDir: BUILTIN_PACKS,
    userDir: join(tempRoot, 'user'),
    stateFile: join(tempRoot, 'packs-state.json')
  })).summaries();
  const llm = new OpenAiCompatibleClient({
    baseUrl,
    apiKey,
    model,
    tools,
    timeoutMs: caseTimeoutMs
  });
  const session = new AgentSession({
    llm,
    bus,
    maxIterations: 8,
    offlineFallback: false,
    contextProvider: () => projectContext,
    confirmWrite: async (name, args) => {
      confirmations.push({ name, args });
      return true;
    }
  });

  let reply = '';
  try {
    reply = await withTimeout(session.run(testCase.instruction), caseTimeoutMs);
  } catch (error) {
    return {
      id: testCase.id,
      instruction: testCase.instruction,
      expected: expectedLabel(testCase),
      actualTools: bus.calls.map((call) => call.name),
      confirmations: confirmations.map((entry) => entry.name),
      reply: error instanceof Error ? error.message : String(error),
      ok: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  let matched = null;
  let reason = '未调用预期工具或关键参数不符';
  for (const alternative of testCase.alternatives) {
    const result = alternativeMatches(alternative, bus.calls, confirmations);
    if (result && result.confirmed) {
      matched = { alternative, call: result.call };
      break;
    }
    if (result && !result.confirmed) reason = result.reason;
  }

  const writeExpected = matched
    ? matched.alternative.confirm === true
    : testCase.alternatives.some((alternative) => alternative.confirm === true);
  const confirmedOk = matched
    ? !writeExpected || confirmations.some((entry) => entry.name === matched.call.name)
    : confirmations.length === 0 || !writeExpected;

  return {
    id: testCase.id,
    instruction: testCase.instruction,
    expected: expectedLabel(testCase),
    actualTools: bus.calls.map((call) => call.name),
    actualCalls: bus.calls,
    confirmations: confirmations.map((entry) => entry.name),
    reply: reply.length > 500 ? `${reply.slice(0, 500)}…` : reply,
    matched: Boolean(matched),
    confirmExpected: writeExpected,
    confirmOk: confirmedOk,
    ok: Boolean(matched) && confirmedOk,
    ...(matched ? {} : { reason })
  };
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agent-live-'));
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    for (const testCase of CASES) {
      const result = await runCase(testCase, tempRoot);
      results.push(result);
      const status = result.ok ? 'PASS' : 'FAIL';
      const toolText = result.actualTools.length > 0 ? result.actualTools.join(' -> ') : '(none)';
      console.log(`${status} ${result.id} ${testCase.instruction}  [${toolText}]`);
      if (!result.ok) console.log(`     ${result.reason ?? ''}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const matched = results.filter((result) => result.ok).length;
  const total = results.length;
  const toolAccuracy = total === 0 ? 1 : matched / total;
  const confirmExpected = results.filter((result) => result.confirmExpected);
  const confirmOk = confirmExpected.filter((result) => result.confirmOk).length;
  const confirmRate = confirmExpected.length === 0 ? 1 : confirmOk / confirmExpected.length;
  const failures = results
    .filter((result) => !result.ok)
    .map(({ id, instruction, expected, actualTools, confirmations, reply, reason }) => ({
      id,
      instruction,
      expected,
      actualTools,
      confirmations,
      reply,
      reason
    }));

  const output = {
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    mode: 'live-model',
    model,
    total,
    matched,
    toolAccuracy,
    confirmRate,
    failures
  };
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`模型 ${model} · 工具匹配 ${matched}/${total} · toolAccuracy=${toolAccuracy.toFixed(2)} · confirmRate=${confirmRate.toFixed(2)}`);
  console.log(`结果文件 docs/desktop/eval/agent-live.json`);
  if (failures.length === 0) {
    console.log(`AGENT_LIVE_OK matched=${matched}/${total} tools=${toolAccuracy.toFixed(2)} confirm=${confirmRate.toFixed(2)}`);
    return;
  }
  console.error(`AGENT_LIVE_FAIL matched=${matched}/${total} tools=${toolAccuracy.toFixed(2)} confirm=${confirmRate.toFixed(2)}`);
  for (const failure of failures) console.error(`- ${failure.id}: ${failure.reason}`);
  process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`AGENT_LIVE_FAIL ${message}`);
  process.exitCode = 1;
});
