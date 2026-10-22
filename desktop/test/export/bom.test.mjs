import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as XLSX from 'xlsx';
import { BOM_HEADERS, toCsv, toXlsx } from '../../src/export/bom.ts';

const rows = [
  { index: 1, name: '左侧支架', model: 'BRK-01', quantity: 2, material: '6061-T6', note: '阳极氧化' },
  { index: 2, name: '气缸', model: 'MXQ20-50', quantity: 1, material: '铝合金', note: '' }
];

test('CSV 表头与普通行', () => {
  const csv = toCsv(rows);
  assert.equal(csv.split('\r\n')[0], BOM_HEADERS.join(','));
  assert.match(csv, /1,左侧支架,BRK-01,2,6061-T6,阳极氧化/);
});

test('CSV 转义逗号、双引号与换行', () => {
  const csv = toCsv([
    { index: 3, name: '支架,左', model: 'A"B', quantity: 1, material: '钢', note: '第一行\n第二行' }
  ]);
  assert.match(csv, /"支架,左"/);
  assert.match(csv, /"A""B"/);
  assert.match(csv, /"第一行\n第二行"/);
});

test('XLSX 可被 xlsx 读回且值一致', () => {
  const data = toXlsx(rows);
  assert.ok(data.byteLength > 0);
  const workbook = XLSX.read(data, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const values = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  assert.deepEqual(values[0], [...BOM_HEADERS]);
  assert.deepEqual(values[1], ['1', '左侧支架', 'BRK-01', '2', '6061-T6', '阳极氧化']);
  assert.deepEqual(values[2], ['2', '气缸', 'MXQ20-50', '1', '铝合金', '']);
});
