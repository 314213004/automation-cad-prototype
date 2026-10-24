// 机型方案落盘与校验：负责 MachineDesign 的结构校验、id 净化、BOM 行转换，
// 以及 userData/machine 下的最小文件读写。命令总线负责编排 3D/BOM/PLC 联动。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { dirname, join } from 'node:path';
import { validateMachineConfig, type MachineConfig } from '../commission/machine-config.ts';
import type { MachineBomItem, MachineCycleEstimate, MachinePowerEstimate } from './synth.ts';
import type { MachineFormGeometry, MachineFormSummary } from './forms.ts';

export interface NormalizedMachineDesign {
  config: MachineConfig;
  points: string[];
  cycle?: MachineCycleEstimate;
  power?: MachinePowerEstimate;
  bomDraft?: { items: MachineBomItem[] };
  warnings: string[];
  assumptions: string[];
  form?: MachineFormSummary;
}

export interface MachineBomRow {
  name: string;
  model: string;
  qty: number;
  category: string;
  note?: string;
  source: 'machine-design';
  partId?: string;
  packId?: string;
  pendingSelection?: boolean;
}

export interface ActiveMachinePointer {
  schemaVersion: 1;
  machineId: string;
  name: string;
  file: string;
  appliedAt: string;
}

export interface StoredMachineDesign extends NormalizedMachineDesign {
  schemaVersion: 1;
  kind: 'machine-design';
  id: string;
  name: string;
  appliedAt: string;
}

const BOM_KIND_LABEL: Record<MachineBomItem['kind'], string> = {
  actuator: '执行机构',
  sensor: '传感器',
  electrical: '电气'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** 配置中的全部点位，按执行机构字段顺序、再按传感器顺序；大小写不敏感去重。 */
export function machineConfigPoints(config: MachineConfig): string[] {
  const points: string[] = [];
  for (const actuator of config.actuators) {
    for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
      if (point) points.push(point);
    }
  }
  for (const sensor of config.sensors) points.push(sensor.point);
  return uniqueStrings(points);
}

function parseMachineForm(value: unknown): MachineFormSummary {
  if (!isRecord(value)) throw new Error('design.form 必须是对象');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : '';
  if (!id) throw new Error('design.form.id 不能为空');
  if (!name) throw new Error('design.form.name 不能为空');
  if (!rationale) throw new Error('design.form.rationale 不能为空');
  const layouts = new Set(['single', 'linear', 'dial', 'parallel', 'cell']);
  const layout = layouts.has(String(value.layout))
    ? value.layout as MachineFormSummary['layout']
    : 'linear';
  const geometryRaw = isRecord(value.geometry) ? value.geometry : {};
  const rawKind = geometryRaw.kind;
  const inferredKind = String(value.layout) === 'dial' || id.startsWith('dial-')
    ? 'dial'
    : String(value.layout) === 'cell' || id.startsWith('dual-')
      ? 'dual'
      : String(value.layout) === 'parallel' || id.startsWith('gantry-')
        ? 'gantry'
        : 'linear';
  const kind = rawKind === 'dial' || rawKind === 'linear' || rawKind === 'gantry' || rawKind === 'dual'
    ? rawKind
    : geometryRaw.kind === undefined
      ? inferredKind
      : null;
  if (kind === null) {
    throw new Error('design.form.geometry.kind 必须是 dial/linear/gantry/dual');
  }
  const geometry: MachineFormGeometry = { kind };
  if (typeof geometryRaw.lanes === 'number' && Number.isInteger(geometryRaw.lanes) && geometryRaw.lanes > 0) {
    geometry.lanes = geometryRaw.lanes;
  }
  if (typeof geometryRaw.stationsPerLane === 'number' && Number.isInteger(geometryRaw.stationsPerLane) && geometryRaw.stationsPerLane > 0) {
    geometry.stationsPerLane = geometryRaw.stationsPerLane;
  }
  if (typeof geometryRaw.axes === 'number' && Number.isInteger(geometryRaw.axes) && geometryRaw.axes > 0) {
    geometry.axes = geometryRaw.axes;
  }
  if (geometryRaw.conveyor === 'belt' || geometryRaw.conveyor === 'chain') geometry.conveyor = geometryRaw.conveyor;
  if (geometryRaw.indexer === 'cam' || geometryRaw.indexer === 'dd') geometry.indexer = geometryRaw.indexer;
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`design.form.alternatives[${index}] 必须是对象`);
      const altId = typeof entry.id === 'string' ? entry.id.trim() : '';
      const altName = typeof entry.name === 'string' ? entry.name.trim() : '';
      const difference = typeof entry.difference === 'string' ? entry.difference.trim() : '';
      if (!altId || !altName || !difference) {
        throw new Error(`design.form.alternatives[${index}] 需要 id/name/difference`);
      }
      return { id: altId, name: altName, difference };
    })
    : [];
  const score = typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : 0;
  const warning = typeof value.warning === 'string' && value.warning.trim() ? value.warning.trim() : undefined;
  return {
    id,
    name,
    rationale,
    layout,
    geometry,
    score,
    alternatives,
    ...(warning ? { warning } : {})
  };
}

