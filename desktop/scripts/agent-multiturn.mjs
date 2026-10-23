#!/usr/bin/env node
/**
 * 多轮真实模型评测（可选依赖）
 *
 * 环境变量同 `npm run agent:live`：
 *   AGENT_LIVE_BASE_URL / AGENT_LIVE_API_KEY / AGENT_LIVE_MODEL
 * 缺任一变量：写 SKIP 结果、打印 AGENT_MULTITURN_SKIP 并以 0 退出。
 *
 * 用例：desktop/scripts/agent-multiturn-cases.json（6 个场景，每场景 2–3 轮）
 * 结果：docs/desktop/eval/agent-multiturn.json
 * 阈值：passRate ≥ 0.8
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CASES_PATH = resolve(HERE, 'agent-multiturn-cases.json');
const OUTPUT_PATH = resolve(REPO_ROOT, 'docs/desktop/eval/agent-multiturn.json');
const BUILTIN_PACKS = resolve(REPO_ROOT, 'packs/builtin');

const SCENARIO_COUNT = 6;
const PASS_RATE_GATE = 0.8;
const MAX_ITERATIONS = 12;
const MUTATING_TOOLS = new Set([
  'import_cad', 'insert_component', 'place_component', 'update_component',
  'remove_component', 'run_plc_generate', 'export_files', 'undo_last', 'export_cost_report'
]);

const baseUrl = (process.env.AGENT_LIVE_BASE_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = (process.env.AGENT_LIVE_API_KEY ?? '').trim();
const model = (process.env.AGENT_LIVE_MODEL ?? '').trim();
const configuredTimeout = Number(process.env.AGENT_LIVE_TIMEOUT_MS ?? 120_000);
const turnTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120_000;

const componentStub = {
  '断路器': [
    { id: 'iC65N-C16-1P', model: 'iC65N 1P C16', category: '断路器', vendor: '施耐德', dims: { w: 18, h: 85, d: 78.5 } },
    { id: 'NXB-63-C32-3P', model: 'NXB-63 3P C32', category: '断路器', vendor: '正泰', dims: { w: 54, h: 80, d: 77.8 } }
  ],
  '24V': [
    { id: 'NDR-120-24', model: 'NDR-120-24', category: '开关电源', vendor: '明纬', dims: { w: 40, h: 125.2, d: 113.5 } }
  ]
};

function loadCases() {
  const raw = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('多轮用例必须是数组');
  if (raw.length !== SCENARIO_COUNT) throw new Error(`多轮场景应为 ${SCENARIO_COUNT} 个，实际 ${raw.length} 个`);
  const ids = new Set();
  for (const scenario of raw) {
    if (!scenario || typeof scenario !== 'object') throw new Error('场景必须是对象');
    if (typeof scenario.id !== 'string' || !scenario.id) throw new Error('场景缺少 id');
    if (ids.has(scenario.id)) throw new Error(`重复场景 id：${scenario.id}`);
    ids.add(scenario.id);
    if (!Array.isArray(scenario.turns) || scenario.turns.length < 2 || scenario.turns.length > 3) {
      throw new Error(`${scenario.id} 必须有 2–3 轮`);
    }
    for (const [index, turn] of scenario.turns.entries()) {
      if (typeof turn.prompt !== 'string' || !turn.prompt.trim()) throw new Error(`${scenario.id} 第 ${index + 1} 轮缺少 prompt`);
      if (!turn.expect || typeof turn.expect !== 'object') throw new Error(`${scenario.id} 第 ${index + 1} 轮缺少 expect`);
      if (!Array.isArray(turn.expect.tools)) throw new Error(`${scenario.id} 第 ${index + 1} 轮 expect.tools 必须是数组`);
      if (!Array.isArray(turn.expect.mustNot)) throw new Error(`${scenario.id} 第 ${index + 1} 轮 expect.mustNot 必须是数组`);
    }
  }
  return raw;
}

function cloneContext(context) {
  return {
    ...context,
    machine: context.machine ? { ...context.machine } : null,
    plate: context.plate ? { ...context.plate } : null,
    placements: Array.isArray(context.placements) ? context.placements.map((item) => ({ ...item })) : [],
    recentActions: Array.isArray(context.recentActions) ? context.recentActions.map((item) => ({ ...item })) : [],
    units: 'mm'
  };
}

function applyContextPatch(context, patch) {
  if (!patch || typeof patch !== 'object') return context;
  const merged = cloneContext(context);
  if (patch.machine) merged.machine = { ...(merged.machine ?? {}), ...patch.machine };
  if (patch.plate) merged.plate = { ...(merged.plate ?? {}), ...patch.plate };
  if (Array.isArray(patch.placements)) {
    merged.placements = patch.placements.map((item) => ({ ...item }));
    merged.plate = {
      ...(merged.plate ?? { width: 600, height: 400, overlaps: 0 }),
      placed: merged.placements.length
    };
  }
  for (const key of ['domain', 'view', 'selection', 'bomRows', 'hasCadModel']) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  return merged;
}

function createFakeBus(initialContext) {
  let context = cloneContext(initialContext);
  const calls = [];
  const undoStack = [];

  function view() {
    return cloneContext(context);
  }

  function findPlacement(ref) {
    const wanted = String(ref ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return context.placements.find((item) =>
      String(item.id).toLowerCase() === wanted ||
      String(item.label ?? '').toLowerCase() === wanted ||
      String(item.model ?? '').toLowerCase() === wanted
    ) ?? null;
  }

  function update(args) {
    const ref = args.ref ?? args.designator ?? args.tag ?? args.partId ?? '';
    const placement = findPlacement(ref);
    if (!placement) return { ok: true, ref, model: args.model, qty: args.qty, remark: args.remark, note: 'bom-only stub' };
    undoStack.push({ kind: 'update', id: placement.id, snapshot: { ...placement } });
    if (typeof args.model === 'string' && args.model.trim()) {
      placement.model = args.model.trim();
      placement.label = placement.label === placement.id ? placement.label : placement.label;
    }
    if (Number.isInteger(args.qty) && args.qty > 0) placement.qty = args.qty;
    if (typeof args.remark === 'string') placement.remark = args.remark;
    return { ok: true, ref, id: placement.id, model: placement.model, qty: placement.qty, remark: placement.remark };
  }

  function undo() {
    const action = undoStack.pop();
    if (!action) return { ok: true, command: null, note: '没有可撤销操作' };
    const index = context.placements.findIndex((item) => item.id === action.id);
    if (index >= 0) context.placements[index] = { ...action.snapshot };
    return { ok: true, command: 'update_component', restored: action.id };
  }

  function fakeData(name, args) {
    switch (name) {
      case 'get_project_context':
        return view();
      case 'get_bom':
        return {
          rows: context.placements.map((item, index) => ({
            line: index + 1,
            ref: item.label,
            model: item.model,
            qty: item.qty ?? 1,
            remark: item.remark ?? ''
          })),
          note: 'multiturn stub'
        };
      case 'list_components':
      case 'search_components':
        return { count: 2, components: componentStub['断路器'] };
      case 'run_cost_report':
        return { totals: { grand: 1398.64 }, lines: context.placements.length, missing: 0 };
      case 'run_electrical_check':
        return { ok: true, findings: [], summary: { errors: 0, warnings: 0 } };
      case 'run_interference_check':
        return { hits: 0, items: [] };
      case 'export_cost_report':
        return { path: `D:\\userData\\exports\\cost.${args.format === 'csv' ? 'csv' : 'pdf'}`, bytes: 1024, format: args.format };
      case 'export_files':
        return { ok: true, path: `D:\\userData\\exports\\${args.kind}`, bytes: 1024 };
      default:
        return { ok: true, data: { tool: name, args } };
    }
  }

  return {
    calls,
    view,
    updateContext(patch) {
      context = applyContextPatch(context, patch);
    },
    async execute(name, args = {}) {
      const record = { name, args };
      calls.push(record);
      let data;
      if (name === 'update_component') data = update(args);
      else if (name === 'undo_last') data = undo();
      else data = fakeData(name, args);
      const result = { ok: true, data };
      record.result = result;
      return result;
    },
    async undoLast() {
      calls.push({ name: 'undo_last', args: {} });
      return { ok: true, data: undo() };
    }
  };
}

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

function matchOrdered(expected, calls) {
  let position = 0;
  for (const call of calls) {
    if (position >= expected.length) break;
    const step = expected[position];
    if (call.name === step.tool && matchesArgs(call.args, step.args)) position += 1;
  }
  return position === expected.length;
}

function withConfirmedAttempts(calls, confirmations) {
  const attempted = calls.map((call) => ({ ...call, confirmedOnly: false }));
  for (const confirm of confirmations) {
    const already = attempted.some((call) =>
      call.name === confirm.name && JSON.stringify(call.args ?? {}) === JSON.stringify(confirm.args ?? {})
    );
    if (!already) attempted.push({ name: confirm.name, args: confirm.args ?? {}, confirmedOnly: true });
  }
  return attempted;
}

function evaluateTurn(turn, calls, confirmations) {
  const expect = turn.expect;
  const forbidden = calls.filter((call) => expect.mustNot.includes(call.name));
  if (forbidden.length > 0) return { ok: false, reason: `调用了禁止工具：${forbidden.map((call) => call.name).join(',')}` };
  if (expect.tools.length > 0 && !matchOrdered(expect.tools, calls)) {
    const attempted = calls.map((call) => call.name).join(' -> ') || '(none)';
    return { ok: false, reason: `工具序列不符合预期：${attempted}` };
  }
  if (Array.isArray(expect.anyOfTools) && expect.anyOfTools.length > 0) {
    if (!calls.some((call) => expect.anyOfTools.includes(call.name))) {
      return { ok: false, reason: `缺少任一预期工具：${expect.anyOfTools.join(' / ')}` };
    }
  }
  const expectedWriteNames = expect.tools.filter((step) => MUTATING_TOOLS.has(step.tool)).map((step) => step.tool);
  for (const name of expectedWriteNames) {
    if (!calls.some((call) => call.name === name)) continue;
    if (!confirmations.some((entry) => entry.name === name)) {
      return { ok: false, reason: `写操作 ${name} 未经确认` };
    }
  }
  return { ok: true };
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`轮次超时（${Math.round(ms / 1000)} 秒）`)), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function threadSnapshot(session) {
  const state = session.threadState();
  if (!state) return null;
  return {
    turnId: state.turnId,
    intent: state.intent,
    targets: state.targets,
    pendingConfirm: state.pendingConfirm ?? null,
    completedSteps: state.completedSteps.map((step) => ({
      step: step.step,
      tool: step.tool,
      ok: step.ok,
      code: step.code ?? null
    })),
    lastReplySummary: state.lastReplySummary
  };
}

async function runScenario(scenario, tools) {
  const bus = createFakeBus(scenario.context);
  const llm = new OpenAiCompatibleClient({ baseUrl, apiKey, model, tools, timeoutMs: turnTimeoutMs });
  let confirmMode = 'allow';
  const confirmations = [];
  const session = new AgentSession({
    llm,
    bus,
    maxIterations: MAX_ITERATIONS,
    offlineFallback: false,
    toolSchemas: Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema])),
    contextProvider: () => bus.view(),
    confirmWrite: async (name, args) => {
      confirmations.push({ name, args });
      if (confirmMode === 'timeout') throw new Error('确认超时');
      return confirmMode !== 'deny';
    }
  });

  const turns = [];
  let scenarioOk = true;
  for (const [index, turn] of scenario.turns.entries()) {
    if (turn.contextPatch) bus.updateContext(turn.contextPatch);
    confirmMode = turn.confirm ?? 'allow';
    const callStart = bus.calls.length;
    const confirmStart = confirmations.length;
    const startedAt = Date.now();
    let reply = '';
    let error = '';
    try {
      reply = await withTimeout(session.run(turn.prompt), turnTimeoutMs);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const calls = bus.calls.slice(callStart);
    const turnConfirms = confirmations.slice(confirmStart);
    const attempted = withConfirmedAttempts(calls, turnConfirms);
    const verdict = error ? { ok: false, reason: error } : evaluateTurn(turn, attempted, turnConfirms);
    if (!verdict.ok) scenarioOk = false;
    turns.push({
      round: index + 1,
      prompt: turn.prompt,
      confirm: turn.confirm ?? 'allow',
      durationMs: Date.now() - startedAt,
      actualTools: attempted.map((call) => call.name),
      confirmations: turnConfirms.map((entry) => entry.name),
      matched: verdict.ok,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
      reply: reply.length > 500 ? `${reply.slice(0, 500)}…` : (reply || error),
      thread: threadSnapshot(session)
    });
  }
  return { id: scenario.id, title: scenario.title, passed: scenarioOk, turns };
}

function summarize(scenarios) {
  const total = scenarios.length;
  const passed = scenarios.filter((scenario) => scenario.passed).length;
  const turnTotal = scenarios.reduce((sum, scenario) => sum + scenario.turns.length, 0);
  const turnPassed = scenarios.reduce((sum, scenario) => sum + scenario.turns.filter((turn) => turn.matched).length, 0);
  const durations = scenarios.flatMap((scenario) => scenario.turns.map((turn) => turn.durationMs));
  const sorted = durations.slice().sort((left, right) => left - right);
  const percentile = (ratio) => sorted.length === 0 ? 0 : sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1))];
  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    turnTotal,
    turnPassed,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95)
  };
}

function writeResult(result) {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function main() {
  const cases = loadCases();
  const startedAt = new Date().toISOString();
  if (!baseUrl || !apiKey || !model) {
    writeResult({
      generatedAt: startedAt,
      finishedAt: new Date().toISOString(),
      mode: 'skip',
      skipped: true,
      reason: '未配置 AGENT_LIVE_BASE_URL / AGENT_LIVE_API_KEY / AGENT_LIVE_MODEL',
      model: '',
      total: SCENARIO_COUNT,
      passed: 0,
      passRate: 0,
      threshold: PASS_RATE_GATE,
      gate: false,
      scenarios: []
    });
    console.log('AGENT_MULTITURN_SKIP 未配置 AGENT_LIVE_BASE_URL / AGENT_LIVE_API_KEY / AGENT_LIVE_MODEL');
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'agent-multiturn-'));
  const scenarios = [];
  try {
    const tools = new AgentTools(new PackRegistry({
      builtinDir: BUILTIN_PACKS,
      userDir: join(tempRoot, 'user'),
      stateFile: join(tempRoot, 'packs-state.json')
    })).summaries();
    for (const scenario of cases) {
      const result = await runScenario(scenario, tools);
      scenarios.push(result);
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} ${result.title} turns=${result.turns.length}`);
      for (const turn of result.turns) {
        console.log(`  ${turn.matched ? '✓' : '×'} 第 ${turn.round} 轮 [${turn.actualTools.join(' -> ') || '(none)'}] ${turn.durationMs}ms`);
        if (!turn.matched) console.log(`    ${turn.reason}`);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const totals = summarize(scenarios);
  const failures = scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      failedTurns: scenario.turns.filter((turn) => !turn.matched).map((turn) => ({
        round: turn.round,
        prompt: turn.prompt,
        reason: turn.reason,
        actualTools: turn.actualTools
      }))
    }));
  const result = {
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    mode: 'live-model',
    skipped: false,
    model,
    ...totals,
    threshold: PASS_RATE_GATE,
    gate: totals.passRate >= PASS_RATE_GATE,
    scenarios,
    failures
  };
  writeResult(result);

  console.log('');
  console.log(`模型 ${model} · 场景 ${totals.passed}/${totals.total} · passRate=${totals.passRate.toFixed(3)} · 轮次 ${totals.turnPassed}/${totals.turnTotal} · p50=${totals.p50Ms}ms p95=${totals.p95Ms}ms`);
  if (result.gate) {
    console.log(`AGENT_MULTITURN_OK passRate=${totals.passRate.toFixed(2)} scenarios=${totals.passed}/${totals.total}`);
  } else {
    for (const failure of failures) {
      for (const turn of failure.failedTurns) {
        console.error(`- ${failure.id} 第 ${turn.round} 轮：${turn.reason}`);
      }
    }
    console.error(`AGENT_MULTITURN_FAIL passRate=${totals.passRate.toFixed(2)} scenarios=${totals.passed}/${totals.total}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`AGENT_MULTITURN_FAIL ${message}`);
  process.exitCode = 1;
});
