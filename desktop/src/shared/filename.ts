/**
 * 导出文件名净化与时间戳。
 *
 * 成本报告与 PLC 导出共用同一套规则：去掉路径分隔符、Windows 非法字符、
 * 控制字符与首尾空白/点，确保调用方传入的任意名称都不会逃出目标目录。
 */

/** 文件名净化；只返回基名，不保证扩展名。 */
export function sanitizeFileName(value: unknown, maxLength = 80): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim()
    .slice(0, Math.max(1, maxLength))
    .replace(/[\s.]+$/g, '');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `yyyyMMdd-HHmm`（本地时区）。 */
export function exportTimestamp(value: Date | string | number = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return exportTimestamp(new Date());
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/** 成本模块沿用的旧名称；新代码请直接用 `sanitizeFileName` / `exportTimestamp`。 */
export const sanitizeCostFileName = sanitizeFileName;
export const costExportTimestamp = exportTimestamp;
