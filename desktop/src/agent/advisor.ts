/**
 * 主动建议（next-best-action）纯函数。
 *
 * 只根据调用方传入的工程上下文与项目状态摘要产出 0–3 条建议；不读 DOM、不调工具、
 * 不维护「已忽略」状态。忽略集合由调用方通过 options.ignored 传入，因此同一份输入
 * 永远得到同一份输出，便于在会话刷新时复用。
 */

import type { AgentContext } from './context.ts';

export interface AdvisorProjectState {
  /** 当前 BOM 行数（CAD 零件 + 占位件）。 */
  bomRows: number;
  /** BOM 中有 partId、但底板 placement 中没有的件数。 */
  unplaced: number;
  /** 最近一次干涉检查命中数；null = 还没跑过检查（无 CAD 时也为 null）。 */
  conflicts: number | null;
  /** BOM 中缺少 dims.w/h 的件数。 */
  missingDimensions: number;
  hasCadModel: boolean;
  /** null = 尚未运行电气校验。 */
  elecCheckPassed: boolean | null;
  /** 电气校验的严重问题数；未运行时为 0。 */
  elecIssueCount: number;
  /** BOM 在最近一次成本计算后是否又变更过。 */
  costStale: boolean;
  plcGenerated: boolean;
}

export interface AdvisorAskAction {
  kind: 'ask';
  prompt: string;
}

export interface AdvisorToolAction {
  kind: 'tool';
  tool: string;
  args: Record<string, unknown>;
}

export type AdvisorAction = AdvisorAskAction | AdvisorToolAction;

export interface AdvisorSuggestion {
  id: string;
  title: string;
  why: string;
  action: AdvisorAction;
  weight: number;
}

export interface AdvisorOptions {
  /** 本次会话已忽略的建议 id；纯数据，不修改传入集合。 */
  ignored?: Iterable<string>;
  /** 默认 3，上限 3；0 返回空数组。 */
  limit?: number;
}


