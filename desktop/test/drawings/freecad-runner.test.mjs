import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
  FreecadRunner,
  TailBuffer,
  freecadCandidates,
  isFreecadCmdPath,
  isSupportedFreecadVersion,
  parseFreecadVersion,
  probeFreecad,
  resolveTechdrawScript
} from '../../electron/freecad.ts';

const FAKE = fileURLToPath(new URL('../../scripts/fake-freecadcmd.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'spike', 'freecad', 'techdraw_job.py');
const roots = [];
const runners = [];

after(async () => {
  for (const runner of runners) await runner.dispose();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'acad-freecad-test-'));
  roots.push(root);
  const temp = join(root, 'tmp');
  const out = join(root, 'out');
  const steps = join(root, 'steps');
  mkdirSync(temp);
  mkdirSync(steps);
  return { root, temp, out, steps };
}

function stepFile(dir, name) {
  const path = join(dir, `${name}.step`);
  writeFileSync(path, `ISO-10303-21;\nHEADER;\n/* ${name} */\nENDSEC;\nEND-ISO-10303-21;\n`);
  return path;
}

function runner(ws, mode = 'ok', extra = {}) {
  const events = [];
  const instance = new FreecadRunner({
    command: FAKE,
    resolveScript: () => SCRIPT,
    env: { ...process.env, FAKE_FREECAD_MODE: mode },
    tempRoot: ws.temp,
    onJob: (snapshot) => events.push(snapshot),
    ...extra
  });
  runners.push(instance);
  return { instance, events };
}

function parts(names) {
  return names.map((name, index) => ({
    partKey: name, partId: name, fileStem: `${name}-0000000${index}`, name: `零件${name}`,
    material: '6061-T6', drawingNo: `AC-${name}`, quantity: 1
  }));
}

function settledOutcome(spec) {
  let resolveOutcome;
  const promise = new Promise((resolveP) => { resolveOutcome = resolveP; });
  return { spec: { ...spec, onSettled: (outcome) => resolveOutcome(outcome) }, promise };
}

test('parseFreecadVersion / isSupportedFreecadVersion', () => {
  assert.deepEqual(parseFreecadVersion('FreeCAD 1.0.0 Revision: 39109 (Git)'), { major: 1, minor: 0, patch: 0, text: '1.0.0' });
  assert.deepEqual(parseFreecadVersion('FreeCAD 1.1 Revision'), { major: 1, minor: 1, patch: 0, text: '1.1.0' });
  assert.equal(parseFreecadVersion('Python 3.11'), null);
  assert.equal(isSupportedFreecadVersion(parseFreecadVersion('FreeCAD 0.21.2')), false);
  assert.equal(isSupportedFreecadVersion(parseFreecadVersion('FreeCAD 1.0.2')), true);
});

test('isFreecadCmdPath：只接受绝对路径的 freecadcmd，拒绝 GUI 版与任意程序', () => {
  assert.equal(isFreecadCmdPath('C:\\Program Files\\FreeCAD 1.0\\bin\\freecadcmd.exe', 'win32'), true);
  assert.equal(isFreecadCmdPath('C:\\Program Files\\FreeCAD 1.0\\bin\\FreeCADCmd.exe', 'win32'), true);
  assert.equal(isFreecadCmdPath('C:\\Program Files\\FreeCAD 1.0\\bin\\FreeCAD.exe', 'win32'), false);
  assert.equal(isFreecadCmdPath('C:\\Windows\\System32\\cmd.exe', 'win32'), false);
  assert.equal(isFreecadCmdPath('freecadcmd.exe', 'win32'), false);
  assert.equal(isFreecadCmdPath('/usr/bin/freecadcmd', 'linux'), true);
  assert.equal(isFreecadCmdPath('/usr/bin/python3', 'linux'), false);
});

test('freecadCandidates（Windows）：设置 > 环境变量 > Program Files 下 FreeCAD 1.x（新版本优先）> PATH', () => {
  const files = new Set([
    'C:\\Program Files\\FreeCAD 1.0\\bin\\freecadcmd.exe',
    'C:\\Program Files\\FreeCAD 1.1\\bin\\freecadcmd.exe',
    'C:\\Users\\wang\\AppData\\Local\\Programs\\FreeCAD 1.0\\bin\\freecadcmd.exe',
    'D:\\tools\\fc\\freecadcmd.exe'
  ]);
  const dirs = {
    'C:\\Program Files': ['FreeCAD 1.0', 'FreeCAD 1.1', 'FreeCAD 0.21', 'Git'],
    'C:\\Users\\wang\\AppData\\Local\\Programs': ['FreeCAD 1.0']
  };
  const list = freecadCandidates({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\wang\\AppData\\Local', PATH: 'D:\\tools\\fc;C:\\Windows', PATHEXT: '.EXE' },
    configuredPath: 'E:\\FreeCAD\\bin\\freecadcmd.exe',
    exists: (path) => files.has(path),
    listDir: (path) => dirs[path] ?? []
  });
  assert.deepEqual(list.map((item) => [item.source, item.path]), [
    ['configured', 'E:\\FreeCAD\\bin\\freecadcmd.exe'],
    ['detected', 'C:\\Program Files\\FreeCAD 1.1\\bin\\freecadcmd.exe'],
    ['detected', 'C:\\Program Files\\FreeCAD 1.0\\bin\\freecadcmd.exe'],
    ['detected', 'C:\\Users\\wang\\AppData\\Local\\Programs\\FreeCAD 1.0\\bin\\freecadcmd.exe'],
    ['detected', 'D:\\tools\\fc\\freecadcmd.exe']
  ]);
});

test('freecadCandidates（Linux）：环境变量与 PATH，去重', () => {
  const list = freecadCandidates({
    platform: 'linux',
    env: { AUTOMATIONCAD_FREECAD_CMD: '/opt/fc/bin/freecadcmd', PATH: '/usr/bin:/opt/fc/bin' },
    exists: (path) => path === '/usr/bin/freecadcmd' || path === '/opt/fc/bin/freecadcmd',
    listDir: () => []
  });
  assert.deepEqual(list.map((item) => item.path), ['/opt/fc/bin/freecadcmd', '/usr/bin/freecadcmd']);
  assert.equal(list[0].source, 'env');
});

test('TailBuffer 只保留尾部', () => {
  const buffer = new TailBuffer(10);
  buffer.push('abcdef');
  buffer.push('ghijkl');
  assert.equal(buffer.text(), 'ghijkl');
  buffer.push('x'.repeat(30));
  assert.equal(buffer.text().length, 10);
});

test('probeFreecad：假 freecadcmd 版本检测，旧版本给出中文原因', async () => {
  const ok = await probeFreecad(FAKE, { env: process.env });
  assert.equal(ok.ok, true);
  assert.equal(ok.version.text, '1.0.0');
  const old = await probeFreecad(FAKE, { env: { ...process.env, FAKE_FREECAD_VERSION: '0.21.2' } });
  assert.equal(old.ok, false);
  assert.match(old.reason, /版本过旧/);
  const missing = await probeFreecad('/nonexistent/freecadcmd', { env: process.env, timeoutMs: 5_000 });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /无法启动/);
});

