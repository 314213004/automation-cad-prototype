// 崩溃报告落盘：与 Electron API 解耦，便于在 Node 测试中直接验证字段与脱敏。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCrashReport, type CrashReport, type CrashReportInput } from '../src/shared/diagnostics.ts';

export function lastCrashPath(userDataPath: string): string {
  return join(userDataPath, 'diagnostics', 'last-crash.json');
}

/** 原子写 userData/diagnostics/last-crash.json；只含版本、操作类型、错误摘要与堆栈。 */
export function writeLastCrash(userDataPath: string, input: CrashReportInput): CrashReport {
  const report = buildCrashReport(input);
  const target = lastCrashPath(userDataPath);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, target);
  } catch {
    // Windows 上目标已存在时 rename 可能失败；先删旧文件再重命名，仍保持单文件原子替换语义。
    rmSync(target, { force: true });
    renameSync(temp, target);
  }
  return report;
}
