// 多形态回归：同一 evaluateFlow 入口覆盖 6 个机型、5 种布局。
// 数字全部由公式直接算出，不对任何机型写特例。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateFlow } from '../../src/machine/flow.ts';

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

function assertEvaluation(result, expected) {
  assert.equal(result.mode, expected.mode);
  close(result.cycleSeconds, expected.cycleSeconds);
  close(result.throughputPerMin, expected.throughputPerMin, 1e-5);
  assert.equal(result.meetsTarget, expected.meetsTarget);
  assert.equal(result.requiredStations, expected.requiredStations);
  assert.equal(result.bottleneck?.station, expected.bottleneckStation);
}

test('机型 1：六工位锁螺丝（parallel）≈ 113 件/分钟', () => {
  const result = evaluateFlow({
    layout: 'parallel',
    stations: 6,
    copies: 6,
    targetPerMin: 20,
    ops: [{ id: 'screw', name: '锁螺丝', seconds: 3.18, station: 0 }]
  });
  assertEvaluation(result, {
    mode: 'parallel',
    cycleSeconds: 0.53,
    throughputPerMin: 113.207547,
    meetsTarget: true,
    requiredStations: 2,
    bottleneckStation: 0
  });
  assert.equal(result.stationSecondsMax, 3.18);
  assert.equal(result.bottleneck?.op, '锁螺丝');
});

test('机型 2：转盘式点胶（dial，3 工位 + 0.6 s 分度）', () => {
  const result = evaluateFlow({
    layout: 'dial',
    stations: 3,
    indexSeconds: 0.6,
    targetPerMin: 20,
    ops: [
      { id: 'load', name: '上料', seconds: 2.5, station: 0 },
      { id: 'dispense', name: '点胶', seconds: 3.0, station: 1 },
      { id: 'unload', name: '下料', seconds: 1.8, station: 2 }
    ]
  });
  assertEvaluation(result, {
    mode: 'dial',
    cycleSeconds: 3.6,
    throughputPerMin: 16.666667,
    meetsTarget: false,
    requiredStations: 6,
    bottleneckStation: 1
  });
  assert.deepEqual(result.stationSeconds, [2.5, 3.0, 1.8]);
  assert.equal(result.bottleneck?.op, '点胶');
});

test('机型 3：直线装配线（linear，5 工位，含 1.5 s 转移）由瓶颈工位决定', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 5,
    transferSeconds: 1.5,
    targetPerMin: 12,
    ops: [
      { id: 'load', name: '上料', seconds: 2.0, station: 0 },
      { id: 'press', name: '压装', seconds: 3.5, station: 1 },
      { id: 'screw', name: '锁螺丝', seconds: 2.5, station: 2 },
      { id: 'inspect', name: '检测', seconds: 4.0, station: 3 },
      { id: 'unload', name: '下料', seconds: 1.5, station: 4 }
    ]
  });
  assertEvaluation(result, {
    mode: 'linear',
    cycleSeconds: 5.5,
    throughputPerMin: 10.909091,
    meetsTarget: false,
    requiredStations: 10,
    bottleneckStation: 3
  });
  assert.deepEqual(result.stationSeconds, [3.5, 5.0, 4.0, 5.5, 3.0]);
  assert.equal(result.bottleneck?.op, '检测');
});

test('机型 4：单工位检测机（single），可选工序不拖慢节拍', () => {
  const result = evaluateFlow({
    layout: 'single',
    stations: 1,
    targetPerMin: 12,
    ops: [
      { id: 'load', name: '上料', seconds: 1.5, station: 0 },
      { id: 'vision', name: '视觉检测', seconds: 2.0, station: 0 },
      { id: 'unload', name: '下料', seconds: 0.5, station: 0 },
      { id: 'mark', name: '可选打标', seconds: 1.2, station: 0, optional: true }
    ]
  });
  assertEvaluation(result, {
    mode: 'single',
    cycleSeconds: 4.0,
    throughputPerMin: 15.0,
    meetsTarget: true,
    requiredStations: 1,
    bottleneckStation: 0
  });
  assert.equal(result.bottleneck?.op, '上料 + 视觉检测 + 下料');
  assert.ok(result.notes.some((note) => /可选打标/.test(note)));
});

test('机型 5：单元式（cell，2 组 × 2 工位，含 0.8 s 转移）', () => {
  const result = evaluateFlow({
    layout: 'cell',
    stations: 4,
    transferSeconds: 0.8,
    targetPerMin: 12,
    ops: [
      { id: 'c1-load', name: '上料', seconds: 1.2, station: 0 },
      { id: 'c1-screw', name: '锁螺丝', seconds: 1.8, station: 0 },
      { id: 'c2-inspect', name: '检测', seconds: 1.5, station: 1 },
      { id: 'c2-unload', name: '下料', seconds: 2.2, station: 1 }
    ]
  });
  assertEvaluation(result, {
    mode: 'cell',
    cycleSeconds: 4.5,
    throughputPerMin: 13.333333,
    meetsTarget: true,
    requiredStations: 4,
    bottleneckStation: 1
  });
  assert.equal(result.stationSecondsMax, 3.7);
});

test('机型 6：并行点胶（parallel，2 副本）', () => {
  const result = evaluateFlow({
    layout: 'parallel',
    stations: 2,
    copies: 2,
    targetPerMin: 30,
    ops: [{ id: 'dispense', name: '点胶', seconds: 2.8, station: 0 }]
  });
  assertEvaluation(result, {
    mode: 'parallel',
    cycleSeconds: 1.4,
    throughputPerMin: 42.857143,
    meetsTarget: true,
    requiredStations: 2,
    bottleneckStation: 0
  });
  assert.equal(result.stationSecondsMax, 2.8);
});
