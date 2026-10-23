/**
 * 离线规则意图路由（P7-A）
 *
 * 目标：不依赖大模型、不联网也能把中文指令落到只读工具上；模型不可用时由
 * `AgentSession` 直接走这里，避免「断网就什么都问不了」。
 *
 * 设计约束：
 * - 纯函数，无 IO、无 DOM、无 Electron 依赖，可直接单测；
 * - 只做「意图分类 + 工具选择」，不执行工具；
 * - 写工具一律标 `readOnly: false`，离线通道只执行 `readOnly: true` 的计划。
 */

export type IntentKind =
  | 'query'
  | 'compute'
  | 'modify'
  | 'generate'
  | 'commission'
  | 'sync'
  | 'out_of_scope';

export const INTENT_ORDER: IntentKind[] = [
  'query',
  'compute',
  'modify',
  'generate',
  'commission',
  'sync',
  'out_of_scope'
];

export const INTENT_LABELS: Record<IntentKind, string> = {
  query: '查询',
  compute: '计算',
  modify: '修改',
  generate: '生成',
  commission: '联调',
  sync: '同步',
  out_of_scope: '超纲'
};

interface IntentRule {
  intent: Exclude<IntentKind, 'out_of_scope'>;
  strong: string[];
  normal: string[];
}

/** 优先级用于同分时裁决：写操作 > 生成 > 同步 > 联调 > 计算 > 查询。 */
const INTENT_PRIORITY: Record<Exclude<IntentKind, 'out_of_scope'>, number> = {
  modify: 6,
  generate: 5,
  sync: 4,
  commission: 3,
  compute: 2,
  query: 1
};

const RULES: IntentRule[] = [
  {
    intent: 'modify',
    strong: ['插入', '放置', '删掉', '删除', '撤销', '撤消', '改线号', '改型号', '换型号', '换成', '换掉', '替换', '导入'],
    normal: ['放一个', '放两个', '加一个', '添加', '修改', '改成', '改一下', '移走']
  },
  {
    intent: 'generate',
    strong: ['出图', '导出', '生成', '出一份', '出份', '生成报告', '生成BOM', '生成 BOM', '报价单'],
    normal: ['报告', 'pdf', 'PDF', 'csv', 'CSV', 'excel', '打印', '出一份', '出份']
  },
  {
    intent: 'sync',
    strong: ['同步', '上传', '设计包', '版本对比'],
    normal: ['下发', '推送', '云端', '服务器']
  },
  {
    intent: 'commission',
    strong: ['联调', '上电', '跑序列', '故障诊断', '报警'],
    normal: ['点位', '调试', '手动模式', '自动模式', '诊断', 'IO']
  },
  {
    intent: 'compute',
    strong: ['成本', '多少钱', '报价', '干涉', '电气校验', '载流量', '不平衡度', '余量'],
    normal: ['计算', '算一下', '算一遍', '重算', '算算', '够不够', '合规', '校验', '检查', '统计', '功率', '费用', '总价', '合计']
  },
  {
    intent: 'query',
    strong: ['有哪些', '有什么', '列出', '列一下', '搜索', '搜一下', '查找', '找一下', '查一下', 'BOM', '物料清单'],
    normal: ['型号', '参数', '在哪', '什么', '清单', '看看', '多少', '几个', '价格', '读一下']
  }
];

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentMatch {
  intent: IntentKind;
  confidence: IntentConfidence;
  score: number;
  hits: string[];
  reason: string;
}

function scoreRules(text: string): Array<{ intent: Exclude<IntentKind, 'out_of_scope'>; score: number; hits: string[] }> {
  return RULES.map((rule) => {
    const hits: string[] = [];
    let score = 0;
    for (const keyword of rule.strong) {
      if (text.includes(keyword)) {
        score += 3;
        hits.push(keyword);
      }
    }
    for (const keyword of rule.normal) {
      if (text.includes(keyword)) {
        score += 1;
        hits.push(keyword);
      }
    }
    return { intent: rule.intent, score, hits };
  });
}

/**
 * 把「先查…再算…」拆成有序子句。只认明确连接词，避免把普通顿号/逗号拆坏；
 * 空子句（例如句首的「再」）会被丢掉。
 */
export function splitInstructionSteps(text: string): string[] {
  const normalized = (text ?? '').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?:然后|接着|之后|最后|并且|同时|再|并)/)
    .map((part) =>
      part
        .trim()
        .replace(/^[，,、；;:：]+|[，,、；;:：]+$/g, '')
        .replace(/^(?:先|再|然后|接着|之后|最后|并且|同时|并)/, '')
        .trim()
    )
    .filter(Boolean);
}

