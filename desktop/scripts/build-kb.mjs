#!/usr/bin/env node
/**
 * 构建本地知识索引（离线 RAG）。
 * 用法：在 desktop/ 下执行 `npm run kb:build`；输出 `src/agent/kb/kb.json`。
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildKnowledgeBase } from '../src/agent/kb/index.ts';

const root = resolve(import.meta.dirname, '..');
const repoRoot = resolve(root, '..');
const output = resolve(root, 'src/agent/kb/kb.json');
const data = buildKnowledgeBase({ repoRoot });

writeFileSync(output, JSON.stringify(data), 'utf8');
console.log(
  `KB_BUILD_OK docs=${data.meta.docs} chunks=${data.meta.chunks} bytes=${data.meta.bytes} ` +
  `truncated=${data.meta.truncated ? 1 : 0}${data.meta.sizeLimited ? ' size_limited=1' : ''}`
);
