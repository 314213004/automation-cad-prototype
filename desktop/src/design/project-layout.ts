import type { Placement } from '../enclosure/layout.ts';
import { projectLayoutItemStatus, type ProjectLayoutValidationView } from './project-layout-validation.ts';

export interface ProjectLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectLayoutSvg {
  markup: string;
  widthPx: number;
  heightPx: number;
  scale: number;
}

const MAX_PROJECT_LAYOUT_ITEMS = 2000;
const MAX_LAYOUT_TEXT_LENGTH = 500;
export const MAX_PROJECT_LAYOUT_COORDINATE = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength = MAX_LAYOUT_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

/** 布局坐标以毫米计，允许负坐标，但不允许超出可读、可交互的工程范围。 */
export function isValidProjectLayoutGeometry(item: Pick<Placement, 'x' | 'y' | 'w' | 'h'>): boolean {
  return Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.w) && Number.isFinite(item.h) &&
    Math.abs(item.x) <= MAX_PROJECT_LAYOUT_COORDINATE && Math.abs(item.y) <= MAX_PROJECT_LAYOUT_COORDINATE &&
    item.w > 0 && item.h > 0 && item.w <= MAX_PROJECT_LAYOUT_COORDINATE && item.h <= MAX_PROJECT_LAYOUT_COORDINATE &&
    item.x + item.w <= MAX_PROJECT_LAYOUT_COORDINATE && item.y + item.h <= MAX_PROJECT_LAYOUT_COORDINATE;
}

/** 对工程文件中的布局数据做严格筛选；损坏或过大的数据不影响 3D 工程打开。 */
export function parseProjectLayoutPlacements(value: unknown): Placement[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_LAYOUT_ITEMS) return null;
  const placements: Placement[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !boundedText(raw.id) || !raw.id || ids.has(raw.id) || !boundedText(raw.partId) ||
        !boundedText(raw.model) || !isValidProjectLayoutGeometry({ x: raw.x as number, y: raw.y as number, w: raw.w as number, h: raw.h as number })) {
      return null;
    }
    ids.add(raw.id);
    const placement: Placement = {
      id: raw.id,
      partId: raw.partId,
      model: raw.model,
      x: raw.x as number,
      y: raw.y as number,
      w: raw.w as number,
      h: raw.h as number
    };
    if (raw.railId !== undefined) {
      if (!boundedText(raw.railId)) return null;
      placement.railId = raw.railId;
    }
    if (raw.tag !== undefined) {
      if (!boundedText(raw.tag)) return null;
      placement.tag = raw.tag;
    }
    if (raw.qty !== undefined) {
      if (typeof raw.qty !== 'number' || !Number.isFinite(raw.qty) || raw.qty < 0) return null;
      placement.qty = raw.qty;
    }
    if (raw.note !== undefined) {
      if (!boundedText(raw.note, 2_000)) return null;
      placement.note = raw.note;
    }
    placements.push(placement);
  }
  return placements;
}

/** 用工程包络和布局外接框共同确定视图范围，不改写原始毫米坐标。 */
export function projectLayoutBounds(
  placements: readonly Placement[],
  envelope?: readonly [number, number, number] | null
): ProjectLayoutBounds {
  const envelopeWidth = envelope && Number.isFinite(envelope[0]) && envelope[0] > 0 ? Math.min(envelope[0], MAX_PROJECT_LAYOUT_COORDINATE) : 0;
  const envelopeHeight = envelope && Number.isFinite(envelope[1]) && envelope[1] > 0 ? Math.min(envelope[1], MAX_PROJECT_LAYOUT_COORDINATE) : 0;
  const minX = Math.min(0, ...placements.map((item) => item.x));
  const minY = Math.min(0, ...placements.map((item) => item.y));
  const maxX = Math.max(envelopeWidth, ...placements.map((item) => item.x + item.w), 1);
  const maxY = Math.max(envelopeHeight, ...placements.map((item) => item.y + item.h), 1);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character] ?? character);
}

