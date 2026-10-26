// 向导的元件库绑定与点位分配：只读 registry 数据，不复制元件库。

import type { ComponentPart } from '../shared/types.ts';
import type { ActuatorDraft, SensorDraft, StationDraft } from './wizard-state.ts';

export type DesignPartIssueCode = 'PART_NOT_FOUND' | 'DUPLICATE_POINT' | 'EMPTY_NAME';

export interface DesignPartIssue {
  code: DesignPartIssueCode;
  message: string;
  path: string;
}

export type DesignIssueTarget =
  | { stationIndex: number; itemType: 'actuator'; itemIndex: number; field: 'name' | 'kind' | 'model' | 'extendPoint' | 'retractPoint' | 'gripPoint' | 'point' }
  | { stationIndex: number; itemType: 'sensor'; itemIndex: number; field: 'point' | 'model' };

/** 将校验器的稳定字段路径解析为可聚焦的工位表格坐标；不接受未知字段或畸形路径。 */
export function designIssueTargetFromPath(path: string): DesignIssueTarget | null {
  const match = /^stations\[(\d+)\]\.(actuators|sensors)\[(\d+)\]\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
  if (!match) return null;
  const stationIndex = Number(match[1]);
  const itemIndex = Number(match[3]);
  if (!Number.isSafeInteger(stationIndex) || !Number.isSafeInteger(itemIndex)) return null;
  const itemType = match[2];
  const field = match[4];
  if (!itemType || !field) return null;
  if (itemType === 'actuators' && ['name', 'kind', 'model', 'extendPoint', 'retractPoint', 'gripPoint', 'point'].includes(field)) {
    return { stationIndex, itemType: 'actuator', itemIndex, field: field as Extract<DesignIssueTarget, { itemType: 'actuator' }>['field'] };
  }
  if (itemType === 'sensors' && ['point', 'model'].includes(field)) {
    return { stationIndex, itemType: 'sensor', itemIndex, field: field as Extract<DesignIssueTarget, { itemType: 'sensor' }>['field'] };
  }
  return null;
}

const ACTUATOR_CATEGORY: Record<ActuatorDraft['kind'], RegExp> = {
  cylinder: /气缸|滑台|气动执行/i,
  gripper: /气爪|夹爪|真空吸盘/i,
  rotary: /伺服|步进|旋转|减速机|模组/i
};

const SENSOR_CATEGORY = /传感器|光电|接近|压力|安全光栅|行程开关/i;

export function partKey(part: Pick<ComponentPart, 'id' | 'packId'>): string {
  return `${part.packId ?? ''}|${part.id}`;
}

export function filterPartsForKind(parts: readonly ComponentPart[], kind: ActuatorDraft['kind']): ComponentPart[] {
  const pattern = ACTUATOR_CATEGORY[kind];
  return parts.filter((part) => pattern.test(part.category));
}

export function filterSensorParts(parts: readonly ComponentPart[]): ComponentPart[] {
  return parts.filter((part) => SENSOR_CATEGORY.test(`${part.category} ${part.model}`));
}

export function findPartByModel(
  parts: readonly ComponentPart[],
  model: string,
  packId?: string
): ComponentPart | undefined {
  const normalized = model.trim();
  if (!normalized) return undefined;
  return parts.find((part) => part.model === normalized && (packId === undefined || part.packId === packId));
}

export function bindPartFields(
  part: ComponentPart
): Pick<ActuatorDraft, 'model' | 'partId' | 'packId'> {
  return {
    model: part.model,
    partId: part.id,
    ...(part.packId ? { packId: part.packId } : {})
  };
}

function pointKey(point: string): string {
  return point.trim().toUpperCase();
}

function firstFree(base: string, used: Set<string>): string {
  if (!used.has(pointKey(base))) return base;
  let suffix = 2;
  while (used.has(pointKey(`${base}-${suffix}`))) suffix += 1;
  return `${base}-${suffix}`;
}

/** 按 synth.ts / io-map.ts 的命名规则分配执行机构点位，并避开已占用点位。 */
export function allocateActuatorPoints(
  stationIndex: number,
  actuatorIndex: number,
  kind: ActuatorDraft['kind'],
  used: ReadonlySet<string>
): Pick<ActuatorDraft, 'extendPoint' | 'retractPoint' | 'gripPoint' | 'point'> {
  const prefix = `ST${stationIndex + 1}`;
  const actuator = `A${actuatorIndex}`;
  const set = new Set([...used].map(pointKey));
  if (kind === 'cylinder') {
    const extendPoint = firstFree(`${prefix}-EXT-${actuator}`, set);
    set.add(pointKey(extendPoint));
    return { extendPoint, retractPoint: firstFree(`${prefix}-RET-${actuator}`, set) };
  }
  if (kind === 'gripper') return { gripPoint: firstFree(`${prefix}-GRIP-${actuator}`, set) };
  return { point: firstFree(`${prefix}-ROT-${actuator}`, set) };
}

