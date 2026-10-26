import type { BomRow } from '../export/bom.ts';
import type { ProjectGeometryReview } from './geometry-review.ts';
import { canSaveAsConcept } from './geometry-review.ts';
import type { DesignReview } from './review.ts';
import type { GeneratedFile } from '../plcgen/types.ts';

export interface GeometryReviewExportNotes {
  bom: string;
  plc: string;
  svg: readonly [string, string];
}

/** Durable, format-specific copy for files that may be separated from the wizard UI. */
export function geometryReviewExportNotes(state: ProjectGeometryReview): GeometryReviewExportNotes {
  if (state.status === 'not-executed') {
    return {
      bom: '【概念版】3D/干涉校核未执行/未验证；不得视为通过；导出不代表验收或发布',
      plc: '【概念版】3D/干涉校核未执行/未验证；不得视为校核通过；导出不代表验收或发布',
      svg: ['【概念版】3D/干涉校核未执行/未验证', '导出不代表验收或发布']
    };
  }
  if (state.status === 'aabb-screened') {
    return {
      bom: '【初步版】仅 AABB 包围盒级干涉初筛；非 B-rep 精检或工程签核；导出不代表验收或发布',
      plc: '【初步版】仅 AABB 包围盒级干涉初筛；非 B-rep 精检或工程签核；导出不代表验收或发布',
      svg: ['【初步版】仅 AABB 包围盒级干涉初筛', '非 B-rep 精检/工程签核；导出不代表验收或发布']
    };
  }
  throw new Error('不支持的几何校核导出状态');
}

/** Keep the BOM schema and rows intact while carrying status in each item's existing remarks column. */
export function annotateBomRowsForGeometryReview(
  rows: readonly BomRow[],
  state: ProjectGeometryReview
): BomRow[] {
  const marker = geometryReviewExportNotes(state).bom;
  return rows.map((row) => ({
    ...row,
    note: row.note ? `${row.note}；${marker}` : marker
  }));
}

/** ST line comments are valid IEC 61131-3 source and remain visible when files are extracted from the PLC ZIP. */
export function annotatePlcFilesForGeometryReview(
  files: readonly GeneratedFile[],
  state: ProjectGeometryReview
): GeneratedFile[] {
  const marker = geometryReviewExportNotes(state).plc;
  return files.map((file) => file.path.toLowerCase().endsWith('.st')
    ? { ...file, content: `// ${marker}\n${file.content}` }
    : file);
}

/** A current review may export only when it has no blocking errors, except for the explicitly savable empty-geometry concept case. */
export function canExportDesignDeliverables(review: DesignReview): boolean {
  return review.errors === 0 || canSaveAsConcept(review);
}
