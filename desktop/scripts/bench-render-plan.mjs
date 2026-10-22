#!/usr/bin/env node
/**
 * P4 性能基准：用合成 10 万面模型测量「规划层」耗时与合批效果。
 * 只测纯计算（建模时间 + 帧计划），不做 GPU 渲染；渲染器接线后在同一脚本扩展 FPS。
 *
 * 用法：node scripts/bench-render-plan.mjs [三角面总数]
 * 输出：BENCH_RENDER_OK parts=.. triangles=.. metaMs=.. planMs=.. drawCalls=.. saved=..%
 */
import { buildPartMetas, describePlan, planFrame, withinFrameBudget } from '../src/cad/render-plan.ts';

const TARGET_TRIANGLES = Number(process.argv[2] ?? 100_000);
const UNIQUE_SHAPES = 20;
const TRIANGLES_PER_PART = 200;

function makePart(shapeIndex, copyIndex) {
  const positions = new Float32Array(TRIANGLES_PER_PART * 9);
  const size = 40 + shapeIndex;
  let cursor = 0;
  for (let t = 0; t < TRIANGLES_PER_PART; t += 1) {
    const x = ((t % 16) / 16) * size + copyIndex * 60;
    const y = (Math.floor(t / 16) % 16 / 16) * size;
    const z = shapeIndex * 5;
    positions[cursor++] = x;
    positions[cursor++] = y;
    positions[cursor++] = z;
    positions[cursor++] = x + 1.5;
    positions[cursor++] = y;
    positions[cursor++] = z;
    positions[cursor++] = x;
    positions[cursor++] = y + 1.5;
    positions[cursor++] = z;
  }
  return { name: `支架-${shapeIndex}-${copyIndex}`, positions, color: [0.5, 0.55, 0.6] };
}

const copyCount = Math.ceil(TARGET_TRIANGLES / (UNIQUE_SHAPES * TRIANGLES_PER_PART));
const meshes = [];
for (let shape = 0; shape < UNIQUE_SHAPES; shape += 1) {
  for (let copy = 0; copy < copyCount; copy += 1) meshes.push(makePart(shape, copy));
}
const totalTriangles = meshes.length * TRIANGLES_PER_PART;

const metaStart = performance.now();
const metas = buildPartMetas(meshes);
const metaMs = performance.now() - metaStart;

const planStart = performance.now();
const plan = planFrame(metas, { position: { x: 300, y: -300, z: 900 }, fovDeg: 45 });
const planMs = performance.now() - planStart;

const totalMs = metaMs + planMs;
const savedRatio = plan.naiveDrawCalls > 0 ? (1 - plan.drawCalls / plan.naiveDrawCalls) * 100 : 0;

console.log(
  `BENCH_RENDER parts=${meshes.length} triangles=${totalTriangles} metaMs=${metaMs.toFixed(1)} ` +
    `planMs=${planMs.toFixed(1)} drawCalls=${plan.drawCalls} naive=${plan.naiveDrawCalls} ` +
    `instances=${plan.instanceGroups.length} saved=${savedRatio.toFixed(0)}% ` +
    `budget=${withinFrameBudget(totalMs) ? 'OK' : 'OVER'}`
);
console.log(describePlan(plan, totalMs));

if (!withinFrameBudget(totalMs)) {
  console.error(`规划层耗时 ${totalMs.toFixed(1)}ms 超出 3s 首帧预算`);
  process.exit(1);
}
console.log('BENCH_RENDER_OK');
