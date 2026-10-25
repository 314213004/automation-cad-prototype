/**
 * 工程库（项目下拉的数据源）。
 *
 * 一个整机模型 = 一个目录：userData/projects/<id>/
 *   project.json   名称/机型/参数/质量/零件数/创建时间
 *   model.step     合并实体（给外部 CAD 用）
 *   model.stl      合并网格
 *   parts/NN-*.stl 逐件网格（重新打开时按零件装配，零件树/干涉检查才有意义）
 *
 * 只存内核真实产出的文件，不做二次建模。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface ProjectRecord {
  id: string;
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: number | null;
  envelope: [number, number, number] | null;
  material: string[];
  createdAt: string;
  /** 单件网格：file 是 parts/ 下的文件名，name 是零件名（零件树显示用） */
  partsList: Array<{ file: string; name: string }>;
  hasStep: boolean;
  hasStl: boolean;
  bytes: number;
}

export interface ProjectSaveInput {
  name: string;
  process: string;
  params?: Record<string, number>;
  parts: number;
  massKg?: number | null;
  envelope?: [number, number, number] | null;
  material?: string[];
  stepPath?: string | null;
  stlPath?: string | null;
  partPaths?: Array<{ name: string; path: string }>;
}

export interface ProjectOpenResult {
  ok: boolean;
  record?: ProjectRecord;
  /** 逐件 STL 的绝对路径，按零件序 */
  partPaths?: Array<{ name: string; path: string }>;
  stepPath?: string | null;
  message?: string;
}

const MAX_PROJECTS = 200;

export function projectsRoot(userDataDir: string): string {
  return join(userDataDir, 'projects');
}

function sanitizeId(value: string): string {
  const safe = value.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return safe || 'project';
}

function projectDir(userDataDir: string, id: string): string {
  return join(projectsRoot(userDataDir), sanitizeId(id));
}

function readRecord(dir: string): ProjectRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as ProjectRecord;
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/** 列出全部工程，按创建时间倒序（新的在前）。 */
export function listProjects(userDataDir: string): ProjectRecord[] {
  const root = projectsRoot(userDataDir);
  if (!existsSync(root)) return [];
  const records: ProjectRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(join(root, entry.name));
    if (record) records.push(record);
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return records.slice(0, MAX_PROJECTS);
}

/**
 * 保存一个工程。同名工程覆盖（id 由名字派生），保证下拉里不会堆一堆"皮带输送机-2-3"。
 */
export function saveProject(userDataDir: string, input: ProjectSaveInput): { ok: boolean; record?: ProjectRecord; message?: string } {
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: '工程名不能为空' };
  const id = sanitizeId(name);
  const dir = projectDir(userDataDir, id);
  try {
    mkdirSync(join(dir, 'parts'), { recursive: true });
    // 先清掉旧的逐件网格，避免参数变小后残留多余零件
    for (const file of readdirSync(join(dir, 'parts'))) {
      rmSync(join(dir, 'parts', file), { force: true });
    }
    const partsList: Array<{ file: string; name: string }> = [];
    for (const item of input.partPaths ?? []) {
      if (!item?.path || !existsSync(item.path)) continue;
      const safe = sanitizeId(basename(item.path).replace(/\.stl$/i, ''));
      const target = join(dir, 'parts', `${safe}.stl`);
      copyFileSync(item.path, target);
      partsList.push({ file: `${safe}.stl`, name: String(item.name ?? safe) });
    }
    let hasStep = false;
    let hasStl = false;
    if (input.stepPath && existsSync(input.stepPath)) {
      copyFileSync(input.stepPath, join(dir, 'model.step'));
      hasStep = true;
    }
    if (input.stlPath && existsSync(input.stlPath)) {
      copyFileSync(input.stlPath, join(dir, 'model.stl'));
      hasStl = true;
    }
    const bytes = directoryBytes(dir);
    const record: ProjectRecord = {
      id,
      name,
      process: String(input.process ?? 'unknown'),
      params: input.params ?? {},
      parts: Number(input.parts ?? partsList.length),
      massKg: typeof input.massKg === 'number' ? input.massKg : null,
      envelope: input.envelope ?? null,
      material: input.material ?? [],
      createdAt: new Date().toISOString(),
      partsList,
      hasStep,
      hasStl,
      bytes
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(record, null, 2), 'utf8');
    return { ok: true, record };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function openProject(userDataDir: string, id: string): ProjectOpenResult {
  const dir = projectDir(userDataDir, id);
  const record = readRecord(dir);
  if (!record) return { ok: false, message: `工程「${id}」不存在或已损坏` };
  const partsDir = join(dir, 'parts');
  const partPaths: Array<{ name: string; path: string }> = [];
  // partsList 的顺序就是零件序，名字来自保存时记录（零件树要显示中文名）
  for (const entry of record.partsList ?? []) {
    const path = join(partsDir, entry.file);
    if (!existsSync(path)) continue;
    partPaths.push({ name: entry.name, path });
  }
  const stepPath = join(dir, 'model.step');
  return {
    ok: true,
    record,
    partPaths,
    stepPath: existsSync(stepPath) ? stepPath : null
  };
}

export function deleteProject(userDataDir: string, id: string): { ok: boolean; message?: string } {
  const dir = projectDir(userDataDir, id);
  if (!existsSync(dir)) return { ok: false, message: `工程「${id}」不存在` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else total += statSync(path).size;
  }
  return total;
}
