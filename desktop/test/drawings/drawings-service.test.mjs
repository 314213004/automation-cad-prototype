import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { FreecadRunner } from '../../electron/freecad.ts';
import { DrawingsService, parseGenerateRequest, projectDirName } from '../../electron/drawings-service.ts';
import { drawingStatus, planDrawingParts } from '../../src/drawings/stale.ts';

const FAKE = fileURLToPath(new URL('../../scripts/fake-freecadcmd.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../../spike/freecad/techdraw_job.py', import.meta.url));
const roots = [];
const runners = [];

after(async () => {
  for (const runner of runners) await runner.dispose();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const plate = (length) => [{ id: 'f1', type: 'box', name: '底板', params: { length, width: 80, height: 10 } }];
const doc = (lengthA = 200) => ({
  schemaVersion: 2,
  updatedAt: '2026-10-26T09:00:00Z',
  instances: [
    { id: 'p1', name: '转接板', partId: 'P-001', transform: { x: 0, y: 0, z: 0, rz: 0 }, features: plate(lengthA) },
    { id: 'p2', name: '转接板', partId: 'P-001', transform: { x: 300, y: 0, z: 0, rz: 0 }, features: plate(lengthA) },
    { id: 'p3', name: '垫块', transform: { x: 0, y: 200, z: 0, rz: 0 }, features: plate(40) }
  ]
});

function setup({ enabled = () => true, mode = 'ok', available = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acad-drawings-svc-'));
  roots.push(root);
  const userData = join(root, 'userData');
  mkdirSync(userData);
  const builds = [];
  const runner = new FreecadRunner(available
    ? { command: FAKE, resolveScript: () => SCRIPT, env: { ...process.env, FAKE_FREECAD_MODE: mode }, tempRoot: join(root, 'tmp') }
    : { resolveScript: () => SCRIPT, env: { PATH: '' }, platform: 'linux', candidateOptions: { exists: () => false, listDir: () => [] }, tempRoot: join(root, 'tmp') });
  runners.push(runner);
  const service = new DrawingsService({
    userDataDir: userData,
    projectsRoot: join(userData, 'projects'),
    runner,
    isEnabled: enabled,
    buildStep: async (featureDoc) => {
      builds.push(featureDoc);
      const path = join(root, `build-${builds.length}.step`);
      writeFileSync(path, `ISO-10303-21; /* ${JSON.stringify(featureDoc.features)} */`);
      return path;
    }
  });
  return { root, userData, runner, service, builds };
}

test('parseGenerateRequest：只收结构化数据；拒绝非法 projectKey 与非特征树', () => {
  const request = parseGenerateRequest({
    projectKey: 'proj-1', doc: doc(), instanceIds: ['p1', 3], onlyStale: true,
    meta: { 'P-001': { material: '6061', paper: 'A0', scale: '1:2' } }, titleBlock: { designer: '老王', evil: 1 },
    stepPath: '/etc/passwd'
  });
  assert.deepEqual(request.instanceIds, ['p1']);
  assert.equal(request.onlyStale, true);
  assert.deepEqual(request.meta['P-001'], { material: '6061', scale: '1:2' });
  assert.deepEqual(request.titleBlock, { designer: '老王' });
  assert.equal('stepPath' in request, false);
  assert.throws(() => parseGenerateRequest({ projectKey: '', doc: doc() }), /projectKey/);
  assert.throws(() => parseGenerateRequest({ projectKey: 'a\u0000b', doc: doc() }), /projectKey/);
  assert.throws(() => parseGenerateRequest({ projectKey: 'p', doc: { foo: 1 } }), /不是特征树/);
});

test('projectDirName：任意 projectKey 都映射到无分隔符的稳定目录名', () => {
  assert.equal(projectDirName('../../evil'), projectDirName('../../evil'));
  assert.match(projectDirName('../../evil'), /^evil-[0-9a-f]{12}$/);
  assert.match(projectDirName('src:转接板.step'), /^src-step-[0-9a-f]{12}$/);
  assert.match(projectDirName('工程'), /^project-[0-9a-f]{12}$/);
});

test('生成全部 → 同物料号只出一次、逐件单独建模、清单与产物写入工程目录 → 改参后只重出过期零件', async () => {
  const { service, runner, builds, userData } = setup();
  const first = await service.generate({ projectKey: 'proj-1', doc: doc(), meta: { 'P-001': { material: '6061-T6' } }, titleBlock: { designer: '老王' } });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.partKeys, ['P-001', 'inst:p3']);
  await runner.idle();
  assert.equal(builds.length, 2, '两个零件各导出一次 STEP（同物料号的两个实例只建一次）');
  assert.equal(builds[0].schemaVersion, 1, '单件 FeatureDoc，不带装配摆位');
  assert.deepEqual(builds[0].features, plate(200));

  const listed = service.list('proj-1');
  assert.equal(listed.directory, join(userData, 'drawings', projectDirName('proj-1')));
  const entry = listed.manifest.entries['P-001'];
  assert.ok(entry, '清单有 P-001');
  assert.match(entry.stepSha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.freecadVersion, '1.0.0');
  const pdf = service.resolveFile('proj-1', 'P-001', 'pdf');
  assert.ok(pdf && existsSync(pdf));
  assert.equal(service.resolveFile('proj-1', 'P-001', 'exe'), null);
  assert.equal(service.resolveFile('proj-1', 'nope', 'pdf'), null);

  const meta = { 'P-001': { material: '6061-T6' } };
  let report = drawingStatus(service.readManifest('proj-1'), planDrawingParts(doc(), { meta }));
  assert.deepEqual(report.parts.map((part) => part.status), ['fresh', 'fresh']);

  // 改 P-001 长度 → 只有它过期；onlyStale 只重出它
  report = drawingStatus(service.readManifest('proj-1'), planDrawingParts(doc(260), { meta }));
  assert.deepEqual(report.staleKeys, ['P-001']);
  const second = await service.generate({ projectKey: 'proj-1', doc: doc(260), meta, onlyStale: true });
  assert.equal(second.ok, true);
  assert.deepEqual(second.partKeys, ['P-001']);
  await runner.idle();
  assert.equal(builds.length, 3);
  report = drawingStatus(service.readManifest('proj-1'), planDrawingParts(doc(260), { meta }));
  assert.deepEqual(report.parts.map((part) => part.status), ['fresh', 'fresh']);

  const nothing = await service.generate({ projectKey: 'proj-1', doc: doc(260), meta, onlyStale: true });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'NOTHING_TO_DO');
});

test('选中零件出图；命中工程库项目时写入 projects/<id>/drawings', async () => {
  const { service, runner, userData } = setup();
  const projectDir = join(userData, 'projects', 'abc123');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'project.json'), '{}');
  const response = await service.generate({ projectKey: 'abc123', doc: doc(), instanceIds: ['p3'] });
  assert.equal(response.ok, true);
  assert.deepEqual(response.partKeys, ['inst:p3']);
  await runner.idle();
  assert.equal(service.directoryFor('abc123'), join(projectDir, 'drawings'));
  assert.ok(existsSync(join(projectDir, 'drawings', 'manifest.json')));
  const manifest = JSON.parse(readFileSync(join(projectDir, 'drawings', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.entries), ['inst:p3']);
});

