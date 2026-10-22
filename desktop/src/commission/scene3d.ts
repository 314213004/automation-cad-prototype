import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { probeWebGL } from '../cad/webgl.ts';
import { axisPose } from '../cad/kinematics.ts';
import {
  partToAxis,
  type KinematicsAnnotation,
  type MovingPart
} from '../cad/kinematics-ui.ts';
import { type ActuatorConfig, type MachineConfig, validateMachineConfig } from './machine-config.ts';

// 诚实边界：这里的“联动”来自 machine-config.ts 中的点位/执行机构配置。
// STEP 文件只提供几何，没有轴类型、行程、方向或运动学关系，因此本场景不会从 STEP
// 自动识别机构。当前验证的是配置驱动 + 多工位多轴渲染，不是任意 STEP 自动联动。

export interface Commission3DStats {
  frames: number;
  ticks: number;
  /** 基座数 + 执行机构数，传感器不计入部件数。 */
  parts: number;
  stations: number;
  sensors: number;
  actuators: number;
  webgl: boolean;
  enabled: boolean;
  active: boolean;
}

export interface CommissionKinematicsMode {
  mode: 'annotation' | 'config';
  reason: string;
  parts: number;
  sourceFile: string;
}

interface AnnotationVisual {
  part: MovingPart;
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
}

export interface ActuatorMotionSnapshot {
  id: string;
  kind: ActuatorConfig['kind'];
  /** cylinder: 0~1；gripper: 0~1（1 为闭合）；rotary: 0~90 度。 */
  target: number;
  value: number;
  from: number;
  startedAt: number;
  durationMs: number;
}

interface MutableMotion extends ActuatorMotionSnapshot {
  startedFrom: number;
}

interface ActuatorVisual {
  config: ActuatorConfig;
  group: THREE.Group;
  rod?: THREE.Mesh;
  jawLeft?: THREE.Group;
  jawRight?: THREE.Group;
  rotor?: THREE.Group;
  travel: number;
}

interface SensorVisual {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  onColor: THREE.Color;
}

interface HighlightMaterial {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
}

type PointValues = Record<string, boolean | number>;

const BACKGROUND = 0x2a2d31;
const SENSOR_OFF = new THREE.Color(0x5d666e);
const SENSOR_DEFAULT_ON = new THREE.Color(0x2dd4bf);
const FAULT_COLOR = 0xff4d4f;
const STATION_SPACING = 2.9;

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pointIsOn(values: PointValues, point: string | undefined): boolean {
  if (!point) return false;
  return values[point] === true || values[point.toUpperCase()] === true;
}

