/**
 * 皮带输送机 → 参数化装配文档（喂给 build123d sidecar 出真实实体）。
 *
 * 这里**不画代理体**：每个零件都是一段合法的参数化特征（box / cylinder / holes），
 * 由软件里的建模内核（spike/build123d/app.py）布尔求和成 B-rep，导出 STEP/STL，
 * 并把每个实例的体积回传用于质量与 BOM。
 *
 * 坐标系与内核一致：Z 向上、单位 mm；X 为输送方向（物料从左往右）；
 * 原点在机架地面中心，皮带面高度默认 850。
 */

import type { AssemblyDoc, FeatureNode, InstanceTransform, PartInstance } from '../parametric/features.ts';

export type ConveyorMaterial = 'AL6063' | 'Q235' | 'PVC' | 'STEEL45';

/** kg/m³ */
export const MATERIAL_DENSITY: Record<ConveyorMaterial, number> = {
  AL6063: 2700,
  Q235: 7850,
  PVC: 1400,
  STEEL45: 7850
};

export const MATERIAL_LABEL: Record<ConveyorMaterial, string> = {
  AL6063: '铝型材 6063-T5',
  Q235: 'Q235 钢板',
  PVC: 'PVC 皮带',
  STEEL45: '45# 钢'
};

export interface ConveyorParams {
  /** 线体总长（两滚筒中心距 + 端部余量），mm */
  lengthMm: number;
  /** 皮带有效宽度，mm */
  widthMm: number;
  /** 皮带面高度，mm（地面到皮带上面） */
  beltHeightMm: number;
  /** 滚筒直径，mm */
  pulleyDiameterMm: number;
  /** 皮带厚度，mm */
  beltThicknessMm: number;
  /** 型材截面，mm（40 表示 4040） */
  frameSectionMm: number;
  /**
   * 缓存层数（1 = 普通输送线；≥2 = 立体缓存：底层输送 + 上方多层托架 + 升降机构）。
   * 层高由 layerPitchMm 决定，层位从皮带面往上排。省略即单层。
   */
  layers?: number;
  /** 层间距，mm（layers ≥ 2 时才有意义） */
  layerPitchMm?: number;
}

/** 归一化之后的参数：层数一定存在，内部构建器只用这个类型。 */
export type ResolvedConveyorParams = ConveyorParams & { layers: number; layerPitchMm: number };

export const DEFAULT_CONVEYOR: Required<ConveyorParams> = {
  lengthMm: 2000,
  widthMm: 300,
  beltHeightMm: 850,
  pulleyDiameterMm: 50,
  beltThicknessMm: 4,
  frameSectionMm: 40,
  layers: 1,
  layerPitchMm: 400
};

export interface ConveyorPart {
  id: string;
  name: string;
  material: ConveyorMaterial;
  /** 特征树（交给内核逐条执行，布尔求和） */
  features: FeatureNode[];
  transform: InstanceTransform;
  /** 只用于 BOM 分组的规格文字 */
  spec: string;
  /**
   * BOM 质量覆盖（kg/件）。代理实体是实心的，对电机、滚筒这类空心件会显著偏重，
   * 这里用样本值覆盖，几何仍然由内核真实生成。
   */
  massOverrideKg?: number;
}

function feature(id: string, type: FeatureNode['type'], name: string, params: Record<string, unknown>): FeatureNode {
  return { id, type, name, params };
}

function box(id: string, name: string, length: number, width: number, height: number): FeatureNode {
  return feature(id, 'box', name, { length, width, height });
}

function cylinder(id: string, name: string, diameter: number, height: number, axis: 'x' | 'y' | 'z', at: [number, number, number] = [0, 0, 0]): FeatureNode {
  return feature(id, 'cylinder', name, { diameter, height, axis, at });
}

/**
 * 生成整机零件表。几何关系：
 * - 滚筒中心 z = 皮带面高 - 滚筒半径
 * - 侧梁中心 z = 滚筒中心 z - (frameSection/2 + 10)  ← 留出皮带绕包空间
 * - 支腿从地面顶到侧梁下沿
 */
