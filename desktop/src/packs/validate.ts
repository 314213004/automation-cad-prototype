// 数据包校验器：manifest / parts / 校验和 / schema 迁移 / 跨包唯一性 / 依赖。
// 纯同步实现，CLI、单测、smoke 与 diagnose 共用同一套口径。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PackRequirement } from '../shared/types.ts';

export const PACK_INTEGRITY_FAILED = 'PACK_INTEGRITY_FAILED';
export const PARTS_SCHEMA_VERSION = 2;

const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface PackIssue {
  code: string;
  message: string;
  path?: string;
}

export interface PackValidationStats {
  id: string;
  name: string;
  version: string;
  schemaVersion: number;
  declaredPartsCount: number;
  partsCount: number;
  activeParts: number;
  aliasCount: number;
  categories: string[];
  categoryCount: number;
  partsBytes: number;
  hasParts: boolean;
  partsSha256: string | null;
  computedPartsSha256: string | null;
  integrityOk: boolean | null;
  withDims: number;
  withPrice: number;
  migratedFrom: number | null;
  requires: PackRequirement[];
}

export interface PackValidationResult {
  ok: boolean;
  errors: PackIssue[];
  warnings: PackIssue[];
  stats: PackValidationStats;
}

export interface PackCatalogStats {
  packs: number;
  parts: number;
  activeParts: number;
  aliases: number;
  uniqueModels: number;
  categories: number;
  errors: number;
  warnings: number;
}

export interface PackCatalogValidation {
  ok: boolean;
  packs: PackValidationResult[];
  errors: PackIssue[];
  warnings: PackIssue[];
  stats: PackCatalogStats;
}

export interface ValidatePackOptions {
  /** 跨包唯一性与依赖解析的根目录；默认取包目录的父目录。 */
  packsRoot?: string;
  /** 额外允许的分类（内置白名单之外）。 */
  allowedCategories?: Iterable<string>;
  /** 强制要求 manifest.partsSha256；缺省只告警。 */
  requireChecksum?: boolean;
}

interface PartsDocument {
  entries: unknown[];
  schemaVersion: number;
  migrated: boolean;
}

interface PackSnapshot {
  dir: string;
  base: string;
  manifestRaw: string | null;
  manifest: Record<string, unknown> | null;
  manifestError: string | null;
  partsRaw: string | null;
  partsDoc: PartsDocument | null;
  partsError: string | null;
  partsBytes: number;
  hasPricebook: boolean;
  latestMtimeMs: number;
}

