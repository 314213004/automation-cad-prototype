/**
 * 3D 渲染质量档位（纯函数）。
 *
 * `antialias` 只能在 WebGLRenderer 构造时决定，因此这里只负责像素比与自动降级判定；
 * 跨 MSAA 边界的重建由 OrbitView 负责。
 */

export type RenderQuality = 'flow' | 'standard' | 'high';

export const RENDER_QUALITIES: readonly RenderQuality[] = ['flow', 'standard', 'high'];

export const DEFAULT_RENDER_QUALITY: RenderQuality = 'standard';

export const RENDER_QUALITY_CAPS: Readonly<Record<RenderQuality, number>> = Object.freeze({
  flow: 1,
  standard: 1.5,
  high: 2
});

export const DRAG_PIXEL_RATIO = 0.8;

/** 超过该零件数时默认降到 flow，避免大装配体拖动时持续按高像素比渲染。 */
export const AUTO_DOWNGRADE_PART_THRESHOLD = 1500;

export function normalizeRenderQuality(value: unknown): RenderQuality {
  return typeof value === 'string' && (RENDER_QUALITIES as readonly string[]).includes(value)
    ? value as RenderQuality
    : DEFAULT_RENDER_QUALITY;
}

/**
 * 实际传给 renderer.setPixelRatio 的值。
 * 拖动中固定 0.8；静止时 min(设备像素比, 档位上限)。
 */
export function effectivePixelRatio(dpr: unknown, quality: unknown, dragging: boolean): number {
  if (dragging) return DRAG_PIXEL_RATIO;
  const ratio = typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(ratio, RENDER_QUALITY_CAPS[normalizeRenderQuality(quality)]);
}

export function shouldAutoDowngrade(partCount: unknown): boolean {
  return typeof partCount === 'number' && Number.isFinite(partCount) && partCount > AUTO_DOWNGRADE_PART_THRESHOLD;
}

export function resolveEffectiveQuality(
  quality: unknown,
  partCount: unknown
): { quality: RenderQuality; autoDowngraded: boolean } {
  const configured = normalizeRenderQuality(quality);
  const autoDowngraded = shouldAutoDowngrade(partCount);
  return {
    quality: autoDowngraded ? 'flow' : configured,
    autoDowngraded
  };
}

