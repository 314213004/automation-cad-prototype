export interface WebGLCanvasLike {
  getContext(contextId: string, options?: Record<string, unknown>): unknown;
}

export interface WebGLProbeResult {
  ok: boolean;
  contextId?: string;
  reason?: string;
}

const CONTEXT_IDS = ['webgl2', 'webgl', 'experimental-webgl'] as const;

/**
 * 纯函数能力探测：不依赖 DOM 全局，便于在 Node 单测中注入假 canvas。
 * 只要任意一个 WebGL 上下文可用即视为支持。
 */
export function probeWebGL(canvasFactory: () => WebGLCanvasLike | null): WebGLProbeResult {
  let canvas: WebGLCanvasLike | null;
  try {
    canvas = canvasFactory();
  } catch (error) {
    return {
      ok: false,
      reason: `创建探测画布失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!canvas) return { ok: false, reason: '无法创建用于 WebGL 探测的画布' };

  const failures: string[] = [];
  for (const contextId of CONTEXT_IDS) {
    try {
      const context = canvas.getContext(contextId);
      if (context) return { ok: true, contextId };
      failures.push(contextId);
    } catch (error) {
      failures.push(`${contextId}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  return {
    ok: false,
    reason: `浏览器未提供 WebGL 上下文：${failures.join('、')}`
  };
}
