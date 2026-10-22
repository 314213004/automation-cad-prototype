// 边界说明：STEP / IGES 只提供几何与装配名称，不包含轴、行程、方向或点位。
// 本模块是「人工标注层」：把 STEP 里的动件网格名，绑定到运动轴、行程与 PLC 点位。
// 不做机构自动识别，不猜运动学；校验只针对标注本身是否自洽、是否指向真实零件与点位。

export type KinematicsKind = 'linear' | 'rotary';
export type KinematicsAxisName = 'x' | 'y' | 'z';
export type KinematicsRole = 'extend' | 'retract' | 'rotate';

export interface KinematicsBinding {
  role: KinematicsRole;
  point: string;
}

export interface KinematicsAxis {
  /** STEP 网格名（动件），保存为导入时的原始名称 */
  part: string;
  kind: KinematicsKind;
  axis: KinematicsAxisName;
  /** 直线轴行程（mm），kind=linear 必填 */
  travelMm?: number;
  /** 缩回状态的位移读数（mm），默认 0，必须小于 travelMm */
  retractedMm?: number;
  /** 旋转轴角度范围（deg），kind=rotary 必填 */
  rangeDeg?: number;
  /** 运动方向：1 沿轴正向伸出，-1 沿负向；默认 1 */
  direction?: 1 | -1;
  bindings: KinematicsBinding[];
}

export interface KinematicsDoc {
  schemaVersion: 1;
  units: 'mm';
  axes: KinematicsAxis[];
}

export interface KinematicsIssue {
  code: string;
  level: 'error' | 'warning';
  message: string;
  part?: string;
}

export interface KinematicsStats {
  axes: number;
  linear: number;
  rotary: number;
  boundPoints: number;
  totalTravelMm: number;
}

export interface KinematicsOptions {
  /** 当前 STEP 导入的零件名；提供时校验动件是否存在 */
  partNames?: readonly string[];
  /** 权威 IO 点位表；提供时校验绑定点位是否存在 */
  knownPoints?: readonly string[];
  /** 行程上限（mm），默认 20000 */
  maxTravelMm?: number;
  /** 旋转角度上限（deg），默认 3600 */
  maxRangeDeg?: number;
}

export interface KinematicsCheck {
  doc: KinematicsDoc;
  issues: KinematicsIssue[];
  errors: KinematicsIssue[];
  warnings: KinematicsIssue[];
  stats: KinematicsStats;
  ok: boolean;
}

