/**
 * DWG 读取支持。
 *
 * DWG 是闭源二进制格式，没有官方规范，能读它的开源实现（LibreDWG）是 **GPL-3.0**。
 * 这个项目没有 LICENSE 文件、发行物是否开源未定，所以这里**不把 GPL 代码打进安装包**：
 *
 * 1. 首选外部转换器（顺序）：
 *    - LibreDWG WASM（用户自己放到 `<resources>/dwg/libredwg-web`，或开发态 node_modules）
 *    - ODA File Converter（免费，官方下载，DWG↔DXF 最稳）
 *    - LibreDWG 命令行 `dwg2dxf`
 * 2. 都没有时给可执行的指引，而不是「不支持的扩展名」这种死路。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface DwgConversion {
  ok: boolean;
  converter: 'libredwg-wasm' | 'oda' | 'dwg2dxf' | null;
  bytes?: Uint8Array;
  message: string;
}

const CONVERT_TIMEOUT_MS = 120_000;

function candidatesForWasmModule(resourcesPath: string | undefined): string[] {
  const list: string[] = [];
  const fromEnv = process.env.AUTOMATION_CAD_LIBREDWG;
  if (fromEnv) list.push(fromEnv);
  // 用户侧可选安装位置（不随安装包分发，GPL 模块单独放）
  if (process.env.APPDATA) list.push(join(process.env.APPDATA, 'AutomationCAD', 'dwg', 'libredwg-web'));
  if (resourcesPath) {
    list.push(join(resourcesPath, 'dwg', 'libredwg-web'));
    list.push(join(resourcesPath, 'app.asar.unpacked', 'dwg', 'libredwg-web'));
  }
  // 开发态：desktop/node_modules（主进程被 esbuild 打成 CJS，__dirname 可用）
  list.push(join(process.cwd(), 'node_modules', '@mlightcad', 'libredwg-web'));
  list.push(join(moduleRoot(), '..', 'node_modules', '@mlightcad', 'libredwg-web'));
  list.push(join(moduleRoot(), 'node_modules', '@mlightcad', 'libredwg-web'));
  return list;
}

export function findWasmModule(resourcesPath: string | undefined): string | null {
  for (const candidate of candidatesForWasmModule(resourcesPath)) {
    if (existsSync(join(candidate, 'dist', 'libredwg-web.js')) && existsSync(join(candidate, 'wasm', 'libredwg-web.wasm'))) {
      return candidate;
    }
  }
  return null;
}

function findOdaConverter(): string | null {
  const roots = [
    'C:\\Program Files\\ODA',
    'C:\\Program Files (x86)\\ODA',
    '/opt/oda',
    '/usr/lib/oda'
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = ['ODAFileConverter.exe', 'ODAFileConverter'];
    for (const exe of versions) {
      const guess = join(root, exe);
      if (existsSync(guess)) return guess;
    }
  }
  return null;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: `${stderr}\n转换超时（${CONVERT_TIMEOUT_MS} ms）` });
    }, CONVERT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 主进程被 esbuild 打成 CJS，这里拿 dist-electron 目录 */
