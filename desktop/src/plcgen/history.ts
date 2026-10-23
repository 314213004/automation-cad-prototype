/** PLC 生成历史：最近 10 次，按 inputHash 去重（同一输入只保留最新一条）。 */

export const PLC_HISTORY_LIMIT = 10;

export interface PlcHistoryFile {
  path: string;
  lines: number;
  bytes: number;
}

export interface PlcHistoryEntry {
  at: string;
  inputHash: string;
  files: number;
  target: string;
  namePrefix: string;
  fileList: PlcHistoryFile[];
  zipPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function parseFileList(value: unknown): PlcHistoryFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.path !== 'string' || !item.path) return [];
    return [{
      path: item.path,
      lines: positiveInteger(item.lines),
      bytes: positiveInteger(item.bytes)
    }];
  });
}

/** 把 IPC / JSON 中的未知值收敛成合法历史条目；无效条目返回 null。 */
export function normalizeHistoryEntry(value: unknown): PlcHistoryEntry | null {
  if (!isRecord(value)) return null;
  const inputHash = text(value.inputHash).trim();
  const at = text(value.at).trim();
  if (!inputHash || !at) return null;
  const entry: PlcHistoryEntry = {
    at,
    inputHash,
    files: positiveInteger(value.files),
    target: text(value.target, 'generic') || 'generic',
    namePrefix: text(value.namePrefix),
    fileList: parseFileList(value.fileList)
  };
  const zipPath = text(value.zipPath).trim();
  if (zipPath) entry.zipPath = zipPath;
  return entry;
}

/** 读取历史 JSON（数组）并去重、截断；损坏条目跳过。 */
export function parsePlcHistory(value: unknown, limit = PLC_HISTORY_LIMIT): PlcHistoryEntry[] {
  const source = Array.isArray(value) ? value : [];
  let history: PlcHistoryEntry[] = [];
  // 存储顺序为新→旧；从旧往新合并，保证最新条目仍在最前。
  for (const item of [...source].reverse()) {
    const entry = normalizeHistoryEntry(item);
    if (entry) history = mergePlcHistory(history, entry, limit);
  }
  return history;
}

/** 新条目在前；同 inputHash 的旧条目移除；最多保留 limit 条。 */
export function mergePlcHistory(
  history: readonly PlcHistoryEntry[],
  entry: PlcHistoryEntry,
  limit = PLC_HISTORY_LIMIT
): PlcHistoryEntry[] {
  const max = Math.max(1, Math.trunc(limit));
  return [entry, ...history.filter((item) => item.inputHash !== entry.inputHash)].slice(0, max);
}

export interface HistoryEntryFromResult {
  inputHash: string;
  target: string;
  namePrefix: string;
  at?: string;
  files: Array<{ path: string; lines: number; bytes: number }>;
}

export function createHistoryEntry(value: HistoryEntryFromResult): PlcHistoryEntry {
  return {
    at: value.at ?? new Date().toISOString(),
    inputHash: value.inputHash,
    files: value.files.length,
    target: value.target,
    namePrefix: value.namePrefix,
    fileList: value.files.map((file) => ({ ...file }))
  };
}
