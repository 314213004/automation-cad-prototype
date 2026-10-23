import { join } from 'node:path';
import { exportTimestamp, sanitizeFileName } from '../shared/filename.ts';

export interface PlcExportPlanOptions {
  exportsRoot: string;
  machineName: unknown;
  now?: Date | string | number;
  exists?: (path: string) => boolean;
  maxLength?: number;
}

export interface PlcExportPlan {
  name: string;
  path: string;
  zipName: string;
  zipPath: string;
}

/** `<机型>-<yyyyMMdd-HHmm>`；同名时追加 `-2`、`-3`…，不覆盖已有目录。 */
export function planPlcExportDirectory(options: PlcExportPlanOptions): PlcExportPlan {
  const maxLength = Math.max(12, Math.trunc(options.maxLength ?? 60));
  const machine = sanitizeFileName(options.machineName, Math.min(40, maxLength - 16)) || 'PLC';
  const stamp = exportTimestamp(options.now ?? new Date());
  const base = `${machine}-${stamp}`;
  const exists = options.exists ?? (() => false);

  let name = base;
  let index = 2;
  while (exists(join(options.exportsRoot, name))) {
    const suffix = `-${index}`;
    name = `${sanitizeFileName(base, Math.max(1, maxLength - suffix.length))}${suffix}`;
    index += 1;
    if (index > 9999) throw new Error('同名 PLC 导出目录过多');
  }
  return {
    name,
    path: join(options.exportsRoot, name),
    zipName: `${name}.zip`,
    zipPath: join(options.exportsRoot, name, `${name}.zip`)
  };
}