export function buildConveyorParts(params: ConveyorParams): ConveyorPart[] {
  const p = normalizeParams(params);
  const parts = buildSingleLayerParts(p);
  // 立体缓存：底层还是输送线（进出料），上方按层数叠托架 + 一套升降机构
  return p.layers > 1 ? [...parts, ...buildBufferStackParts(p)] : parts;
}

function buildSingleLayerParts(p: ResolvedConveyorParams): ConveyorPart[] {
  const halfL = p.lengthMm / 2;
  const halfW = p.widthMm / 2;
  const section = p.frameSectionMm;
  const pulleyRadius = p.pulleyDiameterMm / 2;
  const pulleyZ = p.beltHeightMm - pulleyRadius;
  const railZ = pulleyZ - pulleyRadius - section / 2;
  const legHeight = railZ - section / 2;
  const legCenterZ = legHeight / 2;
  const outerY = halfW + section / 2 + 15;
  const parts: ConveyorPart[] = [];

  // 1) 两侧纵梁（4040 型材）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `rail-${label}`,
      name: `侧纵梁（${label === 'left' ? '操作侧' : '驱动侧'}）`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.lengthMm)}`,
      features: [box(`rail-${label}-body`, '型材', p.lengthMm, section, section)],
      transform: { x: 0, y: sign * outerY, z: railZ, rz: 0 }
    });
  }

  // 2) 横撑（跨接两侧梁）
  // 首尾横撑必须让开端板：端板占 x ∈ ±[halfL-8, halfL]，横撑半宽 section/2，
  // 过去直接排到 ±halfL，端板与横撑实打实撞在一起（干涉检查 153600 mm³）。
  const crossCount = Math.max(3, Math.round(p.lengthMm / 500) + 1);
  // 还要躲开尾部张紧滑座（|x| ∈ [halfL-110, halfL-40]），否则横撑 1 顶住滑座
  const crossInset = Math.max(section + 8, 130);
  const returnBeltBottom = pulleyZ - pulleyRadius - p.beltThicknessMm;
  const crossZ = returnBeltBottom - 4 - section / 2;
  const crossSpan = Math.max(0, p.lengthMm - crossInset * 2);
  for (let i = 0; i < crossCount; i += 1) {
    const x = -halfL + crossInset + (crossSpan * i) / (crossCount - 1);
    parts.push({
      id: `cross-${i + 1}`,
      name: `横撑 ${i + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.widthMm + section * 2)}`,
      features: [box(`cross-${i + 1}-body`, '型材', section, p.widthMm + section * 2, section)],
      // 横撑要躲开回程皮带：回程带下沿在 pulleyZ - pulleyRadius - t，
      // 过去横撑放在 railZ（与皮带同一高度），实打实穿带（干涉 64000 mm³）
      transform: { x: round(x), y: 0, z: crossZ, rz: 0 }
    });
  }

  // 3) 头尾端板（装滚筒轴承座）
  for (const [label, sign] of [['head', 1], ['tail', -1]] as const) {
    parts.push({
      id: `endplate-${label}`,
      name: `${label === 'head' ? '头部' : '尾部'}端板`,
      material: 'Q235',
      spec: `8 mm × ${Math.round(p.widthMm + section * 2)} × ${Math.round(section * 3)}`,
      features: [
        box(`endplate-${label}-body`, '钢板', 8, p.widthMm + section * 2, section * 3),
        feature(`endplate-${label}-holes`, 'holes', '轴承座螺栓孔', {
          // 板厚沿 X（8 mm），宽度沿 Y；孔必须落在板的 Y 向范围内
          diameter: 9,
          positions: [
            [0, -halfW - 10],
            [0, halfW + 10]
          ]
        })
      ],
      transform: { x: sign * (halfL - 4), y: 0, z: railZ, rz: 0 }
    });
  }

  // 4) 支腿 + 地脚
  const legPositions: Array<[number, number]> = [
    [-halfL + 120, -outerY],
    [-halfL + 120, outerY],
    [halfL - 120, -outerY],
    [halfL - 120, outerY]
  ];
  legPositions.forEach(([x, y], index) => {
    parts.push({
      id: `leg-${index + 1}`,
      name: `支腿 ${index + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(legHeight)}`,
      features: [box(`leg-${index + 1}-body`, '型材', section, section, legHeight)],
      transform: { x: round(x), y, z: legCenterZ, rz: 0 }
    });
    parts.push({
      id: `foot-${index + 1}`,
      name: `可调地脚 ${index + 1}`,
      material: 'Q235',
      spec: `80×80×8 + 2×M10`,
      features: [
        box(`foot-${index + 1}-plate`, '底板', 80, 80, 8),
        feature(`foot-${index + 1}-holes`, 'holes', '地脚螺栓孔', {
          diameter: 11,
          positions: [
            [-25, -25],
            [25, 25]
          ]
        })
      ],
      transform: { x: round(x), y, z: 4, rz: 0 }
    });
  });

  // 5) 主动 / 从动滚筒（横轴圆柱，直径 × 面宽）
  for (const [label, sign] of [['drive', 1], ['tail', -1]] as const) {
    parts.push({
      id: `pulley-${label}`,
      name: `${label === 'drive' ? '主动' : '从动'}滚筒`,
      material: 'STEEL45',
      spec: `φ${p.pulleyDiameterMm} × ${Math.round(p.widthMm + 40)}`,
      features: [
        cylinder(`pulley-${label}-body`, '滚筒筒体', p.pulleyDiameterMm, p.widthMm + 40, 'y'),
        // 轴头：两侧各伸 30
        cylinder(`pulley-${label}-shaft`, '轴头', 20, p.widthMm + 100, 'y')
      ],
      // 真实滚筒是空心筒体 + 轴，实心代理体会重一倍以上，按样本质量给
      massOverrideKg: 3.2,
      // 筒体必须让开端板：端板占 x ∈ ±[halfL-8, halfL]，滚筒半径 25，
      // 放在 ±halfL 时筒体整段穿过端板（干涉 47985 mm³）
      transform: { x: sign * (halfL - 10 - pulleyRadius), y: 0, z: pulleyZ, rz: 0 }
    });
  }

  // 6) 皮带：上行程 + 回程 + 两侧挡边
  parts.push({
    id: 'belt-top',
    name: '皮带上行程',
    material: 'PVC',
    spec: `${Math.round(p.lengthMm - 40)} × ${Math.round(p.widthMm)} × ${p.beltThicknessMm}`,
    features: [box('belt-top-body', '皮带', p.lengthMm - 40, p.widthMm, p.beltThicknessMm)],
    transform: { x: 0, y: 0, z: p.beltHeightMm - p.beltThicknessMm / 2, rz: 0 }
  });
  parts.push({
    id: 'belt-return',
    name: '皮带回程',
    material: 'PVC',
    spec: `${Math.round(p.lengthMm - 40)} × ${Math.round(p.widthMm)} × ${p.beltThicknessMm}`,
    features: [box('belt-return-body', '皮带', p.lengthMm - 40, p.widthMm, p.beltThicknessMm)],
    transform: { x: 0, y: 0, z: pulleyZ - pulleyRadius - p.beltThicknessMm / 2, rz: 0 }
  });
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `guard-${label}`,
      name: `侧挡边（${label === 'left' ? '左' : '右'}）`,
      material: 'Q235',
      spec: `3 × 60 × ${Math.round(p.lengthMm)}`,
      features: [box(`guard-${label}-body`, '挡边', p.lengthMm - 60, 3, 60)],
      transform: { x: 0, y: sign * (halfW + 3), z: p.beltHeightMm + 26, rz: 0 }
    });
  }

  // 7) 减速电机（驱动侧端部，含输出轴）
  parts.push({
    id: 'gearmotor',
    name: '减速电机',
    material: 'Q235',
    spec: '40 W · i=18 · 输出 76 rpm',
    massOverrideKg: 2.8,
    features: [
      box('gearmotor-body', '电机+减速箱', 160, 120, 140),
      cylinder('gearmotor-shaft', '输出轴', 25, 80, 'y', [0, -60, 0])
    ],
    // 电机箱外挂在纵梁外侧：过去中心只在纵梁外 60、箱体深 120，
    // 有一半压进纵梁（干涉 128000 mm³），现在留 5 mm 安装面间隙
    transform: { x: halfL - 120, y: -(outerY + section / 2 + 65), z: pulleyZ, rz: 0 }
  });

  // 8) 尾部张紧滑座 + 螺杆（两侧各一套）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `tension-${label}`,
      name: `张紧滑座（${label === 'left' ? '左' : '右'}）`,
      material: 'Q235',
      spec: '70×50×50 + M10 螺杆，行程 ±30',
      features: [
        box(`tension-${label}-body`, '滑座', 70, 50, 50),
        feature(`tension-${label}-slot`, 'slot', '滑动长槽', { length: 60, width: 12 }),
        cylinder(`tension-${label}-screw`, 'M10 调节螺杆', 10, 90, 'x')
      ],
      transform: { x: -halfL + 60, y: sign * outerY, z: railZ, rz: 0 }
    });
  }

  // 9) 进出料光电（支架 + M12 传感器本体）
  for (const [label, sign, y] of [['inlet', -1, -outerY], ['outlet', 1, outerY]] as const) {
    parts.push({
      id: `sensor-${label}`,
      name: `${label === 'inlet' ? '进料' : '出料'}光电支架`,
      material: 'Q235',
      spec: '40×30×80 + M12 漫反射光电',
      massOverrideKg: 0.8,
      features: [
        box(`sensor-${label}-bracket`, '支架', 40, 30, 80),
        cylinder(`sensor-${label}-body`, 'M12 光电', 12, 40, 'y')
      ],
      transform: { x: sign * (halfL - 160), y, z: p.beltHeightMm + 40, rz: 0 }
    });
  }

  return parts;
}

/**
 * 立体缓存叠加层（layers ≥ 2）：4 根缓存立柱 + 每层托条/托板/传动辊/挡停 + 一套升降机构。
 *
 * 为什么单独一段而不是把单层线体按层复制：缓存机型的进出料仍然只有底层一条输送线，
 * 上方各层是储位（托条 + 托板），靠一套升降台在层间搬运。复制线体会把皮带、滚筒、
 * 电机按层数翻倍，既不真实也会让 BOM 里出现 3 条皮带的荒唐行。
 */
function buildBufferStackParts(p: ResolvedConveyorParams): ConveyorPart[] {
  const parts: ConveyorPart[] = [];
  const section = p.frameSectionMm;
  const halfL = p.lengthMm / 2;
  const halfW = p.widthMm / 2;
  const outerY = halfW + section / 2 + 15;
  const layerCount = p.layers;
  const topLayerZ = p.beltHeightMm + (layerCount - 1) * p.layerPitchMm;
  const columnH = topLayerZ + 240;
  const columnY = outerY + section / 2 + 40;
  const columnX = halfL - 120;

  // 1) 缓存立柱：4 根，立在纵梁外侧（不与侧挡边、支腿、横撑同位置）
  const columns: Array<[string, number, number]> = [
    ['fl', -columnX, -columnY],
    ['fr', -columnX, columnY],
    ['bl', columnX, -columnY],
    ['br', columnX, columnY]
  ];
  columns.forEach(([label, x, y], index) => {
    parts.push({
      id: `column-${label}`,
      name: `缓存立柱 ${index + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(columnH)}`,
      features: [box(`column-${label}-body`, '型材', section, section, columnH)],
      transform: { x: round(x), y: round(y), z: round(columnH / 2), rz: 0 }
    });
  });

  // 2) 顶部横梁：把四根立柱在 Y 向连成门架，托架层才有支点
  for (const [label, sign] of [['front', -1], ['back', 1]] as const) {
    parts.push({
      id: `top-beam-${label}`,
      name: `顶部横梁（${label === 'front' ? '前' : '后'}）`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.lengthMm - 200)}`,
      features: [box(`top-beam-${label}-body`, '横梁', p.lengthMm - 240, section, section)],
      transform: { x: 0, y: sign * columnY, z: round(topLayerZ + 200), rz: 0 }
    });
  }

  // 3) 逐层储位：第 2 层起（第 1 层就是底层输送线）
  for (let layer = 2; layer <= layerCount; layer += 1) {
    const layerZ = p.beltHeightMm + (layer - 1) * p.layerPitchMm;
    // 托条：两根沿 X，托住托盘两侧长边
    for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
      parts.push({
        id: `tray-rail-${layer}-${label}`,
        name: `第 ${layer} 层托条（${label === 'left' ? '左' : '右'}）`,
        material: 'AL6063',
        spec: `${section}×${section} × ${Math.round(p.lengthMm - 320)}`,
        features: [box(`tray-rail-${layer}-${label}-body`, '托条', p.lengthMm - 320, section, section)],
        transform: { x: 0, y: sign * round(halfW * 0.55), z: round(layerZ - section / 2), rz: 0 }
      });
    }
    // 托板：放在托条上，留 5mm 高度间隙，避免和托条共面被算成干涉
    parts.push({
      id: `tray-${layer}`,
      name: `第 ${layer} 层托板`,
      material: 'Q235',
      spec: `3 × ${Math.round(p.widthMm * 0.9)} × ${Math.round(p.lengthMm - 340)}`,
      features: [box(`tray-${layer}-body`, '托板', p.lengthMm - 340, round(p.widthMm * 0.9), 3)],
      transform: { x: 0, y: 0, z: round(layerZ + 3 + 2), rz: 0 }
    });
    // 层内传动辊：进出各一根，托板中间让开
    for (const [label, sign] of [['in', -1], ['out', 1]] as const) {
      parts.push({
        id: `tray-roller-${layer}-${label}`,
        name: `第 ${layer} 层传动辊（${label === 'in' ? '进' : '出'}）`,
        material: 'STEEL45',
        spec: `φ${p.pulleyDiameterMm} × ${Math.round(p.widthMm * 0.85)}`,
        massOverrideKg: 2.4,
        features: [cylinder(`tray-roller-${layer}-${label}-body`, '辊筒', p.pulleyDiameterMm, round(p.widthMm * 0.85), 'y')],
        transform: { x: sign * round(halfL - 220), y: 0, z: round(layerZ + 16), rz: 0 }
      });
    }
    // 出口挡停：装在托板上方，挡住托盘
    parts.push({
      id: `stop-${layer}`,
      name: `第 ${layer} 层挡停板`,
      material: 'Q235',
      spec: `3 × ${Math.round(p.widthMm * 0.8)} × 60`,
      features: [box(`stop-${layer}-body`, '挡停板', 3, round(p.widthMm * 0.8), 60)],
      transform: { x: round(halfL - 190), y: 0, z: round(layerZ + 36), rz: 0 }
    });
    // 层到位检测（每层一只，简化成 M12 传感器本体）
    parts.push({
      id: `layer-sensor-${layer}`,
      name: `第 ${layer} 层到位光电`,
      material: 'Q235',
      spec: 'M12 漫反射光电',
      massOverrideKg: 0.08,
      features: [cylinder(`layer-sensor-${layer}-body`, 'M12 光电', 12, 40, 'y')],
      transform: { x: round(-halfL + 300), y: round(halfW + 12), z: round(layerZ + 30), rz: 0 }
    });
  }

  // 4) 升降机构：2 根导柱 + 升降台 + 升降电机 + 2 条链条
  const travel = (layerCount - 1) * p.layerPitchMm;
  const postH = travel + 320;
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `lift-post-${label}`,
      name: `升降导柱（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `φ${section} × ${Math.round(postH)}`,
      features: [cylinder(`lift-post-${label}-body`, '导柱', section, postH, 'z')],
      transform: { x: round(-halfL + 60), y: sign * round(halfW * 0.8), z: round(postH / 2 + 20), rz: 0 }
    });
    parts.push({
      id: `lift-chain-${label}`,
      name: `升降链条（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `8B 单排 × ${Math.round(travel + 200)}`,
      massOverrideKg: 1.6,
      features: [box(`lift-chain-${label}-body`, '链条', 10, 12, travel + 200)],
      transform: { x: round(-halfL + 60), y: sign * round(halfW * 0.8), z: round((travel + 200) / 2 + 90), rz: 0 }
    });
  }
  // 升降台：位于底层输送线上方一个层距处，宽度略小于皮带，避免压挡边
  parts.push({
    id: 'lift-platform',
    name: '升降台',
    material: 'Q235',
    spec: `${Math.round(p.widthMm * 0.9)} × 320 × 16`,
    features: [
      box('lift-platform-body', '台面', 320, round(p.widthMm * 0.9), 16),
      box('lift-platform-guide', '导向块', 60, 60, 40)
    ],
    transform: { x: round(-halfL + 240), y: 0, z: round(p.beltHeightMm + p.layerPitchMm * 0.5), rz: 0 }
  });
  parts.push({
    id: 'lift-motor',
    name: '升降减速电机',
    material: 'Q235',
    spec: '0.75 kW · i=40 · 带制动',
    massOverrideKg: 12.5,
    features: [
      box('lift-motor-body', '电机+减速箱', 180, 140, 160),
      cylinder('lift-motor-shaft', '输出轴', 25, 70, 'y', [0, -60, 0])
    ],
    // 挂在左侧立柱外侧，留 5mm 安装面
    transform: { x: round(-halfL + 60), y: round(-(columnY + section / 2 + 80)), z: round(p.beltHeightMm), rz: 0 }
  });

  return parts;
}

