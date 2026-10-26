// 画布草稿的磁盘存储（主进程侧，node:fs）。
//
// 和 design/draft-store 同一套约定：userData 目录、0600 权限、先写 .tmp 再 rename（避免半截文件）。
// 区别：画布图会随节点变多，加 1.5MB 上限——超了直接报错，而不是悄悄写坏磁盘；
// 读的时候坏文件不删，返回 recovered=true 让上层提示「草稿损坏，已回退到内置示例」。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANVAS_DRAFT_FILE = 'canvas-workbench-draft.json';
/** 1.5MB：约等于 3000 个节点的 JSON，远超实际用量，只用来挡异常放大。 */
export const CANVAS_DRAFT_MAX_BYTES = 1_500_000;

export interface CanvasDraftReadResult {
  draft: unknown | null;
  /** 文件存在但解析失败。 */
  recovered: boolean;
  path: string;
}

export function canvasDraftPath(userDataDir: string): string {
  return join(userDataDir, CANVAS_DRAFT_FILE);
}

export function readCanvasDraft(userDataDir: string): CanvasDraftReadResult {
  const path = canvasDraftPath(userDataDir);
  if (!existsSync(path)) return { draft: null, recovered: false, path };
  try {
    const size = statSync(path).size;
    if (size > CANVAS_DRAFT_MAX_BYTES) return { draft: null, recovered: true, path };
    return { draft: JSON.parse(readFileSync(path, 'utf8')) as unknown, recovered: false, path };
  } catch {
    return { draft: null, recovered: true, path };
  }
}

export function writeCanvasDraft(userDataDir: string, draft: unknown): { path: string; bytes: number } {
  const text = `${JSON.stringify(draft, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CANVAS_DRAFT_MAX_BYTES) {
    throw new Error(`画布草稿 ${bytes} 字节，超过 ${CANVAS_DRAFT_MAX_BYTES} 上限（节点过多或混入了大数组）`);
  }
  mkdirSync(userDataDir, { recursive: true });
  const path = canvasDraftPath(userDataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    if (process.platform === 'win32') rmSync(path, { force: true });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, bytes };
}

export function clearCanvasDraft(userDataDir: string): void {
  rmSync(canvasDraftPath(userDataDir), { force: true });
}