interface ParsedRequirement {
  pack: string;
  version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function issue(code: string, message: string, path?: string): PackIssue {
  return {
    code,
    message,
    ...(path ? { path } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 校验 parts.json 原始字节的 SHA-256；manifest 未声明时视为通过。 */
export function assertPartsIntegrity(raw: string | Buffer, expected: string | undefined, packId: string): void {
  if (!expected) return;
  if (!SHA256_PATTERN.test(expected)) {
    throw new Error(`${PACK_INTEGRITY_FAILED} pack=${packId} manifest.partsSha256 不是合法的 SHA-256`);
  }
  const actual = sha256Hex(raw);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${PACK_INTEGRITY_FAILED} pack=${packId} expected=${expected.toLowerCase()} actual=${actual}`);
  }
}

/** 把 parts 文档解析为统一结构；显式 schemaVersion=1 时迁移并补默认字段。 */
export function parsePartsDocument(value: unknown): PartsDocument {
  if (Array.isArray(value)) {
    return { entries: value, schemaVersion: PARTS_SCHEMA_VERSION, migrated: false };
  }
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    throw new Error('parts.json 必须是元器件数组，或 { schemaVersion, parts: [] }');
  }
  const schemaVersion = value.schemaVersion === undefined ? PARTS_SCHEMA_VERSION : value.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== PARTS_SCHEMA_VERSION) {
    throw new Error(`parts.schemaVersion 必须为 1 或 ${PARTS_SCHEMA_VERSION}`);
  }
  const entries = value.parts;
  if (schemaVersion === 1) {
    const migrated = entries.map((entry) => {
      if (!isRecord(entry)) return entry;
      return {
        specs: {},
        ...entry,
        schemaVersion: PARTS_SCHEMA_VERSION
      };
    });
    return { entries: migrated, schemaVersion: PARTS_SCHEMA_VERSION, migrated: true };
  }
  return { entries, schemaVersion, migrated: false };
}

function readSnapshot(dir: string): PackSnapshot {
  const absolute = resolve(dir);
  const manifestPath = join(absolute, 'manifest.json');
  const partsPath = join(absolute, 'parts.json');
  const pricebookPath = join(absolute, 'pricebook.json');
  let manifestRaw: string | null = null;
  let manifest: Record<string, unknown> | null = null;
  let manifestError: string | null = null;
  let partsRaw: string | null = null;
  let partsDoc: PartsDocument | null = null;
  let partsError: string | null = null;
  let partsBytes = 0;
  let latestMtimeMs = 0;

  if (!existsSync(absolute)) {
    manifestError = `目录不存在：${absolute}`;
  } else if (!existsSync(manifestPath)) {
    manifestError = 'manifest.json 不存在';
  } else {
    try {
      manifestRaw = readFileSync(manifestPath, 'utf8');
      latestMtimeMs = Math.max(latestMtimeMs, statSync(manifestPath).mtimeMs);
      const parsed = JSON.parse(manifestRaw) as unknown;
      if (!isRecord(parsed)) throw new Error('manifest.json 必须是对象');
      manifest = parsed;
    } catch (error) {
      manifestError = errorMessage(error);
    }
  }

  if (existsSync(partsPath)) {
    try {
      partsRaw = readFileSync(partsPath, 'utf8');
      partsBytes = statSync(partsPath).size;
      latestMtimeMs = Math.max(latestMtimeMs, statSync(partsPath).mtimeMs);
      partsDoc = parsePartsDocument(JSON.parse(partsRaw) as unknown);
    } catch (error) {
      partsError = errorMessage(error);
    }
  }

  const hasPricebook = existsSync(pricebookPath);
  if (hasPricebook) {
    try {
      latestMtimeMs = Math.max(latestMtimeMs, statSync(pricebookPath).mtimeMs);
    } catch {
      // mtime 只用于统计展示，读取失败不影响校验结论。
    }
  }

  return {
    dir: absolute,
    base: basename(absolute),
    manifestRaw,
    manifest,
    manifestError,
    partsRaw,
    partsDoc,
    partsError,
    partsBytes,
    hasPricebook,
    latestMtimeMs
  };
}

function scanCatalog(packsRoot: string, targetDir?: string): PackSnapshot[] {
  const root = resolve(packsRoot);
  const target = targetDir ? resolve(targetDir) : null;
  const dirs = new Set<string>();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(root, entry.name);
      if (existsSync(join(dir, 'manifest.json')) || dir === target) dirs.add(dir);
    }
  }
  if (target) dirs.add(target);
  return [...dirs].sort().map((dir) => readSnapshot(dir));
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(nonEmptyString).map((item) => item.trim());
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | null {
  const match = SEMVER_PATTERN.exec(value.trim().replace(/^v/, ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(left: { major: number; minor: number; patch: number }, right: { major: number; minor: number; patch: number }): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function nextMajor(version: { major: number; minor: number; patch: number }) {
  return { major: version.major + 1, minor: 0, patch: 0 };
}

function nextMinor(version: { major: number; minor: number; patch: number }) {
  return { major: version.major, minor: version.minor + 1, patch: 0 };
}

function matchesRange(versionText: string, range: string): boolean {
  const version = parseSemver(versionText);
  if (!version) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed.toLowerCase() === 'latest') return true;
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const baseText = match[2]!.trim().replace(/^v/, '');
  const base = parseSemver(baseText);
  if (!base) return false;
  const comparison = compareSemver(version, base);
  if (operator === '=') return comparison === 0;
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '~') return comparison >= 0 && compareSemver(version, nextMinor(base)) < 0;
  if (operator === '^') {
    const upper = base.major > 0
      ? nextMajor(base)
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: base.patch + 1 };
    return comparison >= 0 && compareSemver(version, upper) < 0;
  }
  return false;
}

export function satisfiesVersion(version: string, range: string): boolean {
  return range.split('||').some((part) => matchesRange(version, part));
}

function isValidVersionRange(value: string): boolean {
  const parts = value.split('||').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    if (part === '*' || part.toLowerCase() === 'latest') return true;
    const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part);
    return Boolean(match && parseSemver(match[2]!));
  });
}

function parseRequirements(value: unknown, errors: PackIssue[]): ParsedRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(issue('PACK_REQUIRES_INVALID', 'manifest.requires 必须是数组', 'manifest.requires'));
    return [];
  }
  const requirements: ParsedRequirement[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(issue('PACK_REQUIRES_INVALID', `manifest.requires[${index}] 必须是对象`, `manifest.requires[${index}]`));
      return;
    }
    if (!nonEmptyString(entry.pack)) {
      errors.push(issue('PACK_REQUIRES_INVALID', `manifest.requires[${index}].pack 必须是非空字符串`, `manifest.requires[${index}].pack`));
      return;
    }
    if (!nonEmptyString(entry.version)) {
      errors.push(issue('PACK_REQUIRES_INVALID', `manifest.requires[${index}].version 必须是非空字符串`, `manifest.requires[${index}].version`));
      return;
    }
    const range = entry.version.trim();
    if (!isValidVersionRange(range)) {
      errors.push(issue('PACK_DEPENDENCY_INVALID', `依赖 ${entry.pack.trim()} 的版本范围不合法：${range}`, `manifest.requires[${index}].version`));
      return;
    }
    requirements.push({ pack: entry.pack.trim(), version: range });
  });
  return requirements;
}

function partIds(snapshot: PackSnapshot): string[] {
  const entries = snapshot.partsDoc?.entries ?? [];
  return entries
    .filter(isRecord)
    .map((entry) => (nonEmptyString(entry.id) ? entry.id.trim() : ''))
    .filter(Boolean);
}

function validateSnapshot(
  snapshot: PackSnapshot,
  catalog: PackSnapshot[],
  options: ValidatePackOptions
): PackValidationResult {
  const errors: PackIssue[] = [];
  const warnings: PackIssue[] = [];
  const manifest = snapshot.manifest;
  const dirId = snapshot.base;

  if (snapshot.manifestError) {
    errors.push(issue('PACK_MANIFEST_INVALID', `manifest.json 无法读取：${snapshot.manifestError}`, 'manifest.json'));
  }

  let id = dirId;
  let name = '';
  let version = '';
  let schemaVersion = 0;
  let declaredPartsCount = 0;
  let categories: string[] = [];
  let requirements: ParsedRequirement[] = [];
  let expectedSha: string | null = null;

  if (manifest) {
    for (const key of ['schemaVersion', 'id', 'name', 'version', 'partsCount', 'categories'] as const) {
      if (!(key in manifest)) {
        errors.push(issue('PACK_MANIFEST_FIELD_MISSING', `缺少必填字段：manifest.${key}`, `manifest.${key}`));
      }
    }

    if (manifest.schemaVersion !== undefined) {
      if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
        errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.schemaVersion 必须为 1 或 2', 'manifest.schemaVersion'));
      } else {
        schemaVersion = manifest.schemaVersion;
      }
    }

    if (!nonEmptyString(manifest.id)) {
      errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.id 必须是非空字符串', 'manifest.id'));
    } else {
      id = manifest.id.trim();
      if (!PACK_ID_PATTERN.test(id)) {
        errors.push(issue('PACK_MANIFEST_INVALID', `manifest.id 格式不合法：${id}`, 'manifest.id'));
      }
      if (id !== dirId) {
        errors.push(issue('PACK_ID_DIR_MISMATCH', `manifest.id (${id}) 与目录名 (${dirId}) 不一致`, 'manifest.id'));
      }
    }

    if (!nonEmptyString(manifest.name)) {
      errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.name 必须是非空字符串', 'manifest.name'));
    } else {
      name = manifest.name.trim();
    }

    if (!nonEmptyString(manifest.version)) {
      errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.version 必须是非空 semver 字符串', 'manifest.version'));
    } else {
      version = manifest.version.trim();
      if (!SEMVER_PATTERN.test(version)) {
        errors.push(issue('PACK_MANIFEST_INVALID', `manifest.version 不是合法 semver：${version}`, 'manifest.version'));
      }
    }

    if (!Number.isInteger(manifest.partsCount) || (manifest.partsCount as number) < 0) {
      errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.partsCount 必须是非负整数', 'manifest.partsCount'));
    } else {
      declaredPartsCount = manifest.partsCount as number;
    }

    if (!Array.isArray(manifest.categories) || manifest.categories.length === 0) {
      errors.push(issue('PACK_MANIFEST_INVALID', 'manifest.categories 必须是非空字符串数组', 'manifest.categories'));
    } else {
      const seen = new Set<string>();
      manifest.categories.forEach((category, index) => {
        if (!nonEmptyString(category)) {
          errors.push(issue('PACK_MANIFEST_INVALID', `manifest.categories[${index}] 必须是非空字符串`, `manifest.categories[${index}]`));
          return;
        }
        const value = category.trim();
        if (seen.has(value)) {
          warnings.push(issue('PACK_CATEGORY_DUPLICATE', `manifest.categories 重复项已忽略：${value}`, 'manifest.categories'));
        } else {
          seen.add(value);
        }
      });
      categories = [...seen];
    }

    if (!nonEmptyString(manifest.vendor)) {
      warnings.push(issue('PACK_MANIFEST_VENDOR_MISSING', 'manifest.vendor 缺失或为空；内置包建议补齐', 'manifest.vendor'));
    }
    for (const key of ['license', 'description'] as const) {
      if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
        errors.push(issue('PACK_MANIFEST_INVALID', `manifest.${key} 必须是字符串`, `manifest.${key}`));
      }
    }

    requirements = parseRequirements(manifest.requires, errors);

    if (manifest.partsSha256 !== undefined) {
      if (typeof manifest.partsSha256 !== 'string' || !SHA256_PATTERN.test(manifest.partsSha256)) {
        errors.push(issue('PACK_SHA_INVALID', 'manifest.partsSha256 必须是 64 位十六进制 SHA-256', 'manifest.partsSha256'));
      } else {
        expectedSha = manifest.partsSha256.toLowerCase();
      }
    }
  }

  if (snapshot.partsError) {
    errors.push(issue('PACK_PARTS_JSON_INVALID', `parts.json 无法解析：${snapshot.partsError}`, 'parts.json'));
  }

  const entries = snapshot.partsDoc?.entries ?? [];
  if (!snapshot.partsDoc && !snapshot.hasPricebook && !snapshot.partsError) {
    errors.push(issue('PACK_DATA_MISSING', '包内既没有 parts.json，也没有 pricebook.json', 'parts.json'));
  }
  if (snapshot.partsDoc?.migrated) {
    warnings.push(issue(
      'PACK_SCHEMA_MIGRATED',
      `parts.schemaVersion 1 → ${PARTS_SCHEMA_VERSION}：已为 ${entries.length} 条补默认字段（specs={}、schemaVersion=${PARTS_SCHEMA_VERSION}）`,
      'parts.json'
    ));
  }
  if (snapshot.partsDoc && !expectedSha && !options.requireChecksum) {
    warnings.push(issue('PACK_SHA_MISSING', 'manifest 未声明 partsSha256，加载时无法发现数据被篡改', 'manifest.partsSha256'));
  }
  if (snapshot.partsDoc && !expectedSha && options.requireChecksum) {
    errors.push(issue('PACK_SHA_MISSING', 'manifest 必须声明 partsSha256', 'manifest.partsSha256'));
  }

  const manifestCategories = new Set(categories);
  const globalCategories = new Set<string>();
  for (const candidate of catalog) {
    for (const category of asStringArray(candidate.manifest?.categories)) globalCategories.add(category);
  }
  for (const category of options.allowedCategories ?? []) globalCategories.add(category);
  for (const category of manifestCategories) globalCategories.add(category);

  const localIds = new Set<string>();
  const localModels = new Set<string>();
  const actualCategories = new Set<string>();
  let aliasCount = 0;
  let activeParts = 0;
  let withDims = 0;
  let withPrice = 0;

  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(issue('PACK_PART_INVALID', `parts[${index}] 必须是对象`, `parts[${index}]`));
      return;
    }
    const path = `parts[${index}]`;

    if (!nonEmptyString(entry.id)) {
      errors.push(issue('PACK_PART_ID_INVALID', `${path}.id 必须是非空字符串`, `${path}.id`));
    } else {
      const partId = entry.id.trim();
      if (localIds.has(partId)) {
        errors.push(issue('PACK_DUPLICATE_ID', `包内重复 id：${partId}`, `${path}.id`));
      } else {
        localIds.add(partId);
      }
    }

    if (!nonEmptyString(entry.model)) {
      errors.push(issue('PACK_PART_MODEL_INVALID', `${path}.model 必须是非空字符串`, `${path}.model`));
    } else {
      localModels.add(entry.model.trim().toLocaleLowerCase('zh-CN'));
    }

    if (!nonEmptyString(entry.category)) {
      errors.push(issue('PACK_PART_CATEGORY_INVALID', `${path}.category 必须是非空字符串`, `${path}.category`));
    } else {
      const category = entry.category.trim();
      actualCategories.add(category);
      if (!globalCategories.has(category)) {
        errors.push(issue('PACK_PART_CATEGORY_UNKNOWN', `分类不在白名单：${category}`, `${path}.category`));
      } else if (!manifestCategories.has(category)) {
        warnings.push(issue('PACK_CATEGORY_UNDECLARED', `分类 ${category} 未写入 manifest.categories`, `${path}.category`));
      }
    }

    const specs = entry.specs;
    if (specs !== undefined) {
      if (!isRecord(specs)) {
        errors.push(issue('PACK_PART_SPECS_INVALID', `${path}.specs 必须是对象`, `${path}.specs`));
      } else {
        for (const [key, value] of Object.entries(specs)) {
          if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
              errors.push(issue('PACK_NUMBER_INVALID', `${path}.specs.${key} 必须是有限数值`, `${path}.specs.${key}`));
            }
          } else if (typeof value !== 'string') {
            errors.push(issue('PACK_PART_SPECS_INVALID', `${path}.specs.${key} 必须是字符串或数字`, `${path}.specs.${key}`));
          }
        }
      }
    }

    if (entry.price !== undefined) {
      if (typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price < 0) {
        errors.push(issue('PACK_NUMBER_INVALID', `${path}.price 必须是非负有限数`, `${path}.price`));
      }
    }

    if (entry.dims !== undefined) {
      if (!isRecord(entry.dims)) {
        errors.push(issue('PACK_NUMBER_INVALID', `${path}.dims 必须是 {w,h,d}`, `${path}.dims`));
      } else {
        for (const key of ['w', 'h', 'd'] as const) {
          const value = entry.dims[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            errors.push(issue('PACK_NUMBER_INVALID', `${path}.dims.${key} 必须是有限正数`, `${path}.dims.${key}`));
          }
        }
        if (entry.dims.source !== undefined && typeof entry.dims.source !== 'string') {
          errors.push(issue('PACK_PART_INVALID', `${path}.dims.source 必须是字符串`, `${path}.dims.source`));
        }
        if (entry.dims.estimated !== undefined && typeof entry.dims.estimated !== 'boolean') {
          errors.push(issue('PACK_PART_INVALID', `${path}.dims.estimated 必须是布尔值`, `${path}.dims.estimated`));
        }
      }
    }

    if (entry.moduleWidth !== undefined &&
        (typeof entry.moduleWidth !== 'number' || !Number.isFinite(entry.moduleWidth) || entry.moduleWidth <= 0)) {
      errors.push(issue('PACK_NUMBER_INVALID', `${path}.moduleWidth 必须是有限正数`, `${path}.moduleWidth`));
    }

    if (entry.aliasOf !== undefined && !nonEmptyString(entry.aliasOf)) {
      errors.push(issue('PACK_PART_INVALID', `${path}.aliasOf 必须是非空字符串`, `${path}.aliasOf`));
    }

    if (nonEmptyString(entry.aliasOf)) aliasCount += 1;
    if (!nonEmptyString(entry.aliasOf)) {
      activeParts += 1;
      if (isRecord(entry.dims) &&
          typeof entry.dims.w === 'number' && Number.isFinite(entry.dims.w) && entry.dims.w > 0 &&
          typeof entry.dims.h === 'number' && Number.isFinite(entry.dims.h) && entry.dims.h > 0 &&
          typeof entry.dims.d === 'number' && Number.isFinite(entry.dims.d) && entry.dims.d > 0) {
        withDims += 1;
      }
      if (typeof entry.price === 'number' && Number.isFinite(entry.price) && entry.price >= 0) withPrice += 1;
    }
  });

  if (manifest && Number.isInteger(manifest.partsCount) && (manifest.partsCount as number) >= 0) {
    if ((manifest.partsCount as number) !== entries.length) {
      errors.push(issue(
        'PACK_PARTS_COUNT_MISMATCH',
        `manifest.partsCount=${manifest.partsCount} 与实际条数 ${entries.length} 不一致`,
        'manifest.partsCount'
      ));
    }
  }

  const otherIds = new Map<string, string>();
  for (const candidate of catalog) {
    if (candidate === snapshot) continue;
    const candidateId = nonEmptyString(candidate.manifest?.id) ? candidate.manifest.id.trim() : candidate.base;
    for (const partId of partIds(candidate)) {
      if (!otherIds.has(partId)) otherIds.set(partId, candidateId);
    }
  }
  for (const partId of localIds) {
    const otherPack = otherIds.get(partId);
    if (otherPack) {
      errors.push(issue('PACK_DUPLICATE_ID', `跨包重复 id：${partId}（同时存在于 ${otherPack}）`, 'parts.json'));
    }
  }

  const allIds = new Set<string>(localIds);
  for (const partId of otherIds.keys()) allIds.add(partId);
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || !nonEmptyString(entry.aliasOf)) return;
    const target = entry.aliasOf.trim();
    if (!allIds.has(target)) {
      warnings.push(issue('PACK_ALIAS_TARGET_MISSING', `aliasOf 指向不存在的 id：${target}`, `parts[${index}].aliasOf`));
    }
  });

  const computedSha = snapshot.partsRaw !== null ? sha256Hex(snapshot.partsRaw) : null;
  if (expectedSha && computedSha && expectedSha !== computedSha) {
    errors.push(issue(
      PACK_INTEGRITY_FAILED,
      `parts.json 校验和不匹配：expected=${expectedSha} actual=${computedSha}`,
      'manifest.partsSha256'
    ));
  }

  const versions = new Map<string, string>();
  for (const candidate of catalog) {
    if (nonEmptyString(candidate.manifest?.id) && nonEmptyString(candidate.manifest.version)) {
      versions.set(candidate.manifest.id.trim(), candidate.manifest.version.trim());
    }
  }
  for (const requirement of requirements) {
    if (requirement.pack === id) {
      errors.push(issue('PACK_DEPENDENCY_SELF', `数据包不能依赖自身：${id}`, 'manifest.requires'));
      continue;
    }
    const requiredVersion = versions.get(requirement.pack);
    if (!requiredVersion) {
      errors.push(issue('PACK_DEPENDENCY_MISSING', `缺少依赖包 ${requirement.pack}`, 'manifest.requires'));
    } else if (!satisfiesVersion(requiredVersion, requirement.version)) {
      errors.push(issue(
        'PACK_DEPENDENCY_VERSION',
        `依赖 ${requirement.pack} 需要 ${requirement.version}，实际 ${requiredVersion}`,
        'manifest.requires'
      ));
    }
  }

  const stats: PackValidationStats = {
    id,
    name,
    version,
    schemaVersion,
    declaredPartsCount,
    partsCount: entries.length,
    activeParts,
    aliasCount,
    categories: [...actualCategories].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    categoryCount: actualCategories.size,
    partsBytes: snapshot.partsBytes,
    hasParts: snapshot.partsDoc !== null,
    partsSha256: expectedSha,
    computedPartsSha256: computedSha,
    integrityOk: expectedSha && computedSha ? expectedSha === computedSha : null,
    withDims,
    withPrice,
    migratedFrom: snapshot.partsDoc?.migrated ? 1 : null,
    requires: requirements.map((requirement) => ({ ...requirement }))
  };

  return { ok: errors.length === 0, errors, warnings, stats };
}

export function validatePack(dir: string, options: ValidatePackOptions = {}): PackValidationResult {
  const absolute = resolve(dir);
  const root = resolve(options.packsRoot ?? dirname(absolute));
  const catalog = scanCatalog(root, absolute);
  const snapshot = catalog.find((candidate) => candidate.dir === absolute) ?? readSnapshot(absolute);
  return validateSnapshot(snapshot, catalog, options);
}

export function validatePackCatalog(options: {
  packsDir: string;
  allowedCategories?: Iterable<string>;
  requireChecksum?: boolean;
}): PackCatalogValidation {
  const catalog = scanCatalog(options.packsDir);
  const packs = catalog.map((snapshot) => validateSnapshot(snapshot, catalog, {
    packsRoot: options.packsDir,
    ...(options.allowedCategories ? { allowedCategories: options.allowedCategories } : {}),
    ...(options.requireChecksum ? { requireChecksum: true } : {})
  }));
  const errors = packs.flatMap((pack) => pack.errors);
  const warnings = packs.flatMap((pack) => pack.warnings);
  const models = new Set<string>();
  const categories = new Set<string>();
  let parts = 0;
  let activeParts = 0;
  for (const snapshot of catalog) {
    for (const entry of snapshot.partsDoc?.entries ?? []) {
      if (!isRecord(entry)) continue;
      parts += 1;
      if (nonEmptyString(entry.category)) categories.add(entry.category.trim());
      if (!nonEmptyString(entry.aliasOf)) {
        activeParts += 1;
        if (nonEmptyString(entry.model)) models.add(entry.model.trim().toLocaleLowerCase('zh-CN'));
      }
    }
  }
  return {
    ok: errors.length === 0,
    packs,
    errors,
    warnings,
    stats: {
      packs: packs.length,
      parts,
      activeParts,
      aliases: parts - activeParts,
      uniqueModels: models.size,
      categories: categories.size,
      errors: errors.length,
      warnings: warnings.length
    }
  };
}
