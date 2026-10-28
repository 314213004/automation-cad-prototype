import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMatePanel } from '../../src/canvas/feature-tree-mates.ts';
import { COMMAND_TABS, commandForTarget } from '../../src/canvas/feature-commands.ts';

const sliderPort = { family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 };

test('配合面板：五字段全等才兼容，差一个字段就标红该字段', () => {
  const graph = {
    nodes: [
      { id: 'a', name: '直线模组', portIn: sliderPort, portOut: sliderPort },
      { id: 'b', name: '转接板', portIn: sliderPort, portOut: { ...sliderPort, pitchYMm: 36 } },
      { id: 'c', name: '气缸', portIn: { ...sliderPort, pitchYMm: 40 }, portOut: sliderPort }
    ],
    edges: [
      { id: 'e1', from: 'a', to: 'b' },
      { id: 'e2', from: 'b', to: 'c' }
    ]
  };
  const panel = buildMatePanel(graph);
  assert.equal(panel[0].compatible, true);
  assert.deepEqual(panel[0].diffFields, []);
  assert.equal(panel[1].compatible, false);
  assert.deepEqual(panel[1].diffFields, ['pitchYMm']);
  assert.equal(buildMatePanel({ nodes: graph.nodes, edges: [{ id: 'e9', from: 'a', to: '不存在' }] })[0].compatible, false);
});

test('命令条：只有机械侧标签页，特征命令对应现有特征类型', () => {
  assert.deepEqual(COMMAND_TABS.map((t) => t.id), ['feature', 'assembly', 'drawing']);
  assert.ok(!COMMAND_TABS.some((t) => t.id === 'electrical'));
  assert.equal(commandForTarget('counterbore').label, '沉孔');
  assert.equal(commandForTarget('adapter').label, '转接板');
  assert.equal(commandForTarget('不存在'), null);
});
