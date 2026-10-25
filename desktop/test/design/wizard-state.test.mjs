import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDraft, withBrief, withCandidates, withStations, withPlacements, selectCandidate, nextStep, prevStep, canAdvance, parseDesignDraft, shanghaiIso } from '../../src/design/wizard-state.ts';
import { generateCandidates } from '../../src/design/candidates.ts';
import { briefToMachineBrief } from '../../src/design/wizard-state.ts';

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
  const draft = draftAt(4);
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(draft)), now);
  assert.deepEqual(restored, draft);
  assert.match(restored.updatedAt, /\+08:00$/);
  assert.equal(parseDesignDraft({ ...draft, brief: { bad: true } }, now).step, 1);
  assert.equal(parseDesignDraft('{broken', now).step, 1);
  assert.equal(parseDesignDraft({ ...draft, candidates: [null, null, null] }, now).step, 1);
});
test('修改需求清除候选，保留工位供按名称合并', () => {
  const old = draftAt(4);
  const changed = withBrief(old, { ...old.brief, cyclePerMin: 30 }, now);
  assert.equal(changed.candidates, undefined);
  assert.equal(changed.design, undefined);
  assert.equal(changed.selectedIndex, undefined);
  assert.equal(changed.stations.length, old.stations.length);
});
test('时间戳固定为 ISO 8601 +08:00', () => {
  assert.equal(shanghaiIso(new Date('2026-10-25T00:00:00Z')), '2026-10-25T08:00:00.000+08:00');
});
