/**
 * 线号方案（可配置的线号规则）。
 *
 * 一份方案 = 每个“网络类别”一条模板 + {num} 起始号 + 重号区分后缀。出图（drawing.ts）按方案生成线号，
 * 电气校验（check.ts）按同一方案判断格式——方案即规则，两边永远同口径。
 *
 * 本模块是纯函数，不碰 DOM；类别识别只依赖 build.ts 产出的电路/版面计划（网络 id 命名见 classifyNets）。
 */

import type { Circuit, CircuitDevice } from './circuit.ts';
import type { ElecPlan } from './build.ts';

/** 安全母线网络 id（= build.ts 的 SAFE_NET；这里不做值导入，免得 check.ts 经本模块把出图引擎拖进主进程） */
export const SAFE_NET_ID = 'S24';

/* ------------------------------------------------------------------ 类别 */

export type WireNoCategory =
  | 'mainIn'        // 三相电源：总进线前 L1/L2/L3
  | 'mainBus'       // 三相电源：总进线断路器后（母线）
  | 'branch'        // 三相电源：各支路断路器后（含单相支路相线）
  | 'branchK'       // 三相电源：支路接触器后、热继前（接触器出线端 2/T1 4/T2 6/T3）
  | 'neutralMain'   // N：总进线 N
  | 'neutralBranch' // N：支路断路器（1P+N）后的 N
  | 'pe'            // PE
  | 'dc24'          // DC +24V
  | 'dc0'           // 0V
  | 'motor'         // 电机出线 U/V/W
  | 'control'       // 控制回路中间网络（起保停、线圈回路等）
  | 'plcIn'         // PLC 数字输入（每点一个网络）
  | 'plcOut'        // PLC 数字输出（每点一个网络）
  | 'plcCommon'     // PLC 公共端（COM/M/L+ 单独成网时）
  | 'analog'        // 模拟量
  | 'safety'        // 安全回路（急停/光栅/安全继电器/安全母线）
  | 'other';        // 其他

export const WIRE_NO_CATEGORIES: ReadonlyArray<{ id: WireNoCategory; label: string; bus: boolean }> = [
  { id: 'mainIn', label: '三相电源·总进线前', bus: true },
  { id: 'mainBus', label: '三相电源·总进线后', bus: false },
  { id: 'branch', label: '三相电源·各支路断路器后', bus: false },
  { id: 'branchK', label: '三相电源·支路接触器后', bus: false },
  { id: 'neutralMain', label: 'N·总进线', bus: true },
  { id: 'neutralBranch', label: 'N·支路后', bus: false },
  { id: 'pe', label: 'PE', bus: true },
  { id: 'dc24', label: 'DC +24V', bus: true },
  { id: 'dc0', label: '0V', bus: true },
  { id: 'motor', label: '电机出线 U/V/W', bus: false },
  { id: 'control', label: '控制回路中间网络', bus: false },
  { id: 'plcIn', label: 'PLC 数字输入（每点）', bus: false },
  { id: 'plcOut', label: 'PLC 数字输出（每点）', bus: false },
  { id: 'plcCommon', label: 'PLC 公共端 COM/M/L+', bus: false },
  { id: 'analog', label: '模拟量', bus: false },
  { id: 'safety', label: '安全回路', bus: false },
  { id: 'other', label: '其他', bus: false }
];

const CATEGORY_IDS = new Set<string>(WIRE_NO_CATEGORIES.map((item) => item.id));
/** 电位母线类别：整张图一个线号，图上用母线标签表示，不逐根导线标线号 */
export const BUS_CATEGORIES: ReadonlySet<WireNoCategory> = new Set(WIRE_NO_CATEGORIES.filter((item) => item.bus).map((item) => item.id));

export function isWireNoCategory(value: unknown): value is WireNoCategory {
  return typeof value === 'string' && CATEGORY_IDS.has(value);
}

/* ------------------------------------------------------------------ 方案 */

export type WireNoPresetId = 'digital' | 'potential' | 'pagecol' | 'custom';

