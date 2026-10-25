#!/usr/bin/env node
/**
 * 本机快速更新：编译后把产物原地覆盖到已安装目录，不重新打包安装包。
 *
 * 用法：cd desktop && npm run update:installed [-- --no-restart]
 *
 * 只替换 resources/app.asar（以及可执行文件），比 NSIS 安装快一个数量级；
 * 已安装目录按常见位置自动探测，也可用 AUTOMATIONCAD_INSTALL_DIR 指定。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..');
const noRestart = process.argv.includes('--no-restart');

const candidates = [
  process.env.AUTOMATIONCAD_INSTALL_DIR,
  // 用户目录安装优先：不需要管理员权限，增量更新才能静默完成。
  join(process.env.LOCALAPPDATA || '', 'Programs/AutomationCAD'),
  'C:/Program Files/AutomationCAD'
].filter(Boolean);

const installDir = candidates.find((dir) => existsSync(join(dir, 'AutomationCAD.exe')));
if (!installDir) {
  console.error('找不到已安装目录；请用 AUTOMATIONCAD_INSTALL_DIR 指定（需包含 AutomationCAD.exe）');
  process.exit(1);
}
console.log(`安装目录: ${installDir}`);

function run(cmd, args, options = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // Windows 上 npx/npm 是 .cmd 包装，必须过 shell 才能 spawn（否则 ENOENT）。
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: desktopRoot, shell: process.platform === 'win32', ...options });
}

// 1) 只做增量验证 + 构建，不打安装包
run('npx', ['tsc', '--noEmit']);
run('npm', ['run', 'build:ext']);

// 2) 生成 unpacked 目录（electron-builder 的 dir 目标，不做 NSIS）
run('npx', ['electron-builder', '--win', 'dir', '--x64']);

// 3) 覆盖安装目录前先停掉应用：Windows 会锁住正在运行的 exe 与 asar，复制必然失败。
console.log('\n停止正在运行的 AutomationCAD…');
execFileSync('powershell', ['-NoProfile', '-Command',
  'Stop-Process -Name AutomationCAD -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2'], { stdio: 'inherit' });

// 4) 覆盖安装目录（app.asar 是主产物；exe 只在版本信息变化时需要）
const unpacked = join(desktopRoot, 'release', 'win-unpacked');
const copies = [
  [join(unpacked, 'resources', 'app.asar'), join(installDir, 'resources', 'app.asar')],
  [join(unpacked, 'AutomationCAD.exe'), join(installDir, 'AutomationCAD.exe')]
];
for (const [from, to] of copies) {
  if (!existsSync(from)) { console.error(`缺少产物: ${from}`); process.exit(1); }
  const size = statSync(from).size;
  console.log(`copy ${from} -> ${to} (${(size / 1048576).toFixed(1)} MB)`);
  execFileSync('powershell', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${from}' -Destination '${to}' -Force`], { stdio: 'inherit' });
}

// 5) 重启应用
if (!noRestart) {
  console.log('\n重启 AutomationCAD…');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Start-Process '${join(installDir, 'AutomationCAD.exe')}'; Start-Sleep -Seconds 10`], { stdio: 'inherit' });
}

console.log('\nDONE 已原地更新（未生成安装包）');