/**
 * 校验并归一化 Agent 返回的 MachineDesign。
 *
 * `validateMachineConfig` 已覆盖必填字段、工位存在、点位唯一等；这里补上
 * 工位/执行机构/传感器 id 唯一、传感器 part 引用、以及 design.points 与配置
 * 点位的一致性，避免“看起来有方案、实际点表引用不存在”。
 */
export function validateMachineDesign(value: unknown): NormalizedMachineDesign {
  if (!isRecord(value)) throw new Error('design 必须是对象');
  if (!isRecord(value.config)) throw new Error('design.config 必须是对象');
  const config = validateMachineConfig(value.config);

  const actuatorIds = new Set<string>();
  for (const actuator of config.actuators) {
    if (actuatorIds.has(actuator.id)) throw new Error(`执行机构 id 重复：${actuator.id}`);
    actuatorIds.add(actuator.id);
  }
  const stationSet = new Set(config.stations);
  for (const sensor of config.sensors) {
    if (!stationSet.has(sensor.part) && !actuatorIds.has(sensor.part)) {
      throw new Error(`传感器「${sensor.point}」引用了未定义工位或执行机构「${sensor.part}」`);
    }
  }

  const configPoints = machineConfigPoints(config);
  const pointSet = new Set(configPoints.map((point) => point.toUpperCase()));
  let points = configPoints;
  if (value.points !== undefined) {
    const declared = stringArray(value.points, 'design.points');
    if (declared.length === 0) throw new Error('design.points 不能为空');
    const declaredSet = new Set<string>();
    for (const point of declared) {
      const key = point.toUpperCase();
      if (declaredSet.has(key)) throw new Error(`设计点位重复：${point}`);
      declaredSet.add(key);
      if (!pointSet.has(key)) throw new Error(`设计点位引用缺失：配置中没有点位 ${point}`);
    }
    for (const point of configPoints) {
      if (!declaredSet.has(point.toUpperCase())) throw new Error(`设计点位引用缺失：${point} 未列入 design.points`);
    }
    points = declared;
  }

  let bomDraft: { items: MachineBomItem[] } | undefined;
  if (value.bomDraft !== undefined) {
    if (!isRecord(value.bomDraft) || !Array.isArray(value.bomDraft.items)) {
      throw new Error('design.bomDraft.items 必须是数组');
    }
    const items = value.bomDraft.items.map((raw, index): MachineBomItem => {
      if (!isRecord(raw)) throw new Error(`design.bomDraft.items[${index}] 必须是对象`);
      const kind = raw.kind;
      if (kind !== 'actuator' && kind !== 'sensor' && kind !== 'electrical') {
        throw new Error(`design.bomDraft.items[${index}].kind 必须是 actuator/sensor/electrical`);
      }
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!name) throw new Error(`design.bomDraft.items[${index}].name 不能为空`);
      const qty = raw.qty;
      if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
        throw new Error(`design.bomDraft.items[${index}].qty 必须是正整数`);
      }
      const item: MachineBomItem = { kind, name, qty };
      if (typeof raw.note === 'string' && raw.note.trim()) item.note = raw.note.trim();
      if (typeof raw.model === 'string' && raw.model.trim()) item.model = raw.model.trim();
      if (typeof raw.partId === 'string' && raw.partId.trim()) item.partId = raw.partId.trim();
      if (typeof raw.packId === 'string' && raw.packId.trim()) item.packId = raw.packId.trim();
      if (raw.pendingSelection === true) item.pendingSelection = true;
      return item;
    });
    bomDraft = { items };
  }

  const warnings = stringArray(value.warnings, 'design.warnings');
  const assumptions = stringArray(value.assumptions, 'design.assumptions');
  const form = value.form === undefined ? undefined : parseMachineForm(value.form);

  const normalized: NormalizedMachineDesign = { config, points, warnings, assumptions, ...(form ? { form } : {}) };
  if (isRecord(value.cycle)) {
    const perMin = value.cycle.perMin;
    const secondsPerPiece = value.cycle.secondsPerPiece;
    const bottleneck = value.cycle.bottleneck;
    if (typeof perMin !== 'number' || !Number.isFinite(perMin) || perMin <= 0) {
      throw new Error('design.cycle.perMin 必须大于 0');
    }
    if (typeof secondsPerPiece !== 'number' || !Number.isFinite(secondsPerPiece) || secondsPerPiece <= 0) {
      throw new Error('design.cycle.secondsPerPiece 必须大于 0');
    }
    if (typeof bottleneck !== 'string' || !bottleneck.trim()) {
      throw new Error('design.cycle.bottleneck 不能为空');
    }
    const optionalNumber = (key: string): number | undefined => {
      const raw = value.cycle && typeof value.cycle === 'object'
        ? (value.cycle as Record<string, unknown>)[key]
        : undefined;
      return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    };
    const estimated = optionalNumber('estimatedSecondsPerPiece') ?? secondsPerPiece;
    const baseSeconds = optionalNumber('baseSeconds') ?? 0;
    const slowestActionSeconds = optionalNumber('slowestActionSeconds') ?? Math.max(0, estimated - baseSeconds);
    const requiredParallelStations = Math.max(1, Math.trunc(optionalNumber('requiredParallelStations') ?? 1));
    const stations = normalized.config.stations.length;
    const rawMode = (value.cycle as Record<string, unknown>).mode;
    const flowModes: MachineCycleEstimate['mode'][] = ['single', 'linear', 'dial', 'parallel', 'cell'];
    const mode: MachineCycleEstimate['mode'] = rawMode === 'line'
      ? 'linear'
      : flowModes.includes(rawMode as MachineCycleEstimate['mode'])
        ? rawMode as MachineCycleEstimate['mode']
        : 'linear';
    const stationSeconds = optionalNumber('stationSeconds') ?? estimated;
    const throughputPerMin = optionalNumber('throughputPerMin')
      ?? (stationSeconds > 0 ? Math.round((60 / stationSeconds) * 100) / 100 : 0);
    normalized.cycle = {
      mode,
      perMin,
      secondsPerPiece,
      stationSeconds,
      throughputPerMin,
      estimatedSecondsPerPiece: estimated,
      baseSeconds,
      slowestStation: Math.max(1, Math.trunc(optionalNumber('slowestStation') ?? 1)),
      slowestActionSeconds,
      requiredParallelStations,
      requiredTotalStations: Math.trunc(optionalNumber('requiredTotalStations') ?? stations * requiredParallelStations),
      meetsTarget: value.cycle.meetsTarget === true
        || (throughputPerMin > 0 ? throughputPerMin >= perMin - 1e-9 : estimated <= secondsPerPiece),
      bottleneck: bottleneck.trim()
    };
  }
  if (isRecord(value.power)) {
    const va = value.power.va;
    if (typeof va !== 'number' || !Number.isFinite(va) || va < 0) {
      throw new Error('design.power.va 必须是非负数字');
    }
    const byGroup = Array.isArray(value.power.byGroup)
      ? value.power.byGroup.map((group, index) => {
        if (!isRecord(group)) throw new Error(`design.power.byGroup[${index}] 必须是对象`);
        const name = typeof group.name === 'string' ? group.name.trim() : '';
        const groupVa = group.va;
        if (!name || typeof groupVa !== 'number' || !Number.isFinite(groupVa) || groupVa < 0) {
          throw new Error(`design.power.byGroup[${index}] 名称或 va 不合法`);
        }
        return { name, va: groupVa };
      })
      : [];
    normalized.power = { va, byGroup };
  }
  if (bomDraft) normalized.bomDraft = bomDraft;
  return normalized;
}