/** 规则分类：取分最高者，同分按写操作优先，全 0 判为超纲。 */
export function routeIntent(text: string): IntentMatch {
  const normalized = (text ?? '').trim();
  if (!normalized) {
    return { intent: 'out_of_scope', confidence: 'low', score: 0, hits: [], reason: '输入为空' };
  }
  // 多步指令以最后一步的目标分类：「读 BOM 然后做干涉」应算计算而不是查询。
  const steps = splitInstructionSteps(normalized);
  const lastStep = steps.length > 1 ? steps[steps.length - 1]! : normalized;
  let scored = scoreRules(lastStep).filter((entry) => entry.score > 0);
  // 「刚才那个 BOM 再读一遍」里的「再」是重做副词，不是新的子任务；
  // 最后一段无可识别意图时回退到整句，避免拆坏原本能判的指令。
  if (scored.length === 0 && lastStep !== normalized) {
    scored = scoreRules(normalized).filter((entry) => entry.score > 0);
  }
  if (scored.length === 0) {
    return {
      intent: 'out_of_scope',
      confidence: 'low',
      score: 0,
      hits: [],
      reason: '未匹配到工程意图关键词，按超纲处理'
    };
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return INTENT_PRIORITY[right.intent] - INTENT_PRIORITY[left.intent];
  });
  const best = scored[0]!;
  const confidence: IntentConfidence = best.score >= 3 ? 'high' : best.score === 2 ? 'medium' : 'low';
  return {
    intent: best.intent,
    confidence,
    score: best.score,
    hits: best.hits,
    reason: `命中 ${best.hits.join('、')}`
  };
}

export interface ToolPlan {
  tool: string;
  args: Record<string, unknown>;
  /** 只读工具允许离线直接执行；写工具只能进确认流程。 */
  readOnly: boolean;
  /** 写工具缺少的必要参数，离线时用于解释为什么不执行。 */
  missing: string[];
  why: string;
}

/** 目前注册的 10 个工具里，只读的那 6 个（写操作 4 个）。 */
export const READ_ONLY_TOOLS = new Set([
  'list_components',
  'search_components',
  'get_bom',
  'run_interference_check',
  'run_electrical_check',
  'run_cost_report'
]);

export const WRITE_TOOLS = new Set(['import_cad', 'insert_component', 'undo_last', 'export_cost_report']);

/** 类别同义词 → 数据包里的真实 category。 */
const CATEGORY_SYNONYMS: Record<string, string> = {
  断路器: '断路器',
  空开: '断路器',
  空气开关: '断路器',
  接触器: '接触器',
  热继: '热继电器',
  热继电器: '热继电器',
  中间继电器: '中间继电器',
  继电器: '中间继电器',
  按钮: '按钮与开关',
  开关: '按钮与开关',
  指示灯: '指示与信号',
  信号灯: '指示与信号',
  端子: '端子与辅材',
  辅材: '端子与辅材',
  开关电源: '开关电源',
  电源: '开关电源',
  plc: 'PLC',
  PLC: 'PLC',
  传感器: '传感器',
  变频器: '变频器',
  伺服: '伺服',
  时间继电器: '时间继电器',
  安全继电器: '安全继电器',
  浪涌保护器: '浪涌保护器',
  熔断器: '熔断器',
  行程开关: '行程开关',
  隔离开关: '隔离开关',
  HMI: 'HMI',
  触摸屏: 'HMI',
  软启动器: '软启动器',
  步进: '步进',
  编码器: '编码器',
  仪表: '仪表',
  安全件: '安全件',
  视觉: '识别与视觉',
  气缸: '气缸',
  气爪: '气爪',
  电磁阀: '电磁阀',
  气动接头: '气动接头',
  气源处理: '气源处理'
};

const POLITE_PREFIXES = [
  '帮我',
  '请',
  '麻烦',
  '给我',
  '我想',
  '我要',
  '能不能',
  '可以',
  '帮忙'
];

const QUERY_VERBS = [
  '查一下',
  '查查',
  '查',
  '看一下',
  '看看',
  '搜索一下',
  '搜索',
  '搜一下',
  '搜',
  '查找',
  '找一下',
  '找',
  '列出所有',
  '列出',
  '列举',
  '显示',
  '读一下',
  '读',
  '有哪些',
  '有什么'
];

