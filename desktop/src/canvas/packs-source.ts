// 模组库数据源：把 packs 里的真实元件映射成画布可放的功能模组（P3 第二步）。
//
// 边界（必须写在 UI 上）：
//   - packs 提供型号/品类/规格/外形，**不提供质量**。质量按品类默认值给，节点上标注
//     「质量取品类默认值，待样本核对」；惯量/扭矩结论因此只到方案级。
//   - MountPort 是按品类推的通用接口（例如丝杠模组 grid→slider 60×60），不是该型号的
//     真实安装孔；要精确到型号，得等 3D/样本数据接入。
//   - 价格仍然只来自价格簿（按 partId 查），这里不带价格字段。
import type { CanvasNode, MountPort } from './types.ts';
import type { PaletteItem } from './demo-graph.ts';

const GRID50: MountPort = { family: 'grid', holeDiaMm: 6.6, pitchXMm: 50, pitchYMm: 50, count: 4 };
const SLIDER60: MountPort = { family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 };
const BODY48: MountPort = { family: 'body', holeDiaMm: 5.5, pitchXMm: 48, pitchYMm: 36, count: 4 };
const PLATE32: MountPort = { family: 'plate', holeDiaMm: 4.5, pitchXMm: 32, pitchYMm: 32, count: 4 };
const TIP: MountPort = { family: 'tip', holeDiaMm: 0, pitchXMm: 0, pitchYMm: 0, count: 0 };
const OPTICAL: MountPort = { family: 'optical', holeDiaMm: 0, pitchXMm: 0, pitchYMm: 0, count: 0 };
const FLOOR: MountPort = { family: 'floor', holeDiaMm: 12, pitchXMm: 700, pitchYMm: 550, count: 4 };

type Kind = CanvasNode['kind'];

interface CategoryRule {
  /** 命中这些品类名（精确匹配，避免「气缸」误吞「气缸传感器」）。 */
  categories: readonly string[];
  kind: Kind;
  portIn: MountPort;
  portOut: MountPort;
  /** 品类默认行程/导程/单步时间（mm/s）。 */
  strokeMm: number;
  leadMm: number;
  stepSec: number;
  /** 品类默认质量 kg（packs 无质量字段，这里是有据可查的工程经验值，需样本核对）。 */
  defaultMassKg: number;
  /** 无外形数据时的兜底尺寸 mm。 */
  defaultDimsMm: [number, number, number];
  io: { di: number; do: number; desc: string };
  sectionLabel: string;
}

/**
 * 品类 → 画布模组。只收录**能当机械节点挂载**的品类；
 * 断路器/端子/继电器这类纯电气件不进画布（它们属于 elec/BOM，不是装配节点）。
 */
export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    categories: ['滚珠丝杠', '直线导轨', '直线模组', '同步带模组'],
    kind: 'linear',
    portIn: GRID50,
    portOut: SLIDER60,
    strokeMm: 300,
    leadMm: 10,
    stepSec: 0.45,
    defaultMassKg: 6.5,
    defaultDimsMm: [480, 80, 70],
    io: { di: 3, do: 2, desc: '限位 + 原点 + 伺服使能' },
    sectionLabel: '直线传动'
  },
  {
    categories: ['气缸', '无杆气缸', '滑台气缸', '气源处理'],
    kind: 'actuator',
    portIn: BODY48,
    portOut: PLATE32,
    strokeMm: 100,
    leadMm: 0,
    stepSec: 0.35,
    defaultMassKg: 1.8,
    defaultDimsMm: [80, 62, 195],
    io: { di: 2, do: 2, desc: '磁性开关 + 电磁阀' },
    sectionLabel: '气动执行器'
  },
  {
    categories: ['气爪', '真空吸盘'],
    kind: 'gripper',
    portIn: PLATE32,
    portOut: TIP,
    strokeMm: 20,
    leadMm: 5,
    stepSec: 0.25,
    defaultMassKg: 0.9,
    defaultDimsMm: [70, 70, 95],
    io: { di: 2, do: 2, desc: '开合/真空到位反馈' },
    sectionLabel: '末端执行器'
  },
  {
    categories: ['工业相机', '镜头', '光源'],
    kind: 'vision',
    portIn: GRID50,
    portOut: OPTICAL,
    strokeMm: 0,
    leadMm: 0,
    stepSec: 0.25,
    defaultMassKg: 1.4,
    defaultDimsMm: [90, 90, 210],
    io: { di: 1, do: 2, desc: '触发 + 光源频闪' },
    sectionLabel: '视觉'
  },
  {
    categories: ['工业铝型材', '型材配件', '机架'],
    kind: 'frame',
    portIn: FLOOR,
    portOut: GRID50,
    strokeMm: 0,
    leadMm: 0,
    stepSec: 0,
    defaultMassKg: 45,
    defaultDimsMm: [800, 650, 750],
    io: { di: 2, do: 1, desc: '安全回路' },
    sectionLabel: '机架'
  }
];

