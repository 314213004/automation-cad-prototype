import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bboxAtRatio,
  detectKeyframeInterferences,
  sweptBBox
} from '../../src/mech/interference-keyframe.ts';

const part = (over = {}) => ({ name: 'A', bbox: { min: [0, 0, 0], max: [10, 10, 10] }, ...over });

test('sweptBBox：行程方向上的包围盒扩展到平移后位置，反向行程同样扩展', () => {
  assert.deepEqual(sweptBBox(part({ strokeVectorMm: [20, 0, 0] })), { min: [0, 0, 0], max: [30, 10, 10] });
  assert.deepEqual(sweptBBox(part({ strokeVectorMm: [-20, 0, 0] })), { min: [-20, 0, 0], max: [10, 10, 10] });
});

test('bboxAtRatio：0% 在原位，50% 在半程，100% 在满行程；比例越界抛错', () => {
  const p = part({ strokeVectorMm: [20, 0, 0] });
  assert.deepEqual(bboxAtRatio(p, 0), { min: [0, 0, 0], max: [10, 10, 10] });
  assert.deepEqual(bboxAtRatio(p, 0.5), { min: [10, 0, 0], max: [20, 10, 10] });
  assert.deepEqual(bboxAtRatio(p, 1), { min: [20, 0, 0], max: [30, 10, 10] });
  assert.throws(() => bboxAtRatio(p, 1.5), /0~1/);
});

test('关键帧：运动件只在满行程撞上，0% / 50% 不报，满行程报 error', () => {
  const moving = part({ name: 'M', strokeVectorMm: [20, 0, 0] });
  const fixed = part({ name: 'F', bbox: { min: [25, 0, 0], max: [35, 10, 10] } });
  const hits = detectKeyframeInterferences([moving, fixed]);
  assert.deepEqual(hits.map((h) => h.poseRatio), [1]);
  assert.equal(hits[0].severity, 'error');
  assert.equal(hits[0].volumeApproxMm3, 500);
});

test('行程粗筛：全程都不相交的远处零件对直接跳过，不进入关键帧', () => {
  const a = part({ name: 'A', strokeVectorMm: [10, 0, 0] });
  const b = part({ name: 'B', bbox: { min: [100, 0, 0], max: [110, 10, 10] } });
  assert.deepEqual(detectKeyframeInterferences([a, b]), []);
});

test('配合豁免：配合对微过盈 <50mm³ 不报，≥50mm³ 仍报；非配合对小过盈报 warning', () => {
  const a = part({ name: 'A' });
  const small = part({ name: 'B', bbox: { min: [9, 0, 0], max: [19, 2, 2] } }); // 重叠 1×2×2=4
  assert.deepEqual(detectKeyframeInterferences([a, small], [0], { matedPairs: [['A', 'B']] }), []);
  assert.equal(detectKeyframeInterferences([a, small], [0])[0].severity, 'warning');
  const big = part({ name: 'B', bbox: { min: [9, 0, 0], max: [19, 10, 10] } }); // 重叠 1×10×10=100
  const hits = detectKeyframeInterferences([a, big], [0], { matedPairs: [['B', 'A']] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'error');
});

test('相切不算干涉', () => {
  const a = part({ name: 'A' });
  const b = part({ name: 'B', bbox: { min: [10, 0, 0], max: [20, 10, 10] } });
  assert.deepEqual(detectKeyframeInterferences([a, b], [0]), []);
});
