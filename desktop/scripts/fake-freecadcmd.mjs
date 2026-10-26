// 假 freecadcmd：只用于 node --test 集成测试（运行器 / 工程图服务），不随包发布。
// 行为由环境变量 FAKE_FREECAD_MODE 控制：ok | fail-part | no-pdf | hang | crash | bad-file | noisy
// 版本由 FAKE_FREECAD_VERSION 控制（默认 1.0.0）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const version = process.env.FAKE_FREECAD_VERSION ?? '1.0.0';

if (argv.includes('--version')) {
  process.stdout.write(`FreeCAD ${version} Revision: 0 (AutomationCAD fake)\n`);
  process.exit(0);
}

const mode = process.env.FAKE_FREECAD_MODE ?? 'ok';
const jobPath = process.env.AUTOMATIONCAD_FREECAD_JOB;
if (!jobPath || !existsSync(jobPath)) {
  process.stderr.write('fake freecadcmd: missing AUTOMATIONCAD_FREECAD_JOB\n');
  process.exit(2);
}
if (!argv.some((item) => item.endsWith('techdraw_job.py'))) {
  process.stderr.write(`fake freecadcmd: unexpected argv ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const job = JSON.parse(readFileSync(jobPath, 'utf8'));
process.stderr.write('FreeCAD 1.0.0, Libs: fake\n(C) fake\n');
if (mode === 'noisy') process.stderr.write('x'.repeat(200_000));

if (mode === 'hang') {
  setInterval(() => undefined, 1_000);
} else if (mode === 'crash') {
  process.stderr.write('Program received signal SIGSEGV, Segmentation fault.\n');
  process.exit(3);
} else {
  const parts = [];
  job.parts.forEach((part, index) => {
    process.stdout.write(`@@ACAD ${JSON.stringify({ event: 'part-start', index, total: job.parts.length, partId: part.partId })}\n`);
    const files = {};
    let ok = existsSync(part.step);
    let error;
    if (!ok) error = `STEP 不存在：${part.step}`;
    if (mode === 'fail-part' && index === 0) {
      ok = false;
      error = 'TimeoutError: TechDraw 投影超时（60 秒）';
    }
    if (ok) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297"><text x="10" y="20">${part.name}</text></svg>`;
      writeFileSync(join(job.outputDir, `${part.fileStem}.svg`), svg);
      files.svg = `${part.fileStem}.svg`;
      if (mode !== 'no-pdf') {
        writeFileSync(join(job.outputDir, `${part.fileStem}.pdf`), `%PDF-1.4\n% fake ${part.partId}\n%%EOF\n`);
        files.pdf = mode === 'bad-file' ? `../${part.fileStem}.pdf` : `${part.fileStem}.pdf`;
      }
      writeFileSync(join(job.outputDir, `${part.fileStem}.dxf`), '  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n');
      files.dxf = `${part.fileStem}.dxf`;
    }
    parts.push({
      partId: part.partId,
      ok,
      files,
      warnings: mode === 'no-pdf' && ok ? ['FreeCAD 侧 PDF 渲染失败：fake；将由主进程用 SVG 兜底生成'] : [],
      ...(error ? { error } : {}),
      ...(mode === 'no-pdf' ? { pdfFallback: true } : {}),
      bbox: [200, 120, 15],
      paper: 'A3',
      scale: '1:1',
      dimensions: { length: 200, width: 120, height: 15 },
      views: ['front', 'iso', 'left', 'top'],
      elapsedMs: 5
    });
    process.stdout.write(`@@ACAD ${JSON.stringify({ event: 'part-done', index, total: job.parts.length, partId: part.partId, ok })}\n`);
  });
  const result = {
    protocol: 'automationcad.drawing-result/1',
    jobId: job.jobId,
    scriptVersion: '1.0.0',
    ok: parts.every((part) => part.ok),
    freecadVersion: version,
    parts,
    elapsedMs: 10
  };
  writeFileSync(join(job.outputDir, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write('@@ACAD {"event":"done","ok":true}\n');
}
