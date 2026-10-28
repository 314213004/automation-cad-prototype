// kb.json 是提交入库的构建产物：文档改了却忘记 `npm run kb:build`，
// Agent 的 search_docs 就会检索到旧内容。这里现场重建并与提交版比对（忽略 generatedAt 时间戳）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildKnowledgeBase } from '../../src/agent/kb/index.ts';

const desktopRoot = resolve(import.meta.dirname, '..', '..');
const repoRoot = resolve(desktopRoot, '..');

function stripTime(value) {
  const clone = JSON.parse(JSON.stringify(value));
  if (clone.meta) delete clone.meta.generatedAt;
  return clone;
}

const committed = JSON.parse(readFileSync(resolve(desktopRoot, 'src/agent/kb/kb.json'), 'utf8'));
const fresh = buildKnowledgeBase({ repoRoot });

test('kb.json 与当前文档同步（改文档后必须重建）', () => {
  assert.deepEqual(stripTime(committed), stripTime(fresh), 'kb.json 已过期：请运行 npm run kb:build 并提交');
});

test('README 里引用的 kb 统计与实际一致', () => {
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`SMOKE_AGENT_KB_OK docs=${committed.meta.docs} chunks=${committed.meta.chunks}`));
});
