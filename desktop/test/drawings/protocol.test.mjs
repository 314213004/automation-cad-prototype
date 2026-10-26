import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DRAWING_JOB_PROTOCOL,
  DRAWING_RESULT_PROTOCOL,
  buildDrawingJob,
  localDate,
  normalizeDrawingOptions,
  parseDrawingJobResult,
  parseProgressLine,
  partFileStem,
  serializeDrawingJob,
  validateDrawingJob
} from '../../src/drawings/protocol.ts';

function part(overrides = {}) {
  return {
    partId: 'P-001',
    fileStem: 'P-001-abcd1234',
    name: '转接板',
    material: '6061-T6',
    drawingNo: 'AC-P-001',
    quantity: 2,
    step: '/tmp/job/in/P-001-abcd1234.step',
    ...overrides
  };
}

function job(parts = [part()]) {
  return buildDrawingJob({
    jobId: 'fc-test-0001',
    outputDir: '/tmp/job/out',
    parts,
    titleBlock: { designer: '老王', company: 'AutomationCAD' },
    now: new Date(2026, 9, 26, 17, 0, 0)
  });
}

test('buildDrawingJob：默认选项、标题栏本地日期、序列化往返', () => {
  const built = job();
  assert.equal(built.protocol, DRAWING_JOB_PROTOCOL);
  assert.equal(built.kind, 'techdraw');
  assert.deepEqual(built.options, { formats: ['pdf', 'dxf', 'svg'], paper: 'auto', scale: 'auto', iso: true, hiddenLines: true, hlrTimeoutSec: 60 });
  assert.deepEqual(built.titleBlock, { designer: '老王', company: 'AutomationCAD', date: '2026-10-26' });
  assert.equal(built.parts[0].quantity, 2);
  const roundTrip = JSON.parse(serializeDrawingJob(built));
  assert.deepEqual(roundTrip, built);
  assert.deepEqual(validateDrawingJob(roundTrip), []);
  assert.ok(serializeDrawingJob(built).endsWith('\n'));
});

test('buildDrawingJob：清洗控制字符、截断过长字段、数量非法回落为 1', () => {
  const built = job([part({ name: '板\u0000子'.padEnd(100, 'x'), quantity: 0, material: '\t45#\n' })]);
  assert.ok(!built.parts[0].name.includes('\u0000'));
  assert.equal(built.parts[0].name.length, 60);
  assert.equal(built.parts[0].quantity, 1);
  assert.equal(built.parts[0].material, '45#');
});

test('validateDrawingJob：协议/路径/重复 partId/fileStem 注入全部报错', () => {
  assert.deepEqual(validateDrawingJob(null), ['作业必须是对象']);
  const bad = {
    ...job(),
    protocol: 'x/0',
    parts: [part(), part({ fileStem: '../evil' }), part({ partId: 'P-002', fileStem: 'p-001-ABCD1234', step: '/tmp/a.stl' })]
  };
  const errors = validateDrawingJob(bad);
  assert.ok(errors.some((item) => item.includes('协议不匹配')));
  assert.ok(errors.some((item) => item.includes('partId 重复')));
  assert.ok(errors.some((item) => item.includes('fileStem 非法')));
  assert.ok(errors.some((item) => item.includes('fileStem 重复')), '大小写不同的同名文件在 Windows 上冲突');
  assert.ok(errors.some((item) => item.includes('.step/.stp')));
  assert.throws(() => buildDrawingJob({ jobId: 'bad id', outputDir: '/x', parts: [part()] }), /jobId 非法/);
  assert.throws(() => buildDrawingJob({ jobId: 'fc-ok-0001', outputDir: '/x', parts: [] }), /parts 必须是非空数组/);
  const many = Array.from({ length: 51 }, (_, index) => part({ partId: `P${index}`, fileStem: `p${index}` }));
  assert.ok(validateDrawingJob({ ...job(), parts: many }).some((item) => item.includes('最多 50')));
});

