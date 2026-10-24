import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import {
  assertPartsIntegrity,
  parsePartsDocument,
  satisfiesVersion,
  sha256Hex,
  validatePack,
  validatePackCatalog
} from '../../src/packs/validate.ts';
import { PackRegistry } from '../../src/packs/registry.ts';
import { buildDiagnosisReport, formatDiagnosisReport } from '../../src/shared/diagnostics.ts';
import { buildPackStats, renderPackStatsMarkdown, writePackStats } from '../../../scripts/pack-stats.mjs';
import { createPackSkeleton } from '../../../scripts/pack-add.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const BUILTIN_DIR = join(REPO_ROOT, 'packs', 'builtin');
const PRICEBOOK = join(BUILTIN_DIR, 'pricebook-cn', 'pricebook.json');

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-pack-lifecycle-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function parts() {
  return [
    { id: 'P-001', model: 'M-001', category: '气缸', vendor: '测试厂商', specs: { 缸径: '32 mm' }, price: 100 },
    { id: 'P-002', model: 'M-002', category: '传感器', vendor: '测试厂商', specs: { 类型: '磁性' } }
  ];
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'demo-pack',
    name: '演示包',
    vendor: '测试厂商',
    version: '1.0.0',
    license: '测试数据',
    description: '单元测试',
    categories: ['气缸', '传感器'],
    partsCount: 2,
    ...overrides
  };
}

function writePack(dirName, options = {}) {
  const dir = join(sandbox, dirName);
  mkdirSync(dir, { recursive: true });
  const partsValue = options.parts ?? parts();
  const rawParts = options.rawParts ?? `${JSON.stringify(partsValue, null, 2)}\n`;
  writeFileSync(join(dir, 'parts.json'), rawParts);
  const manifestValue = options.manifest ?? manifest({ id: dirName, partsCount: (options.parts ?? parts()).length });
  if (options.omitSha !== true && manifestValue.partsSha256 === undefined && options.rawManifest === undefined) {
    manifestValue.partsSha256 = sha256Hex(rawParts);
  }
  writeFileSync(
    join(dir, 'manifest.json'),
    options.rawManifest ?? `${JSON.stringify(manifestValue, null, 2)}\n`
  );
  return dir;
}

function expectCode(result, code) {
  assert.equal(result.errors.some((error) => error.code === code), true,
    `缺少错误码 ${code}：${JSON.stringify(result.errors)}`);
}

test('校验：合法包通过并返回统计', () => {
  const dir = writePack('demo-pack');
  const result = validatePack(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.partsCount, 2);
  assert.equal(result.stats.declaredPartsCount, 2);
  assert.equal(result.stats.activeParts, 2);
  assert.equal(result.stats.categoryCount, 2);
  assert.equal(result.stats.integrityOk, true);
  assert.equal(result.warnings.length, 0);
});

test('校验：manifest 缺必填字段', () => {
  const value = manifest({ id: 'demo-pack' });
  delete value.name;
  const dir = writePack('demo-pack', { manifest: value });
  const result = validatePack(dir);
  assert.equal(result.ok, false);
  expectCode(result, 'PACK_MANIFEST_FIELD_MISSING');
  assert.match(result.errors.find((error) => error.code === 'PACK_MANIFEST_FIELD_MISSING').message, /name/);
});

test('校验：version 必须是 semver', () => {
  const dir = writePack('demo-pack', { manifest: manifest({ id: 'demo-pack', version: '1.0' }) });
  const result = validatePack(dir);
  expectCode(result, 'PACK_MANIFEST_INVALID');
  assert.match(result.errors.map((error) => error.message).join(' '), /semver/);
});

test('校验：partsCount 与实际条数不符', () => {
  const dir = writePack('demo-pack', { manifest: manifest({ id: 'demo-pack', partsCount: 3 }) });
  const result = validatePack(dir);
  expectCode(result, 'PACK_PARTS_COUNT_MISMATCH');
});

