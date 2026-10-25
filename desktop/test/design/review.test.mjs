import test from 'node:test';
import assert from 'node:assert/strict';
import { completeDesign } from '../../src/design/synthesis.ts';
import { isDesignReviewCurrent, reviewDesign } from '../../src/design/review.ts';
import { withReviewedCycle } from '../../src/design/candidates.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';

const design = completeDesign({
  process: 'screw',
  stations: 3,
  cyclePerMin: 10,
  layout: 'auto',
  processes: ['锁螺丝'],
  actuators: [],
  sensors: [],
  brand: null,
  voltage: '380VAC',
  notes: []
}, []);
const linearDesign = completeDesign({
  process: 'screw',
  stations: 3,
  cyclePerMin: 10,
  layout: 'linear',
  processes: ['锁螺丝'],
  actuators: [],
  sensors: [],
  brand: null,
  voltage: '380VAC',
  notes: []
}, []);

test('空场景将干涉初筛标记为阻断错误，而不是无干涉通过', () => {
  const review = reviewDesign(design, []);
  const unchecked = review.items.find((item) => item.title === '干涉初筛未执行');

  assert.deepEqual(review.interference, []);
  assert.equal(unchecked?.severity, 'error');
  assert.match(unchecked?.detail ?? '', /没有可检查的零件.*未执行/);
  assert.ok(review.errors >= 1);
});

test('有可检查零件时不报告空场景未执行错误', () => {
  const review = reviewDesign(design, [{
    name: '工件 A',
    bbox: { min: [0, 0, 0], max: [10, 10, 10] }
  }]);

  assert.ok(!review.items.some((item) => item.title === '干涉初筛未执行'));
});

test('校核仅对当前设计配置与 BOM 有效，写回本次计算结果不误判为过期', () => {
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(design, parts);
  const updated = {
    ...withReviewedCycle(design, review.cycle),
    power: review.power,
    cost: review.cost
  };

  assert.equal(isDesignReviewCurrent(review, updated, parts), true);
  assert.equal(isDesignReviewCurrent(review, {
    ...updated,
    config: { ...updated.config, stations: [...updated.config.stations, '新增工位'] }
  }, parts), false);
  assert.equal(isDesignReviewCurrent(review, {
    ...updated,
    bomDraft: { items: [...updated.bomDraft.items, { kind: 'actuator', name: '新气缸', qty: 1 }] }
  }, parts), false);
  assert.equal(isDesignReviewCurrent(null, updated, parts), false);
});

test('场景、元件库或价格参数变化后不能沿用旧校核', () => {
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const library = [{ id: 'part-a', packId: 'test-pack', model: 'M-A', category: '传感器', specs: {}, price: 10 }];
  const pricing = {
    power: { simultaneity: 0.7, loadFactor: 0.6, efficiency: 0.9, cosPhi: 0.9 },
    labor: { ratePerHour: 120, mechanicalHoursPerStation: 8, electricalHoursPerStation: 6, debugHoursPerStation: 4 }
  };
  const review = reviewDesign(design, parts, library, pricing);

  assert.equal(isDesignReviewCurrent(review, design, parts, library, pricing), true);
  assert.equal(isDesignReviewCurrent(review, design, [{ ...parts[0], bbox: { min: [0, 0, 0], max: [20, 10, 10] } }], library, pricing), false);
  assert.equal(isDesignReviewCurrent(review, design, parts, [...library, { ...library[0], id: 'part-b' }], pricing), false);
  assert.equal(isDesignReviewCurrent(review, design, parts, library, {
    ...pricing,
    labor: { ...pricing.labor, ratePerHour: 250 }
  }), false);
});

test('默认时间估算达到目标时仍标记未实测，不能作为节拍通过签核', () => {
  const review = reviewDesign(design, [{
    name: '工件 A',
    bbox: { min: [0, 0, 0], max: [10, 10, 10] }
  }]);
  const cycleItem = review.items.find((item) => item.title === '节拍估算（未实测）');

  assert.equal(review.cycle.meetsTarget, true, '静态估算本身仍覆盖输入目标');
  assert.equal(cycleItem?.severity, 'warning');
  assert.match(cycleItem?.detail ?? '', /模型估算产能/);
  assert.match(cycleItem?.detail ?? '', /不代表工程达标/);
  assert.match(cycleItem?.detail ?? '', /行程\/分度角（包括工程师输入）只驱动概念运动几何预览，单动作 durationMs 只用于动画预览，均不参与节拍估算/);
  assert.match(cycleItem?.detail ?? '', /可信速度\/加速度、完整动作时序、并行调度、等待\/上下料时间或现场实测数据.*不能签核/);
  assert.match(cycleItem?.detail ?? '', /运动参数来源：直线行程 工程师输入 0\/3 项，方案\/系统默认 3\/3 项；旋转分度角 工程师输入 0\/3 项，方案\/系统默认 3\/3 项/);
  assert.doesNotMatch(cycleItem?.detail ?? '', /尚缺真实行程/);
  assert.equal(review.items.some((item) => item.title === '节拍复核' && item.severity === 'pass'), false);
});

