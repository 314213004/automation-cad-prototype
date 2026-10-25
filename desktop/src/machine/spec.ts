// 自然语言机型需求抽取：只做规则解析，不调用模型、不读写文件。
// 输出是后续 synthMachine 的输入；无法识别的字段使用明确缺省值，并在 notes 里
// 留下「缺省」标记，便于合成器把假设写进 warnings/assumptions。

export type MachineProcess =
  | 'screw'
  | 'dispense'
  | 'assembly'
  | 'inspection'
  | 'packaging'
  /** 输送：单条皮带/链条线，节拍由线速与工件间距决定，不受工位机构限制。 */
  | 'conveyor'
  | 'unknown';

export type MachineActuatorKind = 'cylinder' | 'gripper' | 'rotary';
export type MachineSensorKind = 'proximity' | 'photoelectric' | 'safety' | 'pressure';
export type MachineVoltage = '220VAC' | '380VAC' | '24VDC';

/**
 * 布局模型：
 * - single：单工位完成全部工序。
 * - linear：工位串成直线流水线，每站一道工序，产能由最慢工序决定（line 为兼容别名）。
 * - dial：转盘分度，工位同时作业，分度期间不作业。
 * - parallel：N 个工位复制同一道工序，产能随工位数放大。
 * - cell：单元式，组内串行、组间并行。
 * - auto：未显式指定，由解析器按需求文本推断。
 */
export type MachineLayout = 'single' | 'linear' | 'dial' | 'parallel' | 'cell' | 'line' | 'auto';

/** 输送机的机械参数；没写到的字段为 null，由合成器给典型值并在 assumptions 里说明。 */
export interface ConveyorSpec {
  /** 线体总长（mm） */
  lengthMm: number | null;
  /** 皮带有效宽度（mm） */
  widthMm: number | null;
  /** 线速度（m/s） */
  speedMps: number | null;
  /** 单件重量（kg） */
  loadKg: number | null;
}

/** 工程师明确输入的整机占地边界；仅用于与实际几何包络比较，不缩放实体。 */
export interface MachineFootprintRequirement {
  lengthMm: number;
  widthMm: number;
}

export interface MachineBrief {
  process: MachineProcess;
  stations: number;
  cyclePerMin: number | null;
  layout: MachineLayout;
  conveyor?: ConveyorSpec;
  /** 可选占地限制；未填写时沿用形态的推荐尺寸。 */
  footprint?: MachineFootprintRequirement | null;
  /** 需求中显式列出的工序名，按出现顺序去重。 */
  processes?: string[];
  actuators: { kind: MachineActuatorKind; count: number }[];
  sensors: { kind: MachineSensorKind; count: number }[];
  brand: string | null;
  voltage: MachineVoltage | null;
  notes: string[];
}

export const MACHINE_STATIONS_MIN = 1;
export const MACHINE_STATIONS_MAX = 12;
export const MACHINE_DEFAULT_STATIONS = 2;
export const MACHINE_DEFAULT_CYCLE_PER_MIN = 10;

export const DEFAULT_NOTE_STATIONS = `缺省：未识别工位数，按 ${MACHINE_DEFAULT_STATIONS} 工位合成`;
export const DEFAULT_NOTE_CYCLE = `缺省：未识别节拍，按 ${MACHINE_DEFAULT_CYCLE_PER_MIN} 件/分钟估算`;
export const DEFAULT_NOTE_PROCESS = '缺省：未识别工艺，按通用工艺方案合成';
export const DEFAULT_NOTE_LAYOUT = '缺省：未识别布局，按同工序并行估算；可显式指定 layout（single/linear/dial/parallel/cell）';

const PROCESS_RULES: Array<{ process: Exclude<MachineProcess, 'unknown'>; pattern: RegExp }> = [
  { process: 'screw', pattern: /锁螺丝|锁付|拧螺丝|打螺丝|螺丝机|上螺丝/ },
  { process: 'dispense', pattern: /点胶|涂胶|灌胶|滴胶|胶机/ },
  { process: 'assembly', pattern: /装配|组装|压装|压合|组装线/ },
  { process: 'inspection', pattern: /检测|检查|检验|视觉|测量|AOI/i },
  { process: 'packaging', pattern: /包装|装箱|装盒|封箱|贴标|码垛/ },
  // 输送放最后：只有没提到其他工艺时才判为输送线，避免「装配线配输送」被抢走工艺类型。
  { process: 'conveyor', pattern: /输送机|输送线|皮带线|传送带|皮带输送|链条输送|流水线输送|输送段/ }
];

