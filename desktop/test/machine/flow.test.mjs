import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateFlow } from '../../src/machine/flow.ts';

function close(actual, expected, tolerance = 1e-9, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, message || `${actual} != ${expected}`);
}

const op = (station, seconds, name = `工序${station + 1}`, optional = false) => ({
  id: `op-${station}-${name}`,
  name,
  seconds,
  station,
  ...(optional ? { optional: true } : {})
});

test('single：一个工位完成全部工序，cycle = 工序时间之和', () => {
  const result = evaluateFlow({
    layout: 'single',
    stations: 1,
    ops: [op(0, 1.2, '上料'), op(0, 2.3, '检测')],
    targetPerMin: 10
  });
  assert.equal(result.mode, 'single');
  assert.deepEqual(result.stationSeconds, [3.5]);
  assert.equal(result.stationSecondsMax, 3.5);
  assert.equal(result.cycleSeconds, 3.5);
  close(result.throughputPerMin, 60 / 3.5);
  assert.equal(result.meetsTarget, true);
  assert.equal(result.requiredStations, 1);
  assert.equal(result.bottleneck?.station, 0);
});

test('linear：stationSeconds 含每站转移时间，cycle = 最慢工位', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 3,
    transferSeconds: 0.5,
    ops: [op(0, 1, '上料'), op(1, 3, '锁螺丝'), op(2, 2, '下料')]
  });
  assert.deepEqual(result.stationSeconds, [1.5, 3.5, 2.5]);
  assert.equal(result.stationSecondsMax, 3.5);
  assert.equal(result.cycleSeconds, 3.5);
  assert.equal(result.bottleneck?.station, 1);
  assert.equal(result.bottleneck?.seconds, 3.5);
  assert.equal(result.bottleneck?.op, '锁螺丝');
  assert.equal(result.meetsTarget, null);
  assert.equal(result.requiredStations, 0);
});

test('linear：同一工位多道工序先求和，再加转移时间', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 2,
    transferSeconds: 0.2,
    ops: [op(0, 1, '上料'), op(0, 0.5, '定位'), op(1, 2, '检测')]
  });
  assert.deepEqual(result.stationSeconds, [1.7, 2.2]);
  assert.equal(result.cycleSeconds, 2.2);
});

test('linear：未给 transferSeconds 时按 0 估算并写 note', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 2,
    ops: [op(0, 1), op(1, 2)]
  });
  assert.deepEqual(result.stationSeconds, [1, 2]);
  assert.ok(result.notes.some((note) => /transferSeconds.*默认 0/.test(note)));
});

test('dial：各工位同时作业，cycle = 最慢工位 + 分度时间', () => {
  const result = evaluateFlow({
    layout: 'dial',
    stations: 3,
    indexSeconds: 0.6,
    ops: [op(0, 2.5, '上料'), op(1, 3.0, '点胶'), op(2, 1.8, '下料')]
  });
  assert.deepEqual(result.stationSeconds, [2.5, 3.0, 1.8]);
  assert.equal(result.stationSecondsMax, 3.0);
  assert.equal(result.cycleSeconds, 3.6);
  assert.equal(result.bottleneck?.station, 1);
});

test('dial：未给 indexSeconds 时按默认 0.6 秒并写 note', () => {
  const result = evaluateFlow({
    layout: 'dial',
    stations: 2,
    ops: [op(0, 1), op(1, 2)]
  });
  assert.equal(result.cycleSeconds, 2.6);
  assert.ok(result.notes.some((note) => /indexSeconds.*默认 0\.6/.test(note)));
});

test('parallel：copies 个副本各做全套工序，cycle = 单套时间 / copies', () => {
  const result = evaluateFlow({
    layout: 'parallel',
    stations: 4,
    copies: 4,
    ops: [op(0, 1.2, '上料'), op(0, 1.8, '锁螺丝')]
  });
  assert.deepEqual(result.stationSeconds, [3, 3, 3, 3]);
  assert.equal(result.stationSecondsMax, 3);
  assert.equal(result.cycleSeconds, 0.75);
  assert.equal(result.throughputPerMin, 80);
  assert.equal(result.bottleneck?.station, 0);
});

test('parallel：未给 copies 时默认等于 stations，并写 note', () => {
  const result = evaluateFlow({
    layout: 'parallel',
    stations: 3,
    ops: [op(0, 2.4)]
  });
  close(result.cycleSeconds, 0.8);
  close(result.throughputPerMin, 75);
  assert.ok(result.notes.some((note) => /copies.*stations=3/.test(note)));
});

test('cell：组内工序串行、组间并行，cycle = 最慢组 + 转移时间', () => {
  const result = evaluateFlow({
    layout: 'cell',
    stations: 4,
    transferSeconds: 0.8,
    ops: [op(0, 1.2, '上料'), op(0, 1.8, '锁螺丝'), op(1, 1.5, '检测'), op(1, 2.2, '下料')]
  });
  assert.deepEqual(result.stationSeconds, [3, 3.7, 0, 0]);
  assert.equal(result.stationSecondsMax, 3.7);
  assert.equal(result.cycleSeconds, 4.5);
  close(result.throughputPerMin, 60 / 4.5);
  assert.equal(result.bottleneck?.station, 1);
});

