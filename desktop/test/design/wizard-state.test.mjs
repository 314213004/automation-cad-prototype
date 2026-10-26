import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDraft, withBrief, withPendingBrief, withCandidates, withStations, withPlacements, mergeStationDrafts, resetActuatorTravelOnKindChange, selectCandidate, nextStep, prevStep, canAdvance, parseDesignDraft, shanghaiIso, validateStep } from '../../src/design/wizard-state.ts';
import { placementSnapshotFingerprint } from '../../src/design/layout.ts';
import { generateCandidates } from '../../src/design/candidates.ts';
import { briefToMachineBrief } from '../../src/design/wizard-state.ts';
import { geometryForDesign } from '../../src/design/footprint.ts';
import { withStationGeometryOffset } from '../../src/machine/station-layout.ts';
import { stationsFromDesign } from '../../src/design/wizard-state.ts';

const now = new Date('2026-10-25T08:00:00+08:00');
function draftAt(step = 1) {
  let draft = withBrief(initialDraft(now), { ...initialDraft().brief, name: '测试锁螺丝机', cyclePerMin: 10, stations: 3 }, now);
  const candidates = generateCandidates(briefToMachineBrief(draft.brief));
  draft = withCandidates(draft, candidates, now);
  if (step >= 2) { draft = selectCandidate(draft, 0, now); draft = nextStep(draft, now); }
  if (step >= 3) draft = nextStep(draft, now);
  if (step >= 4) { draft = withPlacements(draft, [{ id: 'station:station-1', partId: 'station-1', model: '工位 1', x: 0, y: 0, w: 140, h: 140 }], now); draft = nextStep(draft, now); }
  return draft;
}
test('需求校验定位到中文错误，产能必须大于 0', () => {
  assert.equal(canAdvance(initialDraft()), false);
  assert.throws(() => nextStep(initialDraft()), /产品\/机型名称不能为空/);
  assert.throws(() => nextStep(withBrief(initialDraft(), { ...initialDraft().brief, name: 'A', cyclePerMin: 0 })), /目标产能必须大于 0/);
});
test('五步推进/回退与各步门槛', () => {
  const second = draftAt(2);
  assert.equal(second.step, 2);
  assert.equal(canAdvance(second), true);
  const third = nextStep(second, now);
  assert.equal(third.step, 3);
  assert.equal(canAdvance(third), true);
  const noStations = withStations(third, [], now);
  assert.equal(canAdvance(noStations), false);
  const fourth = nextStep(third, now);
  assert.equal(canAdvance(fourth), false);
  const placed = withPlacements(fourth, [{ id: 'station:s1', partId: 's1', model: '上料', x: 35, y: 35, w: 140, h: 140 }], now);
  assert.equal(canAdvance(placed), true);
  assert.equal(nextStep(placed, now).step, 5);
  assert.equal(prevStep(placed, now).step, 3);
  assert.equal(prevStep(initialDraft(), now).step, 1);
});
test('草稿 JSON 往返，损坏字段回落第 1 步', () => {
  const base = draftAt(4);
  const placement = base.placements[0];
  assert.ok(placement);
  const draft = withPlacements(base, [{ ...placement, x: 42, y: 83 }], now);
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(draft)), now);
  assert.deepEqual(restored, draft);
  assert.equal(restored.version, 1);
  assert.equal(restored.placements[0]?.x, 42);
  assert.equal(restored.placements[0]?.y, 83);
  assert.match(restored.updatedAt, /\+08:00$/);
  assert.equal(parseDesignDraft({ ...draft, brief: { bad: true } }, now).step, 1);
  assert.equal(parseDesignDraft('{broken', now).step, 1);
  assert.equal(parseDesignDraft({ ...draft, candidates: [null, null, null] }, now).step, 1);
});
test('自动保存可恢复尚未通过步骤校验的有限表单值', () => {
  const base = initialDraft(now);
  const brief = {
    ...base.brief,
    name: '待补充产能的设备',
    cyclePerMin: 0,
    stations: 1.5,
    footprint: { lengthMm: 0, widthMm: 1800 }
  };
  const draft = withBrief(base, brief, now);
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(draft)), now);

  assert.deepEqual(restored.brief, brief);
  assert.ok(validateStep(restored).some((error) => error.includes('目标产能')));
  assert.ok(validateStep(restored).some((error) => error.includes('工位数')));
  assert.ok(validateStep(restored).some((error) => error.includes('占地')));
});
test('自动保存可恢复暂时没有工位或工位名称尚未填完的草稿', () => {
  const complete = draftAt(3);
  const noStations = parseDesignDraft(JSON.parse(JSON.stringify(withStations(complete, [], now))), now);
  assert.equal(noStations.step, 3);
  assert.deepEqual(noStations.stations, []);
  assert.ok(validateStep(noStations).some((error) => error.includes('至少需要 1 个工位')));

  const first = complete.stations[0];
  assert.ok(first);
  const unfinished = withStations(complete, [{ ...first, name: '' }, ...complete.stations.slice(1)], now);
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(unfinished)), now);
  assert.equal(restored.step, 3);
  assert.equal(restored.stations[0]?.name, '');
  assert.ok(validateStep(restored).some((error) => error.includes('工位名称不能为空')));
});
test('修改需求清除候选，保留工位供按名称合并', () => {
  const old = draftAt(4);
  const changed = withBrief(old, { ...old.brief, cyclePerMin: 30 }, now);
  assert.equal(changed.candidates, undefined);
  assert.equal(changed.design, undefined);
  assert.equal(changed.selectedIndex, undefined);
  assert.equal(changed.stations.length, old.stations.length);
});
test('需求、候选或工位变更后清除旧布局；工位未变时保留手工布局', () => {
  const old = draftAt(4);
  assert.ok(old.placements.length > 0);

  assert.deepEqual(withBrief(old, { ...old.brief, cyclePerMin: 30 }, now).placements, []);
  assert.deepEqual(withCandidates(old, old.candidates ?? [], now).placements, []);
  assert.deepEqual(selectCandidate(old, 1, now).placements, []);

  const editedStations = old.stations.map((station, index) => index === 0
    ? { ...station, name: `${station.name}（修改）` }
    : station);
  assert.deepEqual(withStations(old, editedStations, now).placements, []);
  assert.deepEqual(withStations(old, JSON.parse(JSON.stringify(old.stations)), now).placements, old.placements);
});
test('暂存需求自动保存恢复；撤销或取消重算时原方案、候选和二维布局均保留', () => {
  const old = draftAt(4);
  const pending = withPendingBrief(old, { ...old.brief, cyclePerMin: 27, name: '暂存的新机型名' }, now);

  assert.deepEqual(pending.brief, old.brief, '已应用需求仍与旧方案绑定');
  assert.deepEqual(pending.pendingBrief, { ...old.brief, cyclePerMin: 27, name: '暂存的新机型名' });
  assert.deepEqual(pending.candidates, old.candidates);
  assert.deepEqual(pending.design, old.design);
  assert.deepEqual(pending.placements, old.placements);

  const restored = parseDesignDraft(JSON.parse(JSON.stringify(pending)), now);
  assert.deepEqual(restored, pending, '关闭后自动保存再打开，应恢复待编辑需求和原有成果');
  const cancelled = parseDesignDraft(JSON.parse(JSON.stringify(restored)), now);
  assert.deepEqual(cancelled.candidates, old.candidates);
  assert.deepEqual(cancelled.design, old.design);
  assert.deepEqual(cancelled.placements, old.placements);

  const undone = withPendingBrief(cancelled, cancelled.brief, now);
  assert.equal(undone.pendingBrief, undefined, '恢复原需求应清除待应用状态');
  assert.deepEqual(undone.design, old.design);
  assert.deepEqual(undone.placements, old.placements);
});
test('显式应用待编辑需求后重算方案并清除旧二维布局', () => {
  const old = draftAt(4);
  const pending = withPendingBrief(old, { ...old.brief, cyclePerMin: 27 }, now);
  const applied = withBrief(pending, pending.pendingBrief, now);
  const candidates = generateCandidates(briefToMachineBrief(applied.brief));
  const replaced = withCandidates(applied, candidates, now);
  const selected = selectCandidate(replaced, 0, now);

  assert.equal(selected.brief.cyclePerMin, 27);
  assert.equal(selected.pendingBrief, undefined);
  assert.equal(selected.design?.cycle.perMin, 27);
  assert.deepEqual(selected.placements, [], '重算确认后才清除既有布局');
  assert.notDeepEqual(selected.candidates, old.candidates);
});
test('时间戳固定为 ISO 8601 +08:00', () => {
  assert.equal(shanghaiIso(new Date('2026-10-25T00:00:00Z')), '2026-10-25T08:00:00.000+08:00');
});
test('编辑工位后 BOM 使用当前执行机构/传感器，并保留已绑定型号', () => {
  const old = draftAt(3);
  const stationName = old.stations[0]?.name ?? '工位 1';
  const editedStations = [{
    id: 'station-edited',
    name: stationName,
    actuators: [{ id: 'cyl-edited', name: '推料气缸', kind: 'cylinder', station: stationName, model: 'CQ2B32-50DZ', partId: 'CQ2B32-50DZ', packId: 'smc-cn' }],
    sensors: [{ point: 'ST1-SAFE-S1', station: stationName, part: 'cyl-edited' }]
  }];

  const edited = withStations(old, editedStations, now);
  const items = edited.design?.bomDraft.items ?? [];

  assert.deepEqual(edited.design?.config.actuators, editedStations[0].actuators);
  assert.equal(items.find((item) => item.role === 'cylinder')?.qty, 1);
  assert.equal(items.find((item) => item.role === 'cylinder')?.model, 'CQ2B32-50DZ');
  assert.equal(items.find((item) => item.role === 'safety')?.qty, 1);
});
test('工位数组被原地编辑时仍检测到配置变化并清除旧布局', () => {
  const old = draftAt(4);
  const editedStations = old.stations;
  const station = editedStations[0];
  assert.ok(station);
  station.actuators = [{ id: 'cyl-in-place', name: '新气缸', kind: 'cylinder', station: station.name }];
  station.sensors = [];

  const edited = withStations(old, editedStations, now);
  const cylinder = edited.design?.bomDraft.items.find((item) => item.role === 'cylinder');

  assert.equal(cylinder?.qty, 1);
  assert.deepEqual(edited.placements, []);
  assert.equal(edited.design?.config.actuators[0]?.id, 'cyl-in-place');
});

