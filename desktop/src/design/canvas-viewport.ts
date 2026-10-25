export const DESIGN_CANVAS_ZOOM_MIN = 0.5;
export const DESIGN_CANVAS_ZOOM_MAX = 3;
export const DESIGN_CANVAS_ZOOM_FACTOR = 1.25;

export function clampDesignCanvasZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.round(Math.min(DESIGN_CANVAS_ZOOM_MAX, Math.max(DESIGN_CANVAS_ZOOM_MIN, value)) * 1000) / 1000;
}

export function stepDesignCanvasZoom(current: number, direction: -1 | 1): number {
  const zoom = clampDesignCanvasZoom(current);
  return clampDesignCanvasZoom(direction > 0 ? zoom * DESIGN_CANVAS_ZOOM_FACTOR : zoom / DESIGN_CANVAS_ZOOM_FACTOR);
}

export function designCanvasSvgDimensions(
  size: { width: number; height: number },
  baseScale: number,
  zoom: number
): { width: number; height: number } {
  if (![size.width, size.height, baseScale].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || baseScale <= 0) {
    throw new Error('画布尺寸与比例必须是正数');
  }
  const scale = baseScale * clampDesignCanvasZoom(zoom);
  return { width: size.width * scale, height: size.height * scale };
}
