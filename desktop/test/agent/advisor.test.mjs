import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyAgentContext } from '../../src/agent/context.ts';
import {
  bomSignatureFromRows,
  suggestNextActions
} from '../../src/agent/advisor.ts';

function state(overrides = {}) {
  return {
    bomRows: 12,
    unplaced: 0,
    conflicts: 0,
    missingDimensions: 0,
    hasCadModel: true,
    elecCheckPassed: true,
    elecIssueCount: 0,
    costStale: false,
    plcGenerated: true,
    ...overrides
  };
}

function context(overrides = {}) {
  return {
    ...emptyAgentContext(),
    domain: 'mech',
    view: 'assembly',
    ...overrides
  };
}

function ids(suggestions) {
  return suggestions.map((suggestion) => suggestion.id);
}

test('overlap：底板重叠命中并带真实数字', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } }),
    state()
  );
  assert.equal(suggestions[0]?.id, 'overlap');
  assert.match(suggestions[0]?.title ?? '', /3/);
  assert.match(suggestions[0]?.why ?? '', /3/);
  assert.match(suggestions[0]?.why ?? '', /7/);
  assert.equal(suggestions[0]?.action.kind, 'ask');
});

test('overlap：重叠为 0 时不命中', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 0 } }),
    state()
  );
  assert.ok(!ids(suggestions).includes('overlap'));
});

test('interference-hits：已检查且有命中时命中，why 带命中数', () => {
  const suggestions = suggestNextActions(context(), state({ conflicts: 4 }));
  const hit = suggestions.find((suggestion) => suggestion.id === 'interference-hits');
  assert.ok(hit);
  assert.match(hit.why, /4/);
  assert.match(hit.why, /12/);
});

test('interference-unchecked：有 CAD 但还没检查时命中，动作是 tool', () => {
  const suggestions = suggestNextActions(context(), state({ conflicts: null }));
  const hit = suggestions.find((suggestion) => suggestion.id === 'interference-unchecked');
  assert.ok(hit);
  assert.equal(hit.action.kind, 'tool');
  assert.equal(hit.action.tool, 'run_interference_check');
});

test('interference-unchecked：没有 CAD 时不命中', () => {
  const suggestions = suggestNextActions(context(), state({ hasCadModel: false, conflicts: null }));
  assert.ok(!ids(suggestions).includes('interference-unchecked'));
});

test('missing-dimensions：缺尺寸命中，why 同时包含缺尺寸数与 BOM 行数', () => {
  const suggestions = suggestNextActions(context(), state({ missingDimensions: 5 }));
  const hit = suggestions.find((suggestion) => suggestion.id === 'missing-dimensions');
  assert.ok(hit);
  assert.match(hit.title, /5/);
  assert.match(hit.why, /5/);
  assert.match(hit.why, /12/);
});

test('elec-failed：电气校验未通过命中，优先于缺尺寸', () => {
  const suggestions = suggestNextActions(
    context(),
    state({ elecCheckPassed: false, elecIssueCount: 4, missingDimensions: 5 })
  );
  assert.equal(suggestions[0]?.id, 'elec-failed');
  assert.match(suggestions[0]?.title ?? '', /4/);
  assert.match(suggestions[0]?.why ?? '', /4/);
});

test('elec-failed：电气校验通过时不命中', () => {
  const suggestions = suggestNextActions(context(), state({ elecCheckPassed: true }));
  assert.ok(!ids(suggestions).includes('elec-failed'));
});

test('cost-stale：成本过期命中，动作为 run_cost_report', () => {
  const suggestions = suggestNextActions(context(), state({ costStale: true, plcGenerated: false }));
  const hit = suggestions.find((suggestion) => suggestion.id === 'cost-stale');
  assert.ok(hit);
  assert.equal(hit.action.kind, 'tool');
  assert.equal(hit.action.tool, 'run_cost_report');
  assert.match(hit.why, /12/);
});

test('cost-stale：成本未过期时不命中', () => {
  const suggestions = suggestNextActions(context(), state({ costStale: false }));
  assert.ok(!ids(suggestions).includes('cost-stale'));
});

