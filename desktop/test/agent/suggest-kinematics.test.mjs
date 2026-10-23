import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../../src/packs/registry.ts';
import { AgentTools, compactKinematicsSuggestion } from '../../src/agent/tools.ts';
import { createAgentCommandBus, RendererBridge } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS, planTool } from '../../src/agent/router.ts';

function suggestion(id, extra = {}) {
  return {
    id,
    category: 'cylinder',
    name: `气缸 ${id}`,
    meshIds: [1, 2],
    meshNames: ['MXQ20-50 滑台', '活塞杆'],
    fixedMeshIds: [3],
    kind: 'linear',
    directionVector: [1, 0, 0],
    axis: 'x',
    direction: 1,
    offAxisDeg: 0,
    travelMm: 50,
    retractedMm: 0,
    rangeDeg: 0,
    strokeSource: 'model-code',
    modelCode: 'MXQ20-50',
    station: 'ST1',
    point: 'Y0',
    role: 'extend',
    pointCandidates: [{ point: 'Y0', score: 0.9 }],
    confidence: 0.876,
    level: 'high',
    reasons: ['型号 MXQ20-50'],
    reason: '型号 MXQ20-50 → 行程 50 mm',
    ...extra
  };
}

let sandbox;
let registry;
let bridgeResult;
let bridgeCalls;

function makeTools(result) {
  bridgeResult = result;
  bridgeCalls = [];
  const bridge = {
    async call(method) {
      bridgeCalls.push(method);
      if (method === 'suggestKinematics') return bridgeResult;
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  return new AgentTools(registry, createAgentCommandBus(registry, bridge));
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-suggest-kin-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'smc-cn', name: 'SMC', vendor: 'SMC', version: '1.0.0' }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([]));
  registry = new PackRegistry({ builtinDir: join(sandbox, 'builtin'), userDir: join(sandbox, 'user'), stateFile: join(sandbox, 'packs-state.json') });
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

test('suggest_kinematics 注册为只读工具，schema 严格且描述强调不写入', () => {
  const tools = makeTools(null);
  const tool = tools.summaries().find((item) => item.name === 'suggest_kinematics');
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['includeLow', 'limit']);
  assert.match(tool.description, /从不写入/);
  assert.equal(READ_ONLY_TOOLS.has('suggest_kinematics'), true);
  assert.equal(WRITE_TOOLS.has('suggest_kinematics'), false);
});

test('suggest_kinematics 经命令总线调用渲染层并压缩建议字段', async () => {
  const tools = makeTools({
    sourceFile: 'kinematics-assembly.stp',
    meshes: 11,
    existingParts: 0,
    summary: '识别到 1 条高置信度、1 条低置信度建议',
    stats: { meshes: 11, classified: 9, groups: 5, high: 1, low: 1, skipped: 2 },
    suggestions: [suggestion('s1')],
    lowConfidence: [suggestion('s2', { kind: 'rotary', axis: 'z', direction: -1, rangeDeg: 180, travelMm: 0, confidence: 0.41, level: 'low' })],
    skipped: [{ name: '零件17', reason: '名称与几何都不像动件' }]
  });
  const result = await tools.call('suggest_kinematics', {});
  assert.deepEqual(bridgeCalls, ['suggestKinematics']);
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.meshes, 11);
  assert.match(result.note, /未写入/);
  assert.deepEqual(result.suggestions[0], {
    id: 's1',
    name: '气缸 s1',
    category: 'cylinder',
    kind: 'linear',
    axis: '+X',
    travelMm: 50,
    strokeSource: 'model-code',
    modelCode: 'MXQ20-50',
    station: 'ST1',
    point: 'Y0',
    confidence: 0.88,
    level: 'high',
    reason: '型号 MXQ20-50 → 行程 50 mm',
    meshNames: ['MXQ20-50 滑台', '活塞杆']
  });
  assert.equal(result.lowConfidence[0].axis, '-Z');
  assert.equal(result.lowConfidence[0].rangeDeg, 180);
  assert.equal('travelMm' in result.lowConfidence[0], false);
  assert.equal('pointCandidates' in result.suggestions[0], false);
  assert.equal(result.skipped.length, 1);
});

test('suggest_kinematics includeLow=false 与 limit 截断', async () => {
  const many = Array.from({ length: 5 }, (_value, index) => suggestion(`h${index}`));
  const tools = makeTools({ meshes: 20, existingParts: 1, summary: 'x', stats: {}, suggestions: many, lowConfidence: [suggestion('l0', { level: 'low' })], skipped: [] });
  const result = await tools.call('suggest_kinematics', { includeLow: false, limit: 2 });
  assert.equal(result.suggestions.length, 2);
  assert.equal(result.lowConfidence.length, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.existingParts, 1);
});

test('suggest_kinematics 参数非法返回中文 INVALID_ARGUMENT 且不调用渲染层', async () => {
  const tools = makeTools({ meshes: 0, suggestions: [], lowConfidence: [] });
  for (const args of [{ limit: 0 }, { limit: 31 }, { limit: 1.5 }, { includeLow: 'yes' }]) {
    const result = await tools.call('suggest_kinematics', args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.match(result.message, /[\u4e00-\u9fa5]/);
  }
  assert.deepEqual(bridgeCalls, []);
});

test('未导入模型时提示先 import_cad；渲染层失败转 RENDERER_ERROR', async () => {
  const empty = await makeTools({ meshes: 0, summary: '', stats: {}, suggestions: [], lowConfidence: [], skipped: [] }).call('suggest_kinematics', {});
  assert.equal(empty.ok, true);
  assert.equal(empty.suggestions.length, 0);
  assert.match(empty.summary, /import_cad/);
  const failed = await makeTools({ ok: false, message: '渲染层尚未就绪' }).call('suggest_kinematics', {});
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'RENDERER_ERROR');
  assert.match(failed.message, /渲染层尚未就绪/);
});

test('无命令总线时返回 AGENT_UNAVAILABLE', async () => {
  const tools = new AgentTools(registry);
  const result = await tools.call('suggest_kinematics', {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_UNAVAILABLE');
});

test('compactKinematicsSuggestion 丢弃非法输入', () => {
  assert.equal(compactKinematicsSuggestion(null), null);
  assert.equal(compactKinematicsSuggestion({ name: '无 id' }), null);
});

test('自然语言路由：识别运动件 → suggest_kinematics（只读），干涉仍走干涉检查', () => {
  for (const text of ['帮我识别一下这个装配的运动件', '自动识别运动件', '找出 STEP 里的动件', '给个运动学识别建议']) {
    const plan = planTool(text);
    assert.equal(plan?.tool, 'suggest_kinematics', text);
    assert.equal(plan?.readOnly, true, text);
  }
  assert.equal(planTool('跑一下干涉检查')?.tool, 'run_interference_check');
});

test('RendererBridge 白名单放行 suggestKinematics（真实渲染桥路径）', async () => {
  const scripts = [];
  const bridge = new RendererBridge(() => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async (script) => {
        scripts.push(script);
        return { meshes: 0, suggestions: [], lowConfidence: [] };
      }
    }
  }));
  const result = await bridge.call('suggestKinematics');
  assert.equal(result.meshes, 0);
  assert.match(scripts[0], /bridge\.suggestKinematics\(/);
});