test('校验：包内重复 id', () => {
  const duplicated = parts();
  duplicated[1].id = duplicated[0].id;
  const dir = writePack('demo-pack', { parts: duplicated });
  const result = validatePack(dir);
  expectCode(result, 'PACK_DUPLICATE_ID');
});

test('校验：跨包重复 id', () => {
  const shared = parts();
  writePack('alpha-pack', { parts: shared, manifest: manifest({ id: 'alpha-pack', partsCount: 2 }) });
  writePack('beta-pack', { parts: shared, manifest: manifest({ id: 'beta-pack', partsCount: 2 }) });
  const result = validatePack(join(sandbox, 'beta-pack'), { packsRoot: sandbox });
  expectCode(result, 'PACK_DUPLICATE_ID');
  assert.match(result.errors.find((error) => error.code === 'PACK_DUPLICATE_ID').message, /alpha-pack/);
});

test('校验：坏 JSON 不抛异常而是返回错误', () => {
  const dir = writePack('demo-pack', { rawParts: '{"schemaVersion":2,"parts":[' });
  const result = validatePack(dir);
  assert.equal(result.ok, false);
  expectCode(result, 'PACK_PARTS_JSON_INVALID');
});

test('校验：category 必须在白名单', () => {
  const items = parts();
  items[0].category = '不存在的分类';
  const dir = writePack('demo-pack', { parts: items, manifest: manifest({ id: 'demo-pack', categories: ['气缸', '传感器'] }) });
  const result = validatePack(dir);
  expectCode(result, 'PACK_PART_CATEGORY_UNKNOWN');
});

test('校验：model 不能为空', () => {
  const items = parts();
  items[0].model = '   ';
  const dir = writePack('demo-pack', { parts: items });
  const result = validatePack(dir);
  expectCode(result, 'PACK_PART_MODEL_INVALID');
});

test('校验：数值字段必须有限', () => {
  const rawParts = '[{"id":"P1","model":"M1","category":"气缸","specs":{"功率":1e999},"price":1e999}]\n';
  const dir = writePack('demo-pack', {
    rawParts,
    manifest: manifest({ id: 'demo-pack', partsCount: 1 })
  });
  const result = validatePack(dir);
  expectCode(result, 'PACK_NUMBER_INVALID');
});

test('校验：partsSha256 不匹配返回 PACK_INTEGRITY_FAILED', () => {
  const dir = writePack('demo-pack', { manifest: manifest({ id: 'demo-pack', partsSha256: '0'.repeat(64) }) });
  const result = validatePack(dir);
  assert.equal(result.ok, false);
  expectCode(result, 'PACK_INTEGRITY_FAILED');
  assert.equal(result.stats.integrityOk, false);
});

test('校验：partsSha256 缺失告警但不阻断', () => {
  const dir = writePack('demo-pack', { omitSha: true });
  const result = validatePack(dir);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((warning) => warning.code === 'PACK_SHA_MISSING'), true);
  assert.equal(result.stats.partsSha256, null);
});

test('迁移：parts schemaVersion 1 自动补默认字段并告警', () => {
  const rawParts = `${JSON.stringify({
    schemaVersion: 1,
    parts: [{ id: 'P1', model: 'M1', category: '气缸' }]
  }, null, 2)}\n`;
  const dir = writePack('demo-pack', {
    rawParts,
    manifest: manifest({ id: 'demo-pack', categories: ['气缸'], partsCount: 1 })
  });
  const parsed = parsePartsDocument(JSON.parse(rawParts));
  assert.equal(parsed.migrated, true);
  assert.deepEqual(parsed.entries[0].specs, {});
  assert.equal(parsed.entries[0].schemaVersion, 2);
  const result = validatePack(dir);
  assert.equal(result.ok, true);
  assert.equal(result.stats.migratedFrom, 1);
  assert.equal(result.warnings.some((warning) => warning.code === 'PACK_SCHEMA_MIGRATED'), true);
});

