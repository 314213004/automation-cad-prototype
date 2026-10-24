import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MERGE_WINDOW_MS,
  ORBIT_HISTORY_LIMIT,
  UnifiedHistory,
  parseProtoCounts,
  sameOverrides
} from '../../src/orbit/history.ts';

const edit = (label, before, after, extra = {}) => ({ label, before, after, at: 1000, ...extra });
const T8 = {};
const T12 = { base: { thickness: 12 } };
const T16 = { base: { thickness: 16 } };

test('parseProtoCounts：读状态栏「撤销 N / 重做 M」，原型未初始化时返回 null', () => {
  assert.deepEqual(parseProtoCounts('撤销 3', '重做 1'), { undo: 3, redo: 1 });
  assert.deepEqual(parseProtoCounts('撤销 0', null), { undo: 0, redo: 0 });
  assert.equal(parseProtoCounts('撤销上一步：缸径 32→40', '重做 0'), null);
  assert.equal(parseProtoCounts(undefined, undefined), null);
});

test('sameOverrides：忽略键顺序与空对象', () => {
  assert.ok(sameOverrides({ a: { x: 1, y: 2 }, b: {} }, { a: { y: 2, x: 1 } }));
  assert.ok(!sameOverrides({ a: { x: 1 } }, { a: { x: 2 } }));
});

test('纯 3D 编辑：撤销换回 before、重做换回 after，栈与令牌同步', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  assert.equal(h.nextUndo(), null);
  assert.ok(h.recordOrbit(edit('厚度 8→12', T8, T12)));
  assert.equal(h.nextUndo(), 'orbit');
  assert.equal(h.peekOrbitUndo().label, '厚度 8→12');
  const u = h.takeOrbitUndo();
  assert.deepEqual(u.before, T8);
  assert.equal(h.nextUndo(), null);
  assert.equal(h.nextRedo(), 'orbit');
  const r = h.takeOrbitRedo();
  assert.deepEqual(r.after, T12);
  assert.deepEqual(h.snapshot().undoTimeline, ['orbit']);
  assert.deepEqual(h.orbitCounts(), { undo: 1, redo: 0 });
});

test('快照独立：记录后再改入参不影响栈内快照；前后相同的编辑不入栈', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  const after = { base: { thickness: 12 } };
  h.recordOrbit(edit('x', {}, after));
  after.base.thickness = 99;
  assert.equal(h.takeOrbitUndo().after.base.thickness, 12);
  assert.equal(h.recordOrbit(edit('noop', T12, { base: { thickness: 12 } })), false);
});

test('同字段 800 ms 内连续输入合并为一步，保留最初 before；改回原值则整条作废', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  h.recordOrbit(edit('8→12', T8, T12, { mergeKey: 'base::thickness', at: 1000 }));
  h.recordOrbit(edit('8→16', T12, T16, { mergeKey: 'base::thickness', at: 1000 + MERGE_WINDOW_MS }));
  assert.deepEqual(h.orbitCounts(), { undo: 1, redo: 0 });
  const top = h.peekOrbitUndo();
  assert.deepEqual(top.before, T8);
  assert.deepEqual(top.after, T16);
  assert.equal(top.label, '8→16');
  // 超出窗口：新的一步
  h.recordOrbit(edit('16→12', T16, T12, { mergeKey: 'base::thickness', at: 1000 + MERGE_WINDOW_MS * 3 }));
  assert.equal(h.orbitCounts().undo, 2);
  // 窗口内改回该步的原值 → 该步作废
  h.recordOrbit(edit('16→16', T12, T16, { mergeKey: 'base::thickness', at: 1000 + MERGE_WINDOW_MS * 3 + 10 }));
  assert.equal(h.orbitCounts().undo, 1);
  assert.deepEqual(h.snapshot().undoTimeline, ['orbit']);
});

test('不同字段 / 无 mergeKey 不合并', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  h.recordOrbit(edit('a', {}, { base: { thickness: 12 } }, { mergeKey: 'base::thickness' }));
  h.recordOrbit(edit('b', { base: { thickness: 12 } }, { base: { thickness: 12, width: 80 } }, { mergeKey: 'base::width' }));
  h.recordOrbit(edit('c', { base: { thickness: 12, width: 80 } }, {}));
  assert.equal(h.orbitCounts().undo, 3);
});

test('与原型交错：时间线按发生顺序决定 Ctrl+Z 由谁执行', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  h.observeProto({ undo: 1, redo: 0 }); // 原型：缸径 32→40
  h.recordOrbit(edit('厚度', T8, T12)); // 3D
  h.observeProto({ undo: 2, redo: 0 }); // 原型：插入零件
  assert.deepEqual(h.snapshot().undoTimeline, ['proto', 'orbit', 'proto']);
  // 第一次 Ctrl+Z：原型放行，原型计数 2→1
  assert.equal(h.nextUndo(), 'proto');
  h.observeProto({ undo: 1, redo: 1 });
  // 第二次：3D
  assert.equal(h.nextUndo(), 'orbit');
  h.takeOrbitUndo();
  // 第三次：原型
  assert.equal(h.nextUndo(), 'proto');
  h.observeProto({ undo: 0, redo: 2 });
  assert.equal(h.nextUndo(), null);
  // 重做顺序反过来：原型 → 3D → 原型
  assert.deepEqual(h.snapshot().redoTimeline, ['proto', 'orbit', 'proto']);
  assert.equal(h.nextRedo(), 'proto');
  h.observeProto({ undo: 1, redo: 1 });
  assert.equal(h.nextRedo(), 'orbit');
  h.takeOrbitRedo();
  assert.equal(h.nextRedo(), 'proto');
  h.observeProto({ undo: 2, redo: 0 });
  assert.equal(h.nextRedo(), null);
  assert.deepEqual(h.snapshot().undoTimeline, ['proto', 'orbit', 'proto']);
});

