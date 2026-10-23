import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PlcGenConfig } from '../src/plcgen/types.ts';
import { buildTags } from '../src/plcgen/tags.ts';
import { buildSequencePlan, generateSequence } from '../src/plcgen/sequence.ts';
import { generateSafety } from '../src/plcgen/safety.ts';
import { generateAlarms } from '../src/plcgen/alarms.ts';
import {
  generateProject,
  PROJECT_FILE_ORDER,
  type GenerateProjectSuccess
} from '../src/plcgen/generate.ts';

function makeConfig(overrides: Record<string, unknown> = {}): PlcGenConfig {
  return {
    id: 'p82-machine',
    name: 'P8-2 测试机型',
    stations: ['上料'],
    actuators: [
      {
        id: 'cyl-1',
        name: '上料气缸',
        kind: 'cylinder',
        station: '上料',
        extendPoint: 'Y0',
        retractPoint: 'Y1',
        travelMm: 40,
        durationMs: 400
      }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-1' }
    ],
    safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
    sequence: [],
    ...overrides
  } as PlcGenConfig;
}

function sequenceContent(config: PlcGenConfig): string {
  return generateSequence({ config }).content;
}

function warningCodes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

function success(result: ReturnType<typeof generateProject>): GenerateProjectSuccess {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('生成被预检拦截');
  return result;
}

test('P8-2 序列：空步序生成骨架并给 warning，不报错', () => {
  const result = generateSequence({ config: makeConfig() });
  assert.equal(result.steps, 0);
  assert.ok(warningCodes(result.warnings).includes('SEQUENCE_EMPTY'));
  assert.match(result.content, /FUNCTION FC_AutoSequence/);
  assert.match(result.content, /CASE StepNo OF/);
  assert.match(result.content, /联调步序为空/);
  assert.doesNotMatch(result.content, /\n\s+1:\n/);
});

test('P8-2 序列：置位动作映射为输出 TRUE 与 StepNo 分支', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0' }]
  }));
  assert.match(content, /\n\s+1:\n/);
  assert.match(content, /"DB_IO"\.上料_上料气缸_伸出 := TRUE;/);
  assert.match(content, /IF "DB_IO"\.上料_上料气缸_到位 THEN/);
});

test('P8-2 序列：复位动作映射为输出 FALSE', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '缩回', action: 'reset', point: 'Y1', condition: 'X1' }]
  }));
  assert.match(content, /"DB_IO"\.上料_上料气缸_缩回 := FALSE;/);
});

test('P8-2 序列：点位 AND 组合原样进入转移条件', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '双到位', action: 'wait', condition: 'X0 AND X1' }]
  }));
  assert.match(content, /IF "DB_IO"\.上料_上料气缸_到位 AND "DB_IO"\.上料_上料气缸_到位_2 THEN/);
});

test('P8-2 序列：点位 OR 组合保留括号', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '任一到位', action: 'wait', condition: 'X0 OR X1' }]
  }));
  assert.match(content, /IF \("DB_IO"\.上料_上料气缸_到位 OR "DB_IO"\.上料_上料气缸_到位_2\) THEN/);
});

test('P8-2 序列：expect=false 生成 NOT 条件', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '等待离开', action: 'wait', point: 'X0', expect: false }]
  }));
  assert.match(content, /IF NOT "DB_IO"\.上料_上料气缸_到位 THEN/);
});

test('P8-2 序列：缺省超时为 5s', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0' }]
  }));
  assert.match(content, /_StepTimer\(IN := TRUE, PT := T#5s\);/);
});

test('P8-2 序列：单步超时可覆盖为毫秒', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 2500 }]
  }));
  assert.match(content, /_StepTimer\(IN := TRUE, PT := T#2500ms\);/);
});

test('P8-2 序列：超时转 STEP_ERROR 并写报警字', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0' }]
  }));
  assert.match(content, /StepNo := STEP_ERROR;/);
  assert.match(content, /StepErrorCode := 16#8101;/);
  assert.match(content, /AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT;/);
  assert.match(content, /STEP_ERROR:/);
});

test('P8-2 序列：Abort 与 SafeStop 均复位到 Step0', () => {
  const content = sequenceContent(makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0' }]
  }));
  assert.match(content, /IF _AbortEdge\.Q OR SafeStop THEN/);
  assert.match(content, /StepNo := STEP_IDLE;/);
  assert.match(content, /_StepTimer\(IN := FALSE/);
});

test('P8-2 序列：最后一步完成后回 Step0 并返回步数', () => {
  const result = generateSequence({ config: makeConfig({
    sequence: [
      { name: '伸出', action: 'set', point: 'Y0', condition: 'X0' },
      { name: '缩回', action: 'set', point: 'Y1', condition: 'X1' }
    ]
  }) });
  assert.equal(result.steps, 2);
  assert.match(result.content, /StepNo := 2;/);
  assert.match(result.content, /StepNo := 0;/);
});