function count(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function normalizeState(state: AdvisorProjectState): AdvisorProjectState {
  const conflicts = state.conflicts === null ? null : count(state.conflicts);
  return {
    bomRows: count(state.bomRows),
    unplaced: count(state.unplaced),
    conflicts,
    missingDimensions: count(state.missingDimensions),
    hasCadModel: state.hasCadModel === true,
    elecCheckPassed: state.elecCheckPassed === true
      ? true
      : state.elecCheckPassed === false
        ? false
        : null,
    elecIssueCount: count(state.elecIssueCount),
    costStale: state.costStale === true,
    plcGenerated: state.plcGenerated === true
  };
}

function ask(id: string, title: string, why: string, prompt: string, weight: number): AdvisorSuggestion {
  return { id, title, why, action: { kind: 'ask', prompt }, weight };
}

function tool(
  id: string,
  title: string,
  why: string,
  name: string,
  args: Record<string, unknown>,
  weight: number
): AdvisorSuggestion {
  return { id, title, why, action: { kind: 'tool', tool: name, args }, weight };
}

/**
 * 规则表（weight 越大越先展示）：
 * - overlap                  100  底板 placement 重叠
 * - elec-failed               95  电气校验未通过
 * - interference-hits         90  CAD 干涉检查命中
 * - missing-dimensions        85  BOM 缺外形尺寸
 * - interference-unchecked    70  有 CAD 但没跑干涉检查
 * - cost-stale                65  BOM 变更后成本未重算
 * - plc-missing               60  选型齐但 PLC 未生成
 * - deliver-package           50  全部就绪，导出交付包
 */
export function suggestNextActions(
  context: AgentContext,
  project: AdvisorProjectState,
  options: AdvisorOptions = {}
): AdvisorSuggestion[] {
  const state = normalizeState(project);
  const suggestions: AdvisorSuggestion[] = [];

  const overlaps = count(context.plate?.overlaps);
  const placed = count(context.plate?.placed);
  if (overlaps > 0) {
    suggestions.push(ask(
      'overlap',
      `查看 ${overlaps} 处重叠`,
      `底板已放置 ${placed} 个件，检测到 ${overlaps} 处重叠；重叠区域的孔位与安装空间不可用。`,
      '底板哪里重叠了',
      100
    ));
  }

  if (state.elecCheckPassed === false) {
    const issues = state.elecIssueCount;
    suggestions.push(ask(
      'elec-failed',
      issues > 0 ? `先修 ${issues} 处相序/线径问题` : '先修电气校验问题',
      issues > 0
        ? `最近一次电气校验未通过，共 ${issues} 项严重问题（相序 / 线径 / 断路器配合）。`
        : `最近一次电气校验未通过；结果里没有可用的严重问题计数（当前 BOM ${state.bomRows} 行），先打开问题清单确认。`,
      '电气校验哪些地方没通过',
      95
    ));
  }

  if (state.hasCadModel && state.conflicts !== null && state.conflicts > 0) {
    suggestions.push(ask(
      'interference-hits',
      `处理 ${state.conflicts} 处干涉`,
      `CAD 模型已加载（BOM ${state.bomRows} 行），最近一次干涉检查命中 ${state.conflicts} 处；先看清单再改结构。`,
      'CAD 哪里干涉了',
      90
    ));
  }

  if (state.missingDimensions > 0) {
    suggestions.push(ask(
      'missing-dimensions',
      `这 ${state.missingDimensions} 个件没有尺寸，底板画不了`,
      `BOM 共 ${state.bomRows} 行，其中 ${state.missingDimensions} 行缺少 dims.w/h，底板布置无法估算占位。`,
      '哪些件缺少尺寸',
      85
    ));
  }

  if (state.hasCadModel && state.conflicts === null) {
    suggestions.push(tool(
      'interference-unchecked',
      '跑一次干涉检查',
      `CAD 模型已加载（BOM ${state.bomRows} 行），但还没有干涉检查结果。`,
      'run_interference_check',
      {},
      70
    ));
  }

  if (state.costStale) {
    suggestions.push(tool(
      'cost-stale',
      '成本已过期，重算',
      `BOM 已变更（当前 ${state.bomRows} 行），最近一次成本结果早于变更，报价不可直接使用。`,
      'run_cost_report',
      {},
      65
    ));
  }

  if (
    !state.plcGenerated &&
    state.bomRows > 0 &&
    state.unplaced === 0 &&
    state.missingDimensions === 0
  ) {
    suggestions.push(tool(
      'plc-missing',
      '按当前选型生成 PLC',
      `BOM ${state.bomRows} 行已齐（未放置 ${state.unplaced} 个、缺尺寸 ${state.missingDimensions} 个），PLC 尚未生成。`,
      'run_plc_generate',
      {},
      60
    ));
  }

  if (
    state.bomRows > 0 &&
    state.hasCadModel &&
    state.unplaced === 0 &&
    state.conflicts === 0 &&
    state.missingDimensions === 0 &&
    state.elecCheckPassed === true &&
    !state.costStale &&
    state.plcGenerated
  ) {
    suggestions.push(ask(
      'deliver-package',
      '导出交付包（BOM+PDF+PLC）',
      `BOM ${state.bomRows} 行、未放置 ${state.unplaced}、缺失尺寸 ${state.missingDimensions}、干涉 ${state.conflicts}；电气校验通过且 PLC 已生成，可以出交付包。`,
      '导出交付包：BOM、PDF 和 PLC',
      50
    ));
  }

  const ignored = new Set(options.ignored ?? []);
  const requested = options.limit === undefined ? 3 : Math.trunc(options.limit);
  const limit = Math.max(0, Math.min(3, requested));
  return suggestions
    .filter((suggestion) => !ignored.has(suggestion.id))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
}


/**
 * 生成 BOM 指纹，供成本面板 / 建议区判断 BOM 是否在成本计算后变更。
 * 只取型号、partId 与数量，避免备注里的无关改动把成本误判为过期。
 */
export function bomSignatureFromRows(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return JSON.stringify(value.map((row) => {
    if (!row || typeof row !== 'object') return ['', '', 0];
    const source = row as Record<string, unknown>;
    const model = typeof source.model === 'string'
      ? source.model
      : typeof source.spec === 'string'
        ? source.spec
        : typeof source.name === 'string'
          ? source.name
          : '';
    const partId = typeof source.partId === 'string' ? source.partId : '';
    const qty = Number(source.qty ?? source.quantity ?? 1);
    return [partId, model, Number.isFinite(qty) ? qty : 1];
  }));
}
