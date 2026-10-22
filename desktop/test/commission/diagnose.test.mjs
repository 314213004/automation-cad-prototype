import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose } from '../../src/commission/diagnose.ts';

function failedStep(overrides = {}) {
  return {
    stepId: 'diag.step',
    name: '诊断步骤',
    pass: false,
    expected: 'X6 = true',
    actual: 'X6 = false',
    at: '2026-01-01T00:00:00.000Z',
    durationMs: 1500,
    ...overrides
  };
}

test('诊断：执行元件已得电但未到位', () => {
  const result = diagnose({
    step: failedStep({ message: '阶段「诊断步骤」超时（1500ms）' }),
    points: { X6: false, Y6: true, X3: true, X8: true },
    expected: { point: 'X6', value: true },
    timeoutMs: 1500
  });
  assert.equal(result[0]?.code, 'POWERED_NOT_IN_POSITION');
  assert.match(result[0]?.title ?? '', /执行元件已得电但未到位/);
  assert.ok(result[0]?.actions.some((action) => action.includes('气源压力')));
  assert.ok(result[0]?.evidence.some((item) => item.includes('Y6 已为 ON')));
});

test('诊断：输出未动作', () => {
  const result = diagnose({
    step: failedStep(),
    points: { X6: false, Y6: false, X3: true, X8: true },
    expected: { point: 'X6', value: true }
  });
  assert.equal(result[0]?.code, 'OUTPUT_NOT_ACTUATED');
  assert.ok(result[0]?.actions.some((action) => action.includes('PLC 对应输出点')));
});

test('诊断：双传感器同时触发', () => {
  const result = diagnose({
    step: failedStep({ expected: 'X7 = false', actual: 'X7 = true', message: '阶段「诊断步骤」超时（1500ms）' }),
    points: { X6: true, X7: true, Y6: true, Y7: false, X3: true, X8: true },
    expected: { point: 'X7', value: false },
    timeoutMs: 1500
  });
  assert.equal(result[0]?.code, 'DUAL_SENSOR');
  assert.match(result[0]?.title ?? '', /双传感器/);
});

test('诊断：安全回路未闭合', () => {
  const result = diagnose({
    step: failedStep({ expected: 'Y5 = true', actual: 'Y5 = false' }),
    points: { X6: false, Y6: false, X3: true, X8: false, X9: false, Y5: false },
    expected: { point: 'Y5', value: true }
  });
  assert.equal(result[0]?.code, 'SAFETY_LOOP_OPEN');
  assert.ok(result[0]?.evidence.some((item) => item.includes('X8 安全门')));
});

test('诊断：PLC 通讯异常', () => {
  const result = diagnose({
    step: failedStep({ actual: 'X6 = 读取失败：连接超时' }),
    points: { X6: false, Y6: true, X3: true, X8: true },
    expected: { point: 'X6', value: true },
    commOk: false
  });
  assert.equal(result[0]?.code, 'PLC_COMM_ERROR');
  assert.ok(result[0]?.actions.some((action) => action.includes('IP')));
});

test('诊断：PLC 未 RUN 或程序未下载', () => {
  const result = diagnose({
    step: failedStep({ durationMs: 2000, message: '阶段「诊断步骤」超时（2000ms）' }),
    points: {},
    expected: { point: 'X6', value: true },
    timeoutMs: 2000
  });
  assert.equal(result[0]?.code, 'PLC_NOT_RUNNING');
  assert.match(result[0]?.title ?? '', /PLC 未 RUN/);
  assert.ok(result[0]?.actions.some((action) => action.includes('程序已下载')));
});

test('诊断：气源压力不足', () => {
  const result = diagnose({
    step: failedStep({ name: '气源建立', expected: 'X3 = true', actual: 'X3 = false' }),
    points: { X3: false, Y3: true, X8: true },
    expected: { point: 'X3', value: true }
  });
  assert.equal(result[0]?.code, 'AIR_PRESSURE_LOW');
  assert.equal(result[0]?.severity, 'warning');
});

test('诊断：无规则命中时返回带点位快照的兜底项', () => {
  const result = diagnose({
    step: failedStep({ expected: '前置条件满足', actual: '自定义前置条件不满足' }),
    points: { X3: true, X8: true, AI0: 620 }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.code, 'UNCLASSIFIED');
  assert.ok(result[0]?.evidence.some((item) => item.includes('X3=ON')));
  assert.ok(result[0]?.evidence.some((item) => item.includes('AI0=620')));
  assert.ok((result[0]?.confidence ?? 0) > 0);
});

test('诊断：结果按置信度降序排列', () => {
  const result = diagnose({
    step: failedStep(),
    points: { X6: false, Y6: false, X3: false, Y3: true, X8: true },
    expected: { point: 'X6', value: true },
    commOk: false
  });
  const confidences = result.map((item) => item.confidence);
  assert.ok(confidences.length >= 3);
  assert.deepEqual(confidences, [...confidences].sort((left, right) => right - left));
  assert.ok(confidences.every((value) => value > 0 && value <= 1));
});

test('诊断：通讯异常优先于其他点位故障', () => {
  const result = diagnose({
    step: failedStep(),
    points: { X6: false, Y6: true, X3: false, X8: false, X9: true },
    expected: { point: 'X6', value: true },
    commOk: false
  });
  assert.equal(result[0]?.code, 'PLC_COMM_ERROR');
  assert.ok(result.some((item) => item.code === 'SAFETY_LOOP_OPEN'));
  assert.ok(result.some((item) => item.code === 'POWERED_NOT_IN_POSITION'));
  assert.ok((result[0]?.confidence ?? 0) > (result[1]?.confidence ?? 0));
});