test('新动作作废另一侧的重做：原型新动作清 3D 重做；3D 新动作把原型重做记为 orphan 并拦截', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  h.recordOrbit(edit('a', T8, T12));
  h.takeOrbitUndo();
  assert.equal(h.nextRedo(), 'orbit');
  h.observeProto({ undo: 1, redo: 0 }); // 原型新动作
  assert.equal(h.nextRedo(), null);
  assert.equal(h.orbitCounts().redo, 0);

  h.observeProto({ undo: 0, redo: 1 }); // 撤销原型
  assert.equal(h.nextRedo(), 'proto');
  assert.equal(h.protoRedoBlocked(), false);
  h.recordOrbit(edit('b', T8, T16)); // 3D 新动作
  assert.equal(h.nextRedo(), null);
  assert.equal(h.protoRedoBlocked(), true);
  assert.equal(h.snapshot().protoRedoOrphans, 1);
  // 原型再有新动作，原型自己清掉重做栈，orphan 归零
  h.observeProto({ undo: 1, redo: 0 });
  assert.equal(h.protoRedoBlocked(), false);
  assert.equal(h.snapshot().protoRedoOrphans, 0);
});

test('外部撤销（Agent / ProtoApi 直接调原型）越过 3D 令牌时只搬动原型令牌', () => {
  const h = new UnifiedHistory({ undo: 1, redo: 0 });
  h.recordOrbit(edit('a', T8, T12));
  h.observeProto({ undo: 0, redo: 1 });
  assert.deepEqual(h.snapshot().undoTimeline, ['orbit']);
  assert.deepEqual(h.snapshot().redoTimeline, ['proto']);
  assert.equal(h.nextUndo(), 'orbit');
});

test('挂载前已有原型历史：全部视为更早的原型动作；原型达到上限滚动时令牌数对齐', () => {
  const h = new UnifiedHistory({ undo: 50, redo: 0 });
  assert.equal(h.snapshot().undoTimeline.length, 50);
  h.recordOrbit(edit('a', T8, T12));
  // 撤销原型一步后做了新动作（动作名不同）：计数 49/1 → 50/0 与「重做」相同，靠栈顶动作名区分
  h.observeProto({ undo: 49, redo: 1, undoLabel: 'p48', redoLabel: 'p49' });
  h.observeProto({ undo: 50, redo: 0, undoLabel: '插入 MXQ', redoLabel: null });
  const tl = h.snapshot().undoTimeline;
  assert.equal(tl.filter((t) => t === 'proto').length, 50);
  assert.equal(tl[tl.length - 1], 'proto');
  assert.ok(tl.includes('orbit'));
  assert.equal(h.nextRedo(), null);
});

test('(U+1, R−1)：栈顶动作名与刚才的重做栈顶相同 → 重做；不同 → 新动作并作废 3D 重做', () => {
  const redo = new UnifiedHistory({ undo: 1, redo: 0, undoLabel: '缸径 32→40', redoLabel: null });
  redo.observeProto({ undo: 0, redo: 1, undoLabel: null, redoLabel: '缸径 32→40' });
  redo.recordOrbit(edit('a', T8, T12));
  redo.takeOrbitUndo();
  // 原型重做（经 ProtoApi 绕过拦截）：动作名一致
  redo.observeProto({ undo: 1, redo: 0, undoLabel: '缸径 32→40', redoLabel: null });
  assert.deepEqual(redo.snapshot().undoTimeline, ['proto']);
  assert.equal(redo.nextRedo(), 'orbit', '重做不作废 3D 重做');

  const push = new UnifiedHistory({ undo: 1, redo: 0, undoLabel: '缸径 32→40', redoLabel: null });
  push.recordOrbit(edit('a', T8, T12));
  push.takeOrbitUndo();
  push.observeProto({ undo: 0, redo: 1, undoLabel: null, redoLabel: '缸径 32→40' });
  push.observeProto({ undo: 1, redo: 0, undoLabel: '插入 MXQ20-32-50', redoLabel: null });
  assert.equal(push.nextRedo(), null, '新动作作废全部重做');
  assert.equal(push.nextUndo(), 'proto');
});

test('parseProtoCounts 带按钮提示时解析栈顶动作名', () => {
  const c = parseProtoCounts('撤销 2', '重做 0', '撤销：缸径 32→40（Ctrl+Z）', '没有可重做的操作');
  assert.deepEqual(c, { undo: 2, redo: 0, undoLabel: '缸径 32→40', redoLabel: null });
});

test('无法识别的跳变按计数强制对齐，不会多撤原型', () => {
  const h = new UnifiedHistory({ undo: 3, redo: 0 });
  h.observeProto({ undo: 1, redo: 5 });
  const s = h.snapshot();
  assert.equal(s.undoTimeline.filter((t) => t === 'proto').length, 1);
  assert.equal(s.redoTimeline.filter((t) => t === 'proto').length + s.protoRedoOrphans, 5);
});

test('3D 栈上限与原型一致（50），溢出丢最早的 3D 令牌', () => {
  const h = new UnifiedHistory({ undo: 0, redo: 0 });
  for (let i = 0; i < ORBIT_HISTORY_LIMIT + 5; i += 1) {
    h.recordOrbit(edit(`e${i}`, { base: { thickness: i + 2 } }, { base: { thickness: i + 3 } }));
  }
  assert.equal(h.orbitCounts().undo, ORBIT_HISTORY_LIMIT);
  assert.equal(h.snapshot().undoTimeline.length, ORBIT_HISTORY_LIMIT);
  assert.equal(h.snapshot().orbitUndo[0], 'e5');
});
