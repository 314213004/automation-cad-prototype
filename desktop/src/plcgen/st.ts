import type {
  GeneratedFile,
  PlcGenConfig,
  StGenerateInput,
  StGenerateOptions,
  StGenerateResult
} from './types.ts';
import { buildTags } from './tags.ts';
import { inputJsonHash } from './hash.ts';

export const PLCGEN_VERSION = '1.0.0';
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_TOLERANCE_DEG = 0.5;
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 5000;

export type GenerateInput = StGenerateInput | PlcGenConfig;

export interface RenderContext {
  config: PlcGenConfig;
  version: string;
  inputHash: string;
  generatorVersion: string;
  timeoutTime: string;
  timeoutTimeMs: number;
  toleranceDeg: number;
  sequenceTimeout: string;
  sequenceTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWrappedInput(value: GenerateInput): value is StGenerateInput {
  return isRecord(value) && isRecord((value as { config?: unknown }).config);
}

export function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('PLC 生成超时时间必须是大于 0 的整数毫秒');
  }
  return timeout;
}

function validateTolerance(value: number | undefined): number {
  const tolerance = value ?? DEFAULT_TOLERANCE_DEG;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('旋转轴角度容差必须是大于等于 0 的有限数字');
  }
  return tolerance;
}

function validateSequenceTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('PLC 序列超时时间必须是大于 0 的整数毫秒');
  }
  return timeout;
}

function formatVersion(value: string | number | undefined): string {
  const version = value ?? '1';
  const text = String(version).trim();
  if (!text) throw new Error('PLC 机型版本不能为空');
  return text;
}

export function formatTime(milliseconds: number): string {
  if (milliseconds % 1000 === 0) return `T#${milliseconds / 1000}s`;
  return `T#${milliseconds}ms`;
}