test('normalizeDrawingOptions：白名单格式、比例格式、超时夹紧', () => {
  assert.deepEqual(normalizeDrawingOptions({ formats: ['pdf', 'exe', 'pdf'], paper: 'A0', scale: '1:2', hlrTimeoutSec: 9999, iso: false }), {
    formats: ['pdf'], paper: 'auto', scale: '1:2', iso: false, hiddenLines: true, hlrTimeoutSec: 600
  });
  assert.equal(normalizeDrawingOptions({ scale: 'rm -rf' }).scale, 'auto');
  assert.deepEqual(normalizeDrawingOptions({ formats: [] }).formats, ['pdf', 'dxf', 'svg']);
  assert.equal(normalizeDrawingOptions({ hlrTimeoutSec: 1 }).hlrTimeoutSec, 5);
});

test('parseDrawingJobResult：只采信与作业对应、文件名合规的条目', () => {
  const built = job([part(), part({ partId: 'P-002', fileStem: 'P-002-ffff0000', step: '/tmp/job/in/b.step' })]);
  const parsed = parseDrawingJobResult({
    protocol: DRAWING_RESULT_PROTOCOL,
    jobId: built.jobId,
    freecadVersion: '1.0.0',
    parts: [
      {
        partId: 'P-001', ok: true,
        files: { pdf: 'P-001-abcd1234.pdf', dxf: '../../etc/passwd', svg: 'P-001-abcd1234.svg' },
        warnings: ['w1', 3], paper: 'A3', scale: '1:1', bbox: [200, 120, 15], dimensions: { length: 200, width: 120, height: 15 }
      },
      { partId: 'P-999', ok: true, files: { pdf: 'x.pdf' } }
    ]
  }, built);
  assert.equal(parsed.ok, false, 'P-002 缺结果 → 整体不成功');
  assert.equal(parsed.freecadVersion, '1.0.0');
  assert.equal(parsed.parts.length, 2);
  const first = parsed.parts[0];
  assert.equal(first.ok, true);
  assert.deepEqual(first.files, { pdf: 'P-001-abcd1234.pdf', svg: 'P-001-abcd1234.svg' });
  assert.ok(first.warnings.includes('w1'));
  assert.ok(first.warnings.some((item) => item.includes('dxf')), '不合规文件名记为警告');
  assert.equal(first.paper, 'A3');
  assert.deepEqual(first.bbox, [200, 120, 15]);
  assert.equal(parsed.parts[1].ok, false);
  assert.match(parsed.parts[1].error, /未返回/);
});

test('parseDrawingJobResult：协议错误或 jobId 不匹配时全部判失败', () => {
  const built = job();
  assert.equal(parseDrawingJobResult({ protocol: 'nope' }, built).parts[0].ok, false);
  const mismatch = parseDrawingJobResult({ protocol: DRAWING_RESULT_PROTOCOL, jobId: 'other', parts: [] }, built);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /不匹配/);
  const noFiles = parseDrawingJobResult({ protocol: DRAWING_RESULT_PROTOCOL, jobId: built.jobId, parts: [{ partId: 'P-001', ok: true, files: {} }] }, built);
  assert.equal(noFiles.parts[0].ok, false);
  assert.match(noFiles.parts[0].error, /未产出/);
});

test('parseProgressLine：识别 @@ACAD 进度行，其他输出忽略', () => {
  assert.deepEqual(parseProgressLine('@@ACAD {"event":"part-start","index":0,"total":2,"partId":"P-001"}'),
    { event: 'part-start', index: 0, total: 2, partId: 'P-001' });
  assert.deepEqual(parseProgressLine('@@ACAD {"event":"part-done","index":1,"total":2,"partId":"B","ok":true}'),
    { event: 'part-done', index: 1, total: 2, partId: 'B', ok: true });
  assert.deepEqual(parseProgressLine('@@ACAD {"event":"done","ok":false}'), { event: 'done', ok: false });
  assert.equal(parseProgressLine('Recompute...... (100 %)'), null);
  assert.equal(parseProgressLine('@@ACAD {broken'), null);
  assert.equal(parseProgressLine('@@ACAD {"event":"part-start","index":"0"}'), null);
});

test('partFileStem：稳定、唯一、只含安全字符；localDate 用本地日期', () => {
  assert.equal(partFileStem('P-001'), partFileStem('P-001'));
  assert.notEqual(partFileStem('转接板'), partFileStem('滚筒'));
  for (const key of ['P-001', '转接板', '../../x', 'inst:p1', 'A B/C\\D']) {
    assert.match(partFileStem(key), /^[A-Za-z0-9_-]{1,64}$/);
  }
  assert.match(partFileStem('转接板'), /^part-[0-9a-f]{8}$/);
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