export interface WireNoScheme {
  version: 1;
  preset: WireNoPresetId;
  /** 每个类别一条模板 */
  templates: Record<WireNoCategory, string>;
  /** {num} 全局流水号起始值 */
  numStart: number;
  /** 不同网络产生同一线号时追加的区分后缀模板，含且只含一个 {k}（1,2,3…）或 {a}（a,b,c…） */
  dedupe: string;
}

/** 占位符说明（UI 与文档共用） */
export const WIRE_NO_PLACEHOLDERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'seq', label: '类别内序号（按页→列→行阅读顺序，1 起；PLC 输入/输出/模拟量按地址顺序，同 {pt}）' },
  { key: 'num', label: '全局流水号（所有用 {num} 的网络共用，从起始号连续）' },
  { key: 'page', label: '首次出现的页码' },
  { key: 'col', label: '首次出现的列号 1–8' },
  { key: 'row', label: '首次出现的行号 A–F' },
  { key: 'cseq', label: '同页同列内序号（1 起）' },
  { key: 'cdot', label: '同页同列有多个网络时为 .序号，只有一个时为空' },
  { key: 'phase', label: '相序 1/2/3（三相电源、电机出线）' },
  { key: 'grp', label: '所属支路/电机编号（位号里的数字，如 -QF2→2、-M1→1）' },
  { key: 'addr', label: 'PLC 地址，如 I0.3 / Q1.2' },
  { key: 'pt', label: 'PLC 点号（本 PLC 输入或输出的第几点，1 起）' },
  { key: 'tag', label: '元件位号（去掉前导 -，如 KM1）' },
  { key: 'pin', label: '元件引脚（电机 U/V/W、PLC 端子、断路器出线端…）' }
];
const PLACEHOLDER_KEYS = new Set(WIRE_NO_PLACEHOLDERS.map((item) => item.key));

/** 位置/序号类占位符：母线类别不能用（母线跨页，一个电位只有一个线号） */
const POSITIONAL = new Set(['seq', 'num', 'page', 'col', 'row', 'cseq', 'cdot']);
const PHASE_CATEGORIES = new Set<WireNoCategory>(['mainIn', 'mainBus', 'branch', 'branchK', 'motor']);
const PLC_CATEGORIES = new Set<WireNoCategory>(['plcIn', 'plcOut', 'analog']);

export const WIRE_NO_TEMPLATE_MAX = 24;
export const WIRE_NO_DEDUPE_MAX = 6;
const LITERAL_RE = /^[A-Za-z0-9.+\-_/:]*$/;

const BUS_FIXED: Pick<Record<WireNoCategory, string>, 'mainIn' | 'neutralMain' | 'pe' | 'dc24' | 'dc0'> = {
  mainIn: 'L{phase}',
  neutralMain: 'N',
  pe: 'PE',
  dc24: '24V',
  dc0: '0V'
};

function fill(base: Partial<Record<WireNoCategory, string>>, rest: string): Record<WireNoCategory, string> {
  const out = {} as Record<WireNoCategory, string>;
  for (const { id } of WIRE_NO_CATEGORIES) out[id] = base[id] ?? rest;
  return out;
}

export const WIRE_NO_PRESETS: Readonly<Record<Exclude<WireNoPresetId, 'custom'>, { label: string; description: string; scheme: WireNoScheme }>> = {
  digital: {
    label: '数字连续',
    description: 'L1/L2/L3/N/PE、24V/0V 固定电位，其余网络 101 起按页→列连续编号（现行规则）',
    scheme: { version: 1, preset: 'digital', templates: fill(BUS_FIXED, '{num}'), numStart: 101, dedupe: '.{k}' }
  },
  potential: {
    label: '电位-类别',
    description: '进线 L1/L2/L3，总开关后 L11/L21/L31，支路断路器后 2L1…、接触器后 2T1…，N/N1，+24V/0V，电机 1U/1V/1W，PLC DI1…/DO1…/COM，安全 S1…，其余 101 起',
    scheme: {
      version: 1,
      preset: 'potential',
      templates: fill(
        {
          ...BUS_FIXED,
          dc24: '+24V',
          mainBus: 'L{phase}1',
          branch: '{grp}L{phase}',
          branchK: '{grp}T{phase}',
          neutralBranch: 'N{grp}',
          motor: '{grp}{pin}',
          plcIn: 'DI{seq}',
          plcOut: 'DO{seq}',
          plcCommon: 'COM',
          analog: 'AI{seq}',
          safety: 'S{seq}'
        },
        '{num}'
      ),
      numStart: 101,
      dedupe: '.{k}'
    }
  },
  pagecol: {
    label: '页.列',
    description: 'IEC 常见：固定电位不变，其余网络按首次出现的“页.列”编号，同页同列多个网络自动加 .序号',
    scheme: { version: 1, preset: 'pagecol', templates: fill(BUS_FIXED, '{page}.{col}{cdot}'), numStart: 101, dedupe: '.{k}' }
  }
};

