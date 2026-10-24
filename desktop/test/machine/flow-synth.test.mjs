import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { chooseLayout, synthMachine } from '../../src/machine/synth.ts';

test('synth 接入：六工位锁螺丝仍由 flow 得到 parallel / 113.21 件/分钟', () => {
  const design = synthMachine(parseMachineBrief(
    '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅'
  ));
  assert.equal(design.cycle.mode, 'parallel');
  assert.equal(design.cycle.stationSeconds, 3.18);
  assert.equal(design.cycle.throughputPerMin, 113.21);
  assert.equal(design.cycle.meetsTarget, true);
  assert.equal(design.cycle.requiredTotalStations, 2);
  assert.ok(design.assumptions.some((line) => /evaluateFlow/.test(line)));
});

test('synth 接入：转盘关键词解析为 dial，分度默认 0.6 秒写入 assumptions', () => {
  const brief = parseMachineBrief('三工位转盘点胶机，20 件/分钟');
  assert.equal(brief.layout, 'dial');
  const design = synthMachine(brief);
  assert.equal(design.cycle.mode, 'dial');
  assert.equal(design.cycle.meetsTarget, false);
  assert.equal(design.cycle.requiredTotalStations, 6);
  assert.ok(design.assumptions.some((line) => /indexSeconds.*默认 0\.6/.test(line)));
});

test('synth 接入：cell 只在显式指定时使用', () => {
  const brief = { ...parseMachineBrief('四工位锁螺丝机，20 件/分钟'), layout: 'cell' };
  const design = synthMachine(brief);
  assert.equal(design.cycle.mode, 'cell');
  assert.ok(design.assumptions.some((line) => /单元式/.test(line)));
});

test('synth 接入：layout=auto 的推断结果写入 assumptions', () => {
  const brief = { ...parseMachineBrief('三工位锁螺丝机，20 件/分钟'), layout: 'auto' };
  const design = synthMachine(brief);
  assert.equal(design.cycle.mode, 'parallel');
  assert.ok(design.assumptions.some((line) => /布局自动推断为 parallel/.test(line)));
});

test('chooseLayout：几何布局与显式 parallel/cell 可区分', () => {
  assert.equal(chooseLayout('screw', 1), 'single');
  assert.equal(chooseLayout('screw', 8), 'dial');
  assert.equal(chooseLayout('inspection', 3), 'linear');
  assert.equal(chooseLayout('screw', 6, { sameProcess: true }), 'parallel');
  assert.equal(chooseLayout('assembly', 2, { cell: true }), 'cell');
});