test('optional：不计入关键路径，但保留在输入与 note 中', () => {
  const result = evaluateFlow({
    layout: 'single',
    stations: 1,
    ops: [op(0, 2, '检测'), op(0, 100, '可选打标', true)]
  });
  assert.equal(result.cycleSeconds, 2);
  assert.equal(result.stationSecondsMax, 2);
  assert.ok(result.notes.some((note) => /可选打标.*不计入关键路径.*成本/.test(note)));
});

test('optional：线性布局下也不放大工位时间', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 2,
    ops: [op(0, 1), op(0, 5, '可选清洗', true), op(1, 2)]
  });
  assert.deepEqual(result.stationSeconds, [1, 2]);
  assert.equal(result.cycleSeconds, 2);
});

test('requiredStations（parallel）：按最小副本数反解并向上取整', () => {
  const result = evaluateFlow({
    layout: 'parallel',
    stations: 6,
    copies: 6,
    ops: [op(0, 3.18, '锁螺丝')],
    targetPerMin: 20
  });
  assert.equal(result.meetsTarget, true);
  assert.equal(result.requiredStations, 2);
});

test('requiredStations（linear）：按瓶颈工位复制数 × 总工位', () => {
  const result = evaluateFlow({
    layout: 'linear',
    stations: 5,
    transferSeconds: 1.5,
    ops: [op(0, 2), op(1, 3.5), op(2, 2.5), op(3, 4), op(4, 1.5)],
    targetPerMin: 12
  });
  assert.equal(result.cycleSeconds, 5.5);
  assert.equal(result.meetsTarget, false);
  assert.equal(result.requiredStations, 10);
});

test('requiredStations（dial）：分度时间占用目标节拍，剩余时间决定副本数', () => {
  const result = evaluateFlow({
    layout: 'dial',
    stations: 3,
    indexSeconds: 0.6,
    ops: [op(0, 2.5), op(1, 3), op(2, 1.8)],
    targetPerMin: 20
  });
  assert.equal(result.meetsTarget, false);
  assert.equal(result.requiredStations, 6);
});

test('requiredStations（cell）：按最慢组复制数 × 总工位', () => {
  const result = evaluateFlow({
    layout: 'cell',
    stations: 4,
    transferSeconds: 0.8,
    ops: [op(0, 1.2), op(0, 1.8), op(1, 1.5), op(1, 2.2)],
    targetPerMin: 15
  });
  assert.equal(result.meetsTarget, false);
  assert.equal(result.requiredStations, 8);
});

test('requiredStations（single）：目标可达时为 1，单工位无法靠加工位达标', () => {
  const met = evaluateFlow({ layout: 'single', stations: 1, ops: [op(0, 4)], targetPerMin: 12 });
  assert.equal(met.meetsTarget, true);
  assert.equal(met.requiredStations, 1);
  const miss = evaluateFlow({ layout: 'single', stations: 1, ops: [op(0, 4)], targetPerMin: 20 });
  assert.equal(miss.meetsTarget, false);
  assert.equal(miss.requiredStations, Number.POSITIVE_INFINITY);
  assert.ok(miss.notes.some((note) => /无法通过增加工位/.test(note)));
});

test('无目标：meetsTarget=null、requiredStations=0', () => {
  const result = evaluateFlow({ layout: 'linear', stations: 1, ops: [op(0, 2)] });
  assert.equal(result.meetsTarget, null);
  assert.equal(result.requiredStations, 0);
  assert.ok(result.notes.some((note) => /未设置目标节拍/.test(note)));
});

test('非法输入：stations <= 0 抛中文错误', () => {
  for (const stations of [0, -1, 1.5]) {
    assert.throws(() => evaluateFlow({ layout: 'linear', stations, ops: [op(0, 1)] }), /工位数/);
  }
});

test('非法输入：ops 为空抛中文错误', () => {
  assert.throws(() => evaluateFlow({ layout: 'single', stations: 1, ops: [] }), /工序不能为空/);
});

test('非法输入：秒数 <= 0 抛中文错误', () => {
  for (const seconds of [0, -0.1, Number.NaN]) {
    assert.throws(() => evaluateFlow({ layout: 'linear', stations: 1, ops: [op(0, seconds)] }), /作业时间必须大于 0/);
  }
});

test('非法输入：工序工位索引越界抛中文错误', () => {
  assert.throws(() => evaluateFlow({ layout: 'linear', stations: 2, ops: [op(2, 1)] }), /工位索引/);
});

test('非法输入：目标节拍 / 转移时间 / 分度时间非法抛中文错误', () => {
  assert.throws(() => evaluateFlow({ layout: 'linear', stations: 1, ops: [op(0, 1)], targetPerMin: 0 }), /目标节拍/);
  assert.throws(() => evaluateFlow({ layout: 'linear', stations: 1, ops: [op(0, 1)], transferSeconds: -1 }), /转移时间/);
  assert.throws(() => evaluateFlow({ layout: 'dial', stations: 1, ops: [op(0, 1)], indexSeconds: -0.1 }), /分度时间/);
});

test('全部工序可选：关键路径按 0 秒处理并写 note', () => {
  const result = evaluateFlow({ layout: 'single', stations: 1, ops: [op(0, 1, '可选', true)] });
  assert.equal(result.cycleSeconds, 0);
  assert.equal(result.throughputPerMin, 0);
  assert.ok(result.notes.some((note) => /全部工序均为可选/.test(note)));
});
