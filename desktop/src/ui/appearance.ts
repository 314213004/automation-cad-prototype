import type { AppearanceConfig } from '../shared/appearance.ts';
import type { RenderQuality } from '../orbit/quality.ts';

export const UI_SCALE_OPTIONS = [
  { value: 1, label: '100%' },
  { value: 1.1, label: '110%' },
  { value: 1.15, label: '115%' },
  { value: 1.25, label: '125%' },
  { value: 1.4, label: '140%' },
  { value: 1.5, label: '150%' }
] as const;

export const RENDER_QUALITY_OPTIONS: ReadonlyArray<{ value: RenderQuality; label: string }> = [
  { value: 'flow', label: '流畅（≤1.0x，关闭抗锯齿）' },
  { value: 'standard', label: '标准（≤1.5x，抗锯齿）' },
  { value: 'high', label: '高清（≤2.0x，抗锯齿）' }
];

/** 只通过 CSS 变量缩放注入样式，根 styles.css 保持零改动。 */
export function applyUiScale(scale: number): void {
  const root = document.documentElement;
  root.style.setProperty('--acad-ui-scale', String(scale));
  root.dataset.acadUiScale = String(scale);
  window.dispatchEvent(new Event('resize'));
  window.AutomationCadOrbit?.resize();
  requestAnimationFrame(() => {
    window.AutomationCadOrbit?.resize();
    window.dispatchEvent(new Event('resize'));
  });
}

export function applyRenderQuality(quality: RenderQuality): void {
  document.documentElement.dataset.acadRenderQuality = quality;
  window.AutomationCadOrbit?.setRenderQuality(quality);
}

export function applyAppearance(config: AppearanceConfig): void {
  applyUiScale(config.uiScale);
  applyRenderQuality(config.renderQuality);
}

