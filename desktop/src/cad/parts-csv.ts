// 工程零件清单 CSV（可交付/可核对）
//
// 只写「场景里真实存在的量」：零件名、装配路径、包围盒尺寸、三角面数。
// 不写质量（导入网格没有材料/密度）、不写单价（工程记录里没有价格语义）——
// 空着比编一个数强，需要的人自己去称/去询价。

export interface PartsCsvRow {
  name: string;
  path?: string[];
  /** 包围盒 [minX,minY,minZ,maxX,maxY,maxZ]（mm） */
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  triangles?: number;
}

const HEADER = ['序号', '零件名', '装配路径', '宽X_mm', '深Y_mm', '高Z_mm', '三角面数'];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function cell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 生成 CSV（带 BOM 便于 Excel 直接识别中文）。空清单返回只有表头的文本。 */
export function buildPartsCsv(rows: readonly PartsCsvRow[]): { csv: string; rows: number } {
  const lines = [HEADER.map(cell).join(',')];
  rows.forEach((row, index) => {
    const min = row.bbox?.min;
    const max = row.bbox?.max;
    const size = min && max
      ? [round1(max[0] - min[0]), round1(max[1] - min[1]), round1(max[2] - min[2])]
      : null;
    lines.push([
      index + 1,
      row.name,
      (row.path ?? []).join(' > '),
      size ? size[0] : '',
      size ? size[1] : '',
      size ? size[2] : '',
      typeof row.triangles === 'number' ? row.triangles : ''
    ].map(cell).join(','));
  });
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows: rows.length };
}

/** 文件名（去掉路径分隔符/通配符，限制长度）。 */
export function partsCsvFileName(projectName: string): string {
  const base = (projectName || '工程零件').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40) || '工程零件';
  return `${base}-零件清单.csv`;
}