function moduleRoot(): string {
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

function runnerPath(): string {
  // 编译后 runner 会被复制到 dist-electron/，源码在 electron/；两处都找
  const here = moduleRoot();
  const candidates = [join(here, 'dwg-convert.mjs'), join(here, '..', 'electron', 'dwg-convert.mjs')];
  return candidates.find((path) => existsSync(path)) ?? candidates[0] ?? 'dwg-convert.mjs';
}

export const DWG_HELP = [
  '无法读取 DWG：本机没有可用的 DWG 转换器。',
  'DWG 是闭源格式，能读它的开源实现（LibreDWG）是 GPL-3.0，所以不随安装包分发。三选一：',
  '1) 装 ODA File Converter（免费，官方下载，最稳）：https://www.opendesign.com/guestfiles/oda_file_converter',
  '2) 装 LibreDWG 命令行：把 dwg2dxf 放进 PATH（Linux: apt install libredwg-tools；Windows: 用 WSL 或官方构建）',
  '3) 放 LibreDWG WASM 模块：解压 npm 包 @mlightcad/libredwg-web 到 <安装目录>/resources/dwg/libredwg-web',
  '最快的是第 4 条：在 AutoCAD/BricsCAD 里「另存为 DXF」，本项目可以直接读 DXF。'
].join('\n');

/**
 * 先确认文件真的是 DWG。所有 DWG 版本都以 `AC10xx` 开头（AC1015=2000 … AC1032=2018）。
 * 实测遇到过一个 29MB 的「.dwg」：开头不是 AC10，全文搜不到 AC10，整体熵 8.00 bit/byte
 * —— 那是被透明加密软件处理过的文件，任何 DWG 转换器都读不了，越早说清楚越好。
 */
export function inspectDwgHeader(bytes: Uint8Array): { ok: true; version: string } | { ok: false; message: string } {
  if (bytes.length < 6) return { ok: false, message: '文件太小，不是有效的 DWG' };
  const head = Buffer.from(bytes.subarray(0, 6)).toString('latin1');
  if (/^AC10\d\d$/.test(head)) return { ok: true, version: head };
  // 抽样估熵：加密内容接近 8.00，正常 DWG 头部远低于此
  const sample = bytes.subarray(0, Math.min(bytes.length, 1 << 20));
  const counts = new Uint32Array(256);
  for (const byte of sample) counts[byte] = (counts[byte] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const p = count / sample.length;
    entropy -= p * Math.log2(p);
  }
  const looksEncrypted = entropy > 7.8;
  return {
    ok: false,
    message: [
      `这不是标准 DWG：文件开头是 ${JSON.stringify(head)}，不是 AC10xx 版本标识（全文也找不到 AC10）。`,
      looksEncrypted
        ? `抽样熵 ${entropy.toFixed(2)} bit/byte，接近完全随机——基本可以确定文件被加密或压缩过。`
        : `抽样熵 ${entropy.toFixed(2)} bit/byte。`,
      '常见原因：企业透明加密软件（亿赛通/SDC 等）导出的文件、ERP/PLM 加密包，或复制过程损坏。',
      '处理方式：在能正常打开它的软件里「另存为 DXF」，本项目可以直接读 DXF；或先解密再打开。'
    ].join(' ')
  };
}

/** DWG → DXF。成功返回 DXF 字节。 */
export async function convertDwgToDxf(inputPath: string, resourcesPath?: string): Promise<DwgConversion> {
  const header = inspectDwgHeader(readFileSync(inputPath));
  if (!header.ok) return { ok: false, converter: null, message: header.message };
  const wasmModule = findWasmModule(resourcesPath);
  const workDir = mkdtempSync(join(tmpdir(), 'awcad-dwg-'));
  const outputPath = join(workDir, `${basename(inputPath, '.dwg')}.dxf`);
  try {
    if (wasmModule) {
      // runner 打包后在 app.asar 里，不能直接当脚本路径传给子进程；
      // 主进程读得到 asar（Electron 的 fs 打过补丁），把源码用 -e 传过去。
      let source = '';
      try {
        source = readFileSync(runnerPath(), 'utf8');
      } catch (error) {
        return { ok: false, converter: null, message: `DWG 转换器脚本缺失：${error instanceof Error ? error.message : String(error)}` };
      }
      const result = await run(process.execPath, ['-e', source, wasmModule, inputPath, outputPath], {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      });
      if (result.code === 0 && existsSync(outputPath) && statSync(outputPath).size > 0) {
        return { ok: true, converter: 'libredwg-wasm', bytes: readFileSync(outputPath), message: 'libredwg-wasm' };
      }
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
      return { ok: false, converter: null, message: `LibreDWG WASM 转换失败：${detail || `退出码 ${result.code}`}` };
    }

    const oda = findOdaConverter();
    if (oda) {
      const outDir = workDir;
      const result = await run(oda, [workDir, outDir, 'ACAD2018', 'DXF', '0', '1', inputPath]);
      if (result.code === 0 && existsSync(outputPath)) {
        return { ok: true, converter: 'oda', bytes: readFileSync(outputPath), message: 'ODA File Converter' };
      }
      return { ok: false, converter: null, message: `ODA File Converter 调用失败：${(result.stderr || result.stdout).trim().slice(-200)}` };
    }

    const dwg2dxf = await run('dwg2dxf', ['-y', '-o', outputPath, inputPath]);
    if (dwg2dxf.code === 0 && existsSync(outputPath)) {
      return { ok: true, converter: 'dwg2dxf', bytes: readFileSync(outputPath), message: 'dwg2dxf' };
    }

    return { ok: false, converter: null, message: DWG_HELP };
  } finally {
    // 只有成功时才在 caller 里读走字节；这里清理临时目录
    setTimeout(() => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结果 */
      }
    }, 5_000);
  }
}
