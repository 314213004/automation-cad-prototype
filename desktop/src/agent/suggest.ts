/**
 * 失败建议（纯函数）
 *
 * 输入稳定的错误码、原始消息、工具与参数，输出中文建议和可执行的替代方案。
 * 原则：只根据已知错误码给建议；未知码明确说「无法判断原因」，不编造。
 */

import { summarizeArguments } from './feedback.ts';

export interface FailureInput {
  code: string;
  message?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface FailureSuggestion {
  advice: string;
  alternatives: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function keywordFrom(input: FailureInput): string {
  const args = input.args ?? {};
  for (const key of ['model', 'newModel', 'q', 'partId', 'ref', 'designator', 'tag', 'name']) {
    const value = text(args[key]);
    if (value) return value;
  }
  const message = text(input.message);
  const quoted = message.match(/[「“"]([^」”"]{1,60})[」”"]/);
  if (quoted?.[1]) return quoted[1].trim();
  const model = message.match(/(?:型号|物料号)\s*[:：]?\s*([A-Za-z0-9._-]{2,40})/);
  return model?.[1] ?? '';
}

function firstErrorLine(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines.find((line) => /(?:错误|error|失败|缺少|无效|不允许)/i.test(line)) ?? lines[0] ?? '';
  return first.replace(/^预检失败\s*[:：]\s*/, '').slice(0, 240);
}

function precheckLocation(message: string): string {
  if (/点位|IO|I\/O|映射/i.test(message)) return '机型配置的 IO 点位 / 映射表';
  if (/执行机构|行程|动作/i.test(message)) return '执行机构与动作/序列定义';
  if (/传感器|条件|超时/i.test(message)) return '传感器条件与序列超时配置';
  return 'PLC 机型配置（PLC 程序面板的预检列表会标出位置）';
}

function unknown(input: FailureInput): FailureSuggestion {
  const code = input.code || 'UNKNOWN';
  const message = text(input.message);
  const tool = input.tool ? `${input.tool} ` : '';
  return {
    advice: `${tool}执行失败（${code}${message ? `：${message}` : ''}）。当前没有该错误码的专门建议，无法判断具体原因，请按原消息排查。`,
    alternatives: [
      `把错误码 ${code} 与完整消息反馈给维护者`,
      '先用只读工具检查当前工程上下文（get_project_context）',
      '重试前确认参数与目标对象存在，不要假定已经写入'
    ]
  };
}

export function suggestFailure(input: FailureInput): FailureSuggestion {
  const code = text(input.code).toUpperCase();
  const message = text(input.message);
  const tool = text(input.tool);
  const keyword = keywordFrom(input);

  if (code === 'PART_NOT_FOUND') {
    const quoted = keyword ? `「${keyword}」` : '';
    return {
      advice: `未找到型号${quoted}。先调用 search_components 搜索该关键词，确认型号存在于已启用的数据包中，再执行放置或修改。`,
      alternatives: [
        keyword ? `search_components q=${keyword}` : 'search_components q=<型号关键词>',
        '打开「数据包」面板，确认包含该品牌的包已启用',
        keyword ? `若型号写法不同，先用 list_components 按类别查看，或换用 ${keyword} 的同系列型号` : '若型号写法不同，先用 list_components 按类别查看'
      ]
    };
  }

  if (code === 'NO_DIMENSIONS') {
    const quoted = keyword ? `「${keyword}」` : '该型号';
    return {
      advice: `${quoted}缺少外形尺寸（w/h/d），无法可靠放置或计算布局。请换有尺寸的型号，或到元件库补录尺寸。`,
      alternatives: [
        '先 search_components 查看同系列中带尺寸的型号',
        '在「数据包 / 元件库」补录该型号的 dims（w、h、d，单位 mm）后重试',
        '若只是占位，可先 insert_component 插入占位件，尺寸后续人工补录'
      ]
    };
  }

  if (code === 'UNAVAILABLE') {
    return {
      advice: `对应服务不可用${message ? `：${message}` : ''}。请检查该服务是否已启动，以及桌面主进程日志中的启动错误。`,
      alternatives: [
        '参数化建模：检查 Python sidecar 与 build123d 运行环境是否就绪',
        '确认本机 7420 端口没有被占用，且 userData/agent-token 可读',
        '在 AutomationCAD 桌面应用内重试；外部进程不要直接访问渲染层'
      ]
    };
  }

  if (code === 'DESKTOP_NOT_RUNNING') {
    return {
      advice: '外部 Agent 未连接到桌面应用。先启动 AutomationCAD 并保持窗口运行，再重试；桌面启动后会在 127.0.0.1:7420 提供 JSON-RPC。',
      alternatives: [
        '启动 AutomationCAD 桌面应用',
        '检查 7420 端口占用情况与 userData/agent-token 文件',
        '只读检索可先用 MCP 本地回退（list_components / search_components）'
      ]
    };
  }

  if (code === 'PRECHECK_FAILED') {
    const first = firstErrorLine(message);
    const location = precheckLocation(message);
    return {
      advice: first
        ? `预检未通过，未写入文件。第一条错误：${first}。修复位置：${location}。`
        : '预检未通过，未写入文件；结果中没有第一条错误详情。请打开 PLC 生成面板查看预检列表。',
      alternatives: [
        '打开「PLC 程序」面板，按预检列表逐条修复后重新生成',
        '先用 verify_plc_program 只读验证，确认 0 error 再落盘',
        `检查${location}`
      ]
    };
  }

  if (code === 'USER_DENIED') {
    return {
      advice: `${tool || '该工具'}未执行：用户在确认弹窗中选择了拒绝，装配体与文件都没有改动。`,
      alternatives: [
        '确认参数无误后重新发送同一请求，并在确认弹窗点「允许」',
        '先用 get_project_context / search_components 核对目标对象与参数',
        '只读校验可改用 verify_plc_program / run_cost_report，不需要写确认'
      ]
    };
  }

  return unknown(input);
}

/** 供失败卡片显示的一行参数上下文（脱敏）。 */
export function describeFailureContext(input: FailureInput): string {
  return [input.tool, input.code, summarizeArguments(input.args, 120)].filter(Boolean).join(' · ');
}
