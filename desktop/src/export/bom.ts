import * as XLSX from 'xlsx';

export interface BomRow {
  index: number | string;
  name: string;
  model: string;
  quantity: number;
  material: string;
  note?: string;
}

export const BOM_HEADERS = ['序号', '名称', '型号', '数量', '材料', '备注'] as const;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function csvCell(value: unknown): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly BomRow[]): string {
  if (!Array.isArray(rows)) throw new Error('BOM 数据必须是数组');
  const lines = [BOM_HEADERS.map((header) => csvCell(header)).join(',')];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 行 BOM 数据不合法`);
    lines.push([
      row.index,
      row.name,
      row.model,
      row.quantity,
      row.material,
      row.note ?? ''
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}

export function bomToSheet(rows: readonly BomRow[]): XLSX.WorkSheet {
  const data = [
    [...BOM_HEADERS],
    ...rows.map((row) => [
      row.index,
      row.name,
      row.model,
      row.quantity,
      row.material,
      row.note ?? ''
    ])
  ];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet['!cols'] = [{ wch: 7 }, { wch: 22 }, { wch: 24 }, { wch: 8 }, { wch: 16 }, { wch: 28 }];
  return sheet;
}

export function toXlsx(rows: readonly BomRow[]): Uint8Array {
  if (!Array.isArray(rows)) throw new Error('BOM 数据必须是数组');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, bomToSheet(rows), 'BOM');
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(output);
}