function normalizeParams(params: Partial<ConveyorParams> | undefined): ResolvedConveyorParams {
  const merged = { ...DEFAULT_CONVEYOR, ...(params ?? {}) };
  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  const lengthMm = clamp(positive(merged.lengthMm, DEFAULT_CONVEYOR.lengthMm), 400, 12000);
  const widthMm = clamp(positive(merged.widthMm, DEFAULT_CONVEYOR.widthMm), 100, 1200);
  const beltHeightMm = clamp(positive(merged.beltHeightMm, DEFAULT_CONVEYOR.beltHeightMm), 300, 1400);
  const pulleyDiameterMm = clamp(positive(merged.pulleyDiameterMm, DEFAULT_CONVEYOR.pulleyDiameterMm), 20, 200);
  const beltThicknessMm = clamp(positive(merged.beltThicknessMm, DEFAULT_CONVEYOR.beltThicknessMm), 1, 20);
  const frameSectionMm = clamp(positive(merged.frameSectionMm, DEFAULT_CONVEYOR.frameSectionMm), 20, 100);
  const layers = clamp(Math.round(positive(merged.layers ?? DEFAULT_CONVEYOR.layers, 1)), 1, 8);
  const layerPitchMm = clamp(positive(merged.layerPitchMm ?? DEFAULT_CONVEYOR.layerPitchMm, 400), 250, 900);
  return { lengthMm, widthMm, beltHeightMm, pulleyDiameterMm, beltThicknessMm, frameSectionMm, layers, layerPitchMm };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function conveyorAssembly(parts: readonly ConveyorPart[]): AssemblyDoc {
  const instances: PartInstance[] = parts.map((part) => ({
    id: part.id,
    name: part.name,
    transform: part.transform,
    features: part.features
  }));
  return { schemaVersion: 2, instances, updatedAt: new Date().toISOString() };
}

/**
 * 包络（mm）：X 长 × Y 宽 × Z 高。
 * 按每个零件的实际外形盒求并集，避免「公式估的包络」小于真实模型（电机、挡边会超出）。
 */
export function conveyorEnvelope(parts: readonly ConveyorPart[]): [number, number, number] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const half = partHalfExtent(part);
    const axes: Array<[number, number]> = [
      [part.transform.x - half[0], part.transform.x + half[0]],
      [part.transform.y - half[1], part.transform.y + half[1]],
      [part.transform.z - half[2], part.transform.z + half[2]]
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const [lo, hi] = axes[axis] ?? [0, 0];
      min[axis] = Math.min(min[axis] ?? Infinity, lo);
      max[axis] = Math.max(max[axis] ?? -Infinity, hi);
    }
  }
  if (!Number.isFinite(min[0])) return [0, 0, 0];
  return [
    Math.round((max[0] - min[0]) * 10) / 10,
    Math.round((max[1] - min[1]) * 10) / 10,
    Math.round((max[2] - min[2]) * 10) / 10
  ];
}

