// MachineGeometry → three.js 场景树。与导出共用 partLocalMesh，保证「看到的 = 导出的」。
// 根节点绕 X 轴 -90°（Z 向上 → Y 向上）并按 scale 缩放到场景单位；子节点保持 mm 数据。
// 运动件按 GeomMovingAxis 分组：linear / gripper 用平移子组，rotary 用位于转轴的枢轴组。

import * as THREE from 'three';
import type { GeomMovingAxis, GeomPart, MachineGeometry } from './geometry.ts';
import { partLocalMesh } from './geometry-export.ts';

export interface ThreeActuatorNode {
  axis: GeomMovingAxis;
  group: THREE.Group;
  /** linear：整体平移组；rotary：枢轴组；gripper：未使用（见 jaws）。 */
  mover: THREE.Group | null;
  jaws: { group: THREE.Group; sign: 1 | -1 }[];
}

export interface ThreeSensorNode {
  point: string;
  meshes: THREE.Mesh[];
  material: THREE.MeshStandardMaterial;
}

export interface ThreeMachine {
  root: THREE.Group;
  scale: number;
  stationGroups: Map<string, THREE.Group>;
  actuators: Map<string, ThreeActuatorNode>;
  sensors: Map<string, ThreeSensorNode>;
  meshCount: number;
}

function partMesh(part: GeomPart, material: THREE.Material, segments: number): THREE.Mesh {
  const local = partLocalMesh(part, segments);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(local.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(local.normals, 3));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = part.id;
  mesh.position.set(part.center[0], part.center[1], part.center[2]);
  mesh.rotation.z = THREE.MathUtils.degToRad(part.rotationZDeg);
  mesh.userData.partId = part.id;
  if (part.sensorPoint) mesh.userData.pointId = part.sensorPoint;
  return mesh;
}

function material(part: GeomPart): THREE.MeshStandardMaterial {
  const metal = part.role === 'actuator' ? 0.55 : part.role === 'frame' || part.role === 'structure' ? 0.35 : 0.15;
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(part.color), metalness: metal, roughness: 0.5 });
}

export function buildThreeMachine(
  geometry: MachineGeometry,
  options: { targetSpan?: number; segments?: number; sensorOffColor?: THREE.Color } = {}
): ThreeMachine {
  const segments = options.segments ?? 20;
  const span = Math.max(geometry.envelope[0], geometry.envelope[1], geometry.envelope[2], 1);
  const scale = (options.targetSpan ?? 6) / span;
  const root = new THREE.Group();
  root.name = `machine-geometry:${geometry.machineId}`;
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(scale);

  const machineGroup = new THREE.Group();
  machineGroup.name = 'machine-static';
  root.add(machineGroup);

  const stationGroups = new Map<string, THREE.Group>();
  for (const station of geometry.stations) {
    const group = new THREE.Group();
    group.name = `station:${station.id}`;
    root.add(group);
    stationGroups.set(station.id, group);
  }

  const actuators = new Map<string, ThreeActuatorNode>();
  const movingByPart = new Map<string, { node: ThreeActuatorNode; jaw?: number }>();
  for (const axis of geometry.moving) {
    const group = new THREE.Group();
    group.name = `actuator:${axis.actuatorId}`;
    const stationGroup = stationGroups.get(axis.stationId) ?? root;
    stationGroup.add(group);
    const node: ThreeActuatorNode = { axis, group, mover: null, jaws: [] };
    if (axis.kind === 'gripper') {
      for (const jaw of axis.jaws ?? []) {
        const jawGroup = new THREE.Group();
        jawGroup.name = `jaw:${jaw.partId}`;
        group.add(jawGroup);
        node.jaws.push({ group: jawGroup, sign: jaw.sign });
        movingByPart.set(jaw.partId, { node, jaw: node.jaws.length - 1 });
      }
    } else {
      const mover = new THREE.Group();
      mover.name = axis.kind === 'rotary' ? `pivot:${axis.actuatorId}` : `slide:${axis.actuatorId}`;
      if (axis.kind === 'rotary') mover.position.set(axis.pivot[0], axis.pivot[1], axis.pivot[2]);
      group.add(mover);
      node.mover = mover;
      for (const partId of axis.partIds) movingByPart.set(partId, { node });
    }
    actuators.set(axis.actuatorId, node);
  }

  const sensors = new Map<string, ThreeSensorNode>();
  let meshCount = 0;
  for (const part of geometry.parts) {
    if (part.sensorPoint && (part.role === 'sensor' || part.role === 'safety')) {
      const key = part.sensorPoint.toUpperCase();
      let sensor = sensors.get(key);
      if (!sensor) {
        sensor = {
          point: part.sensorPoint,
          meshes: [],
          material: new THREE.MeshStandardMaterial({
            color: options.sensorOffColor?.clone() ?? new THREE.Color(part.color),
            emissive: 0x000000,
            emissiveIntensity: 0.05,
            metalness: 0.1,
            roughness: 0.35
          })
        };
        sensors.set(key, sensor);
      }
      const mesh = partMesh(part, sensor.material, segments);
      sensor.meshes.push(mesh);
      (stationGroups.get(part.stationId ?? '') ?? machineGroup).add(mesh);
      meshCount += 1;
      continue;
    }
    const mesh = partMesh(part, material(part), segments);
    meshCount += 1;
    const moving = movingByPart.get(part.id);
    if (moving) {
      if (moving.jaw !== undefined) {
        moving.node.jaws[moving.jaw]?.group.add(mesh);
      } else if (moving.node.mover) {
        if (moving.node.axis.kind === 'rotary') {
          const pivot = moving.node.axis.pivot;
          mesh.position.set(part.center[0] - pivot[0], part.center[1] - pivot[1], part.center[2] - pivot[2]);
        }
        moving.node.mover.add(mesh);
      }
      continue;
    }
    if (part.actuatorId && actuators.has(part.actuatorId)) {
      actuators.get(part.actuatorId)?.group.add(mesh);
    } else if (part.stationId && stationGroups.has(part.stationId)) {
      stationGroups.get(part.stationId)?.add(mesh);
    } else {
      machineGroup.add(mesh);
    }
  }

  return { root, scale, stationGroups, actuators, sensors, meshCount };
}

/**
 * 把 MachineMotion 的状态值作用到场景：
 * linear value 0~1（伸出比例）；gripper value 0~1（1 为闭合）；rotary value 为角度（0~rangeDeg）。
 */
export function applyAxisValue(node: ThreeActuatorNode, value: number): void {
  const axis = node.axis;
  if (axis.kind === 'linear' && node.mover) {
    const distance = Math.max(0, Math.min(1, value)) * axis.strokeMm;
    node.mover.position.set(axis.axis[0] * distance, axis.axis[1] * distance, axis.axis[2] * distance);
  } else if (axis.kind === 'gripper') {
    const distance = (Math.max(0, Math.min(1, value)) * axis.strokeMm) / 2;
    for (const jaw of node.jaws) {
      jaw.group.position.set(axis.axis[0] * distance * jaw.sign, axis.axis[1] * distance * jaw.sign, axis.axis[2] * distance * jaw.sign);
    }
  } else if (axis.kind === 'rotary' && node.mover) {
    const angle = THREE.MathUtils.degToRad(Math.max(0, Math.min(axis.rangeDeg || 90, value)));
    node.mover.quaternion.setFromAxisAngle(new THREE.Vector3(axis.axis[0], axis.axis[1], axis.axis[2]).normalize(), angle);
  }
}