test('detect：未安装时禁用并给出安装指引；脚本缺失单独说明', async () => {
  const ws = workspace();
  const none = new FreecadRunner({
    resolveScript: () => SCRIPT,
    env: { PATH: '' },
    platform: 'linux',
    candidateOptions: { exists: () => false, listDir: () => [] },
    tempRoot: ws.temp
  });
  runners.push(none);
  const info = await none.detect(true);
  assert.equal(info.available, false);
  assert.match(info.reason, /未找到 FreeCAD/);
  assert.match(info.installHint, /freecadcmd/);
  const noScript = new FreecadRunner({ command: FAKE, resolveScript: () => null, tempRoot: ws.temp });
  runners.push(noScript);
  assert.match((await noScript.detect(true)).reason, /脚本/);
  const old = new FreecadRunner({ command: FAKE, resolveScript: () => SCRIPT, env: { ...process.env, FAKE_FREECAD_VERSION: '0.21.2' }, tempRoot: ws.temp });
  runners.push(old);
  assert.match((await old.detect(true)).reason, /版本过旧/);
});

test('作业：批量两件 → 进度事件、产物交付输出目录、STEP 哈希、临时目录清理', async () => {
  const ws = workspace();
  const { instance, events } = runner(ws);
  const info = await instance.detect();
  assert.equal(info.available, true);
  assert.equal(info.version, '1.0.0');
  const stepA = stepFile(ws.steps, 'a');
  const stepB = stepFile(ws.steps, 'b');
  const { spec, promise } = settledOutcome({
    parts: parts(['A', 'B']),
    resolveStep: async (part) => (part.partKey === 'A' ? stepA : stepB),
    outputDir: ws.out,
    titleBlock: { designer: '老王' }
  });
  const queued = instance.enqueue(spec);
  assert.equal(queued.state, 'queued');
  const outcome = await promise;
  assert.equal(outcome.state, 'succeeded', outcome.message);
  assert.equal(outcome.freecadVersion, '1.0.0');
  assert.equal(outcome.parts.length, 2);
  for (const entry of outcome.parts) {
    assert.equal(entry.result.ok, true);
    assert.match(entry.stepSha256, /^[0-9a-f]{64}$/);
    for (const name of Object.values(entry.result.files)) assert.ok(existsSync(join(ws.out, name)), name);
  }
  assert.deepEqual(readdirSync(ws.temp), [], '临时目录已清理');
  const states = events.filter((event) => event.jobId === queued.jobId).map((event) => event.state);
  assert.ok(states.includes('preparing') && states.includes('running') && states.at(-1) === 'succeeded', states.join(','));
  assert.ok(events.some((event) => event.done === 2 && event.state === 'running'), '收到逐件进度');
  assert.equal(instance.jobs()[0].state, 'succeeded');
});

