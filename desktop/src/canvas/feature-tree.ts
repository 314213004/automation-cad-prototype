// UI 重构第 1 步（机械侧 only）：特征树与属性面板的只读绑定模型。
//
// 定位：这是表现层，不是内核。所有字段都直接读现有对象，
// 不新造数据结构，不改字段名，不碰电气（电气标签页、IO 编辑、
// 柜体布置都不在本模块，也不改任何电气代码）。
//
// 术语只改叫法（方案第 4 节映射表）：
//   box / cylinder -> 拉伸（凸台），holes -> 孔，
//   counterbore -> 沉孔，slot -> 槽，fillet -> 圆角/倒角。
// 代码里的类型名和字段名一个都不改，现有测试和数据文件不受影响。
//
// 绑定方式（方案第 3 节硬规则）：树节点即文档对象本身，
// 本模块只返回“怎么显示、选了谁、面板上该列哪些字段”的描述，
// 不持有文档对象的副本；DOM 渲染与编辑入口由后续步骤接 workbench.ts。
// 本步先做只读绑定：树可看、面板可看，编辑入口暂不开放。

export type FeatureTreeNodeKind =
  | 'part'
  | 'feature'
  | 'assembly'
  | 'component'
  | 'mate';

export interface FeatureTreeNode {
  id: string;
  kind: FeatureTreeNodeKind;
  /** 界面显示名：特征用 FeatureNode.name，零件/节点用 CanvasNode.name。 */
  label: string;
  /** SolidWorks 风格的界面术语，如“沉孔”“圆角/倒角”。 */
  displayType?: string;
  /** 原始特征类型（box / holes / counterbore / slot / fillet / cylinder），原样保留。 */
  featureType?: string;
  /** FeatureNode.suppressed：压缩的特征在编译时跳过，树上灰显。 */
  suppressed?: boolean;
  children?: FeatureTreeNode[];
}

export interface PanelField {
  key: string;
  label: string;
  value: unknown;
  unit?: string;
}

/** 特征类型 -> 界面术语（只改叫法，不改类型名）。 */
export const FEATURE_DISPLAY_TYPE: Record<string, string> = {
  box: '拉伸（凸台）',
  cylinder: '拉伸（圆柱）',
  holes: '孔',
  counterbore: '沉孔',
  slot: '槽',
  fillet: '圆角/倒角'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positionsCount(params: Record<string, unknown>): number | undefined {
  const positions = params.positions;
  return Array.isArray(positions) ? positions.length : undefined;
}

/** FeatureDoc -> 零件特征树：按 features 数组顺序渲染，顺序即建模顺序。 */
export function buildFeatureTree(doc: {
  features: Array<{
    id: string;
    type: string;
    name: string;
    params: Record<string, unknown>;
    suppressed?: boolean;
  }>;
}): FeatureTreeNode {
  return {
    id: 'part',
    kind: 'part',
    label: '零件',
    children: doc.features.map((feature) => ({
      id: feature.id,
      kind: 'feature' as const,
      label: feature.name,
      displayType: FEATURE_DISPLAY_TYPE[feature.type] ?? feature.type,
      featureType: feature.type,
      suppressed: feature.suppressed === true
    }))
  };
}

/** MachineGraph -> 整机装配树：节点即组件，边即配合（from.portOut 对接 to.portIn）。 */
export function buildAssemblyTree(graph: {
  nodes: Array<{ id: string; name: string; kind: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
}): FeatureTreeNode {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    id: 'assembly',
    kind: 'assembly',
    label: '整机装配体',
    children: [
      ...graph.nodes.map((node) => ({
        id: node.id,
        kind: 'component' as const,
        label: node.name
      })),
      ...graph.edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        return {
          id: edge.id,
          kind: 'mate' as const,
          label: from && to ? `配合 ${from.name} → ${to.name}` : `配合 ${edge.from} → ${edge.to}`
        };
      })
    ]
  };
}

