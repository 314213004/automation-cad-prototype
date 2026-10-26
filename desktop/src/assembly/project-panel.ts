// 工程零件属性面板（扩展接管右侧「属性」区）
//
// 背景：原型 app.js 的右侧属性面板读的是硬编码 PARTS（薄型气缸 CYL-032-050 等演示件）。
// 打开真实工程后，左侧/3D 已经是工程零件，右侧却还显示演示气缸——面板与工程不联动。
//
// 这里做一个「工程模式」面板：只要当前有打开的工程，就用工程数据接管右侧属性区；
// 选中 3D 零件时显示该零件真实包围盒，未选中时显示工程摘要（件数/包络/质量/导出物）。
// 不伪造质量：单件质量工程记录里没有，就写「未称重（工程合计 X kg）」，不按体积瞎算。
import type { InterferencePart } from '../mech/interference.ts';

export interface ProjectPanelInfo {
  name: string;
  parts: number;
  envelopeMm: [number, number, number] | null;
  massKg: number | null;
  hasStep: boolean;
  hasStl: boolean;
  createdAt: string;
  materials: string[];
}

let current: ProjectPanelInfo | null = null;
let attached = false;
let lastKey = '';
let pollTimer = 0;

const STYLE_ID = 'project-panel-styles';

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
  [data-panel="right"][data-project-panel="true"] { font: 12px/1.6 "Segoe UI", "PingFang SC", sans-serif; }
  [data-panel="right"] .pp-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #2a333d; }
  [data-panel="right"] .pp-head b { font-size: 13px; }
  [data-panel="right"] .pp-badge { padding: 1px 6px; border-radius: 9px; font-size: 10px; border: 1px solid #2f6d63; background: #1d3a35; color: #9fe8d3; }
  [data-panel="right"] .pp-note { padding: 6px 12px; color: #8b98a9; font-size: 11px; }
  [data-panel="right"] .pp-row { display: flex; gap: 10px; padding: 3px 12px; }
  [data-panel="right"] .pp-row span { min-width: 82px; color: #8b98a9; }
  [data-panel="right"] .pp-row b { font-weight: 500; color: #dfe7f3; }
  [data-panel="right"] .pp-hint { margin: 4px 12px 8px; color: #7d8b9c; font-size: 11px; }
  `;
  document.head.appendChild(style);
}

function panelHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-panel="right"][data-for="assembly"]');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
  );
}

function fmt(value: number, digits = 2): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function summaryHtml(info: ProjectPanelInfo): string {
  const env = info.envelopeMm;
  return `
  <div class="pp-head">
    <b>工程零件</b>
    <span class="pp-badge">实时</span>
  </div>
  <div class="pp-note">当前工程：${escapeHtml(info.name)}</div>
  <section>
    <h4>工程概况</h4>
    <div class="pp-row"><span>零件数</span><b>${info.parts} 件</b></div>
    ${env ? `<div class="pp-row"><span>包络</span><b>${fmt(env[0], 1)} × ${fmt(env[1], 1)} × ${fmt(env[2], 1)} mm</b></div>` : ''}
    ${info.massKg !== null ? `<div class="pp-row"><span>合计质量</span><b>${fmt(info.massKg, 1)} kg</b></div>` : ''}
    ${info.materials.length > 0 ? `<div class="pp-row"><span>材料</span><b>${escapeHtml(info.materials.join('、'))}</b></div>` : ''}
    <div class="pp-row"><span>导出物</span><b>${info.hasStep ? 'STEP' : '—'}${info.hasStl ? ' / STL' : ''}</b></div>
  </section>
  <section>
    <h4>怎么用</h4>
    <p class="pp-hint">在 3D 视口或左侧结构树点选零件，这里会显示它的真实属性与包围盒。演示气缸的属性只在未打开工程时出现。</p>
  </section>`;
}

function partHtml(name: string, bbox: number[] | null): string {
  const size = bbox && bbox.length === 6
    ? [
        (bbox[3] ?? 0) - (bbox[0] ?? 0),
        (bbox[4] ?? 0) - (bbox[1] ?? 0),
        (bbox[5] ?? 0) - (bbox[2] ?? 0)
      ]
    : null;
  return `
  <div class="pp-head">
    <b>${escapeHtml(name)}</b>
    <span class="pp-badge">实时</span>
  </div>
  ${current ? `<div class="pp-note">所属工程：${escapeHtml(current.name)}</div>` : ''}
  <section>
    <h4>几何</h4>
    ${size
      ? `<div class="pp-row"><span>包围盒</span><b>${fmt(size[0] ?? 0, 1)} × ${fmt(size[1] ?? 0, 1)} × ${fmt(size[2] ?? 0, 1)} mm</b></div>`
      : '<div class="pp-row"><span>包围盒</span><b>—</b></div>'}
    ${bbox
      ? `<div class="pp-row"><span>X / Y / Z 范围</span><b>${fmt(bbox[0] ?? 0, 1)}~${fmt(bbox[3] ?? 0, 1)} / ${fmt(bbox[1] ?? 0, 1)}~${fmt(bbox[4] ?? 0, 1)} / ${fmt(bbox[2] ?? 0, 1)}~${fmt(bbox[5] ?? 0, 1)}</b></div>`
      : ''}
  </section>
  <section>
    <h4>属性</h4>
    <div class="pp-row"><span>零件名</span><b>${escapeHtml(name)}</b></div>
    <div class="pp-row"><span>质量</span><b>未称重${current?.massKg != null ? `（工程合计 ${fmt(current.massKg, 1)} kg）` : ''}</b></div>
    <p class="pp-hint">型号/零件号/材料来自工程记录；单件质量与材料表未随 STL 导入，不做估算填充。</p>
  </section>`;
}

function render(): void {
  const host = panelHost();
  if (!host || !current) return;
  const bridge = (window as unknown as { __AgentBridge?: { getSelection?: () => unknown } }).__AgentBridge;
  let selection: { name?: string; bbox?: number[] } | null = null;
  try {
    const raw = bridge?.getSelection?.();
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { name?: unknown }).name === 'string') {
      selection = raw as { name: string; bbox?: number[] };
    }
  } catch {
    selection = null;
  }
  const key = selection?.name ?? '__summary__';
  if (key === lastKey) return;
  lastKey = key;
  host.innerHTML = selection?.name
    ? partHtml(selection.name, selection.bbox ?? null)
    : summaryHtml(current);
  host.dataset.projectPanel = 'true';
}

/** 工程打开后调用：接管右侧属性面板。 */
export function attachProjectPanel(info: ProjectPanelInfo): void {
  injectStyles();
  current = info;
  lastKey = '';
  render();
  if (attached) return;
  attached = true;
  // 选中变化：原型自己重写 DOM，这里在点击/指针抬起后补一次（幂等，key 不变不重绘）
  const stage = document.getElementById('stageAssembly');
  const refresh = (): void => {
    window.setTimeout(() => {
      lastKey = '';
      render();
    }, 60);
  };
  stage?.addEventListener('pointerup', refresh, true);
  stage?.addEventListener('mouseup', refresh, true);
  stage?.addEventListener('click', refresh, true);
  document.addEventListener('keydown', refresh, true);
  // 3D 拾取走 three.js 射线，不一定冒泡 pointerup；用一个 500ms 变更检测兜底（key 变了才重绘）
  pollTimer = window.setInterval(() => {
    const host = panelHost();
    if (!host || host.dataset.projectPanel !== 'true') return;
    const before = lastKey;
    render();
    if (lastKey !== before) lastKey = lastKey;
  }, 500);
}

/** 退出工程（回到演示）时恢复原型面板。 */
export function detachProjectPanel(): void {
  current = null;
  lastKey = '';
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
  }
  const host = panelHost();
  if (host) host.removeAttribute('data-project-panel');
}

export function projectPanelInfo(): ProjectPanelInfo | null {
  return current;
}

export function __testRenderSummary(info: ProjectPanelInfo): string {
  return summaryHtml(info);
}

export function __testRenderPart(name: string, bbox: number[] | null, info: ProjectPanelInfo | null): string {
  current = info;
  return partHtml(name, bbox);
}

/** 供扩展在工程打开时把 record 转成面板信息（纯函数，便于测试）。 */
export function toPanelInfo(record: {
  name: string;
  parts: number;
  envelope: [number, number, number] | null;
  massKg: number | null;
  hasStep: boolean;
  hasStl: boolean;
  createdAt: string;
  material?: string[];
}): ProjectPanelInfo {
  return {
    name: record.name,
    parts: record.parts,
    envelopeMm: record.envelope,
    massKg: record.massKg,
    hasStep: record.hasStep,
    hasStl: record.hasStl,
    createdAt: record.createdAt,
    materials: record.material ?? []
  };
}