/** 绘制二维毫米布局。interactive 仅增加点选/拖动所需标记，不改变几何或 3D/STL。 */
export function renderProjectLayoutSvg(
  placements: readonly Placement[],
  bounds: ProjectLayoutBounds,
  maxWidthPx = 1100,
  maxHeightPx = 620,
  options: {
    interactive?: boolean;
    selectedId?: string | null;
    projectEnvelope?: readonly [number, number, number] | null;
    validation?: ProjectLayoutValidationView;
  } = {}
): ProjectLayoutSvg {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const scale = Math.min(1, maxWidthPx / width, maxHeightPx / height);
  const widthPx = Math.max(1, Math.round(width * scale));
  const heightPx = Math.max(1, Math.round(height * scale));
  const gridStep = Math.max(35, Math.ceil(Math.max(width, height) / 200 / 35) * 35);
  const verticalGrid: string[] = [];
  const horizontalGrid: string[] = [];
  for (let x = Math.ceil(bounds.x / gridStep) * gridStep; x <= bounds.x + width; x += gridStep) {
    verticalGrid.push(`<line x1="${x}" y1="${bounds.y}" x2="${x}" y2="${bounds.y + height}"/>`);
  }
  for (let y = Math.ceil(bounds.y / gridStep) * gridStep; y <= bounds.y + height; y += gridStep) {
    horizontalGrid.push(`<line x1="${bounds.x}" y1="${y}" x2="${bounds.x + width}" y2="${y}"/>`);
  }
  const envelope = options.projectEnvelope;
  const envelopeOutline = options.interactive && envelope && Number.isFinite(envelope[0]) && envelope[0] > 0 &&
    Number.isFinite(envelope[1]) && envelope[1] > 0
    ? `<rect data-project-envelope="true" x="0" y="0" width="${envelope[0]}" height="${envelope[1]}" fill="none" stroke="#23b7a8" stroke-width="4" stroke-dasharray="14 8"><title>项目包络：长度 ${envelope[0]} mm × 宽度 ${envelope[1]} mm</title></rect>`
    : '';
  const items = placements.map((item) => {
    const title = `${item.model} · X ${item.x}, Y ${item.y}, ${item.w}×${item.h} mm`;
    const station = item.id.startsWith('station:');
    const fill = station ? '#5aa5d833' : '#e0a34144';
    const stroke = station ? '#2778a9' : '#b7791f';
    const interactive = options.interactive === true;
    const selected = options.selectedId === item.id;
    const status = interactive && options.validation ? projectLayoutItemStatus(options.validation, item.id) : 'valid';
    const outside = status === 'out-of-bounds' || status === 'overlap-and-out-of-bounds';
    const overlap = status === 'overlap' || status === 'overlap-and-out-of-bounds' || status === 'overlap-unchecked';
    const itemFill = outside ? '#d9484144' : overlap ? '#ed9c273e' : fill;
    const itemStroke = outside ? '#e15b50' : overlap ? '#e59a22' : selected ? '#007f73' : stroke;
    const attributes = interactive
      ? ` data-layout-placement="${escapeXml(item.id)}" data-layout-state="${status}"${selected ? ' data-layout-selected="true"' : ''}`
      : '';
    return `<g${attributes}><title>${escapeXml(title)}</title><rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="3" fill="${itemFill}" stroke="${itemStroke}" stroke-width="${selected ? 4 : 2}"/><text x="${item.x + 6}" y="${item.y + 18}" font-size="14" fill="#173042">${escapeXml(item.model)}</text><text x="${item.x + 6}" y="${item.y + 36}" font-size="11" fill="#34505f">${item.x}, ${item.y} mm</text></g>`;
  }).join('');
  const ariaLabel = options.interactive ? '可编辑的已保存二维毫米布局' : '已保存的二维毫米布局，只读';
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${width} ${height}" width="${widthPx}" height="${heightPx}" role="img" aria-label="${ariaLabel}"><rect x="${bounds.x}" y="${bounds.y}" width="${width}" height="${height}" fill="#f8fbfb"/><g stroke="#c6d3d8" stroke-width="1">${verticalGrid.join('')}${horizontalGrid.join('')}</g>${envelopeOutline}<rect x="0" y="0" width="${Math.max(1, bounds.x + width)}" height="${Math.max(1, bounds.y + height)}" fill="none" stroke="#71858d" stroke-width="3"/>${items}</svg>`;
  return { markup, widthPx, heightPx, scale };
}
