import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildReferenceMarkdown, generateReference } from '../../scripts/gen-reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const BUILTIN_DIR = join(REPO_ROOT, 'packs', 'builtin');
const PARTS_FILE = join(BUILTIN_DIR, 'iec-cn', 'parts.json');
const ELECTRICAL_JS = join(REPO_ROOT, 'electrical.js');

const EXPECTED_CATEGORIES = [
  '断路器', '接触器', '热继电器', '中间继电器', '按钮与开关', '指示与信号',
  '端子与辅材', '开关电源', 'PLC', '传感器', '变频器', '伺服'
];

const EXPECTED_SYMBOLS = ['qf1', 'km1', 'km1c', 'fr1', 'ka1', 'sb1', 'a1', 'm1', 'yv1', 'yv2', 'x1', 'hl1'];

function readParts() {
  return JSON.parse(readFileSync(PARTS_FILE, 'utf8'));
}

test('iec-cn 数据包规模达标并包含核心分类与 LC1D18M7C', () => {
  const parts = readParts();
  assert.ok(parts.length >= 350, `条目过少：${parts.length}`);
  const categories = [...new Set(parts.map((part) => part.category))];
  assert.ok(categories.length >= 20, `分类过少：${categories.length}`);
  for (const expected of EXPECTED_CATEGORIES) {
    assert.ok(categories.includes(expected), `缺少分类：${expected}`);
  }
  const contactor = parts.find((part) => part.model === 'LC1D18M7C');
  assert.ok(contactor);
  assert.equal(contactor.category, '接触器');
});

test('gen-reference 输出包含 LC1D18M7C 与接触器表', () => {
  const markdown = buildReferenceMarkdown({ builtinDir: BUILTIN_DIR });
  assert.match(markdown, /## 接触器/);
  assert.match(markdown, /LC1D18M7C/);
  assert.match(markdown, /\| 型号 \| 厂商 \|/);

  const sandbox = mkdtempSync(join(tmpdir(), 'cad-gen-reference-'));
  try {
    const outFile = join(sandbox, 'electrical-components.md');
    const result = generateReference({ builtinDir: BUILTIN_DIR, outFile });
    assert.equal(result.packCount, 9);
    assert.ok(result.partCount >= 350, `参考表条目过少：${result.partCount}`);
    assert.equal(existsSync(outFile), true);
    assert.match(readFileSync(outFile, 'utf8'), /LC1D18M7C/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('symbol → LIB_SYM 映射表包含 12 个键且目标都在符号库中', () => {
  const source = readFileSync(ELECTRICAL_JS, 'utf8');
  const start = source.indexOf('const PACK_SYMBOL_LIB');
  const end = source.indexOf('function resolvePackLibKey');
  assert.ok(start >= 0 && end > start, '未找到 PACK_SYMBOL_LIB 映射表');
  const block = source.slice(start, end);
  const entries = [...block.matchAll(/\b([a-z][a-z0-9]{0,7})\s*:\s*'([a-z]+)'/g)];
  assert.equal(entries.length, 12);
  const mappedKeys = new Set(entries.map((entry) => entry[1]));
  for (const key of EXPECTED_SYMBOLS) assert.equal(mappedKeys.has(key), true, `映射表缺少 ${key}`);

  const libKeys = new Set([...source.matchAll(/\{\s*key:\s*'([a-z]+)'/g)].map((match) => match[1]));
  assert.equal(libKeys.size, 12);
  for (const entry of entries) assert.equal(libKeys.has(entry[2]), true, `${entry[1]} 指向了不存在的 LIB_SYM 键 ${entry[2]}`);
});

test('iec-cn 使用到的每个 symbol 都在映射表和 LIB_SYM 中', () => {
  const source = readFileSync(ELECTRICAL_JS, 'utf8');
  const start = source.indexOf('const PACK_SYMBOL_LIB');
  const end = source.indexOf('function resolvePackLibKey');
  const block = source.slice(start, end);
  const symbols = [...new Set(readParts().map((part) => part.symbol).filter((symbol) => typeof symbol === 'string' && symbol !== ''))];
  assert.equal(symbols.length, 8);
  for (const symbol of symbols) assert.match(block, new RegExp(`\\b${symbol}\\s*:`));
});

test('insertSymbol API 使用 armPlace / placeSymbol / 24×18 网格并在 finally 中取消放置', () => {
  const source = readFileSync(ELECTRICAL_JS, 'utf8');
  assert.match(source, /function insertSymbol\(key, opts\)/);
  assert.match(source, /insertSymbol: insertSymbol/);
  assert.match(source, /armPlace\(libKey\)/);
  assert.match(source, /placeSymbol\(x, y\)/);
  assert.match(source, /finally\s*\{[\s\S]*?disarmPlace\(\)/);
  assert.match(source, /gx \+= 24/);
  assert.match(source, /gy \+= 18/);
  assert.match(source, /tries < 60/);
  assert.match(source, /ES\.domain !== 'elec'[\s\S]*?setDomain\('elec'\)/);
});
