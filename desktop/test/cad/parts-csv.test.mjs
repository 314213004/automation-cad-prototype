import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPartsCsv, partsCsvFileName } from '../../src/cad/parts-csv.ts';

const box = (min, max) => ({ min, max });

test('buildPartsCsv：表头固定，行数正确，带 BOM 与 CRLF（Excel 直接认中文）', () => {
  const { csv, rows } = buildPartsCsv([
    { name: '立柱-左前', path: ['缓存单元', '机架'], bbox: box([-750, -700, 0], [-670, -620, 1800]), triangles: 12 }
  ]);
  assert.equal(rows, 1);
  assert.ok(csv.startsWith('\uFEFF序号,零件名,装配路径,宽X_mm,深Y_mm,高Z_mm,三角面数'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes('立柱-左前'));
  assert.ok(csv.includes('缓存单元 > 机架'));
  assert.ok(csv.includes('80,80,1800,12'), '包围盒尺寸由 max-min 算出');
});

test('buildPartsCsv：缺包围盒/三角面时留空，不编数', () => {
  const { csv } = buildPartsCsv([{ name: '无几何件' }]);
  assert.ok(csv.trimEnd().endsWith('1,无几何件,,,,,'), '路径/宽/深/高/三角面 五个空列都留空');
});

test('buildPartsCsv：逗号/引号/换行做 CSV 转义', () => {
  const { csv } = buildPartsCsv([{ name: '件,带"引号"\n换行', bbox: box([0, 0, 0], [1, 1, 1]), triangles: 12 }]);
  assert.ok(csv.includes('"件,带""引号""\n换行"'));
});

test('buildPartsCsv：空清单只有表头', () => {
  const { csv, rows } = buildPartsCsv([]);
  assert.equal(rows, 0);
  assert.equal(csv.trimEnd().split('\r\n').length, 1);
});

test('partsCsvFileName：替换非法字符并限长', () => {
  assert.equal(partsCsvFileName('光伏缓存堆叠单元（导入）'), '光伏缓存堆叠单元（导入）-零件清单.csv');
  assert.equal(partsCsvFileName('a/b:c*?'), 'a_b_c__-零件清单.csv');
  assert.equal(partsCsvFileName(''), '工程零件-零件清单.csv');
  assert.ok(partsCsvFileName('x'.repeat(80)).length <= 60);
});