test('工程师周期输入自动保存后可恢复，且仅改周期不清除手工布局', () => {
  const old = draftAt(4);
  const station = old.stations[0];
  assert.ok(station);
  const entered = withStations(old, old.stations.map((item, index) => index === 0
    ? { ...item, cycleTime: { seconds: 2.75, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } }
    : item), now);
  assert.deepEqual(entered.placements, old.placements);

  const restored = parseDesignDraft(JSON.parse(JSON.stringify(entered)), now);
  assert.deepEqual(restored.stations[0]?.cycleTime, {
    seconds: 2.75,
    sharedTimeConfirmed: true,
    source: 'engineer-input',
    verification: 'pending-measurement'
  });
  const legacy = JSON.parse(JSON.stringify(entered));
  delete legacy.stations[0].cycleTime.sharedTimeConfirmed;
  assert.equal(parseDesignDraft(legacy, now).stations[0]?.cycleTime?.sharedTimeConfirmed, false);
  assert.deepEqual(restored.placements, old.placements);

  const invalidDraft = withStations(restored, restored.stations.map((item, index) => index === 0
    ? { ...item, cycleTime: { seconds: 0, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } }
    : item), now);
  assert.equal(parseDesignDraft(JSON.parse(JSON.stringify(invalidDraft)), now).stations[0]?.cycleTime?.seconds, 0);
});