test('P8-2 序列：无转移条件给出 warning 且条件为 TRUE', () => {
  const result = generateSequence({ config: makeConfig({
    sequence: [{ name: '直接跳转', action: 'set', point: 'Y0' }]
  }) });
  assert.ok(warningCodes(result.warnings).includes('SEQUENCE_NO_CONDITION'));
  assert.match(result.content, /IF TRUE THEN/);
});

test('P8-2 序列：未知点位保留符号并给出 warning', () => {
  const result = generateSequence({ config: makeConfig({
    sequence: [{ name: '未知', action: 'wait', condition: 'X99 OR X0' }]
  }) });
  assert.ok(warningCodes(result.warnings).includes('SEQUENCE_POINT_UNRESOLVED'));
  assert.match(result.content, /X99/);
});

test('P8-2 序列：计划模型保留动作、条件与超时', () => {
  const plan = buildSequencePlan({ config: makeConfig({
    sequence: [{ id: 's1', name: '伸出', action: 'set', point: 'Y0', waitPoints: ['X0'], timeoutMs: 1200 }]
  }) });
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0]?.sets, ['Y0']);
  assert.deepEqual(plan.steps[0]?.waits, ['X0']);
  assert.equal(plan.steps[0]?.timeoutMs, 1200);
});

test('P8-2 安全：急停与安全门按常闭串联', () => {
  const content = generateSafety(makeConfig());
  assert.match(content, /SafetyHealthy := "DB_IO"\.安全_安全回路_急停 AND "DB_IO"\.安全_安全回路_安全门;/);
  assert.match(content, /急停 \/ 安全门 \/ 光栅常闭串联/);
});

test('P8-2 安全：断开即 SafeStop 并锁存到 Reset 上升沿', () => {
  const content = generateSafety(makeConfig());
  assert.match(content, /IF NOT SafetyHealthy THEN\n\s+SafeStop := TRUE;\n\s+SafetyTriggered := TRUE;/);
  assert.match(content, /IF _ResetEdge\.Q AND SafetyHealthy THEN\n\s+SafeStop := FALSE;\n\s+SafetyTriggered := FALSE;/);
});

test('P8-2 安全：SafeStop 时复位所有输出', () => {
  const content = generateSafety(makeConfig());
  assert.match(content, /IF SafeStop THEN/);
  assert.match(content, /"DB_IO"\.上料_上料气缸_伸出 := FALSE;/);
  assert.match(content, /"DB_IO"\.上料_上料气缸_缩回 := FALSE;/);
});

test('P8-2 安全：缺失安全点位生成注释且不伪造变量', () => {
  const content = generateSafety(makeConfig({ safety: undefined }));
  assert.match(content, /\(\* 未配置急停\/安全门 \*\)/);
  assert.match(content, /SafeStop := TRUE;/);
  assert.doesNotMatch(content, /"DB_IO"\.[^\n]*(急停|安全门)/);
});

test('P8-2 安全：只缺安全门同样强制安全停止', () => {
  const content = generateSafety(makeConfig({ safety: { emergencyStop: 'X8' } }));
  assert.match(content, /\(\* 未配置急停\/安全门 \*\)/);
  assert.match(content, /缺少安全门\/光栅通道/);
  assert.doesNotMatch(content, /SafetyHealthy :=/);
});

