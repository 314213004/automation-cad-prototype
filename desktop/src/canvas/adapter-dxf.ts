// 转接板开孔图 DXF（单件、1:1 mm，可直接下料/送加工）
//
// 和 build123d 请求是两条互补的路：
//   - build123d：给 3D 内核建模（需要 sidecar）；
//   - DXF：给机加工/激光切割的开孔图，不需要任何内核。
//
// 画法：板外形 (0,0)-(W,H) 以左下角为原点；孔位按两端 MountPort 的对称阵列铺，
// 母件侧 HOLES 层、子件侧 HOLES 层（不同颜色）、定位销孔 PILOT 层。
// **沉头**在图纸上只用文字标注（协议/图元里没有沉头孔），不在 DXF 里假装画了锥面。
import Drawing from 'dxf-writer';
import { holePositions } from './adapter-model.ts';
import type { CanvasNode, MountPort } from './types.ts';

export interface AdapterHoleLayout {
  /** 绝对坐标（mm），原点为板左下角。 */
  x: number;
  y: number;
  diameterMm: number;
  group: 'in' | 'out' | 'dowel';
}

export interface AdapterDxfResult {
  dxf: string;
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  holes: number;
  dowels: number;
}

/** 板内所有孔的绝对坐标（纯几何，便于单测与后续 2D 预览复用）。 */
export function adapterHoleLayout(node: CanvasNode): AdapterHoleLayout[] {
  const params = node.adapterParams;
  if (!params) return [];
  const [width, height] = node.dimsMm;
  const place = (port: MountPort, group: AdapterHoleLayout['group']): AdapterHoleLayout[] =>
    holePositions(port).map(([dx, dy]) => ({
      x: Number((width / 2 + dx).toFixed(3)),
      y: Number((height / 2 + dy).toFixed(3)),
      diameterMm: port.holeDiaMm,
      group
    }));
  const holes = [...place(params.fromPort, 'in'), ...place(params.toPort, 'out')];
  if (params.dowelDiaMm > 0) {
    const pad = params.dowelDiaMm * 2;
    holes.push(
      { x: pad, y: pad, diameterMm: params.dowelDiaMm, group: 'dowel' },
      { x: Number((width - pad).toFixed(3)), y: Number((height - pad).toFixed(3)), diameterMm: params.dowelDiaMm, group: 'dowel' }
    );
  }
  return holes;
}

/**
 * 生成单件转接板 DXF。非 adapter / 缺参数返回 null（不生成空图）。
 */
export function adapterPlateDxf(node: CanvasNode): AdapterDxfResult | null {
  if (!node || node.kind !== 'adapter' || !node.adapterParams) return null;
  const [width, height, thickness] = node.dimsMm;
  if (!(width > 0 && height > 0 && thickness > 0)) return null;
  const params = node.adapterParams;
  const holes = adapterHoleLayout(node);

  const drawing = new Drawing();
  drawing.setUnits('Millimeters');
  drawing.addLayer('OUTLINE', Drawing.ACI.CYAN, 'CONTINUOUS');
  drawing.addLayer('HOLES-IN', Drawing.ACI.YELLOW, 'CONTINUOUS');
  drawing.addLayer('HOLES-OUT', Drawing.ACI.MAGENTA, 'CONTINUOUS');
  drawing.addLayer('PILOT', Drawing.ACI.GREEN, 'CONTINUOUS');
  drawing.addLayer('TEXT', Drawing.ACI.WHITE, 'CONTINUOUS');

  drawing.setActiveLayer('OUTLINE');
  drawing.drawRect(0, 0, width, height);

  for (const hole of holes) {
    drawing.setActiveLayer(hole.group === 'in' ? 'HOLES-IN' : hole.group === 'out' ? 'HOLES-OUT' : 'PILOT');
    drawing.drawCircle(hole.x, hole.y, hole.diameterMm / 2);
  }

  drawing.setActiveLayer('TEXT');
  const from = params.fromPort;
  const to = params.toPort;
  const lines = [
    `ADAPTER ${node.id}  ${width}x${height}x${thickness}mm  ${params.material}`,
    `A/FROM ${from.family} D${from.holeDiaMm} PITCH ${from.pitchXMm}x${from.pitchYMm} x${from.count}`,
    `B/TO   ${to.family} D${to.holeDiaMm} PITCH ${to.pitchXMm}x${to.pitchYMm} x${to.count}`,
    params.counterBore
      ? 'COUNTERBORE: 2D 只画通孔，沉窝尺寸见 3D 模型/工序卡（DXF 不带锥面）'
      : 'THROUGH HOLES ONLY',
    params.dowelDiaMm > 0 ? `DOWEL D${params.dowelDiaMm} x2` : 'NO DOWEL',
    'UNIT mm  SCALE 1:1  NOT FOR B-REP / 仅开孔图，不含公差与粗糙度'
  ];
  lines.forEach((line, index) => {
    drawing.drawText(0, height + 8 + (lines.length - index) * 5, 3.2, 0, line);
  });

  return {
    dxf: drawing.toDxfString(),
    widthMm: width,
    heightMm: height,
    thicknessMm: thickness,
    holes: holes.filter((hole) => hole.group !== 'dowel').length,
    dowels: holes.filter((hole) => hole.group === 'dowel').length
  };
}

/** 一句话说明，导出面板上显示。 */
export function describeAdapterDxf(result: AdapterDxfResult | null): string {
  if (!result) return '没有可导出的转接板（先在画布上插入一块，或选中已有转接板）。';
  return `${result.widthMm}×${result.heightMm}×${result.thicknessMm}mm · 通孔 ${result.holes} 个 · 销孔 ${result.dowels} 个 · 1:1 mm`;
}
