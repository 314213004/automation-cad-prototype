import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideEntryBar } from '../../src/ui/entry-bar.ts';

test('空间足够：保持带文字', () => {
  assert.deepEqual(decideEntryBar({ needed: 900, available: 1200, compactNeeded: 500 }), { mode: 'full', scrolls: false });
});

test('刚好处在阈值上（留 8px 余量）：不算溢出', () => {
  assert.equal(decideEntryBar({ needed: 1192, available: 1200, compactNeeded: 500 }).mode, 'full');
  assert.equal(decideEntryBar({ needed: 1193, available: 1200, compactNeeded: 500 }).mode, 'compact');
});

test('带文字放不下、图标放得下：降级为图标模式且不滚动', () => {
  assert.deepEqual(decideEntryBar({ needed: 1980, available: 1670, compactNeeded: 520 }), { mode: 'compact', scrolls: false });
});

test('连图标都放不下：图标模式 + 横向滚动兜底', () => {
  assert.deepEqual(decideEntryBar({ needed: 1980, available: 400, compactNeeded: 520 }), { mode: 'compact', scrolls: true });
});

test('零宽度（隐藏容器）不会误判成可放下', () => {
  assert.equal(decideEntryBar({ needed: 900, available: 0, compactNeeded: 90 }).scrolls, true);
});
