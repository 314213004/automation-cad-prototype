import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectWorkpiece, parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const PV = '设计一台光伏板缓存堆叠机：光伏板 2400×1200×35mm、单件约 32kg，缓存 30 片，8 片/分钟放行，占地 6000×3000mm，380V';

test('detectWorkpiece：识别 2400×1200×35mm + 32kg', () => {
  const spec = detectWorkpiece(PV);
  assert.equal(spec.lengthMm, 2400);
  assert.equal(spec.widthMm, 1200);
  assert.equal(spec.heightMm, 35);
  assert.equal(spec.massKg, 32);
});

test('detectWorkpiece：不把节拍/工位数当尺寸', () => {
  assert.equal(detectWorkpiece('3 秒/片，20 片/分钟，4 工位，380V'), null);
  assert.equal(detectWorkpiece('占地不超过 6000×3000mm'), null, '两个数但没有工件/重量语义时不当工件');
});

test('parseMachineBrief：工件尺寸进 brief 并写进 notes，不再丢', () => {
  const brief = parseMachineBrief(PV);
  assert.equal(brief.workpiece.lengthMm, 2400);
  assert.ok(brief.notes.some((note) => note.includes('工件：2400×1200×35 mm')), brief.notes.join(' | '));
});

test('synthMachine：大件触发「模板不含工件夹持空间」告警', () => {
  const design = synthMachine(parseMachineBrief(PV));
  const warning = design.warnings.find((item) => item.includes('属于大件'));
  assert.ok(warning, `期望大件告警，实际：${design.warnings.join(' | ')}`);
  assert.match(warning, /包络不能作为占地与验收依据/);
});

test('synthMachine：小件不触发大件告警', () => {
  const design = synthMachine(parseMachineBrief('4 工位锁螺丝机，节拍 12 件/分钟，工件 120×80mm'));
  assert.equal(design.warnings.some((item) => item.includes('属于大件')), false);
});
