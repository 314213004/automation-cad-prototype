import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { probeWebGL } from '../cad/webgl';

export interface Commission3DStats {
  frames: number;
  ticks: number;
  parts: number;
  webgl: boolean;
  enabled: boolean;
  active: boolean;
}

interface HighlightMaterial {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
}

const PART_COUNT = 5;
const BACKGROUND = 0x2a2d31;
const SENSOR_ON = 0x2dd4bf;
const SENSOR_OFF = 0x5d666e;
const FAULT_COLOR = 0xff4d4f;

function standardMaterial(color: number, metalness = 0.35, roughness = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

export class CommissionScene3D {
  private readonly container: HTMLElement;
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
  private latestValues: Record<string, boolean | number> = {};
  private frames = 0;
  private ticks = 0;
  private targetPosition = 0;
  private position = 0;
  private positionFrom = 0;
  private positionStartedAt = 0;
  private jawAngle = 0;
  private jawFrom = 0;
  private jawTarget = 0;
  private jawStartedAt = 0;
  private highlightedPoint: string | null = null;
  private highlightedMaterials: HighlightMaterial[] = [];

  private rod: THREE.Mesh | null = null;
  private slide: THREE.Mesh | null = null;
  private cylinder: THREE.Mesh | null = null;
  private gripper: THREE.Group | null = null;
  private jawLeft: THREE.Group | null = null;
  private jawRight: THREE.Group | null = null;
  private readonly sensors = new Map<string, THREE.Mesh>();
  private readonly targets = new Map<string, THREE.Object3D[]>();

  constructor(container: HTMLElement) {
    this.container = container;
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

  update(values: Record<string, boolean | number>): void {
    this.latestValues = { ...values };
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.enabled) {
      this.ticks += 1;
      this.frames += 1;
    }

    const extend = values.Y0 === true;
    const retract = values.Y1 === true;
    const nextPosition = retract ? 0 : extend ? 1 : this.targetPosition;
    if (nextPosition !== this.targetPosition) {
      this.positionFrom = this.position;
      this.positionStartedAt = now;
      this.targetPosition = nextPosition;
    }

    const nextJaw = values.Y2 === true ? 25 : 0;
    if (nextJaw !== this.jawTarget) {
      this.jawFrom = this.jawAngle;
      this.jawStartedAt = now;
      this.jawTarget = nextJaw;
    }

    for (let index = 0; index < 4; index += 1) {
      this.paintSensor(`X${index}`, values[`X${index}`] === true);
    }

    if (this.degraded || !this.renderer) {
      this.position = this.targetPosition;
      this.jawAngle = this.jawTarget;
      this.applyTransforms();
      return;
    }
    this.advance(now);
  }

  highlight(pointId: string, on: boolean): void {
    if (!on) {
      if (this.highlightedPoint === pointId) this.clearHighlight();
      return;
    }
    this.clearHighlight();
    const normalized = pointId.trim().toUpperCase();
    const targets = this.targets.get(normalized) ?? this.targets.get('BASE') ?? [];
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

  stats(): Commission3DStats {
    return {
      frames: this.frames,
      ticks: this.ticks,
      parts: PART_COUNT,
      webgl: Boolean(this.renderer) && !this.degraded,
      enabled: this.enabled,
      active: this.active
    };
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
    controls.minDistance = 4;
    controls.maxDistance = 24;
    controls.target.set(0.7, 0.75, 0);
    controls.update();
    this.controls = controls;

    this.camera.position.set(7.2, 4.8, 7.8);
    this.camera.lookAt(0.7, 0.75, 0);
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
    this.advance(time);
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.ticks += 1;
    this.frames += 1;
  };

  private advance(now: number): void {
    const positionElapsed = Math.max(0, now - this.positionStartedAt);
    const positionT = Math.min(1, positionElapsed / 400);
    const eased = positionT < 0.5 ? 2 * positionT * positionT : 1 - ((-2 * positionT + 2) ** 2) / 2;
    this.position = this.positionFrom + (this.targetPosition - this.positionFrom) * eased;
    if (positionT >= 1) this.position = this.targetPosition;

    const jawElapsed = Math.max(0, now - this.jawStartedAt);
    const jawT = Math.min(1, jawElapsed / 220);
    this.jawAngle = this.jawFrom + (this.jawTarget - this.jawFrom) * jawT;
    if (jawT >= 1) this.jawAngle = this.jawTarget;
    this.applyTransforms();
  }

  private applyTransforms(): void {
    const travel = 0.9;
    if (this.rod) this.rod.position.x = 1.1 + this.position * travel;
    if (this.slide) this.slide.position.x = 2.55 + this.position * travel;
    if (this.gripper) this.gripper.position.x = 3.25 + this.position * travel;
    const radians = THREE.MathUtils.degToRad(this.jawAngle);
    if (this.jawLeft) this.jawLeft.rotation.x = radians;
    if (this.jawRight) this.jawRight.rotation.x = -radians;
  }

  private paintSensor(id: string, on: boolean): void {
    if (this.highlightedPoint === id) return;
    const sensor = this.sensors.get(id);
    if (!sensor) return;
    const material = sensor.material as THREE.MeshStandardMaterial;
    material.color.setHex(on ? SENSOR_ON : SENSOR_OFF);
    material.emissive.setHex(on ? SENSOR_ON : 0x000000);
    material.emissiveIntensity = on ? 1.15 : 0.05;
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
    const base = new THREE.Mesh(new THREE.BoxGeometry(7, 0.6, 3.4), standardMaterial(0x5c646b, 0.25, 0.72));
    base.position.set(0, -0.3, 0);
    this.controlsRoot.add(base);
    this.targets.set('BASE', [base]);

    const grid = new THREE.GridHelper(12, 24, 0x5d6770, 0x3a4047);
    grid.position.y = -0.61;
    this.controlsRoot.add(grid);

    const slide = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.55, 1.55), standardMaterial(0x7d8b96, 0.45, 0.42));
    slide.position.set(2.55, 0.28, 0);
    this.slide = slide;
    this.controlsRoot.add(slide);

    const cylinder = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.48, 2.6, 36),
      standardMaterial(0x9aa7b2, 0.55, 0.32)
    );
    cylinder.rotation.z = Math.PI / 2;
    cylinder.position.set(-0.8, 0.72, 0);
    this.cylinder = cylinder;
    this.controlsRoot.add(cylinder);

    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.15, 1.8, 28),
      standardMaterial(0xc7d0d7, 0.8, 0.22)
    );
    rod.rotation.z = Math.PI / 2;
    rod.position.set(1.1, 0.72, 0);
    this.rod = rod;
    this.controlsRoot.add(rod);

    const gripper = new THREE.Group();
    gripper.position.set(3.25, 0.72, 0);
    this.gripper = gripper;
    this.controlsRoot.add(gripper);

    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.7, 0.9), standardMaterial(0x68747e, 0.45, 0.45));
    gripper.add(mount);

    const jawGeometry = new THREE.BoxGeometry(0.55, 0.68, 0.12);
    const jawMaterial = standardMaterial(0x23b7a5, 0.35, 0.38);
    const jawLeft = new THREE.Group();
    jawLeft.position.set(0.16, 0.3, 0.34);
    const leftMesh = new THREE.Mesh(jawGeometry, jawMaterial.clone());
    leftMesh.position.y = -0.3;
    jawLeft.add(leftMesh);
    jawLeft.rotation.x = 0;
    gripper.add(jawLeft);
    this.jawLeft = jawLeft;

    const jawRight = new THREE.Group();
    jawRight.position.set(0.16, 0.3, -0.34);
    const rightMesh = new THREE.Mesh(jawGeometry, jawMaterial.clone());
    rightMesh.position.y = -0.3;
    jawRight.add(rightMesh);
    jawRight.rotation.x = -0;
    gripper.add(jawRight);
    this.jawRight = jawRight;

    for (let index = 0; index < 4; index += 1) {
      const sensor = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 20, 14),
        new THREE.MeshStandardMaterial({ color: SENSOR_OFF, emissive: 0x000000, emissiveIntensity: 0.05, metalness: 0.1, roughness: 0.35 })
      );
      sensor.position.set(-2.35 + index * 1.05, 0.23, 1.48);
      sensor.userData.pointId = `X${index}`;
      this.sensors.set(`X${index}`, sensor);
      this.targets.set(`X${index}`, [sensor]);
      this.controlsRoot.add(sensor);
    }

    this.targets.set('ROD', [rod]);
    this.targets.set('SLIDE', [slide]);
    this.targets.set('CYLINDER', [cylinder]);
    this.targets.set('GRIPPER', [gripper]);
    const outputs: Record<string, string[]> = {
      Y0: ['ROD'],
      Y1: ['ROD'],
      Y2: ['GRIPPER'],
      Y3: ['CYLINDER'],
      Y4: ['SLIDE'],
      Y5: ['BASE'],
      Y6: ['SLIDE'],
      Y7: ['SLIDE'],
      Y8: ['BASE'],
      X4: ['SLIDE'],
      X5: ['SLIDE'],
      X6: ['SLIDE'],
      X7: ['SLIDE'],
      X8: ['BASE'],
      X9: ['BASE'],
      X10: ['BASE'],
      X11: ['CYLINDER'],
      X14: ['BASE']
    };
    for (const [point, names] of Object.entries(outputs)) {
      const objects = names.flatMap((name) => this.targets.get(name) ?? []);
      if (objects.length > 0) this.targets.set(point, objects);
    }
    this.applyTransforms();
  }
}
