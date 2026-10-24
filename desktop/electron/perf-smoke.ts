// Headless smoke 专用的性能 workload：只在 --headless-smoke 中动态加载，
// 避免普通桌面启动静态引入 three.js / 几何生成器。
import { generateMachineGeometry } from '../src/machine/geometry.ts';
import { applyAxisValue, buildThreeMachine, disposeThreeMachine } from '../src/machine/geometry-three.ts';
import { MachineMotion } from '../src/commission/scene3d.ts';

export interface PerfSmokeResult {
  parts: number;
  buildMs: number;
  tickMs: number;
}

/** 构造 1000 件线性装配并模拟 300 帧；仅测 CPU 侧场景与变换更新。 */
export function runPerfSmoke(targetParts = 1000): PerfSmokeResult {
  const stations = Array.from({ length: Math.max(1, Math.round(targetParts / 62.5)) }, (_, index) => `S${index + 1}`);
  const actuators = [];
  const sensors = [];
  for (let stationIndex = 0; stationIndex < stations.length; stationIndex += 1) {
    const station = stations[stationIndex]!;
    for (let actuatorIndex = 0; actuatorIndex < 8; actuatorIndex += 1) {
      const id = `smoke-cyl-${stationIndex + 1}-${actuatorIndex + 1}`;
      actuators.push({
        id,
        name: `Smoke Cylinder ${stationIndex + 1}-${actuatorIndex + 1}`,
        kind: 'cylinder' as const,
        station,
        extendPoint: `${id}-extend`,
        retractPoint: `${id}-retract`,
        travelMm: 50,
        durationMs: 400
      });
      sensors.push({ point: `${id}-sensor`, station, part: id });
    }
  }
  const config = {
    id: 'design-perf-smoke',
    name: 'Perf Smoke',
    stations,
    actuators,
    sensors
  };

  const buildStarted = performance.now();
  const geometry = generateMachineGeometry(config, { layout: 'linear' });
  const machine = buildThreeMachine(geometry, { targetSpan: 6 });
  const buildMs = performance.now() - buildStarted;
  const points = Object.fromEntries(actuators.map((actuator) => [String(actuator.extendPoint), true]));
  const motion = new MachineMotion(config as never, () => 0);
  const tickStarted = performance.now();
  for (let tick = 0; tick < 300; tick += 1) {
    const now = tick * (1000 / 60);
    motion.update(points, now);
    motion.advance(now);
    for (const node of machine.actuators.values()) {
      applyAxisValue(node, motion.getActuator(node.axis.actuatorId)?.value ?? 0);
    }
  }
  const tickMs = (performance.now() - tickStarted) / 300;
  const result = { parts: geometry.parts.length, buildMs, tickMs };
  disposeThreeMachine(machine);
  return result;
}