function standardMaterial(color: number, metalness = 0.35, roughness = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

/**
 * 与 Three.js 解耦的逐轴状态机，便于用假 clock 验证目标值与插值。
 * 气缸未收到伸展/缩回信号时保持当前目标；两者同时为 true 时缩回优先。
 */
export class MachineMotion {
  private readonly config: MachineConfig;
  private readonly clock: () => number;
  private readonly states = new Map<string, MutableMotion>();
  private readonly sensorStates = new Map<string, boolean>();

  constructor(config: MachineConfig, clock: () => number = defaultNow) {
    this.config = config;
    this.clock = clock;
    for (const actuator of config.actuators) {
      this.states.set(actuator.id, {
        id: actuator.id,
        kind: actuator.kind,
        target: 0,
        value: 0,
        from: 0,
        startedFrom: 0,
        startedAt: clock(),
        durationMs: actuator.durationMs ?? 400
      });
    }
    for (const sensor of config.sensors) this.sensorStates.set(sensor.point.toUpperCase(), false);
  }

  update(values: PointValues, now: number = this.clock()): void {
    for (const actuator of this.config.actuators) {
      const state = this.states.get(actuator.id);
      if (!state) continue;
      const nextTarget = this.targetFor(actuator, state.target, values);
      if (nextTarget !== state.target) {
        state.startedFrom = state.value;
        state.from = state.value;
        state.startedAt = now;
        state.target = nextTarget;
      }
    }
    for (const sensor of this.config.sensors) {
      this.sensorStates.set(sensor.point.toUpperCase(), pointIsOn(values, sensor.point));
    }
  }

  advance(now: number = this.clock()): void {
    for (const state of this.states.values()) {
      const elapsed = Math.max(0, now - state.startedAt);
      const ratio = Math.min(1, elapsed / Math.max(1, state.durationMs));
      const eased = ratio * ratio * (3 - 2 * ratio);
      state.value = ratio >= 1 ? state.target : state.startedFrom + (state.target - state.startedFrom) * eased;
    }
  }

  snap(): void {
    for (const state of this.states.values()) state.value = state.target;
  }

  getActuator(id: string): ActuatorMotionSnapshot | undefined {
    const state = this.states.get(id);
    return state ? { ...state } : undefined;
  }

  isSensorOn(point: string): boolean {
    return this.sensorStates.get(point.trim().toUpperCase()) === true;
  }

  private targetFor(actuator: ActuatorConfig, current: number, values: PointValues): number {
    if (actuator.kind === 'cylinder') {
      let target = current;
      if (pointIsOn(values, actuator.extendPoint)) target = 1;
      if (pointIsOn(values, actuator.retractPoint)) target = 0;
      return target;
    }
    if (actuator.kind === 'gripper') return pointIsOn(values, actuator.gripPoint) ? 1 : 0;
    return pointIsOn(values, actuator.point) ? 90 : 0;
  }
}

export class CommissionScene3D {
  private readonly container: HTMLElement;
  private readonly config: MachineConfig;
  private readonly clock: () => number;
  private readonly motion: MachineMotion;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  private readonly controlsRoot = new THREE.Group();
  private renderer: THREE.WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationRunning = false;
  private initialized = false;
  private degraded = false;
  private enabled = true;
  private active = false;
  private latestValues: PointValues = {};
  private frames = 0;
  private ticks = 0;
  private highlightedPoint: string | null = null;
  private highlightedMaterials: HighlightMaterial[] = [];
  private readonly stationGroups = new Map<string, THREE.Group>();
  private readonly actuatorVisuals = new Map<string, ActuatorVisual>();
  private readonly sensorVisuals = new Map<string, SensorVisual>();
  private readonly targets = new Map<string, THREE.Object3D[]>();
  private annotation: KinematicsAnnotation | null = null;
  private annotationVisuals: AnnotationVisual[] = [];
  private annotationGroup: THREE.Group | null = null;
  private annotationScale = 1;
  private kinematics: CommissionKinematicsMode = {
    mode: 'config',
    reason: '尚未加载运动学标注',
    parts: 0,
    sourceFile: ''
  };

  constructor(container: HTMLElement, config: MachineConfig, clock: () => number = defaultNow) {
    this.container = container;
    this.config = validateMachineConfig(config);
    this.clock = clock;
    this.motion = new MachineMotion(this.config, clock);
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.add(this.controlsRoot);
    this.buildLights();
    this.buildModel();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.sync();
  }

  update(values: PointValues): void {
    this.latestValues = { ...values };
    const now = this.clock();
    if (this.enabled) {
      this.ticks += 1;
      this.frames += 1;
    }
    this.motion.update(values, now);
    if (this.degraded || !this.renderer) this.motion.snap();
    else this.motion.advance(now);
    this.paintSensors();
    this.applyTransforms();
  }

  highlight(pointId: string, on: boolean): void {
    const normalized = pointId.trim().toUpperCase();
    if (!on) {
      if (this.highlightedPoint === normalized) this.clearHighlight();
      return;
    }
    this.clearHighlight();
    const targets = this.targets.get(normalized) ?? [];
    for (const target of targets) {
      target.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          this.highlightedMaterials.push({
            material,
            color: material.color.clone(),
            emissive: material.emissive.clone(),
            emissiveIntensity: material.emissiveIntensity
          });
          material.color.setHex(FAULT_COLOR);
          material.emissive.setHex(0x8f1114);
          material.emissiveIntensity = 0.8;
          material.needsUpdate = true;
        }
      });
    }
    this.highlightedPoint = normalized;
  }

  clearHighlight(): void {
    for (const entry of this.highlightedMaterials) {
      entry.material.color.copy(entry.color);
      entry.material.emissive.copy(entry.emissive);
      entry.material.emissiveIntensity = entry.emissiveIntensity;
      entry.material.needsUpdate = true;
    }
    this.highlightedMaterials = [];
    this.highlightedPoint = null;
  }

  /**
   * 标注驱动优先：只要标注完整（网格、行程、点位都有效），就隐藏配置生成的执行机构；
   * 否则保留配置驱动，并通过 kinematicsMode() 暴露黄色提示原因。
   */
  setKinematics(annotation: KinematicsAnnotation | null): void {
    this.annotation = annotation;
    this.kinematics = this.evaluateKinematics(annotation);
    this.rebuildAnnotationVisuals();
    this.applyTransforms();
  }

  kinematicsMode(): CommissionKinematicsMode {
    return { ...this.kinematics };
  }

  stats(): Commission3DStats {
    return {
      frames: this.frames,
      ticks: this.ticks,
      parts: this.stationGroups.size + this.actuatorVisuals.size,
      stations: this.config.stations.length,
      sensors: this.sensorVisuals.size,
      actuators: this.actuatorVisuals.size,
      webgl: Boolean(this.renderer) && !this.degraded,
      enabled: this.enabled,
      active: this.active
    };
  }

  motionState(actuatorId: string): ActuatorMotionSnapshot | undefined {
    return this.motion.getActuator(actuatorId);
  }

  sensorOn(point: string): boolean {
    return this.motion.isSensorOn(point);
  }

  dispose(): void {
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) this.container.removeChild(this.renderer.domElement);
    this.renderer = null;
  }

  private evaluateKinematics(annotation: KinematicsAnnotation | null): CommissionKinematicsMode {
    if (!annotation || annotation.parts.length === 0) {
      return { mode: 'config', reason: '尚未加载运动学标注', parts: 0, sourceFile: '' };
    }
    const points = new Set<string>();
    for (const actuator of this.config.actuators) {
      for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
        if (point) points.add(point.trim().toUpperCase());
      }
    }
    for (const part of annotation.parts) {
      if (part.meshIds.length === 0) {
        return { mode: 'config', reason: `动件「${part.name}」未关联网格`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (part.kind === 'linear' && !(part.travelMm > 0)) {
        return { mode: 'config', reason: `动件「${part.name}」行程为 0`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (part.kind === 'rotary' && part.rangeDeg === 0) {
        return { mode: 'config', reason: `动件「${part.name}」角度为 0`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (!part.point.trim()) {
        return { mode: 'config', reason: `动件「${part.name}」未绑定点位`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (!points.has(part.point.trim().toUpperCase())) {
        return { mode: 'config', reason: `动件「${part.name}」点位不在机型配置中`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
    }
    return {
      mode: 'annotation',
      reason: '',
      parts: annotation.parts.length,
      sourceFile: annotation.sourceFile
    };
  }

  private rebuildAnnotationVisuals(): void {
    if (this.annotationGroup) {
      this.controlsRoot.remove(this.annotationGroup);
      this.annotationGroup.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) material.dispose();
        }
      });
      this.annotationGroup = null;
    }
    this.annotationVisuals = [];
    for (const visual of this.actuatorVisuals.values()) visual.group.visible = this.kinematics.mode === 'config';
    if (!this.annotation || this.kinematics.mode !== 'annotation') {
      this.scene.updateMatrixWorld(true);
      return;
    }
    const group = new THREE.Group();
    group.name = 'kinematics-annotation';
    const parts = this.annotation.parts;
    const overall = new THREE.Box3();
    for (const part of parts) {
      const center = new THREE.Vector3(part.center[0], part.center[1], part.center[2]);
      const half = new THREE.Vector3(Math.max(part.size[0], 0.1), Math.max(part.size[1], 0.1), Math.max(part.size[2], 0.1)).multiplyScalar(0.5);
      overall.expandByPoint(center.clone().sub(half));
      overall.expandByPoint(center.clone().add(half));
    }
    const origin = overall.getCenter(new THREE.Vector3());
    const span = overall.getSize(new THREE.Vector3());
    this.annotationScale = 3.6 / Math.max(span.x, span.y, span.z, 1);
    const colors = [0x2dd4bf, 0x60a5fa, 0xf59e0b, 0xa78bfa, 0xf472b6, 0x84cc16];
    parts.forEach((part, index) => {
      const size = new THREE.Vector3(Math.max(part.size[0], 0.1), Math.max(part.size[1], 0.1), Math.max(part.size[2], 0.1)).multiplyScalar(this.annotationScale);
      const material = new THREE.MeshStandardMaterial({
        color: colors[index % colors.length] ?? 0x2dd4bf,
        metalness: 0.12,
        roughness: 0.52
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
      const basePosition = new THREE.Vector3(
        (part.center[0] - origin.x) * this.annotationScale,
        0.65 + (part.center[2] - origin.z) * this.annotationScale,
        -(part.center[1] - origin.y) * this.annotationScale
      );
      mesh.position.copy(basePosition);
      group.add(mesh);
      this.annotationVisuals.push({ part, mesh, basePosition });
    });
    this.controlsRoot.add(group);
    this.annotationGroup = group;
    this.applyAnnotationTransforms();
  }

  private applyAnnotationTransforms(): void {
    for (const visual of this.annotationVisuals) {
      const part = visual.part;
      const axis = partToAxis(part);
      const point = part.point.trim();
      const pose = axisPose(axis, point ? { [point]: true } : {});
      const offset = new THREE.Vector3(
        pose.offset[0] * this.annotationScale,
        pose.offset[2] * this.annotationScale,
        -pose.offset[1] * this.annotationScale
      );
      const sign = (part.rangeDeg < 0 ? -1 : 1) * (part.direction === -1 ? -1 : 1);
      const rotationRad = part.kind === 'rotary' ? pose.rotationRad * sign : 0;
      const axisVector =
        part.axis === 'x' ? new THREE.Vector3(1, 0, 0) : part.axis === 'y' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      visual.mesh.quaternion.setFromAxisAngle(axisVector, rotationRad);
      visual.mesh.position.copy(visual.basePosition).add(offset);
    }
  }

  private sync(): void {
    const shouldRun = this.enabled && this.active;
    if (shouldRun && !this.initialized) this.initialize();
    if (shouldRun && this.renderer) {
      this.renderer.domElement.style.display = 'block';
      this.resize();
      this.update(this.latestValues);
      if (!this.animationRunning) {
        this.animationRunning = true;
        this.renderer.setAnimationLoop(this.animate);
      }
    } else {
      this.stopAnimation();
    }
  }

  private initialize(): void {
    this.initialized = true;
    const capability = probeWebGL(() => document.createElement('canvas'));
    if (!capability.ok) {
      this.enterDegradedMode(capability.reason ?? 'WebGL 不可用');
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (error) {
      this.enterDegradedMode(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'commission-3d-canvas';
    renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(renderer.domElement);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 3;
    controls.maxDistance = 32;
    controls.target.set(0, 0.65, 0);
    controls.update();
    this.controls = controls;

    this.camera.position.set(7.4, 6.2, 7.4);
    this.camera.lookAt(0, 0.65, 0);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    this.resize();
  }

  private enterDegradedMode(reason: string): void {
    this.degraded = true;
    this.initialized = true;
    this.stopAnimation();
    this.container.innerHTML = '';
    const fallback = document.createElement('div');
    fallback.className = 'commission-3d-fallback';
    fallback.dataset.reason = reason;
    fallback.innerHTML = '<strong>当前环境不支持 WebGL</strong><span>3D 联动已停用，联调与故障诊断仍可正常使用。</span>';
    this.container.appendChild(fallback);
  }

  private stopAnimation(): void {
    if (!this.animationRunning) return;
    this.animationRunning = false;
    this.renderer?.setAnimationLoop(null);
    if (this.renderer) this.renderer.domElement.style.display = 'none';
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(1, Math.floor(this.container.clientWidth));
    const height = Math.max(1, Math.floor(this.container.clientHeight || 240));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private readonly animate = (time: number): void => {
    if (!this.renderer || !this.enabled || !this.active) return;
    this.motion.advance(time);
    this.applyTransforms();
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.ticks += 1;
    this.frames += 1;
  };

  private applyTransforms(): void {
    if (this.kinematics.mode === 'annotation') {
      this.applyAnnotationTransforms();
      return;
    }
    for (const visual of this.actuatorVisuals.values()) {
      const state = this.motion.getActuator(visual.config.id);
      if (!state) continue;
      if (visual.config.kind === 'cylinder' && visual.rod) {
        visual.rod.position.x = 0.18 + state.value * visual.travel;
      } else if (visual.config.kind === 'gripper') {
        const opening = 0.14 + (1 - state.value) * 0.14;
        if (visual.jawLeft) visual.jawLeft.position.z = opening;
        if (visual.jawRight) visual.jawRight.position.z = -opening;
      } else if (visual.config.kind === 'rotary' && visual.rotor) {
        visual.rotor.rotation.y = THREE.MathUtils.degToRad(state.value);
      }
    }
  }

  private paintSensors(): void {
    for (const sensor of this.config.sensors) {
      const key = sensor.point.toUpperCase();
      if (this.highlightedPoint === key) continue;
      const visual = this.sensorVisuals.get(key);
      if (!visual) continue;
      const on = this.motion.isSensorOn(sensor.point);
      visual.material.color.copy(on ? visual.onColor : SENSOR_OFF);
      visual.material.emissive.copy(on ? visual.onColor : new THREE.Color(0x000000));
      visual.material.emissiveIntensity = on ? 1.15 : 0.05;
    }
  }

  private addTarget(key: string, objects: THREE.Object3D[]): void {
    this.targets.set(key, objects);
    this.targets.set(key.toUpperCase(), objects);
  }

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(4.5, 7, 5.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ab5c7, 0.8);
    fill.position.set(-5, 3, -4);
    this.scene.add(fill);
  }

  private buildModel(): void {
    const stationCount = this.config.stations.length;
    const columns = Math.max(1, Math.ceil(Math.sqrt(stationCount)));
    const rows = Math.ceil(stationCount / columns);
    const originX = -((columns - 1) * STATION_SPACING) / 2;
    const originZ = -((rows - 1) * STATION_SPACING) / 2;

    const grid = new THREE.GridHelper(Math.max(9, columns * STATION_SPACING + 2), 32, 0x5d6770, 0x3a4047);
    grid.position.y = -0.54;
    this.controlsRoot.add(grid);

    for (const [index, station] of this.config.stations.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const group = new THREE.Group();
      group.position.set(originX + column * STATION_SPACING, 0, originZ + row * STATION_SPACING);
      this.controlsRoot.add(group);

      const base = new THREE.Mesh(new THREE.BoxGeometry(2.55, 0.45, 2.55), standardMaterial(0x5c646b, 0.25, 0.72));
      base.position.y = -0.24;
      group.add(base);
      this.stationGroups.set(station, group);
      this.addTarget(station, [base]);
    }

    const actuatorSlots = new Map<string, number>();
    for (const actuator of this.config.actuators) {
      const stationGroup = this.stationGroups.get(actuator.station);
      if (!stationGroup) continue;
      const slot = actuatorSlots.get(actuator.station) ?? 0;
      actuatorSlots.set(actuator.station, slot + 1);
      const group = new THREE.Group();
      group.position.set(...(actuator.position ?? this.defaultActuatorPosition(slot)));
      stationGroup.add(group);
      const visual = this.buildActuator(actuator, group);
      this.actuatorVisuals.set(actuator.id, visual);
      this.addTarget(actuator.id, [group]);
      for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
        if (point) this.addTarget(point, [group]);
      }
    }

    const sensorSlots = new Map<string, number>();
    for (const sensor of this.config.sensors) {
      const stationGroup = this.stationGroups.get(sensor.station);
      if (!stationGroup) continue;
      const slot = sensorSlots.get(sensor.station) ?? 0;
      sensorSlots.set(sensor.station, slot + 1);
      const material = new THREE.MeshStandardMaterial({
        color: SENSOR_OFF,
        emissive: 0x000000,
        emissiveIntensity: 0.05,
        metalness: 0.1,
        roughness: 0.35
      });
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 12), material);
      sphere.position.set(-0.78 + slot * 0.52, 0.16, 1.04);
      sphere.userData.pointId = sensor.point;
      stationGroup.add(sphere);
      const key = sensor.point.toUpperCase();
      this.sensorVisuals.set(key, {
        mesh: sphere,
        material,
        onColor: new THREE.Color(sensor.color ?? SENSOR_DEFAULT_ON)
      });
      const partTargets = this.targets.get(sensor.part) ?? this.targets.get(sensor.part.toUpperCase()) ?? [];
      this.addTarget(sensor.point, [sphere, ...partTargets]);
    }

    this.paintSensors();
    this.applyTransforms();
  }

  private defaultActuatorPosition(slot: number): [number, number, number] {
    const positions: [number, number, number][] = [
      [-0.72, 0.55, -0.38],
      [0.05, 0.55, -0.38],
      [0.76, 0.65, 0.35]
    ];
    return positions[slot] ?? [0, 0.55, 0];
  }

  private buildActuator(config: ActuatorConfig, group: THREE.Group): ActuatorVisual {
    if (config.kind === 'cylinder') return this.buildCylinder(config, group);
    if (config.kind === 'gripper') return this.buildGripper(config, group);
    return this.buildRotary(config, group);
  }

  private buildCylinder(config: ActuatorConfig, group: THREE.Group): ActuatorVisual {
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.18, 0.34), standardMaterial(0x4f5961, 0.4, 0.5));
    mount.position.y = -0.13;
    group.add(mount);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.58, 24), standardMaterial(0x9aa7b2, 0.55, 0.32));
    body.rotation.z = Math.PI / 2;
    body.position.x = -0.2;
    group.add(body);

    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.7, 18), standardMaterial(0xc7d0d7, 0.8, 0.22));
    rod.rotation.z = Math.PI / 2;
    rod.position.x = 0.18;
    group.add(rod);

    return {
      config,
      group,
      rod,
      travel: ((config.travelMm ?? 40) / 40) * 0.34
    };
  }

  private buildGripper(config: ActuatorConfig, group: THREE.Group): ActuatorVisual {
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 0.42), standardMaterial(0x68747e, 0.45, 0.45));
    mount.position.y = -0.08;
    group.add(mount);

    const jawGeometry = new THREE.BoxGeometry(0.24, 0.42, 0.09);
    const jawMaterial = standardMaterial(0x23b7a5, 0.35, 0.38);
    const jawLeft = new THREE.Group();
    jawLeft.position.set(0.16, 0.13, 0.14);
    jawLeft.add(new THREE.Mesh(jawGeometry, jawMaterial.clone()));
    group.add(jawLeft);

    const jawRight = new THREE.Group();
    jawRight.position.set(0.16, 0.13, -0.14);
    jawRight.add(new THREE.Mesh(jawGeometry, jawMaterial.clone()));
    group.add(jawRight);

    return { config, group, jawLeft, jawRight, travel: 0 };
  }

  private buildRotary(config: ActuatorConfig, group: THREE.Group): ActuatorVisual {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.16, 24), standardMaterial(0x59636b, 0.5, 0.42));
    base.position.y = -0.14;
    group.add(base);

    const rotor = new THREE.Group();
    rotor.position.y = 0.04;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 20), standardMaterial(0xb2bec7, 0.65, 0.28));
    rotor.add(hub);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.16), standardMaterial(0xf59e0b, 0.4, 0.4));
    arm.position.set(0.3, 0.16, 0);
    rotor.add(arm);
    group.add(rotor);

    return { config, group, rotor, travel: 0 };
  }
}

export function createScene3D(container: HTMLElement, config: MachineConfig, clock?: () => number): CommissionScene3D {
  return new CommissionScene3D(container, config, clock);
}