/** 文件名净化：保留中英文/数字/._-，去掉路径分隔、控制字符与连续点。 */
export function sanitizeMachineId(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  let id = raw
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
  if (!id) id = 'machine';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) id = `machine-${id}`;
  return id;
}

export function machineDirectory(userDataRoot: string): string {
  return join(userDataRoot, 'machine');
}

export function machineDesignPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), `${sanitizeMachineId(machineId)}.json`);
}

export function machineBomDraftPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), sanitizeMachineId(machineId), 'bom-draft.csv');
}

/** 参数化几何产物目录：machine/<id>/（与 bom-draft.csv 同目录）。 */
export function machineGeometryPaths(userDataRoot: string, machineId: string): {
  json: string;
  stl: string;
  gltf: string;
  sidecar: string;
  solidsDir: string;
} {
  const dir = join(machineDirectory(userDataRoot), sanitizeMachineId(machineId));
  return {
    json: join(dir, 'geometry.json'),
    stl: join(dir, 'model.stl'),
    gltf: join(dir, 'model.gltf'),
    sidecar: join(dir, 'sidecar-assembly.json'),
    solidsDir: join(dir, 'solids')
  };
}

/** 读取任意文件为 base64（用于撤销快照，兼容二进制 STL/STEP）；不存在返回 null。 */
export function readBase64IfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path).toString('base64') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_BINARY_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function restoreBase64(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeBytes(path, Buffer.from(previous, 'base64'));
}