test('plc-missing：元件齐但未生成 PLC 时命中', () => {
  const suggestions = suggestNextActions(context(), state({ plcGenerated: false }));
  const hit = suggestions.find((suggestion) => suggestion.id === 'plc-missing');
  assert.ok(hit);
  assert.equal(hit.action.kind, 'tool');
  assert.equal(hit.action.tool, 'run_plc_generate');
  assert.match(hit.why, /12/);
  assert.match(hit.why, /未放置 0/);
});

test('plc-missing：仍有未放置件时不命中', () => {
  const suggestions = suggestNextActions(context(), state({ plcGenerated: false, unplaced: 2 }));
  assert.ok(!ids(suggestions).includes('plc-missing'));
});

test('deliver-package：全部就绪时只给一条交付包建议', () => {
  const suggestions = suggestNextActions(context(), state());
  assert.deepEqual(ids(suggestions), ['deliver-package']);
  assert.match(suggestions[0]?.why ?? '', /12/);
  assert.equal(suggestions[0]?.action.kind, 'ask');
});

test('优先级：weight 降序，重叠排第一', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } }),
    state({ missingDimensions: 5, conflicts: null, costStale: true, plcGenerated: false })
  );
  assert.deepEqual(ids(suggestions), ['overlap', 'missing-dimensions', 'interference-unchecked']);
  assert.ok(suggestions.every((suggestion, index) => index === 0 || suggestions[index - 1].weight >= suggestion.weight));
});

test('上限：最多返回 3 条', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } }),
    state({ elecCheckPassed: false, elecIssueCount: 2, missingDimensions: 5, conflicts: null, costStale: true })
  );
  assert.equal(suggestions.length, 3);
});

test('空状态：没有任何可执行项时返回空数组', () => {
  const suggestions = suggestNextActions(
    context(),
    state({
      bomRows: 0,
      hasCadModel: false,
      conflicts: null,
      elecCheckPassed: null,
      plcGenerated: false
    })
  );
  assert.deepEqual(suggestions, []);
});

test('忽略：被忽略的建议不再返回，其余建议顺延', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } }),
    state({ missingDimensions: 5, conflicts: null }),
    { ignored: ['overlap'] }
  );
  assert.deepEqual(ids(suggestions), ['missing-dimensions', 'interference-unchecked']);
});

test('忽略后刷新不复活：同一 ignored 集合重复调用结果一致', () => {
  const input = context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } });
  const project = state({ missingDimensions: 5, conflicts: null });
  const ignored = new Set(['overlap', 'missing-dimensions']);
  const first = suggestNextActions(input, project, { ignored });
  const second = suggestNextActions(input, project, { ignored });
  assert.deepEqual(ids(first), ['interference-unchecked']);
  assert.deepEqual(ids(second), ['interference-unchecked']);
});

test('忽略全部：返回空数组，不凑数', () => {
  const input = context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } });
  const project = state({ missingDimensions: 5, conflicts: null });
  const suggestions = suggestNextActions(input, project, {
    ignored: ['overlap', 'missing-dimensions', 'interference-unchecked']
  });
  assert.deepEqual(suggestions, []);
});

test('why 不含泛泛而谈：每条建议都引用输入里的数字', () => {
  const suggestions = suggestNextActions(
    context({ plate: { width: 600, height: 400, placed: 7, overlaps: 3 } }),
    state({ elecCheckPassed: false, elecIssueCount: 2, missingDimensions: 5, conflicts: null, costStale: true })
  );
  assert.ok(suggestions.length > 0);
  for (const suggestion of suggestions) {
    assert.match(suggestion.why, /\d+/);
  }
});

test('BOM 指纹：型号或数量变化会改变，备注变化不改变', () => {
  const rows = [
    { partId: 'QF1', model: 'iC65N-C16-1P', qty: 2, note: 'A' },
    { partId: 'KM1', model: 'LC1D09', qty: 1 }
  ];
  const base = bomSignatureFromRows(rows);
  assert.equal(bomSignatureFromRows(rows.map((row) => ({ ...row, note: 'B' }))), base);
  assert.notEqual(bomSignatureFromRows(rows.map((row) => ({ ...row, qty: 3 }))), base);
  assert.notEqual(bomSignatureFromRows(rows.map((row) => ({ ...row, model: 'LC1D12' }))), base);
});
