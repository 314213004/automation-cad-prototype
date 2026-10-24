#!/usr/bin/env node
// 数据包统计：每包条数/体积/覆盖、全库唯一型号、分类矩阵、价格命中与跨包重复。
// 默认写入 docs/desktop/PACK-STATS.md 与 docs/desktop/pack-stats.json。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_PACKS_DIR = join(REPO_ROOT, 'packs', 'builtin');
const DEFAULT_OUT_DIR = join(REPO_ROOT, 'docs', 'desktop');

const COMMON_BOM_MODELS = [
  { id: 'SV660PS5R5I', role: '伺服驱动器', pack: 'iec-cn' },
  { id: 'MS1H1-75B30CB', role: '伺服电机', pack: 'iec-cn' },
  { id: 'MHZ2-20D', role: '气爪', pack: 'smc-cn' },
  { id: 'SY5120-5LZD', role: '电磁阀', pack: 'smc-cn' },
  { id: 'D-M9B', role: '磁性开关', pack: 'smc-cn' },
  { id: 'CP1E-N40DR-A', role: 'PLC', pack: 'iec-cn' },
  { id: 'PNOZ-s3-750103', role: '安全继电器', pack: 'iec-cn' },
  { id: 'F3SG-4SRA0640-14', role: '安全光栅', pack: 'iec-cn' },
  { id: 'LRS-350-24', role: '24 V 开关电源', pack: 'iec-cn' },
  { id: 'iC65N-C6-1P', role: '伺服断路器', pack: 'iec-cn' },
  { id: '5SY63-C16', role: '主断路器', pack: 'iec-cn' }
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizeModel(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '');
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readPartsDocument(rawText) {
  const value = JSON.parse(rawText);
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.parts)) return value.parts;
  throw new Error('parts.json 必须是数组或 { schemaVersion, parts }');
}

function walkBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) total += walkBytes(file);
    else if (entry.isFile()) total += statSync(file).size;
  }
  return total;
}

function latestMtime(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, latestMtime(file));
    else if (entry.isFile()) latest = Math.max(latest, statSync(file).mtimeMs);
  }
  return latest;
}

