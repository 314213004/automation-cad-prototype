import test from 'node:test';
import assert from 'node:assert/strict';
import { assessStationCycles, buildStationCycleReport, renderStationCycleEditor } from '../../src/design/station-cycle.ts';

const fallback = {
  mode: 'dial',
  stationSeconds: [3.5, 2.8],
  stationSecondsMax: 3.5,
  cycleSeconds: 4.1,
  throughputPerMin: 60 / 4.1,
  meetsTarget: true,
  requiredStations: 2,
  bottleneck: { station: 0, seconds: 3.5, op: '模型默认动作' },
  notes: ['模板默认估算']
};
const station = (id, name, seconds, sharedTimeConfirmed = true) => ({
  id,
  name,
  cycleTime: { seconds, sharedTimeConfirmed, source: 'engineer-input', verification: 'pending-measurement' }
});

test('转盘人工周期必须显式包含每次分度；确认后取瓶颈且不重复加模型分度', () => {
  const result = assessStationCycles(fallback, [station('s1', '上料', 2), station('s2', '锁付', 4), station('s3', '检测', 3)], 12);
  assert.equal(result.source, 'engineer-input');
  assert.equal(result.inputStatus, 'complete');
  assert.deepEqual(result.stationSeconds, [2, 4, 3]);
  assert.equal(result.cycleSeconds, 4);
  assert.equal(result.throughputPerMin, 15);
  assert.equal(result.meetsTarget, true);
  assert.equal(result.bottleneck.station, 1);
  assert.equal(result.bottleneckStationName, '锁付');
  assert.equal(result.mode, fallback.mode);
  assert.match(result.notes.join(' '), /每次转盘分度.*不再重复叠加/);
});

test('未确认公共时间口径时保留模板估算、停用目标判定并提示确认分度', () => {
  const stations = [station('s1', '上料', 2, false), station('s2', '锁付', 4, false)];
  const result = assessStationCycles(fallback, stations, 12);
  assert.equal(result.source, 'model-estimate');
  assert.equal(result.inputStatus, 'unconfirmed');
  assert.equal(result.meetsTarget, fallback.meetsTarget, 'preserve model comparison; it is not a manual result');
  assert.equal(result.throughputPerMin, fallback.throughputPerMin);
  assert.match(result.manualCalculationBlockedReason, /每次转盘分度/);
  const report = buildStationCycleReport(result, stations, 12);
  assert.match(report.explanation, /不输出基于这些人工值的目标判定/);
  assert.match(report.stations[0]?.verificationLabel ?? '', /公共时间口径未确认/);
});

test('parallel 和 cell 不推断每通道/整机映射，不套 max 或 lanes 除数，也不输出手工达标结果', () => {
  const stations = [station('s1', '上料', 2), station('s2', '加工', 4), station('s3', '检测', 3)];
  for (const mode of ['parallel', 'cell']) {
    const model = { ...fallback, mode };
    const result = assessStationCycles(model, stations, 12);
    assert.equal(result.source, 'model-estimate');
    assert.equal(result.inputStatus, 'layout-unsupported');
    assert.equal(result.cycleSeconds, model.cycleSeconds);
    assert.equal(result.throughputPerMin, model.throughputPerMin);
    assert.equal(result.meetsTarget, model.meetsTarget, 'preserve model comparison; it is not a manual result');
    assert.match(result.manualCalculationBlockedReason, /每条轨道还是整机周期|每个并行副本还是整机产出/);
    const report = buildStationCycleReport(result, stations, 12);
    assert.match(report.explanation, /人工值仅作记录|仅作记录/);
    assert.match(report.explanation, /不输出基于这些人工值的目标判定/);
  }
});

test('single 仅允许一个工位输入代表整机循环；多站 single 不取最大值', () => {
  const oneStation = assessStationCycles({ ...fallback, mode: 'single' }, [station('s1', '整机循环', 3)], 12);
  assert.equal(oneStation.source, 'engineer-input');
  assert.equal(oneStation.cycleSeconds, 3);
  const multipleStations = assessStationCycles({ ...fallback, mode: 'single' }, [station('s1', '上料', 2), station('s2', '锁付', 4)], 12);
  assert.equal(multipleStations.source, 'model-estimate');
  assert.equal(multipleStations.inputStatus, 'layout-unsupported');
  assert.equal(multipleStations.meetsTarget, fallback.meetsTarget);
});

test('未填、部分填写和非正周期不会当作 0 或工程节拍，继续回退模板估算', () => {
  const none = assessStationCycles(fallback, [{ id: 's1', name: '上料' }], 12);
  assert.equal(none.source, 'model-estimate');
  assert.equal(none.inputStatus, 'none');
  assert.equal(none.throughputPerMin, fallback.throughputPerMin);

  const partial = assessStationCycles(fallback, [station('s1', '上料', 2), { id: 's2', name: '检测' }], 12);
  assert.equal(partial.source, 'model-estimate');
  assert.equal(partial.inputStatus, 'partial');
  assert.deepEqual(partial.missingStations, ['检测']);
  assert.equal(partial.throughputPerMin, fallback.throughputPerMin);

  const invalid = assessStationCycles(fallback, [station('s1', '上料', 0), station('s2', '检测', 2)], 12);
  assert.equal(invalid.source, 'model-estimate');
  assert.equal(invalid.inputStatus, 'invalid');
  assert.deepEqual(invalid.invalidStations, ['上料']);
  assert.equal(invalid.throughputPerMin, fallback.throughputPerMin);
  assert.deepEqual(invalid.stationCycleInputs.map((item) => item.seconds), [2], 'zero/negative values remain in the draft/report, not persisted as valid engineer inputs');
});

