// 首页的纯逻辑：最近工程排序/裁剪/元信息格式化、空态文案、版本标签。
// 抽出来是为了能单测（时间格式化最容易写错），DOM 渲染在 home-screen.ts。

export interface HomeProjectInput {
  id: string;
  name: string;
  process: string;
  parts: number;
  createdAt: string;
}

export interface HomeProject {
  id: string;
  name: string;
  /** 「工艺 · 12 件 · 10-26 14:20」 */
  meta: string;
  createdAt: string;
}

export interface HomeModel {
  projects: HomeProject[];
  /** 最近工程为空时显示的话（不写「示例」，首页不出现示例装配）。 */
  emptyHint: string;
  footerHint: string;
  versionLabel: string;
}

export interface HomeModelOptions {
  now?: Date;
  /** 最多展示几条（默认 6）。 */
  limit?: number;
  /** 读取工程列表失败时的原因，会进 footerHint。 */
  error?: string | null;
  appVersion?: string;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** ISO → 「MM-DD HH:mm」（本地时区）；无法解析返回空串，不编时间。 */
export function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 「今天/昨天/N 天前」——给「最近」列表一点时间感；未来时间按今天算。 */
export function formatRelativeDay(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const startOf = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return formatShortTime(iso).slice(0, 5);
}

export function projectMeta(project: HomeProjectInput, now: Date = new Date()): string {
  const parts: string[] = [];
  const process = project.process?.trim();
  if (process) parts.push(process);
  parts.push(`${project.parts} 件`);
  const time = formatShortTime(project.createdAt);
  if (time) parts.push(`${formatRelativeDay(project.createdAt, now)} ${time.slice(6)}`);
  return parts.join(' · ');
}

export function buildHomeModel(inputs: readonly HomeProjectInput[], options: HomeModelOptions = {}): HomeModel {
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit ?? 6);
  const sorted = [...inputs]
    .filter((item) => item && typeof item.id === 'string' && item.id.trim() !== '')
    .sort((a, b) => {
      const left = Date.parse(a.createdAt);
      const right = Date.parse(b.createdAt);
      const safeLeft = Number.isNaN(left) ? 0 : left;
      const safeRight = Number.isNaN(right) ? 0 : right;
      // 新工程在前；时间相同按名字稳定排序
      return safeRight - safeLeft || a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      name: item.name?.trim() || item.id,
      meta: projectMeta(item, now),
      createdAt: item.createdAt
    }));

  const error = options.error?.trim() ?? '';
  return {
    projects: sorted,
    emptyHint:
      sorted.length === 0 && !error
        ? '还没有保存过工程。用左侧「空白画布」或「演示拓扑」开始，设计向导保存后就会出现在这里。'
        : '',
    footerHint: error || '首页不加载示例装配；需要看示例请点「进入经典原型界面」。',
    versionLabel: options.appVersion ? `v${options.appVersion}` : ''
  };
}
