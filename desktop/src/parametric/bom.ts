// 装配 → BOM → 成本入参的纯函数层：无 DOM、无 IPC，便于单测与面板复用。
import type { CostBomRow } from '../cost/engine.ts';
import {
  toAssembly,
  type AssemblyDoc,
  type FeatureDoc,
  type FeatureNode,
  type PartInstance
} from './features.ts';

export interface BomRow {
  no: number;
  partId?: string;
  name: string;
  spec: string;
  qty: number;
  /** 没有 partId 的合并行必须显式标记，成本侧按 NO_PART_ID 处理。 */
  unmapped?: boolean;
}

export interface CostInputLike {
  bom: CostBomRow[];
}

export const BOM_CSV_BOM = '\uFEFF';
const CSV_HEADER = '序号,物料号,名称,规格,数量,未映射';

function numberText(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function enabled(features: readonly FeatureNode[]): FeatureNode[] {
  return features.filter((feature) => feature.suppressed !== true);
}

function specOf(instance: PartInstance): string {
  const features = enabled(instance.features);
  const box = features.find((feature) => feature.type === 'box');
  if (box) {
    const dims = [box.params.length, box.params.width, box.params.height].map(numberText);
    if (dims.every(Boolean)) return `${dims.join('×')} mm`;
  }
  const cylinder = features.find((feature) => feature.type === 'cylinder');
  if (cylinder) {
    const diameter = numberText(cylinder.params.diameter);
    const height = numberText(cylinder.params.height);
    if (diameter && height) return `Ø${diameter}×${height} mm`;
  }
  return features.length > 0 ? `${features.length} 个特征` : '空实体';
}

/** 相同 partId 合并；无 partId 时按名称合并并标记 unmapped。顺序取首次出现。 */
export function toBom(input: AssemblyDoc | FeatureDoc): BomRow[] {
  const assembly = toAssembly(input);
  const merged = new Map<string, Omit<BomRow, 'no'>>();
  for (const instance of assembly.instances) {
    const partId = typeof instance.partId === 'string' ? instance.partId.trim() : '';
    const name = instance.name.trim() || '未命名';
    const key = partId ? `id:${partId}` : `name:${name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qty += 1;
      continue;
    }
    merged.set(key, {
      ...(partId ? { partId } : {}),
      name,
      spec: specOf(instance),
      qty: 1,
      ...(partId ? {} : { unmapped: true })
    });
  }
  return [...merged.values()].map((row, index) => ({ no: index + 1, ...row }));
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** BOM CSV：UTF-8 BOM + CRLF；未映射列写「是」。 */
export function bomToCsv(rows: readonly BomRow[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push([
      String(row.no),
      row.partId ?? '',
      row.name,
      row.spec,
      String(row.qty),
      row.unmapped ? '是' : ''
    ].map(escapeCsv).join(','));
  }
  return `${BOM_CSV_BOM}${lines.join('\r\n')}\r\n`;
}

/** 直接导出装配 BOM CSV。 */
export function assemblyBomCsv(assembly: AssemblyDoc | FeatureDoc): string {
  return bomToCsv(toBom(assembly));
}

/** 成本面板/`computeCostReport` 共用入参：未映射行不带 partId，绝不猜物料号。 */
export function toCostBomRows(assembly: AssemblyDoc | FeatureDoc): CostBomRow[] {
  return toBom(assembly).map((row) => ({
    ...(row.partId ? { partId: row.partId } : {}),
    name: row.name,
    spec: row.spec,
    qty: row.qty
  }));
}

export function toCostInput(assembly: AssemblyDoc | FeatureDoc): CostInputLike {
  return { bom: toCostBomRows(assembly) };
}

export const toCostReportInput = toCostInput;