test('cell 布局在部分或缺少周期时仍显示永久限制并保留输入缺项', () => {
  const cellFallback = { ...fallback, mode: 'cell' };
  const partialStations = [station('s1', '上料', 2), { id: 's2', name: '检测' }];
  const partial = assessStationCycles(cellFallback, partialStations, 12);
  assert.equal(partial.source, 'model-estimate');
  assert.equal(partial.inputStatus, 'partial');
  assert.deepEqual(partial.missingStations, ['检测']);
  assert.equal(partial.manualCalculationBlockedReason, '单元/多轨布局没有说明输入是每条轨道还是整机周期，也没有工位到通道的映射；不能擅自除以轨道数，人工周期仅记录，目标判定已停用。');
  assert.equal(partial.meetsTarget, cellFallback.meetsTarget, 'only the model target comparison remains');
  assert.match(partial.notes.join(' '), /即使补齐也不会参与产能计算/);
  const partialReport = buildStationCycleReport(partial, partialStations, 12);
  assert.match(partialReport.inputStatusLabel, /仅录入 1\/2 个工位.*未填写：检测.*永久布局限制/);
  assert.match(partialReport.explanation, /人工周期仅记录/);
  assert.match(partialReport.explanation, /不会参与产能计算/);
  assert.match(partialReport.explanation, /不输出基于这些人工值的目标判定/);

  const emptyStations = [{ id: 's1', name: '上料' }, { id: 's2', name: '检测' }];
  const empty = assessStationCycles(cellFallback, emptyStations, 12);
  assert.equal(empty.inputStatus, 'none');
  assert.ok(empty.manualCalculationBlockedReason);
  const emptyReport = buildStationCycleReport(empty, emptyStations, 12);
  assert.match(emptyReport.inputStatusLabel, /无周期输入.*未填写：上料、检测.*永久布局限制/);
  assert.doesNotMatch(emptyReport.explanation, /全部工位.*才会切换为工程师输入计算/);
});

test('工位周期输入 UI 清楚区分未填写与工程师输入待实测，并解释完整周期口径', () => {
  const blank = renderStationCycleEditor({ id: 's1', name: '上料' }, 0, 'dial', 2);
  assert.match(blank, /工位完整动作周期（秒\/件）/);
  assert.match(blank, /data-station-cycle="0"/);
  assert.match(blank, /未填写；暂用模板估算/);
  assert.match(blank, /durationMs/);
  assert.match(blank, /按最慢完整周期计算产能（60 ÷ 秒\/件）/);
  assert.match(blank, /每次转盘分度/);
  assert.match(blank, /data-cycle-coverage="0"/);

  const entered = renderStationCycleEditor(station('s1', '工位 <A>', 2.75), 1, 'dial', 2);
  assert.match(entered, /value="2\.75"/);
  assert.match(entered, /工程师输入 · 待实测/);
  assert.match(entered, /工位 &lt;A&gt;完整工位周期/);
});

test('完整输入的工程报告逐工位标明工程师输入待实测，并只标记实际输入瓶颈', () => {
  const stations = [station('s1', '上料', 2), station('s2', '锁付', 4), station('s3', '检测', 3)];
  const assessment = assessStationCycles(fallback, stations, 12);
  const report = buildStationCycleReport(assessment, stations, 12);

  assert.equal(report.calculationSource, 'engineer-input');
  assert.match(report.calculationSourceLabel, /工程师输入.*待实测/);
  assert.match(report.inputStatusLabel, /完整且口径已确认：3 个工位均有有效输入/);
  assert.match(report.bottleneckLabel, /工程师输入瓶颈：锁付.*4\.00 秒\/件/);
  assert.deepEqual(report.stations.map((row) => row.seconds), [2, 4, 3]);
  assert.ok(report.stations.every((row) => row.sourceLabel === '工程师输入'));
  assert.ok(report.stations.every((row) => row.verificationLabel.includes('待实测')));
  assert.deepEqual(report.stations.map((row) => row.bottleneck), [false, true, false]);
});

test('部分或无效输入的工程报告明确列出未填/无效工位，输入不作为产能计算依据', () => {
  const partialStations = [station('s1', '上料', 2), { id: 's2', name: '检测' }];
  const partial = buildStationCycleReport(assessStationCycles(fallback, partialStations, 12), partialStations, 12);

  assert.equal(partial.calculationSource, 'model-estimate');
  assert.match(partial.calculationSourceLabel, /模型估算（未实测）/);
  assert.match(partial.inputStatusLabel, /仅录入 1\/2 个工位.*未填写：检测/);
  assert.match(partial.explanation, /已填写的工程师周期仅作记录，未参与本次产能计算/);
  assert.equal(partial.stations[0]?.sourceLabel, '工程师输入');
  assert.match(partial.stations[0]?.verificationLabel ?? '', /待实测.*未参与产能计算/);
  assert.equal(partial.stations[0]?.bottleneck, false);
  assert.equal(partial.stations[1]?.state, 'not-entered');
  assert.equal(partial.stations[1]?.seconds, null);

  const invalidStations = [station('s1', '上料', 0), { id: 's2', name: '检测' }];
  const invalid = buildStationCycleReport(assessStationCycles(fallback, invalidStations, 12), invalidStations, 12);
  assert.match(invalid.inputStatusLabel, /未填写：检测.*无效：上料/);
  assert.match(invalid.stations[0]?.verificationLabel ?? '', /无效值；未参与产能计算/);
});
