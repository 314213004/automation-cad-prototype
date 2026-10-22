export type FeatureType = 'box' | 'cylinder' | 'holes' | 'slot' | 'fillet';

export interface FeatureNode {
  id: string;
  type: FeatureType;
  name: string;
  params: Record<string, unknown>;
  suppressed?: boolean;
}

export interface FeatureDoc {
  schemaVersion: 1;
  sourceFile?: string;
  features: FeatureNode[];
  updatedAt: string;
}

type UnknownRecord = Record<string, unknown>;

const FEATURE_TYPES: readonly FeatureType[] = ['box', 'cylinder', 'holes', 'slot', 'fillet'];
const TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(Math.round(value * 100) / 100);
}

function featureLabel(node: UnknownRecord, index: number): string {
  const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : '未命名';
  return `第 ${index + 1} 个特征（${name}）`;
}

function paramNumber(
  params: UnknownRecord,
  key: string,
  label: string,
  errors: string[],
  options: { allowZero?: boolean; allowNegative?: boolean } = {}
): number | null {
  const value = params[key];
  if (value === undefined) {
    errors.push(`${label}：缺少必填参数「${key}」`);
    return null;
  }
  if (!isFiniteNumber(value)) {
    errors.push(`${label}：参数「${key}」必须是数字`);
    return null;
  }
  if (options.allowNegative ? value === 0 : options.allowZero ? value < 0 : value <= 0) {
    const rule = options.allowNegative ? '不能为 0' : options.allowZero ? '不能为负数' : '必须大于 0';
    errors.push(`${label}：参数「${key}」${rule}`);
    return null;
  }
  return value;
}

function vector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  return [x, y, z];
}

function positionsOf(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const positions: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [x, y] = item;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    positions.push([x, y]);
  }
  return positions;
}

function collectPlate(doc: FeatureDoc): { minX: number; maxX: number; minY: number; maxY: number; thickness: number } | null {
  let plate: { minX: number; maxX: number; minY: number; maxY: number; thickness: number } | null = null;
  for (const node of Array.isArray(doc.features) ? doc.features : []) {
    if (!isRecord(node) || node.type !== 'box' || node.suppressed === true) continue;
    const params = isRecord(node.params) ? node.params : {};
    const length = params.length;
    const width = params.width;
    const height = params.height;
    if (!positiveNumber(length) || !positiveNumber(width) || !positiveNumber(height)) continue;
    const centered = params.centered !== false;
    const minX = centered ? -length / 2 : 0;
    const minY = centered ? -width / 2 : 0;
    if (!plate) {
      plate = { minX, maxX: minX + length, minY, maxY: minY + width, thickness: height };
    } else {
      plate.thickness = Math.min(plate.thickness, height);
    }
  }
  return plate;
}

