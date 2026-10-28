import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectConveyorSpec, detectProcess } from '../../src/machine/spec.ts';

test('缓存机台按输送线（缓存线）识别，不再落回通用转盘模板', () => {
  const brief = '设计一台缓存机台：链式缓存线，12 个缓存工位（3 层 × 4 位），来料托盘 300×200mm，节拍 15 件/分钟';
  assert.equal(detectProcess(brief), 'conveyor');
});

test('缓存线/积放线/倍速链都归输送工艺', () => {
  for (const text of ['缓存线体', '积放式输送', '倍速链输送线', '链式输送机']) {
    assert.equal(detectProcess(text), 'conveyor', text);
  }
});

test('其他工艺不被缓存关键词抢走', () => {
  assert.equal(detectProcess('锁螺丝机，带缓存工位'), 'screw');
  assert.equal(detectProcess('视觉检测机，进料缓存 20 件'), 'inspection');
});

test('只给「占地 3000×1800」也要拿到线体长宽', () => {
  const spec = detectConveyorSpec('链式缓存线，占地 3000×1800mm，12 个缓存工位');
  assert.ok(spec);
  assert.equal(spec.lengthMm, 3000);
  assert.equal(spec.widthMm, 1800);
});

test('没有尺寸线索时仍返回 null（不臆造）', () => {
  assert.equal(detectConveyorSpec('做一台缓存机台'), null);
});
