// 2D 正交布局图 → DXF（给客户/车间看的排布图，不是零件图）
//
// 画什么：整体包络框、每个工位的外形矩形与名称、尺寸链（总宽/总高/中心距）、标题栏文字。
// 不画什么：装配关系、运动包络的第二种工况、干涉结论。重叠按尺寸链如实标注，不美化。
//
// 坐标系：DXF 用左下角原点、Y 向上（CAD 习惯），所以画布 ortho（Y 向下）在这里翻一次 Y。
import Drawing from 'dxf-writer';
import { buildDimensions } from './dimensions.ts';
import type { OrthoStation, OrthoView } from './view-model.ts';
import type { MachineGraph } from './types.ts';

export interface LayoutDxfResult {
  dxf: string;
  widthMm: number;
  heightMm: number;
  stations: number;
  dimensions: number;
}

/** 把画布 px 视图里的工位换成「左下角原点、Y 向上」的 mm 坐标。 */
export function layoutStations(stations: readonly OrthoStation[], boundsMm: OrthoView['boundsMm']): Array<OrthoStation & { cadX: number; cadY: number }> {
  return stations.map((station) => ({
    ...station,
    cadX: station.mmX - boundsMm.minX,
    // 画布 Y 向下、DXF Y 向上：用整体高度减去，让最上面的工位落在最高处
    cadY: boundsMm.maxY - (station.mmY + station.mmHeight)
  }));
}

export function buildLayoutDxf(graph: MachineGraph, view: OrthoView): LayoutDxfResult {
  const width = view.boundsMm.maxX - view.boundsMm.minX;
  const height = view.boundsMm.maxY - view.boundsMm.minY;
  const stations = layoutStations(view.stations, view.boundsMm);
  const dimensions = buildDimensions(view, null);

  const drawing = new Drawing();
  drawing.setUnits('Millimeters');
  drawing.addLayer('OUTLINE', Drawing.ACI.CYAN, 'CONTINUOUS');
  drawing.addLayer('STATION', Drawing.ACI.YELLOW, 'CONTINUOUS');
  drawing.addLayer('ADAPTER', Drawing.ACI.MAGENTA, 'CONTINUOUS');
  drawing.addLayer('DIM', Drawing.ACI.GREEN, 'CONTINUOUS');
  drawing.addLayer('TEXT', Drawing.ACI.WHITE, 'CONTINUOUS');

  drawing.setActiveLayer('OUTLINE');
  drawing.drawRect(0, 0, width, height);

  for (const station of stations) {
    drawing.setActiveLayer(station.adapter ? 'ADAPTER' : 'STATION');
    drawing.drawRect(station.cadX, station.cadY, station.cadX + station.mmWidth, station.cadY + station.mmHeight);
    drawing.setActiveLayer('TEXT');
    drawing.drawText(station.cadX + 2, station.cadY + station.mmHeight + 3, 2.5, 0, station.name.slice(0, 40));
    drawing.drawText(
      station.cadX + 2,
      station.cadY + station.mmHeight + 7,
      2,
      0,
      `${station.mmWidth}x${station.mmHeight}`
    );
  }

  // 尺寸链：X 向画在图形上方，Y 向画在左侧
  drawing.setActiveLayer('DIM');
  let level = 0;
  for (const chain of dimensions.chains) {
    level += 1;
    if (chain.axis === 'x') {
      const y = height + 12 + level * 6;
      const x1 = chain.fromMm - view.boundsMm.minX;
      const x2 = chain.toMm - view.boundsMm.minX;
      drawing.drawLine(Math.min(x1, x2), y, Math.max(x1, x2), y);
      drawing.drawLine(Math.min(x1, x2), y - 2, Math.min(x1, x2), y + 2);
      drawing.drawLine(Math.max(x1, x2), y - 2, Math.max(x1, x2), y + 2);
      drawing.drawText((x1 + x2) / 2, y + 1.5, 2.2, 0, `${chain.text}`);
    } else {
      const x = -10 - level * 6;
      const y1 = chain.fromMm - view.boundsMm.minY;
      const y2 = chain.toMm - view.boundsMm.minY;
      drawing.drawLine(x, Math.min(y1, y2), x, Math.max(y1, y2));
      drawing.drawLine(x - 2, Math.min(y1, y2), x + 2, Math.min(y1, y2));
      drawing.drawLine(x - 2, Math.max(y1, y2), x + 2, Math.max(y1, y2));
      drawing.drawText(x - 3, (y1 + y2) / 2, 2.2, 90, `${chain.text}`);
    }
  }

  drawing.setActiveLayer('TEXT');
  const head = `${graph.title ?? graph.schemeId} · 2D 排布图`;
  drawing.drawText(0, -18, 5, 0, head);
  drawing.drawText(0, -26, 3, 0, `包络 ${Math.round(width)}x${Math.round(height)}mm（含行程）  单位 mm  1:1`);
  drawing.drawText(0, -32, 3, 0, `工位 ${stations.length} 个  ${dimensions.note.slice(0, 120)}`);
  drawing.drawText(0, -38, 2.6, 0, '示意图：工位坐标为示意布局，重叠不代表干涉；装配关系见图纸/3D');

  return {
    dxf: drawing.toDxfString(),
    widthMm: width,
    heightMm: height,
    stations: stations.length,
    dimensions: dimensions.chains.length
  };
}

export function describeLayoutDxf(result: LayoutDxfResult | null): string {
  if (!result) return '当前没有可导出的 2D 排布。';
  return `${Math.round(result.widthMm)}×${Math.round(result.heightMm)}mm · ${result.stations} 个工位 · ${result.dimensions} 条尺寸 · 1:1 mm`;
}
