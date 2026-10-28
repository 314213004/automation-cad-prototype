import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planToolMenu } from '../../src/ui/tool-menu.ts';

const ALL = [
  'designWizardEntry',
  'assemblyEntryButton',
  'drawingEntryButton',
  'agentEntryButton',
  'elecLibEntryButton',
  'elecCheckEntryButton',
  'plcGenEntryButton',
  'factoryEntryButton',
  'commissionEntryButton',
  'packEntryButton',
  'canvasWorkbenchEntryButton',
  'enclosureEntryButton',
  'costEntryButton',
  'syncEntryButton',
  'moduleSettingsEntryButton',
  'measure',
  'display',
  'automationCadUpdateButton',
  'help'
];

test('全部入口：四组且组内按声明顺序，不出现空的「其他」', () => {
  const plan = planToolMenu(ALL);
  assert.deepEqual(plan.map((group) => group.title), ['设计', '电气', '模块', '视图与帮助']);
  assert.deepEqual(plan[0].keys, ['designWizardEntry', 'assemblyEntryButton', 'drawingEntryButton', 'agentEntryButton']);
  assert.deepEqual(plan[3].keys, ['measure', 'display', 'automationCadUpdateButton', 'help']);
});

test('注册顺序打乱也不影响菜单顺序（不跟着注册顺序漂）', () => {
  const reversed = [...ALL].reverse();
  assert.deepEqual(planToolMenu(reversed), planToolMenu(ALL));
});

test('模块开关关掉的入口不注册 → 该组整组消失，不留空标题', () => {
  const only = ['elecLibEntryButton', 'elecCheckEntryButton'];
  const plan = planToolMenu(only);
  assert.deepEqual(plan.map((group) => group.title), ['电气']);
  assert.deepEqual(plan[0].keys, only);
});

test('未登记的新入口进「其他」，不丢失', () => {
  const plan = planToolMenu(['elecCheckEntryButton', 'futureModuleEntry']);
  assert.deepEqual(plan.map((group) => group.title), ['电气', '其他']);
  assert.deepEqual(plan[1].keys, ['futureModuleEntry']);
});

test('重复 key 只出现一次', () => {
  const plan = planToolMenu(['measure', 'measure', 'help']);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].keys, ['measure', 'help']);
});

test('空输入：没有任何分组', () => {
  assert.deepEqual(planToolMenu([]), []);
});
