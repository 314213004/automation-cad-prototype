/**
 * 审计文件落盘：按大小轮转 + 保留期清理（迭代：审计轮转）
 *
 * `audit.ts` 保持纯函数（格式化、脱敏、解析）；这里是唯一碰文件系统的一层，
 * 只在主进程使用。文件布局（以默认 `agent-audit.jsonl` 为例）：
 *
 *   agent-audit.jsonl      当前写入文件（最新）
 *   agent-audit.1.jsonl    上一次轮转
 *   agent-audit.2.jsonl    更早 …… 直到 agent-audit.<maxFiles>.jsonl
 *
 * 规则：
 * - 写入前若「当前大小 + 本行」超过 maxBytes 且当前文件非空，先轮转：
 *   .N-1 → .N（超出 maxFiles 的直接删除），当前 → .1，再写入新文件；
 * - 保留期按文件 mtime（= 该文件最后一条记录的写入时间）判断：
 *   早于 now - retentionDays 的轮转文件删除；当前文件整份过期也删除；
 *   编号大于 maxFiles 的残留（例如调小了 maxFiles）一并清理；
 * - 所有错误只回调 onError，不抛，审计不允许影响主流程。
 *
 * 读取：`readAuditEntries` 按「最旧轮转 → 当前」顺序拼接，坏行沿用 parseAuditLines 跳过。
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseAuditLines, type AgentAuditEntry } from './audit.ts';

export interface AuditRetentionOptions {
  /** 单个审计文件上限（字节），超过即轮转。默认 5 MB。 */
  maxBytes: number;
  /** 保留的轮转文件份数（不含当前文件）。默认 5。 */
  maxFiles: number;
  /** 保留期（天）；0 表示不按时间清理。默认 90。 */
  retentionDays: number;
}

export const DEFAULT_AUDIT_RETENTION: AuditRetentionOptions = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 5,
  retentionDays: 90
});

/** 配置文件名（放在 userData 下，可选）。 */
export const AUDIT_RETENTION_FILE = 'agent-audit-retention.json';

const LIMITS = {
  maxBytes: { min: 64 * 1024, max: 512 * 1024 * 1024 },
  maxFiles: { min: 1, max: 50 },
  retentionDays: { min: 0, max: 3650 }
} as const;

function pick(value: unknown, key: keyof AuditRetentionOptions): number {
  const fallback = DEFAULT_AUDIT_RETENTION[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const { min, max } = LIMITS[key];
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** 非法/缺省字段回落默认值，越界值夹到合法区间（例如 maxBytes 最小 64 KB）。 */
export function normalizeAuditRetention(input?: Partial<AuditRetentionOptions> | null): AuditRetentionOptions {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    maxBytes: pick(source.maxBytes, 'maxBytes'),
    maxFiles: pick(source.maxFiles, 'maxFiles'),
    retentionDays: pick(source.retentionDays, 'retentionDays')
  };
}

/** 读取 userData/agent-audit-retention.json；不存在或损坏时用默认值。 */
export function loadAuditRetention(userDataDir: string): AuditRetentionOptions {
  try {
    const file = join(userDataDir, AUDIT_RETENTION_FILE);
    if (!existsSync(file)) return { ...DEFAULT_AUDIT_RETENTION };
    return normalizeAuditRetention(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_AUDIT_RETENTION };
  }
}

/** agent-audit.jsonl + 2 → agent-audit.2.jsonl */
export function rotatedAuditPath(file: string, index: number): string {
  const ext = extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  return `${stem}.${index}${ext}`;
}

/** 目录里属于该审计文件的轮转序号（含超出 maxFiles 的残留），升序。 */
export function listRotatedIndexes(file: string): number[] {
  const dir = dirname(file);
  const name = basename(file);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escape(stem)}\\.(\\d+)${escape(ext)}$`);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((entry) => entry.match(pattern)?.[1])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 当前 → .1，.k → .k+1；超过 maxFiles 的删除。返回是否发生了轮转。 */
export function rotateAuditFile(file: string, options: AuditRetentionOptions): boolean {
  if (!existsSync(file) || fileSize(file) === 0) return false;
  const indexes = listRotatedIndexes(file);
  // 先删掉轮转后会超出上限的旧文件（含残留的大编号）。
  for (const index of indexes) {
    if (index >= options.maxFiles) unlinkSync(rotatedAuditPath(file, index));
  }
  for (const index of indexes.filter((value) => value < options.maxFiles).sort((left, right) => right - left)) {
    renameSync(rotatedAuditPath(file, index), rotatedAuditPath(file, index + 1));
  }
  renameSync(file, rotatedAuditPath(file, 1));
  return true;
}

export interface AuditPruneResult {
  removed: string[];
}

/** 保留期 + 份数清理。只删除整份文件，不改写文件内容。 */
export function pruneAuditFiles(
  file: string,
  options: AuditRetentionOptions,
  now: Date = new Date()
): AuditPruneResult {
  const removed: string[] = [];
  const cutoff = options.retentionDays > 0 ? now.getTime() - options.retentionDays * 86_400_000 : null;
  const expired = (path: string): boolean => {
    if (cutoff === null) return false;
    try {
      return statSync(path).mtimeMs < cutoff;
    } catch {
      return false;
    }
  };
  for (const index of listRotatedIndexes(file)) {
    const path = rotatedAuditPath(file, index);
    if (index > options.maxFiles || expired(path)) {
      unlinkSync(path);
      removed.push(path);
    }
  }
  if (existsSync(file) && expired(file)) {
    unlinkSync(file);
    removed.push(file);
  }
  return { removed };
}

export interface AuditFileWriterOptions {
  retention?: Partial<AuditRetentionOptions>;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/**
 * 给 createAuditLog 用的 write 回调：先按大小轮转再追加。
 * 创建时做一次保留期清理；之后每次轮转后再清理一次（轮转频率低，代价可忽略）。
 */
export function createAuditFileWriter(file: string, options: AuditFileWriterOptions = {}): (line: string) => void {
  const retention = normalizeAuditRetention(options.retention);
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };
  try {
    pruneAuditFiles(file, retention, now());
  } catch (error) {
    report(error);
  }
  return (line: string) => {
    const payload = `${line}\n`;
    try {
      const size = fileSize(file);
      if (size > 0 && size + Buffer.byteLength(payload, 'utf8') > retention.maxBytes) {
        rotateAuditFile(file, retention);
        pruneAuditFiles(file, retention, now());
      }
    } catch (error) {
      // 轮转失败不阻止写入：宁可单文件超限，也不丢审计。
      report(error);
    }
    appendFileSync(file, payload, 'utf8');
  };
}

export interface AuditReadResult {
  entries: AgentAuditEntry[];
  /** 实际读到的文件（最旧 → 最新）。 */
  files: string[];
}

/** 按「最旧轮转 → 当前」顺序读取全部审计文件；坏行跳过，单个文件读失败也跳过。 */
export function readAuditEntries(file: string, options?: Partial<AuditRetentionOptions>): AuditReadResult {
  const retention = normalizeAuditRetention(options);
  const files: string[] = [];
  const entries: AgentAuditEntry[] = [];
  const indexes = listRotatedIndexes(file)
    .filter((index) => index <= retention.maxFiles)
    .sort((left, right) => right - left);
  for (const path of [...indexes.map((index) => rotatedAuditPath(file, index)), file]) {
    if (!existsSync(path)) continue;
    try {
      entries.push(...parseAuditLines(readFileSync(path, 'utf8')));
      files.push(path);
    } catch {
      // 单个文件不可读（权限/被并发删除）时跳过，保留其余审计。
    }
  }
  return { entries, files };
}