test('迁移：schemaVersion 2 不产生迁移告警', () => {
  const rawParts = `${JSON.stringify({ schemaVersion: 2, parts: parts() }, null, 2)}\n`;
  const dir = writePack('demo-pack', { rawParts });
  const result = validatePack(dir);
  assert.equal(result.ok, true);
  assert.equal(result.stats.migratedFrom, null);
  assert.equal(result.warnings.some((warning) => warning.code === 'PACK_SCHEMA_MIGRATED'), false);
});

test('依赖：缺失依赖包报 PACK_DEPENDENCY_MISSING', () => {
  const dir = writePack('demo-pack', {
    manifest: manifest({ id: 'demo-pack', requires: [{ pack: 'base-pack', version: '^1.0.0' }] })
  });
  const result = validatePack(dir);
  expectCode(result, 'PACK_DEPENDENCY_MISSING');
});

test('依赖：版本不满足报 PACK_DEPENDENCY_VERSION', () => {
  writePack('base-pack', { manifest: manifest({ id: 'base-pack', version: '1.0.0' }) });
  const dir = writePack('demo-pack', {
    manifest: manifest({ id: 'demo-pack', requires: [{ pack: 'base-pack', version: '^2.0.0' }] })
  });
  const result = validatePack(dir, { packsRoot: sandbox });
  expectCode(result, 'PACK_DEPENDENCY_VERSION');
  assert.match(result.errors.find((error) => error.code === 'PACK_DEPENDENCY_VERSION').message, /实际 1\.0\.0/);
});

test('依赖：版本满足时通过', () => {
  writePack('base-pack', {
    parts: [{ id: 'BASE-1', model: 'BASE-1', category: '气缸', specs: {} }],
    manifest: manifest({ id: 'base-pack', version: '1.4.2', partsCount: 1 })
  });
  const dir = writePack('demo-pack', {
    manifest: manifest({ id: 'demo-pack', requires: [{ pack: 'base-pack', version: '^1.2.0' }] })
  });
  const result = validatePack(dir, { packsRoot: sandbox });
  assert.equal(result.ok, true);
});