/** 选中一个特征 -> 属性面板字段（只读描述，字段名原样保留）。 */
export function panelFieldsForFeature(feature: {
  type: string;
  params: Record<string, unknown>;
}): PanelField[] {
  const params = feature.params;
  switch (feature.type) {
    case 'box': {
      const fields: PanelField[] = [];
      const length = num(params, 'length');
      const width = num(params, 'width');
      const height = num(params, 'height');
      if (length !== undefined) fields.push({ key: 'length', label: '长度', value: length, unit: 'mm' });
      if (width !== undefined) fields.push({ key: 'width', label: '宽度', value: width, unit: 'mm' });
      if (height !== undefined) fields.push({ key: 'height', label: '高度', value: height, unit: 'mm' });
      return fields;
    }
    case 'holes': {
      const fields: PanelField[] = [];
      const diameter = num(params, 'diameter');
      const count = positionsCount(params);
      if (diameter !== undefined) fields.push({ key: 'diameter', label: '孔径', value: diameter, unit: 'mm' });
      if (count !== undefined) fields.push({ key: 'count', label: '孔数', value: count });
      return fields;
    }
    case 'counterbore': {
      const fields: PanelField[] = [];
      const diameter = num(params, 'diameter');
      const cbDiameter = num(params, 'cbDiameter');
      const cbDepth = num(params, 'cbDepth');
      if (diameter !== undefined) fields.push({ key: 'diameter', label: '孔径', value: diameter, unit: 'mm' });
      if (cbDiameter !== undefined) fields.push({ key: 'cbDiameter', label: '沉窝直径', value: cbDiameter, unit: 'mm' });
      if (cbDepth !== undefined) fields.push({ key: 'cbDepth', label: '沉窝深度', value: cbDepth, unit: 'mm' });
      return fields;
    }
    case 'fillet': {
      const fields: PanelField[] = [];
      const radius = num(params, 'radius');
      if (radius !== undefined) fields.push({ key: 'radius', label: '圆角半径', value: radius, unit: 'mm' });
      if (typeof params.edges === 'string') fields.push({ key: 'edges', label: '边', value: params.edges });
      return fields;
    }
    default:
      return [];
  }
}

/** 转接板节点 -> 属性面板字段（AdapterParams 全字段呈现，金额不进面板）。 */
export function panelFieldsForAdapter(adapterParams: {
  fromPort: { family: string; holeDiaMm: number; pitchXMm: number; pitchYMm: number; count: number };
  toPort: { family: string; holeDiaMm: number; pitchXMm: number; pitchYMm: number; count: number };
  plateDimsMm: [number, number, number];
  thicknessMm: number;
  material: string;
  counterBore: boolean;
  dowelDiaMm: number;
  massKg: number;
}): PanelField[] {
  const port = (label: string, port: { family: string; holeDiaMm: number; pitchXMm: number; pitchYMm: number; count: number }): PanelField[] => [
    { key: `${label}.family`, label: `${label}族`, value: port.family },
    { key: `${label}.holeDiaMm`, label: `${label}孔径`, value: port.holeDiaMm, unit: 'mm' },
    { key: `${label}.pitchXMm`, label: `${label}孔距 X`, value: port.pitchXMm, unit: 'mm' },
    { key: `${label}.pitchYMm`, label: `${label}孔距 Y`, value: port.pitchYMm, unit: 'mm' },
    { key: `${label}.count`, label: `${label}孔数`, value: port.count }
  ];
  return [
    ...port('fromPort', adapterParams.fromPort),
    ...port('toPort', adapterParams.toPort),
    { key: 'plateDimsMm', label: '板尺寸', value: adapterParams.plateDimsMm.join('×'), unit: 'mm' },
    { key: 'thicknessMm', label: '板厚', value: adapterParams.thicknessMm, unit: 'mm' },
    { key: 'material', label: '材料', value: adapterParams.material },
    { key: 'counterBore', label: '沉头', value: adapterParams.counterBore },
    { key: 'dowelDiaMm', label: '定位销孔直径', value: adapterParams.dowelDiaMm, unit: 'mm' },
    { key: 'massKg', label: '质量', value: adapterParams.massKg, unit: 'kg' }
  ];
}

/** 在树中按 id 找节点；找不到返回 null（不猜、不抛）。 */
export function findTreeNode(root: FeatureTreeNode, id: string): FeatureTreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

export function isRecordValue(value: unknown): boolean {
  return isRecord(value);
}