function cleanComment(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function renderHeader(ctx: RenderContext, fileName: string): string {
  return [
    '// 自动生成，请勿手工修改',
    `// 机型: ${ctx.config.name || '未命名机型'} (${ctx.config.id || '未指定'})  版本: ${ctx.version}  输入哈希: ${ctx.inputHash}`,
    `// 来源: AutomationCAD 生成器 v${ctx.generatorVersion}`,
    `// 文件: ${fileName}`
  ].join('\n');
}

/** 解析 `{ config, ...options }` 或直接传入机型配置，并生成稳定的渲染上下文。 */
export function createRenderContext(input: GenerateInput): RenderContext {
  if (!isRecord(input)) throw new Error('PLC 生成输入必须是对象');
  const wrapped = isWrappedInput(input);
  const config = (wrapped ? input.config : input) as PlcGenConfig;
  if (!isRecord(config)) throw new Error('缺少必填参数：机型配置');

  const options: StGenerateOptions = wrapped ? input : {};
  const timeoutTimeMs = validateTimeout(options.timeoutTimeMs);
  const toleranceDeg = validateTolerance(options.toleranceDeg);
  const sequenceTimeoutMs = validateSequenceTimeout(options.sequenceTimeoutMs);
  const generatorVersion = options.generatorVersion?.trim() || PLCGEN_VERSION;
  const version = formatVersion(options.version ?? config.version);
  const inputHash = inputJsonHash(input).slice(0, 12);
  return {
    config,
    version,
    inputHash,
    generatorVersion,
    timeoutTime: formatTime(timeoutTimeMs),
    timeoutTimeMs,
    toleranceDeg,
    sequenceTimeout: formatTime(sequenceTimeoutMs),
    sequenceTimeoutMs
  };
}

export function renderGeneratedFile(ctx: RenderContext, path: string, body: string): string {
  return `${renderHeader(ctx, path.split('/').pop() ?? path)}\n\n${body}`;
}

function cylinderBlock(ctx: RenderContext): string {
  return [
    'FUNCTION_BLOCK FB_Cylinder',
    'VAR_INPUT',
    '    Execute : BOOL;',
    '    Extend : BOOL;',
    '    ExtendSensor : BOOL;',
    '    RetractSensor : BOOL;',
    `    TimeoutTime : TIME := ${ctx.timeoutTime};`,
    'END_VAR',
    'VAR_OUTPUT',
    '    ExtendOutput : BOOL;',
    '    RetractOutput : BOOL;',
    '    Busy : BOOL;',
    '    Done : BOOL;',
    '    Error : BOOL;',
    '    ErrorCode : WORD;',
    'END_VAR',
    'VAR',
    '    _Edge : R_TRIG;',
    '    _Timer : TON;',
    '    _Active : BOOL;',
    '    _TargetExtend : BOOL;',
    'END_VAR',
    'VAR CONSTANT',
    '    ERR_TIMEOUT : WORD := 16#8201;',
    '    ERR_SENSOR_CONFLICT : WORD := 16#8202;',
    'END_VAR',
    '',
    '_Edge(CLK := Execute);',
    '',
    '// 上升沿启动；缩回与伸出输出始终互斥。',
    'IF _Edge.Q AND NOT _Active THEN',
    '    _Active := TRUE;',
    '    Done := FALSE;',
    '    Error := FALSE;',
    '    ErrorCode := 16#0000;',
    '    _TargetExtend := Extend;',
    '    Busy := TRUE;',
    '    _Timer(IN := FALSE, PT := TimeoutTime);',
    'END_IF;',
    '',
    'IF _Active THEN',
    '    ExtendOutput := _TargetExtend;',
    '    RetractOutput := NOT _TargetExtend;',
    '    _Timer(IN := TRUE, PT := TimeoutTime);',
    '',
    '    IF ExtendSensor AND RetractSensor THEN',
    '        ExtendOutput := FALSE;',
    '        RetractOutput := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_SENSOR_CONFLICT;',
    '        _Active := FALSE;',
    '    ELSIF (_TargetExtend AND ExtendSensor) OR (NOT _TargetExtend AND RetractSensor) THEN',
    '        Busy := FALSE;',
    '        Done := TRUE;',
    '        Error := FALSE;',
    '        _Active := FALSE;',
    '    ELSIF _Timer.Q THEN',
    '        ExtendOutput := FALSE;',
    '        RetractOutput := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_TIMEOUT;',
    '        _Active := FALSE;',
    '    END_IF;',
    'END_IF;',
    '',
    'IF NOT Execute THEN',
    '    _Timer(IN := FALSE, PT := TimeoutTime);',
    'END_IF;',
    'END_FUNCTION_BLOCK',
    ''
  ].join('\n');
}

function gripperBlock(ctx: RenderContext): string {
  return [
    'FUNCTION_BLOCK FB_Gripper',
    'VAR_INPUT',
    '    Execute : BOOL;',
    '    OpenCommand : BOOL;',
    '    CloseCommand : BOOL;',
    '    OpenedSensor : BOOL;',
    '    ClosedSensor : BOOL;',
    `    TimeoutTime : TIME := ${ctx.timeoutTime};`,
    'END_VAR',
    'VAR_OUTPUT',
    '    OpenOutput : BOOL;',
    '    CloseOutput : BOOL;',
    '    Busy : BOOL;',
    '    Done : BOOL;',
    '    Error : BOOL;',
    '    ErrorCode : WORD;',
    'END_VAR',
    'VAR',
    '    _Edge : R_TRIG;',
    '    _Timer : TON;',
    '    _Active : BOOL;',
    '    _TargetOpen : BOOL;',
    'END_VAR',
    'VAR CONSTANT',
    '    ERR_TIMEOUT : WORD := 16#8301;',
    '    ERR_COMMAND_CONFLICT : WORD := 16#8302;',
    '    ERR_SENSOR_CONFLICT : WORD := 16#8303;',
    'END_VAR',
    '',
    '_Edge(CLK := Execute);',
    '',
    'IF _Edge.Q AND NOT _Active THEN',
    '    Done := FALSE;',
    '    Error := OpenCommand AND CloseCommand;',
    '    IF Error THEN',
    '        OpenOutput := FALSE;',
    '        CloseOutput := FALSE;',
    '        ErrorCode := ERR_COMMAND_CONFLICT;',
    '    ELSE',
    '        _Active := TRUE;',
    '        _TargetOpen := OpenCommand;',
    '        Busy := TRUE;',
    '        ErrorCode := 16#0000;',
    '        _Timer(IN := FALSE, PT := TimeoutTime);',
    '    END_IF;',
    'END_IF;',
    '',
    'IF _Active THEN',
    '    // 开/合两路互锁：任何时刻只允许一路输出为 1。',
    '    IF _TargetOpen THEN',
    '        OpenOutput := TRUE;',
    '        CloseOutput := FALSE;',
    '    ELSE',
    '        OpenOutput := FALSE;',
    '        CloseOutput := TRUE;',
    '    END_IF;',
    '    _Timer(IN := TRUE, PT := TimeoutTime);',
    '',
    '    IF OpenOutput AND CloseOutput THEN',
    '        OpenOutput := FALSE;',
    '        CloseOutput := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_SENSOR_CONFLICT;',
    '        _Active := FALSE;',
    '    ELSIF OpenedSensor AND ClosedSensor THEN',
    '        OpenOutput := FALSE;',
    '        CloseOutput := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_SENSOR_CONFLICT;',
    '        _Active := FALSE;',
    '    ELSIF (_TargetOpen AND OpenedSensor) OR (NOT _TargetOpen AND ClosedSensor) THEN',
    '        Busy := FALSE;',
    '        Done := TRUE;',
    '        Error := FALSE;',
    '        _Active := FALSE;',
    '    ELSIF _Timer.Q THEN',
    '        OpenOutput := FALSE;',
    '        CloseOutput := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_TIMEOUT;',
    '        _Active := FALSE;',
    '    END_IF;',
    'END_IF;',
    'END_FUNCTION_BLOCK',
    ''
  ].join('\n');
}

function rotaryBlock(ctx: RenderContext): string {
  return [
    'FUNCTION_BLOCK FB_RotaryAxis',
    'VAR_INPUT',
    '    Execute : BOOL;',
    '    TargetAngle : REAL;',
    '    ActualAngle : REAL;',
    `    Tolerance : REAL := ${ctx.toleranceDeg};`,
    `    TimeoutTime : TIME := ${ctx.timeoutTime};`,
    'END_VAR',
    'VAR_OUTPUT',
    '    DriveEnable : BOOL;',
    '    InPosition : BOOL;',
    '    Busy : BOOL;',
    '    Done : BOOL;',
    '    Error : BOOL;',
    '    ErrorCode : WORD;',
    'END_VAR',
    'VAR',
    '    _Edge : R_TRIG;',
    '    _Timer : TON;',
    '    _Active : BOOL;',
    'END_VAR',
    'VAR CONSTANT',
    '    ERR_TIMEOUT : WORD := 16#8401;',
    'END_VAR',
    '',
    '_Edge(CLK := Execute);',
    '',
    'IF _Edge.Q AND NOT _Active THEN',
    '    _Active := TRUE;',
    '    Busy := TRUE;',
    '    Done := FALSE;',
    '    Error := FALSE;',
    '    ErrorCode := 16#0000;',
    '    DriveEnable := TRUE;',
    '    _Timer(IN := FALSE, PT := TimeoutTime);',
    'END_IF;',
    '',
    'IF _Active THEN',
    '    InPosition := ABS(ActualAngle - TargetAngle) <= Tolerance;',
    '    _Timer(IN := TRUE, PT := TimeoutTime);',
    '    IF InPosition THEN',
    '        DriveEnable := FALSE;',
    '        Busy := FALSE;',
    '        Done := TRUE;',
    '        _Active := FALSE;',
    '    ELSIF _Timer.Q THEN',
    '        DriveEnable := FALSE;',
    '        Busy := FALSE;',
    '        Done := FALSE;',
    '        Error := TRUE;',
    '        ErrorCode := ERR_TIMEOUT;',
    '        _Active := FALSE;',
    '    END_IF;',
    'END_IF;',
    'END_FUNCTION_BLOCK',
    ''
  ].join('\n');
}

function dbIoBlock(ctx: RenderContext): string {
  const tags = buildTags(ctx.config);
  const declarations = tags.rows.map((row) => {
    const plcAddress = row.address.replace('I', '%I').replace('Q', '%Q');
    return `    ${row.name} AT ${plcAddress} : ${row.type}; // ${cleanComment(row.comment)}`;
  });
  return [
    'DATA_BLOCK DB_IO',
    'VAR',
    ...declarations,
    'END_VAR',
    'BEGIN',
    'END_DATA_BLOCK',
    ''
  ].join('\n');
}

function ob1Block(ctx: RenderContext): string {
  return [
    'PROGRAM OB1_Main',
    'VAR',
    '    ManualMode : BOOL;',
    '    AutoMode : BOOL;',
    '    AlarmReset : BOOL;',
    '    Abort : BOOL;',
    '    SafeStop : BOOL;',
    '    SafetyTriggered : BOOL;',
    '    StepNo : INT;',
    '    SeqTimeout : BOOL;',
    '    StepErrorCode : WORD;',
    '    AlarmWord : WORD;',
    '    FirstFault : WORD;',
    'END_VAR',
    'BEGIN',
    '    // P8-2：FC_AutoSequence() 与 FC_Alarms() 已接线；FC_Manual() 留待后续。',
    '    // FC_Manual();',
    '    FC_AutoSequence(',
    '        Start := AutoMode,',
    '        Abort := Abort,',
    '        SafeStop := SafeStop,',
    '        StepNo => StepNo,',
    '        SeqTimeout => SeqTimeout,',
    '        StepErrorCode => StepErrorCode,',
    '        AlarmWord := AlarmWord);',
    '    FC_Alarms(',
    '        SeqTimeout := SeqTimeout,',
    '        SafetyTriggered := SafetyTriggered,',
    '        Reset := AlarmReset,',
    '        AlarmWord => AlarmWord,',
    '        FirstFault => FirstFault);',
    '    // 安全 FC 最后执行，保证 SafeStop 同扫描周期内复位所有输出。',
    '    FC_Safety(',
    '        Reset := AlarmReset,',
    '        SafeStop => SafeStop,',
    '        SafetyTriggered => SafetyTriggered);',
    'END_PROGRAM',
    ''
  ].join('\n');
}

function countLines(content: string): number {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n').length;
}

/**
 * 生成 P8-1 的 5 个 ST 文件。纯函数：同一输入（JSON 键序也相同）逐字节一致，
 * 文件正文不含时间戳。
 */
export function generateSt(input: GenerateInput): StGenerateResult {
  const ctx = createRenderContext(input);

  const definitions: Array<{ path: string; render: () => string }> = [
    { path: 'src/FB_Cylinder.st', render: () => cylinderBlock(ctx) },
    { path: 'src/FB_Gripper.st', render: () => gripperBlock(ctx) },
    { path: 'src/FB_RotaryAxis.st', render: () => rotaryBlock(ctx) },
    { path: 'src/DB_IO.st', render: () => dbIoBlock(ctx) },
    { path: 'src/OB1_Main.st', render: () => ob1Block(ctx) }
  ];
  const files: GeneratedFile[] = definitions.map((definition) => ({
    path: definition.path,
    content: renderGeneratedFile(ctx, definition.path, definition.render())
  }));
  const tags = buildTags(ctx.config);
  return {
    files,
    stats: {
      files: files.length,
      lines: files.reduce((total, file) => total + countLines(file.content), 0),
      tags: tags.rows.length,
      inputs: tags.rows.filter((row) => row.address.startsWith('I')).length,
      outputs: tags.rows.filter((row) => row.address.startsWith('Q')).length,
      actuators: (ctx.config.actuators ?? []).length,
      stations: (ctx.config.stations ?? []).length,
      inputHash: ctx.inputHash,
      timeoutTimeMs: ctx.timeoutTimeMs,
      toleranceDeg: ctx.toleranceDeg
    }
  };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `generateSt`。 */
export const generatePlcSt = generateSt;