test('P8-2 报警：超时写入统一 AlarmWord', () => {
  const content = generateAlarms(makeConfig());
  assert.match(content, /IF SeqTimeout THEN\n\s+AlarmWord := AlarmWord OR ALARM_TIMEOUT;/);
  assert.match(content, /ALARM_TIMEOUT : WORD := 16#8101;/);
});

test('P8-2 报警：同一机构两路传感器同时为 1 报矛盾', () => {
  const content = generateAlarms(makeConfig());
  assert.match(content, /IF "DB_IO"\.上料_上料气缸_到位 AND "DB_IO"\.上料_上料气缸_到位_2 THEN\n\s+SensorConflict := TRUE;/);
  assert.match(content, /AlarmWord := AlarmWord OR ALARM_SENSOR_CONFLICT;/);
});

test('P8-2 报警：安全触发并入 AlarmWord', () => {
  const content = generateAlarms(makeConfig());
  assert.match(content, /IF SafetyTriggered THEN\n\s+AlarmWord := AlarmWord OR ALARM_SAFETY;/);
});

test('P8-2 报警：首故障锁存且 Reset 后清空', () => {
  const content = generateAlarms(makeConfig());
  assert.match(content, /IF FirstFault = 16#0000 THEN/);
  assert.match(content, /FirstFault := ALARM_TIMEOUT;/);
  assert.match(content, /IF _ResetEdge\.Q THEN\n\s+AlarmWord := 16#0000;\n\s+FirstFault := 16#0000;/);
});

test('P8-2 汇总：固定 11 个文件且顺序稳定', () => {
  const result = success(generateProject({ config: makeConfig() }));
  assert.deepEqual(result.files.map((file) => file.path), [...PROJECT_FILE_ORDER]);
  assert.equal(result.stats.files, 11);
  assert.equal(result.stats.steps, 0);
  assert.equal(result.stats.sequenceEmpty, true);
});

test('P8-2 汇总：同输入两次生成每个文件 sha256 一致', () => {
  const input = { config: makeConfig({
    sequence: [
      { name: '伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { name: '缩回', action: 'set', point: 'Y1', condition: 'X1' }
    ]
  }) };
  const first = success(generateProject(input));
  const second = success(generateProject(input));
  assert.deepEqual(first.files.map((file) => file.path), second.files.map((file) => file.path));
  for (const [index, file] of first.files.entries()) {
    const repeated = second.files[index];
    assert.ok(repeated);
    const digest = createHash('sha256').update(file.content).digest('hex');
    const repeatedDigest = createHash('sha256').update(repeated.content).digest('hex');
    assert.equal(digest, repeatedDigest, file.path);
    assert.equal(first.stats.hashes[file.path], digest);
  }
});

test('P8-2 汇总：mapping.json 串起位号、点位、变量与步序', () => {
  const result = success(generateProject({ config: makeConfig({
    sequence: [{ name: '伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 }]
  }) }));
  const mappingFile = result.files.find((file) => file.path === 'mapping.json');
  assert.ok(mappingFile);
  const mapping = JSON.parse(mappingFile.content) as {
    inputHash: string;
    points: Array<{ point: string; variable: string; steps: number[]; ref: string }>;
    sequence: Array<{ stepNo: number; sets: string[]; condition: string }>;
  };
  assert.equal(mapping.inputHash, result.stats.inputHash);
  const point = mapping.points.find((entry) => entry.point === 'Y0');
  assert.ok(point);
  assert.equal(point.variable, '上料_上料气缸_伸出');
  assert.deepEqual(point.steps, [1]);
  assert.equal(mapping.sequence[0]?.stepNo, 1);
  assert.deepEqual(mapping.sequence[0]?.sets, ['Y0']);
  assert.match(mapping.sequence[0]?.condition ?? '', /DB_IO/);
});

test('P8-2 汇总：io-tags.csv 与 buildTags 逐字节一致', () => {
  const config = makeConfig();
  const result = success(generateProject({ config }));
  const csv = result.files.find((file) => file.path === 'io-tags.csv');
  assert.ok(csv);
  assert.equal(csv.content, buildTags(config).csv);
});

test('P8-2 汇总：OB1 实际调用序列、报警与安全 FC', () => {
  const result = success(generateProject({ config: makeConfig() }));
  const ob1 = result.files.find((file) => file.path === 'src/OB1_Main.st');
  assert.ok(ob1);
  assert.match(ob1.content, /FC_AutoSequence\(/);
  assert.match(ob1.content, /FC_Alarms\(/);
  assert.match(ob1.content, /FC_Safety\(/);
  assert.match(ob1.content, /安全 FC 最后执行/);
});

test('P8-2 汇总：预检有 error 时不生成文件', () => {
  const result = generateProject({ config: makeConfig({
    sequence: [{ name: '坏点位', action: 'wait', point: 'X99' }]
  }) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'SEQUENCE_POINT_NOT_FOUND'));
  assert.equal('files' in result, false);
});

test('P8-2 汇总：缺安全点位被预检拦截', () => {
  const result = generateProject({ config: makeConfig({ safety: undefined }) });
  assert.equal(result.ok, false);
  const found = new Set(result.errors.map((error) => error.code));
  assert.ok(found.has('ESTOP_UNDEFINED'));
  assert.ok(found.has('SAFETY_DOOR_UNDEFINED'));
});

test('P8-2 汇总：空步序仍能生成并保留 warning', () => {
  const result = success(generateProject({ config: makeConfig() }));
  assert.ok(result.warnings.some((warning) => warning.code === 'SEQUENCE_EMPTY'));
  const auto = result.files.find((file) => file.path === 'src/FC_AutoSequence.st');
  assert.ok(auto);
  assert.match(auto.content, /联调步序为空/);
});

test('P8-2 汇总：README 与所有文件头使用同一 inputHash 且无时间戳', () => {
  const result = success(generateProject({ config: makeConfig() }));
  const readme = result.files.find((file) => file.path === 'README.md');
  assert.ok(readme);
  assert.match(readme.content, new RegExp(result.stats.inputHash));
  assert.doesNotMatch(readme.content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  for (const file of result.files) {
    if (file.path.endsWith('.st')) {
      assert.match(file.content, new RegExp(`输入哈希: ${result.stats.inputHash}`), file.path);
    }
  }
});
