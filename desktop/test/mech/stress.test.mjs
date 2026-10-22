import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boltPreload, cantileverDeflection, cylinderForce } from '../../src/mech/stress.ts';

function near(actual, expected, tolerance = 0.01) {
  const relative = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12);
  assert.ok(relative <= tolerance, `${actual} 与手算值 ${expected} 偏差 ${(relative * 100).toFixed(2)}%`);
}

test('气缸推力/拉力手算对齐', () => {
  const result = cylinderForce({ bore: 32, pressure: 0.5, efficiency: 0.85, load: 300 });
  const area = (Math.PI * 32 ** 2) / 4;
  const push = 0.5 * area * 0.85;
  near(result.push, push);
  near(result.pull, push * 0.85);
  near(result.margin, push - 300);
  near(result.safetyFactor, push / 300);
  assert.equal(result.pass, true);
  assert.match(result.formula, /F推/);
});

test('气缸推力不足时 pass=false 并给出缺口', () => {
  const result = cylinderForce({ bore: 20, pressure: 0.4, load: 500 });
  assert.equal(result.pass, false);
  assert.match(result.verdict, /推力不足/);
});

test('悬臂梁挠度与弯曲应力手算对齐（超限）', () => {
  const result = cantileverDeflection({ force: 100, length: 500, E: 70000, width: 20, height: 10 });
  const I = (20 * 10 ** 3) / 12;
  const W = (20 * 10 ** 2) / 6;
  near(result.I, I);
  near(result.delta, (100 * 500 ** 3) / (3 * 70000 * I));
  near(result.stress, (100 * 500) / W);
  near(result.allowable, 1);
  assert.equal(result.pass, false);
});

test('悬臂梁满足 L/500 时 pass=true', () => {
  const result = cantileverDeflection({ force: 10, length: 100, width: 20, height: 10 });
  near(result.delta, 0.0285714286);
  near(result.allowable, 0.2);
  near(result.stress, 3);
  assert.equal(result.pass, true);
});

test('M6 8.8 螺栓预紧力与安全系数手算对齐', () => {
  const result = boltPreload({ size: 'M6', grade: 8.8, load: 5000 });
  near(result.As, 20.1);
  near(result.F0, 0.7 * 640 * 20.1);
  near(result.safety, (0.7 * 640 * 20.1) / 5000);
  assert.equal(result.pass, true);
});

test('M8 10.9 高负载下安全系数小于 1.5', () => {
  const result = boltPreload({ size: 'M8', grade: 10.9, load: 20000 });
  near(result.F0, 0.7 * 940 * 36.6);
  near(result.safety, (0.7 * 940 * 36.6) / 20000);
  assert.equal(result.pass, false);
});

test('零值和负值抛出中文参数错误', () => {
  assert.throws(() => cylinderForce({ bore: 0, pressure: 0.5, load: 100 }), /缸径.*大于 0/);
  assert.throws(() => cylinderForce({ bore: 20, pressure: -1, load: 100 }), /压力.*大于 0/);
  assert.throws(() => cantileverDeflection({ force: 100, length: 0, width: 20, height: 10 }), /悬臂长度.*大于 0/);
  assert.throws(() => cantileverDeflection({ force: 100, length: 100, width: 0, height: 10 }), /截面宽度.*大于 0/);
  assert.throws(() => boltPreload({ size: 'M6', grade: 8.8, load: -5 }), /工作负载.*大于 0/);
  assert.throws(() => boltPreload({ size: 'M12', grade: 8.8, load: 100 }), /不支持的螺栓规格/);
});
