// 自然语言机型需求抽取：只做规则解析，不调用模型、不读写文件。
// 输出是后续 synthMachine 的输入；无法识别的字段使用明确缺省值，并在 notes 里
// 留下「缺省」标记，便于合成器把假设写进 warnings/assumptions。

export type MachineProcess =
  | 'screw'
  | 'dispense'
  | 'assembly'
  | 'inspection'
  | 'packaging'
  | 'unknown';

export type MachineActuatorKind = 'cylinder' | 'gripper' | 'rotary';
export type MachineSensorKind = 'proximity' | 'photoelectric' | 'safety' | 'pressure';
export type MachineVoltage = '220VAC' | '380VAC' | '24VDC';

export interface MachineBrief {
  process: MachineProcess;
  stations: number;
  cyclePerMin: number | null;
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

const PROCESS_RULES: Array<{ process: Exclude<MachineProcess, 'unknown'>; pattern: RegExp }> = [
  { process: 'screw', pattern: /锁螺丝|锁付|拧螺丝|打螺丝|螺丝机|上螺丝/ },
  { process: 'dispense', pattern: /点胶|涂胶|灌胶|滴胶|胶机/ },
  { process: 'assembly', pattern: /装配|组装|压装|压合|组装线/ },
  { process: 'inspection', pattern: /检测|检查|检验|视觉|测量|AOI/i },
  { process: 'packaging', pattern: /包装|装箱|装盒|封箱|贴标|码垛/ }
];

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
  proximity: ['接近开关', '接近传感器', '接近'],
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

function detectActuators(text: string, notes: string[]): { kind: MachineActuatorKind; count: number }[] {
  const counts = new Map<MachineActuatorKind, number>();
  for (const kind of ['cylinder', 'gripper', 'rotary'] as const) {
    const aliases = ACTUATOR_ALIASES[kind];
    let count = explicitCount(text, aliases);
    if (count === 0 && aliasOccurrences(text, aliases) > 0) count = 1;
    if (count > 0) counts.set(kind, count);
  }

  const driveExplicit = explicitDriveCount(text);
  const driveMentions = aliasOccurrences(text, DRIVE_ALIASES);
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

function detectSensors(text: string): { kind: MachineSensorKind; count: number }[] {
  const counts = new Map<MachineSensorKind, number>();
  for (const kind of ['proximity', 'photoelectric', 'safety', 'pressure'] as const) {
    const aliases = SENSOR_ALIASES[kind];
    let count = explicitCount(text, aliases);
    if (count === 0 && aliasOccurrences(text, aliases) > 0) count = 1;
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

  const stationMatch = detectStations(source);
  let stations = MACHINE_DEFAULT_STATIONS;
  if (stationMatch === null) {
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

  const actuators = detectActuators(source, notes);
  const sensors = detectSensors(source);
  const brand = detectBrand(source);
  const voltage = detectVoltage(source);

  return {
    process,
    stations,
    cyclePerMin,
    actuators,
    sensors,
    brand,
    voltage,
    notes
  };
}