test('切换候选时按工位名保留周期值但重置旧布局的公共时间确认', () => {
  const old = draftAt(3);
  const preserved = old.stations.map((item, index) => index === 0
    ? { ...item, cycleTime: { seconds: 2.75, sharedTimeConfirmed: true, source: 'engineer-input', verification: 'pending-measurement' } }
    : item);
  const selected = selectCandidate(old, 1, now);
  const merged = mergeStationDrafts(selected.stations, preserved);
  const first = merged.stations.find((item) => item.name === preserved[0]?.name);

  assert.ok(merged.kept > 0);
  assert.deepEqual(first?.cycleTime, {
    seconds: 2.75,
    sharedTimeConfirmed: false,
    source: 'engineer-input',
    verification: 'pending-measurement'
  });
});

test('工程师输入的执行机构行程与来源可保存恢复，并在候选重新生成后保留', () => {
  const original = draftAt(3);
  const station = original.stations[0];
  assert.ok(station);
  const edited = withStations(original, original.stations.map((item, index) => index === 0
    ? { ...item, actuators: [{ id: 'manual-cylinder', name: '推料气缸', kind: 'cylinder', station: item.name, travelMm: 125.5, travelSource: 'engineer-input' }] }
    : item), now);
  assert.equal(edited.design?.config.actuators[0]?.travelMm, 125.5);
  assert.equal(edited.design?.config.actuators[0]?.travelSource, 'engineer-input');

  const restored = parseDesignDraft(JSON.parse(JSON.stringify(edited)), now);
  assert.equal(restored.stations[0]?.actuators[0]?.travelMm, 125.5);
  assert.equal(restored.stations[0]?.actuators[0]?.travelSource, 'engineer-input');

  const changedBrief = withBrief(restored, { ...restored.brief, cyclePerMin: 18 }, now);
  const regenerated = withCandidates(changedBrief, generateCandidates(briefToMachineBrief(changedBrief.brief)), now);
  const selected = selectCandidate(regenerated, 0, now);
  const merged = mergeStationDrafts(selected.stations, restored.stations);
  const afterRegeneration = withStations(selected, merged.stations, now);
  assert.equal(afterRegeneration.stations[0]?.actuators[0]?.travelMm, 125.5);
  assert.equal(afterRegeneration.stations[0]?.actuators[0]?.travelSource, 'engineer-input');
  assert.equal(afterRegeneration.design?.config.actuators[0]?.travelMm, 125.5);
});

