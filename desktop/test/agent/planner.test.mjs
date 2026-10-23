import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import {
  PLAN_CONFIDENCE_THRESHOLD,
  describePlanStep,
  executePlan,
  plan
} from '../../src/agent/planner.ts';

const REGISTERED = new Set(new AgentTools({ listParts: () => [] }).summaries().map((tool) => tool.name));

function step(tool, args = {}, readOnly = false) {
  return { tool, args, why: `${tool} why`, readOnly };
}

function noConfirm() {
  throw new Error('不应请求确认');
}

test('组合 1：查件 → 放置 → 电气校验', () => {
  const result = plan('查一下 MXQ20-32-50 气缸，放到 40, 60，然后做电气校验');
  assert.equal(result.refused, undefined);
  assert.deepEqual(result.steps.map((item) => item.tool), [
    'search_components',
    'place_component',
    'run_electrical_check'
  ]);
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(result.steps[1].args.partId, 'MXQ20-32-50');
  assert.equal(result.steps[1].args.x, 40);
  assert.equal(result.steps[1].args.y, 60);
  assert.equal(result.steps[0].readOnly, true);
  assert.equal(result.steps[1].readOnly, false);
  assert.equal(result.steps[2].readOnly, true);
  assert.match(result.steps[1].why, /可撤销/);
});

test('组合 1 参数不全时保留步骤并点名缺失参数', () => {
  const result = plan('查一下 SMC 气缸，放到 40, 60，然后做电气校验');
  assert.deepEqual(result.steps.map((item) => item.tool), [
    'search_components',
    'place_component',
    'run_electrical_check'
  ]);
  assert.deepEqual(result.steps[1].missing, ['partId']);
  assert.ok(result.confidence >= PLAN_CONFIDENCE_THRESHOLD);
});

test('组合 2：BOM → 成本 → 导出（CSV）', () => {
  const result = plan('读一下当前 BOM，算一下成本，然后导出 CSV 报价单');
  assert.deepEqual(result.steps.map((item) => item.tool), [
    'get_bom',
    'run_cost_report',
    'export_cost_report'
  ]);
  assert.deepEqual(result.steps[2].args, { format: 'csv' });
  assert.equal(result.steps[2].readOnly, false);
  assert.match(result.steps[2].why, /需确认/);
});

test('组合 2 默认 PDF', () => {
  const result = plan('查 BOM，算成本，然后导出报价单');
  assert.equal(result.steps[2].tool, 'export_cost_report');
  assert.deepEqual(result.steps[2].args, { format: 'pdf' });
});

test('组合 3：导入 CAD → 干涉初筛', () => {
  const result = plan('导入 CAD 文件 D:\\models\\fixture.step，然后做干涉检查');
  assert.deepEqual(result.steps.map((item) => item.tool), ['import_cad', 'run_interference_check']);
  assert.deepEqual(result.steps[0].args, { path: 'D:\\models\\fixture.step' });
  assert.equal(result.steps[0].readOnly, false);
  assert.equal(result.steps[1].readOnly, true);
});

test('组合 3 缺少路径时仍给计划但标记参数缺失', () => {
  const result = plan('导入 CAD 文件然后检查干涉');
  assert.deepEqual(result.steps.map((item) => item.tool), ['import_cad', 'run_interference_check']);
  assert.deepEqual(result.steps[0].missing, ['path']);
  assert.ok(result.confidence >= PLAN_CONFIDENCE_THRESHOLD);
});

test('组合 4：PLC 生成与模拟由只读 verify_plc_program 一次完成', () => {
  const result = plan('生成 PLC 程序并模拟验证');
  assert.deepEqual(result.steps.map((item) => item.tool), ['verify_plc_program']);
  assert.equal(result.steps[0].readOnly, true);
  assert.match(result.steps[0].why, /不落盘/);
});

test('组合 5：同步工具已注册时生成需确认的上传步骤', () => {
  const result = plan('生成设计包并同步到智慧工厂', {
    tools: [...REGISTERED, 'sync_design_package'],
    deviceId: 'SF-2026-01',
    baseUrl: 'https://factory.example.com'
  });
  assert.deepEqual(result.steps.map((item) => item.tool), ['sync_design_package']);
  assert.equal(result.steps[0].readOnly, false);
  assert.equal(result.steps[0].args.deviceId, 'SF-2026-01');
  assert.equal(result.steps[0].args.baseUrl, 'https://factory.example.com');
});

test('组合 5：工具未注册时过滤并拒绝执行，不编造工具', () => {
  const result = plan('生成设计包并同步到智慧工厂');
  assert.equal(result.refused, true);
  assert.deepEqual(result.steps, []);
  assert.ok(result.warnings?.some((warning) => warning.includes('sync_design_package')));
  assert.ok(result.suggestions?.length > 0);
});

