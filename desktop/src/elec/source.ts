/**
 * 电气图纸数据源：最近一次“打开的工程”或“应用的机型方案”，谁新用谁。
 *
 * 机型方案必须带上规则引擎给出的 BOM 草稿与功率估算（apply_machine_design 归一化后的完整方案），
 * 否则 elecDesignFromMachine 只能按缺省伺服 0.4 kW、通用型号出图。只带 config 的旧调用方仍能出图，
 * 但会在图纸说明里写明“未携带 BOM/功率”。
 *
 * 本模块只做选源与缓存，不碰 DOM；extension.ts 负责把图送进电气域画布。
 */

import { elecDesignFromMachine, elecDesignFromProject, type MachineDesignLike, type ProjectLike } from './adapters.ts';
import type { DrawingOptions, ElecDrawing } from './drawing.ts';
import type { ElecDesign } from './design.ts';
import type { MachineConfig } from '../commission/machine-config.ts';

export const MACHINE_CONFIG_ONLY_NOTE = '机型方案未携带 BOM/功率估算（只有 config）：电机功率与型号按缺省出图，需以方案 BOM 核对';

export type ElecSource =
  | { kind: 'project'; project: ProjectLike }
  | { kind: 'machine'; design: MachineDesignLike; configOnly: boolean };

/** 渲染层 applyMachineConfig / 启动恢复收到的方案里，电气出图需要的部分 */
export interface MachineElecPayload {
  bomDraft?: MachineDesignLike['bomDraft'];
  power?: MachineDesignLike['power'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从桥接/IPC 载荷里取出 bomDraft 与 power（只做形状检查，数据已在主进程 validateMachineDesign 归一化）。
 * 形状不对的字段直接丢弃，退回“只有 config”。
 */
export function pickMachineElecPayload(value: unknown): MachineElecPayload {
  if (!isRecord(value)) return {};
  const out: MachineElecPayload = {};
  const bom = value.bomDraft;
  if (isRecord(bom) && Array.isArray(bom.items) && bom.items.every(isRecord)) {
    out.bomDraft = bom as unknown as NonNullable<MachineElecPayload['bomDraft']>;
  }
  const power = value.power;
  if (isRecord(power) && Array.isArray(power.byGroup) && power.byGroup.every(isRecord)) {
    out.power = power as unknown as NonNullable<MachineElecPayload['power']>;
  }
  return out;
}

/** config + （可能缺失的）完整方案 → 机型数据源 */
export function machineSource(config: MachineConfig, design: unknown): ElecSource {
  const extra = pickMachineElecPayload(design);
  return {
    kind: 'machine',
    design: { config, ...extra } as MachineDesignLike,
    configOnly: !extra.bomDraft && !extra.power
  };
}

export function elecDesignFromSource(source: ElecSource, options: { date?: string } = {}): ElecDesign {
  if (source.kind === 'project') return elecDesignFromProject(source.project, options);
  const design = elecDesignFromMachine(source.design, options);
  if (source.configOnly) design.notes = [MACHINE_CONFIG_ONLY_NOTE, ...design.notes];
  return design;
}

export interface ElecSourceLabel {
  kind: ElecSource['kind'];
  id: string;
  name: string;
}

export function sourceLabel(source: ElecSource | null): ElecSourceLabel | null {
  if (!source) return null;
  return source.kind === 'project'
    ? { kind: 'project', id: source.project.id, name: source.project.name }
    : { kind: 'machine', id: source.design.config.id, name: source.design.config.name };
}

/**
 * 数据源跟踪 + 图纸缓存。每次换源版本号 +1；drawing() 在版本或日期变化时重建，
 * 电气域画布、电气校验面板（__ElecDocProvider）、Agent run_electrical_check 都从这里取同一份图。
 */
export class ElecSourceTracker {
  private source: ElecSource | null = null;
  private versionValue = 0;
  private cache: { version: number; date: string; drawing: ElecDrawing | null } | null = null;
  private readonly render: (design: ElecDesign, options: DrawingOptions) => ElecDrawing;
  private readonly today: () => string;

  /** render 由调用方注入（renderElecDrawing），本模块只管选源与缓存 */
  constructor(
    render: (design: ElecDesign, options: DrawingOptions) => ElecDrawing,
    today: () => string = () => new Date().toISOString().slice(0, 10)
  ) {
    this.render = render;
    this.today = today;
  }

  get version(): number {
    return this.versionValue;
  }

  current(): ElecSource | null {
    return this.source;
  }

  label(): ElecSourceLabel | null {
    return sourceLabel(this.source);
  }

  /** 打开/生成了工程：工程成为最新数据源 */
  useProject(project: ProjectLike): void {
    this.set({ kind: 'project', project });
  }

  /** 应用（或撤销回）一个机型方案 */
  useMachine(config: MachineConfig, design: unknown): void {
    this.set(machineSource(config, design));
  }

  /** 撤销到“没有方案”：退回最近打开的工程，没有就清空 */
  clearMachine(fallbackProject: ProjectLike | null): void {
    if (this.source && this.source.kind !== 'machine') return;
    this.set(fallbackProject ? { kind: 'project', project: fallbackProject } : null);
  }

  /** 启动恢复：只在还没有任何数据源时生效，避免盖掉启动期间用户刚打开的工程 */
  restoreMachine(config: MachineConfig, design: unknown): boolean {
    if (this.source) return false;
    this.useMachine(config, design);
    return true;
  }

  drawing(): ElecDrawing | null {
    const date = this.today();
    if (this.cache && this.cache.version === this.versionValue && this.cache.date === date) return this.cache.drawing;
    const drawing = this.source ? this.render(elecDesignFromSource(this.source, { date }), { date }) : null;
    this.cache = { version: this.versionValue, date, drawing };
    return drawing;
  }

  private set(source: ElecSource | null): void {
    this.source = source;
    this.versionValue += 1;
    this.cache = null;
  }
}
