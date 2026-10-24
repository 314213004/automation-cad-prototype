import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const caseFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');
const SIX_STATION =
  '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';
const DIAL_SIX_STATION =
  '六工位转盘锁螺丝机，节拍 10 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

test('layout 推断：出现「流水线」→ linear', () => {
  assert.equal(parseMachineBrief('三工位锁螺丝流水线，20 件/分钟').layout, 'linear');
});

test('layout 推断：出现「线体」→ linear', () => {
  assert.equal(parseMachineBrief('四工位装配线体').layout, 'linear');
});

test('layout 推断：出现「产线」→ linear', () => {
  assert.equal(parseMachineBrief('包装产线，六工位').layout, 'linear');
});

test('layout 推断：上料/锁螺丝/检测/下料多工序 → linear，并记录工序链', () => {
  const brief = parseMachineBrief('三工位：上料、锁螺丝、检测、下料，20 件/分钟');
  assert.equal(brief.layout, 'linear');
  assert.deepEqual(brief.processes, ['上料', '锁螺丝', '检测', '下料']);
});

test('layout 推断：六工位锁螺丝机（单一工艺）→ parallel', () => {
  const brief = parseMachineBrief(SIX_STATION);
  assert.equal(brief.layout, 'parallel');
  assert.deepEqual(brief.processes, ['锁螺丝']);
  assert.equal(brief.notes.some((note) => note.includes('按同工序并行估算')), true);
});

test('layout 推断：两工位点胶机（单一工艺）→ parallel', () => {
  assert.equal(parseMachineBrief('两工位点胶机，20 件/分钟').layout, 'parallel');
});

test('layout 推断：单工位锁螺丝机 → parallel', () => {
  assert.equal(parseMachineBrief('一工位锁螺丝机，20 件/分钟').layout, 'parallel');
});

test('layout 推断：单工位但写明流水线 → linear', () => {
  assert.equal(parseMachineBrief('一工位检测流水线，20 件/分钟').layout, 'linear');
});

test('layout 兜底：工艺未知且多工位 → 工位覆盖形态 + 可显式指定 layout 的 warning', () => {
  const design = synthMachine(parseMachineBrief('三工位，20 件/分钟'));
  assert.equal(design.form.id, 'dial-6');
  assert.equal(design.cycle.mode, 'dial');
  assert.ok(design.warnings.some((warning) => /未识别布局/.test(warning)));
  assert.ok(design.warnings.some((warning) => /显式指定 layout/.test(warning)));
  assert.ok(design.assumptions.some((line) => /布局按转盘分度估算/.test(line)));
});

test('dial 公式：3.18 秒/件 + 0.6 秒分度 → 15.87 件/分钟', () => {
  const design = synthMachine(parseMachineBrief(DIAL_SIX_STATION));
  assert.equal(design.form.id, 'dial-6');
  assert.equal(design.cycle.mode, 'dial');
  assert.equal(design.cycle.stationSeconds, 3.18);
  assert.equal(design.cycle.throughputPerMin, 15.87);
  assert.ok(Math.abs(design.cycle.throughputPerMin - 60 / (3.18 + 0.6)) < 0.01);
  assert.ok(design.assumptions.some((line) => line.includes('布局按转盘分度估算')));
});

test('六工位锁螺丝 20 件/分钟选中 dual-lane，双轨并行达标', () => {
  const design = synthMachine(parseMachineBrief(SIX_STATION));
  assert.equal(design.form.id, 'dual-lane');
  assert.equal(design.cycle.mode, 'cell');
  assert.equal(design.cycle.throughputPerMin, 31.75);
  assert.equal(design.cycle.meetsTarget, true);
  assert.match(design.cycle.bottleneck, /最慢工位1 单件 3\.18 秒/);
  assert.match(design.cycle.bottleneck, /2 轨并行/);
  assert.match(design.cycle.bottleneck, /31\.75 件\/分钟/);
});

test('parallel 单工位 3.18 秒/件 → 18.87 件/分钟，不达标', () => {
  const design = synthMachine(parseMachineBrief('一工位锁螺丝机，节拍 120 件/分钟，1 个气爪，1 个旋转轴'));
  assert.equal(design.cycle.mode, 'parallel');
  assert.equal(design.cycle.stationSeconds, 3.18);
  assert.equal(design.cycle.throughputPerMin, 18.87);
  assert.equal(design.cycle.meetsTarget, false);
  assert.equal(design.cycle.requiredTotalStations, 7);
  assert.ok(design.warnings.some((warning) => /并行同工序/.test(warning)));
});

