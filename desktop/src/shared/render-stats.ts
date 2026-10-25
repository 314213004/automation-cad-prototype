import type { RenderQuality } from '../orbit/quality.ts';

/** 渲染层通过 IPC 上报、主进程缓存、/health 与 get_render_stats 共用的指标口径。 */
export interface RenderStats {
  /** RENDERER 与 UNMASKED_RENDERER_WEBGL 合并后的可读字符串；两者都取不到时为能力摘要。 */
  glRenderer: string;
  isSoftware: boolean;
  pixelRatio: number;
  quality: RenderQuality;
  partCount: number;
  triangleCount: number;
  /** 最近一次拖动（controls start → end）内的帧间隔数量。 */
  dragFrames: number;
  dragAvgFrameMs: number;
  dragMaxFrameMs: number;
  /** 最近一次拖动结束时间（ISO 8601）；尚未拖动过为 null。 */
  lastDragAt: string | null;
}

const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|software/i;

export function isSoftwareRenderer(renderer: unknown): boolean {
  return typeof renderer === 'string' && SOFTWARE_RENDERER_PATTERN.test(renderer);
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** IPC 输入是不可信 JSON：字段缺失/类型错误时回落安全值，非法 quality 回落 standard。 */
export function normalizeRenderStats(value: unknown): RenderStats | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const quality = source.quality;
  if (quality !== 'flow' && quality !== 'standard' && quality !== 'high') return null;
  const glRenderer = typeof source.glRenderer === 'string' ? source.glRenderer.slice(0, 500) : '';
  const lastDragAt = typeof source.lastDragAt === 'string' && source.lastDragAt.trim()
    ? source.lastDragAt.slice(0, 64)
    : null;
  const dragFrames = Math.min(1_000_000, Math.trunc(finiteNonNegative(source.dragFrames)));
  const dragAvgFrameMs = Math.min(60_000, finiteNonNegative(source.dragAvgFrameMs));
  const dragMaxFrameMs = Math.min(60_000, finiteNonNegative(source.dragMaxFrameMs));
  return {
    glRenderer,
    isSoftware: source.isSoftware === true || isSoftwareRenderer(glRenderer),
    pixelRatio: Math.min(16, finiteNonNegative(source.pixelRatio)),
    quality,
    partCount: Math.min(100_000_000, Math.trunc(finiteNonNegative(source.partCount))),
    triangleCount: Math.min(1_000_000_000, Math.trunc(finiteNonNegative(source.triangleCount))),
    dragFrames,
    dragAvgFrameMs: Math.round(dragAvgFrameMs * 100) / 100,
    dragMaxFrameMs: Math.round(dragMaxFrameMs * 100) / 100,
    lastDragAt
  };
}

/** 一句中文结论：先讲软件渲染，再讲拖动帧预算。 */
export function describeRenderStats(stats: RenderStats | null): string {
  if (!stats) return '尚未收到渲染指标；请打开 3D 视口并拖动一次。';
  if (stats.isSoftware) {
    return `检测到软件渲染 ${stats.glRenderer || '(未知渲染器)'}，已降级 flow。`;
  }
  if (stats.dragFrames === 0) {
    return `尚未采集到拖动帧；当前 ${stats.quality} 档、${stats.partCount} 个零件、${stats.triangleCount} 个三角形。`;
  }
  const average = stats.dragAvgFrameMs;
  if (average > 33.34) {
    return `平均 ${average} ms/帧，低于 30 fps，拖动会明显不跟手。`;
  }
  if (average > 16.67) {
    return `平均 ${average} ms/帧，低于 60 fps，拖动可能不够跟手。`;
  }
  return `平均 ${average} ms/帧，拖动帧率正常。`;
}