export function activeMachinePath(userDataRoot: string): string {
  return join(machineDirectory(userDataRoot), 'active.json');
}

export function readTextIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_TEXT_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function restoreText(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeText(path, previous);
}

export function readActivePointer(userDataRoot: string): ActiveMachinePointer | null {
  const text = readTextIfExists(activeMachinePath(userDataRoot));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const machineId = typeof parsed.machineId === 'string' ? sanitizeMachineId(parsed.machineId) : '';
    if (!machineId) return null;
    const name = typeof parsed.name === 'string' ? parsed.name : machineId;
    const appliedAt = typeof parsed.appliedAt === 'string' ? parsed.appliedAt : '';
    return {
      schemaVersion: 1,
      machineId,
      name,
      file: `machine/${machineId}.json`,
      appliedAt
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_ACTIVE_POINTER_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts' });
    return null;
  }
}

export function writeActivePointer(userDataRoot: string, pointer: ActiveMachinePointer): void {
  writeText(activeMachinePath(userDataRoot), `${JSON.stringify(pointer, null, 2)}\n`);
}

export function readStoredMachineDesign(userDataRoot: string, machineId: string): StoredMachineDesign | null {
  const text = readTextIfExists(machineDesignPath(userDataRoot, machineId));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const design = validateMachineDesign(parsed);
    return {
      ...design,
      schemaVersion: 1,
      kind: 'machine-design',
      id: sanitizeMachineId(typeof parsed.id === 'string' ? parsed.id : machineId),
      name: design.config.name,
      appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : ''
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_DESIGN_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts', machineId });
    return null;
  }
}

export function readActiveMachineDesign(userDataRoot: string): StoredMachineDesign | null {
  const pointer = readActivePointer(userDataRoot);
  if (!pointer) return null;
  return readStoredMachineDesign(userDataRoot, pointer.machineId);
}


/** 用于幂等判断的稳定内容（不含 appliedAt，避免重复执行被误判为变更）。 */
export function machineDesignContent(design: NormalizedMachineDesign): string {
  return JSON.stringify({
    config: design.config,
    points: design.points,
    cycle: design.cycle ?? null,
    power: design.power ?? null,
    bomDraft: design.bomDraft ?? null,
    warnings: design.warnings,
    assumptions: design.assumptions,
    form: design.form ?? null
  });
}

export function buildMachineBomRows(design: NormalizedMachineDesign): MachineBomRow[] {
  const items = design.bomDraft?.items ?? [];
  return items.map((item): MachineBomRow => {
    const row: MachineBomRow = {
      name: item.name,
      model: item.model?.trim() || '模型待定',
      qty: item.qty,
      category: BOM_KIND_LABEL[item.kind],
      source: 'machine-design'
    };
    if (item.note) row.note = item.note;
    if (item.partId) row.partId = item.partId;
    if (item.packId) row.packId = item.packId;
    if (item.pendingSelection === true) row.pendingSelection = true;
    return row;
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderMachineBomCsv(rows: readonly MachineBomRow[]): string {
  const lines = [
    ['序号', '名称', '型号', '数量', '分类', '来源包', '来源', '待选型', '备注'].map(csvCell).join(','),
    ...rows.map((row, index) => [
      index + 1,
      row.name,
      row.model,
      row.qty,
      row.category,
      row.packId ?? '',
      row.source,
      row.pendingSelection ? '是' : '否',
      row.note ?? ''
    ].map(csvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}