test('linear 公式保持修复前逻辑：产能 = 60 / 最慢工位', () => {
  const design = synthMachine(parseMachineBrief('三工位锁螺丝流水线，20 件/分钟，每工位 1 个气爪'));
  assert.equal(design.cycle.mode, 'linear');
  assert.equal(design.cycle.stationSeconds, 2.48);
  assert.equal(design.cycle.throughputPerMin, 24.19);
  assert.equal(design.cycle.meetsTarget, true);
  assert.equal(design.cycle.requiredParallelStations, 1);
  assert.equal(design.cycle.requiredTotalStations, 3);
  assert.match(design.cycle.bottleneck, /流水线最慢工序/);
});

test('linear 不达标时建议复制瓶颈工序，并给出复制数与总工位', () => {
  const design = synthMachine(parseMachineBrief('三工位锁螺丝流水线，80 件/分钟，每工位 1 个气爪'));
  assert.equal(design.cycle.mode, 'linear');
  assert.equal(design.cycle.meetsTarget, false);
  assert.equal(design.cycle.requiredParallelStations, 4);
  assert.equal(design.cycle.requiredTotalStations, 12);
  assert.ok(design.warnings.some((warning) => /流水线节拍瓶颈/.test(warning)));
  assert.ok(design.warnings.some((warning) => /复制瓶颈工序/.test(warning)));
});

test('边界：估算产能恰好等于目标时 meetsTarget=true', () => {
  const design = synthMachine(
    parseMachineBrief('三工位锁螺丝流水线，每工位 1 个气爪'),
    { cyclePerMin: 60 / 2.48 }
  );
  assert.equal(design.cycle.mode, 'linear');
  assert.equal(design.cycle.throughputPerMin, 24.19);
  assert.equal(design.cycle.meetsTarget, true);
});

test('边界：工位数 1 时 parallel 产能等于 60 / 单工位时间', () => {
  const design = synthMachine(parseMachineBrief('一工位点胶机，每工位 1 个气爪'));
  assert.equal(design.config.stations.length, 1);
  assert.equal(design.cycle.mode, 'parallel');
  assert.equal(design.cycle.stationSeconds, 2.68);
  assert.equal(design.cycle.throughputPerMin, 22.39);
  assert.equal(design.cycle.requiredTotalStations, 1);
});

test('两种模式的 warning / bottleneck 关键词可区分', () => {
  const parallel = synthMachine(parseMachineBrief('一工位锁螺丝机，120 件/分钟，两个旋转轴'));
  const line = synthMachine(parseMachineBrief('三工位锁螺丝流水线，120 件/分钟，每工位 1 个气爪'));
  assert.match(parallel.cycle.bottleneck, /并行/);
  assert.doesNotMatch(parallel.cycle.bottleneck, /流水线最慢工序/);
  assert.match(line.cycle.bottleneck, /流水线最慢工序/);
  assert.doesNotMatch(line.cycle.bottleneck, /工位并行/);
  assert.match(parallel.warnings[0], /并行同工序/);
  assert.match(line.warnings[0], /流水线节拍瓶颈/);
});

test('显式 layout=line 覆盖解析器的 parallel 推断', () => {
  const parsed = parseMachineBrief('三工位锁螺丝机，20 件/分钟，每工位 1 个气爪');
  assert.equal(parsed.layout, 'parallel');
  const design = synthMachine({ ...parsed, layout: 'line' });
  assert.equal(design.cycle.mode, 'linear');
  assert.equal(design.cycle.throughputPerMin, 24.19);
});

test('案例 json：mode=cell、throughput=31.75、meetsTarget=true', () => {
  const stored = JSON.parse(readFileSync(caseFile, 'utf8'));
  assert.equal(stored.design.form.id, 'dual-lane');
  assert.equal(stored.design.cycle.mode, 'cell');
  assert.equal(stored.design.cycle.stationSeconds, 3.18);
  assert.equal(stored.design.cycle.throughputPerMin, 31.75);
  assert.equal(stored.design.cycle.meetsTarget, true);
  assert.equal(stored.cycleAnalysis.mode, 'cell');
  assert.equal(stored.cycleAnalysis.throughputPerMin, 31.75);
  assert.equal(stored.cycleAnalysis.meetsTarget, true);
  assert.equal(stored.parsed.layout, 'parallel');
});
