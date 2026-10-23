import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { PackRegistry } from '../src/packs/registry.ts';
import { createAgentCommandBus } from '../src/agent/commands.ts';
import { AgentTools } from '../src/agent/tools.ts';
import {
  CostExportError,
  buildCostExport,
  costExportTimestamp,
  planExportName,
  sanitizeCostFileName,
  type CostExportSavePayload
} from '../src/cost/export.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;
const costCase = JSON.parse(
  readFileSync(new URL('./fixtures/cost-case.json', import.meta.url), 'utf8')
) as Record<string, any>;
const NOW = '2026-10-23T12:00:00+08:00';
const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f\u007f]/;

let sandbox = '';
let registry: PackRegistry;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-cost-export-'));
  const builtin = join(sandbox, 'builtin', 'smc-cn');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(join(builtin, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'smc-cn',
    name: 'SMC',
    vendor: 'SMC',
    version: '1.0.0'
  }));
  writeFileSync(join(builtin, 'parts.json'), JSON.stringify([
    { id: 'MXQ20-50', model: 'MXQ20-50.stp', category: '气缸', specs: {} }
  ]));
  registry = new PackRegistry({
    builtinDir: join(sandbox, 'builtin'),
    userDir: join(sandbox, 'user'),
    stateFile: join(sandbox, 'packs-state.json')
  });
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