export const DEFAULT_WIRE_NO_SCHEME: WireNoScheme = WIRE_NO_PRESETS.digital.scheme;

export function presetScheme(id: Exclude<WireNoPresetId, 'custom'>): WireNoScheme {
  const scheme = WIRE_NO_PRESETS[id].scheme;
  return { ...scheme, templates: { ...scheme.templates } };
}

export function schemeLabel(scheme: WireNoScheme): string {
  return scheme.preset === 'custom' ? '自定义' : WIRE_NO_PRESETS[scheme.preset].label;
}

/* ------------------------------------------------------------------ 模板解析与校验 */

type Token = { lit: string } | { ph: string };

/** 模板 → 字面量/占位符序列；花括号不配对或空占位符返回 null */
export function parseTemplate(template: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let lit = '';
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch === '{') {
      const end = template.indexOf('}', i + 1);
      if (end < 0) return null;
      const key = template.slice(i + 1, end);
      if (!key || key.includes('{')) return null;
      if (lit) tokens.push({ lit });
      lit = '';
      tokens.push({ ph: key });
      i = end + 1;
      continue;
    }
    if (ch === '}') return null;
    lit += ch;
    i += 1;
  }
  if (lit) tokens.push({ lit });
  return tokens;
}

/** 校验一个类别模板；合法返回 null，否则返回中文原因 */
export function validateTemplate(category: WireNoCategory, template: unknown): string | null {
  const label = WIRE_NO_CATEGORIES.find((item) => item.id === category)?.label ?? category;
  if (typeof template !== 'string' || template.trim() === '') return `「${label}」模板为空`;
  if (template !== template.trim()) return `「${label}」模板首尾不能有空格`;
  if (template.length > WIRE_NO_TEMPLATE_MAX) return `「${label}」模板过长（${template.length} 字符，最多 ${WIRE_NO_TEMPLATE_MAX}）`;
  const tokens = parseTemplate(template);
  if (!tokens) return `「${label}」模板花括号不配对：${template}`;
  for (const token of tokens) {
    if ('lit' in token) {
      if (!LITERAL_RE.test(token.lit)) {
        const bad = [...token.lit].find((ch) => !LITERAL_RE.test(ch)) ?? '';
        return `「${label}」模板含非法字符「${bad}」（只允许字母、数字和 . + - _ / :）`;
      }
      continue;
    }
    const key = token.ph;
    if (!PLACEHOLDER_KEYS.has(key)) return `「${label}」模板有未知占位符 {${key}}`;
    if (BUS_CATEGORIES.has(category) && POSITIONAL.has(key)) return `「${label}」是整图一个电位的母线，不能用位置/序号占位符 {${key}}`;
    if (key === 'phase' && !PHASE_CATEGORIES.has(category)) return `「${label}」没有相序，不能用 {phase}`;
    if ((key === 'addr' || key === 'pt') && !PLC_CATEGORIES.has(category)) return `「${label}」不是 PLC 点，不能用 {${key}}`;
  }
  const meaningful = tokens.some((token) => ('lit' in token ? token.lit.length > 0 : token.ph !== 'cdot'));
  if (!meaningful) return `「${label}」模板只有 {cdot}，可能生成空线号`;
  return null;
}

