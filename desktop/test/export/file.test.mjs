import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertAllowedTargetPath,
  ensureExportExtension,
  validateExportFileName
} from '../../src/export/file.ts';

test('合法导出名通过并返回小写扩展名', () => {
  assert.deepEqual(validateExportFileName('BOM-001.XLSX'), { name: 'BOM-001.XLSX', extension: '.xlsx' });
});

test('非法扩展名与路径穿越被拒绝', () => {
  assert.throws(() => validateExportFileName('report.exe'), /不支持的导出扩展名/);
  assert.throws(() => validateExportFileName('../report.csv'), /路径或 \.\./);
  assert.throws(() => validateExportFileName('C:\\temp\\report.pdf'), /路径/);
  assert.throws(() => assertAllowedTargetPath('/tmp/report.sh'), /不支持的导出扩展名/);
});

test('参数化导出格式 step / stl / json 通过白名单', () => {
  assert.deepEqual(validateExportFileName('bracket.STEP'), { name: 'bracket.STEP', extension: '.step' });
  assert.deepEqual(validateExportFileName('bracket.stl'), { name: 'bracket.stl', extension: '.stl' });
  assert.deepEqual(validateExportFileName('bracket.parametric.json'), { name: 'bracket.parametric.json', extension: '.json' });
});

test('保存路径缺少扩展名时补齐，已有扩展名则替换', () => {
  assert.equal(ensureExportExtension('/tmp/report', '.csv'), '/tmp/report.csv');
  assert.equal(ensureExportExtension('/tmp/report.txt', '.csv'), '/tmp/report.csv');
  assert.equal(ensureExportExtension('/tmp/report.CSV', '.csv'), '/tmp/report.CSV');
});
