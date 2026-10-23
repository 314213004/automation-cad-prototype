import { createRenderContext, renderGeneratedFile, type GenerateInput } from './st.ts';
import { extractSafetyRefs } from './io.ts';
import { buildSymbolMap, outputBindings, resolveSymbol, tagRef } from './symbols.ts';

function resolveSafetyChannels(
  points: readonly string[],
  symbols: Map<string, string>
): string[] {
  const references: string[] = [];
  for (const point of points) {
    const variable = resolveSymbol(symbols, point);
    if (!variable) continue;
    const reference = tagRef(variable);
    if (!references.includes(reference)) references.push(reference);
  }
  return references;
}

/**
 * 生成 FC_Safety.st。急停 / 安全门 / 光栅按常闭串联，断开即 SafeStop，
 * 并锁存到 Reset 上升沿且安全条件恢复。缺失安全点位时只写注释与失效保护，
 * 不伪造任何变量。
 */
export function generateSafety(input: GenerateInput): string {
  const ctx = createRenderContext(input);
  const safety = extractSafetyRefs(ctx.config);
  const symbols = buildSymbolMap(ctx.config);
  const estopChannels = resolveSafetyChannels(safety.estop, symbols);
  const doorChannels = resolveSafetyChannels(safety.safetyDoor, symbols);
  const missingEstop = estopChannels.length === 0;
  const missingDoor = doorChannels.length === 0;
  const missing = missingEstop || missingDoor;

  const body: string[] = [
    'FUNCTION FC_Safety : VOID',
    'VAR_INPUT',
    '    Reset : BOOL;',
    'END_VAR',
    'VAR_OUTPUT',
    '    SafeStop : BOOL;',
    '    SafetyTriggered : BOOL;',
    'END_VAR',
    'VAR',
    '    _ResetEdge : R_TRIG;',
    '    SafetyHealthy : BOOL;',
    'END_VAR',
    'VAR CONSTANT',
    '    ALARM_SAFETY : WORD := 16#8301;',
    'END_VAR',
    ''
  ];

  if (missing) {
    body.push('(* 未配置急停/安全门 *)');
    if (missingEstop) body.push('// 缺少急停通道：保持 SafeStop，补齐点位后重新生成。');
    if (missingDoor) body.push('// 缺少安全门/光栅通道：保持 SafeStop，补齐点位后重新生成。');
    body.push('// 不生成任何虚构的安全输入变量。');
    body.push('SafeStop := TRUE;');
    body.push('SafetyTriggered := TRUE;');
  } else {
    const channels = [...estopChannels, ...doorChannels];
    body.push('_ResetEdge(CLK := Reset);', '');
    body.push('// 急停 / 安全门 / 光栅常闭串联：全部为 TRUE 才视为安全。');
    body.push(`SafetyHealthy := ${channels.join(' AND ')};`, '');
    body.push('IF NOT SafetyHealthy THEN');
    body.push('    SafeStop := TRUE;');
    body.push('    SafetyTriggered := TRUE;');
    body.push('END_IF;', '');
    body.push('// 锁存：仅当安全条件恢复且 Reset 出现上升沿时解除。');
    body.push('IF _ResetEdge.Q AND SafetyHealthy THEN');
    body.push('    SafeStop := FALSE;');
    body.push('    SafetyTriggered := FALSE;');
    body.push('END_IF;', '');

    if (safety.reset) {
      const resetVariable = resolveSymbol(symbols, safety.reset);
      body.push(resetVariable
        ? `// 安全复位点位: ${safety.reset} -> ${tagRef(resetVariable)}`
        : `// 安全复位点位 ${safety.reset} 未出现在 IO 变量表中，改由 HMI 的 Reset 驱动。`);
    } else {
      body.push('// 未配置 safety.reset，Reset 由 HMI/按钮输入驱动。');
    }
  }

  const outputs = outputBindings(ctx.config);
  if (outputs.length > 0) {
    body.push('', '// 任一安全条件断开时复位所有输出。');
    body.push('IF SafeStop THEN');
    const seen = new Set<string>();
    for (const binding of outputs) {
      if (seen.has(binding.row.name)) continue;
      seen.add(binding.row.name);
      body.push(`    ${tagRef(binding.row.name)} := FALSE;`);
    }
    body.push('END_IF;');
  } else {
    body.push('', '// 本机型没有输出点位，SafeStop 仅作为运行许可。');
  }
  body.push('');

  return renderGeneratedFile(ctx, 'src/FC_Safety.st', body.join('\n'));
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `generateSafety`。 */
export const generateSafetyBlock = generateSafety;