test('完整周期仍标为工程师输入/待实测，并追溯运动参数而不改写周期来源', () => {
  const designWithMotionInputs = {
    ...linearDesign,
    config: {
      ...linearDesign.config,
      actuators: [
        { id: 'ACT-C1', name: '输入行程气缸', kind: 'cylinder', station: linearDesign.config.stations[0], travelMm: 125, travelSource: 'engineer-input' },
        { id: 'ACT-G1', name: '默认行程夹爪', kind: 'gripper', station: linearDesign.config.stations[1] },
        { id: 'ACT-R1', name: '输入分度角转台', kind: 'rotary', station: linearDesign.config.stations[2], rotationRangeDeg: 180, rotationRangeSource: 'engineer-input' }
      ]
    }
  };
  const stations = linearDesign.config.stations.map((name, index) => ({
    id: `station-${index + 1}`,
    name,
    cycleTime: { seconds: [2, 4, 3][index], sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' }
  }));
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(designWithMotionInputs, parts, [], undefined, undefined, stations);
  const cycleItem = review.items.find((item) => item.title.includes('工程师输入'));

  assert.equal(review.cycle.source, 'engineer-input');
  assert.match(cycleItem?.title ?? '', /工位节拍输入（工程师输入\/待实测）/);
  assert.doesNotMatch(cycleItem?.title ?? '', /节拍估算/);
  assert.match(cycleItem?.detail ?? '', /节拍计算依据为工程师输入的完整工位周期（仍待现场实测）/);
  assert.match(cycleItem?.detail ?? '', /仅用于概念运动几何预览，单动作 durationMs 仅用于动画预览，两者均不参与周期计算/);
  assert.match(cycleItem?.detail ?? '', /直线行程 工程师输入 1\/2 项，方案\/系统默认 1\/2 项；旋转分度角 工程师输入 1\/1 项/);
});

test('完整工位周期需确认公共时间口径后才按瓶颈计算，并在保存中保留确认来源', () => {
  const stations = linearDesign.config.stations.map((name, index) => ({
    id: `station-${index + 1}`,
    name,
    cycleTime: {
      seconds: [2, 4, 3][index],
      sharedTimeConfirmed: true,
      source: 'engineer-input',
      verification: 'pending-measurement'
    }
  }));
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(linearDesign, parts, [], undefined, undefined, stations);
  const cycleItem = review.items.find((item) => item.title.includes('工程师输入'));

  assert.equal(review.cycle.source, 'engineer-input');
  assert.equal(review.cycle.bottleneckStationName, linearDesign.config.stations[1]);
  assert.equal(review.cycle.cycleSeconds, 4);
  assert.equal(review.cycle.throughputPerMin, 15);
  assert.equal(cycleItem?.severity, 'warning');
  assert.match(cycleItem?.detail ?? '', /瓶颈工位.*4\.00 秒\/件计算，产能 15\.00 件\/分钟/);
  assert.match(cycleItem?.detail ?? '', /工程师输入/);
  assert.match(cycleItem?.detail ?? '', /待实测/);
  assert.equal(isDesignReviewCurrent(review, linearDesign, parts, [], undefined, undefined, stations), true);
  assert.equal(isDesignReviewCurrent(review, linearDesign, parts, [], undefined, undefined, stations.map((station, index) => index === 0
    ? { ...station, cycleTime: { ...station.cycleTime, seconds: 2.5 } }
    : station)), false);
  const reviewed = withReviewedCycle(linearDesign, review.cycle);
  const restored = validateMachineDesign(JSON.parse(JSON.stringify(reviewed)));
  assert.equal(restored.cycle?.source, 'engineer-input');
  assert.deepEqual(restored.cycle?.stationCycleInputs?.map((item) => item.seconds), [2, 4, 3]);
  assert.ok(restored.cycle?.stationCycleInputs?.every((item) => item.verification === 'pending-measurement'));
  assert.ok(restored.cycle?.stationCycleInputs?.every((item) => item.sharedTimeConfirmed));
});

test('完整周期输入用于 parallel 时保留模型估算，但明确屏蔽人工目标结论', () => {
  const parallelDesign = { ...design, cycle: { ...design.cycle, mode: 'parallel' } };
  const stations = design.config.stations.map((name, index) => ({
    id: `station-${index + 1}`,
    name,
    cycleTime: { seconds: [2, 4, 3][index], sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' }
  }));
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(parallelDesign, parts, [], undefined, undefined, stations);
  const cycleItem = review.items.find((item) => item.title === '人工周期输入未用于产能判定');

  assert.equal(review.cycle.source, 'model-estimate');
  assert.equal(review.cycle.inputStatus, 'layout-unsupported');
  assert.equal(review.cycle.meetsTarget, parallelDesign.cycle.meetsTarget, 'preserve the model-only target comparison');
  assert.match(cycleItem?.detail ?? '', /通道映射不明确/);
  assert.match(cycleItem?.detail ?? '', /基于人工输入的目标判定已停用/);
  assert.doesNotMatch(cycleItem?.detail ?? '', /估算值覆盖目标|估算值低于目标/);
});

test('周期输入不完整时校核继续使用模板估算并说明缺少工位输入', () => {
  const stations = [
    { id: 'station-1', name: '上料', cycleTime: { seconds: 2, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } },
    { id: 'station-2', name: '锁付' }
  ];
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const review = reviewDesign(design, parts, [], undefined, undefined, stations);
  const modelReview = reviewDesign(design, parts);
  const cycleItem = review.items.find((item) => item.title === '节拍估算（未实测）');

  assert.equal(review.cycle.source, 'model-estimate');
  assert.equal(review.cycle.inputStatus, 'partial');
  assert.equal(review.cycle.throughputPerMin, modelReview.cycle.throughputPerMin);
  assert.match(cycleItem?.detail ?? '', /工位周期未完整：锁付/);
  assert.match(cycleItem?.detail ?? '', /所有工位均有大于 0 的有效值并确认公共时间口径后才会采用工程师输入/);
});

test('cell 部分或缺少周期的校核项仍声明永久布局限制并列出缺项', () => {
  const cellDesign = { ...design, cycle: { ...design.cycle, mode: 'cell' } };
  const parts = [{ name: '工件 A', bbox: { min: [0, 0, 0], max: [10, 10, 10] } }];
  const modelReview = reviewDesign(cellDesign, parts);
  const partialStations = cellDesign.config.stations.map((name, index) => index === 0
    ? { id: `station-${index + 1}`, name, cycleTime: { seconds: 2, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } }
    : { id: `station-${index + 1}`, name });
  const partial = reviewDesign(cellDesign, parts, [], undefined, undefined, partialStations);
  const partialItem = partial.items.find((item) => item.title === '人工周期输入未用于产能判定');

  assert.equal(partial.cycle.source, 'model-estimate');
  assert.equal(partial.cycle.inputStatus, 'partial');
  assert.equal(partial.cycle.meetsTarget, modelReview.cycle.meetsTarget, 'only the model comparison remains');
  assert.match(partialItem?.detail ?? '', /即使补齐也仅作记录、不参与产能计算/);
  assert.match(partialItem?.detail ?? '', /未填写：/);
  assert.doesNotMatch(partialItem?.detail ?? '', /所有工位均.*才会采用工程师输入/);

  const emptyStations = cellDesign.config.stations.map((name, index) => ({ id: `station-${index + 1}`, name }));
  const empty = reviewDesign(cellDesign, parts, [], undefined, undefined, emptyStations);
  const emptyItem = empty.items.find((item) => item.title === '人工周期输入未用于产能判定');
  assert.equal(empty.cycle.inputStatus, 'none');
  assert.equal(empty.cycle.meetsTarget, modelReview.cycle.meetsTarget);
  assert.match(emptyItem?.detail ?? '', /永久限制：人工周期即使补齐也仅作记录/);
  assert.match(emptyItem?.detail ?? '', /尚未录入工位周期/);
  assert.doesNotMatch(emptyItem?.detail ?? '', /所有工位均.*才会采用工程师输入/);
});
