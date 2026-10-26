import type { DesignReview } from './review.ts';

/** 项目记录中可持久化的几何校核状态；不表示完整的型号级 CAD / B-rep 签核。 */
export type ProjectGeometryReview =
  | { status: 'not-executed'; partCount: 0 }
  | { status: 'aabb-screened'; partCount: number; method: 'AABB'; sourceName?: string; checkedAt: string };

export type SceneGeometrySource = 'empty' | 'imported-model' | 'concept-placeholder' | 'saved-model';

export interface DesignSceneInfo {
  source: SceneGeometrySource;
  sourceName?: string;
}

/** 空场景仍是校核 error；仅当它是唯一 error 时，才允许用户显式存成概念版。 */
export function canSaveAsConcept(review: DesignReview): boolean {
  if (review.geometryCheck !== 'not-executed') return false;
  const errors = review.items.filter((item) => item.severity === 'error');
  return errors.length === 1 && errors[0]?.title === '干涉初筛未执行';
}

export function projectGeometryReviewFrom(
  review: DesignReview,
  scene: DesignSceneInfo,
  partCount: number,
  checkedAt = new Date().toISOString()
): ProjectGeometryReview {
  if (review.geometryCheck === 'not-executed' || partCount < 1 || scene.source === 'empty' || scene.source === 'concept-placeholder') {
    return { status: 'not-executed', partCount: 0 };
  }
  return {
    status: 'aabb-screened',
    partCount,
    method: 'AABB',
    ...(scene.sourceName ? { sourceName: scene.sourceName } : {}),
    checkedAt
  };
}

export function projectGeometryReviewLabel(state: ProjectGeometryReview | undefined): string {
  if (!state || state.status === 'not-executed') return '3D/干涉校核未执行（未验证）';
  return `包围盒级干涉初筛已执行（${state.partCount} 件；非 B-rep 精检或工程签核）`;
}

/** 重开向导工程时指出校核针对的是先前导入的 CAD，而工程 STL 仍是概念占位体。 */
export function reopenedGeometryReviewMessage(state: ProjectGeometryReview | undefined): string {
  if (!state || state.status === 'not-executed') {
    return '3D/干涉校核未执行/未验证。此工程的向导 STL 是概念估算占位体，不是型号级 CAD；请点“打开文件”导入真实 CAD，再打开“整机设计”并运行一键校核。';
  }
  const source = state.sourceName ? `（来源：${state.sourceName}）` : '';
  return `曾对导入几何${source}执行包围盒级干涉初筛（${state.partCount} 件），这不是 B-rep 精检或工程签核；当前工程仍保存向导概念占位体。请点“打开文件”重新导入 CAD，并在“整机设计”中再次校核。`;
}

export function isProjectGeometryReview(value: unknown): value is ProjectGeometryReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (state.status === 'not-executed') return state.partCount === 0;
  if (state.status !== 'aabb-screened' || state.method !== 'AABB') return false;
  if (!Number.isSafeInteger(state.partCount) || Number(state.partCount) < 1) return false;
  if (typeof state.checkedAt !== 'string' || !Number.isFinite(Date.parse(state.checkedAt))) return false;
  return state.sourceName === undefined || (typeof state.sourceName === 'string' && state.sourceName.length <= 1024);
}
