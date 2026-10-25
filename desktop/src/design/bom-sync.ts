import type { MachineBomItem, MachineDesign } from '../machine/synth.ts';
import type { ActuatorConfig, SensorConfig } from '../commission/machine-config.ts';

type DeviceRole = 'cylinder' | 'gripper' | 'rotary' | 'sensor' | 'safety';
type DeviceKind = 'actuator' | 'sensor';

interface DeviceGroup {
  kind: DeviceKind;
  role: DeviceRole;
  category: string;
  name: string;
  qty: number;
  model?: string;
  partId?: string;
  packId?: string;
}

const ACTUATOR_LABELS: Record<ActuatorConfig['kind'], string> = {
  cylinder: '气缸',
  gripper: '气爪',
  rotary: '旋转轴'
};

function sensorCategory(point: string): { category: string; name: string; role: DeviceRole } {
  const normalized = point.toUpperCase();
  if (normalized.includes('-SAFE-')) return { category: 'safety', name: '安全光栅', role: 'safety' };
  if (normalized.includes('-PRS-')) return { category: 'pressure', name: '压力传感器', role: 'sensor' };
  if (normalized.includes('-PHT-')) return { category: 'photoelectric', name: '光电传感器', role: 'sensor' };
  return { category: 'proximity', name: '接近开关', role: 'sensor' };
}

function groupsForConfig(design: MachineDesign): DeviceGroup[] {
  const grouped = new Map<string, DeviceGroup>();
  const add = (group: Omit<DeviceGroup, 'qty'>): void => {
    const key = [group.kind, group.category, group.partId ?? '', group.packId ?? '', group.model ?? ''].join('|');
    const existing = grouped.get(key);
    if (existing) existing.qty += 1;
    else grouped.set(key, { ...group, qty: 1 });
  };

  for (const actuator of design.config.actuators) {
    add({
      kind: 'actuator',
      role: actuator.kind,
      category: actuator.kind,
      name: ACTUATOR_LABELS[actuator.kind],
      ...(actuator.model ? { model: actuator.model } : {}),
      ...(actuator.partId ? { partId: actuator.partId } : {}),
      ...(actuator.packId ? { packId: actuator.packId } : {})
    });
  }
  for (const sensor of design.config.sensors) {
    const category = sensorCategory(sensor.point);
    add({
      kind: 'sensor',
      role: category.role,
      category: category.category,
      name: category.name,
      ...(sensor.model ? { model: sensor.model } : {}),
      ...(sensor.partId ? { partId: sensor.partId } : {}),
      ...(sensor.packId ? { packId: sensor.packId } : {})
    });
  }
  return [...grouped.values()];
}

function matchesCategory(item: MachineBomItem, group: DeviceGroup): boolean {
  if (item.kind !== group.kind) return false;
  if (group.kind === 'actuator') return item.role === group.role;
  if (item.role !== group.role) return false;
  const name = item.name.toLowerCase();
  if (group.category === 'safety') return /安全光栅|安全光幕/.test(name);
  if (group.category === 'pressure') return /压力/.test(name);
  if (group.category === 'photoelectric') return /光电/.test(name);
  return /接近|到位检测|磁性开关/.test(name);
}

function matchingTemplate(items: readonly MachineBomItem[], group: DeviceGroup): MachineBomItem | undefined {
  if (group.partId) {
    const exact = items.find((item) => matchesCategory(item, group) && item.partId === group.partId && (group.packId === undefined || item.packId === group.packId));
    if (exact) return exact;
  }
  if (group.model) {
    const exact = items.find((item) => matchesCategory(item, group) && item.model === group.model && (group.packId === undefined || item.packId === group.packId));
    if (exact) return exact;
  }
  return items.find((item) => matchesCategory(item, group));
}

function configuredItem(group: DeviceGroup, oldItems: readonly MachineBomItem[]): MachineBomItem {
  const template = matchingTemplate(oldItems, group);
  const item: MachineBomItem = template ? { ...template } : {
    kind: group.kind,
    name: group.name,
    qty: group.qty,
    role: group.role
  };
  item.kind = group.kind;
  item.name = template?.name ?? group.name;
  item.qty = group.qty;
  item.role = group.role;

  const explicitlyBound = Boolean(group.model || group.partId);
  if (explicitlyBound) {
    const templateMatchesBinding = Boolean(template &&
      (!group.partId || template.partId === group.partId) &&
      (!group.model || template.model === group.model) &&
      (!group.packId || template.packId === group.packId));
    if (group.model) item.model = group.model;
    else delete item.model;
    if (group.partId) item.partId = group.partId;
    else delete item.partId;
    if (group.packId) item.packId = group.packId;
    else delete item.packId;
    if (!templateMatchesBinding) delete item.ratedW;
    delete item.pendingSelection;
    item.note = template && templateMatchesBinding
      ? template.note ?? '型号按当前工位配置绑定'
      : '型号按当前工位配置绑定';
  } else if (!template?.model || template.pendingSelection) {
    item.model = '待选型';
    delete item.partId;
    delete item.packId;
    delete item.ratedW;
    item.pendingSelection = true;
    item.note = `根据当前工位配置汇总；${group.name}尚未绑定型号`;
  }
  return item;
}

function pendingSupportItem(name: string, qty: number, role: 'valve'): MachineBomItem {
  return {
    kind: 'actuator',
    name,
    model: '待选型',
    qty,
    role,
    pendingSelection: true,
    note: '按当前执行机构数量估算，需工程师选型'
  };
}

/**
 * 以当前工位配置为执行机构/传感器 BOM 的数量来源。用户绑定型号优先；未绑定时保留同类原选型，
 * 否则明确标为待选型。固定电气行继续沿用原草案，不在此函数中伪造电气型号或额定值。
 */
export function syncDesignBom(design: MachineDesign): MachineDesign {
  const oldItems = design.bomDraft.items;
  const groups = groupsForConfig(design);
  const actuators = design.config.actuators;
  const gripperCount = actuators.filter((item) => item.kind === 'gripper').length;
  const rotaryCount = actuators.filter((item) => item.kind === 'rotary').length;
  const rotaryBound = actuators.some((item) => item.kind === 'rotary' && (item.model || item.partId));
  const oldServoRows = oldItems.filter((item) => item.role === 'servo' && item.kind !== 'sensor');
  const retainOldServoRows = rotaryCount > 0 && !rotaryBound && oldServoRows.length > 0;

  const deviceItems = groups
    .filter((group) => !(group.category === 'rotary' && retainOldServoRows))
    .map((group) => configuredItem(group, oldItems));
  if (retainOldServoRows) {
    deviceItems.push(...oldServoRows.map((item) => {
      const current = { ...item, qty: rotaryCount };
      if (!current.model || current.pendingSelection) {
        current.model = '待选型';
        current.pendingSelection = true;
      }
      return current;
    }));
  }

  const supportItems: MachineBomItem[] = [];
  if (gripperCount > 0) {
    const valve = oldItems.find((item) => item.role === 'valve');
    supportItems.push(valve
      ? { ...valve, qty: gripperCount }
      : pendingSupportItem('电磁阀', gripperCount, 'valve'));
  }

  const fixedElectricalItems = oldItems
    .filter((item) => item.kind === 'electrical' && item.role !== 'servo')
    .flatMap((item) => {
      if (/伺服支路断路器/.test(item.name)) {
        return rotaryCount > 0 ? [{ ...item, qty: rotaryCount }] : [];
      }
      return [{ ...item }];
    });

  return {
    ...design,
    bomDraft: {
      items: [...deviceItems, ...supportItems, ...fixedElectricalItems]
    }
  };
}