export function validateDedupe(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return '重号区分后缀为空';
  if (value.length > WIRE_NO_DEDUPE_MAX) return `重号区分后缀过长（最多 ${WIRE_NO_DEDUPE_MAX} 字符）`;
  const tokens = parseTemplate(value);
  if (!tokens) return `重号区分后缀花括号不配对：${value}`;
  const phs = tokens.filter((token): token is { ph: string } => 'ph' in token);
  if (phs.length !== 1 || (phs[0]?.ph !== 'k' && phs[0]?.ph !== 'a')) return '重号区分后缀须且只能含一个 {k}（数字）或 {a}（字母），如 .{k} 或 -{a}';
  for (const token of tokens) {
    if ('lit' in token && !LITERAL_RE.test(token.lit)) return `重号区分后缀含非法字符（只允许字母、数字和 . + - _ / :）`;
  }
  return null;
}

export type SchemeValidation = { ok: true; scheme: WireNoScheme } | { ok: false; errors: string[] };

/**
 * 校验并规整一份方案（来自 UI、localStorage 或工程文件）。
 * 缺的类别按所选预设（自定义按“数字连续”）补齐；任何一条不合法都整体拒绝并列出原因。
 */
export function validateWireNoScheme(input: unknown): SchemeValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['线号方案必须是对象'] };
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];
  const preset = raw.preset;
  if (preset !== 'digital' && preset !== 'potential' && preset !== 'pagecol' && preset !== 'custom') {
    errors.push(`未知预设：${String(preset)}`);
  }
  const base = preset === 'potential' || preset === 'pagecol' ? WIRE_NO_PRESETS[preset].scheme : DEFAULT_WIRE_NO_SCHEME;
  const rawTemplates = raw.templates;
  if (rawTemplates !== undefined && (typeof rawTemplates !== 'object' || rawTemplates === null || Array.isArray(rawTemplates))) {
    errors.push('templates 必须是对象');
  }
  const given = (typeof rawTemplates === 'object' && rawTemplates !== null ? rawTemplates : {}) as Record<string, unknown>;
  for (const key of Object.keys(given)) if (!CATEGORY_IDS.has(key)) errors.push(`未知线号类别：${key}`);
  const templates = {} as Record<WireNoCategory, string>;
  for (const { id } of WIRE_NO_CATEGORIES) {
    const value = given[id] === undefined ? base.templates[id] : given[id];
    const why = validateTemplate(id, value);
    if (why) errors.push(why);
    else templates[id] = value as string;
  }
  const numStart = raw.numStart === undefined ? base.numStart : raw.numStart;
  if (typeof numStart !== 'number' || !Number.isInteger(numStart) || numStart < 0 || numStart > 99999) {
    errors.push('{num} 起始号须是 0–99999 的整数');
  }
  const dedupe = raw.dedupe === undefined ? base.dedupe : raw.dedupe;
  const dedupeWhy = validateDedupe(dedupe);
  if (dedupeWhy) errors.push(dedupeWhy);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scheme: { version: 1, preset: preset as WireNoPresetId, templates, numStart: numStart as number, dedupe: dedupe as string } };
}

/* ------------------------------------------------------------------ 渲染 */

export interface WireNoContext {
  seq?: number;
  num?: number;
  page?: number;
  col?: number;
  row?: string;
  cseq?: number;
  /** 同页同列（用 cseq/cdot 的）网络个数 */
  ccount?: number;
  phase?: string;
  grp?: string;
  addr?: string;
  pt?: number;
  tag?: string;
  pin?: string;
}

/** 按上下文把模板展开成线号（模板须已校验；缺值的占位符展开为空） */
export function renderTemplate(template: string, ctx: WireNoContext): string {
  const tokens = parseTemplate(template) ?? [{ lit: template }];
  return tokens
    .map((token) => {
      if ('lit' in token) return token.lit;
      switch (token.ph) {
        case 'cdot':
          return (ctx.ccount ?? 1) > 1 && ctx.cseq !== undefined ? `.${ctx.cseq}` : '';
        case 'seq':
        case 'num':
        case 'page':
        case 'col':
        case 'cseq':
        case 'pt': {
          const value = ctx[token.ph];
          return value === undefined ? '' : String(value);
        }
        case 'row':
        case 'phase':
        case 'grp':
        case 'addr':
        case 'tag':
        case 'pin':
          return ctx[token.ph] ?? '';
        default:
          return '';
      }
    })
    .join('');
}

export function uses(template: string, key: string): boolean {
  return (parseTemplate(template) ?? []).some((token) => 'ph' in token && token.ph === key);
}

