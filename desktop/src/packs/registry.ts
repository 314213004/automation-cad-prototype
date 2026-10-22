import AdmZip from 'adm-zip';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ComponentPart, PackInfo, PackManifest } from '../shared/types';

export interface PackRegistryOptions {
  builtinDir: string;
  userDir: string;
  stateFile: string;
}

interface LoadedPack {
  info: PackInfo;
  manifest?: PackManifest;
  parts: ComponentPart[];
}

interface PackState {
  disabled: string[];
}

const MANIFEST_REQUIRED = ['schemaVersion', 'id', 'name', 'vendor', 'version'] as const;
const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SYMBOL_PATTERN = /^[a-z][a-z0-9]{0,7}$/;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function validateManifest(value: unknown): PackManifest {
  if (!isRecord(value)) throw new Error('manifest.json 必须是对象');
  for (const key of MANIFEST_REQUIRED) {
    if (!(key in value)) throw new Error(`manifest.json 缺少字段：${key}`);
  }
  if (value.schemaVersion !== 1) throw new Error('manifest.schemaVersion 必须为 1');
  if (typeof value.id !== 'string' || !PACK_ID_PATTERN.test(value.id)) throw new Error('manifest.id 格式不合法');
  for (const key of ['name', 'vendor', 'version'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`manifest.${key} 必须是非空字符串`);
    }
  }
  for (const key of ['license', 'description'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`manifest.${key} 必须是字符串`);
    }
  }
  const manifest: PackManifest = {
    schemaVersion: 1,
    id: value.id,
    name: value.name as string,
    vendor: value.vendor as string,
    version: value.version as string
  };
  if (typeof value.license === 'string') manifest.license = value.license;
  if (typeof value.description === 'string') manifest.description = value.description;
  return manifest;
}

function validateParts(value: unknown, packId: string, packName: string): ComponentPart[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.parts)
      ? value.parts
      : null;
  if (!source) throw new Error('parts.json 必须是元器件数组');
  const seen = new Set<string>();
  return source.map((item, index) => {
    if (!isRecord(item)) throw new Error(`parts[${index}] 必须是对象`);
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw new Error(`parts[${index}] 缺少 id`);
    }
    if (seen.has(item.id)) throw new Error(`parts 中存在重复 id：${item.id}`);
    seen.add(item.id);
    if (typeof item.model !== 'string' || item.model.trim() === '') {
      throw new Error(`parts[${index}].model 必须是非空字符串`);
    }
    if (typeof item.category !== 'string' || item.category.trim() === '') {
      throw new Error(`parts[${index}].category 必须是非空字符串`);
    }
    const rawSpecs = isRecord(item.specs) ? item.specs : {};
    const specs: Record<string, string | number> = {};
    for (const [key, spec] of Object.entries(rawSpecs)) {
      if (typeof spec !== 'string' && typeof spec !== 'number') {
        throw new Error(`parts[${index}].specs.${key} 必须是字符串或数字`);
      }
      specs[key] = spec;
    }
    if (item.price !== undefined && typeof item.price !== 'number') {
      throw new Error(`parts[${index}].price 必须是数字`);
    }
    const part: ComponentPart = {
      id: item.id,
      model: item.model,
      category: item.category,
      specs,
      packId,
      packName
    };
    if (typeof item.vendor === 'string') part.vendor = item.vendor;
    if (item.symbol !== undefined) {
      if (typeof item.symbol !== 'string' || (item.symbol !== '' && !SYMBOL_PATTERN.test(item.symbol))) {
        throw new Error(`parts[${index}].symbol 必须是 1-8 位小写字母开头的键`);
      }
      if (item.symbol !== '') part.symbol = item.symbol;
    }
    if (item.dims !== undefined) {
      if (!isRecord(item.dims) || !isPositiveNumber(item.dims.w) || !isPositiveNumber(item.dims.h) || !isPositiveNumber(item.dims.d)) {
        throw new Error(`parts[${index}].dims 必须是 {w,h,d} 正数`);
      }
      part.dims = { w: item.dims.w, h: item.dims.h, d: item.dims.d };
    }
    if (item.railMount !== undefined) {
      if (typeof item.railMount !== 'boolean') throw new Error(`parts[${index}].railMount 必须是布尔值`);
      part.railMount = item.railMount;
    }
    if (item.moduleWidth !== undefined) {
      if (!isPositiveNumber(item.moduleWidth)) throw new Error(`parts[${index}].moduleWidth 必须是正数`);
      part.moduleWidth = item.moduleWidth;
    }
    if (typeof item.asset === 'string') part.asset = item.asset;
    if (typeof item.thumbnail === 'string') part.thumbnail = item.thumbnail;
    if (typeof item.price === 'number') part.price = item.price;
    return part;
  });
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeZipEntryName(name: string): string {
  if (name.includes('\\')) throw new Error(`ZIP 路径包含反斜杠，已拒绝：${name}`);
  if (name.includes('\0')) throw new Error('ZIP 路径包含非法字符');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`ZIP 包含绝对路径：${name}`);
  const normalized = name.replace(/\/+/g, '/');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`ZIP 包含路径穿越：${name}`);
  }
  return normalized;
}

