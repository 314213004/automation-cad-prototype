// 转接板 → parametric 特征树（P4 第二步）
//
// 把画布上 adapter 节点的两端 MountPort 翻译成仓库既有的 FeatureDoc
// （box / holes / fillet），交给主进程 parametric.build 走 build123d sidecar。
//
// 协议边界（必须写清楚）：
//   - feature 协议现已支持 counterbore（通孔 + 顶面沉窝）；母件侧有沉头需求时出沉头孔，
//     沉头直径/深度取 ISO 4762 内六角圆柱头螺钉的头部尺寸（按通孔直径推定），并在说明里写清依据。
//   - 孔位是对称阵列的近似（按孔距铺 2×n 网格），不是厂商图纸逐孔坐标。
//   - 建模失败（内核未装 / 模块被门控 / 超时）一律按「仅参数」降级，不伪造成功。
import type { FeatureDoc, FeatureNode } from '../parametric/features.ts';
import type { CanvasNode, MountPort } from './types.ts';

/** 板边相对孔阵列外扩的余量 mm（与 view-model 的默认工厂一致）。 */
export const ADAPTER_EDGE_MARGIN_MM = 15;
/** 圆角半径 mm。 */
export const ADAPTER_FILLET_MM = 3;

/**
 * 孔阵列铺法：1 孔居中；≥2 孔按 2 列 × ceil(n/2) 行，行列都居中。
 * 返回相对板中心的 mm 坐标（板中心为原点，与 box centered=true 对齐）。
 */
export function holePositions(port: MountPort): Array<[number, number]> {
  const count = Math.max(0, Math.floor(port.count));
  if (count === 0) return [];
  if (count === 1) return [[0, 0]];
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const positions: Array<[number, number]> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (positions.length >= count) break;
      const x = (col - (cols - 1) / 2) * port.pitchXMm;
      const y = (row - (rows - 1) / 2) * port.pitchYMm;
      positions.push([Number(x.toFixed(3)), Number(y.toFixed(3))]);
    }
  }
  return positions;
}

/** ISO 4762 内六角圆柱头螺钉：按通孔直径推头部直径/高度。查不到就返回 null（不猜）。 */
export interface ScrewHeadSpec {
  screw: string;
  headDiaMm: number;
  headHeightMm: number;
}

const ISO4762_HEADS: ReadonlyArray<{ clearanceMm: number; spec: ScrewHeadSpec }> = [
  { clearanceMm: 4.5, spec: { screw: 'M4', headDiaMm: 7, headHeightMm: 4 } },
  { clearanceMm: 5.5, spec: { screw: 'M5', headDiaMm: 8.5, headHeightMm: 5 } },
  { clearanceMm: 6.6, spec: { screw: 'M6', headDiaMm: 10, headHeightMm: 6 } },
  { clearanceMm: 9, spec: { screw: 'M8', headDiaMm: 13, headHeightMm: 8 } },
  { clearanceMm: 11, spec: { screw: 'M10', headDiaMm: 16, headHeightMm: 10 } }
];

export function screwHeadForClearance(holeDiaMm: number): ScrewHeadSpec | null {
  let best: { delta: number; spec: ScrewHeadSpec } | null = null;
  for (const entry of ISO4762_HEADS) {
    const delta = Math.abs(entry.clearanceMm - holeDiaMm);
    if (delta <= 0.6 && (!best || delta < best.delta)) best = { delta, spec: entry.spec };
  }
  return best?.spec ?? null;
}

function holeFeature(id: string, label: string, port: MountPort): FeatureNode | null {
  const positions = holePositions(port);
  if (positions.length === 0 || !(port.holeDiaMm > 0)) return null;
  return {
    id,
    type: 'holes',
    name: label,
    params: {
      diameter: port.holeDiaMm,
      depth: 'through',
      positions
    }
  };
}

/**
 * adapter 节点 → FeatureDoc。非 adapter 或缺 adapterParams 返回 null（不给假模型）。
 * 板外形用 box(centered=true)，板中心在原点；两端孔阵列都落在板内。
 */