function formatShanghai(ms) {
  if (!ms) return 'unknown';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

function loadPricebook(pricebookPath) {
  const empty = {
    path: pricebookPath,
    currency: 'CNY',
    updatedAt: null,
    usableItems: [],
    byId: new Map(),
    byModel: new Map()
  };
  if (!pricebookPath || !existsSync(pricebookPath)) return empty;
  const book = JSON.parse(readFileSync(pricebookPath, 'utf8'));
  const items = [];
  const byId = new Map();
  const byModel = new Map();
  for (const [key, raw] of Object.entries(book.items ?? {})) {
    if (!isRecord(raw) || raw.example === true) continue;
    if (typeof raw.list !== 'number' || !Number.isFinite(raw.list) || raw.list < 0) continue;
    const item = {
      key,
      id: key,
      model: nonEmpty(raw.model) ? raw.model.trim() : key,
      category: nonEmpty(raw.category) ? raw.category.trim() : '',
      list: raw.list,
      source: nonEmpty(raw.source) ? raw.source.trim() : '',
      checkedAt: nonEmpty(raw.checkedAt) ? raw.checkedAt.trim() : null
    };
    items.push(item);
    if (!byId.has(key)) byId.set(key, item);
    if (!byModel.has(normalizeModel(key))) byModel.set(normalizeModel(key), item);
    if (!byModel.has(normalizeModel(item.model))) byModel.set(normalizeModel(item.model), item);
  }
  return {
    path: pricebookPath,
    currency: nonEmpty(book.currency) ? book.currency : 'CNY',
    updatedAt: nonEmpty(book.updatedAt) ? book.updatedAt : null,
    usableItems: items,
    byId,
    byModel
  };
}

function priceFor(part, pricebook) {
  if (typeof part.price === 'number' && Number.isFinite(part.price) && part.price >= 0) {
    return { source: 'inline', list: part.price, key: part.id };
  }
  if (!nonEmpty(part.id)) return null;
  const byId = pricebook.byId.get(part.id.trim());
  if (byId) return { source: 'pricebook', list: byId.list, key: byId.key };
  const byModel = pricebook.byModel.get(normalizeModel(part.model));
  if (byModel) return { source: 'pricebook', list: byModel.list, key: byModel.key };
  return null;
}

function hasValidDims(part) {
  if (!isRecord(part.dims)) return false;
  return ['w', 'h', 'd'].every((key) => typeof part.dims[key] === 'number' && Number.isFinite(part.dims[key]) && part.dims[key] > 0);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

export function buildPackStats(options = {}) {
  const packsDir = resolve(options.packsDir ?? DEFAULT_PACKS_DIR);
  const pricebookPath = resolve(options.pricebookPath ?? join(packsDir, 'pricebook-cn', 'pricebook.json'));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const pricebook = loadPricebook(pricebookPath);

  const dirs = readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(packsDir, entry.name))
    .sort((left, right) => basename(left).localeCompare(basename(right), 'zh-CN'));

  const packInputs = [];
  const allEntries = [];
  for (const dir of dirs) {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const id = nonEmpty(manifest.id) ? manifest.id.trim() : basename(dir);
    const partsPath = join(dir, 'parts.json');
    let entries = [];
    let partsRaw = null;
    let partsBytes = 0;
    if (existsSync(partsPath)) {
      partsRaw = readFileSync(partsPath, 'utf8');
      entries = readPartsDocument(partsRaw);
      partsBytes = statSync(partsPath).size;
    }
    const pack = {
      dir,
      id,
      manifest,
      entries,
      partsRaw,
      partsBytes,
      packBytes: walkBytes(dir),
      lastUpdatedMs: latestMtime(dir)
    };
    packInputs.push(pack);
    for (const entry of entries) {
      if (isRecord(entry)) allEntries.push({ ...entry, __pack: id });
    }
  }

  const packIds = packInputs.map((pack) => pack.id);
  const packs = packInputs.map((pack) => {
    const active = pack.entries.filter((entry) => isRecord(entry) && !nonEmpty(entry.aliasOf));
    const aliases = pack.entries.filter((entry) => isRecord(entry) && nonEmpty(entry.aliasOf));
    const categories = [...new Set(pack.entries.filter(isRecord).map((entry) => entry.category).filter(nonEmpty))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const withDims = active.filter(hasValidDims).length;
    const withPrice = active.filter((entry) => priceFor(entry, pricebook) !== null).length;
    const expectedSha = nonEmpty(pack.manifest.partsSha256) ? pack.manifest.partsSha256.toLowerCase() : null;
    const actualSha = pack.partsRaw !== null ? sha256(pack.partsRaw) : null;
    const integrity = expectedSha === null
      ? (pack.partsRaw === null ? 'n/a' : 'missing')
      : actualSha === expectedSha ? 'ok' : 'failed';
    return {
      id: pack.id,
      name: nonEmpty(pack.manifest.name) ? pack.manifest.name.trim() : pack.id,
      version: nonEmpty(pack.manifest.version) ? pack.manifest.version.trim() : 'unknown',
      schemaVersion: pack.manifest.schemaVersion ?? null,
      parts: pack.entries.length,
      activeParts: active.length,
      aliases: aliases.length,
      categories,
      categoryCount: categories.length,
      withDims,
      dimsCoverage: active.length > 0 ? round(withDims / active.length) : 0,
      withPrice,
      priceCoverage: active.length > 0 ? round(withPrice / active.length) : 0,
      partsBytes: pack.partsBytes,
      packBytes: pack.packBytes,
      partsSha256: expectedSha,
      integrity,
      requires: Array.isArray(pack.manifest.requires) ? pack.manifest.requires : [],
      lastUpdated: formatShanghai(pack.lastUpdatedMs),
      lastUpdatedIso: pack.lastUpdatedMs ? new Date(pack.lastUpdatedMs).toISOString() : null
    };
  });

  const activeEntries = allEntries.filter((entry) => !nonEmpty(entry.aliasOf));
  const uniqueIds = new Set(allEntries.map((entry) => entry.id).filter(nonEmpty));
  const uniqueModels = new Set(activeEntries.map((entry) => normalizeModel(entry.model)).filter(Boolean));
  const allCategories = new Set(allEntries.map((entry) => entry.category).filter(nonEmpty));

  const idPacks = new Map();
  const modelPacks = new Map();
  for (const entry of allEntries) {
    if (nonEmpty(entry.id)) {
      if (!idPacks.has(entry.id)) idPacks.set(entry.id, new Set());
      idPacks.get(entry.id).add(entry.__pack);
    }
  }
  for (const entry of activeEntries) {
    const model = normalizeModel(entry.model);
    if (!model) continue;
    if (!modelPacks.has(model)) modelPacks.set(model, { model: entry.model, packs: new Set() });
    modelPacks.get(model).packs.add(entry.__pack);
  }
  const duplicates = {
    byId: [...idPacks.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([id, set]) => ({ id, packs: [...set].sort() })),
    byModel: [...modelPacks.values()]
      .filter((entry) => entry.packs.size > 1)
      .map((entry) => ({ model: entry.model, packs: [...entry.packs].sort() }))
  };

  const matrixCategories = [...allCategories].sort((left, right) => {
    const leftTotal = allEntries.filter((entry) => entry.category === left).length;
    const rightTotal = allEntries.filter((entry) => entry.category === right).length;
    return rightTotal - leftTotal || left.localeCompare(right, 'zh-CN');
  });
  const categoryMatrix = matrixCategories.map((category) => {
    const counts = Object.fromEntries(packIds.map((id) => [id, 0]));
    let total = 0;
    for (const entry of allEntries) {
      if (entry.category !== category) continue;
      counts[entry.__pack] += 1;
      total += 1;
    }
    return { category, counts, total };
  });

  const withDims = activeEntries.filter(hasValidDims).length;
  const withPrice = activeEntries.filter((entry) => priceFor(entry, pricebook) !== null).length;
  const commonBom = COMMON_BOM_MODELS.map((reference) => {
    const part = allEntries.find((entry) => entry.id === reference.id && entry.__pack === reference.pack)
      ?? allEntries.find((entry) => entry.id === reference.id);
    const price = part ? priceFor(part, pricebook) : null;
    return {
      id: reference.id,
      role: reference.role,
      pack: part?.__pack ?? reference.pack,
      model: part?.model ?? reference.id,
      found: Boolean(part),
      priced: Boolean(price),
      list: price?.list ?? null,
      priceSource: price?.source ?? null,
      priceKey: price?.key ?? null
    };
  });
  const commonHits = commonBom.filter((entry) => entry.priced).length;
  const integrityCounts = {
    checked: packs.filter((pack) => pack.integrity === 'ok' || pack.integrity === 'failed').length,
    ok: packs.filter((pack) => pack.integrity === 'ok').length,
    missing: packs.filter((pack) => pack.integrity === 'missing').length,
    failed: packs.filter((pack) => pack.integrity === 'failed').length
  };

  return {
    schemaVersion: 1,
    generatedAt,
    source: {
      packsDir,
      pricebook: pricebook.path,
      pricebookUpdatedAt: pricebook.updatedAt,
      currency: pricebook.currency
    },
    totals: {
      packs: packs.length,
      partPacks: packs.filter((pack) => pack.parts > 0).length,
      pricebookPacks: packs.filter((pack) => pack.parts === 0).length,
      parts: allEntries.length,
      activeParts: activeEntries.length,
      aliases: allEntries.length - activeEntries.length,
      uniqueIds: uniqueIds.size,
      uniqueModels: uniqueModels.size,
      categories: allCategories.size,
      withDims,
      dimsCoverage: activeEntries.length > 0 ? round(withDims / activeEntries.length) : 0,
      withPrice,
      priceCoverage: activeEntries.length > 0 ? round(withPrice / activeEntries.length) : 0,
      partsBytes: packs.reduce((sum, pack) => sum + pack.partsBytes, 0),
      packBytes: packs.reduce((sum, pack) => sum + pack.packBytes, 0),
      integrity: integrityCounts,
      pricebookItems: pricebook.usableItems.length,
      commonBomHits: commonHits,
      commonBomTotal: commonBom.length
    },
    packs,
    duplicates,
    categoryMatrix,
    priceCoverage: {
      library: {
        parts: activeEntries.length,
        priced: withPrice,
        rate: activeEntries.length > 0 ? round(withPrice / activeEntries.length) : 0,
        pricebookItems: pricebook.usableItems.length
      },
      commonBom: {
        total: commonBom.length,
        hits: commonHits,
        rate: commonBom.length > 0 ? round(commonHits / commonBom.length) : 0,
        models: commonBom
      }
    }
  };
}

export function renderPackStatsMarkdown(stats) {
  const lines = [];
  lines.push('# 数据包统计（PACK-STATS）');
  lines.push('');
  lines.push(`> 生成时间：${stats.generatedAt} ｜ 数据源：\`${stats.source.packsDir}\` ｜ 价格簿：\`${stats.source.pricebook}\` ｜ 币种：${stats.source.currency}`);
  lines.push('> 本文件由 `npm run packs:stats` 生成，请勿手工编辑；JSON 版本见 `docs/desktop/pack-stats.json`。');
  lines.push('');
  lines.push('## 总计');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 数据包 | ${stats.totals.packs}（元器件包 ${stats.totals.partPacks} / 价格簿 ${stats.totals.pricebookPacks}） |`);
  lines.push(`| 总条数 | ${stats.totals.parts}（实型号 ${stats.totals.activeParts} + alias ${stats.totals.aliases}） |`);
  lines.push(`| 去重后唯一 id | ${stats.totals.uniqueIds} |`);
  lines.push(`| 去重后唯一型号 | ${stats.totals.uniqueModels} |`);
  lines.push(`| 总分类 | ${stats.totals.categories} |`);
  lines.push(`| 尺寸覆盖 | ${stats.totals.withDims}/${stats.totals.activeParts}（${(stats.totals.dimsCoverage * 100).toFixed(1)}%） |`);
  lines.push(`| 价格覆盖 | ${stats.totals.withPrice}/${stats.totals.activeParts}（${(stats.totals.priceCoverage * 100).toFixed(1)}%） |`);
  lines.push(`| 体积 | parts.json ${(stats.totals.partsBytes / 1024).toFixed(1)} KB / 整包 ${(stats.totals.packBytes / 1024).toFixed(1)} KB |`);
  lines.push(`| 校验和 | 已校验 ${stats.totals.integrity.checked} · 通过 ${stats.totals.integrity.ok} · 缺失 ${stats.totals.integrity.missing} · 失败 ${stats.totals.integrity.failed} |`);
  lines.push(`| BOM 常见型号价格命中 | ${stats.totals.commonBomHits}/${stats.totals.commonBomTotal}（${(stats.priceCoverage.commonBom.rate * 100).toFixed(1)}%） |`);
  lines.push('');
  lines.push('## 每包');
  lines.push('');
  lines.push('| 包 | 版本 | 条数 | 实型号 | alias | 分类 | 尺寸覆盖 | 价格覆盖 | parts.json | 整包 | 最近更新 | 校验和 |');
  lines.push('|----|------|-----:|-------:|------:|-----:|---------:|---------:|-----------:|-----:|----------|--------|');
  for (const pack of stats.packs) {
    lines.push(`| \`${escapeCell(pack.id)}\` | ${escapeCell(pack.version)} | ${pack.parts} | ${pack.activeParts} | ${pack.aliases} | ${pack.categoryCount} | ${pack.withDims}/${pack.activeParts}（${(pack.dimsCoverage * 100).toFixed(1)}%） | ${pack.withPrice}/${pack.activeParts}（${(pack.priceCoverage * 100).toFixed(1)}%） | ${(pack.partsBytes / 1024).toFixed(1)} KB | ${(pack.packBytes / 1024).toFixed(1)} KB | ${pack.lastUpdated} | ${pack.integrity} |`);
  }
  lines.push('');
  lines.push('## 分类矩阵');
  lines.push('');
  lines.push('行为分类，列为数据包；数字是该包内该分类的条数（含 alias），`·` 表示 0。');
  lines.push('');
  lines.push(`| 分类 | ${stats.packs.map((pack) => `\`${escapeCell(pack.id)}\``).join(' | ')} | 合计 |`);
  lines.push(`|------|${stats.packs.map(() => '-----:').join('|')}|-----:|`);
  for (const row of stats.categoryMatrix) {
    const cells = stats.packs.map((pack) => {
      const count = row.counts[pack.id] ?? 0;
      return count > 0 ? String(count) : '·';
    });
    lines.push(`| ${escapeCell(row.category)} | ${cells.join(' | ')} | ${row.total} |`);
  }
  lines.push('');
  lines.push('## 价格覆盖');
  lines.push('');
  lines.push('### 全库');
  lines.push('');
  lines.push(`- 可检索实型号：${stats.priceCoverage.library.parts}`);
  lines.push(`- 可定价：${stats.priceCoverage.library.priced}（${(stats.priceCoverage.library.rate * 100).toFixed(1)}%）`);
  lines.push(`- 价格簿可用条目：${stats.priceCoverage.library.pricebookItems}（已排除 example 示例条目）`);
  lines.push('');
  lines.push('### BOM 常见型号');
  lines.push('');
  lines.push('| 用途 | id | 型号 | 包 | 命中 | 价格 | 来源 |');
  lines.push('|------|----|------|----|------|-----:|------|');
  for (const entry of stats.priceCoverage.commonBom.models) {
    lines.push(`| ${escapeCell(entry.role)} | \`${escapeCell(entry.id)}\` | ${escapeCell(entry.model)} | \`${escapeCell(entry.pack)}\` | ${entry.priced ? '✅' : '—'} | ${entry.list ?? '—'} | ${entry.priceSource ?? '—'} |`);
  }
  lines.push('');
  lines.push('## 跨包重复');
  lines.push('');
  if (stats.duplicates.byId.length === 0 && stats.duplicates.byModel.length === 0) {
    lines.push('未发现跨包重复 id 或型号。');
  } else {
    if (stats.duplicates.byId.length > 0) {
      lines.push('### 重复 id');
      lines.push('');
      for (const item of stats.duplicates.byId) lines.push(`- \`${item.id}\`：${item.packs.join(' / ')}`);
      lines.push('');
    }
    if (stats.duplicates.byModel.length > 0) {
      lines.push('### 重复型号');
      lines.push('');
      for (const item of stats.duplicates.byModel) lines.push(`- ${item.model}：${item.packs.join(' / ')}`);
    }
  }
  lines.push('');
  lines.push('## 说明');
  lines.push('');
  lines.push('- `条数` 含 alias；`实型号` 与覆盖比例只统计非 alias 条目，和 `listParts` 可检索口径一致。');
  lines.push('- 价格命中 = 条目自带 `price` 或价格簿按 id / 型号命中；example 示例条目不参与。');
  lines.push('- `最近更新` 取包目录内文件的最大 mtime，时区固定 Asia/Shanghai。');
  lines.push('');
  return lines.join('\n');
}