test('未注册工具从多步计划中过滤并记 warning', () => {
  const result = plan('查一下 MXQ20-32-50 气缸，放到 40, 60，然后做电气校验', {
    tools: ['search_components', 'place_component']
  });
  assert.deepEqual(result.steps.map((item) => item.tool), ['search_components', 'place_component']);
  assert.ok(result.warnings?.some((warning) => warning.includes('run_electrical_check')));
});

test('规则不命中时 refused，不硬猜工具', () => {
  const result = plan('今天天气怎么样');
  assert.equal(result.refused, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.confidence, 0.2);
  assert.ok(result.reason);
  assert.ok(result.suggestions?.length > 0);
});

test('置信度低于阈值时拒绝', () => {
  const result = plan('查一下 SMC 气缸，再算一下整机成本', { minConfidence: 0.9 });
  assert.equal(result.refused, true);
  assert.deepEqual(result.steps, []);
  assert.match(result.reason ?? '', /置信度.*低于阈值/);
});

test('计划输出确定：同一输入重复调用完全一致', () => {
  const text = '读一下当前 BOM，算一下成本，然后导出 CSV 报价单';
  assert.deepEqual(plan(text), plan(text));
});

test('所有默认计划步骤都来自 tools.ts 注册表', () => {
  const inputs = [
    '查一下 MXQ20-32-50 气缸，放到 40, 60，然后做电气校验',
    '读一下当前 BOM，算一下成本，然后导出 CSV 报价单',
    '导入 CAD 文件 D:\\models\\fixture.step，然后做干涉检查',
    '生成 PLC 程序并模拟验证'
  ];
  for (const input of inputs) {
    for (const item of plan(input).steps) {
      assert.ok(REGISTERED.has(item.tool), `${input} 生成了未注册工具 ${item.tool}`);
    }
  }
});

test('评估集 5 条多步用例都能由 planner 覆盖', () => {
  const cases = [
    ['读一下当前 BOM，然后查一下 24V 开关电源', ['get_bom', 'search_components']],
    ['先查左边第二个气缸和底座有没有干涉，再做电气校验', ['run_interference_check', 'run_electrical_check']],
    ['先查一下 SMC 气缸，再算一下整机成本', ['search_components', 'run_cost_report']],
    ['查一下 SMC 气缸并插入到 2 号工位', ['search_components', 'insert_component']],
    ['读一下当前 BOM，然后导出一份 PDF 报价单', ['get_bom', 'export_cost_report']]
  ];
  for (const [input, tools] of cases) {
    const result = plan(input);
    assert.equal(result.refused, undefined, input);
    assert.deepEqual(result.steps.map((item) => item.tool), tools, input);
  }
});