/**
 * 工序名与主工艺（process）分开：主工艺只保留五类可合成模板，
 * 上料/下料/搬运等工序用于判断是否为流水线分工序布局。
 */
const PROCESS_NAME_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: '上料', pattern: /上料|进料|供料/ },
  { name: '锁螺丝', pattern: /锁螺丝|锁付|拧螺丝|打螺丝|上螺丝/ },
  { name: '点胶', pattern: /点胶|涂胶|灌胶|滴胶/ },
  { name: '装配', pattern: /装配|组装|压装|压合/ },
  { name: '检测', pattern: /检测|检查|检验|视觉|测量|AOI/i },
  { name: '包装', pattern: /包装|装箱|装盒|封箱|贴标|码垛/ },
  { name: '下料', pattern: /下料|卸料|出料/ },
  { name: '搬运', pattern: /搬运|移载|转运/ }
];

const LINE_KEYWORD = /流水线|线体|产线|生产线|装配线|包装线|检测线|自动线|输送线|长线/;
const DIAL_KEYWORD = /转盘|分度盘|分度转盘|回转台|圆盘|转台式|分度式/;
const CELL_KEYWORD = /单元式|单元线|独立单元|cell/i;
const PARALLEL_KEYWORD = /并行|复制式|多工位并行/;

/** 传感器/上下料描述里的「检测」不是独立工序，推断布局前先屏蔽。 */
function maskNonProcessPhrases(text: string): string {
  return text
    .replace(/到位检测|位置检测|有无检测|检测开关|检测传感器|传感器检测/g, ' ')
    .replace(/自动上下料|上下料/g, ' ');
}

function detectProcessNames(text: string): string[] {
  const masked = maskNonProcessPhrases(text);
  const found: Array<{ name: string; index: number }> = [];
  for (const rule of PROCESS_NAME_RULES) {
    const match = rule.pattern.exec(masked);
    if (match?.index !== undefined) found.push({ name: rule.name, index: match.index });
  }
  return found
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.name)
    .filter((name, index, names) => names.indexOf(name) === index);
}

/**
 * 布局推断规则（可测）：
 * - 出现流水线/线体/产线等词，或两个及以上不同工序 → line；
 * - 已知单一工艺 → parallel（同工序并行是更常见的复制式布局）；
 * - 无法判断且工位数 > 1 → parallel，并在 notes 里提示可显式指定 layout。
 */
function detectLayout(text: string, process: MachineProcess, processNames: string[]): {
  layout: Exclude<MachineLayout, 'auto'>;
  inferred: string;
} {
  if (CELL_KEYWORD.test(text)) {
    return { layout: 'cell', inferred: '需求含单元式布局线索' };
  }
  if (DIAL_KEYWORD.test(text)) {
    return { layout: 'dial', inferred: '需求含转盘/分度布局线索' };
  }
  if (LINE_KEYWORD.test(text)) {
    return { layout: 'linear', inferred: '需求含流水线/线体/产线线索' };
  }
  if (PARALLEL_KEYWORD.test(text)) {
    return { layout: 'parallel', inferred: '需求含并行/复制式布局线索' };
  }
  if (processNames.length >= 2) {
    return { layout: 'linear', inferred: `识别到多个不同工序（${processNames.join('、')}）` };
  }
  if (process !== 'unknown') {
    return { layout: 'parallel', inferred: `单一工艺「${processNames[0] ?? process}」按同工序并行` };
  }
  return { layout: 'parallel', inferred: '无法判断布局，按同工序并行估算' };
}

const BRANDS = [
  '罗克韦尔',
  '施耐德',
  '欧姆龙',
  '西门子',
  '基恩士',
  '汇川',
  '台达',
  '正泰',
  '三菱',
  '松下',
  '倍福',
  '安川',
  'ABB'
];

const ACTUATOR_ALIASES: Record<MachineActuatorKind, string[]> = {
  cylinder: ['气缸', '气动缸', '气动执行器'],
  gripper: ['夹爪', '气爪', '抓手', '夹取机构'],
  rotary: ['旋转轴', '旋转台', '转台', '分度盘']
};