export function writePackStats(options = {}) {
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const stats = buildPackStats(options);
  const markdown = renderPackStatsMarkdown(stats);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, 'PACK-STATS.md');
  const jsonPath = join(outDir, 'pack-stats.json');
  writeFileSync(mdPath, markdown, 'utf8');
  writeFileSync(jsonPath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
  return { stats, markdown, mdPath, jsonPath };
}

function parseArgs(argv) {
  const options = { json: false, write: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--packs') options.packsDir = resolve(String(argv[++index] ?? ''));
    else if (arg === '--out-dir') options.outDir = resolve(String(argv[++index] ?? ''));
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else options.packsDir = resolve(arg);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const stats = buildPackStats(options);
    let paths = { mdPath: null, jsonPath: null };
    if (options.write) paths = writePackStats(options);
    if (options.json) console.log(JSON.stringify(stats, null, 2));
    else {
      console.log(`PACK_STATS_OK packs=${stats.totals.packs} parts=${stats.totals.parts} models=${stats.totals.uniqueModels} categories=${stats.totals.categories} prices=${stats.priceCoverage.commonBom.hits}/${stats.priceCoverage.commonBom.total}`);
      if (paths.mdPath) console.log(`PACK_STATS_WROTE md=${paths.mdPath} json=${paths.jsonPath}`);
    }
  } catch (error) {
    console.error(`PACK_STATS_FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
