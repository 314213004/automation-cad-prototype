/**
 * 「线号格式」弹窗 + 设置持久化。
 *
 * 入口在电气域画布翻页条（extension.ts 注入，不改原型文件）。选预设 / 逐类别改模板 / 改 {num} 起始号与重号后缀，
 * 每次输入都用 validateWireNoScheme 校验并实时预览示例线号；保存后写 localStorage 并回调重画当前图。
 * 纯函数部分（读写存储、预览）不碰 DOM，可单测。
 */

import {
  DEFAULT_WIRE_NO_SCHEME,
  presetScheme,
  renderTemplate,
  sameTemplates,
  validateWireNoScheme,
  WIRE_NO_CATEGORIES,
  WIRE_NO_PLACEHOLDERS,
  WIRE_NO_PRESETS,
  type WireNoCategory,
  type WireNoContext,
  type WireNoPresetId,
  type WireNoScheme
} from './wireno.ts';

export const WIRE_SCHEME_STORE_KEY = 'automationcad.elec.wireScheme.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 读已保存的方案；没有或不合法时退回缺省（数字连续），并给出原因 */
export function loadStoredWireScheme(storage: StorageLike | null): { scheme: WireNoScheme; warning?: string } {
  if (!storage) return { scheme: DEFAULT_WIRE_NO_SCHEME };
  let raw: string | null = null;
  try {
    raw = storage.getItem(WIRE_SCHEME_STORE_KEY);
  } catch {
    return { scheme: DEFAULT_WIRE_NO_SCHEME };
  }
  if (!raw) return { scheme: DEFAULT_WIRE_NO_SCHEME };
  try {
    const checked = validateWireNoScheme(JSON.parse(raw));
    if (checked.ok) return { scheme: checked.scheme };
    return { scheme: DEFAULT_WIRE_NO_SCHEME, warning: `已保存的线号方案不合法，按“数字连续”出图：${checked.errors.join('；')}` };
  } catch {
    return { scheme: DEFAULT_WIRE_NO_SCHEME, warning: '已保存的线号方案无法解析，按“数字连续”出图' };
  }
}

export function storeWireScheme(storage: StorageLike, scheme: WireNoScheme): void {
  storage.setItem(WIRE_SCHEME_STORE_KEY, JSON.stringify(scheme));
}

/** 每个类别的示例上下文（三个示例：第 1/2/3 个网络） */
function sampleContexts(category: WireNoCategory, numStart: number): WireNoContext[] {
  return [0, 1, 2].map((i) => {
    const base: WireNoContext = { seq: i + 1, num: numStart + i, page: 1 + Math.floor(i / 2), col: 2 + i, row: 'B', cseq: 1, ccount: 1, tag: `KM${i + 1}`, grp: String(i + 1) };
    if (category === 'mainIn' || category === 'mainBus') return { ...base, phase: String(i + 1), grp: '0', tag: 'QF0', pin: String(2 * i + 2) };
    if (category === 'branch' || category === 'branchK') return { ...base, phase: String(i + 1), grp: '2', tag: 'QF2', pin: String(2 * i + 2) };
    if (category === 'motor') return { ...base, phase: String(i + 1), pin: 'UVW'[i] as string, grp: '1', tag: 'M1' };
    if (category === 'plcIn') return { ...base, addr: `I0.${i}`, pt: i + 1, pin: `I0.${i}`, tag: `B${i + 1}` };
    if (category === 'plcOut') return { ...base, addr: `Q0.${i}`, pt: i + 1, pin: `Q0.${i}`, tag: `YV${i + 1}` };
    if (category === 'analog') return { ...base, addr: `AI${i}`, pt: i + 1, pin: `AI${i}`, tag: `B${i + 1}` };
    if (category === 'plcCommon') return { ...base, pin: ['3L+', '1M', '3M'][i] as string, tag: 'A1' };
    if (category === 'safety') return { ...base, pin: ['S11', 'S12', 'S21'][i] as string, tag: 'KS1' };
    return { ...base, pin: 'A1' };
  });
}

