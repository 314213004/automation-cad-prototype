import type { ActuatorConfig, SensorConfig } from '../commission/machine-config.ts';
import type { PlcGenConfig } from './types.ts';
import { createRenderContext, renderGeneratedFile, type GenerateInput } from './st.ts';
import { extractSafetyRefs, normalizePointKey } from './io.ts';
import { buildSymbolMap, resolveSymbol, tagRef } from './symbols.ts';

type SensorExtras = SensorConfig & { role?: string; address?: string; ioAddress?: string };

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function isSafetySensor(sensor: SensorConfig, safetyPoints: Set<string>): boolean {
  const extras = sensor as SensorExtras;
  const points = [sensor.point, extras.address, extras.ioAddress]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return points.some((point) => safetyPoints.has(normalizePointKey(point)));
}

function sensorsForActuator(
  config: PlcGenConfig,
  actuator: ActuatorConfig,
  safetyPoints: Set<string>
): SensorConfig[] {
  const key = normalized(actuator.id);
  const name = normalized(actuator.name);
  return (config.sensors ?? []).filter((sensor) => (
    !isSafetySensor(sensor, safetyPoints)
    && (normalized(sensor.part) === key || normalized(sensor.part) === name)
  ));
}

/**
 * 生成 FC_Alarms.st。统一 AlarmWord 汇总超时 / 传感器矛盾 / 安全触发，
 * FirstFault 按 超时 > 传感器矛盾 > 安全触发 的优先级锁存首个故障。
 */
export function generateAlarms(input: GenerateInput): string {
  const ctx = createRenderContext(input);
  const config = ctx.config;
  const symbols = buildSymbolMap(config);
  const safety = extractSafetyRefs(config);
  const safetyPoints = new Set(
    [...safety.estop, ...safety.safetyDoor].map((point) => normalizePointKey(point))
  );

  const contradictionChecks: string[] = [];
  for (const actuator of config.actuators ?? []) {
    if (actuator.kind !== 'cylinder' && actuator.kind !== 'gripper') continue;
    const sensors = sensorsForActuator(config, actuator, safetyPoints);
    if (sensors.length < 2) continue;
    const first = sensors[0];
    const second = sensors[1];
    if (!first || !second) continue;
    const firstVariable = resolveSymbol(symbols, first.point);
    const secondVariable = resolveSymbol(symbols, second.point);
    if (!firstVariable || !secondVariable) continue;
    const firstRole = actuator.kind === 'gripper' ? '张开' : '伸出';
    const secondRole = actuator.kind === 'gripper' ? '夹紧' : '缩回';
    contradictionChecks.push(
      `// ${actuator.name}：${firstRole} / ${secondRole} 传感器同时为 1`,
      `IF ${tagRef(firstVariable)} AND ${tagRef(secondVariable)} THEN`,
      '    SensorConflict := TRUE;',
      'END_IF;'
    );
  }

  const body: string[] = [
    'FUNCTION FC_Alarms : VOID',
    'VAR_INPUT',
    '    SeqTimeout : BOOL;',
    '    SafetyTriggered : BOOL;',
    '    Reset : BOOL;',
    'END_VAR',
    'VAR_OUTPUT',
    '    AlarmWord : WORD;',
    '    FirstFault : WORD;',
    'END_VAR',
    'VAR',
    '    _ResetEdge : R_TRIG;',
    '    SensorConflict : BOOL;',
    'END_VAR',
    'VAR CONSTANT',
    '    ALARM_TIMEOUT : WORD := 16#8101;',
    '    ALARM_SENSOR_CONFLICT : WORD := 16#8202;',
    '    ALARM_SAFETY : WORD := 16#8301;',
    'END_VAR',
    '',
    '_ResetEdge(CLK := Reset);',
    'SensorConflict := FALSE;',
    ''
  ];

  if (contradictionChecks.length > 0) {
    body.push('// 传感器配对按同一执行机构的绑定顺序：第 1 路=伸出/张开，第 2 路=缩回/夹紧。');
    body.push(...contradictionChecks, '');
  } else {
    body.push('// 没有可配对的执行机构传感器，传感器矛盾检查保持 FALSE。', '');
  }

  body.push(
    '// 统一报警字：所有活动报警按位或。',
    'AlarmWord := 16#0000;',
    'IF SeqTimeout THEN',
    '    AlarmWord := AlarmWord OR ALARM_TIMEOUT;',
    'END_IF;',
    'IF SensorConflict THEN',
    '    AlarmWord := AlarmWord OR ALARM_SENSOR_CONFLICT;',
    'END_IF;',
    'IF SafetyTriggered THEN',
    '    AlarmWord := AlarmWord OR ALARM_SAFETY;',
    'END_IF;',
    '',
    '// 首故障锁存：只在 FirstFault 为空时写入，复位后重新捕获。',
    'IF FirstFault = 16#0000 THEN',
    '    IF SeqTimeout THEN',
    '        FirstFault := ALARM_TIMEOUT;',
    '    ELSIF SensorConflict THEN',
    '        FirstFault := ALARM_SENSOR_CONFLICT;',
    '    ELSIF SafetyTriggered THEN',
    '        FirstFault := ALARM_SAFETY;',
    '    END_IF;',
    'END_IF;',
    '',
    'IF _ResetEdge.Q THEN',
    '    AlarmWord := 16#0000;',
    '    FirstFault := 16#0000;',
    'END_IF;',
    ''
  );

  return renderGeneratedFile(ctx, 'src/FC_Alarms.st', body.join('\n'));
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `generateAlarms`。 */
export const generateAlarmBlock = generateAlarms;
