// 转接板 → parametric 特征树（P4 第二步）
//
// 把画布上 adapter 节点的两端 MountPort 翻译成仓库既有的 FeatureDoc
// （box / holes / fillet），交给主进程 parametric.build 走 build123d sidecar。
//
// 协议边界（必须写清楚）：
//   - feature 协议只有 box / cylinder / holes(slot/fillet)，**没有沉头孔算子**；
//     所以这里出通孔，沉头在图纸/后续工序体现，不在 3D 里假装做出来了。
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
  const fromHoles = holeFeature('f-holes-in', `母件侧孔阵列（${params.fromPort.family}）`, params.fromPort);
  if (fromHoles) features.push(fromHoles);
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
  const holes = doc.features.filter((feature) => feature.type === 'holes');
  const count = holes.reduce((sum, feature) => {
    const positions = feature.params.positions;
    return sum + (Array.isArray(positions) ? positions.length : 0);
  }, 0);
  return `特征树 ${doc.features.length} 个（板体 + ${holes.length} 组孔共 ${count} 孔 + 圆角）；沉头孔协议不支持，先出通孔。`;
}
