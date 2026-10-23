import { createHash } from 'node:crypto';
import type {
  GeneratedFile,
  Issue,
  PlcBomInput,
  PlcGenConfig,
  PrecheckResult,
  StGenerateOptions,
  StStats,
  TagTable
} from './types.ts';
import { precheck } from './precheck.ts';
import { buildTags } from './tags.ts';
import { generateSt } from './st.ts';
import {
  buildSequencePlan,
  generateSequence,
  type SequenceStepModel
} from './sequence.ts';
import { generateAlarms } from './alarms.ts';
import { generateSafety } from './safety.ts';
import { createRenderContext } from './st.ts';
import { buildTagBindings, type TagBinding } from './symbols.ts';
import { normalizePointKey } from './io.ts';

export interface GenerateProjectInput extends StGenerateOptions {
  config: PlcGenConfig;
  /** 仅参与预检；不进入程序正文。 */
  bom?: PlcBomInput;
}

export interface ProjectStats extends StStats {
  steps: number;
  precheckWarnings: number;
  sequenceWarnings: number;
  sequenceEmpty: boolean;
  hashes: Record<string, string>;
}

export interface GenerateProjectSuccess {
  ok: true;
  files: GeneratedFile[];
  stats: ProjectStats;
  precheck: PrecheckResult;
  warnings: Issue[];
}

export interface GenerateProjectFailure {
  ok: false;
  errors: Issue[];
  precheck: PrecheckResult;
}

export type GenerateProjectResult = GenerateProjectSuccess | GenerateProjectFailure;

/** 汇总生成固定文件顺序；不得依赖调用方的 Map/对象遍历顺序。 */
export const PROJECT_FILE_ORDER = [
  'src/OB1_Main.st',
  'src/DB_IO.st',
  'src/FB_Cylinder.st',
  'src/FB_Gripper.st',
  'src/FB_RotaryAxis.st',
  'src/FC_AutoSequence.st',
  'src/FC_Alarms.st',
  'src/FC_Safety.st',
  'io-tags.csv',
  'mapping.json',
  'README.md'
] as const;

