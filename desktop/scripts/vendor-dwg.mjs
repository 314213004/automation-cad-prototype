#!/usr/bin/env node
/**
 * 把 LibreDWG WASM 模块放进 vendor/dwg/，供 electron-builder 以 extraResources 打进安装包。
 *
 * 为什么单独抄一份而不是直接依赖 node_modules：
 * - 它只在打包时需要，进 devDependencies 会让 `npm ci` 每次都拉 13MB 且拖慢测试；
 * - 打包后必须落在 asar 外面（转换器是子进程按路径读取 wasm 的），asar 里读不到。
 *
 * 源按顺序找：AUTOMATION_CAD_LIBREDWG 环境变量 → 已安装目录的 dwg 目录 → node_modules。
 * 注意：LibreDWG 是 GPL-3.0，随包分发即要求整个发行物遵守 GPL-3.0。
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const target = join(desktopRoot, 'vendor', 'dwg', 'libredwg-web');
const force = process.argv.includes('--force');

const sources = [
  process.env.AUTOMATION_CAD_LIBREDWG,
  process.env.APPDATA ? join(process.env.APPDATA, 'AutomationCAD', 'dwg', 'libredwg-web') : null,
  join(desktopRoot, 'node_modules', '@mlightcad', 'libredwg-web')
].filter(Boolean);

async function valid(dir) {
  return existsSync(join(dir, 'dist', 'libredwg-web.js')) && existsSync(join(dir, 'wasm', 'libredwg-web.wasm'));
}

if (!force && await valid(target)) {
  console.log(`vendor/dwg 已存在，跳过（--force 可重建）`);
  process.exit(0);
}

let source = null;
for (const candidate of sources) {
  if (await valid(candidate)) { source = candidate; break; }
}
if (!source) {
  console.error('找不到 libredwg-web 模块。装一份再打包，二选一：');
  console.error('  npm i -D @mlightcad/libredwg-web   （在 desktop/ 下执行）');
  console.error('  或把模块解压到 %APPDATA%\\AutomationCAD\\dwg\\libredwg-web');
  process.exit(1);
}

await rm(join(desktopRoot, 'vendor', 'dwg'), { recursive: true, force: true });
await mkdir(target, { recursive: true });
// 只需要 dist（JS 包装）和 wasm 两部分，其余文档/源码不带走
for (const part of ['dist', 'wasm']) {
  await cp(join(source, part), join(target, part), { recursive: true });
}
await cp(join(source, 'package.json'), join(target, 'package.json'));
const bytes = (await stat(join(target, 'wasm', 'libredwg-web.wasm'))).size;
console.log(`vendor/dwg/libredwg-web ← ${source}（wasm ${(bytes / 1024 / 1024).toFixed(1)} MB）`);
