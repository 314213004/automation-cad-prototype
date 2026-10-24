#!/usr/bin/env node
/**
 * Headless performance baseline for the parametric machine viewer.
 *
 * Usage:
 *   node --expose-gc scripts/perf-baseline.mjs
 *   node scripts/perf-baseline.mjs --json
 *
 * The workload is generated from the production geometry generator and three.js
 * scene builder. It deliberately avoids WebGL so the numbers describe CPU-side
 * scene construction and per-tick transform work, not GPU rasterisation.
 */

import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMachineGeometry } from '../src/machine/geometry.ts';
import { buildThreeMachine, applyAxisValue } from '../src/machine/geometry-three.ts';
import { MachineMotion } from '../src/commission/scene3d.ts';

const TICK_COUNT = 300;
const FRAME_MS = 1000 / 60;

const SCALES = [
  { target: 200, stations: 4, actuatorsPerStation: 6, extraSensors: 0 },
  { target: 1000, stations: 16, actuatorsPerStation: 8, extraSensors: 0 },
  { target: 3000, stations: 33, actuatorsPerStation: 12, extraSensors: 2 }
];

function buildConfig(scale) {
  const stations = Array.from({ length: scale.stations }, (_, index) => `S${index + 1}`);
  const actuators = [];
  const sensors = [];
  for (let stationIndex = 0; stationIndex < scale.stations; stationIndex += 1) {
    const station = stations[stationIndex];
    for (let actuatorIndex = 0; actuatorIndex < scale.actuatorsPerStation; actuatorIndex += 1) {
      const id = `cyl-${stationIndex + 1}-${actuatorIndex + 1}`;
      actuators.push({
        id,
        name: `Cylinder ${stationIndex + 1}-${actuatorIndex + 1}`,
        kind: 'cylinder',
        station,
        extendPoint: `${id}-extend`,
        retractPoint: `${id}-retract`,
        travelMm: 50,
        durationMs: 400
      });
      sensors.push({ point: `${id}-sensor`, station, part: id });
    }
  }
  for (let index = 0; index < scale.extraSensors; index += 1) {
    sensors.push({
      point: `extra-sensor-${index + 1}`,
      station: stations[0],
      part: actuators[0]?.id ?? ''
    });
  }
  return {
    id: `design-assembly-${scale.target}st`,
    name: `Perf ${scale.target}`,
    stations,
    actuators,
    sensors
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function countMaterials(root) {
  const materials = new Set();
  root.traverse((node) => {
    const material = node.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else if (material) {
      materials.add(material);
    }
  });
  return materials.size;
}

function sampleHeap() {
  return process.memoryUsage().heapUsed;
}

function measureScale(scale) {
  const config = buildConfig(scale);
  const points = Object.fromEntries(config.actuators.map((actuator) => [actuator.extendPoint, true]));

  if (global.gc) global.gc();
  const heapBefore = sampleHeap();

  const coldStart = performance.now();
  const geometry = generateMachineGeometry(config, { layout: 'linear' });
  const coldBuildMs = performance.now() - coldStart;

  const warmRuns = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    generateMachineGeometry(config, { layout: 'linear' });
    warmRuns.push(performance.now() - started);
  }
  warmRuns.sort((a, b) => a - b);

  const sceneStart = performance.now();
  const scene = buildThreeMachine(geometry, { targetSpan: 6 });
  const sceneBuildMs = performance.now() - sceneStart;

  const motion = new MachineMotion(config, () => 0);
  motion.update(points, 0);
  let peakHeap = sampleHeap();
  const tickTimes = [];
  let transformUpdates = 0;
  for (let tick = 0; tick < TICK_COUNT; tick += 1) {
    const started = performance.now();
    const now = tick * FRAME_MS;
    motion.update(points, now);
    motion.advance(now);
    for (const node of scene.actuators.values()) {
      const state = motion.getActuator(node.axis.actuatorId);
      if (state) {
        if (applyAxisValue(node, state.value)) transformUpdates += 1;
      }
    }
    scene.root.updateMatrixWorld();
    tickTimes.push(performance.now() - started);
    if ((tick & 15) === 0) peakHeap = Math.max(peakHeap, sampleHeap());
  }
  peakHeap = Math.max(peakHeap, sampleHeap());
  const sortedTicks = [...tickTimes].sort((a, b) => a - b);
  const tickTotalMs = tickTimes.reduce((sum, value) => sum + value, 0);

  return {
    targetParts: scale.target,
    actualParts: geometry.parts.length,
    stations: geometry.stations.length,
    actuators: geometry.moving.length,
    coldBuildMs: round(coldBuildMs),
    warmBuildMs: round(warmRuns[Math.floor(warmRuns.length / 2)] ?? 0),
    sceneBuildMs: round(sceneBuildMs),
    tickTotalMs: round(tickTotalMs),
    tickAvgMs: round(tickTotalMs / TICK_COUNT, 4),
    tickP50Ms: round(percentile(sortedTicks, 0.5), 4),
    tickP95Ms: round(percentile(sortedTicks, 0.95), 4),
    heapPeakMb: round(peakHeap / 1024 / 1024, 2),
    heapDeltaMb: round((peakHeap - heapBefore) / 1024 / 1024, 2),
    meshes: scene.meshCount,
    materials: countMaterials(scene.root),
    transformUpdates,
    ticks: TICK_COUNT
  };
}

function main() {
  const requestedScales = process.argv
    .filter((argument) => argument.startsWith('--parts='))
    .flatMap((argument) => argument.slice('--parts='.length).split(','))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const selected = requestedScales.length > 0
    ? SCALES.filter((scale) => requestedScales.includes(scale.target))
    : SCALES;
  const results = selected.map(measureScale);
  const payload = {
    schemaVersion: 1,
    kind: 'automation-cad-perf-baseline',
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    workload: {
      tickCount: TICK_COUNT,
      frameMs: FRAME_MS,
      renderer: 'headless three.js scene tree (no WebGL)'
    },
    results
  };

  const jsonIndex = process.argv.indexOf('--out');
  if (jsonIndex >= 0) {
    const target = process.argv[jsonIndex + 1];
    if (!target) throw new Error('--out 需要目标 JSON 路径');
    writeFileSync(resolve(target), `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  console.log(`PERF_BASELINE node=${process.version} ticks=${TICK_COUNT} renderer=headless`);
  for (const result of results) {
    console.log(
      `PERF scale=${result.targetParts} parts=${result.actualParts} coldBuildMs=${result.coldBuildMs} ` +
      `warmBuildMs=${result.warmBuildMs} sceneBuildMs=${result.sceneBuildMs} ` +
      `tickAvgMs=${result.tickAvgMs} tickP95Ms=${result.tickP95Ms} ` +
      `heapPeakMb=${result.heapPeakMb} meshes=${result.meshes} materials=${result.materials}`
    );
  }
}

main();