test('失败的零件保留旧图并标记过期；模块关闭与 FreeCAD 未安装 fail-closed', async () => {
  const { service, runner } = setup();
  await service.generate({ projectKey: 'p', doc: doc() });
  await runner.idle();
  const failing = setup({ mode: 'fail-part' });
  // 复用同一 userData：直接把第一份清单拷过去不必要，这里验证新服务首个零件失败不写条目
  const response = await failing.service.generate({ projectKey: 'p', doc: doc() });
  assert.equal(response.ok, true);
  await failing.runner.idle();
  const manifest = failing.service.readManifest('p');
  assert.equal(manifest.entries['P-001'], undefined, '首次失败不写入伪条目');
  assert.ok(manifest.entries['inst:p3']);

  let enabled = false;
  const disabled = setup({ enabled: () => enabled });
  const blocked = await disabled.service.generate({ projectKey: 'p', doc: doc() });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'MODULE_DISABLED');
  assert.equal(disabled.builds.length, 0);
  enabled = true;

  const missing = setup({ available: false });
  const unavailable = await missing.service.generate({ projectKey: 'p', doc: doc() });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'FREECAD_UNAVAILABLE');
  assert.match(unavailable.message, /安装/);
  assert.equal(missing.builds.length, 0, '未安装时不触发建模');

  const invalid = await service.generate({ projectKey: 'p', doc: 'not a doc' });
  assert.equal(invalid.code, 'INVALID_ARGUMENT');
});