test('非法或过大的直线行程在状态校验与草稿恢复中被拒绝', () => {
  const original = draftAt(3);
  const station = original.stations[0];
  assert.ok(station);
  for (const travelMm of [0, -1, 2000.1]) {
    const invalid = withStations(original, original.stations.map((item, index) => index === 0
      ? { ...item, actuators: [{ id: 'bad-cylinder', name: '无效气缸', kind: 'cylinder', station: item.name, travelMm, travelSource: 'engineer-input' }] }
      : item), now);
    assert.ok(validateStep(invalid).some((error) => /行程必须是 0\.1–2000 mm/.test(error)));
    assert.equal(parseDesignDraft(JSON.parse(JSON.stringify(invalid)), now).step, 1);
  }
});

test('状态类型切换 cylinder↔gripper 清除旧行程来源和值，并在草稿恢复后保持默认估算状态', () => {
  for (const [from, to, oldTravel] of [
    ['cylinder', 'gripper', 125],
    ['gripper', 'cylinder', 35]
  ]) {
    const original = draftAt(3);
    const station = original.stations[0];
    assert.ok(station);
    const actuator = {
      id: `switch-${from}`,
      name: '切换测试执行机构',
      kind: from,
      station: station.name,
      travelMm: oldTravel,
      travelSource: 'engineer-input'
    };
    actuator.kind = to;
    resetActuatorTravelOnKindChange(actuator);
    const changed = withStations(original, original.stations.map((item, index) => index === 0
      ? { ...item, actuators: [actuator] }
      : item), now);

    assert.equal(Object.hasOwn(changed.stations[0].actuators[0], 'travelMm'), false);
    assert.equal(Object.hasOwn(changed.stations[0].actuators[0], 'travelSource'), false);
    assert.equal(Object.hasOwn(changed.design.config.actuators[0], 'travelMm'), false);
    assert.equal(Object.hasOwn(changed.design.config.actuators[0], 'travelSource'), false);
    const restored = parseDesignDraft(JSON.parse(JSON.stringify(changed)), now);
    assert.equal(Object.hasOwn(restored.stations[0].actuators[0], 'travelMm'), false);
    assert.equal(Object.hasOwn(restored.stations[0].actuators[0], 'travelSource'), false);
  }
});