const STOPWORDS = [
  '怎么样',
  '多少钱',
  '多少',
  '哪些',
  '什么',
  '在哪',
  '哪里',
  '价格',
  '参数',
  '型号',
  '这个',
  '那个',
  '一下',
  '所有',
  '全部',
  '一共',
  '当前',
  '机台',
  '整机',
  '设备',
  '柜子',
  '柜内',
  '工位',
  '里',
  '里面',
  '一个',
  '两个',
  '几个',
  '多少',
  '吗',
  '呢',
  '吧',
  '的',
  '是',
  '有',
  '和',
  '与',
  '吧'
];

const LIST_VERBS = ['有哪些', '列出', '列举', '所有', '全部', '清单', '显示'];

/** 指代词只用于消解上下文，不能当成元件搜索词。 */
const REFERENCE_WORDS = [
  '左边第二个',
  '右边第二个',
  '左边那个',
  '右边那个',
  '刚才那个',
  '刚才的',
  '这个',
  '那个',
  '这台',
  '那台',
  '它',
  '他',
  '她'
];

const REFERENCE_PATTERN = /(左边第二个|右边第二个|左边那个|右边那个|刚才那个|这个|那个|这台|那台|它)/;
const DOMAIN_NOUNS = /(机台|整机|项目|设备|柜子|工位|全部|所有|当前|BOM|物料|成本|报价|费用|总价|合计|电气|线号|载流量|干涉|装配|元件|器件)/i;

function matchCategory(text: string): string | null {
  // 长词优先，避免「继电器」抢走「热继电器」「安全继电器」。
  const keys = Object.keys(CATEGORY_SYNONYMS).sort((left, right) => right.length - left.length);
  for (const key of keys) {
    if (text.includes(key)) return CATEGORY_SYNONYMS[key]!;
  }
  return null;
}

