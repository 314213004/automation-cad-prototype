/**
 * DWG → DXF 转换 runner（独立 Node 进程）。
 *
 * 为什么单独进程：
 * - LibreDWG 是 GPL-3.0，做成可选外部模块，不随主包分发；
 * - WASM 初始化吃内存，隔离出去崩了也不带崩主进程；
 * - 主进程是打包后的 CJS，这里用 ESM 动态 import 不受打包器影响。
 *
 * 用法：electron(ELECTRON_RUN_AS_NODE=1) dwg-convert.mjs <模块目录> <输入.dwg> <输出.dxf>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 用 `node -e <code> a b c` 调用时 argv 里没有脚本路径，所以取末尾三个参数
const [moduleDir, inputPath, outputPath] = process.argv.slice(-3);
if (!moduleDir || !inputPath || !outputPath) {
  console.error('usage: dwg-convert.mjs <moduleDir> <input.dwg> <output.dxf>');
  process.exit(2);
}

try {
  const entry = pathToFileURL(join(moduleDir, 'dist', 'libredwg-web.js')).href;
  const { LibreDwg } = await import(entry);
  const bytes = readFileSync(inputPath);
  const dwg = await LibreDwg.create(join(moduleDir, 'wasm'));
  const dxf = dwg.dwg_write_dxf(bytes);
  if (!dxf || dxf.length === 0) {
    console.error('CONVERT_FAILED: dwg_write_dxf 返回空结果');
    process.exit(3);
  }
  writeFileSync(outputPath, dxf);
  console.log(JSON.stringify({ ok: true, bytes: dxf.length }));
} catch (error) {
  console.error('CONVERT_FAILED: ' + (error && error.message ? error.message : String(error)));
  process.exit(3);
}
