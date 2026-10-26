import type { ActuatorConfig } from '../commission/machine-config.ts';
import {
  DEFAULT_ACTUATOR_TRAVEL_MM,
  MAX_ACTUATOR_TRAVEL_MM,
  MIN_ACTUATOR_TRAVEL_MM,
  DEFAULT_ROTATION_RANGE_DEG,
  MAX_ROTATION_RANGE_DEG,
  MIN_ROTATION_RANGE_DEG
} from '../commission/machine-config.ts';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

export function actuatorTravelSourceLabel(actuator: Pick<ActuatorConfig, 'travelSource'>): string {
  return actuator.travelSource === 'engineer-input'
    ? '工程师输入·待复核'
    : '方案/系统估算·待核验';
}

export function actuatorTravelInputError(value: number): string | null {
  if (!Number.isFinite(value) || value < MIN_ACTUATOR_TRAVEL_MM || value > MAX_ACTUATOR_TRAVEL_MM) {
    return `行程必须是 ${MIN_ACTUATOR_TRAVEL_MM}–${MAX_ACTUATOR_TRAVEL_MM} mm 的有限数`;
  }
  return null;
}

export function actuatorRotationRangeSourceLabel(actuator: Pick<ActuatorConfig, 'rotationRangeSource'>): string {
  return actuator.rotationRangeSource === 'engineer-input'
    ? '工程师输入·待复核'
    : '方案/系统估算·待核验';
}

export function actuatorRotationRangeInputError(value: number): string | null {
  if (!Number.isFinite(value) || value < MIN_ROTATION_RANGE_DEG || value > MAX_ROTATION_RANGE_DEG) {
    return `旋转分度角必须是 ${MIN_ROTATION_RANGE_DEG}–${MAX_ROTATION_RANGE_DEG}° 的有限数`;
  }
  return null;
}

/** advance 专用门控：错误既通知用户，也标在各自输入旁；不会修改 draft 值。 */
export function guardMotionInputs(root: ParentNode, notify: (message: string) => void): boolean {
  const errors: string[] = [];
  const inputs = root.querySelectorAll<HTMLInputElement>('[data-key="travelMm"], [data-key="rotationRangeDeg"]');
  for (const input of inputs) {
    const error = input.dataset.key === 'rotationRangeDeg'
      ? actuatorRotationRangeInputError(input.valueAsNumber)
      : actuatorTravelInputError(input.valueAsNumber);
    const index = input.dataset.actuator ?? '';
    const errorLabel = root.querySelector<HTMLElement>(`[data-motion-error="${index}"]`);
    const sourceLabel = root.querySelector<HTMLElement>(`[data-motion-status="${index}"]`);
    input.setCustomValidity(error ?? '');
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    if (error) {
      if (errorLabel) errorLabel.textContent = error;
      if (sourceLabel) sourceLabel.textContent = '输入无效，尚未应用';
      errors.push(`${input.getAttribute('aria-label') ?? '执行机构'}：${error}`);
    } else if (errorLabel) {
      errorLabel.textContent = '';
    }
  }
  if (errors.length === 0) return true;
  notify(errors[0] ?? '请检查执行机构运动参数。');
  return false;
}

/** 供向导工位表格使用的运动参数单元格；不同执行机构类型不共用数值或来源。 */
export function renderActuatorTravelCell(actuator: ActuatorConfig, index: number): string {
  if (actuator.kind === 'rotary') {
    const value = actuator.rotationRangeDeg ?? DEFAULT_ROTATION_RANGE_DEG;
    return `<div class="design-travel-input"><input type="number" min="${MIN_ROTATION_RANGE_DEG}" max="${MAX_ROTATION_RANGE_DEG}" step="0.1" inputmode="decimal" data-actuator="${index}" data-key="rotationRangeDeg" aria-label="${escapeHtml(actuator.name)}旋转分度角（度）" value="${value}"><span>°</span></div><small data-motion-status="${index}">${actuatorRotationRangeSourceLabel(actuator)}</small><small class="design-travel-error" data-motion-error="${index}" role="alert"></small>`;
  }
  const value = actuator.travelMm ?? DEFAULT_ACTUATOR_TRAVEL_MM;
  return `<div class="design-travel-input"><input type="number" min="${MIN_ACTUATOR_TRAVEL_MM}" max="${MAX_ACTUATOR_TRAVEL_MM}" step="0.1" inputmode="decimal" data-actuator="${index}" data-key="travelMm" aria-label="${escapeHtml(actuator.name)}行程（毫米）" value="${value}"><span>mm</span></div><small data-motion-status="${index}">${actuatorTravelSourceLabel(actuator)}</small><small class="design-travel-error" data-motion-error="${index}" role="alert"></small>`;
}