/** 预览：每个类别三个示例线号（母线类别只有一个电位，取第一个；三相取三相） */
export function previewWireNumbers(scheme: WireNoScheme): Record<WireNoCategory, string[]> {
  const out = {} as Record<WireNoCategory, string[]>;
  for (const { id, bus } of WIRE_NO_CATEGORIES) {
    const values = sampleContexts(id, scheme.numStart).map((ctx) => renderTemplate(scheme.templates[id], ctx));
    out[id] = bus && id !== 'mainIn' ? values.slice(0, 1) : [...new Set(values)];
  }
  return out;
}

/** 这份方案正好等于某个预设时返回该预设 id，否则 custom */
export function detectPreset(scheme: WireNoScheme): WireNoPresetId {
  for (const id of ['digital', 'potential', 'pagecol'] as const) {
    const preset = WIRE_NO_PRESETS[id].scheme;
    if (sameTemplates(scheme, preset) && scheme.numStart === preset.numStart && scheme.dedupe === preset.dedupe) return id;
  }
  return 'custom';
}

const esc = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

export interface WireSchemeDialogOptions {
  current: WireNoScheme;
  /** 保存（已校验）；返回后弹窗关闭 */
  onSave: (scheme: WireNoScheme) => void;
}

/** 打开「线号格式」弹窗（同一时间只开一个） */
export function openWireSchemeDialog(options: WireSchemeDialogOptions): HTMLElement {
  document.querySelector('.cad-wireno-dialog')?.remove();
  const root = document.createElement('div');
  root.className = 'cad-wireno-dialog';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '线号格式');
  let draft: WireNoScheme = { ...options.current, templates: { ...options.current.templates } };
  const presetOptions = (['digital', 'potential', 'pagecol'] as const)
    .map((id) => `<option value="${id}">${esc(WIRE_NO_PRESETS[id].label)}</option>`)
    .join('');
  root.innerHTML = `
    <div class="cad-wireno-card">
      <div class="cad-wireno-head"><strong>线号格式</strong><button type="button" data-wireno-close title="关闭">×</button></div>
      <label class="cad-wireno-row">预设
        <select data-wireno-preset>${presetOptions}<option value="custom">自定义</option></select>
      </label>
      <p class="cad-wireno-desc" data-wireno-desc></p>
      <table class="cad-wireno-table">
        <thead><tr><th>网络类别</th><th>模板</th><th>示例</th></tr></thead>
        <tbody>${WIRE_NO_CATEGORIES.map(
          ({ id, label }) =>
            `<tr data-wireno-cat="${id}"><td>${esc(label)}</td><td><input type="text" spellcheck="false" maxlength="40" data-wireno-tpl="${id}"></td><td class="cad-wireno-preview" data-wireno-preview="${id}"></td></tr>`
        ).join('')}</tbody>
      </table>
      <div class="cad-wireno-row">
        <label>{num} 起始号 <input type="number" min="0" max="99999" step="1" data-wireno-num></label>
        <label>重号区分后缀 <input type="text" spellcheck="false" maxlength="10" data-wireno-dedupe></label>
      </div>
      <details class="cad-wireno-help"><summary>占位符</summary><ul>${WIRE_NO_PLACEHOLDERS.map((item) => `<li><code>{${esc(item.key)}}</code> ${esc(item.label)}</li>`).join('')}<li>其余字符原样输出（只允许字母、数字和 . + - _ / :）。不同网络若生成同一线号，后出现的自动加区分后缀，并在出图自检里提示。</li></ul></details>
      <div class="cad-wireno-errors" data-wireno-errors role="alert"></div>
      <div class="cad-wireno-actions"><button type="button" data-wireno-cancel>取消</button><button type="button" class="is-primary" data-wireno-save>保存并重画</button></div>
    </div>`;
  const q = <T extends Element>(selector: string): T => root.querySelector(selector) as T;
  const presetSel = q<HTMLSelectElement>('[data-wireno-preset]');
  const numInput = q<HTMLInputElement>('[data-wireno-num]');
  const dedupeInput = q<HTMLInputElement>('[data-wireno-dedupe]');
  const saveBtn = q<HTMLButtonElement>('[data-wireno-save]');

  const fillInputs = (): void => {
    presetSel.value = draft.preset;
    for (const { id } of WIRE_NO_CATEGORIES) q<HTMLInputElement>(`[data-wireno-tpl="${id}"]`).value = draft.templates[id];
    numInput.value = String(draft.numStart);
    dedupeInput.value = draft.dedupe;
  };
  const readInputs = (): unknown => {
    const templates: Record<string, string> = {};
    for (const { id } of WIRE_NO_CATEGORIES) templates[id] = q<HTMLInputElement>(`[data-wireno-tpl="${id}"]`).value;
    return { version: 1, preset: presetSel.value, templates, numStart: numInput.value.trim() === '' ? Number.NaN : Number(numInput.value), dedupe: dedupeInput.value };
  };
  const refresh = (): void => {
    const checked = validateWireNoScheme(readInputs());
    const errorsBox = q<HTMLElement>('[data-wireno-errors]');
    const desc = q<HTMLElement>('[data-wireno-desc]');
    desc.textContent = presetSel.value === 'custom' ? '自定义：逐类别编辑模板' : WIRE_NO_PRESETS[presetSel.value as Exclude<WireNoPresetId, 'custom'>].description;
    for (const { id } of WIRE_NO_CATEGORIES) q<HTMLElement>(`[data-wireno-cat="${id}"]`).classList.remove('is-invalid');
    if (!checked.ok) {
      errorsBox.innerHTML = checked.errors.map((item) => `<div>${esc(item)}</div>`).join('');
      for (const { id, label } of WIRE_NO_CATEGORIES) {
        if (checked.errors.some((item) => item.includes(`「${label}」`))) q<HTMLElement>(`[data-wireno-cat="${id}"]`).classList.add('is-invalid');
      }
      saveBtn.disabled = true;
      return;
    }
    draft = checked.scheme;
    errorsBox.textContent = '';
    saveBtn.disabled = false;
    const preview = previewWireNumbers(draft);
    for (const { id } of WIRE_NO_CATEGORIES) q<HTMLElement>(`[data-wireno-preview="${id}"]`).textContent = (preview[id] ?? []).join('、');
  };
  const close = (): void => root.remove();

  presetSel.addEventListener('change', () => {
    if (presetSel.value !== 'custom') {
      draft = presetScheme(presetSel.value as Exclude<WireNoPresetId, 'custom'>);
      fillInputs();
    }
    refresh();
  });
  root.addEventListener('input', (event) => {
    const target = event.target as HTMLElement;
    if (target.matches('[data-wireno-tpl], [data-wireno-num], [data-wireno-dedupe]')) {
      const raw = readInputs() as { templates: Record<string, string>; numStart: number; dedupe: string };
      const asScheme = { ...draft, templates: { ...draft.templates, ...raw.templates }, numStart: raw.numStart, dedupe: raw.dedupe } as WireNoScheme;
      presetSel.value = detectPreset(asScheme);
    }
    refresh();
  });
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target === root || target.closest('[data-wireno-close], [data-wireno-cancel]')) {
      close();
      return;
    }
    if (target.closest('[data-wireno-save]')) {
      const checked = validateWireNoScheme(readInputs());
      if (!checked.ok) {
        refresh();
        return;
      }
      options.onSave(checked.scheme);
      close();
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  fillInputs();
  document.body.appendChild(root);
  refresh();
  q<HTMLSelectElement>('[data-wireno-preset]').focus();
  return root;
}