test('工程师输入旋转分度角与来源可在草稿恢复、候选重生成和主设计配置中持久化', () => {
  const original = draftAt(3);
  const edited = withStations(original, original.stations.map((item, index) => index === 0
    ? { ...item, actuators: [{ id: 'manual-rotary', name: '分度台', kind: 'rotary', station: item.name, rotationRangeDeg: 137.5, rotationRangeSource: 'engineer-input' }] }
    : item), now);
  assert.equal(edited.stations[0]?.actuators[0]?.rotationRangeDeg, 137.5);
  assert.equal(edited.design?.config.actuators[0]?.rotationRangeDeg, 137.5);
  assert.equal(edited.design?.config.actuators[0]?.rotationRangeSource, 'engineer-input');
  assert.equal(edited.design?.config.actuators[0]?.travelMm, undefined);

  const restored = parseDesignDraft(JSON.parse(JSON.stringify(edited)), now);
  assert.equal(restored.stations[0]?.actuators[0]?.rotationRangeDeg, 137.5);
  assert.equal(restored.stations[0]?.actuators[0]?.rotationRangeSource, 'engineer-input');

  const changedBrief = withBrief(restored, { ...restored.brief, cyclePerMin: 18 }, now);
  const regenerated = withCandidates(changedBrief, generateCandidates(briefToMachineBrief(changedBrief.brief)), now);
  const selected = selectCandidate(regenerated, 0, now);
  const merged = mergeStationDrafts(selected.stations, restored.stations);
  const afterRegeneration = withStations(selected, merged.stations, now);
  assert.equal(afterRegeneration.stations[0]?.actuators[0]?.rotationRangeDeg, 137.5);
  assert.equal(afterRegeneration.stations[0]?.actuators[0]?.rotationRangeSource, 'engineer-input');
  assert.equal(afterRegeneration.design?.config.actuators[0]?.rotationRangeDeg, 137.5);
  assert.equal(afterRegeneration.design?.config.actuators[0]?.rotationRangeSource, 'engineer-input');
});

test('旋转角输入越界阻断向导状态和草稿恢复；类型切换不会互串行程/角度来源', () => {
  const original = draftAt(3);
  for (const rotationRangeDeg of [0, 0.09, 360.1, Number.NaN]) {
    const invalid = withStations(original, original.stations.map((item, index) => index === 0
      ? { ...item, actuators: [{ id: 'bad-rotary', name: '无效分度台', kind: 'rotary', station: item.name, rotationRangeDeg, rotationRangeSource: 'engineer-input' }] }
      : item), now);
    assert.ok(validateStep(invalid).some((error) => /旋转分度角必须是 0\.1–360°/.test(error)));
    assert.equal(parseDesignDraft(JSON.parse(JSON.stringify(invalid)), now).step, 1);
  }

  const actuator = { id: 'switch-rotary', name: '切换分度台', kind: 'rotary', station: original.stations[0].name, rotationRangeDeg: 135, rotationRangeSource: 'engineer-input' };
  actuator.kind = 'cylinder';
  resetActuatorTravelOnKindChange(actuator);
  assert.equal(actuator.rotationRangeDeg, undefined);
  assert.equal(actuator.rotationRangeSource, undefined);
  assert.equal(actuator.travelMm, undefined);
  assert.equal(actuator.travelSource, undefined);

  actuator.kind = 'rotary';
  actuator.travelMm = 125;
  actuator.travelSource = 'engineer-input';
  resetActuatorTravelOnKindChange(actuator);
  assert.equal(actuator.rotationRangeDeg, 90);
  assert.equal(actuator.rotationRangeSource, undefined);
  assert.equal(actuator.travelMm, undefined);
  assert.equal(actuator.travelSource, undefined);
});

test('第 4 步重叠未确认不能推进；确认仅适用于当前 placements 快照', () => {
  const current = draftAt(4);
  const placements = [
    { id: 'station:first', partId: 'first', model: '上料工位', x: 0, y: 0, w: 140, h: 140 },
    { id: 'station:second', partId: 'second', model: '锁付工位', x: 20, y: 20, w: 140, h: 140 }
  ];
  const overlapping = withPlacements(current, placements, now);

  assert.ok(validateStep(overlapping).some((error) => /二维重叠冲突/.test(error)));
  assert.equal(canAdvance(overlapping), false);
  assert.throws(() => nextStep(overlapping, now), /二维重叠冲突/);

  const confirmed = {
    ...overlapping,
    layoutOverlapConfirmationFingerprint: placementSnapshotFingerprint(overlapping.placements)
  };
  assert.equal(canAdvance(confirmed), true);
  assert.equal(nextStep(confirmed, now).step, 5);
  assert.deepEqual(parseDesignDraft(JSON.parse(JSON.stringify(confirmed)), now), confirmed);

  const moved = withPlacements(confirmed, confirmed.placements.map((item, index) => index === 0
    ? { ...item, x: 5 }
    : item), now);
  assert.equal(moved.layoutOverlapConfirmationFingerprint, undefined);
  assert.equal(canAdvance(moved), false);
  assert.throws(() => nextStep(moved, now), /二维重叠冲突/);
});