export interface CanvasPackPart {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  specs?: Record<string, string | number>;
  dims?: { w: number; h: number; d: number };
}

export function ruleForCategory(category: string): CategoryRule | null {
  return CATEGORY_RULES.find((rule) => rule.categories.includes(category)) ?? null;
}

function dims(part: CanvasPackPart, rule: CategoryRule): [number, number, number] {
  const raw = part.dims;
  if (!raw) return rule.defaultDimsMm;
  const values = [raw.w, raw.h, raw.d];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) return rule.defaultDimsMm;
  return [values[0] as number, values[1] as number, values[2] as number];
}

/** packs 元件 → 模组模板。品类不在白名单里返回 null（不硬塞成节点）。 */
export function paletteItemFromPack(part: CanvasPackPart): PaletteItem | null {
  if (!part || typeof part.id !== 'string' || part.id.trim() === '') return null;
  if (typeof part.model !== 'string' || part.model.trim() === '') return null;
  const rule = ruleForCategory(part.category);
  if (!rule) return null;
  const size = dims(part, rule);
  return {
    id: `pack:${part.id}`,
    label: part.model,
    partId: part.id,
    kind: rule.kind,
    spec: `${part.category}${part.vendor ? ` · ${part.vendor}` : ''} · 质量取品类默认 ${rule.defaultMassKg}kg（待样本核对）`,
    portIn: { ...rule.portIn },
    portOut: { ...rule.portOut },
    strokeMm: rule.strokeMm,
    leadMm: rule.leadMm,
    massKg: rule.defaultMassKg,
    stepSec: rule.stepSec,
    dimsMm: [size[0], size[1], size[2]],
    io: { ...rule.io }
  };
}

export interface PaletteSection {
  key: string;
  label: string;
  items: PaletteItem[];
  /** 该品类在 packs 里的总数（可能多于展示条数）。 */
  total: number;
}

/**
 * 按品类分组，组内按型号字典序（确定性，便于测试与复现）；
 * 每组最多 `limitPerSection` 件，超出只展示前 N 件并在 UI 标注总数。
 */
export function buildPaletteSections(
  parts: readonly CanvasPackPart[],
  limitPerSection = 12
): PaletteSection[] {
  const groups = new Map<string, PaletteItem[]>();
  for (const part of parts) {
    const item = paletteItemFromPack(part);
    if (!item) continue;
    const rule = ruleForCategory(part.category);
    if (!rule) continue;
    const list = groups.get(rule.sectionLabel) ?? [];
    list.push(item);
    groups.set(rule.sectionLabel, list);
  }
  const sections: PaletteSection[] = [];
  for (const rule of CATEGORY_RULES) {
    const list = groups.get(rule.sectionLabel);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((left, right) => left.label.localeCompare(right.label, 'en'));
    sections.push({
      key: rule.kind,
      label: rule.sectionLabel,
      items: sorted.slice(0, Math.max(1, limitPerSection)),
      total: sorted.length
    });
  }
  return sections;
}

/** 统计：用于 UI 说明「来自 packs 的 N 件里有多少能上画布」。 */
export function summarizePackCoverage(parts: readonly CanvasPackPart[]): { total: number; mountable: number; sections: number } {
  const mountable = parts.filter((part) => paletteItemFromPack(part) !== null).length;
  return { total: parts.length, mountable, sections: buildPaletteSections(parts, Number.MAX_SAFE_INTEGER).length };
}