test('依赖：semver 范围比较覆盖 ^ / ~ / 精确 / 比较符', () => {
  assert.equal(satisfiesVersion('1.4.2', '^1.2.0'), true);
  assert.equal(satisfiesVersion('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesVersion('1.2.9', '~1.2.0'), true);
  assert.equal(satisfiesVersion('1.3.0', '~1.2.0'), false);
  assert.equal(satisfiesVersion('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesVersion('1.2.4', '>=1.2.3 <2.0.0'), false);
  assert.equal(satisfiesVersion('1.5.0', '>=1.2.3 || <1.0.0'), true);
});

test('packs:add：生成的骨架可被校验通过', () => {
  const result = createPackSkeleton(join(sandbox, 'new-pack'), {
    name: '新包',
    vendor: '测试厂商',
    categories: ['气缸']
  });
  assert.equal(result.manifest.schemaVersion, 2);
  const validation = validatePack(result.dir);
  assert.equal(validation.ok, true);
  assert.equal(validation.stats.partsCount, 0);
  assert.equal(validation.stats.integrityOk, true);
  assert.match(readFileSync(join(result.dir, 'README.md'), 'utf8'), /packs:validate/);
});

test('packs:add：已有 manifest 时拒绝覆盖', () => {
  createPackSkeleton(join(sandbox, 'new-pack'), { name: '新包' });
  assert.throws(() => createPackSkeleton(join(sandbox, 'new-pack')), /已存在 manifest/);
});

test('加载：registry 在 checksum 不符时抛 PACK_INTEGRITY_FAILED 而非静默加载', () => {
  const dir = writePack('demo-pack', { manifest: manifest({ id: 'demo-pack', partsSha256: '0'.repeat(64) }) });
  const registry = new PackRegistry({
    builtinDir: sandbox,
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'state.json')
  });
  void dir;
  assert.throws(() => registry.loadPack('demo-pack'), /PACK_INTEGRITY_FAILED/);
});

test('加载：checksum 正确时 registry 正常加载', () => {
  writePack('demo-pack');
  const registry = new PackRegistry({
    builtinDir: sandbox,
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'state.json')
  });
  assert.equal(registry.loadPack('demo-pack').partCount, 2);
  assert.equal(registry.listParts({ packId: 'demo-pack' }).length, 2);
});

test('checksum：assertPartsIntegrity 对合法值放行、对篡改值报错', () => {
  const raw = '[]\n';
  assert.doesNotThrow(() => assertPartsIntegrity(raw, sha256Hex(raw), 'demo-pack'));
  assert.throws(() => assertPartsIntegrity(raw, 'f'.repeat(64), 'demo-pack'), /PACK_INTEGRITY_FAILED/);
});

test('checksum：Windows 的 CRLF 检出不应误判为篡改', () => {
  // 仓库里按 LF 计算 partsSha256；Windows（core.autocrlf=true）检出后是 CRLF。
  const lfText = '{\n  "schemaVersion": 2,\n  "parts": []\n}\n';
  const expected = sha256Hex(lfText);
  const crlfText = lfText.replace(/\n/g, '\r\n');
  assert.doesNotThrow(() => assertPartsIntegrity(crlfText, expected, 'demo-pack'));
  assert.doesNotThrow(() => assertPartsIntegrity(Buffer.from(crlfText, 'utf8'), expected, 'demo-pack'));
  const tampered = crlfText.replace('[]', '["x"]');
  assert.throws(() => assertPartsIntegrity(tampered, expected, 'demo-pack'), /PACK_INTEGRITY_FAILED/);
});

test('统计：每包条数与体积与源数据一致', () => {
  const stats = buildPackStats({ packsDir: BUILTIN_DIR, pricebookPath: PRICEBOOK, generatedAt: '2026-10-24T00:00:00.000Z' });
  for (const pack of stats.packs) {
    const partsPath = join(BUILTIN_DIR, pack.id, 'parts.json');
    if (!existsSync(partsPath)) {
      assert.equal(pack.parts, 0, `${pack.id} 无 parts.json 时应为 0 条`);
      assert.equal(pack.partsBytes, 0, `${pack.id} 无 parts.json 时体积为 0`);
      continue;
    }
    const source = JSON.parse(readFileSync(partsPath, 'utf8'));
    assert.equal(pack.parts, source.length, `${pack.id} 条数不一致`);
    assert.equal(pack.partsBytes, statSync(partsPath).size, `${pack.id} 体积不一致`);
  }
  assert.equal(stats.totals.parts, stats.packs.reduce((sum, pack) => sum + pack.parts, 0));
});

test('统计：去重后唯一型号与源数据一致', () => {
  const stats = buildPackStats({ packsDir: BUILTIN_DIR, pricebookPath: PRICEBOOK, generatedAt: '2026-10-24T00:00:00.000Z' });
  const models = new Set();
  for (const id of stats.packs.map((pack) => pack.id)) {
    const partsPath = join(BUILTIN_DIR, id, 'parts.json');
    if (!existsSync(partsPath)) continue;
    for (const part of JSON.parse(readFileSync(partsPath, 'utf8'))) {
      if (!part.aliasOf) models.add(String(part.model).trim().toLowerCase().replace(/\s+/g, ''));
    }
  }
  assert.equal(stats.totals.uniqueModels, models.size);
  assert.equal(stats.totals.parts, 617);
  assert.equal(stats.totals.activeParts, 612);
});

test('统计：跨包重复型号进入清单', () => {
  const shared = [{ id: 'A-1', model: 'SHARED-MODEL', category: '气缸', specs: {} }];
  writePack('alpha-pack', { parts: shared, manifest: manifest({ id: 'alpha-pack', categories: ['气缸'], partsCount: 1 }) });
  writePack('beta-pack', {
    parts: [{ id: 'B-1', model: 'SHARED-MODEL', category: '气缸', specs: {} }],
    manifest: manifest({ id: 'beta-pack', categories: ['气缸'], partsCount: 1 })
  });
  const stats = buildPackStats({ packsDir: sandbox, pricebookPath: join(sandbox, 'none.json'), generatedAt: '2026-10-24T00:00:00.000Z' });
  assert.equal(stats.duplicates.byModel.length, 1);
  assert.deepEqual(stats.duplicates.byModel[0].packs, ['alpha-pack', 'beta-pack']);
});

test('统计：分类矩阵行合计与包合计一致', () => {
  const stats = buildPackStats({ packsDir: BUILTIN_DIR, pricebookPath: PRICEBOOK, generatedAt: '2026-10-24T00:00:00.000Z' });
  for (const row of stats.categoryMatrix) {
    const sum = Object.values(row.counts).reduce((total, count) => total + count, 0);
    assert.equal(row.total, sum, `${row.category} 合计不一致`);
  }
  assert.equal(stats.categoryMatrix.reduce((sum, row) => sum + row.total, 0), stats.totals.parts);
});

test('统计：价格覆盖与价格簿命中一致', () => {
  const stats = buildPackStats({ packsDir: BUILTIN_DIR, pricebookPath: PRICEBOOK, generatedAt: '2026-10-24T00:00:00.000Z' });
  assert.equal(stats.priceCoverage.library.pricebookItems, 64);
  assert.equal(stats.totals.withPrice, stats.packs.reduce((sum, pack) => sum + pack.withPrice, 0));
  assert.equal(stats.priceCoverage.commonBom.total, 11);
  assert.equal(stats.priceCoverage.commonBom.models.filter((entry) => entry.priced).length, stats.priceCoverage.commonBom.hits);
});

test('统计：写出 md + json 且内容一致', () => {
  const outDir = join(sandbox, 'docs');
  const written = writePackStats({
    packsDir: BUILTIN_DIR,
    pricebookPath: PRICEBOOK,
    outDir,
    generatedAt: '2026-10-24T00:00:00.000Z'
  });
  const json = JSON.parse(readFileSync(written.jsonPath, 'utf8'));
  const markdown = readFileSync(written.mdPath, 'utf8');
  assert.equal(json.totals.parts, 617);
  assert.match(markdown, /# 数据包统计/);
  assert.match(markdown, /## 分类矩阵/);
  assert.match(markdown, /BOM 常见型号/);
  assert.match(renderPackStatsMarkdown(json), /总条数 \| 617/);
});

test('验收：10 个真实内置包全部校验通过', () => {
  const result = validatePackCatalog({ packsDir: BUILTIN_DIR });
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 5)));
  assert.equal(result.stats.packs, 10);
  assert.equal(result.stats.errors, 0);
  assert.equal(result.stats.parts, 617);
  assert.equal(result.stats.uniqueModels, 612);
  assert.equal(result.stats.categories, 55);
});

test('诊断：报告与格式化文本引用库统计摘要', () => {
  const report = buildDiagnosisReport({
    generatedAt: '2026-10-24T00:00:00.000Z',
    appVersion: '0.3.0',
    electronVersion: '45.0.0',
    nodeVersion: '24.7.0',
    platform: 'linux',
    userDataPath: '/tmp/userData',
    webgl: { available: false },
    dataPackVersion: 'iec-cn@1.2.0',
    packCount: 10,
    packStats: { packs: 10, parts: 617, activeParts: 612, uniqueModels: 612, categories: 55, errors: 0, warnings: 0 },
    kbDocs: 13,
    kbChunks: 354,
    auditBytes: 0,
    errors: []
  });
  assert.equal(report.packStats.parts, 617);
  const text = formatDiagnosisReport(report);
  assert.match(text, /包统计：10 个包 · 617 条/);
});