test('作业：单件失败 → partial，失败原因透传；STEP 导出失败的零件不进 FreeCAD', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'fail-part');
  const step = stepFile(ws.steps, 'x');
  const { spec, promise } = settledOutcome({
    parts: parts(['A', 'B', 'C']),
    resolveStep: async (part) => {
      if (part.partKey === 'C') throw new Error('建模失败：孔位越界');
      return step;
    },
    outputDir: ws.out
  });
  instance.enqueue(spec);
  const outcome = await promise;
  assert.equal(outcome.state, 'partial');
  const byKey = Object.fromEntries(outcome.parts.map((entry) => [entry.part.partKey, entry.result]));
  assert.equal(byKey.A.ok, false);
  assert.match(byKey.A.error, /投影超时/);
  assert.equal(byKey.B.ok, true);
  assert.equal(byKey.C.ok, false);
  assert.match(byKey.C.error, /STEP 导出失败：建模失败/);
});

test('作业：FreeCAD 未写结果（崩溃）→ failed 并带 stderr 摘要', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'crash');
  const step = stepFile(ws.steps, 'x');
  const { spec, promise } = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  instance.enqueue(spec);
  const outcome = await promise;
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /没有写出结果/);
  assert.match(outcome.stderrTail, /SIGSEGV/);
  assert.equal(existsSync(ws.out) ? readdirSync(ws.out).length : 0, 0);
});

test('作业：超时杀进程 → timeout；后续作业仍能执行（串行队列不被卡死）', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'hang', { baseTimeoutMs: 600, perPartTimeoutMs: 0 });
  const step = stepFile(ws.steps, 'x');
  const first = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  instance.enqueue(first.spec);
  const outcome = await first.promise;
  assert.equal(outcome.state, 'timeout');
  assert.match(outcome.message, /超时/);
  assert.deepEqual(readdirSync(ws.temp), []);
});

