import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RENDER_QUALITY,
  normalizeRenderQuality,
  type RenderQuality
} from '../orbit/quality.ts';

export interface AppearanceConfig {
  uiScale: number;
  renderQuality: RenderQuality;
}

export const APPEARANCE_FILENAME = 'appearance.json';

/** 根样式固定 px，缩放档位必须保持有限集合，避免用户输入任意值导致布局失控。 */
export const UI_SCALE_VALUES = [1, 1.1, 1.15, 1.25, 1.4, 1.5] as const;

export const DEFAULT_UI_SCALE = 1.15;

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = Object.freeze({
  uiScale: DEFAULT_UI_SCALE,
  renderQuality: DEFAULT_RENDER_QUALITY
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非法/缺失缩放值统一回落 1.15（新默认）。 */
export function normalizeUiScale(value: unknown): number {
  return typeof value === 'number' && (UI_SCALE_VALUES as readonly number[]).includes(value)
    ? value
    : DEFAULT_UI_SCALE;
}

export function appearanceConfigPath(userDataDir: string): string {
  return join(userDataDir, APPEARANCE_FILENAME);
}

export function normalizeAppearanceConfig(value: unknown): AppearanceConfig {
  const source = isRecord(value) ? value : {};
  return {
    uiScale: normalizeUiScale(source.uiScale),
    renderQuality: normalizeRenderQuality(source.renderQuality)
  };
}

/** 读取 userData/appearance.json；缺失或损坏时使用安全默认值。 */
export function readAppearanceConfig(userDataDir: string): AppearanceConfig {
  const file = appearanceConfigPath(userDataDir);
  if (!existsSync(file)) return { ...DEFAULT_APPEARANCE_CONFIG };
  try {
    return normalizeAppearanceConfig(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

/** 原子写入（0600），与 agent-llm.json 使用同一套临时文件 + rename 方式。 */
export function writeAppearanceConfig(userDataDir: string, config: unknown): AppearanceConfig {
  const normalized = normalizeAppearanceConfig(config);
  mkdirSync(userDataDir, { recursive: true });
  const file = appearanceConfigPath(userDataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`保存界面配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

/** 设置页只提交部分字段时，保留未提交项。 */
export function mergeAppearanceConfig(existing: AppearanceConfig, patch: unknown): AppearanceConfig {
  const source = isRecord(patch) ? patch : {};
  return normalizeAppearanceConfig({
    uiScale: source.uiScale === undefined ? existing.uiScale : source.uiScale,
    renderQuality: source.renderQuality === undefined ? existing.renderQuality : source.renderQuality
  });
}

