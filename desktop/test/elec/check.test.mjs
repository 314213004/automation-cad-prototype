import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ampacityOf,
  checkWireNumbers,
  checkWireSections,
  classifyWireNo,
  describeCheck,
  requiredSection,
  runElectricalCheck
} from '../../src/elec/check.ts';

function closeTo(actual, expected, tolerance = 0.01, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} 期望 ≈${expected}，实际 ${actual}`);
}

function codes(findings) {
  return findings.map((item) => item.code);
}

function wire(no, net, potential, extra = {}) {
  return { no, net, potential, from: `${net}:A`, to: `${net}:B`, ...extra };
}

test('classifyWireNo 识别相线/直流/数字线号', () => {
  assert.equal(classifyWireNo('L1'), 'phase');
  assert.equal(classifyWireNo('PE'), 'phase');
  assert.equal(classifyWireNo('24V'), 'dc');
  assert.equal(classifyWireNo('0V'), 'dc');
  assert.equal(classifyWireNo('101'), 'digital');
  assert.equal(classifyWireNo('1013'), 'digital');
});

test('classifyWireNo 对非法格式返回 invalid', () => {
  assert.equal(classifyWireNo('X1'), 'invalid');
  assert.equal(classifyWireNo('l1'), 'invalid');
  assert.equal(classifyWireNo('12'), 'invalid');
  assert.equal(classifyWireNo('10000'), 'invalid');
});

test('缺号线号给出警告并指明位置', () => {
  const findings = checkWireNumbers([wire('', 'n1', 'L1', { from: 'QF1:2', to: 'KM1:1' })]);
  assert.deepEqual(codes(findings), ['WIRE_NO_MISSING']);
  assert.equal(findings[0].severity, 'warning');
  assert.ok(findings[0].message.includes('QF1:2'));
});

test('线号格式不合规给出警告且带规范建议', () => {
  const findings = checkWireNumbers([wire('X1', 'n1', 'L1')]);
  assert.deepEqual(codes(findings), ['WIRE_NO_FORMAT']);
  assert.ok(findings[0].suggestion?.includes('L1/L2/L3'));
});

test('同一网络内重复线号只报警告', () => {
  const findings = checkWireNumbers([wire('101', 'n1', 'L1'), wire('101', 'n1', 'L2')]);
  assert.deepEqual(codes(findings), ['WIRE_NO_DUPLICATE']);
  assert.equal(findings[0].severity, 'warning');
});

test('同一线号跨网络判为错误且不再重复报重复标注', () => {
  const findings = checkWireNumbers([wire('101', 'n1', 'L1'), wire('101', 'n2', 'L1')]);
  assert.deepEqual(codes(findings), ['WIRE_NO_CROSS_NET']);
  assert.equal(findings[0].severity, 'error');
  assert.ok(findings[0].message.includes('n1'));
});

test('相线线号与电位不一致判为错误', () => {
  const findings = checkWireNumbers([wire('L1', 'n1', 'L2')]);
  assert.deepEqual(codes(findings), ['WIRE_NO_POTENTIAL_MISMATCH']);
  assert.equal(findings[0].severity, 'error');
});

test('数字线号跳号列出缺号数量与前缀', () => {
  const findings = checkWireNumbers([
    wire('101', 'n1', 'L1'),
    wire('103', 'n2', 'L1'),
    wire('104', 'n3', 'L1')
  ]);
  const gap = findings.find((item) => item.code === 'WIRE_NO_GAP');
  assert.ok(gap);
  assert.ok(gap.message.includes('1 个'));
  assert.ok(gap.message.includes('102'));
});

test('连续数字线号不报跳号', () => {
  const findings = checkWireNumbers([
    wire('101', 'n1', 'L1'),
    wire('102', 'n2', 'L1'),
    wire('103', 'n3', 'L1')
  ]);
  assert.deepEqual(codes(findings), []);
});

test('requiredSection 与 ampacityOf 按载流量表取值', () => {
  assert.equal(requiredSection(10), 1.5);
  assert.equal(requiredSection(14), 1.5);
  assert.equal(requiredSection(15), 2.5);
  assert.equal(requiredSection(0), null);
  assert.equal(requiredSection(Number.NaN), null);
  assert.equal(requiredSection(500), null);
  assert.equal(ampacityOf(4), 27);
  assert.equal(ampacityOf(7), null);
});

test('powerSummary 汇总三相电机有功/kVA/相电流', () => {
  const result = runElectricalCheck({
    loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }],
    options: { demandFactor: 0.8 }
  }).summary;
  closeTo(result.totalKw, 7.5, 0.001);
  closeTo(result.totalKva, 9.804, 0.01);
  closeTo(result.demandKw, 6, 0.001);
  closeTo(result.phaseCurrentA.L1, 11.92, 0.02);
  closeTo(result.phaseCurrentA.L3, 11.92, 0.02);
  assert.equal(result.demandFactor, 0.8);
});

test('powerSummary 单相负载只累加到对应相', () => {
  const result = runElectricalCheck({
    loads: [{ tag: 'H1', powerKw: 2, phase: 'L2' }],
    options: { demandFactor: 1 }
  }).summary;
  closeTo(result.phaseCurrentA.L2, 10.7, 0.02);
  assert.equal(result.phaseCurrentA.L1, 0);
  assert.equal(result.phaseCurrentA.L3, 0);
});

test('powerSummary 三相不平衡超过 15% 给警告', () => {
  const findings = runElectricalCheck({
    loads: [{ tag: 'H1', powerKw: 5, phase: 'L1' }]
  }).findings;
  assert.ok(codes(findings).includes('PHASE_UNBALANCE'));
});

test('powerSummary 给出主断路器与进线截面建议', () => {
  const summary = runElectricalCheck({
    loads: [{ tag: 'M1', powerKw: 7.5, phase: '3P', cosPhi: 0.85, efficiency: 0.9 }]
  }).summary;
  assert.deepEqual(summary.breakerSuggestion, { ratedA: 16, cableMm2: 2.5 });
  assert.ok(summary.findings.some((item) => item.code === 'MAIN_BREAKER_SUGGEST'));
});

test('24V 电源不足判为错误', () => {
  const summary = runElectricalCheck({
    loads: [{ tag: 'S1', powerKw: 0.24, phase: 'DC24' }],
    options: { demandFactor: 1, psuRatedA: 5 }
  }).summary;
  closeTo(summary.dcCurrentA, 10, 0.01);
  closeTo(summary.psuRequiredA, 12, 0.01);
  assert.ok(summary.findings.some((item) => item.code === 'PSU_OVERLOAD'));
  assert.equal(summary.psuMarginRatio, -1.4);
});

test('24V 电源余量低于 20% 给警告', () => {
  const summary = runElectricalCheck({
    loads: [{ tag: 'S1', powerKw: 0.24, phase: 'DC24' }],
    options: { demandFactor: 1, psuRatedA: 13 }
  }).summary;
  assert.ok(summary.findings.some((item) => item.code === 'PSU_LOW_MARGIN'));
  assert.equal(summary.psuMarginRatio !== null && summary.psuMarginRatio < 0.2, true);
});

test('额定功率非法判为错误并跳过该负载', () => {
  const summary = runElectricalCheck({
    loads: [
      { tag: 'M1', powerKw: Number.NaN, phase: '3P' },
      { tag: 'M2', powerKw: 3, phase: '3P' }
    ]
  }).summary;
  assert.ok(summary.findings.some((item) => item.code === 'LOAD_POWER_INVALID'));
  closeTo(summary.totalKw, 3, 0.001);
});

test('checkWireSections 截面不足判为错误并建议加大', () => {
  const findings = checkWireSections([{ wireNo: '101', currentA: 40, sectionMm2: 4 }]);
  const under = findings.find((item) => item.code === 'WIRE_SECTION_UNDER');
  assert.ok(under);
  assert.equal(under.severity, 'error');
  assert.ok(under.suggestion?.includes('10mm²'));
});

test('checkWireSections 未标注截面给警告', () => {
  const findings = checkWireSections([{ wireNo: '102', currentA: 20 }]);
  assert.deepEqual(codes(findings), ['WIRE_SECTION_MISSING']);
  assert.ok(findings[0].suggestion?.includes('2.5mm²'));
});

test('checkWireSections 断路器大于载流量判为错误', () => {
  const findings = checkWireSections([{ wireNo: '103', currentA: 20, sectionMm2: 4, breakerA: 32 }]);
  const oversized = findings.find((item) => item.code === 'BREAKER_OVERSIZE');
  assert.ok(oversized);
  assert.ok(oversized.message.includes('27A'));
});

test('runElectricalCheck 汇总排序并统计各级别数量', () => {
  const result = runElectricalCheck({
    wires: [wire('101', 'n1', 'L1'), wire('101', 'n2', 'L1'), wire('X9', 'n3', 'L1')],
    loads: [{ tag: 'M1', powerKw: 2.2, phase: '3P' }],
    circuits: [{ wireNo: '101', currentA: 30, sectionMm2: 2.5 }]
  });
  assert.equal(result.counts.error, result.findings.filter((item) => item.severity === 'error').length);
  assert.ok(result.counts.error >= 2);
  assert.ok(result.counts.warning >= 1);
  assert.deepEqual(
    result.findings.map((item) => item.severity),
    [...result.findings.map((item) => item.severity)].sort(
      (a, b) => ({ error: 0, warning: 1, info: 2 })[a] - ({ error: 0, warning: 1, info: 2 })[b]
    )
  );
  assert.ok(describeCheck(result).includes('电气校验'));
});

test('空文档给出无负载提示且不报错', () => {
  const result = runElectricalCheck({});
  assert.deepEqual(codes(result.findings), ['NO_LOAD']);
  assert.equal(result.counts.error, 0);
  assert.equal(result.summary.maxPhaseCurrentA, 0);
});
