// 节点字段编辑（纯逻辑）：把检查器里的字符串输入校验成合法节点，非法就整批拒绝。
//
// 为什么整批拒绝：行程/导程/质量/单步时间是一组耦合参数，只应用一半会让
// 选型结果看着变了其实用的是混合值。要么全过，要么原样返回并给出中文原因。
import type { CanvasNode } from './types.ts';

export type EditableField = 'name' | 'strokeMm' | 'leadMm' | 'massKg' | 'stepSec' | 'orthoX' | 'orthoY';

export interface EditableFieldMeta {
  field: EditableField;
  label: string;
  unit: string;
  kind: 'text' | 'number';
  min?: number;
  max?: number;
  step?: number;
  hint: string;
}

/** 检查器里允许改的字段（其余字段来自元件/端口，不在 P4 手改范围）。 */
export const EDITABLE_FIELDS: readonly EditableFieldMeta[] = [
  { field: 'name', label: '名称', unit: '', kind: 'text', hint: '画布与 BOM 显示用' },
  { field: 'strokeMm', label: '行程', unit: 'mm', kind: 'number', min: 0, step: 1, hint: '直线轴按行程算速度与包络' },
  { field: 'leadMm', label: '导程', unit: 'mm', kind: 'number', min: 0, step: 1, hint: '0 = 无回转传动；>0 才做单轴选型' },
  { field: 'massKg', label: '质量', unit: 'kg', kind: 'number', min: 0, step: 0.1, hint: '影响惯量比、扭矩与挠度' },
  { field: 'stepSec', label: '单步时间', unit: 's', kind: 'number', min: 0, step: 0.05, hint: '只影响甘特与单轴选型，不是整机产能' },
  { field: 'orthoX', label: '正交 X', unit: 'mm', kind: 'number', step: 10, hint: '2D 俯视图毫米坐标，允许负值' },
  { field: 'orthoY', label: '正交 Y', unit: 'mm', kind: 'number', step: 10, hint: '2D 俯视图毫米坐标，允许负值' }
];

export interface EditResult {
  node: CanvasNode;
  errors: string[];
}

function parseNumber(field: EditableFieldMeta, raw: string): { value: number } | { error: string } {
  // 坐标允许负值：EDITABLE_FIELDS 里 orthoX/orthoY 不设 min/max

  const text = raw.trim();
  if (text === '') return { error: `${field.label}不能为空（${field.unit}）` };
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: `${field.label}必须是数字（${field.unit}）` };
  if (field.min !== undefined && value < field.min) return { error: `${field.label}不能小于 ${field.min}${field.unit}` };
  if (field.max !== undefined && value > field.max) return { error: `${field.label}不能大于 ${field.max}${field.unit}` };
  return { value };
}

/**
 * 用一组原始输入（来自 <input>）更新节点。任何一项非法 → 整批拒绝，返回原节点。
 * 不就地修改入参。
 */
export function applyNodePatch(node: CanvasNode, patch: Partial<Record<EditableField, string>>): EditResult {
  const errors: string[] = [];
  const next: CanvasNode = {
    ...node,
    portIn: { ...node.portIn },
    portOut: { ...node.portOut },
    dimsMm: [node.dimsMm[0], node.dimsMm[1], node.dimsMm[2]],
    io: { ...node.io },
    pos: { ...node.pos },
    ortho: { ...node.ortho },
    ...(node.adapterParams === undefined
      ? {}
      : {
          adapterParams: {
            ...node.adapterParams,
            fromPort: { ...node.adapterParams.fromPort },
            toPort: { ...node.adapterParams.toPort },
            plateDimsMm: [
              node.adapterParams.plateDimsMm[0],
              node.adapterParams.plateDimsMm[1],
              node.adapterParams.plateDimsMm[2]
            ] as [number, number, number]
          }
        })
  };

  for (const meta of EDITABLE_FIELDS) {
    const raw = patch[meta.field];
    if (raw === undefined) continue;
    if (meta.kind === 'text') {
      const text = raw.trim();
      if (text === '') {
        errors.push(`${meta.label}不能为空`);
        continue;
      }
      if (text.length > 80) {
        errors.push(`${meta.label}最多 80 个字符`);
        continue;
      }
      next.name = text;
      continue;
    }
    const parsed = parseNumber(meta, raw);
    if ('error' in parsed) {
      errors.push(parsed.error);
      continue;
    }
    if (meta.field === 'strokeMm') next.strokeMm = parsed.value;
    else if (meta.field === 'leadMm') next.leadMm = parsed.value;
    else if (meta.field === 'massKg') next.massKg = parsed.value;
    else if (meta.field === 'stepSec') next.stepSec = parsed.value;
    else if (meta.field === 'orthoX') next.ortho.x = parsed.value;
    else if (meta.field === 'orthoY') next.ortho.y = parsed.value;
  }

  if (errors.length > 0) return { node, errors };
  return { node: next, errors: [] };
}

/** 判断这组编辑是否真的改了值（用于「没变就别写草稿」）。 */
export function patchChangesNode(node: CanvasNode, patch: Partial<Record<EditableField, string>>): boolean {
  const result = applyNodePatch(node, patch);
  if (result.errors.length > 0) return false;
  const next = result.node;
  return (
    next.name !== node.name ||
    next.strokeMm !== node.strokeMm ||
    next.leadMm !== node.leadMm ||
    next.massKg !== node.massKg ||
    next.stepSec !== node.stepSec ||
    next.ortho.x !== node.ortho.x ||
    next.ortho.y !== node.ortho.y
  );
}