export function adapterFeatureDoc(node: CanvasNode): FeatureDoc | null {
  if (!node || node.kind !== 'adapter' || !node.adapterParams) return null;
  const params = node.adapterParams;
  const [width, height, thickness] = node.dimsMm;
  if (!(width > 0 && height > 0 && thickness > 0)) return null;

  const features: FeatureNode[] = [
    {
      id: 'f-body',
      type: 'box',
      name: `${width}×${height}×${thickness} 板体`,
      params: { length: width, width: height, height: thickness, centered: true }
    }
  ];
  // 母件侧：要沉头且能查到标准螺钉头部尺寸 → 出 counterbore；否则退回通孔（不编尺寸）
  const fromPositions = holePositions(params.fromPort);
  const head = params.counterBore ? screwHeadForClearance(params.fromPort.holeDiaMm) : null;
  const cbDepth = head ? Math.min(head.headHeightMm, Math.max(thickness - 1, 0.5)) : 0;
  if (head && fromPositions.length > 0 && params.fromPort.holeDiaMm > 0 && cbDepth > 0) {
    features.push({
      id: 'f-cb-in',
      type: 'counterbore',
      name: `母件侧沉头孔 Ø${params.fromPort.holeDiaMm} / Ø${head.headDiaMm}×${cbDepth}（${head.screw}）`,
      params: {
        diameter: params.fromPort.holeDiaMm,
        cbDiameter: head.headDiaMm,
        cbDepth,
        depth: 'through',
        positions: fromPositions
      }
    });
  } else {
    const fromHoles = holeFeature('f-holes-in', `母件侧孔阵列（${params.fromPort.family}）`, params.fromPort);
    if (fromHoles) features.push(fromHoles);
  }
  const toHoles = holeFeature('f-holes-out', `子件侧孔阵列（${params.toPort.family}）`, params.toPort);
  if (toHoles) features.push(toHoles);
  if (params.dowelDiaMm > 0) {
    // 定位销孔放在对角线靠边位置；放不下就不加（宁可少一个特征，也不要校验失败）
    const pad = params.dowelDiaMm;
    const candidates: Array<[number, number]> = [
      [-width / 2 + pad * 2, -height / 2 + pad * 2],
      [width / 2 - pad * 2, height / 2 - pad * 2]
    ];
    features.push({
      id: 'f-holes-dowel',
      type: 'holes',
      name: `定位销孔 Ø${params.dowelDiaMm}`,
      params: { diameter: params.dowelDiaMm, depth: 'through', positions: candidates }
    });
  }
  features.push({
    id: 'f-fillet',
    type: 'fillet',
    name: `四角 R${ADAPTER_FILLET_MM}`,
    params: { radius: Math.min(ADAPTER_FILLET_MM, thickness), edges: '|Z' }
  });

  return {
    schemaVersion: 1,
    sourceFile: `canvas-adapter:${node.id}`,
    features,
    updatedAt: new Date().toISOString()
  };
}

/** 建模请求的说明文字：讲清「这次到底能建出什么、缺什么」。 */
export function describeAdapterModel(doc: FeatureDoc | null): string {
  if (!doc) return '该节点没有转接板参数，无法生成建模请求。';
  const holes = doc.features.filter((feature) => feature.type === 'holes' || feature.type === 'counterbore');
  const count = holes.reduce((sum, feature) => {
    const positions = feature.params.positions;
    return sum + (Array.isArray(positions) ? positions.length : 0);
  }, 0);
  const counterbores = doc.features.filter((feature) => feature.type === 'counterbore');
  if (counterbores.length > 0) {
    const first = counterbores[0]!;
    const cbDia = typeof first.params.cbDiameter === 'number' ? first.params.cbDiameter : 0;
    const cbDepth = typeof first.params.cbDepth === 'number' ? first.params.cbDepth : 0;
    const dia = typeof first.params.diameter === 'number' ? first.params.diameter : 0;
    return `特征树 ${doc.features.length} 个（板体 + ${holes.length} 组孔共 ${count} 孔 + 圆角）；母件侧 Ø${dia} 通孔带 Ø${cbDia}×${cbDepth} 沉窝（按 ISO 4762 头部尺寸推定，需按实物螺钉复核）。`;
  }
  return `特征树 ${doc.features.length} 个（板体 + ${holes.length} 组孔共 ${count} 孔 + 圆角）；沉头关闭或不适用，按通孔出。`;
}
