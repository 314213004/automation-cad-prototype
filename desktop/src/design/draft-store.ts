import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DESIGN_DRAFT_FILE = 'design-draft.json';

export function readDesignDraft(userDataDir: string): { draft: unknown | null; recovered: boolean } {
  const path = join(userDataDir, DESIGN_DRAFT_FILE);
  if (!existsSync(path)) return { draft: null, recovered: false };
  try {
    return { draft: JSON.parse(readFileSync(path, 'utf8')) as unknown, recovered: false };
  } catch {
    return { draft: null, recovered: true };
  }
}

export function writeDesignDraft(userDataDir: string, draft: unknown): void {
  mkdirSync(userDataDir, { recursive: true });
  const path = join(userDataDir, DESIGN_DRAFT_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    if (process.platform === 'win32') rmSync(path, { force: true });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function clearDesignDraft(userDataDir: string): void {
  rmSync(join(userDataDir, DESIGN_DRAFT_FILE), { force: true });
}