interface StepUsage {
  stepNo: number;
  usage: 'set' | 'reset' | 'condition';
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function countLines(content: string): number {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n').length;
}

function addUsage(
  map: Map<string, StepUsage[]>,
  point: string,
  stepNo: number,
  usage: StepUsage['usage']
): void {
  const key = normalizePointKey(point);
  const entries = map.get(key) ?? [];
  if (!entries.some((entry) => entry.stepNo === stepNo && entry.usage === usage)) {
    entries.push({ stepNo, usage });
    map.set(key, entries);
  }
}

function usageForPoints(
  map: Map<string, StepUsage[]>,
  points: readonly string[],
  stepNo: number,
  usage: StepUsage['usage']
): void {
  for (const point of points) addUsage(map, point, stepNo, usage);
}

function pointUsages(
  map: Map<string, StepUsage[]>,
  binding: TagBinding
): StepUsage[] {
  const keys = [
    binding.ref.point,
    binding.ref.sourceAddress,
    binding.row.address,
    binding.row.name
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizePointKey(value));
  const entries: StepUsage[] = [];
  for (const key of keys) {
    for (const entry of map.get(key) ?? []) {
      if (!entries.some((candidate) => candidate.stepNo === entry.stepNo && candidate.usage === entry.usage)) {
        entries.push(entry);
      }
    }
  }
  return entries.sort((left, right) => left.stepNo - right.stepNo || left.usage.localeCompare(right.usage, 'en'));
}

function buildMapping(
  config: PlcGenConfig,
  tags: TagTable,
  steps: readonly SequenceStepModel[],
  inputHash: string
): string {
  const usageMap = new Map<string, StepUsage[]>();
  for (const step of steps) {
    usageForPoints(usageMap, step.sets, step.stepNo, 'set');
    usageForPoints(usageMap, step.resets, step.stepNo, 'reset');
    for (const point of step.referencedPoints) addUsage(usageMap, point, step.stepNo, 'condition');
  }

  const points = buildTagBindings(config).map((binding) => {
    const usages = pointUsages(usageMap, binding);
    const ref = binding.ref.actuatorName
      ?? (binding.ref.station === '安全' ? '安全回路' : binding.ref.point);
    return {
      ref,
      point: binding.ref.point,
      address: binding.row.address,
      variable: binding.row.name,
      type: binding.row.type,
      comment: binding.row.comment,
      station: binding.row.station,
      area: binding.ref.area,
      steps: [...new Set(usages.map((entry) => entry.stepNo))],
      stepUsage: usages
    };
  });

  const payload = {
    schemaVersion: 1,
    generatorVersion: '1.0.0',
    inputHash,
    machine: {
      id: config.id,
      name: config.name,
      version: String(config.version ?? 1)
    },
    ioCount: {
      total: tags.rows.length,
      inputs: tags.rows.filter((row) => row.address.startsWith('I')).length,
      outputs: tags.rows.filter((row) => row.address.startsWith('Q')).length
    },
    points,
    sequence: steps.map((step) => ({
      stepNo: step.stepNo,
      name: step.name,
      sets: step.sets,
      resets: step.resets,
      waits: step.waits,
      condition: step.condition,
      timeoutMs: step.timeoutMs
    }))
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildReadme(
  config: PlcGenConfig,
  precheckResult: PrecheckResult,
  steps: readonly SequenceStepModel[],
  sequenceWarnings: readonly Issue[],
  tags: TagTable,
  inputHash: string,
  version: string
): string {
  const warnings = [...precheckResult.warnings, ...sequenceWarnings];
  const lines = [
    '# PLC 程序生成说明',
    '',
    `- 机型：${config.name || '未命名机型'} (${config.id || '未指定'})`,
    `- 机型版本：${version}`,
    `- 生成器：AutomationCAD v1.0.0`,
    `- 输入哈希：${inputHash}`,
    `- 文件数：${PROJECT_FILE_ORDER.length}`,
    `- IO 变量：${tags.rows.length}（输入 ${tags.rows.filter((row) => row.address.startsWith('I')).length} / 输出 ${tags.rows.filter((row) => row.address.startsWith('Q')).length}）`,
    `- 自动序列步数：${steps.length}`,
    `- 预检结果：${precheckResult.errors.length} error / ${precheckResult.warnings.length} warning`,
    `- 序列警告：${sequenceWarnings.length}`,
    '',
    '## 文件',
    '',
    ...PROJECT_FILE_ORDER.map((path) => `- \`${path}\``),
    '',
    '## 导入说明',
    '',
    '1. 先导入 `io-tags.csv` 建立变量表，或将 `DB_IO.st` 中带绝对地址的变量声明导入 DB。',
    '2. `OB1_Main.st` 按扫描顺序调用 `FC_AutoSequence`、`FC_Alarms`、`FC_Safety`；安全块最后执行，确保 `SafeStop` 同周期复位输出。',
    '3. `mapping.json` 提供位号、点位、变量与步序的追溯关系，可用于 HMI 或 MES 对点。',
    '4. 生成结果不含时间戳，同一输入可逐字节复现。',
    ''
  ];
  if (warnings.length > 0) {
    lines.push('## 警告', '');
    for (const warning of warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function fileByPath(files: readonly GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`PLC 生成缺少文件 ${path}`);
  return file;
}

/**
 * 汇总生成 PLC 工程：预检有 error 时不生成任何文件；成功时固定输出 11 个文件。
 * 同一输入（JSON 键序一致）重复生成，每个文件 sha256 一致。
 */
export function generateProject(input: GenerateProjectInput): GenerateProjectResult {
  const ctx = createRenderContext(input);
  const check = precheck(ctx.config, input.bom);
  if (check.errors.length > 0) {
    return { ok: false, errors: check.errors, precheck: check };
  }

  const base = generateSt(input);
  const sequence = generateSequence(input);
  const plan = buildSequencePlan(input);
  const tags = buildTags(ctx.config);
  const mapping = buildMapping(ctx.config, tags, plan.steps, ctx.inputHash);
  const readme = buildReadme(
    ctx.config,
    check,
    plan.steps,
    sequence.warnings,
    tags,
    ctx.inputHash,
    ctx.version
  );

  const allFiles: GeneratedFile[] = [
    fileByPath(base.files, 'src/OB1_Main.st'),
    fileByPath(base.files, 'src/DB_IO.st'),
    fileByPath(base.files, 'src/FB_Cylinder.st'),
    fileByPath(base.files, 'src/FB_Gripper.st'),
    fileByPath(base.files, 'src/FB_RotaryAxis.st'),
    { path: 'src/FC_AutoSequence.st', content: sequence.content },
    { path: 'src/FC_Alarms.st', content: generateAlarms(input) },
    { path: 'src/FC_Safety.st', content: generateSafety(input) },
    { path: 'io-tags.csv', content: tags.csv },
    { path: 'mapping.json', content: mapping },
    { path: 'README.md', content: readme }
  ];
  if (allFiles.map((file) => file.path).join('\n') !== PROJECT_FILE_ORDER.join('\n')) {
    throw new Error('PLC 生成文件顺序与固定清单不一致');
  }

  const hashes: Record<string, string> = {};
  for (const file of allFiles) hashes[file.path] = sha256(file.content);

  const warnings = [...check.warnings, ...sequence.warnings];
  const stats: ProjectStats = {
    files: allFiles.length,
    lines: allFiles.reduce((total, file) => total + countLines(file.content), 0),
    tags: tags.rows.length,
    inputs: tags.rows.filter((row) => row.address.startsWith('I')).length,
    outputs: tags.rows.filter((row) => row.address.startsWith('Q')).length,
    actuators: (ctx.config.actuators ?? []).length,
    stations: (ctx.config.stations ?? []).length,
    inputHash: ctx.inputHash,
    timeoutTimeMs: ctx.timeoutTimeMs,
    toleranceDeg: ctx.toleranceDeg,
    steps: plan.steps.length,
    precheckWarnings: check.warnings.length,
    sequenceWarnings: sequence.warnings.length,
    sequenceEmpty: plan.steps.length === 0,
    hashes
  };

  return {
    ok: true,
    files: allFiles,
    stats,
    precheck: check,
    warnings
  };
}

export const generatePlcProject = generateProject;
