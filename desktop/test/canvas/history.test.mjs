import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canRedo,
  canUndo,
  createHistory,
  historyAffordances,
  pushHistory,
  redoHistory,
  undoHistory
} from '../../src/canvas/history.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

function graphWithName(name) {
  const graph = demoCanvasGraph();
  graph.nodes = graph.nodes.map((node, index) => (index === 1 ? { ...node, name } : node));
  return { graph, selectedId: 'AXIS-X' };
}

test('createHistory：初始只有一条、不能撤销不能重做', () => {
  const history = createHistory({ graph: demoCanvasGraph(), selectedId: null });
  assert.equal(history.entries.length, 1);
  assert.equal(canUndo(history), false);
  assert.equal(canRedo(history), false);
  assert.equal(historyAffordances(history).undoLabel, '');
  assert.throws(() => createHistory({ graph: demoCanvasGraph(), selectedId: null }, 'x', 1), /至少为 2/);
});

test('push/undo/redo：状态按顺序回放，label 描述动作', () => {
  let history = createHistory({ graph: demoCanvasGraph(), selectedId: null }, '初始状态');
  history = pushHistory(history, graphWithName('X 轴 A'), '改名为 A');
  history = pushHistory(history, graphWithName('X 轴 B'), '改名为 B');
  assert.equal(history.index, 2);
  assert.equal(historyAffordances(history).undoLabel, '改名为 B');

  const undo1 = undoHistory(history);
  assert.ok(undo1);
  assert.equal(undo1.label, '改名为 B');
  assert.equal(undo1.snapshot.graph.nodes[1].name, 'X 轴 A');
  history = undo1.state;

  const undo2 = undoHistory(history);
  assert.ok(undo2);
  assert.equal(undo2.snapshot.graph.nodes[1].name, demoCanvasGraph().nodes[1].name);
  history = undo2.state;
  assert.equal(canUndo(history), false);
  assert.equal(undoHistory(history), null);

  const redo1 = redoHistory(history);
  assert.ok(redo1);
  assert.equal(redo1.label, '改名为 A');
  assert.equal(redo1.snapshot.graph.nodes[1].name, 'X 轴 A');
  history = redo1.state;
  assert.equal(historyAffordances(history).redoLabel, '改名为 B');
});

test('push 发生在 undo 之后：丢弃 redo 尾巴（标准行为）', () => {
  let history = createHistory({ graph: demoCanvasGraph(), selectedId: null });
  history = pushHistory(history, graphWithName('A'), 'A');
  history = pushHistory(history, graphWithName('B'), 'B');
  history = undoHistory(history).state;
  assert.equal(canRedo(history), true);
  history = pushHistory(history, graphWithName('C'), 'C');
  assert.equal(canRedo(history), false, 'undo 后新提交必须清掉 redo');
  assert.equal(history.entries.length, 3, '初始 → A → C（B 的 redo 尾巴被丢弃）');
  assert.equal(history.entries[1].label, 'A');
  assert.equal(history.entries[2].label, 'C');
});

test('上限：超过 limit 丢最老的，index 指向最新', () => {
  let history = createHistory({ graph: demoCanvasGraph(), selectedId: null }, '初始状态', 3);
  for (let i = 0; i < 5; i += 1) history = pushHistory(history, graphWithName(`N${i}`), `第 ${i} 步`);
  assert.equal(history.entries.length, 3);
  assert.equal(history.index, 2);
  assert.equal(history.entries[2].label, '第 4 步');
  assert.equal(history.entries[0].label, '第 2 步', '最老的两条被丢掉');
  assert.equal(canUndo(history), true);
});

test('快照是深拷贝：外部改图/改选中不会污染历史', () => {
  const initial = { graph: demoCanvasGraph(), selectedId: 'AXIS-X' };
  const history = createHistory(initial);
  initial.graph.nodes[1].name = '被外部改了';
  initial.selectedId = 'GRIP';
  assert.notEqual(history.entries[0].graph.nodes[1].name, '被外部改了');
  assert.equal(history.entries[0].selectedId, 'AXIS-X');

  const next = graphWithName('下一步');
  const pushed = pushHistory(history, next, '改名');
  next.graph.nodes[1].name = '又改了';
  assert.equal(pushed.entries[1].graph.nodes[1].name, '下一步');
});

test('动作名必填：空 label 直接拒绝（避免历史里出现空按钮）', () => {
  const history = createHistory({ graph: demoCanvasGraph(), selectedId: null });
  assert.throws(() => pushHistory(history, graphWithName('x'), '  '), /必须有动作名/);
});

test('historyAffordances：撤销/重做两侧标签都正确', () => {
  let history = createHistory({ graph: demoCanvasGraph(), selectedId: null });
  history = pushHistory(history, graphWithName('A'), '插入转接板');
  history = pushHistory(history, graphWithName('B'), '删除节点');
  const middle = undoHistory(history).state;
  const affordance = historyAffordances(middle);
  assert.equal(affordance.canUndo, true);
  assert.equal(affordance.canRedo, true);
  assert.equal(affordance.undoLabel, '插入转接板');
  assert.equal(affordance.redoLabel, '删除节点');
});