/** 单个零件的半尺寸（按特征包围盒估算，含圆柱的轴向长度） */
function partHalfExtent(part: ConveyorPart): [number, number, number] {
  const half: [number, number, number] = [0, 0, 0];
  for (const node of part.features) {
    const params = node.params;
    if (node.type === 'box') {
      half[0] = Math.max(half[0], Number(params.length) / 2);
      half[1] = Math.max(half[1], Number(params.width) / 2);
      half[2] = Math.max(half[2], Number(params.height) / 2);
    } else if (node.type === 'cylinder') {
      const radius = Number(params.diameter) / 2;
      const length = Number(params.height);
      const axis = String(params.axis ?? 'z');
      const at = Array.isArray(params.at) ? (params.at as number[]) : [0, 0, 0];
      const extent: [number, number, number] = axis === 'x'
        ? [length / 2, radius, radius]
        : axis === 'y' ? [radius, length / 2, radius] : [radius, radius, length / 2];
      for (let i = 0; i < 3; i += 1) {
        half[i] = Math.max(half[i] ?? 0, Math.abs(at[i] ?? 0) + (extent[i] ?? 0));
      }
    }
  }
  return half;
}

export interface ConveyorBomRow {
  name: string;
  spec: string;
  qty: number;
  material: string;
  /** 单件质量（kg），有内核体积时按密度精确计算 */
  massKg: number | null;
}