test('稳定工位身份与 v2 偏移随草稿保存重开一致，需求重算不会迁移旧偏移', () => {
  const original = draftAt(3);
  const movedDesign = withStationGeometryOffset(original.design, geometryForDesign(original.design), 'st2', 125, -80);
  const moved = { ...original, design: movedDesign, stations: stationsFromDesign(movedDesign) };
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(moved)), now);
  assert.deepEqual(restored.design.stationIdentities, moved.design.stationIdentities);
  assert.deepEqual(restored.design.stationGeometryLayout, moved.design.stationGeometryLayout);
  assert.deepEqual(restored.stations.map((station) => station.id), moved.design.stationIdentities);

  const changedBrief = withBrief(restored, { ...restored.brief, cyclePerMin: 18 }, now);
  assert.match(changedBrief.stationIdentityNotice, /不会按名称或序号迁移/);
  const regenerated = withCandidates(changedBrief, generateCandidates(briefToMachineBrief(changedBrief.brief)), now);
  const ids = regenerated.candidates.map((candidate) => candidate.stationIdentities);
  assert.ok(ids.every((candidateIds) => candidateIds.every((id) => !moved.design.stationIdentities.includes(id))));
  assert.notDeepEqual(ids[0], ids[1], '不同形态候选不得隐式共享身份');
  assert.ok(regenerated.candidates.every((candidate) => candidate.stationGeometryLayout === undefined));
  const selected = selectCandidate(regenerated, 0, now);
  assert.equal(selected.design.stationGeometryLayout, undefined);
  assert.deepEqual(selected.stations.map((station) => station.id), selected.design.stationIdentities);
});

test('旧 v1 草稿重开保留编辑内容但清除不可靠偏移并显示告警', () => {
  const original = draftAt(3);
  const old = JSON.parse(JSON.stringify(original));
  const oldName = old.design.config.stations[1];
  delete old.design.stationIdentities;
  old.design.stationGeometryLayout = {
    schemaVersion: 1,
    offsets: [{ stationId: 'st2', stationName: oldName, stationIndex: 1, xMm: 125, yMm: -80 }]
  };
  old.stations = old.stations.map((station, index) => ({ ...station, id: `station-${index + 1}` }));
  const restored = parseDesignDraft(old, now);
  assert.equal(restored.step, 3);
  assert.equal(restored.stations.length, original.stations.length);
  assert.equal(restored.design.stationGeometryLayout, undefined);
  assert.ok(new Set(restored.stations.map((station) => station.id)).size === restored.stations.length);
  assert.match(restored.stationIdentityNotice, /未按名称或序号猜测/);
});

test('候选重算遇到重复工位名称不按名称猜测合并工程师编辑', () => {
  const generated = [
    { id: 'new-a', name: '工位 X', actuators: [], sensors: [] },
    { id: 'new-b', name: '工位 X', actuators: [], sensors: [] }
  ];
  const previous = [
    { id: 'old-a', name: '工位 X', actuators: [{ id: 'a', name: '编辑 A', kind: 'cylinder', station: '工位 X' }], sensors: [] },
    { id: 'old-b', name: '工位 X ', actuators: [{ id: 'b', name: '编辑 B', kind: 'cylinder', station: '工位 X ' }], sensors: [] }
  ];
  const merged = mergeStationDrafts(generated, previous);
  assert.equal(merged.kept, 0);
  assert.deepEqual(merged.stations.map((station) => station.id), ['new-a', 'new-b']);
  assert.deepEqual(merged.stations.map((station) => station.actuators), [[], []]);
});

test('损坏 v2 偏移草稿安全清除偏移并保留其他可恢复编辑', () => {
  const original = draftAt(3);
  const moved = withStationGeometryOffset(original.design, geometryForDesign(original.design), 'st2', 125, -80);
  const payload = JSON.parse(JSON.stringify({ ...original, design: moved, stations: stationsFromDesign(moved) }));
  payload.design.stationGeometryLayout.offsets[0].xMm = 'not-a-coordinate';
  payload.stations[0].name = '工程师已编辑名称';
  payload.design.config.stations[0] = '工程师已编辑名称';
  const restored = parseDesignDraft(payload, now);
  assert.equal(restored.step, 3);
  assert.equal(restored.stations[0].name, '工程师已编辑名称');
  assert.equal(restored.design.stationGeometryLayout, undefined);
  assert.match(restored.stationIdentityNotice, /偏移格式或身份映射无效/);
});
