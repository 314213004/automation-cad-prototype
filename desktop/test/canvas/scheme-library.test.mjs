import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_SCHEMES,
  emptySchemeLibrary,
  listSchemes,
  parseSchemeLibrary,
  removeScheme,
  upsertScheme,
  validateSchemeName
} from '../../src/canvas/scheme-library.ts';
import { demoCanvasGraph } from '../../src/canvas/demo-graph.ts';

const NOW = '2026-10-26T14:00:00+08:00';

test('upsertScheme：新增后可按名字取回，原库不变', () => {
  const library = emptySchemeLibrary();
  const result = upsertScheme(library, 'A 方案', demoCanvasGraph(), NOW);
  assert.equal(result.error, null);
  assert.equal(result.replaced, false);
  assert.equal(result.library.schemes.length, 1);
  assert.equal(result.library.schemes[0].graph.nodes.length, 6);
  assert.deepEqual(library.schemes, [], '入参不变');
});

test('upsertScheme：同名覆盖而不是追加副本', () => {
  const first = upsertScheme(emptySchemeLibrary(), 'A', demoCanvasGraph(), '2026-10-26T10:00:00+08:00');
  const second = upsertScheme(first.library, 'A', demoCanvasGraph(), NOW);
  assert.equal(second.replaced, true);
  assert.equal(second.library.schemes.length, 1);
  assert.equal(second.library.schemes[0].savedAt, NOW);
});

test('validateSchemeName：空名/超长/路径分隔符被拒', () => {
  assert.match(validateSchemeName('   '), /不能为空/);
  assert.match(validateSchemeName('x'.repeat(41)), /最多 40 字/);
  assert.match(validateSchemeName('../etc'), /路径分隔符/);
  assert.equal(validateSchemeName(' 缩回型 3 工位 '), null);
});

test('upsertScheme：超过上限拒绝新增，但允许覆盖已有', () => {
  let library = emptySchemeLibrary();
  for (let i = 0; i < MAX_SCHEMES; i += 1) {
    library = upsertScheme(library, `方案${i}`, demoCanvasGraph(), NOW).library;
  }
  const rejected = upsertScheme(library, '新方案', demoCanvasGraph(), NOW);
  assert.match(rejected.error, /最多 50 个/);
  const overwritten = upsertScheme(library, '方案0', demoCanvasGraph(), NOW);
  assert.equal(overwritten.error, null);
  assert.equal(overwritten.replaced, true);
});

test('removeScheme：删除指定方案，未知名字原样返回', () => {
  const library = upsertScheme(emptySchemeLibrary(), 'A', demoCanvasGraph(), NOW).library;
  assert.equal(removeScheme(library, 'A').schemes.length, 0);
  assert.equal(removeScheme(library, 'NOPE'), library);
});

test('listSchemes：按保存时间倒序并带节点/边数', () => {
  let library = emptySchemeLibrary();
  library = upsertScheme(library, '旧', demoCanvasGraph(), '2026-10-01T00:00:00+08:00').library;
  library = upsertScheme(library, '新', demoCanvasGraph(), NOW).library;
  const list = listSchemes(library);
  assert.deepEqual(list.map((item) => item.name), ['新', '旧']);
  assert.equal(list[0].nodes, 6);
  assert.equal(list[0].edges, 5);
});

test('parseSchemeLibrary：schema 不匹配整份拒绝', () => {
  const parsed = parseSchemeLibrary({ schema: 'other/1', schemes: [] });
  assert.equal(parsed.rejected, true);
  assert.match(parsed.issues[0], /schema 不匹配/);
});

test('parseSchemeLibrary：坏条目丢弃、重名保留第一条', () => {
  const parsed = parseSchemeLibrary({
    schema: 'canvas-scheme-library/1',
    schemes: [
      { name: 'A', savedAt: NOW, graph: { nodes: [], edges: [] } },
      { name: 'A', savedAt: NOW, graph: { nodes: [], edges: [] } },
      { name: '', savedAt: NOW, graph: {} },
      { name: 'B', savedAt: NOW }
    ]
  });
  assert.equal(parsed.rejected, false);
  assert.deepEqual(parsed.library.schemes.map((entry) => entry.name), ['A']);
  assert.equal(parsed.issues.length, 3);
});