export function allocateSensorPoint(
  stationIndex: number,
  sensorIndex: number,
  kind: 'proximity' | 'photoelectric' | 'safety' | 'pressure' = 'proximity',
  used: ReadonlySet<string> = new Set()
): string {
  const code = {
    proximity: 'PRX',
    photoelectric: 'PHT',
    safety: 'SAFE',
    pressure: 'PRS'
  }[kind];
  const set = new Set([...used].map(pointKey));
  return firstFree(`ST${stationIndex + 1}-${code}-S${sensorIndex}`, set);
}

export function allPoints(stations: readonly StationDraft[]): Set<string> {
  const points = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value?.trim()) points.add(pointKey(value));
  };
  for (const station of stations) {
    for (const actuator of station.actuators) {
      add(actuator.extendPoint);
      add(actuator.retractPoint);
      add(actuator.gripPoint);
      add(actuator.point);
    }
    for (const sensor of station.sensors) add(sensor.point);
  }
  return points;
}

/** 型号必须真实存在；空白表示尚未绑定，不伪造型号。 */
export function validatePartBindings(
  stations: readonly StationDraft[],
  parts: readonly ComponentPart[]
): DesignPartIssue[] {
  const issues: DesignPartIssue[] = [];
  const seen = new Set<string>();
  for (const [stationIndex, station] of stations.entries()) {
    for (const [index, actuator] of station.actuators.entries()) {
      if (!actuator.name.trim()) {
        issues.push({
          code: 'EMPTY_NAME',
          path: `stations[${stationIndex}].actuators[${index}].name`,
          message: `工位「${station.name}」的执行机构名称不能为空`
        });
      }
      if (actuator.model?.trim() && !findPartByModel(parts, actuator.model, actuator.packId)) {
        issues.push({
          code: 'PART_NOT_FOUND',
          path: `stations[${stationIndex}].actuators[${index}].model`,
          message: `执行机构「${actuator.name}」的型号「${actuator.model}」在元件库中不存在`
        });
      }
    }
    for (const [index, sensor] of station.sensors.entries()) {
      if (sensor.model?.trim() && !findPartByModel(parts, sensor.model, sensor.packId)) {
        issues.push({
          code: 'PART_NOT_FOUND',
          path: `stations[${stationIndex}].sensors[${index}].model`,
          message: `传感器「${sensor.point}」的型号「${sensor.model}」在元件库中不存在`
        });
      }
    }
  }
  for (const issue of issues) if (seen.has(issue.path)) continue; else seen.add(issue.path);
  return issues;
}

/** 点位冲突按不区分大小写的完整点位名判断。 */
export function validatePointConflicts(stations: readonly StationDraft[]): DesignPartIssue[] {
  const issues: DesignPartIssue[] = [];
  const seen = new Map<string, string>();
  const claim = (point: string, path: string, label: string): void => {
    const key = pointKey(point);
    const previous = seen.get(key);
    if (previous) {
      issues.push({
        code: 'DUPLICATE_POINT',
        path,
        message: `点位「${point}」重复：${label} 与 ${previous} 冲突`
      });
    } else {
      seen.set(key, label);
    }
  };
  for (const [stationIndex, station] of stations.entries()) {
    for (const [actuatorIndex, actuator] of station.actuators.entries()) {
      for (const [field, point] of [
        ['extendPoint', actuator.extendPoint],
        ['retractPoint', actuator.retractPoint],
        ['gripPoint', actuator.gripPoint],
        ['point', actuator.point]
      ] as const) {
        if (!point?.trim()) continue;
        claim(point, `stations[${stationIndex}].actuators[${actuatorIndex}].${field}`,
          `${station.name}·${actuator.name}.${field}`);
      }
    }
    for (const [sensorIndex, sensor] of station.sensors.entries()) {
      if (!sensor.point.trim()) continue;
      claim(sensor.point, `stations[${stationIndex}].sensors[${sensorIndex}].point`,
        `${station.name}·传感器 ${sensor.point}`);
    }
  }
  return issues;
}

export function sensorKindForIndex(index: number): 'proximity' | 'photoelectric' | 'safety' | 'pressure' {
  return (['proximity', 'photoelectric', 'safety', 'pressure'] as const)[index % 4] ?? 'proximity';
}

export function defaultSensorTemplate(index: number): SensorDraft {
  return {
    point: '',
    station: '',
    part: ''
  };
}
