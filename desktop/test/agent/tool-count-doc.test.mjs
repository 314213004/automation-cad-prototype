// 工具数量散落在 README / NL-AGENT / MODULE.md / router 注释里，改工具时必须一起改，
// 否则文档与真实注册表脱节（本项目已漂移过一次：README 写 22，实际 25）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const read = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

function registryNames() {
  const source = read('desktop/src/agent/tools.ts');
  return [...source.matchAll(/name: '([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
}
function setMembers(source, constName) {
  const block = source.match(new RegExp(`export const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  assert.ok(block, `找不到 ${constName}`);
  return [...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
}

const tools = registryNames();
const router = read('desktop/src/agent/router.ts');
const readOnly = setMembers(router, 'READ_ONLY_TOOLS');
const writeOnly = setMembers(router, 'WRITE_TOOLS');

test('注册表与读写分类一一对应（既没有漏分类的工具，也没有幽灵工具）', () => {
  assert.equal(new Set([...readOnly, ...writeOnly]).size, tools.length);
  assert.deepEqual([...tools].sort(), [...readOnly, ...writeOnly].sort());
  assert.equal(readOnly.filter((name) => writeOnly.includes(name)).length, 0);
  assert.equal(tools.length, 25);
  assert.equal(readOnly.length, 12);
  assert.equal(writeOnly.length, 13);
});

test('文档里的工具数量与注册表一致', () => {
  const docs = {
    'README.md': read('README.md'),
    'docs/desktop/NL-AGENT.md': read('docs/desktop/NL-AGENT.md'),
    'desktop/src/agent/MODULE.md': read('desktop/src/agent/MODULE.md'),
    'desktop/src/agent/router.ts': router
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.match(
      text,
      new RegExp(`${tools.length} 个\\s?(工具|AgentTool|已实现工具)`),
      `${name} 里没有找到「${tools.length} 个工具」的表述，改工具后请同步文档`
    );
    assert.ok(
      !new RegExp(`(?<![0-9])${tools.length - 1} 个\\s?(工具|AgentTool)`).test(text),
      `${name} 里仍残留「${tools.length - 1} 个工具」的旧数字`
    );
  }
});

test('README 的工具清单逐个列出且不重不漏', () => {
  const line = read('README.md').split('\n').find((row) => row.startsWith('| 工具集 |'));
  assert.ok(line, 'README 里找不到「工具集」这一行');
  const listed = [...line.matchAll(/`([a-z_][a-z0-9_]*)`/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), tools.sort());
});
