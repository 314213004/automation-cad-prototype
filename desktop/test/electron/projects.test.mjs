import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deleteProject, listProjects, openProject, projectsRoot, saveProject } from '../../electron/projects.ts';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-'));
  roots.push(root);
  const step = join(root, 'model.step');
  const stl = join(root, 'model.stl');
  writeFileSync(step, 'STEP-BYTES');
  writeFileSync(stl, 'STL-BYTES');
  const partA = join(root, '01-rail.stl');
  const partB = join(root, '02-cross.stl');
  writeFileSync(partA, 'A');
  writeFileSync(partB, 'B');
  return { root, step, stl, partA, partB };
}

function save(root, extra = {}) {
  const files = workspaceFiles.get(root);
  return saveProject(root, {
    name: '皮带输送线 2400×400',
    process: 'conveyor',
    params: { lengthMm: 2400, widthMm: 400 },
    parts: 2,
    massKg: 85.41,
    envelope: [2450, 695, 930],
    material: ['铝型材 6063-T5'],
    stepPath: files.step,
    stlPath: files.stl,
    partPaths: [
      { name: '侧纵梁（操作侧）', path: files.partA },
      { name: '横撑 1', path: files.partB }
    ],
    ...extra
  });
}

const workspaceFiles = new Map();

function setup() {
  const files = workspace();
  workspaceFiles.set(files.root, files);
  return files;
}

test('保存后出现在列表里，STEP/STL/逐件网格都落到工程目录', () => {
  const { root } = setup();
  const saved = save(root);
  assert.equal(saved.ok, true);
  assert.equal(saved.record?.parts, 2);
  assert.equal(saved.record?.massKg, 85.41);
  assert.ok(existsSync(join(projectsRoot(root), saved.record.id, 'model.step')));
  assert.ok(existsSync(join(projectsRoot(root), saved.record.id, 'model.stl')));
  assert.equal(saved.record.partsList.length, 2);
  assert.equal(saved.record.hasStep, true);

  const list = listProjects(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '皮带输送线 2400×400');
});

test('同名保存覆盖，不堆副本；零件数变小后旧网格被清掉', () => {
  const { root } = setup();
  save(root);
  save(root, { parts: 1, partPaths: [{ name: '只有一个', path: workspaceFiles.get(root).partA }] });
  const list = listProjects(root);
  assert.equal(list.length, 1, '同名应覆盖');
  assert.equal(list[0].parts, 1);
  assert.equal(list[0].partsList.length, 1);

  const opened = openProject(root, list[0].id);
  assert.equal(opened.ok, true);
  assert.equal(opened.partPaths.length, 1, '残留的逐件网格必须清掉');
});

test('重新打开按零件序返回路径与中文零件名', () => {
  const { root } = setup();
  const saved = save(root);
  const opened = openProject(root, saved.record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.record.name, '皮带输送线 2400×400');
  assert.deepEqual(opened.partPaths.map((item) => item.name), ['侧纵梁（操作侧）', '横撑 1']);
  for (const item of opened.partPaths) assert.ok(existsSync(item.path));
  assert.ok(opened.stepPath && existsSync(opened.stepPath));
});

test('工程名里的路径分隔符等非法字符被清理，不会写到目录外', () => {
  const { root } = setup();
  const saved = save(root, { name: '../../逃逸/皮带线' });
  assert.equal(saved.ok, true);
  const dir = join(projectsRoot(root), saved.record.id);
  assert.ok(dir.startsWith(projectsRoot(root)), '工程目录必须在 projects 根目录下');
  assert.ok(!saved.record.id.includes('/'));
});

test('空名字被拒绝；不存在的工程打开/删除给出原因', () => {
  const { root } = setup();
  assert.equal(save(root, { name: '   ' }).ok, false);
  assert.equal(openProject(root, '不存在').ok, false);
  assert.match(openProject(root, '不存在').message ?? '', /不存在/);
  assert.equal(deleteProject(root, '不存在').ok, false);
});

test('删除工程连同文件一起移除', () => {
  const { root } = setup();
  const saved = save(root);
  const dir = join(projectsRoot(root), saved.record.id);
  assert.ok(existsSync(dir));
  assert.equal(deleteProject(root, saved.record.id).ok, true);
  assert.ok(!existsSync(dir));
  assert.equal(listProjects(root).length, 0);
});

test('损坏的 project.json 不会让列表崩掉，也不冒充工程', () => {
  const { root } = setup();
  const saved = save(root);
  writeFileSync(join(projectsRoot(root), saved.record.id, 'project.json'), '{ 坏掉的 json');
  assert.deepEqual(listProjects(root), []);
});

test('列表按创建时间倒序，新的在最前', () => {
  const { root } = setup();
  const first = save(root, { name: '老工程' });
  // 直接改时间，避免依赖真实时钟
  const path = join(projectsRoot(root), first.record.id, 'project.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.createdAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(path, JSON.stringify(record));
  save(root, { name: '新工程' });
  const list = listProjects(root);
  assert.equal(list[0].name, '新工程');
  assert.equal(list[1].name, '老工程');
});
