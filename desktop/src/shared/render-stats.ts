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
  /** 采样期内被丢弃的间隔数：窗口不可见或间隔超出单帧上限（遮挡、最小化、系统挂起），不计入帧统计。 */
  dragDroppedFrames: number;
  /** 最近一次拖动结束时间（ISO 8601）；尚未拖动过为 null。 */
  lastDragAt: string | null;
}

/**
 * 单帧间隔上限。按需渲染下两次 renderNow 之间可能夹着遮挡/最小化/CPU 挂起造成的数秒空档，
 * 超过这个上限的间隔不是「帧时间」，计入会把正常画面算成「平均几秒一帧」。
 */
export const MAX_CREDIBLE_FRAME_MS = 250;

/** 一次拖动采样是否可信：窗口可见，且间隔落在单帧预算内。 */
export function isCredibleFrameSample(deltaMs: unknown, visibility: string | null | undefined): boolean {
  return typeof deltaMs === 'number'
    && Number.isFinite(deltaMs)
    && deltaMs >= 0
    && deltaMs <= MAX_CREDIBLE_FRAME_MS
    && visibility === 'visible';
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
  const dragDroppedFrames = Math.min(1_000_000, Math.trunc(finiteNonNegative(source.dragDroppedFrames)));
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
    dragDroppedFrames,
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
    if (stats.dragDroppedFrames > 0) {
      return `拖动期没有采到可信帧（${stats.dragDroppedFrames} 次间隔因窗口不可见或超出单帧上限被丢弃）；当前 ${stats.quality} 档、${stats.partCount} 个零件、${stats.triangleCount} 个三角形。请保持窗口可见后重新拖动。`;
    }
    return `尚未采集到拖动帧；当前 ${stats.quality} 档、${stats.partCount} 个零件、${stats.triangleCount} 个三角形。`;
  }
  if (stats.dragFrames < 5) {
    return `仅采到 ${stats.dragFrames} 帧（丢弃 ${stats.dragDroppedFrames} 次不可信间隔），样本不足，不下帧率结论。`;
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