const DRIVE_ALIASES = ['伺服', '步进'];

const SENSOR_ALIASES: Record<MachineSensorKind, string[]> = {
  proximity: ['接近开关', '接近传感器', '到位检测', '到位开关', '到位传感器', '磁性开关', '接近'],
  photoelectric: ['光电开关', '光电传感器', '光电'],
  safety: ['安全光栅', '安全门', '光栅'],
  pressure: ['压力传感器', '压力开关', '压力']
};

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 解析 0–99 的中文数字（含「两」「十二」「二十」）。非数字返回 null。 */
export function parseChineseNumber(value: string): number | null {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const char of text) {
    if (char === '十') {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
      seen = true;
      continue;
    }
    const digit = CN_DIGITS[char];
    if (digit === undefined) return null;
    current = current * 10 + digit;
    seen = true;
  }
  return seen ? total + current : null;
}

function countToken(value: string | undefined): number | null {
  if (!value) return null;
  const number = parseChineseNumber(value);
  return number !== null && Number.isFinite(number) && number > 0 ? number : null;
}

function normalized(text: string): string {
  return (text ?? '').normalize('NFKC');
}

/**
 * 输送机机械参数：总长 / 带宽 / 线速 / 单件重量。
 * 只认显式写出的数字，缺的留 null（由合成器给典型值并写进 assumptions），不猜。
 */
export function detectConveyorSpec(text: string): ConveyorSpec | null {
  const length = /(?:总长|线体长|长度|长)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(mm|毫米|米|m)/i.exec(text);
  const width = /(?:带宽|皮带宽|有效宽|宽度|宽)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(mm|毫米)/i.exec(text);
  const speed = /(?:线速|速度|线速度)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(m\/s|米\/秒|mm\/s)/i.exec(text);
  const load = /(?:工件|负载|载重|单件)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(kg|公斤|千克)/i.exec(text);
  if (!length && !width && !speed && !load) return null;
  const toMm = (value: string, unit: string): number => {
    const number = Number(value);
    return /^(米|m)$/i.test(unit) ? number * 1000 : number;
  };
  const toMps = (value: string, unit: string): number => {
    const number = Number(value);
    return /mm/i.test(unit) ? number / 1000 : number;
  };
  return {
    lengthMm: length ? toMm(length[1] ?? '0', length[2] ?? 'mm') : null,
    widthMm: width ? Number(width[1]) : null,
    speedMps: speed ? toMps(speed[1] ?? '0', speed[2] ?? 'm/s') : null,
    loadKg: load ? Number(load[1]) : null
  };
}

function detectProcess(text: string): MachineProcess {
  for (const rule of PROCESS_RULES) {
    if (rule.pattern.test(text)) return rule.process;
  }
  return 'unknown';
}