/** 校验整棵特征树，返回全部中文错误；空数组表示可以编译。 */
export function validateFeatures(doc: FeatureDoc): string[] {
  const errors: string[] = [];
  const raw = doc as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.features)) {
    errors.push('特征树格式无效：features 必须是数组');
    return errors;
  }
  const features = raw.features;
  if (features.length === 0) errors.push('特征树为空，至少需要一个特征');

  const ids = new Map<string, number>();
  let plate: ReturnType<typeof collectPlate> = null;
  try {
    plate = collectPlate(raw as unknown as FeatureDoc);
  } catch {
    plate = null;
  }

  features.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`第 ${index + 1} 个特征：必须是对象`);
      return;
    }
    const label = featureLabel(value, index);
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id) {
      errors.push(`${label}：缺少特征 id`);
    } else if (ids.has(id)) {
      errors.push(`${label}：id「${id}」与第 ${(ids.get(id) ?? index) + 1} 个特征重复`);
    } else {
      ids.set(id, index);
    }

    const type = value.type;
    if (typeof type !== 'string' || !FEATURE_TYPES.includes(type as FeatureType)) {
      errors.push(`${label}：未知特征类型「${String(type ?? '')}」`);
      return;
    }
    const params = isRecord(value.params) ? value.params : {};
    if (!isRecord(value.params)) errors.push(`${label}：参数 params 必须是对象`);

    if (type === 'box') {
      paramNumber(params, 'length', label, errors);
      paramNumber(params, 'width', label, errors);
      paramNumber(params, 'height', label, errors);
      if (params.centered !== undefined && typeof params.centered !== 'boolean') {
        errors.push(`${label}：参数「centered」必须是布尔值`);
      }
      return;
    }

    if (type === 'cylinder') {
      paramNumber(params, 'diameter', label, errors);
      paramNumber(params, 'height', label, errors);
      if (params.at !== undefined && vector3(params.at) === null) {
        errors.push(`${label}：参数「at」必须是 3 个数字组成的数组`);
      }
      return;
    }

    if (type === 'holes') {
      const diameter = paramNumber(params, 'diameter', label, errors);
      const positions = positionsOf(params.positions);
      if (params.positions === undefined) {
        errors.push(`${label}：缺少必填参数「positions」`);
      } else if (!Array.isArray(params.positions)) {
        errors.push(`${label}：参数「positions」必须是孔位数组`);
      } else if (params.positions.length === 0) {
        errors.push(`${label}：孔位不能为空`);
      } else if (positions === null) {
        errors.push(`${label}：参数「positions」必须是 [x, y] 二元数组`);
      }
      if (params.depth !== undefined && params.depth !== 'through' && !positiveNumber(params.depth)) {
        errors.push(`${label}：参数「depth」必须是 through 或大于 0 的数字`);
      }
      if (positions && plate) {
        const outside = positions.find(([x, y]) =>
          x < plate.minX || x > plate.maxX || y < plate.minY || y > plate.maxY);
        if (outside) {
          errors.push(`${label}：孔 (${formatMm(outside[0])}, ${formatMm(outside[1])}) 在底板包围盒外`);
        }
      }
      if (positions && diameter !== null) {
        for (let first = 0; first < positions.length; first += 1) {
          for (let second = first + 1; second < positions.length; second += 1) {
            const a = positions[first]!;
            const b = positions[second]!;
            const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (distance < diameter) {
              errors.push(`${label}：孔间距 ${formatMm(distance)} mm 小于孔径 ${formatMm(diameter)} mm`);
            }
          }
        }
      }
      return;
    }

    if (type === 'slot') {
      paramNumber(params, 'length', label, errors);
      paramNumber(params, 'width', label, errors);
      return;
    }

    const radius = paramNumber(params, 'radius', label, errors);
    if (params.edges !== undefined && params.edges !== '|Z' && params.edges !== 'all') {
      errors.push(`${label}：参数「edges」必须是 |Z 或 all`);
    }
    if (radius !== null && plate && radius > plate.thickness / 2) {
      errors.push(
        `${label}：圆角半径 ${formatMm(radius)} mm 超过最小板厚 ${formatMm(plate.thickness)} mm 的一半（${formatMm(plate.thickness / 2)} mm）`
      );
    }
  });

  const updatedAt = raw.updatedAt;
  if (typeof updatedAt !== 'string' || !updatedAt.trim()) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  } else if (!TIMEZONE_PATTERN.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  }
  return errors;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

/** 将特征树编译为 sidecar 白名单算子；跳过抑制项，保持特征树顺序。 */
export function compileOps(doc: FeatureDoc): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  for (const node of Array.isArray(doc?.features) ? doc.features : []) {
    if (!isRecord(node) || node.suppressed === true) continue;
    const params = isRecord(node.params) ? node.params : {};
    const type = node.type;
    if (type === 'box') {
      ops.push({
        op: 'box',
        length: params.length,
        width: params.width,
        height: params.height,
        ...(typeof params.centered === 'boolean' ? { centered: params.centered } : {})
      });
    } else if (type === 'cylinder') {
      ops.push({
        op: 'cylinder',
        diameter: params.diameter,
        height: params.height,
        ...(params.at !== undefined ? { at: clone(params.at) } : {})
      });
    } else if (type === 'holes') {
      ops.push({
        op: 'holes',
        diameter: params.diameter,
        positions: clone(params.positions),
        ...(params.depth !== undefined ? { depth: params.depth } : {})
      });
    } else if (type === 'slot') {
      ops.push({ op: 'slot', length: params.length, width: params.width });
    } else if (type === 'fillet') {
      ops.push({
        op: 'fillet',
        radius: params.radius,
        ...(params.edges !== undefined ? { edges: params.edges } : {})
      });
    } else {
      throw new Error(`未知特征类型「${String(type)}」`);
    }
  }
  return ops;
}

/** 特征总数、预计孔数与抑制数；孔数只统计参与编译的孔位。 */
export function summarize(doc: FeatureDoc): { features: number; holes: number; suppressed: number } {
  const features = Array.isArray(doc?.features) ? doc.features : [];
  let holes = 0;
  let suppressed = 0;
  for (const node of features) {
    if (!isRecord(node)) continue;
    if (node.suppressed === true) {
      suppressed += 1;
      continue;
    }
    if (node.type === 'holes' && isRecord(node.params) && Array.isArray(node.params.positions)) {
      holes += node.params.positions.length;
    }
  }
  return { features: features.length, holes, suppressed };
}

export function emptyDoc(): FeatureDoc {
  return { schemaVersion: 1, features: [], updatedAt: new Date().toISOString() };
}