export interface AxisPose {
  part: string;
  kind: KinematicsKind;
  axis: KinematicsAxisName;
  /** 直线：当前位移 mm；旋转：当前角度 deg */
  amount: number;
  unit: 'mm' | 'deg';
  /** 相对原点的位移向量（mm）；旋转轴为 [0,0,0] */
  offset: [number, number, number];
  /** 旋转角度（弧度），直线轴为 0 */
  rotationRad: number;
  source: 'idle' | 'extend' | 'retract' | 'rotate';
  /** 伸展与缩回信号同时为真：传感器/接线冲突，需人工确认 */
  conflict: boolean;
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_MAX_TRAVEL_MM = 20000;
const DEFAULT_MAX_RANGE_DEG = 3600;
const AXIS_NAMES: readonly KinematicsAxisName[] = ['x', 'y', 'z'];
const ROLES: readonly KinematicsRole[] = ['extend', 'retract', 'rotate'];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyKinematicsDoc(): KinematicsDoc {
  return { schemaVersion: 1, units: 'mm', axes: [] };
}

export function normalizePoint(point: string): string {
  return point.trim().toUpperCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readPositive(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

function findPartName(partNames: readonly string[] | undefined, raw: string): string | null {
  if (!partNames) return raw;
  const key = raw.trim().toLowerCase();
  for (const name of partNames) {
    if (name.trim().toLowerCase() === key) return name;
  }
  return null;
}

function findKnownPoint(knownPoints: readonly string[] | undefined, point: string): string | null {
  if (!knownPoints) return point;
  const key = normalizePoint(point);
  for (const candidate of knownPoints) {
    if (normalizePoint(candidate) === key) return candidate.trim();
  }
  return null;
}

/** 统计标注规模；对非法字段按「已标注」处理，仅用于展示。 */
export function kinematicsStats(doc: KinematicsDoc): KinematicsStats {
  const points = new Set<string>();
  let linear = 0;
  let rotary = 0;
  let totalTravelMm = 0;
  for (const axis of doc.axes) {
    if (axis.kind === 'linear') {
      linear += 1;
      totalTravelMm += axis.travelMm ?? 0;
    } else {
      rotary += 1;
    }
    for (const binding of axis.bindings) points.add(normalizePoint(binding.point));
  }
  return {
    axes: doc.axes.length,
    linear,
    rotary,
    boundPoints: points.size,
    totalTravelMm: Math.round(totalTravelMm * 1000) / 1000
  };
}

/**
 * 校验并归一化运动学标注。不抛异常：所有问题以 issue 返回，UI 可直接列给用户。
 * 错误（error）表示标注不可用；警告（warning）表示能跑但工程上应确认。
 */
export function checkKinematics(input: unknown, options: KinematicsOptions = {}): KinematicsCheck {
  const issues: KinematicsIssue[] = [];
  const push = (code: string, level: 'error' | 'warning', message: string, part?: string): void => {
    issues.push(part === undefined ? { code, level, message } : { code, level, message, part });
  };

  const fail = (): KinematicsCheck => {
    const doc = emptyKinematicsDoc();
    const errors = issues.filter((issue) => issue.level === 'error');
    return {
      doc,
      issues,
      errors,
      warnings: issues.filter((issue) => issue.level === 'warning'),
      stats: kinematicsStats(doc),
      ok: errors.length === 0
    };
  };

  if (!isRecord(input)) {
    push('doc.invalid', 'error', '运动学标注必须是对象');
    return fail();
  }
  if (input.schemaVersion !== 1) {
    push('doc.schema', 'error', '运动学标注 schemaVersion 必须为 1');
  }
  if (input.units !== undefined && input.units !== 'mm') {
    push('doc.units', 'error', '运动学标注单位只能是 mm（旋转角度以 deg 记录）');
  }
  if (!Array.isArray(input.axes)) {
    push('doc.axes', 'error', '运动学标注缺少 axes 数组');
    return fail();
  }

  const maxTravel = options.maxTravelMm ?? DEFAULT_MAX_TRAVEL_MM;
  const maxRange = options.maxRangeDeg ?? DEFAULT_MAX_RANGE_DEG;
  const partSeen = new Map<string, string>();
  const pointSeen = new Map<string, string>();
  const axes: KinematicsAxis[] = [];
  const rawAxes = input.axes;

  for (const [index, raw] of rawAxes.entries()) {
    if (!isRecord(raw)) {
      push('axis.invalid', 'error', `axes[${index}] 必须是对象`);
      continue;
    }

    const rawPart = raw.part;
    if (typeof rawPart !== 'string' || rawPart.trim() === '') {
      push('axis.part.missing', 'error', `axes[${index}] 缺少动件名称 part`);
      continue;
    }
    const partName = findPartName(options.partNames, rawPart);
    if (partName === null) {
      push('axis.part.unknown', 'error', `动件「${rawPart.trim()}」不在当前导入的零件中`, rawPart.trim());
      continue;
    }
    const partKey = partName.trim().toLowerCase();
    const previous = partSeen.get(partKey);
    if (previous !== undefined) {
      push('axis.part.duplicate', 'error', `动件「${partName}」重复标注：一个动件只能绑定一个运动轴`, partName);
      continue;
    }
    partSeen.set(partKey, partName);

    const kind = raw.kind;
    if (kind !== 'linear' && kind !== 'rotary') {
      push('axis.kind', 'error', `动件「${partName}」的运动类型必须是 linear 或 rotary`, partName);
      continue;
    }

    const rawAxisName = raw.axis;
    const axisName =
      typeof rawAxisName === 'string' ? (rawAxisName.trim().toLowerCase() as KinematicsAxisName) : null;
    if (!axisName || !AXIS_NAMES.includes(axisName)) {
      push('axis.name', 'error', `动件「${partName}」的轴必须是 X、Y 或 Z`, partName);
      continue;
    }

    const axis: KinematicsAxis = { part: partName, kind, axis: axisName, bindings: [] };
    let axisBroken = false;

    if (kind === 'linear') {
      if (raw.rangeDeg !== undefined) {
        push('axis.range.unexpected', 'error', `直线动件「${partName}」不应填写 rangeDeg（角度）`, partName);
        axisBroken = true;
      }
      const travel = readPositive(raw.travelMm);
      if (travel === null) {
        push('axis.travel.invalid', 'error', `直线动件「${partName}」的行程 travelMm 必须是大于 0 的数字`, partName);
        axisBroken = true;
      } else if (travel > maxTravel) {
        push('axis.travel.tooLarge', 'error', `直线动件「${partName}」行程 ${travel} mm 超出上限 ${maxTravel} mm`, partName);
        axisBroken = true;
      } else {
        axis.travelMm = travel;
      }
      const retractedRaw = raw.retractedMm;
      if (retractedRaw === undefined) {
        axis.retractedMm = 0;
      } else if (!isFiniteNumber(retractedRaw) || retractedRaw < 0) {
        push('axis.retracted.invalid', 'error', `动件「${partName}」的缩回位置 retractedMm 必须是不小于 0 的数字`, partName);
        axisBroken = true;
      } else if (axis.travelMm !== undefined && retractedRaw >= axis.travelMm) {
        push(
          'axis.retracted.range',
          'error',
          `动件「${partName}」缩回位置 ${retractedRaw} mm 必须小于行程 ${axis.travelMm} mm`,
          partName
        );
        axisBroken = true;
      } else {
        axis.retractedMm = retractedRaw;
      }
    } else {
      if (raw.travelMm !== undefined) {
        push('axis.travel.unexpected', 'error', `旋转动件「${partName}」不应填写 travelMm（行程），请用 rangeDeg`, partName);
        axisBroken = true;
      }
      if (raw.retractedMm !== undefined) {
        push('axis.retracted.unexpected', 'error', `旋转动件「${partName}」不应填写 retractedMm`, partName);
        axisBroken = true;
      }
      const range = readPositive(raw.rangeDeg);
      if (range === null) {
        push('axis.range.invalid', 'error', `旋转动件「${partName}」的角度范围 rangeDeg 必须是大于 0 的数字`, partName);
        axisBroken = true;
      } else if (range > maxRange) {
        push('axis.range.tooLarge', 'error', `旋转动件「${partName}」角度 ${range}° 超出上限 ${maxRange}°`, partName);
        axisBroken = true;
      } else {
        axis.rangeDeg = range;
      }
    }

    if (raw.direction !== undefined) {
      if (raw.direction !== 1 && raw.direction !== -1) {
        push('axis.direction', 'error', `动件「${partName}」的 direction 只能是 1 或 -1`, partName);
        axisBroken = true;
      } else {
        axis.direction = raw.direction;
      }
    }

    if (!Array.isArray(raw.bindings)) {
      push('axis.bindings.missing', 'error', `动件「${partName}」缺少 bindings 数组`, partName);
      axisBroken = true;
    } else if (raw.bindings.length === 0) {
      push('axis.bindings.empty', 'error', `动件「${partName}」至少需要绑定一个点位`, partName);
      axisBroken = true;
    } else {
      const roleSeen = new Set<string>();
      for (const [bindingIndex, rawBinding] of raw.bindings.entries()) {
        if (!isRecord(rawBinding)) {
          push('binding.invalid', 'error', `动件「${partName}」bindings[${bindingIndex}] 必须是对象`, partName);
          axisBroken = true;
          continue;
        }
        const role = rawBinding.role;
        if (typeof role !== 'string' || !ROLES.includes(role as KinematicsRole)) {
          push('binding.role', 'error', `动件「${partName}」的绑定角色必须是 extend、retract 或 rotate`, partName);
          axisBroken = true;
          continue;
        }
        const normalizedRole = role as KinematicsRole;
        const allowed = kind === 'linear' ? normalizedRole === 'extend' || normalizedRole === 'retract' : normalizedRole === 'rotate';
        if (!allowed) {
          push(
            'binding.roleMismatch',
            'error',
            kind === 'linear'
              ? `直线动件「${partName}」不能绑定 ${normalizedRole} 角色（只能是 extend / retract）`
              : `旋转动件「${partName}」只能绑定 rotate 角色`,
            partName
          );
          axisBroken = true;
          continue;
        }
        if (roleSeen.has(normalizedRole)) {
          push('binding.roleDuplicate', 'error', `动件「${partName}」的 ${normalizedRole} 角色重复绑定`, partName);
          axisBroken = true;
          continue;
        }
        roleSeen.add(normalizedRole);

        const rawPoint = rawBinding.point;
        if (typeof rawPoint !== 'string' || rawPoint.trim() === '') {
          push('binding.point', 'error', `动件「${partName}」的 ${normalizedRole} 绑定缺少点位`, partName);
          axisBroken = true;
          continue;
        }
        const knownPoint = findKnownPoint(options.knownPoints, rawPoint);
        if (knownPoint === null) {
          push('binding.pointUnknown', 'error', `点位「${rawPoint.trim()}」不在当前 IO 点位表中`, partName);
          axisBroken = true;
          continue;
        }
        const pointKey = normalizePoint(knownPoint);
        const owner = pointSeen.get(pointKey);
        if (owner !== undefined) {
          push('binding.pointDuplicate', 'error', `点位「${knownPoint}」已被动件「${owner}」占用，同一个点位只能绑定一个动件`, partName);
          axisBroken = true;
          continue;
        }
        pointSeen.set(pointKey, partName);
        axis.bindings.push({ role: normalizedRole, point: knownPoint });
      }

      if (kind === 'linear') {
        if (!roleSeen.has('extend')) {
          push('binding.extendMissing', 'error', `直线动件「${partName}」缺少 extend 绑定，无法判断伸出`, partName);
          axisBroken = true;
        }
        if (!roleSeen.has('retract')) {
          push('binding.retractMissing', 'warning', `动件「${partName}」没有 retract 绑定，缩回状态将按 retractedMm 推断`, partName);
        }
      }
    }

    if (!axisBroken || axis.travelMm !== undefined || axis.rangeDeg !== undefined) axes.push(axis);
  }

  const doc: KinematicsDoc = { schemaVersion: 1, units: 'mm', axes };
  const errors = issues.filter((issue) => issue.level === 'error');
  return {
    doc,
    issues,
    errors,
    warnings: issues.filter((issue) => issue.level === 'warning'),
    stats: kinematicsStats(doc),
    ok: errors.length === 0
  };
}

/** 严格模式：任一错误即抛出第一条中文提示，供命令行/智能体工具使用。 */
export function assertKinematics(input: unknown, options: KinematicsOptions = {}): KinematicsDoc {
  const check = checkKinematics(input, options);
  if (check.ok) return check.doc;
  const first = check.errors[0];
  const rest = check.errors.length > 1 ? `（共 ${check.errors.length} 项错误）` : '';
  throw new Error(`运动学标注校验失败：${first?.message ?? '未知错误'}${rest}`);
}

function pointIsOn(values: Record<string, boolean | number>, point: string | undefined): boolean {
  if (!point) return false;
  if (values[point] === true) return true;
  const key = normalizePoint(point);
  if (values[key] === true) return true;
  for (const [candidate, value] of Object.entries(values)) {
    if (value === true && normalizePoint(candidate) === key) return true;
  }
  return false;
}

function bindingPoint(axis: KinematicsAxis, role: KinematicsRole): string | undefined {
  return axis.bindings.find((binding) => binding.role === role)?.point;
}

/** 按当前点位状态解算单轴姿态。双信号同时为真时标记 conflict，并按伸出优先。 */
export function axisPose(axis: KinematicsAxis, values: Record<string, boolean | number>): AxisPose {
  const direction = axis.direction ?? 1;
  const offset: [number, number, number] = [0, 0, 0];

  if (axis.kind === 'rotary') {
    const rotate = pointIsOn(values, bindingPoint(axis, 'rotate'));
    const amount = rotate ? axis.rangeDeg ?? 0 : 0;
    return {
      part: axis.part,
      kind: 'rotary',
      axis: axis.axis,
      amount,
      unit: 'deg',
      offset,
      rotationRad: (amount * Math.PI) / 180,
      source: rotate ? 'rotate' : 'idle',
      conflict: false
    };
  }

  const extend = pointIsOn(values, bindingPoint(axis, 'extend'));
  const retract = pointIsOn(values, bindingPoint(axis, 'retract'));
  const retracted = axis.retractedMm ?? 0;
  let amount = retracted;
  let source: AxisPose['source'] = 'idle';
  if (extend) {
    amount = axis.travelMm ?? 0;
    source = 'extend';
  } else if (retract) {
    amount = retracted;
    source = 'retract';
  }
  const signed = amount * direction;
  if (axis.axis === 'x') offset[0] = signed;
  else if (axis.axis === 'y') offset[1] = signed;
  else offset[2] = signed;

  return {
    part: axis.part,
    kind: 'linear',
    axis: axis.axis,
    amount,
    unit: 'mm',
    offset,
    rotationRad: 0,
    source,
    conflict: extend && retract
  };
}

export function axisPoses(doc: KinematicsDoc, values: Record<string, boolean | number>): AxisPose[] {
  return doc.axes.map((axis) => axisPose(axis, values));
}

/** 新增或替换（按动件名，忽略大小写）一条轴标注，返回新文档，不修改入参。 */
export function upsertAxis(doc: KinematicsDoc, axis: KinematicsAxis): KinematicsDoc {
  const key = axis.part.trim().toLowerCase();
  const axes = doc.axes.filter((item) => item.part.trim().toLowerCase() !== key);
  axes.push({ ...axis, bindings: axis.bindings.map((binding) => ({ ...binding })) });
  return { ...doc, axes };
}

export function removeAxis(doc: KinematicsDoc, part: string): KinematicsDoc {
  const key = part.trim().toLowerCase();
  return { ...doc, axes: doc.axes.filter((item) => item.part.trim().toLowerCase() !== key) };
}

/** 覆盖同一角色的点位绑定；动件不存在时抛错，避免静默丢改动。 */
export function setBinding(doc: KinematicsDoc, part: string, binding: KinematicsBinding): KinematicsDoc {
  const key = part.trim().toLowerCase();
  const target = doc.axes.find((item) => item.part.trim().toLowerCase() === key);
  if (!target) throw new Error(`动件「${part}」尚未标注，无法绑定点位`);
  const bindings = target.bindings.filter((item) => item.role !== binding.role);
  bindings.push({ role: binding.role, point: binding.point.trim() });
  return upsertAxis(doc, { ...target, bindings });
}

export function removeBinding(doc: KinematicsDoc, part: string, role: KinematicsRole): KinematicsDoc {
  const key = part.trim().toLowerCase();
  const target = doc.axes.find((item) => item.part.trim().toLowerCase() === key);
  if (!target) return doc;
  return upsertAxis(doc, { ...target, bindings: target.bindings.filter((item) => item.role !== role) });
}

/**
 * 与机型配置交叉核对：行程不一致、执行机构类型冲突、点位未绑定动件。
 * config 结构按 commission/machine-config.ts 的最小子集读取，避免循环依赖。
 */
export function crossCheckMachineConfig(
  doc: KinematicsDoc,
  config: {
    actuators: readonly {
      id: string;
      name: string;
      kind: string;
      travelMm?: number;
      extendPoint?: string;
      retractPoint?: string;
      gripPoint?: string;
      point?: string;
    }[];
  },
  toleranceMm = 0.5
): KinematicsIssue[] {
  const issues: KinematicsIssue[] = [];
  const byPoint = new Map<string, KinematicsAxis>();
  for (const axis of doc.axes) {
    for (const binding of axis.bindings) byPoint.set(normalizePoint(binding.point), axis);
  }

  const unbound: string[] = [];
  for (const actuator of config.actuators) {
    const points = [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point].filter(
      (point): point is string => typeof point === 'string' && point.trim() !== ''
    );
    const matched: KinematicsAxis[] = [];
    for (const point of points) {
      const axis = byPoint.get(normalizePoint(point));
      if (axis && !matched.includes(axis)) matched.push(axis);
    }
    if (matched.length === 0) {
      unbound.push(actuator.name);
      continue;
    }
    for (const axis of matched) {
      const rotaryActuator = actuator.kind === 'rotary';
      if (rotaryActuator && axis.kind !== 'rotary') {
        issues.push({
          code: 'config.kindMismatch',
          level: 'warning',
          message: `执行机构「${actuator.name}」是旋转轴，但动件「${axis.part}」标注为直线轴`,
          part: axis.part
        });
      } else if (!rotaryActuator && axis.kind === 'rotary') {
        issues.push({
          code: 'config.kindMismatch',
          level: 'warning',
          message: `执行机构「${actuator.name}」是${actuator.kind === 'gripper' ? '夹爪' : '气缸'}，但动件「${axis.part}」标注为旋转轴`,
          part: axis.part
        });
      }
      if (rotaryActuator || axis.kind !== 'linear') continue;
      if (typeof actuator.travelMm !== 'number' || axis.travelMm === undefined) continue;
      const diff = Math.abs(actuator.travelMm - axis.travelMm);
      if (diff > toleranceMm) {
        issues.push({
          code: 'config.travelMismatch',
          level: 'warning',
          message: `执行机构「${actuator.name}」配置行程 ${actuator.travelMm} mm，与动件「${axis.part}」标注行程 ${axis.travelMm} mm 不一致（差 ${Math.round(diff * 100) / 100} mm）`,
          part: axis.part
        });
      }
    }
  }

  if (unbound.length > 0) {
    const sample = unbound.slice(0, 3).join('、');
    const more = unbound.length > 3 ? ` 等 ${unbound.length} 个` : '';
    issues.push({
      code: 'config.unboundActuator',
      level: 'warning',
      message: `机型配置中有执行机构未绑定动件：${sample}${more}`
    });
  }
  return issues;
}

export function serializeKinematics(doc: KinematicsDoc): string {
  return `${JSON.stringify({ schemaVersion: 1, units: 'mm', axes: doc.axes }, null, 2)}\n`;
}

function invalidJsonCheck(message: string): KinematicsCheck {
  const doc = emptyKinematicsDoc();
  const issue: KinematicsIssue = { code: 'json.invalid', level: 'error', message };
  return {
    doc,
    issues: [issue],
    errors: [issue],
    warnings: [],
    stats: kinematicsStats(doc),
    ok: false
  };
}

export function parseKinematicsJson(text: string, options: KinematicsOptions = {}): KinematicsCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return invalidJsonCheck('运动学标注不是合法 JSON');
  }
  return checkKinematics(raw, options);
}
