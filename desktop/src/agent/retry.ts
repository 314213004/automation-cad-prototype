/**
 * 工具调用失败后的重试与回落文案（纯函数）
 *
 * 策略：同一轮用户请求最多重试一次；重试提示必须带上「上次输出错误」并明确
 * 只输出 JSON。仍失败时不再空转，直接说明没听懂，并给出两条可点击候选指令。
 */

export const RETRY_LIMIT = 1;

export interface RetryPromptOptions {
  /** 上一次的具体错误，例如 `参数 qty 应为整数，收到 "3 个"`。 */
  reason: string;
}

function clampReason(reason: string): string {
  const text = reason.trim().replace(/\s+/g, ' ');
  if (!text) return '工具参数无法解析';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** 重试时追加的 user 消息；必须包含固定前缀「上次输出错误：」与「只输出 JSON」。 */
export function buildRetryPrompt(reason: string): string {
  return `上次输出错误：${clampReason(reason)}。只输出 JSON，不要代码围栏、解释文字或多余字段。`;
}

const DEFAULT_CANDIDATES: [string, string] = [
  '列出当前工程里的元器件',
  '生成当前设计的 BOM'
];

/** 根据用户原话给两条最接近的候选指令；始终恰好两条。 */
export function fallbackCandidates(input = ''): [string, string] {
  const text = input.trim();
  if (/成本|报价|价格|多少钱|费用/.test(text)) {
    return ['计算当前设计的成本', '导出一份 CSV 报价单'];
  }
  if (/电气|线号|载流|断路器|合规/.test(text)) {
    return ['检查当前电气图纸的合规性', '读取当前 BOM'];
  }
  if (/导入|STEP|IGES|BREP|STL|CAD/i.test(text)) {
    return ['导入一个 STEP 文件', '读取当前 BOM'];
  }
  if (/放置|底板|摆|安装|干涉|重叠/.test(text)) {
    return ['检查底板干涉', '列出当前工程里的元器件'];
  }
  if (/PLC|程序|联调|点位/i.test(text)) {
    return ['验证当前 PLC 程序', '读取当前 BOM'];
  }
  return DEFAULT_CANDIDATES;
}

/**
 * 两次都失败后的用户可见文案。UI 识别「候选 1/2：」行并渲染成可点击按钮。
 * 不包含模型原始输出，避免把无效参数再次暴露给用户。
 */
export function buildFallbackReply(reason: string, input = ''): string {
  const [first, second] = fallbackCandidates(input);
  return [
    `没听懂这次工具调用，参数无法安全修复（原因：${clampReason(reason)}）。我没有执行任何工具，工程未改动。`,
    '候选指令：',
    `候选 1：${first}`,
    `候选 2：${second}`,
    '也可以把任务拆短一点再发一次。'
  ].join('\n');
}

/** 从助手文案里提取候选指令，供侧栏渲染点击按钮。 */
export function parseFallbackCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^候选\s*[12]\s*[：:]\s*(.+)$/);
    if (match?.[1]) candidates.push(match[1].trim());
  }
  return candidates.slice(0, 2);
}