/** 抽出用户真正想搜的词：去掉客套话、动词、疑问词与量词。 */
export function extractQuery(text: string): string {
  let value = (text ?? '').trim();
  for (const prefix of POLITE_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  }
  for (const reference of [...REFERENCE_WORDS].sort((left, right) => right.length - left.length)) {
    value = value.split(reference).join(' ');
  }
  for (const verb of QUERY_VERBS) value = value.split(verb).join(' ');
  for (const word of STOPWORDS) value = value.split(word).join(' ');
  // 类别词按长度倒序剔除，否则「继电器」会先把「热继电器」拆成「热」。
  for (const category of Object.keys(CATEGORY_SYNONYMS).sort((left, right) => right.length - left.length)) {
    value = value.split(category).join(' ');
  }
  return value
    .replace(/[，。！？、,.!?；;：:"'“”‘’()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exportFormat(text: string): 'pdf' | 'csv' {
  return /csv|excel|表格/i.test(text) ? 'csv' : 'pdf';
}

function extractPartId(text: string): string | null {
  const match = text.match(/(?:partId|物料号|物料编号|物料\s*号)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/i);
  return match?.[1] ?? null;
}

function extractCadPath(text: string): string | null {
  const match = text.match(/[A-Za-z]:\\[^\s，。；;]+/);
  return match?.[0] ?? null;
}

/** 只有指代、没有工程对象/领域词的报价请求应先追问，不能拿「那个东西」去搜元件。 */
function isBareReferencePriceQuery(text: string, category: string | null): boolean {
  if (!REFERENCE_PATTERN.test(text)) return false;
  if (category || DOMAIN_NOUNS.test(text)) return false;
  return /(多少钱|价格|费用|报价|成本|总价|合计)/.test(text);
}

/**
 * 把中文指令映射成一个工具计划。
 * 返回 null 表示「没有任何工具能接住」，调用方应如实说做不了。
 */
export function planTool(text: string): ToolPlan | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  const match = routeIntent(value);
  if (match.intent === 'out_of_scope') return null;
  // 联调/同步工具尚未注册：规则层只能明确说「暂不支持」，不能降级成搜索元件。
  if (match.intent === 'commission' || match.intent === 'sync') return null;

  const category = matchCategory(value);

  if (/(撤销|撤消)/.test(value)) {
    return { tool: 'undo_last', args: {}, readOnly: false, missing: [], why: '撤销最近一次写操作' };
  }
  if (/(删掉|删除)/.test(value)) {
    return { tool: 'undo_last', args: {}, readOnly: false, missing: [], why: '删除能力暂由撤销最近一次写操作承接（需确认）' };
  }

  // 写操作优先判断：宁可多要一次确认，也不能把写当成只读。
  if (/(导出|生成|出一份|出份|打印)/.test(value) && /(成本|报价|费用|报告|报表|报价单)/.test(value)) {
    return {
      tool: 'export_cost_report',
      args: { format: exportFormat(value) },
      readOnly: false,
      missing: [],
      why: `生成并落盘 ${exportFormat(value).toUpperCase()} 成本报告（写入 userData/exports/，需确认）`
    };
  }
  if (/(导入|打开).*(step|stp|iges|stl|obj|glb)/i.test(value)) {
    const path = extractCadPath(value);
    return {
      tool: 'import_cad',
      args: path ? { path } : {},
      readOnly: false,
      missing: path ? [] : ['path'],
      why: path ? `导入 CAD 文件 ${path}（需确认）` : '导入 CAD 需要本机文件绝对路径'
    };
  }
  if (/(插入|放一个|放置|添加)/.test(value)) {
    const partId = extractPartId(value);
    return {
      tool: 'insert_component',
      args: partId ? { partId } : {},
      readOnly: false,
      missing: partId ? [] : ['partId'],
      why: partId ? `插入物料 ${partId} 的占位件（需确认）` : '插入占位件属于写操作，需要先确定物料号并二次确认'
    };
  }

  // 只读工具：按「最具体」到「最泛」排序，避免「BOM 成本」落到 get_bom。
  if (/干涉|碰撞/.test(value)) {
    return {
      tool: 'run_interference_check',
      args: {},
      readOnly: true,
      missing: [],
      why: '对当前装配体做包围盒级干涉初筛'
    };
  }
  if (/(电气校验|线号|载流量|截面|不平衡|功率统计|余量)/.test(value)) {
    return {
      tool: 'run_electrical_check',
      args: {},
      readOnly: true,
      missing: ['wires', 'loads'],
      why: '按当前电气文档做线号合规与功率统计校验'
    };
  }
  if (/(成本|报价|多少钱|费用|总价|合计)/.test(value)) {
    if (isBareReferencePriceQuery(value, category)) return null;
    return {
      tool: 'run_cost_report',
      args: {},
      readOnly: true,
      missing: [],
      why: '按当前 BOM 与内置价格簿计算硬件成本'
    };
  }
  if (/bom|物料清单|物料表/i.test(value)) {
    return {
      tool: 'get_bom',
      args: {},
      readOnly: true,
      missing: [],
      why: '读取当前装配体的简化 BOM'
    };
  }

  const query = extractQuery(value);
  const wantsList = LIST_VERBS.some((verb) => value.includes(verb));

  // 只读兜底只属于查询意图。计算/修改/生成没有命中具体工具时应明确返回 null，
  // 否则「再算一遍」「把它改一下」会被错误落到元件搜索。
  if (match.intent !== 'query') return null;

  if (category && (wantsList || !query)) {
    return {
      tool: 'list_components',
      args: { category },
      readOnly: true,
      missing: [],
      why: `按类别「${category}」列出元件库条目`
    };
  }
  if (query) {
    return {
      tool: 'search_components',
      args: { q: query, ...(category ? { category } : {}) },
      readOnly: true,
      missing: [],
      why: `在元件库中搜索「${query}」`
    };
  }
  if (category) {
    return {
      tool: 'list_components',
      args: { category },
      readOnly: true,
      missing: [],
      why: `按类别「${category}」列出元件库条目`
    };
  }
  return null;
}

/** 多步计划：按明确连接词拆句，任何一步落空都不执行，避免「做一半」。 */
export function planToolSequence(text: string): ToolPlan[] | null {
  const segments = splitInstructionSteps(text);
  if (segments.length <= 1) {
    const plan = planTool(text);
    return plan ? [plan] : null;
  }
  const plans: ToolPlan[] = [];
  for (const segment of segments) {
    const plan = planTool(segment);
    if (!plan) return null;
    plans.push(plan);
  }
  return plans;
}

/** 离线通道专用：只有只读计划才允许自动执行。 */
export function planReadOnly(text: string): ToolPlan | null {
  const plan = planTool(text);
  if (!plan) return null;
  if (!plan.readOnly || !READ_ONLY_TOOLS.has(plan.tool)) return null;
  return plan;
}

export function describePlan(plan: ToolPlan): string {
  const args = Object.keys(plan.args).length > 0 ? ` ${JSON.stringify(plan.args)}` : '';
  return `${plan.why}（${plan.tool}${args}${plan.readOnly ? '' : '，写操作'}）`;
}

export function explainIntent(match: IntentMatch): string {
  if (match.intent === 'out_of_scope') {
    return '这条指令没有匹配到可执行能力：可以问元件、BOM、成本、电气校验或干涉检查。';
  }
  return `意图：${INTENT_LABELS[match.intent]}（${match.confidence}，${match.reason}）`;
}
