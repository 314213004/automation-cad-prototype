import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkNodeSizes,
  describeModelCheck,
  matchParts,
  nameScore,
  normalizePartName
} from '../../src/canvas/model-check.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

function part(name, size) {
  return { name, bbox: { min: [0, 0, 0], max: size } };
}

test('normalizePartName：大小写/空格/横线/全角括号都归一', () => {
  assert.equal(normalizePartName('KK86-450 丝杠（X 轴）'), normalizePartName('kk86 450 丝杠(x轴)'));
});

test('nameScore：同名 1 分，包含 0.8，无关为 0', () => {
  assert.equal(nameScore('X 轴丝杠模组 KK86', 'x轴丝杠模组kk86'), 1);
  assert.ok(nameScore('X 轴丝杠模组 KK86', 'KK86-450 丝杠模组') >= 0.5);
  assert.equal(nameScore('视觉相机', '机架 4040'), 0);
});

test('matchParts：按名称匹配，低于阈值不硬凑', () => {
  const graph = demoCanvasGraph();
  const parts = [part('X 轴丝杠模组 KK86 装配', [620, 74, 86]), part('完全无关的东西', [10, 10, 10])];
  const matches = matchParts(graph.nodes, parts);
  assert.equal(matches.size, 1);
  assert.equal(matches.get('AXIS-X')?.name, 'X 轴丝杠模组 KK86 装配');
  assert.equal(matches.has('CAM'), false);
});

test('checkNodeSizes：体积比落在 0.5–2 算一致，超过算明显偏差', () => {
  const graph = demoCanvasGraph();
  // X 轴节点 dimsMm = [620,86,74] → 体积 3,946,480 mm³
  const close = checkNodeSizes(graph, [part('X 轴丝杠模组 KK86', [620, 74, 86])]);
  const xClose = close.items.find((item) => item.nodeId === 'AXIS-X');
  assert.equal(xClose.verdict, 'close');
  assert.equal(xClose.volumeRatio, 1);

  const wayOff = checkNodeSizes(graph, [part('X 轴丝杠模组 KK86', [1240, 148, 172])]);
  const xOff = wayOff.items.find((item) => item.nodeId === 'AXIS-X');
  assert.equal(xOff.verdict, 'differs');
  assert.equal(xOff.volumeRatio, 8);
  assert.match(xOff.note, /差 700%/);
});

test('checkNodeSizes：没匹配到的节点标 no-model，总数/命中数正确', () => {
  const graph = demoCanvasGraph();
  const summary = checkNodeSizes(graph, [part('X 轴丝杠模组 KK86', [620, 74, 86])]);
  assert.equal(summary.total, graph.nodes.length);
  assert.equal(summary.matched, 1);
  assert.equal(summary.items.filter((item) => item.verdict === 'no-model').length, graph.nodes.length - 1);
});

test('describeModelCheck：没导入模型 / 全一致 / 有偏差三种说法', () => {
  const graph = demoCanvasGraph();
  assert.match(describeModelCheck(null, 0), /未导入模型/);
  const ok = checkNodeSizes(graph, [part('X 轴丝杠模组 KK86', [620, 74, 86])]);
  const okText = describeModelCheck(ok, 1);
  assert.match(okText, /1\/6 节点匹配/);
  assert.match(okText, /没有明显偏差/);
  const bad = checkNodeSizes(graph, [part('X 轴丝杠模组 KK86', [1240, 148, 172])]);
  assert.match(describeModelCheck(bad, 1), /体积差超过 2 倍/);
});
