/** PLC 生成面板的纯数据层：文件树、预览、按钮状态、问题定位与统计文案。 */
import type {
  GeneratedFile,
  Issue,
  PlcGenConfig,
  PlcTarget,
  PrecheckResult
} from './types.ts';
import { PLC_TARGET_LABELS } from './generate.ts';

export const PREVIEW_MAX_LINES = 200;

export const PLC_TARGET_OPTIONS: ReadonlyArray<{ id: PlcTarget; label: string }> = [
  { id: 'generic', label: PLC_TARGET_LABELS.generic },
  { id: 's7-1200', label: PLC_TARGET_LABELS['s7-1200'] },
  { id: 's7-1500', label: PLC_TARGET_LABELS['s7-1500'] },
  { id: 'codesys', label: PLC_TARGET_LABELS.codesys }
];

export interface FileTreeNode {
  path: string;
  name: string;
  depth: number;
  kind: 'dir' | 'file';
  lines: number;
  bytes: number;
}

export interface FilePreview {
  path: string;
  text: string;
  totalLines: number;
  shownLines: number;
  truncated: boolean;
}

export interface IssueLocation {
  actuatorId?: string;
  actuatorName?: string;
  actuatorIndex?: number;
  station?: string;
}

export interface GenerateState {
  hasConfig: boolean;
  precheck: PrecheckResult | null;
  generating?: boolean;
}

export interface StatsSummary {
  files: number;
  tags: number;
  steps: number;
}

export function countContentLines(content: string): number {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n').length;
}

export function contentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** 固定按路径排序，目录节点先于子文件；同一路径只出现一次。 */
export function buildFileTree(files: readonly GeneratedFile[]): FileTreeNode[] {
  const rows: FileTreeNode[] = [];
  const dirs = new Set<string>();
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  for (const file of sorted) {
    const parts = file.path.split('/').filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const path = parts.slice(0, index).join('/');
      if (dirs.has(path)) continue;
      dirs.add(path);
      rows.push({
        path,
        name: parts[index - 1] ?? path,
        depth: index - 1,
        kind: 'dir',
        lines: 0,
        bytes: 0
      });
    }
    rows.push({
      path: file.path,
      name: parts.at(-1) ?? file.path,
      depth: Math.max(0, parts.length - 1),
      kind: 'file',
      lines: countContentLines(file.content),
      bytes: contentBytes(file.content)
    });
  }
  return rows;
}

/** 预览前 N 行；超出时追加截断提示（不修改原文）。 */
export function previewFile(file: GeneratedFile, maxLines = PREVIEW_MAX_LINES): FilePreview {
  const totalLines = countContentLines(file.content);
  const limit = Math.max(1, Math.trunc(maxLines));
  const lines = file.content.split('\n');
  const shown = lines.slice(0, limit);
  const truncated = totalLines > limit;
  return {
    path: file.path,
    text: truncated ? `${shown.join('\n')}\n… 已截断，共 ${totalLines} 行，仅显示前 ${limit} 行` : file.content,
    totalLines,
    shownLines: Math.min(totalLines, limit),
    truncated
  };
}

/** 预检有 error 或尚未拿到结果时禁用生成；warning 不拦截。 */
export function isGenerateDisabled(state: GenerateState): boolean {
  if (!state.hasConfig) return true;
  if (state.generating) return true;
  if (!state.precheck) return true;
  return state.precheck.errors.length > 0;
}

export function formatStatsLine(stats: StatsSummary, elapsedMs: number): string {
  return `${stats.files} 个文件 · 变量 ${stats.tags} · 步序 ${stats.steps} · 生成 ${Math.max(0, Math.round(elapsedMs))} ms`;
}

function actuatorPointValues(config: PlcGenConfig): string[] {
  const values: string[] = [];
  for (const actuator of config.actuators ?? []) {
    for (const value of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
      if (typeof value === 'string' && value.trim()) values.push(value.trim());
    }
  }
  return values;
}

/** 把预检问题映射到机构；优先解析 `actuators[i]`，否则按点位反查。 */
export function locateIssue(issue: Issue, config: PlcGenConfig): IssueLocation | null {
  const actuators = config.actuators ?? [];
  const pathMatch = /^actuators\[(\d+)\]/.exec(issue.path ?? '');
  if (pathMatch) {
    const index = Number(pathMatch[1]);
    const actuator = actuators[index];
    if (actuator) {
      return {
        actuatorId: actuator.id,
        actuatorName: actuator.name,
        actuatorIndex: index,
        station: actuator.station
      };
    }
  }

  const text = `${issue.message} ${issue.path ?? ''}`.toUpperCase();
  const points = actuatorPointValues(config)
    .map((point) => ({ point, upper: point.toUpperCase() }))
    .filter(({ upper }) => text.includes(upper));
  for (const { point } of points) {
    const index = actuators.findIndex((actuator) => [
      actuator.extendPoint,
      actuator.retractPoint,
      actuator.gripPoint,
      actuator.point
    ].some((value) => value?.trim().toUpperCase() === point.toUpperCase()));
    const actuator = actuators[index];
    if (actuator) {
      return {
        actuatorId: actuator.id,
        actuatorName: actuator.name,
        actuatorIndex: index,
        station: actuator.station
      };
    }
  }

  const sensor = (config.sensors ?? []).find((item) => text.includes(item.point.toUpperCase()));
  if (sensor) {
    const index = actuators.findIndex((actuator) => actuator.id === sensor.part);
    const actuator = actuators[index];
    if (actuator) {
      return {
        actuatorId: actuator.id,
        actuatorName: actuator.name,
        actuatorIndex: index,
        station: actuator.station
      };
    }
    return { station: sensor.station };
  }

  const station = (config.stations ?? []).find((name) => text.includes(name.toUpperCase()));
  return station ? { station } : null;
}

/** 复制全部时给每个文件加分隔头，方便粘贴到编辑器/工单。 */
export function buildClipboardBundle(files: readonly GeneratedFile[]): string {
  return files
    .map((file) => `===== ${file.path} =====\n${file.content.replace(/\n$/, '')}`)
    .join('\n\n');
}

export function defaultNamePrefix(config: PlcGenConfig | null): string {
  return config?.id?.trim() || 'PLC';
}

export function targetLabel(target: PlcTarget | string): string {
  return PLC_TARGET_LABELS[target as PlcTarget] ?? target;
}
