import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGenericPartName, readablePartNames } from '../../src/cad/part-naming.ts';

const box = (name, size = [100, 50, 20]) => ({ name, sizeMm: size });

test('通用名识别：COMPOUND/SOLID/Part12/实体/空串', () => {
  for (const name of ['COMPOUND', 'compound', 'SOLID', 'Part12', 'part_3', 'Body', '未命名', '零件', '', '   ']) {
    assert.equal(isGenericPartName(name), true, `${name} 应判为通用名`);
  }
  for (const name of ['立柱-左前', '托条-L17-2', 'MXQ20-50', '底座A']) {
    assert.equal(isGenericPartName(name), false, `${name} 不应被判为通用名`);
  }
});

test('通用名替换成「序号 + 尺寸」，序号从 01 起、尺寸保留 0.1mm', () => {
  const names = readablePartNames([
    box('COMPOUND', [1400, 40, 3]),
    box('SOLID', [80, 80, 1800]),
    box('')
  ]);
  assert.deepEqual(names, [
    '零件-01（1400×40×3）',
    '零件-02（80×80×1800）',
    '零件-03（100×50×20）'
  ]);
});

test('真实名保留（不被改写），重名加 -2/-3', () => {
  const names = readablePartNames([box('立柱'), box('立柱'), box('托条-L17-2')]);
  assert.deepEqual(names, ['立柱', '立柱-2', '托条-L17-2']);
});

test('混合：真实名与通用名各自去重，不互相污染', () => {
  const names = readablePartNames([box('COMPOUND'), box('压板'), box('COMPOUND')]);
  assert.equal(names[0], '零件-01（100×50×20）');
  assert.equal(names[1], '压板');
  assert.equal(names[2], '零件-03（100×50×20）', '序号按网格原始位置，不因跳过真实名而错位');
});

test('尺寸为 0（空几何）也能给出可读名，不崩', () => {
  const names = readablePartNames([box('COMPOUND', [0, 0, 0])]);
  assert.equal(names[0], '零件-01（0×0×0）');
});
