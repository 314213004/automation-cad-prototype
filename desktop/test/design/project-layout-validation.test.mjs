import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectLayoutValidationView,
  canSaveProjectLayout,
  projectLayoutItemStatus,
  projectLayoutOverlapConfirmation
} from '../../src/design/project-layout-validation.ts';

const item = (id, model, x, y, w = 100, h = 80) => ({ id, partId: id, model, x, y, w, h });

test('按工程包络 [长度, 宽度] 检查画布状态并生成列表与画布可用状态', () => {
  const placements = [
    item('station:a', '上料工位', 0, 0),
    item('station:b', '锁附工位', 70, 10),
    item('part:c', '越界传感器', 950, 550, 80, 60)
  ];
  const view = buildProjectLayoutValidationView(placements, [1000, 600, 900]);
  assert.equal(view.envelopeKnown, true);
  assert.deepEqual(view.outOfBounds, ['part:c']);
  assert.deepEqual(view.overlaps, [{ a: 'station:a', b: 'station:b' }]);
  assert.equal(projectLayoutItemStatus(view, 'station:a'), 'overlap');
  assert.equal(projectLayoutItemStatus(view, 'part:c'), 'out-of-bounds');
  assert.equal(view.saveBlockReason, 'out-of-bounds');
  assert.equal(view.state, 'error');
  assert.match(view.messages.join(' '), /1,000 × 600 mm/);
  assert.match(view.messages.join(' '), /越界 1 项/);
  assert.match(view.messages.join(' '), /重叠 1 处/);
  assert.equal(canSaveProjectLayout(view), false);
});

test('无包络时不编造边界，仍检查重叠并明确阻止写回', () => {
  const placements = [item('a', '工位 A', 0, 0), item('b', '工位 B', 50, 0)];
  const view = buildProjectLayoutValidationView(placements, null);
  assert.equal(view.envelopeKnown, false);
  assert.deepEqual(view.outOfBounds, []);
  assert.equal(view.saveBlockReason, 'unknown-envelope');
  assert.equal(projectLayoutItemStatus(view, 'a'), 'overlap-unchecked');
  assert.equal(canSaveProjectLayout(view, true), false);
  assert.match(view.messages.join(' '), /无法校验边界/);
  assert.match(view.messages.join(' '), /不会推测尺寸/);
});

test('只有确认重叠后才允许继续保存，并在确认文案列出冲突双方', () => {
  const placements = [item('a', '上料工位', 0, 0), item('b', '锁附工位', 20, 0)];
  const view = buildProjectLayoutValidationView(placements, [500, 300, 800]);
  assert.equal(view.saveBlockReason, null);
  assert.equal(view.state, 'warning');
  assert.equal(canSaveProjectLayout(view), false);
  assert.equal(canSaveProjectLayout(view, true), true);
  const prompt = projectLayoutOverlapConfirmation(view, placements);
  assert.match(prompt, /上料工位 ↔ 锁附工位/);
  assert.match(prompt, /工程师接受/);
  assert.match(prompt, /仍要保存/);
});

test('仅在有效工程包络内认为边界校验可用', () => {
  for (const envelope of [undefined, [0, 300, 800], [500, Number.NaN, 800]]) {
    const view = buildProjectLayoutValidationView([item('a', '工位', 0, 0)], envelope);
    assert.equal(view.envelopeKnown, false);
    assert.equal(view.saveBlockReason, 'unknown-envelope');
  }
});
