// 在 xvfb 中启动真实 Electron，按产品界面状态抓取 1600×1000 截图。
// 参数化面板由 fake sidecar 驱动，保证 CI / 无 Python 环境可复现。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const fakeSidecar = join(desktopRoot, 'scripts', 'fake-parametric-sidecar.mjs');
const outputDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');

if (!existsSync(electronBin)) {
  console.error(`Electron 未安装：${electronBin}`);
  process.exit(1);
}
if (!existsSync(fakeSidecar)) {
  console.error(`参数化假内核缺失：${fakeSidecar}`);
  process.exit(1);
}

const env = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  AUTOMATIONCAD_PARAMETRIC_CMD: fakeSidecar,
  AUTOMATIONCAD_SCREENSHOT_DIR: outputDir
};
const electronArgs = ['.', '--headless-screenshots'];
const xvfbArgs = ['-a', '-s', '-screen 0 1920x1200x24', electronBin, ...electronArgs];
const command = existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : process.platform === 'linux' ? 'xvfb-run' : electronBin;
const args = command === 'xvfb-run' ? xvfbArgs : electronArgs;

const child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`截图进程启动失败：${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`截图进程被信号终止：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
