export const EXPORT_EXTENSIONS = ['.pdf', '.dxf', '.glb', '.obj', '.csv', '.xlsx', '.step', '.stl', '.json'] as const;
export type ExportExtension = (typeof EXPORT_EXTENSIONS)[number];

export interface ValidatedExportName {
  name: string;
  extension: ExportExtension;
}

export function isExportExtension(value: string): value is ExportExtension {
  return (EXPORT_EXTENSIONS as readonly string[]).includes(value.toLowerCase());
}

/**
 * 校验渲染层传入的默认文件名。只允许纯文件名，不接受目录、盘符或 ..。
 */
export function validateExportFileName(name: unknown): ValidatedExportName {
  if (typeof name !== 'string' || !name.trim()) throw new Error('导出文件名不能为空');
  if (name !== name.trim()) throw new Error('导出文件名不能包含首尾空白');
  if (name.includes('\0')) throw new Error('导出文件名包含非法字符');
  if (/[\\/]/.test(name) || name === '.' || name === '..' || name.includes('..')) {
    throw new Error('导出文件名不能包含路径或 ..');
  }
  if (/^[a-zA-Z]:/.test(name)) throw new Error('导出文件名不能包含盘符或绝对路径');

  const dot = name.lastIndexOf('.');
  if (dot <= 0) throw new Error('导出文件名必须包含扩展名');
  const extension = name.slice(dot).toLowerCase();
  if (!isExportExtension(extension)) {
    throw new Error(`不支持的导出扩展名：${extension}（允许 ${EXPORT_EXTENSIONS.join(' / ')}）`);
  }
  return { name, extension };
}

export function ensureExportExtension(targetPath: string, extension: ExportExtension): string {
  const lower = targetPath.toLowerCase();
  if (lower.endsWith(extension)) return targetPath;
  const dot = targetPath.lastIndexOf('.');
  const separator = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'));
  if (dot <= separator) return `${targetPath}${extension}`;
  return `${targetPath.slice(0, dot)}${extension}`;
}

export function assertAllowedTargetPath(targetPath: string): ExportExtension {
  if (typeof targetPath !== 'string' || !targetPath) throw new Error('保存路径不能为空');
  if (targetPath.includes('\0')) throw new Error('保存路径包含非法字符');
  const dot = targetPath.lastIndexOf('.');
  if (dot < 0) throw new Error('保存路径必须包含扩展名');
  const extension = targetPath.slice(dot).toLowerCase();
  if (!isExportExtension(extension)) {
    throw new Error(`不支持的导出扩展名：${extension}（允许 ${EXPORT_EXTENSIONS.join(' / ')}）`);
  }
  return extension;
}