function expectCostExportError(fn: () => unknown, code: string): CostExportError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CostExportError, `期望 CostExportError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail('期望抛出 CostExportError，但没有抛错');
}

function captureSaver(path = join(sandbox, 'out.csv')) {
  const calls: CostExportSavePayload[] = [];
  return {
    calls,
    saveFile: async (payload: CostExportSavePayload) => {
      calls.push(payload);
      return {
        ok: true,
        path,
        bytes: typeof payload.data === 'string' ? Buffer.byteLength(payload.data, 'utf8') : payload.data.byteLength
      };
    }
  };
}

test('文件名净化：去掉路径分隔符与 Windows 非法字符', () => {
  const name = sanitizeCostFileName('../a\\b:c*d?e"f<g>h|i\u0007');
  assert.doesNotMatch(name, ILLEGAL);
  assert.equal(name, 'abcdefghi');
});

test('文件名净化：首尾空白、点与控制字符被移除', () => {
  assert.equal(sanitizeCostFileName('  ..报价单..  '), '报价单');
  assert.equal(sanitizeCostFileName('\u0000\u0001成本\u007f报告\n'), '成本报告');
});

test('文件名净化：中文与中间点保留', () => {
  assert.equal(sanitizeCostFileName('机台 A.1 成本'), '机台 A.1 成本');
});

test('文件名净化：超长截断到上限且末位不留点', () => {
  const long = `${'机'.repeat(120)}.`;
  const name = sanitizeCostFileName(long, 80);
  assert.equal(name.length, 80);
  assert.doesNotMatch(name, /\.$/);
});

test('planExportName：空文件名回落 suggestedName', () => {
  const planned = planExportName({
    directory: sandbox,
    format: 'pdf',
    fileName: '   ',
    suggestedName: '成本报告-夹具机-20261023-1200.pdf'
  });
  assert.equal(planned.name, '成本报告-夹具机-20261023-1200.pdf');
  assert.equal(planned.path, join(sandbox, planned.name));
});

test('planExportName：扩展名按 format 强制，不叠加旧扩展名', () => {
  const pdf = planExportName({ directory: sandbox, format: 'pdf', fileName: '报价.csv' });
  assert.equal(pdf.name, '报价.pdf');
  const csv = planExportName({ directory: sandbox, format: 'csv', fileName: '报价.PDF' });
  assert.equal(csv.name, '报价.csv');
});

test('planExportName：冲突时追加 (1)、(2)', () => {
  const directory = join(sandbox, 'conflict');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '成本报告.csv'), 'old');
  const first = planExportName({ directory, format: 'csv', suggestedName: '成本报告.csv', exists: existsSync });
  assert.equal(first.name, '成本报告 (1).csv');
  writeFileSync(first.path, 'old');
  const second = planExportName({ directory, format: 'csv', suggestedName: '成本报告.csv', exists: existsSync });
  assert.equal(second.name, '成本报告 (2).csv');
});

test('planExportName：overwrite=true 直接复用原名，不追加序号', () => {
  const directory = join(sandbox, 'overwrite');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '成本报告.pdf'), 'old');
  const planned = planExportName({
    directory,
    format: 'pdf',
    suggestedName: '成本报告.pdf',
    overwrite: true,
    exists: existsSync
  });
  assert.equal(planned.name, '成本报告.pdf');
});

test('planExportName：绝对路径与 .. 被净化，最终仍在导出目录内', () => {
  const directory = join(sandbox, 'confined');
  mkdirSync(directory, { recursive: true });
  const planned = planExportName({
    directory,
    format: 'csv',
    fileName: '../../etc/passwd'
  });
  assert.equal(planned.name, 'etcpasswd.csv');
  assert.equal(planned.path.startsWith(resolve(directory) + sep), true);
  assert.equal(basename(planned.path), planned.name);
});

test('planExportName：追加序号后文件名仍不超过 80 字符', () => {
  const directory = join(sandbox, 'long');
  mkdirSync(directory, { recursive: true });
  const base = '机'.repeat(120);
  writeFileSync(join(directory, `${'机'.repeat(76)}.csv`), 'old');
  const planned = planExportName({
    directory,
    format: 'csv',
    fileName: base,
    exists: existsSync,
    maxLength: 80
  });
  assert.ok(planned.name.length <= 80, `文件名过长：${planned.name.length}`);
  assert.match(planned.name, / \(\d+\)\.csv$/);
});

test('文件名时间戳格式为 yyyyMMdd-HHmm', () => {
  const timestamp = costExportTimestamp(new Date(2026, 9, 23, 9, 5));
  assert.equal(timestamp, '20261023-0905');
});

test('buildCostExport CSV：带 UTF-8 BOM，返回行数、合计与字节数', async () => {
  const saver = captureSaver(join(sandbox, '明细.csv'));
  const result = await buildCostExport(
    { ...costCase, format: 'csv', pricebook: fixture, now: NOW },
    { saveFile: saver.saveFile, projectName: '夹具机' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.format, 'csv');
  assert.equal(result.lines, 6);
  assert.equal(result.grand, 1398.64);
  assert.ok(result.bytes > 0);
  assert.equal(saver.calls.length, 1);
  const data = saver.calls[0]?.data;
  assert.equal(typeof data, 'string');
  assert.equal((data as string).charCodeAt(0), 0xfeff);
  assert.match(data as string, /合计,1398\.64/);
  assert.match(saver.calls[0]?.suggestedName ?? '', /成本报告-夹具机-20261023-1200\.csv/);
});

test('buildCostExport PDF：复用 A4 纵向 HTML 与关键字段', async () => {
  let html = '';
  const result = await buildCostExport(
    { ...costCase, format: 'pdf', pricebook: fixture, now: NOW },
    {
      projectName: '夹具机',
      renderPdf: async (source) => {
        html = source;
        return new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
      },
      saveFile: async () => ({ ok: true, path: join(sandbox, '报告.pdf'), bytes: 8 })
    }
  );
  assert.equal(result.format, 'pdf');
  assert.equal(result.bytes, 8);
  assert.match(html, /@page \{ size: A4 portrait/);
  assert.match(html, /夹具机 · 机台成本报告/);
  assert.match(html, /总价构成/);
  assert.match(html, /硬件明细/);
  assert.match(html, /1,398\.64/);
  assert.equal((html.match(/class="sheet"/g) ?? []).length, 1);
});

test('buildCostExport：非法格式返回 UNSUPPORTED_FORMAT', async () => {
  await assert.rejects(
    () => buildCostExport({ ...costCase, format: 'xml', pricebook: fixture }, { saveFile: captureSaver().saveFile }),
    (error: unknown) => error instanceof CostExportError && error.code === 'UNSUPPORTED_FORMAT'
  );
});

test('buildCostExport：缺少 BOM 时给出可操作提示', async () => {
  const error = await buildCostExport(
    { format: 'csv', pricebook: fixture },
    { saveFile: captureSaver().saveFile }
  ).then(
    () => assert.fail('期望失败'),
    (reason: unknown) => reason as CostExportError
  );
  assert.equal(error.code, 'NO_BOM');
  assert.match(error.message, /BOM/);
});

test('buildCostExport：场景 BOM 缺物料号时仍可导出，并在 CSV 中标注缺价原因', async () => {
  const saver = captureSaver();
  const result = await buildCostExport(
    { format: 'csv', pricebook: fixture, now: NOW },
    {
      sceneBom: [{ no: 1, name: '机架', spec: '40x40', qty: 1, mat: '—' }],
      projectName: '场景机台',
      saveFile: saver.saveFile
    }
  );
  assert.equal(result.lines, 0);
  assert.match(saver.calls[0]?.data as string, /BOM 缺物料号|缺物料号/);
});

test('buildCostExport：渲染层拒绝时返回 DENIED', async () => {
  await assert.rejects(
    () => buildCostExport(
      { ...costCase, format: 'csv', pricebook: fixture },
      { saveFile: async () => ({ ok: false, code: 'DENIED', message: '用户拒绝写入' }) }
    ),
    (error: unknown) => error instanceof CostExportError && error.code === 'DENIED'
  );
});

test('buildCostExport：写盘失败返回 WRITE_FAILED 并保留原因', async () => {
  await assert.rejects(
    () => buildCostExport(
      { ...costCase, format: 'csv', pricebook: fixture },
      { saveFile: async () => ({ ok: false, code: 'WRITE_FAILED', message: '磁盘空间不足' }) }
    ),
    (error: unknown) => error instanceof CostExportError &&
      error.code === 'WRITE_FAILED' && /磁盘空间不足/.test(error.message)
  );
});

function commandBusWith(handler: (payload: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const bridge = {
    async call<T>(method: string, args: unknown): Promise<T> {
      calls.push({ method, args });
      if (method === 'getBom') return [{ no: 1, name: '机架', spec: '40x40', qty: 1, mat: '—' }] as unknown as T;
      if (method === 'getScene') return { source: '夹具机.step' } as unknown as T;
      if (method === 'exportCostFile') return await handler(args as Record<string, unknown>) as T;
      return { ok: false, message: `unexpected ${method}` } as unknown as T;
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    loadBuiltinPricebook: () => fixture,
    renderCostPdf: async () => new Uint8Array([37, 80, 68, 70])
  });
  return { bus, calls };
}

test('命令 export_cost_report：CSV 成功分支写出净化后的文件名', async () => {
  const directory = join(sandbox, 'command');
  mkdirSync(directory, { recursive: true });
  const { bus, calls } = commandBusWith(async (payload) => {
    const planned = planExportName({
      directory,
      format: payload.format as 'pdf' | 'csv',
      fileName: payload.fileName,
      suggestedName: payload.suggestedName,
      overwrite: payload.overwrite === true,
      exists: existsSync
    });
    const data = payload.encoding === 'base64'
      ? Buffer.from(String(payload.data), 'base64')
      : String(payload.data);
    writeFileSync(planned.path, data);
    return {
      ok: true,
      path: planned.path,
      bytes: typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength
    };
  });
  const result = await bus.execute('export_cost_report', {
    ...costCase,
    format: 'csv',
    fileName: '报价/单:2026*',
    pricebook: fixture,
    now: NOW
  });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.format, 'csv');
  assert.equal(data.lines, 6);
  assert.equal(data.grand, 1398.64);
  assert.ok(Number(data.bytes) > 0);
  assert.equal(basename(String(data.path)), '报价单2026.csv');
  assert.equal(calls.at(-1)?.method, 'exportCostFile');
});

test('命令 export_cost_report：场景 BOM 取当前文件名作默认项目名', async () => {
  const directory = join(sandbox, 'scene-name');
  mkdirSync(directory, { recursive: true });
  const { bus, calls } = commandBusWith(async (payload) => {
    const planned = planExportName({
      directory,
      format: payload.format as 'pdf' | 'csv',
      suggestedName: payload.suggestedName,
      exists: existsSync
    });
    return { ok: true, path: planned.path, bytes: 10 };
  });
  const result = await bus.execute('export_cost_report', { format: 'csv', pricebook: fixture, now: NOW });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.method === 'getBom'));
  assert.ok(calls.some((call) => call.method === 'getScene'));
  const saveCall = calls.find((call) => call.method === 'exportCostFile');
  assert.match(String((saveCall?.args as Record<string, unknown>).suggestedName), /成本报告-夹具机-20261023-1200/);
});

test('命令 export_cost_report：PDF 分支传 base64 字节且返回 format=pdf', async () => {
  const { bus, calls } = commandBusWith(async (payload) => {
    assert.equal(payload.encoding, 'base64');
    assert.match(String(payload.data), /^[A-Za-z0-9+/=]+$/);
    return { ok: true, path: join(sandbox, '报告.pdf'), bytes: 4 };
  });
  const result = await bus.execute('export_cost_report', {
    ...costCase,
    format: 'pdf',
    pricebook: fixture,
    now: NOW
  });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.format, 'pdf');
  assert.equal(data.bytes, 4);
  assert.equal(calls.at(-1)?.method, 'exportCostFile');
});

test('命令 export_cost_report：不支持格式返回 UNSUPPORTED_FORMAT', async () => {
  const { bus } = commandBusWith(async () => ({ ok: true, path: 'x', bytes: 1 }));
  const result = await bus.execute('export_cost_report', { format: 'xlsx', ...costCase, pricebook: fixture });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'UNSUPPORTED_FORMAT');
});

test('命令 export_cost_report：写盘失败与拒绝分别透传 WRITE_FAILED / DENIED', async () => {
  const failed = commandBusWith(async () => ({ ok: false, code: 'WRITE_FAILED', message: '目录只读' }));
  const failedResult = await failed.bus.execute('export_cost_report', {
    ...costCase, format: 'csv', pricebook: fixture
  });
  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.error?.code, 'WRITE_FAILED');
  assert.match(failedResult.error?.message ?? '', /目录只读/);

  const denied = commandBusWith(async () => ({ ok: false, code: 'DENIED', message: '用户拒绝' }));
  const deniedResult = await denied.bus.execute('export_cost_report', {
    ...costCase, format: 'csv', pricebook: fixture
  });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.error?.code, 'DENIED');
});

test('工具 export_cost_report：schema 必填 format 且描述写明目录与覆盖策略', () => {
  const tools = new AgentTools(registry);
  const summary = tools.summaries().find((tool) => tool.name === 'export_cost_report');
  assert.ok(summary);
  assert.equal(summary.inputSchema.required instanceof Array, true);
  assert.deepEqual(summary.inputSchema.required, ['format']);
  assert.equal(summary.inputSchema.additionalProperties, false);
  assert.deepEqual(summary.inputSchema.properties.format, {
    type: 'string',
    enum: ['pdf', 'csv'],
    description: summary.inputSchema.properties.format.description
  });
  assert.match(summary.description, /exports\//);
  assert.match(summary.description, /用户确认/);
  assert.match(summary.description, /不会覆盖已有文件，除非 overwrite=true/);
  assert.equal(summary.inputSchema.properties.bom.type, 'array');
});

test('工具 export_cost_report：经命令总线失败时返回结构化中文错误', async () => {
  const { bus } = commandBusWith(async () => ({ ok: true, path: 'x', bytes: 1 }));
  const tools = new AgentTools(registry, bus);
  const result = await tools.call('export_cost_report', { format: 'xml', ...costCase, pricebook: fixture }) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_FORMAT');
  assert.match(String(result.message), /pdf|csv/);
});
