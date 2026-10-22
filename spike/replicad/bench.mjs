import { writeFileSync } from 'node:fs';
const t0 = performance.now();
const { makeBox, makeCylinder, makeFace, sketchOnPlane, exportSTEP, exportSTL, setOC } = await import('replicad');
let ocReady = false;
try {
  const oc = await import('replicad-opencascadejs');
  const factory = oc.default ?? oc;
  setOC(await factory());
  ocReady = true;
} catch (e) {
  console.log('OC_INIT_ERR', e.message);
}
const importMs = performance.now() - t0;
if (!ocReady) process.exit(2);
const t1 = performance.now();
const plate = makeBox([120, 80, 8], { origin: [-60, -40, 0] });
const holes = [[-44,-24],[44,-24],[-44,24],[44,24]].map(([x,y]) => makeCylinder(3, 20, [x, y, -1]));
const part = plate.cut(...holes);
const buildMs = performance.now() - t1;
const t2 = performance.now();
const step = new Uint8Array(await exportSTEP([{ shape: part, name: 'part' }]).arrayBuffer());
const stepMs = performance.now() - t2;
const t3 = performance.now();
const stl = new Uint8Array(await part.blobSTL({ tolerance: 0.1 }).arrayBuffer());
const stlMs = performance.now() - t3;
writeFileSync('part.step', Buffer.from(step));
writeFileSync('part.stl', Buffer.from(stl));
console.log(JSON.stringify({ importMs: Math.round(importMs), buildMs: Math.round(buildMs), stepMs: Math.round(stepMs), stlMs: Math.round(stlMs), stepBytes: step.length, stlBytes: stl.length, volume: Math.round(part.volume) }));
