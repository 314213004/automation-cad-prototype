// 大输入保护：在读取/解析前给出确定性中文拒绝原因，避免大文件把主进程或渲染进程卡死。

export const BOM_MAX_ROWS = 5000;
export const STEP_MAX_BYTES = 200 * 1024 * 1024;
export const CAD_FILE_MAX_BYTES = 50 * 1024 * 1024;

export type InputLimitCode = 'STEP_TOO_LARGE' | 'FILE_TOO_LARGE' | 'BOM_TOO_MANY_ROWS' | 'INVALID_FILE_SIZE';

export class InputLimitError extends Error {
  readonly code: InputLimitCode;
  readonly limit: number;
  readonly actual: number;

  constructor(code: InputLimitCode, message: string, limit: number, actual: number) {
    super(message);
    this.name = 'InputLimitError';
    this.code = code;
    this.limit = limit;
    this.actual = actual;
  }
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** STEP/IGES 允许 200 MB，其余 CAD 文件 50 MB；按扩展名选择阈值。 */
export function cadFileLimitBytes(fileName: string): number {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return extension === 'step' || extension === 'stp' ? STEP_MAX_BYTES : CAD_FILE_MAX_BYTES;
}

/** 读取前调用；超限抛 InputLimitError，调用方应把 message 直接展示给用户。 */
export function assertCadFileSize(fileName: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new InputLimitError('INVALID_FILE_SIZE', `无法读取文件大小：${fileName}`, 0, 0);
  }
  const limit = cadFileLimitBytes(fileName);
  if (bytes <= limit) return;
  const isStep = limit === STEP_MAX_BYTES;
  const code: InputLimitCode = isStep ? 'STEP_TOO_LARGE' : 'FILE_TOO_LARGE';
  const label = isStep ? 'STEP' : 'CAD';
  const action = isStep
    ? '请先在 CAD 软件中做轻量化/去特征，或按子系统拆分后再导入。'
    : '请先压缩网格、删除隐藏零件，或按子系统拆分后再导入。';
  throw new InputLimitError(
    code,
    `${label} 文件 ${formatMb(bytes)} MB，超过 ${formatMb(limit)} MB 上限；${action}`,
    limit,
    bytes
  );
}

/** BOM 输入/追加前的行数保护；total 为现有行数，incoming 为本次要加入的行数。 */
export function assertBomRowCount(total: number, incoming = 0): void {
  const projected = Math.max(0, Math.trunc(total)) + Math.max(0, Math.trunc(incoming));
  if (projected <= BOM_MAX_ROWS) return;
  throw new InputLimitError(
    'BOM_TOO_MANY_ROWS',
    `BOM 共 ${projected} 行，超过 ${BOM_MAX_ROWS} 行上限；请按装配/批次拆分，或先清理重复行后再试。`,
    BOM_MAX_ROWS,
    projected
  );
}