test('执行器：只读计划不请求确认，按顺序执行并记录耗时', async () => {
  const events = [];
  const times = [100, 105, 108, 120, 123, 130];
  const result = await executePlan(
    {
      steps: [step('get_bom', {}, true), step('run_cost_report', {}, true)],
      confidence: 0.9
    },
    {
      confirmPlan: noConfirm,
      now: () => times.shift() ?? 120,
      execute: async (item, index) => {
        events.push(`${index}:${item.tool}`);
        return { ok: true, data: { index } };
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.confirmationRequired, false);
  assert.equal(result.confirmed, true);
  assert.deepEqual(events, ['0:get_bom', '1:run_cost_report']);
  assert.deepEqual(result.results.map((item) => item.elapsedMs), [3, 3]);
  assert.equal(result.totalMs, 30);
  assert.match(result.summary, /已完成 2\/2 步/);
});

test('执行器：有写步骤时一次性请求确认，文案汇总全部步骤', async () => {
  const calls = [];
  let confirmRequest;
  const result = await executePlan(
    {
      steps: [step('get_bom', {}, true), step('export_cost_report', { format: 'csv' })],
      confidence: 0.9
    },
    {
      confirmPlan: async (request) => {
        confirmRequest = request;
        return true;
      },
      execute: async (item) => {
        calls.push(item.tool);
        return { ok: true };
      }
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.confirmed, true);
  assert.equal(confirmRequest.totalSteps, 2);
  assert.deepEqual(confirmRequest.steps.map((item) => item.tool), ['get_bom', 'export_cost_report']);
  assert.deepEqual(confirmRequest.writeIndexes, [1]);
  assert.match(confirmRequest.message, /我准备做这 2 步/);
  assert.deepEqual(calls, ['get_bom', 'export_cost_report']);
});

test('执行器：确认被拒绝则不执行任何步骤', async () => {
  let executed = 0;
  const result = await executePlan(
    { steps: [step('get_bom', {}, true), step('place_component', { partId: 'X', x: 1, y: 2 })], confidence: 0.9 },
    {
      confirmPlan: async () => false,
      execute: async () => {
        executed += 1;
        return { ok: true };
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.confirmed, false);
  assert.equal(executed, 0);
  assert.deepEqual(result.results, []);
  assert.match(result.summary, /已取消/);
});

test('执行器：缺少确认回调时写计划中止', async () => {
  const result = await executePlan(
    { steps: [step('export_cost_report', { format: 'pdf' })], confidence: 0.9 },
    { execute: async () => ({ ok: true }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.match(result.summary, /缺少必填参数：确认回调/);
});

test('执行器：中途失败立即停止，failedAt 从 1 开始，后续不执行', async () => {
  const calls = [];
  const result = await executePlan(
    {
      steps: [step('get_bom', {}, true), step('run_cost_report', {}, true), step('export_cost_report', { format: 'pdf' })],
      confidence: 0.9
    },
    {
      confirmPlan: async () => true,
      execute: async (item, index) => {
        calls.push(item.tool);
        if (index === 1) return { ok: false, code: 'NO_PRICEBOOK', message: '价格簿缺失' };
        return { ok: true };
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 2);
  assert.equal(result.failedIndex, 1);
  assert.equal(result.failedTool, 'run_cost_report');
  assert.deepEqual(calls, ['get_bom', 'run_cost_report']);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].code, 'NO_PRICEBOOK');
  assert.match(result.summary, /已停止后续 1 步/);
});

test('执行器：成功写操作后失败时提示 undo_last', async () => {
  const result = await executePlan(
    {
      steps: [
        step('place_component', { partId: 'MXQ20-32-50', x: 10, y: 10 }),
        step('run_electrical_check', {}, true)
      ],
      confidence: 0.9
    },
    {
      confirmPlan: async () => true,
      execute: async (item) => item.tool === 'place_component'
        ? { ok: true, data: { placementId: 'p1' } }
        : { ok: false, code: 'NO_DOCUMENT', message: '没有电气文档' }
    }
  );
  assert.equal(result.ok, false);
  assert.ok(result.undoHint?.includes('undo_last'));
  assert.match(result.undoHint ?? '', /回退/);
});

test('执行器：只读失败不提示撤销', async () => {
  const result = await executePlan(
    { steps: [step('get_bom', {}, true), step('run_cost_report', {}, true)], confidence: 0.9 },
    {
      execute: async (_item, index) => index === 1
        ? { ok: false, code: 'BOOM', message: '失败' }
        : { ok: true }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.undoHint, undefined);
});

test('执行器：逐步执行只跑 startAt 之后的一步', async () => {
  const calls = [];
  const result = await executePlan(
    {
      steps: [step('get_bom', {}, true), step('run_cost_report', {}, true), step('export_cost_report', { format: 'csv' })],
      confidence: 0.9
    },
    {
      startAt: 2,
      maxSteps: 1,
      confirmPlan: async () => true,
      execute: async (item, index) => {
        calls.push({ tool: item.tool, index });
        return { ok: true };
      }
    }
  );
  assert.deepEqual(calls, [{ tool: 'export_cost_report', index: 2 }]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].index, 2);
  assert.equal(result.results[0].step, 3);
  assert.equal(result.confirmationRequired, true);
});

test('执行器：工具抛异常转换为 TOOL_EXCEPTION 并停止', async () => {
  const result = await executePlan(
    { steps: [step('get_bom', {}, true), step('run_cost_report', {}, true)], confidence: 0.9 },
    {
      execute: async () => {
        throw new Error('模型服务不可用');
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.equal(result.results[0].code, 'TOOL_EXCEPTION');
  assert.match(result.results[0].message ?? '', /模型服务不可用/);
});

test('执行器：嵌套 error 结果与业务 code 正确归一化', async () => {
  const result = await executePlan(
    { steps: [step('get_bom', {}, true)], confidence: 0.9 },
    {
      execute: async () => ({ ok: false, error: { code: 'RENDERER_TIMEOUT', message: '渲染桥超时' } })
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.results[0].code, 'RENDERER_TIMEOUT');
  assert.equal(result.results[0].message, '渲染桥超时');
});

test('执行器：空/refused 计划不执行也不请求确认', async () => {
  let confirms = 0;
  const result = await executePlan(
    { steps: [], confidence: 0.2, refused: true, reason: '没有匹配到可执行规则' },
    {
      confirmPlan: async () => {
        confirms += 1;
        return true;
      },
      execute: async () => {
        throw new Error('不应执行');
      }
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(confirms, 0);
  assert.match(result.summary, /计划已拒绝/);
});

test('参数摘要可读，且无参数时显式标注', () => {
  assert.equal(describePlanStep(step('get_bom')), 'get_bom 无参数');
  assert.equal(
    describePlanStep(step('place_component', { partId: 'MXQ20-32-50', x: 1, y: 2 })),
    'place_component {"partId":"MXQ20-32-50","x":1,"y":2}'
  );
});
