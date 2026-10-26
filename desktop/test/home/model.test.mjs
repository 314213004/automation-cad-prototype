import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHomeModel, formatRelativeDay, formatShortTime, projectMeta } from '../../src/home/model.ts';

const NOW = new Date('2026-10-26T14:30:00+08:00');

test('formatShortTime：ISO → MM-DD HH:mm，坏时间返回空串', () => {
  assert.equal(formatShortTime('2026-10-26T14:05:00+08:00'), '10-26 14:05');
  assert.equal(formatShortTime('not-a-date'), '');
});

test('formatRelativeDay：今天/昨天/N 天前，超过 30 天回落到日期', () => {
  assert.equal(formatRelativeDay('2026-10-26T09:00:00+08:00', NOW), '今天');
  assert.equal(formatRelativeDay('2026-10-25T09:00:00+08:00', NOW), '昨天');
  assert.equal(formatRelativeDay('2026-10-20T09:00:00+08:00', NOW), '6 天前');
  assert.equal(formatRelativeDay('2026-08-01T09:00:00+08:00', NOW), '08-01');
});

test('projectMeta：工艺 · 件数 · 相对时间+时刻，缺工艺不硬塞占位', () => {
  const meta = projectMeta({ id: 'a', name: 'A', process: '贴合', parts: 12, createdAt: '2026-10-25T09:10:00+08:00' }, NOW);
  assert.equal(meta, '贴合 · 12 件 · 昨天 09:10');
  const empty = projectMeta({ id: 'b', name: 'B', process: '  ', parts: 0, createdAt: '' }, NOW);
  assert.equal(empty, '0 件');
});

test('buildHomeModel：按创建时间倒序、裁剪到 limit、跳过空 id', () => {
  const model = buildHomeModel(
    [
      { id: 'old', name: '旧', process: '装配', parts: 3, createdAt: '2026-10-01T10:00:00+08:00' },
      { id: 'new', name: '新', process: '装配', parts: 9, createdAt: '2026-10-26T10:00:00+08:00' },
      { id: ' ', name: '空 id', process: '', parts: 0, createdAt: '' },
      { id: 'mid', name: '中', process: '', parts: 4, createdAt: '2026-10-20T10:00:00+08:00' }
    ],
    { now: NOW, limit: 2 }
  );
  assert.deepEqual(model.projects.map((item) => item.id), ['new', 'mid'], '倒序后取前 2 条');
  assert.equal(model.projects[0].name, '新');
});

test('buildHomeModel：空列表给出空态文案，且首屏说明不加载示例', () => {
  const model = buildHomeModel([], { now: NOW });
  assert.equal(model.projects.length, 0);
  assert.match(model.emptyHint, /还没有保存过工程/);
  assert.match(model.footerHint, /首页不加载示例装配/);
  assert.match(model.emptyHint, /空白画布|演示拓扑/);
});

test('buildHomeModel：读取失败时错误进 footer，空态文案不再说「还没有工程」', () => {
  const model = buildHomeModel([], { now: NOW, error: '读取最近工程失败：权限不足' });
  assert.equal(model.emptyHint, '');
  assert.match(model.footerHint, /读取最近工程失败/);
});

test('buildHomeModel：坏时间不参与排序（当 0 处理）也不抛错', () => {
  const model = buildHomeModel(
    [
      { id: 'bad', name: '坏时间', process: '', parts: 1, createdAt: 'oops' },
      { id: 'ok', name: '正常', process: '', parts: 1, createdAt: '2026-10-26T08:00:00+08:00' }
    ],
    { now: NOW }
  );
  assert.equal(model.projects[0].id, 'ok');
  assert.equal(model.projects[1].meta, '1 件', '坏时间不编时刻，只剩件数');
});