export class PackRegistry {
  private readonly builtinDir: string;
  private readonly userDir: string;
  private readonly stateFile: string;

  constructor(options: PackRegistryOptions) {
    this.builtinDir = resolve(options.builtinDir);
    this.userDir = resolve(options.userDir);
    this.stateFile = resolve(options.stateFile);
  }

  async scan(): Promise<PackInfo[]> {
    return this.scanSync();
  }

  private scanSync(): PackInfo[] {
    const disabled = new Set(this.readState().disabled);
    const byId = new Map<string, LoadedPack>();
    for (const [root, builtin] of [
      [this.builtinDir, true],
      [this.userDir, false]
    ] as const) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const loaded = this.loadPackDirectory(join(root, entry.name), entry.name, builtin, disabled);
        if (!byId.has(loaded.info.id)) byId.set(loaded.info.id, loaded);
      }
    }
    return Array.from(byId.values()).map((pack) => pack.info);
  }

  listParts(filter: { q?: string; category?: string; packId?: string } = {}): ComponentPart[] {
    const q = filter.q?.trim().toLocaleLowerCase('zh-CN');
    const category = filter.category?.trim().toLocaleLowerCase('zh-CN');
    const result: ComponentPart[] = [];
    const disabled = new Set(this.readState().disabled);
    for (const [root, builtin] of [
      [this.builtinDir, true],
      [this.userDir, false]
    ] as const) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const loaded = this.loadPackDirectory(join(root, entry.name), entry.name, builtin, disabled);
        if (!loaded.manifest || loaded.info.error || !loaded.info.enabled) continue;
        if (filter.packId && loaded.info.id !== filter.packId) continue;
        for (const part of loaded.parts) {
          if (category && part.category.toLocaleLowerCase('zh-CN') !== category) continue;
          if (q) {
            const haystack = [
              part.id,
              part.model,
              part.category,
              part.vendor ?? '',
              part.packId ?? '',
              part.packName ?? '',
              ...Object.values(part.specs).map(String)
            ].join(' ').toLocaleLowerCase('zh-CN');
            if (!haystack.includes(q)) continue;
          }
          result.push(part);
        }
      }
    }
    return result;
  }

  async importZip(zipPath: string): Promise<PackInfo> {
    const absoluteZip = resolve(zipPath);
    if (!existsSync(absoluteZip) || !statSync(absoluteZip).isFile()) throw new Error(`ZIP 文件不存在：${zipPath}`);
    const zip = new AdmZip(absoluteZip);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    for (const entry of entries) safeZipEntryName(entry.entryName);

    const manifestEntries = entries.filter((entry) => {
      const parts = safeZipEntryName(entry.entryName).split('/');
      return parts[parts.length - 1] === 'manifest.json' && parts.length <= 2;
    });
    if (manifestEntries.length !== 1) throw new Error('ZIP 根目录必须包含唯一的 manifest.json');
    const manifestEntry = manifestEntries[0]!;
    const manifestName = safeZipEntryName(manifestEntry.entryName);
    const rootPrefix = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : '';
    const rootFolder = rootPrefix ? rootPrefix.slice(0, -1) : '';
    const manifest = validateManifest(JSON.parse(manifestEntry.getData().toString('utf8')) as unknown);
    if (rootFolder && rootFolder !== manifest.id) {
      throw new Error(`manifest.id (${manifest.id}) 与 ZIP 根目录名 (${rootFolder}) 不一致`);
    }
    const partsEntry = entries.find((entry) => safeZipEntryName(entry.entryName) === `${rootPrefix}parts.json`);
    if (!partsEntry) throw new Error('ZIP 中缺少 parts.json');
    const parts = validateParts(JSON.parse(partsEntry.getData().toString('utf8')) as unknown, manifest.id, manifest.name);
    if (parts.length === 0) throw new Error('parts.json 不能为空');

    const target = join(this.userDir, manifest.id);
    if (existsSync(target) || existsSync(join(this.builtinDir, manifest.id))) {
      throw new Error(`数据包 id 已存在：${manifest.id}`);
    }

    mkdirSync(this.userDir, { recursive: true });
    const tempDir = join(this.userDir, `.import-${manifest.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempDir, { recursive: false });
    try {
      for (const entry of entries) {
        const safeName = safeZipEntryName(entry.entryName);
        if (rootPrefix) {
          if (!safeName.startsWith(rootPrefix)) throw new Error(`ZIP 文件不在包根目录内：${entry.entryName}`);
        }
        const relativeName = safeName.slice(rootPrefix.length);
        if (!relativeName) continue;
        const destination = resolve(tempDir, relativeName);
        if (!isPathInside(tempDir, destination)) throw new Error(`ZIP 路径穿越：${entry.entryName}`);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, entry.getData());
      }
      if (!existsSync(join(tempDir, 'manifest.json')) || !existsSync(join(tempDir, 'parts.json'))) {
        throw new Error('ZIP 解压后缺少 manifest.json 或 parts.json');
      }
      const loaded = this.loadPackDirectory(tempDir, manifest.id, false, new Set(), manifest.id);
      if (loaded.info.error) throw new Error(loaded.info.error);
      renameSync(tempDir, target);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
    const loaded = this.loadPackDirectory(target, manifest.id, false, new Set(this.readState().disabled));
    if (loaded.info.error) throw new Error(loaded.info.error);
    return loaded.info;
  }

  async setEnabled(id: string, on: boolean): Promise<void> {
    const allIds = new Set(this.scanSync().map((pack) => pack.id));
    if (!allIds.has(id)) throw new Error(`数据包不存在：${id}`);
    const state = this.readState();
    const disabled = new Set(state.disabled);
    if (on) disabled.delete(id);
    else disabled.add(id);
    this.writeState({ disabled: Array.from(disabled).sort() });
  }

  async remove(id: string): Promise<void> {
    if (existsSync(join(this.builtinDir, id))) throw new Error('内置数据包不可删除');
    const target = join(this.userDir, id);
    if (!existsSync(target)) throw new Error(`用户数据包不存在：${id}`);
    rmSync(target, { recursive: true, force: true });
    const disabled = this.readState().disabled.filter((packId) => packId !== id);
    this.writeState({ disabled });
  }

  private loadPackDirectory(
    dir: string,
    directoryName: string,
    builtin: boolean,
    disabled: Set<string>,
    expectedId = directoryName
  ): LoadedPack {
    const fallback: PackInfo = {
      id: directoryName,
      name: directoryName,
      vendor: '',
      version: '',
      enabled: !disabled.has(directoryName),
      builtin,
      path: dir,
      partCount: 0
    };
    try {
      const manifest = validateManifest(readJson(join(dir, 'manifest.json')));
      if (manifest.id !== expectedId) {
        throw new Error(`manifest.id (${manifest.id}) 与目录名 (${directoryName}) 不一致`);
      }
      const parts = validateParts(readJson(join(dir, 'parts.json')), manifest.id, manifest.name);
      return {
        manifest,
        parts,
        info: {
          id: manifest.id,
          name: manifest.name,
          vendor: manifest.vendor,
          version: manifest.version,
          ...(manifest.description ? { description: manifest.description } : {}),
          ...(manifest.license ? { license: manifest.license } : {}),
          enabled: !disabled.has(manifest.id),
          builtin,
          path: dir,
          partCount: parts.length
        }
      };
    } catch (error) {
      return {
        parts: [],
        info: {
          ...fallback,
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private readState(): PackState {
    try {
      const value = readJson(this.stateFile);
      if (!isRecord(value) || !Array.isArray(value.disabled)) return { disabled: [] };
      return { disabled: value.disabled.filter((item): item is string => typeof item === 'string') };
    } catch {
      return { disabled: [] };
    }
  }

  private writeState(state: PackState): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.stateFile);
  }
}

export { validateManifest, validateParts };
