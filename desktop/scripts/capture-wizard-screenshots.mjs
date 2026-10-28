// 整机设计向导分步截图：起真实 Electron（xvfb），走 5 步向导 + 保存 + 3D/BOM/IO。
// 不依赖模型桩——这条链路是纯界面操作，和智能体无关。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });

// SwiftShader 兜底：无 GPU 的机器上不加这两个 flag，Electron 会把 WebGL 拉黑，
// 3D 视口直接退化成「WebGL 不可用」提示（实测出现过）。
const electronArgs = ['.', '--headless-wizard-shots', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const command = existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : electronBin;
const args = command === 'xvfb-run' ? ['-a', '-s', '-screen 0 1920x1200x24', electronBin, ...electronArgs] : electronArgs;

const child = spawn(command, args, {
  cwd: desktopRoot,
  env: { ...process.env, AUTOMATIONCAD_SCREENSHOT_DIR: outputDir, ELECTRON_DISABLE_SANDBOX: '1' },
  stdio: 'inherit'
});
const watchdog = setTimeout(() => {
  console.error('WIZARD_SHOTS_TIMEOUT 6 分钟内未完成，强制结束');
  if (!child.killed) child.kill('SIGKILL');
}, 6 * 60_000);
child.once('exit', (code, signal) => {
  clearTimeout(watchdog);
  if (signal) {
    console.error(`WIZARD_SHOTS_SIGNAL ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