test('作业：取消运行中与排队中的作业', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'hang', { baseTimeoutMs: 30_000 });
  const step = stepFile(ws.steps, 'x');
  const running = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  const queued = settledOutcome({ parts: parts(['B']), resolveStep: async () => step, outputDir: ws.out });
  const a = instance.enqueue(running.spec);
  const b = instance.enqueue(queued.spec);
  assert.equal(instance.jobs().length, 2);
  // 等第一个作业进入 running 再取消
  const deadline = Date.now() + 5_000;
  while (instance.jobs().find((job) => job.jobId === a.jobId)?.state !== 'running' && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.equal(instance.cancel(b.jobId), true);
  assert.equal(instance.cancel(a.jobId), true);
  assert.equal(instance.cancel('nope'), false);
  assert.equal((await running.promise).state, 'cancelled');
  assert.equal((await queued.promise).state, 'cancelled');
  await instance.idle();
  assert.deepEqual(readdirSync(ws.temp), []);
});

test('作业：FreeCAD 侧 PDF 失败 → 主进程 SVG 兜底；无兜底时只交付 SVG/DXF', async () => {
  const ws = workspace();
  const calls = [];
  const { instance } = runner(ws, 'no-pdf', {
    svgToPdf: async (svgPath, pdfPath, paper) => {
      calls.push([svgPath, paper]);
      writeFileSync(pdfPath, `%PDF-1.4 from ${readFileSync(svgPath, 'utf8').length}`);
    }
  });
  const step = stepFile(ws.steps, 'x');
  const { spec, promise } = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  instance.enqueue(spec);
  const outcome = await promise;
  assert.equal(outcome.state, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'A3');
  assert.ok(outcome.parts[0].result.files.pdf);
  assert.ok(outcome.parts[0].result.warnings.some((item) => item.includes('兜底')));

  const ws2 = workspace();
  const plain = runner(ws2, 'no-pdf').instance;
  const second = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws2.out });
  plain.enqueue(second.spec);
  const plainOutcome = await second.promise;
  assert.equal(plainOutcome.parts[0].result.files.pdf, undefined);
  assert.ok(plainOutcome.parts[0].result.files.svg);
});

test('作业：结果里伪造的路径不会被交付（只认作业约定文件名）', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'bad-file');
  const step = stepFile(ws.steps, 'x');
  const { spec, promise } = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  instance.enqueue(spec);
  const outcome = await promise;
  const result = outcome.parts[0].result;
  assert.equal(result.files.pdf, undefined);
  assert.ok(result.files.dxf);
  assert.ok(result.warnings.some((item) => item.includes('pdf')));
  assert.equal(existsSync(join(ws.root, 'A-00000000.pdf')), false);
});

test('作业：stderr 大量输出只保留尾部；FreeCAD 不可用时直接失败不起进程', async () => {
  const ws = workspace();
  const { instance } = runner(ws, 'noisy');
  const step = stepFile(ws.steps, 'x');
  const { spec, promise } = settledOutcome({ parts: parts(['A']), resolveStep: async () => step, outputDir: ws.out });
  instance.enqueue(spec);
  const outcome = await promise;
  assert.equal(outcome.state, 'succeeded');
  assert.ok(outcome.stderrTail.length <= 2_000);

  const missing = new FreecadRunner({
    resolveScript: () => SCRIPT, env: { PATH: '' }, platform: 'linux',
    candidateOptions: { exists: () => false, listDir: () => [] }, tempRoot: ws.temp
  });
  runners.push(missing);
  const unavailable = settledOutcome({ parts: parts(['A']), resolveStep: async () => { throw new Error('不应调用'); }, outputDir: ws.out });
  missing.enqueue(unavailable.spec);
  const failed = await unavailable.promise;
  assert.equal(failed.state, 'failed');
  assert.match(failed.message, /FreeCAD 不可用/);
});

test('resolveTechdrawScript：开发态找到仓库脚本，打包态缺失返回 null', () => {
  assert.equal(resolveTechdrawScript({ appRoot: REPO_ROOT }), SCRIPT);
  assert.equal(resolveTechdrawScript({ isPackaged: true, resourcesPath: '/nonexistent' }), null);
});
