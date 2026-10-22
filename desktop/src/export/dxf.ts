import Drawing from 'dxf-writer';
import type { BBox, Vec3 } from '../mech/interference';

export interface DxfShape {
  name?: string;
  bbox?: BBox;
  kind?: 'rect' | 'circle';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;
}

interface Projection {
  x0: number;
  y0: number;
  width: number;
  height: number;
  label: string;
}

const A3_WIDTH = 420;
const A3_HEIGHT = 297;
const VIEWS: Projection[] = [
  { x0: 28, y0: 156, width: 108, height: 96, label: '主视图' },
  { x0: 28, y0: 48, width: 108, height: 86, label: '俯视图' },
  { x0: 158, y0: 156, width: 88, height: 96, label: '左视图' }
];

function finite(value: number | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`DXF 形状缺少有效${label}`);
  return value;
}

function bboxOf(shape: DxfShape): BBox {
  if (shape.bbox) {
    const min = shape.bbox.min;
    const max = shape.bbox.max;
    if (!Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3) {
      throw new Error('DXF 形状包围盒必须包含 min/max 三个坐标');
    }
    return {
      min: [finite(min[0], 'min[0]'), finite(min[1], 'min[1]'), finite(min[2], 'min[2]')],
      max: [finite(max[0], 'max[0]'), finite(max[1], 'max[1]'), finite(max[2], 'max[2]')]
    };
  }
  if (shape.kind === 'circle') {
    const x = finite(shape.x, '圆心 x');
    const y = finite(shape.y, '圆心 y');
    const r = finite(shape.radius, '半径');
    if (r <= 0) throw new Error('DXF 圆半径必须大于 0');
    return { min: [x - r, y - r, 0], max: [x + r, y + r, 0] };
  }
  const x = finite(shape.x, 'x');
  const y = finite(shape.y, 'y');
  const width = finite(shape.width, '宽度');
  const height = finite(shape.height, '高度');
  if (width <= 0 || height <= 0) throw new Error('DXF 矩形宽高必须大于 0');
  return { min: [x, y, 0], max: [x + width, y + height, 0] };
}

function project(point: Vec3, viewIndex: number): [number, number] {
  if (viewIndex === 0) return [point[0], point[2]];
  if (viewIndex === 1) return [point[0], point[1]];
  return [point[1], point[2]];
}

function drawFrame(drawing: Drawing): void {
  drawing.addLayer('图框', Drawing.ACI.WHITE, 'CONTINUOUS');
  drawing.setActiveLayer('图框');
  drawing.drawRect(10, 10, A3_WIDTH - 10, A3_HEIGHT - 10);
  drawing.drawRect(18, 18, A3_WIDTH - 18, A3_HEIGHT - 18);

  const titleX = 262;
  const titleY = 18;
  const titleW = 140;
  const titleH = 34;
  drawing.drawRect(titleX, titleY, titleX + titleW, titleY + titleH);
  for (let row = 1; row < 3; row += 1) {
    drawing.drawLine(titleX, titleY + (titleH / 3) * row, titleX + titleW, titleY + (titleH / 3) * row);
  }
  drawing.drawLine(titleX + 76, titleY, titleX + 76, titleY + titleH);
  drawing.drawText(titleX + 5, titleY + 21, 4.2, 0, 'AutomationCAD');
  drawing.drawText(titleX + 5, titleY + 9, 3.2, 0, 'A3 420x297 mm');
  drawing.drawText(titleX + 81, titleY + 21, 3.2, 0, '三视图轮廓');
  drawing.drawText(titleX + 81, titleY + 9, 3.2, 0, '单位: mm');
}

function drawViews(drawing: Drawing, shapes: readonly DxfShape[]): void {
  drawing.addLayer('轮廓', Drawing.ACI.CYAN, 'CONTINUOUS');
  drawing.addLayer('标注', Drawing.ACI.GREEN, 'CONTINUOUS');

  VIEWS.forEach((view, viewIndex) => {
    drawing.setActiveLayer('标注');
    drawing.drawText(view.x0, view.y0 - 8, 3.5, 0, view.label);

    const projected = shapes.map((shape) => {
      const box = bboxOf(shape);
      const [x1, y1] = project(box.min, viewIndex);
      const [x2, y2] = project(box.max, viewIndex);
      return {
        shape,
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2),
        x2: Math.max(x1, x2),
        y2: Math.max(y1, y2)
      };
    });
    if (projected.length === 0) return;

    const minX = Math.min(...projected.map((item) => item.x1));
    const minY = Math.min(...projected.map((item) => item.y1));
    const maxX = Math.max(...projected.map((item) => item.x2));
    const maxY = Math.max(...projected.map((item) => item.y2));
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((view.width - 12) / spanX, (view.height - 12) / spanY);
    const offsetX = view.x0 + (view.width - spanX * scale) / 2;
    const offsetY = view.y0 + (view.height - spanY * scale) / 2;

    projected.forEach((item) => {
      const left = offsetX + (item.x1 - minX) * scale;
      const right = offsetX + (item.x2 - minX) * scale;
      const bottom = offsetY + (item.y1 - minY) * scale;
      const top = offsetY + (item.y2 - minY) * scale;
      drawing.setActiveLayer('轮廓');
      if (item.shape.kind === 'circle' && item.x2 - item.x1 > 0) {
        drawing.drawCircle((left + right) / 2, (bottom + top) / 2, Math.max((right - left) / 2, 0.2));
      } else {
        drawing.drawRect(left, bottom, Math.max(right, left + 0.2), Math.max(top, bottom + 0.2));
      }
    });
  });
}

/**
 * 输出 A3 图框 + 三视图包围盒轮廓。仅用于二维初稿，不包含 B-rep 精确投影。
 */
export function toDxf(shapes: readonly DxfShape[] = []): string {
  if (!Array.isArray(shapes)) throw new Error('DXF 输入必须是形状数组');
  shapes.forEach((shape) => {
    if (!shape || typeof shape !== 'object') throw new Error('DXF 形状不合法');
    bboxOf(shape);
  });
  const drawing = new Drawing();
  drawing.setUnits('Millimeters');
  drawFrame(drawing);
  drawViews(drawing, shapes);
  drawing.setActiveLayer('图框');
  return drawing.toDxfString();
}
