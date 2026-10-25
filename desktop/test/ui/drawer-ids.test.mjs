import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawerIdForEntry } from '../../src/ui/drawer-ids.ts';

test('入口 → 抽屉 id 配对覆盖全部真实入口', () => {
  const pairs = [
    ['agentEntryButton', 'agentDrawer'],
    ['commissionEntryButton', 'commissionDrawer'],
    ['costEntryButton', 'costDrawer'],
    ['elecCheckEntryButton', 'elecCheckDrawer'],
    ['factoryEntryButton', 'factoryDrawer'],
    ['moduleSettingsEntryButton', 'moduleSettingsDrawer'],
    ['elecLibEntryButton', 'elecLibDrawer'],
    ['packEntryButton', 'packDrawer'],
    ['syncEntryButton', 'syncDrawer']
  ];
  for (const [entry, drawer] of pairs) {
    assert.equal(drawerIdForEntry(entry), drawer, `${entry} 应配对 ${drawer}`);
  }
});

test('不符合约定时返回 null，不猜别的抽屉', () => {
  assert.equal(drawerIdForEntry(''), null);
  assert.equal(drawerIdForEntry('EntryButton'), null);
  assert.equal(drawerIdForEntry('factoryButton'), null);
  assert.equal(drawerIdForEntry('factoryEntry'), null);
  assert.equal(drawerIdForEntry('factoryDrawer'), null);
});

test('base 名里的 EntryButton 后缀只去掉一次', () => {
  assert.equal(drawerIdForEntry('xEntryButtonEntryButton'), 'xEntryButtonDrawer');
});
