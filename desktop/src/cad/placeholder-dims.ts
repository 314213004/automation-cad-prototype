// 插入元器件时的占位盒尺寸：优先用数据包里的真实外形（mm），缺项才退回 20mm 小方块。
//
// 背景：addPlaceholderPart 以前固定 20×20×20，插一个 20mm 气缸和一个 200mm 输送段看起来一模一样，
// 在 3D 里判断不了比例，也容易被当成真实外形。这里统一做校验与回落，viewer 只负责建几何。

export interface PlaceholderDimsMm {
  w: number;
  h: number;
  d: number;
}

/** 缺尺寸时的占位边长（mm）。与旧行为一致，避免突然出现巨大方块。 */
export const PLACEHOLDER_FALLBACK_MM = 20;

/** 上限：超过 20m 的外形按「数据可疑」处理，不拿来建盒子。 */
export const PLACEHOLDER_MAX_MM = 20_000;

function usable(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > PLACEHOLDER_MAX_MM) return null;
  return value;
}

/**
 * 解析占位盒尺寸。
 * - 轴映射：w → X（横向）、h → Y（高度）、d → Z（纵深），单位 mm
 * - 缺项 / 非法值逐轴回落到 20mm，不整体放弃（避免一个坏字段导致完全没盒子）
 * - `sized` 只在三轴都来自真实外形时为 true，界面可据此标注「按外形尺寸」
 */
export function resolvePlaceholderDims(dims?: Partial<PlaceholderDimsMm> | null): {
  dims: PlaceholderDimsMm;
  sized: boolean;
} {
  const w = usable(dims?.w);
  const h = usable(dims?.h);
  const d = usable(dims?.d);
  return {
    dims: {
      w: w ?? PLACEHOLDER_FALLBACK_MM,
      h: h ?? PLACEHOLDER_FALLBACK_MM,
      d: d ?? PLACEHOLDER_FALLBACK_MM
    },
    sized: w !== null && h !== null && d !== null
  };
}