function alpha(k: number): string {
  let n = k;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function dedupeSuffix(dedupe: string, k: number): string {
  return (parseTemplate(dedupe) ?? [])
    .map((token) => ('lit' in token ? token.lit : token.ph === 'a' ? alpha(k) : String(k)))
    .join('');
}

/* ------------------------------------------------------------------ 格式规则（check.ts 用） */

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function placeholderRe(key: string, scheme: WireNoScheme): string {
  switch (key) {
    case 'num':
      return `\\d{${Math.max(1, String(scheme.numStart).length)},}`;
    case 'phase':
      return '[1-3]';
    case 'row':
      return '[A-F-]';
    case 'cdot':
      return '(?:\\.\\d+)?';
    case 'addr':
      return '[A-Za-z]{1,3}\\d+(?:\\.\\d+)?';
    case 'tag':
      return '[A-Za-z][A-Za-z0-9]*';
    case 'pin':
      return '[A-Za-z0-9.+-]+';
    default:
      return '\\d+';
  }
}

function suffixRe(scheme: WireNoScheme): string {
  const body = (parseTemplate(scheme.dedupe) ?? [])
    .map((token) => ('lit' in token ? escapeRe(token.lit) : token.ph === 'a' ? '[a-z]+' : '\\d+'))
    .join('');
  return `(?:${body})?`;
}

/** 某类别模板对应的格式正则（含可选的重号区分后缀） */
export function templateRegex(template: string, scheme: WireNoScheme): RegExp {
  const body = (parseTemplate(template) ?? [{ lit: template }])
    .map((token) => ('lit' in token ? escapeRe(token.lit) : placeholderRe(token.ph, scheme)))
    .join('');
  return new RegExp(`^${body}${suffixRe(scheme)}$`);
}

/** 线号是否符合方案：给了类别就按该类别模板判，没给就符合任一类别即可 */
export function matchesScheme(no: string, scheme: WireNoScheme, category?: WireNoCategory): boolean {
  if (category) return templateRegex(scheme.templates[category], scheme).test(no);
  return WIRE_NO_CATEGORIES.some(({ id }) => templateRegex(scheme.templates[id], scheme).test(no));
}

/** 方案的一句话描述（图纸说明、校验建议） */
export function describeScheme(scheme: WireNoScheme): string {
  if (scheme.preset === 'digital' && sameTemplates(scheme, DEFAULT_WIRE_NO_SCHEME) && scheme.numStart === 101) {
    return 'L1/L2/L3/N/PE、24V/0V 为固定电位，其余网络 101 起按页→列连续编号，同网同号';
  }
  const ex = (category: WireNoCategory, ctx: WireNoContext = {}): string =>
    renderTemplate(scheme.templates[category], { seq: 1, num: scheme.numStart, page: 1, col: 2, row: 'A', cseq: 1, ccount: 1, phase: '1', grp: '1', addr: 'I0.0', pt: 1, tag: 'KM1', pin: 'U', ...ctx });
  const others = [...new Set(WIRE_NO_CATEGORIES.filter((item) => !item.bus).map((item) => scheme.templates[item.id]))];
  const fixed = `${ex('mainIn')}/${ex('mainIn', { phase: '2' })}/${ex('mainIn', { phase: '3' })}、${ex('neutralMain')}、${ex('pe')}、${ex('dc24')}/${ex('dc0')}`;
  if (others.length === 1) {
    const second = renderTemplate(others[0] as string, { seq: 2, num: scheme.numStart + 1, page: 1, col: 2, row: 'A', cseq: 1, ccount: 2, phase: '1', grp: '1', addr: 'I0.1', pt: 2, tag: 'KM2', pin: 'U' });
    return `方案「${schemeLabel(scheme)}」：${fixed} 固定，其余 ${others[0]}（如 ${ex('control')} / ${second}），同网同号`;
  }
  const examples = [
    ex('mainBus'),
    ex('branch'),
    ex('branchK'),
    ex('neutralBranch'),
    ex('motor'),
    ex('plcIn'),
    ex('plcOut', { addr: 'Q0.0', tag: 'YV1' }),
    ex('plcCommon', { pin: '3L+', tag: 'A1' }),
    ex('safety', { pin: 'S11', tag: 'KS1' }),
    ex('control')
  ];
  return `方案「${schemeLabel(scheme)}」：${fixed}，${[...new Set(examples)].join('、')}…；同网同号`;
}

export function sameTemplates(a: WireNoScheme, b: WireNoScheme): boolean {
  return WIRE_NO_CATEGORIES.every(({ id }) => a.templates[id] === b.templates[id]);
}

/* ------------------------------------------------------------------ 网络分类 */

export interface NetWireInfo {
  category: WireNoCategory;
  phase?: string;
  grp?: string;
  addr?: string;
  pt?: number;
  tag?: string;
  pin?: string;
}

const tagOf = (pin: string): string => pin.slice(0, pin.lastIndexOf(':'));
const pinOf = (pin: string): string => pin.slice(pin.lastIndexOf(':') + 1);
const tagText = (device: CircuitDevice | undefined, fallback: string): string => (device?.displayTag ?? device?.tag ?? fallback).replace(/^-+/, '');
const tagNumber = (tag: string | undefined): string => /(\d+)/.exec(tag ?? '')?.[1] ?? '';
const PLC_COMMON_RE = /^(?:\d?L\+|\d?M|COM\d*)$/;
const ANALOG_RE = /^(?:A[IQ]|P?[IQ]W)/i;

/**
 * 网络 → 类别 + 占位符取值。网络 id 由 build.ts 统一产出：
 *   标签 L1/L2/L3/N/PE/+24V/0V；BUS-Lk（总开关后母线）；Bn-L / Bn-Qi / Bn-Ki（支路相线）；Bn-N；Bn-U/V/W（电机出线）；
 *   IN-<地址> / OUT-<地址>（PLC 点）；S24（安全母线）、CH-i（安全链）、-KSx-…（安全继电器回路）；其余为控制回路。
 */
export function classifyNets(circuit: Circuit, plan: ElecPlan): Map<string, NetWireInfo> {
  const out = new Map<string, NetWireInfo>();
  const deviceByTag = new Map(circuit.devices.map((device) => [device.tag, device]));
  const plcTag = plan.plc;
  const inputs = plan.inputs.map((item) => item.address);
  const outputs = plan.outputs.map((item) => item.address);
  const phaseNo = (label: string | undefined): string => (label ? (/^L([123])$/.exec(label)?.[1] ?? '') : '');
  for (const net of circuit.nets) {
    const label = net.label ?? '';
    const id = net.id;
    const pins = net.pins;
    const devicesIn = pins.map((pin) => deviceByTag.get(tagOf(pin)));
    const kinds = new Set(devicesIn.map((device) => device?.kind));
    // 固定电位
    if (['L1', 'L2', 'L3'].includes(label)) {
      out.set(id, { category: 'mainIn', phase: phaseNo(label) });
      continue;
    }
    if (label === 'N') {
      out.set(id, { category: 'neutralMain' });
      continue;
    }
    if (label === 'PE') {
      out.set(id, { category: 'pe' });
      continue;
    }
    if (label === '+24V') {
      out.set(id, { category: 'dc24' });
      continue;
    }
    if (label === '0V') {
      out.set(id, { category: 'dc0' });
      continue;
    }
    // 主回路
    let m = /^BUS-L([123])$/.exec(id);
    if (m) {
      out.set(id, { category: 'mainBus', phase: m[1] as string, tag: tagText(deviceByTag.get(plan.mainBreaker), plan.mainBreaker), grp: tagNumber(plan.mainBreaker) });
      continue;
    }
    m = /^B(\d+)-(L|N|Q\d|K\d|[UVW])$/.exec(id);
    if (m) {
      const branch = plan.branches[Number(m[1])];
      const kind = m[2] as string;
      const breaker = branch?.breaker ?? '';
      if (/^[UVW]$/.test(kind)) {
        const motorPin = pins.find((pin) => deviceByTag.get(tagOf(pin))?.kind === 'motor');
        const motorTag = motorPin ? tagOf(motorPin) : (branch?.motor ?? '');
        out.set(id, { category: 'motor', phase: String('UVW'.indexOf(kind) + 1), pin: kind, grp: tagNumber(motorTag), tag: tagText(deviceByTag.get(motorTag), motorTag) });
        continue;
      }
      if (kind === 'N') {
        out.set(id, { category: 'neutralBranch', grp: tagNumber(breaker), tag: tagText(deviceByTag.get(breaker), breaker), pin: '4' });
        continue;
      }
      const phase = kind === 'L' ? phaseNo(branch?.phase) : String(Number(kind.slice(1)) + 1);
      const anchor = (kind.startsWith('K') ? pins.find((pin) => deviceByTag.get(tagOf(pin))?.kind === 'contactor') : pins.find((pin) => tagOf(pin) === breaker)) ?? pins[0] ?? '';
      out.set(id, { category: kind.startsWith('K') ? 'branchK' : 'branch', phase, grp: tagNumber(breaker), tag: tagText(deviceByTag.get(breaker), breaker), pin: pinOf(anchor) });
      continue;
    }
    // PLC
    const plcPins = pins.filter((pin) => tagOf(pin) === plcTag).map(pinOf);
    const ioPin = plcPins.find((pin) => inputs.includes(pin) || outputs.includes(pin) || ANALOG_RE.test(pin));
    if (ioPin) {
      const field = pins.find((pin) => {
        const device = deviceByTag.get(tagOf(pin));
        return device && device.tag !== plcTag && device.kind !== 'terminal';
      });
      const fieldDevice = field ? deviceByTag.get(tagOf(field)) : undefined;
      const isIn = inputs.includes(ioPin);
      const list = isIn ? inputs : outputs;
      const category: WireNoCategory = ANALOG_RE.test(ioPin) ? 'analog' : isIn ? 'plcIn' : 'plcOut';
      out.set(id, {
        category,
        addr: ioPin,
        pt: list.indexOf(ioPin) + 1,
        pin: ioPin,
        tag: tagText(fieldDevice ?? deviceByTag.get(plcTag), plcTag)
      });
      continue;
    }
    const commonPin = plcPins.find((pin) => PLC_COMMON_RE.test(pin));
    if (commonPin) {
      out.set(id, { category: 'plcCommon', pin: commonPin, tag: tagText(deviceByTag.get(plcTag), plcTag) });
      continue;
    }
    // 安全回路
    if (id === SAFE_NET_ID || /^CH-\d+$/.test(id) || kinds.has('safety') || kinds.has('curtain')) {
      const anchor = pins.find((pin) => {
        const kind = deviceByTag.get(tagOf(pin))?.kind;
        return kind === 'safety' || kind === 'curtain';
      }) ?? pins.find((pin) => deviceByTag.get(tagOf(pin))?.kind !== 'terminal') ?? '';
      out.set(id, { category: 'safety', tag: tagText(deviceByTag.get(tagOf(anchor)), tagOf(anchor)), pin: pinOf(anchor) });
      continue;
    }
    if (pins.length === 0) {
      out.set(id, { category: 'other' });
      continue;
    }
    const coil = pins.find((pin) => deviceByTag.get(tagOf(pin))?.kind === 'coil');
    const anchor = coil ?? pins.find((pin) => deviceByTag.get(tagOf(pin))?.kind !== 'terminal') ?? (pins[0] as string);
    out.set(id, { category: 'control', tag: tagText(deviceByTag.get(tagOf(anchor)), tagOf(anchor)), pin: pinOf(anchor) });
  }
  return out;
}

/* ------------------------------------------------------------------ 分配 */

export interface NetPlacement {
  net: string;
  /** 首次出现的页码（没画出来为 0） */
  page: number;
  col: number;
  row: string;
}

export interface WireNoAdjustment {
  net: string;
  base: string;
  no: string;
}

export interface WireNoAssignment {
  numbers: Record<string, string>;
  categories: Record<string, WireNoCategory>;
  /** 模板产生重号、被自动加了区分后缀的网络 */
  adjusted: WireNoAdjustment[];
  /** 线号排序名次（导线表排序用：母线在前，其余按阅读顺序） */
  rank: Record<string, number>;
}

/**
 * 按方案给每个网络分配线号。
 * order：网络首次出现位置的阅读顺序（页 → 列 → 行），没画出来的网络排在最后（page=0）。
 * 母线类别先分配（保证它们保住模板原值）；其余按阅读顺序。不同网络产生同一线号时，后出现的追加区分后缀。
 */
export function assignWireNoScheme(
  circuit: Circuit,
  info: Map<string, NetWireInfo>,
  order: readonly NetPlacement[],
  scheme: WireNoScheme
): WireNoAssignment {
  const numbers: Record<string, string> = {};
  const categories: Record<string, WireNoCategory> = {};
  const rank: Record<string, number> = {};
  const adjusted: WireNoAdjustment[] = [];
  const placement = new Map(order.map((item) => [item.net, item]));
  const busOrder = WIRE_NO_CATEGORIES.filter((item) => item.bus).map((item) => item.id);
  const nets = circuit.nets.map((net) => net.id);
  const isBus = (net: string): boolean => BUS_CATEGORIES.has(info.get(net)?.category ?? 'other');
  const busNets = nets
    .filter(isBus)
    .sort((a, b) => busOrder.indexOf(info.get(a)?.category as WireNoCategory) - busOrder.indexOf(info.get(b)?.category as WireNoCategory) || Number(info.get(a)?.phase ?? 0) - Number(info.get(b)?.phase ?? 0));
  const seenOrder = order.map((item) => item.net).filter((net) => nets.includes(net) && !isBus(net));
  const rest = nets.filter((net) => !isBus(net) && !seenOrder.includes(net));
  const sequence = [...busNets, ...seenOrder, ...rest];

  // 同页同列分组（只数用 {cseq}/{cdot} 的网络）
  const colGroups = new Map<string, string[]>();
  for (const net of sequence) {
    const category = info.get(net)?.category ?? 'other';
    const template = scheme.templates[category];
    if (!uses(template, 'cseq') && !uses(template, 'cdot')) continue;
    const at = placement.get(net);
    const key = `${at?.page ?? 0}.${at?.col ?? 0}`;
    const list = colGroups.get(key) ?? [];
    list.push(net);
    colGroups.set(key, list);
  }
  const seqByCategory = new Map<WireNoCategory, number>();
  let num = scheme.numStart;
  const used = new Map<string, string>();
  sequence.forEach((net, index) => {
    const meta = info.get(net) ?? { category: 'other' as WireNoCategory };
    const category = meta.category;
    const template = scheme.templates[category];
    const at = placement.get(net);
    // PLC 点的 {seq} 跟地址顺序走（第 1 个输入点 = DI1），不跟它在图上首次出现的位置走
    const seq = PLC_CATEGORIES.has(category) && meta.pt ? meta.pt : (seqByCategory.get(category) ?? 0) + 1;
    if (!PLC_CATEGORIES.has(category)) seqByCategory.set(category, seq);
    const ctx: WireNoContext = { seq, page: at?.page ?? 0, col: at?.col ?? 0, row: at?.row ?? '-' };
    if (uses(template, 'num')) {
      ctx.num = num;
      num += 1;
    }
    const group = colGroups.get(`${at?.page ?? 0}.${at?.col ?? 0}`);
    if (group && group.includes(net)) {
      ctx.cseq = group.indexOf(net) + 1;
      ctx.ccount = group.length;
    }
    if (meta.phase !== undefined) ctx.phase = meta.phase;
    if (meta.grp !== undefined) ctx.grp = meta.grp;
    if (meta.addr !== undefined) ctx.addr = meta.addr;
    if (meta.pt !== undefined) ctx.pt = meta.pt;
    if (meta.tag !== undefined) ctx.tag = meta.tag;
    if (meta.pin !== undefined) ctx.pin = meta.pin;
    const base = renderTemplate(template, ctx) || net;
    let no = base;
    if (used.has(no.toUpperCase())) {
      let k = 1;
      do {
        no = `${base}${dedupeSuffix(scheme.dedupe, k)}`;
        k += 1;
      } while (used.has(no.toUpperCase()));
      adjusted.push({ net, base, no });
    }
    used.set(no.toUpperCase(), net);
    numbers[net] = no;
    categories[net] = category;
    rank[net] = index;
  });
  return { numbers, categories, adjusted, rank };
}
