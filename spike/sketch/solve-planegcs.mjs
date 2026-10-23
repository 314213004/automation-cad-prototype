import { performance } from 'node:perf_hooks';
import { make_gcs_wrapper, SolveStatus } from '@salusoft89/planegcs';

const WIDTH = 120;
const HEIGHT = 80;

// Deliberately wrong start so the solver has real work to do.
const START = [
  [0.0, 0.0],      // p1 fixed at the origin
  [117.0, 3.0],
  [123.5, 77.0],
  [-2.0, 82.5],
];

function rectanglePrimitives(vertices) {
  const [p1, p2, p3, p4] = vertices;
  const pts = vertices.map(([x, y], i) => ({
    id: `p${i + 1}`,
    type: 'point',
    x,
    y,
    fixed: i === 0,
  }));
  return [
    ...pts,
    { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
    { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
    { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
    { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' },
    { id: 'c1', type: 'horizontal_pp', p1_id: 'p1', p2_id: 'p2' },
    { id: 'c2', type: 'vertical_pp', p1_id: 'p1', p2_id: 'p4' },
    { id: 'c3', type: 'vertical_pp', p1_id: 'p2', p2_id: 'p3' },
    { id: 'c4', type: 'horizontal_pp', p1_id: 'p4', p2_id: 'p3' },
    { id: 'c5', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: WIDTH },
    { id: 'c6', type: 'p2p_distance', p1_id: 'p2', p2_id: 'p3', distance: HEIGHT },
  ];
}

function buildAndSolve(wrapper, vertices = START) {
  for (const primitive of rectanglePrimitives(vertices)) {
    wrapper.push_primitive(primitive);
  }
  const solveStart = performance.now();
  const status = wrapper.solve();
  const solveMs = performance.now() - solveStart;
  wrapper.apply_solution();
  return { status, solveMs };
}

function verticesOf(wrapper) {
  return ['p1', 'p2', 'p3', 'p4'].map((id) => {
    const p = wrapper.sketch_index.get_sketch_point(id);
    return [p.x, p.y];
  });
}

function residualReport(vertices) {
  const [p1, p2, p3, p4] = vertices;
  return [
    { id: 'c1', name: 'horizontal(p1,p2)', value: p2[1] - p1[1] },
    { id: 'c2', name: 'vertical(p1,p4)', value: p4[0] - p1[0] },
    { id: 'c3', name: 'vertical(p2,p3)', value: p3[0] - p2[0] },
    { id: 'c4', name: 'horizontal(p4,p3)', value: p3[1] - p4[1] },
    { id: 'c5', name: 'width(p1,p2)=120', value: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) - WIDTH },
    { id: 'c6', name: 'height(p2,p3)=80', value: Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) - HEIGHT },
  ];
}

const initStart = performance.now();
const wrapper = await make_gcs_wrapper();
const initMs = performance.now() - initStart;

const first = buildAndSolve(wrapper);
const vertices = verticesOf(wrapper);
const residuals = residualReport(vertices);
const maxAbsResidual = Math.max(...residuals.map((r) => Math.abs(r.value)));

// Steady-state: fresh builds after WASM is warm, 30 samples.
const samples = [];
for (let i = 0; i < 30; i++) {
  const w = await make_gcs_wrapper();
  const t0 = performance.now();
  const status = buildAndSolve(w, START).status;
  const ms = performance.now() - t0;
  if (status !== SolveStatus.Converged && status !== SolveStatus.Success) {
    throw new Error(`benchmark solve failed: status=${status}`);
  }
  samples.push(ms);
  w.destroy_gcs_module();
}
samples.sort((a, b) => a - b);

const result = {
  library: '@salusoft89/planegcs@1.3.0',
  constraints: {
    rectangle: 'p1-p2-p3-p4, p1 fixed at origin',
    rows: ['horizontal(p1,p2)', 'vertical(p1,p4)', 'vertical(p2,p3)', 'horizontal(p4,p3)', 'width p1-p2 = 120', 'height p2-p3 = 80'],
  },
  startVertices: START,
  status: first.status,
  statusName: Object.entries(SolveStatus).find(([, v]) => v === first.status)?.[0],
  dof: wrapper.gcs.dof(),
  vertices,
  residuals: residuals.map((r) => ({ ...r, value: Number(r.value.toFixed(9)) })),
  maxAbsResidual,
  timingsMs: {
    init: Number(initMs.toFixed(2)),
    firstSolve: Number(first.solveMs.toFixed(3)),
    warmBuildAndSolveMedian: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    warmBuildAndSolveP95: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
  },
};

console.log(JSON.stringify(result, null, 2));
wrapper.destroy_gcs_module();

if (first.status !== SolveStatus.Converged && first.status !== SolveStatus.Success) process.exitCode = 1;
if (maxAbsResidual > 1e-6) process.exitCode = 1;