/**
 * BOM。传了 `volumes`（内核回传的每实例体积 mm³）就按密度算真实质量，
 * 没传则 massKg 为 null——不猜重量。
 */
export function conveyorBom(
  parts: readonly ConveyorPart[],
  volumes?: Record<string, number>
): ConveyorBomRow[] {
  const grouped = new Map<string, ConveyorBomRow>();
  for (const part of parts) {
    const volume = volumes?.[part.id];
    const fromKernel = typeof volume === 'number' && volume > 0
      ? Math.round((volume / 1e9) * MATERIAL_DENSITY[part.material] * 1000) / 1000
      : null;
    // 目录件（电机/滚筒/光电）用样本质量覆盖；其余按内核体积 × 密度
    const massKg = part.massOverrideKg ?? fromKernel;
    // 左右/进出这类括号限定不该参与分组，否则「侧纵梁（操作侧）」和「（驱动侧）」会各算一行
    const baseName = part.name.replace(/（[^）]*）/g, '').replace(/ \d+$/, '').trim();
    const key = `${baseName}|${part.spec}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += 1;
      if (existing.massKg !== null && massKg !== null) existing.massKg = Math.min(existing.massKg, massKg);
      continue;
    }
    grouped.set(key, {
      name: baseName,
      spec: part.spec,
      qty: 1,
      material: MATERIAL_LABEL[part.material],
      massKg
    });
  }
  return [...grouped.values()];
}