function detectStations(text: string): number | null {
  const patterns = [
    /([一二两三四五六七八九十\d]+)\s*(?:个)?\s*(?:工位|工作站|站)/,
    /(?:工位(?:数量|数)?|stations?)\s*[:：=]?\s*([一二两三四五六七八九十\d]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = parseChineseNumber(match[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectCyclePerMin(text: string): number | null {
  const decimal = '(\\d+(?:\\.\\d+)?)';
  const piecesPerMinute = [
    new RegExp(`${decimal}\\s*(?:件|个|pcs)\\s*(?:\\/|每)\\s*(?:分钟|分|min(?:ute)?s?)`, 'i'),
    new RegExp(`(?:每分钟|分钟|每分|per\\s*min(?:ute)?)\\s*(?:[:：=]|为|是)?\\s*${decimal}\\s*(?:件|个|pcs)?`, 'i')
  ];
  for (const pattern of piecesPerMinute) {
    const match = text.match(pattern);
    const value = match?.[1] ? Number(match[1]) : NaN;
    const valid = positive(value);
    if (valid !== null) return Math.round(valid * 1000) / 1000;
  }

  const piecesPerSecond = [
    new RegExp(`${decimal}\\s*(?:件|个|pcs)\\s*(?:\\/|每)\\s*(?:秒|s|sec(?:ond)?s?)`, 'i')
  ];
  for (const pattern of piecesPerSecond) {
    const match = text.match(pattern);
    const value = match?.[1] ? Number(match[1]) : NaN;
    const valid = positive(value);
    if (valid !== null) return Math.round(valid * 60 * 1000) / 1000;
  }

  const secondsPerPiece = [
    new RegExp(`${decimal}\\s*(?:秒|s|sec(?:ond)?s?)\\s*(?:\\/|每)\\s*(?:件|个|pcs)`, 'i'),
    new RegExp(`(?:每|一)\\s*${decimal}\\s*(?:秒|s|sec(?:ond)?s?)\\s*(?:一件|每件|一个)?`, 'i'),
    new RegExp(`${decimal}\\s*(?:秒|s|sec(?:ond)?s?)\\s*(?:一件|每件|一个)`, 'i'),
    new RegExp(`(?:每件|一件)\\s*${decimal}\\s*(?:秒|s|sec(?:ond)?s?)`, 'i')
  ];
  for (const pattern of secondsPerPiece) {
    const match = text.match(pattern);
    const value = match?.[1] ? Number(match[1]) : NaN;
    const valid = positive(value);
    if (valid !== null) return Math.round((60 / valid) * 1000) / 1000;
  }

  const ct = text.match(/(?:CT|节拍|cycle\s*time)\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s|sec(?:ond)?s?)?/i);
  const ctValue = ct?.[1] ? Number(ct[1]) : NaN;
  const validCt = positive(ctValue);
  if (validCt !== null) return Math.round((60 / validCt) * 1000) / 1000;
  return null;
}

function detectBrand(text: string): string | null {
  let best: { brand: string; index: number } | null = null;
  for (const brand of BRANDS) {
    const index = text.indexOf(brand);
    if (index < 0) continue;
    if (!best || index < best.index) best = { brand, index };
  }
  return best?.brand ?? null;
}

function detectVoltage(text: string): MachineVoltage | null {
  if (/24\s*V\s*(?:DC|直流)|DC\s*24|24V\s*直流|直流\s*24V|\b24V\b/i.test(text)) return '24VDC';
  if (/380\s*V|AC\s*380|三相\s*380|380VAC/i.test(text)) return '380VAC';
  if (/220\s*V|AC\s*220|单相\s*220|220VAC/i.test(text)) return '220VAC';
  return null;
}

function aliasOccurrences(text: string, aliases: string[]): number {
  // 长词优先，避免「安全光栅」同时命中「光栅」、「接近开关」同时命中「接近」。
  const term = [...aliases]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  return text.match(new RegExp(term, 'g'))?.length ?? 0;
}

/**
 * 按常见分隔符切段。数量只在同一段内生效，避免把「六工位」的 6
 * 误算到后面的「1 个气爪」上。
 */
function splitClauses(text: string): string[] {
  return text
    .split(/[+＋、,，;；。\n\r]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/** 屏蔽功率、电压、尺寸等规格数字，避免把 750W / 24V 当成数量。 */
function maskSpecNumbers(text: string): string {
  return text.replace(
    /\d+(?:\.\d+)?\s*(?:kW|千瓦|W|瓦|V|A|mA|mm|cm|m|r\/min|rpm|N·m)/gi,
    ' '
  );
}

interface NumberToken {
  value: number;
  start: number;
  end: number;
}

function numberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(/(\d+|[一二两三四五六七八九十]+)/g)) {
    const value = parseChineseNumber(match[1] ?? '');
    if (value === null || value <= 0) continue;
    const start = match.index ?? 0;
    tokens.push({ value, start, end: start + (match[1]?.length ?? 0) });
  }
  return tokens;
}

/**
 * 取与别名最近的数字。相比「取段内第一个数字」，这能正确处理
 * 「六工位锁螺丝机每工位 1 套伺服」这种没有逗号的写法。
 */
function nearestAliasCount(clause: string, aliases: string[]): { count: number; explicit: boolean } {
  const masked = maskSpecNumbers(clause);
  const term = [...aliases]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const aliasMatch = new RegExp(term).exec(masked);
  if (!aliasMatch || aliasMatch.index === undefined) return { count: 0, explicit: false };
  const aliasStart = aliasMatch.index;
  const aliasEnd = aliasStart + aliasMatch[0].length;
  let best: { count: number; distance: number } | null = null;
  for (const token of numberTokens(masked)) {
    const distance = token.end <= aliasStart
      ? aliasStart - token.end
      : token.start >= aliasEnd
        ? token.start - aliasEnd
        : 0;
    if (!best || distance < best.distance) best = { count: token.value, distance };
  }
  return best ? { count: best.count, explicit: true } : { count: 1, explicit: false };
}

function aggregateAliasCount(
  text: string,
  aliases: string[],
  perStation: boolean,
  stations: number
): { count: number; explicit: boolean } {
  let count = 0;
  let explicit = false;
  for (const clause of splitClauses(text)) {
    const found = nearestAliasCount(clause, aliases);
    if (found.count <= 0) continue;
    count += perStation && found.explicit ? found.count * stations : found.count;
    explicit = explicit || found.explicit;
  }
  return { count, explicit };
}

function explicitCount(text: string, aliases: string[]): number {
  const term = aliases.map(escapeRegExp).join('|');
  let total = 0;
  const before = new RegExp(`(\\d+|[一二两三四五六七八九十]+)\\s*(?:个|台|套|组|只|轴)?\\s*(?:${term})`, 'g');
  const after = new RegExp(`(?:${term})\\s*(?:数量|共)?\\s*[:：=]?\\s*(\\d+|[一二两三四五六七八九十]+)\\s*(?:个|台|套|组|只|轴)?`, 'g');
  for (const match of text.matchAll(before)) {
    total += countToken(match[1]) ?? 0;
  }
  for (const match of text.matchAll(after)) {
    total += countToken(match[1]) ?? 0;
  }
  return total;
}

function explicitDriveCount(text: string): number {
  // 先屏蔽功率数值，避免把「伺服 750W」中的 750 当成轴数；同时保留
  // 「两台 750W 伺服」里的 2 台，允许数量与执行机构之间隔着功率规格。
  const wattToken = '__MACHINE_WATT__';
  const masked = text.replace(/(\d+(?:\.\d+)?)\s*(?:kW|千瓦|W|瓦)/gi, wattToken);
  const term = DRIVE_ALIASES.map(escapeRegExp).join('|');
  const token = escapeRegExp(wattToken);
  let total = 0;
  const before = new RegExp(
    `(\\d+|[一二两三四五六七八九十]+)\\s*(?:个|台|套|组|只|轴)?\\s*(?:${token}\\s*)?(?:${term})`,
    'g'
  );
  const after = new RegExp(
    `(?:${term})\\s*(?:数量|共)?\\s*[:：=]?\\s*(\\d+|[一二两三四五六七八九十]+)\\s*(?:个|台|套|组|只|轴)?`,
    'g'
  );
  for (const match of masked.matchAll(before)) total += countToken(match[1]) ?? 0;
  for (const match of masked.matchAll(after)) total += countToken(match[1]) ?? 0;
  return total;
}

function detectActuators(
  text: string,
  notes: string[],
  stations: number
): { kind: MachineActuatorKind; count: number }[] {
  const counts = new Map<MachineActuatorKind, number>();
  const perStation = /每\s*(?:个)?\s*(?:工位|工作站|站)/.test(text);
  for (const kind of ['cylinder', 'gripper', 'rotary'] as const) {
    const aliases = ACTUATOR_ALIASES[kind];
    let count = 0;
    for (const clause of splitClauses(text)) {
      if (kind === 'rotary' && aliasOccurrences(clause, DRIVE_ALIASES) > 0) continue;
      const found = nearestAliasCount(clause, aliases);
      if (found.count <= 0) continue;
      count += perStation && found.explicit ? found.count * stations : found.count;
    }
    if (count > 0) counts.set(kind, count);
  }

  let driveExplicit = 0;
  let driveMentions = 0;
  for (const clause of splitClauses(text)) {
    const mentions = aliasOccurrences(clause, DRIVE_ALIASES);
    if (mentions === 0) continue;
    driveMentions += mentions;
    const found = nearestAliasCount(clause, DRIVE_ALIASES);
    if (found.explicit) {
      driveExplicit += perStation ? found.count * stations : found.count;
    }
  }
  if (driveExplicit > 0) {
    counts.set('rotary', (counts.get('rotary') ?? 0) + driveExplicit);
    const watt = text.match(/(\d+(?:\.\d+)?)\s*(?:kW|千瓦|W|瓦)/i)?.[0];
    notes.push(`伺服/步进执行机构 ${driveExplicit} 台${watt ? `（${watt}）` : ''}：按旋转轴建模`);
  } else if (driveMentions > 0) {
    // 「用 750W 伺服」是在描述驱动规格，不是在数执行机构，不能把 750 当数量。
    const watt = text.match(/(\d+(?:\.\d+)?)\s*(?:W|瓦)/i)?.[1];
    notes.push(watt ? `伺服驱动 ${watt}W：按旋转轴建模` : '检测到伺服/步进驱动：按旋转轴建模');
  }

  return (['cylinder', 'gripper', 'rotary'] as const)
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

function detectSensors(text: string, stations: number): { kind: MachineSensorKind; count: number }[] {
  const counts = new Map<MachineSensorKind, number>();
  const perStation = /每\s*(?:个)?\s*(?:工位|工作站|站)/.test(text);
  for (const kind of ['proximity', 'photoelectric', 'safety', 'pressure'] as const) {
    const aliases = SENSOR_ALIASES[kind];
    let count = 0;
    for (const clause of splitClauses(text)) {
      const found = nearestAliasCount(clause, aliases);
      if (found.count <= 0) continue;
      // 安全光栅通常整机 1 套；只有同段明确写「每工位」时才按工位展开，
      // 避免把「每工位 ... + 安全光栅」误扩成 6 套。
      const multiply = perStation && found.explicit && kind !== 'safety';
      count += multiply ? found.count * stations : found.count;
    }
    if (count > 0) counts.set(kind, count);
  }
  return (['proximity', 'photoelectric', 'safety', 'pressure'] as const)
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

export function parseMachineBrief(text: string): MachineBrief {
  const source = normalized(text);
  const notes: string[] = [];

  const process = detectProcess(source);
  if (process === 'unknown') notes.push(DEFAULT_NOTE_PROCESS);

  const processNames = detectProcessNames(source);

  const stationMatch = detectStations(source);
  let stations = MACHINE_DEFAULT_STATIONS;
  if (process === 'conveyor' && stationMatch === null) {
    // 输送线只有一条线体，不存在「工位」概念；不要套用默认 3 工位
    stations = 1;
  } else if (stationMatch === null) {
    notes.push(DEFAULT_NOTE_STATIONS);
  } else if (stationMatch < MACHINE_STATIONS_MIN) {
    notes.push(`工位数 ${stationMatch} 无效：按 ${MACHINE_STATIONS_MIN} 工位合成`);
  } else if (stationMatch > MACHINE_STATIONS_MAX) {
    stations = MACHINE_STATIONS_MAX;
    notes.push(`工位数 ${stationMatch} 超出 ${MACHINE_STATIONS_MIN}–${MACHINE_STATIONS_MAX}：按 ${MACHINE_STATIONS_MAX} 工位合成`);
  } else {
    stations = stationMatch;
  }

  const cyclePerMin = detectCyclePerMin(source);
  if (cyclePerMin === null) notes.push(DEFAULT_NOTE_CYCLE);

  const actuators = detectActuators(source, notes, stations);
  const sensors = detectSensors(source, stations);
  const brand = detectBrand(source);
  const voltage = detectVoltage(source);
  const inferred = detectLayout(source, process, processNames);
  if (process === 'unknown' && stations > 1) notes.push(DEFAULT_NOTE_LAYOUT);
  if (inferred.layout === 'parallel' && process !== 'unknown') {
    notes.push(`布局推断：${inferred.inferred}，按同工序并行估算`);
  } else if (inferred.layout === 'linear') {
    notes.push(`布局推断：${inferred.inferred}，按流水线分工序估算`);
  } else if (inferred.layout === 'dial') {
    notes.push(`布局推断：${inferred.inferred}，按转盘分度估算`);
  } else if (inferred.layout === 'cell') {
    notes.push(`布局推断：${inferred.inferred}，按单元式估算`);
  } else {
    notes.push(`布局推断：${inferred.inferred}`);
  }

  const conveyor = process === 'conveyor' ? detectConveyorSpec(source) : null;

  return {
    process,
    stations,
    cyclePerMin,
    layout: inferred.layout,
    ...(conveyor ? { conveyor } : {}),
    ...(processNames.length > 0 ? { processes: processNames } : {}),
    actuators,
    sensors,
    brand,
    voltage,
    notes
  };
}
