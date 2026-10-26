/**
 * 整机布局编辑：吸附计算（纯函数，无 DOM / three）。
 *
 * - 网格吸附作用在「主数据值」上：工位位姿 xMm/yMm 是相对规则引擎原始位置的偏移，
 *   吸附后写回的就是 1/5/10/50 mm 的整数倍，属性面板与 design.json 里看到的也是这个数。
 * - 角度吸附作用在工位 rotationZDeg（15° / 90°）。
 * - 特征吸附：移动对象的 XY 包络（左/中/右、前/中/后）对齐其它工位或机架零件的同类特征，
 *   命中时覆盖该轴的网格吸附，并给出参考线。几何里没有安装孔/端口数据（MountPort 属于
 *   src/canvas 的节点拓扑，不在 MachineGeometry 中），因此不做孔位吸附。
 */

export const GRID_STEPS_MM = [1, 5, 10, 50] as const;
export const ANGLE_STEPS_DEG = [15, 90] as const;

export interface Rect2 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface SnapTarget {
  id: string;
  label: string;
  rect: Rect2;
}

export interface SnapGuide {
  /** 'x' = 竖直参考线（x = value）；'y' = 水平参考线（y = value） */
  axis: 'x' | 'y';
  value: number;
  /** 参考线沿另一轴的起止（覆盖移动对象与目标） */
  from: number;
  to: number;
  feature: 'min' | 'center' | 'max';
  targetId: string;
  targetLabel: string;
}

export interface FeatureSnapResult {
  dx: number;
  dy: number;
  snappedX: boolean;
  snappedY: boolean;
  guides: SnapGuide[];
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** 按步长吸附；步长 ≤ 0 或非有限时原样返回（吸附关闭）。 */
export function snapToStep(value: number, step: number): number {
  if (!Number.isFinite(value)) throw new Error('吸附输入必须是有限数值');
  if (!Number.isFinite(step) || step <= 0) return clean(value);
  return clean(Math.round(value / step) * step);
}

/** 角度吸附到步长并归一到 (-180, 180]。 */
export function snapAngleDeg(value: number, step: number): number {
  const snapped = snapToStep(value, step);
  let deg = snapped % 360;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return clean(deg);
}

export function translateRect(rect: Rect2, dx: number, dy: number): Rect2 {
  return { minX: rect.minX + dx, maxX: rect.maxX + dx, minY: rect.minY + dy, maxY: rect.maxY + dy };
}

function features(rect: Rect2, axis: 'x' | 'y'): Array<{ feature: 'min' | 'center' | 'max'; value: number }> {
  const min = axis === 'x' ? rect.minX : rect.minY;
  const max = axis === 'x' ? rect.maxX : rect.maxY;
  return [
    { feature: 'min', value: min },
    { feature: 'center', value: (min + max) / 2 },
    { feature: 'max', value: max }
  ];
}

/**
 * 把移动对象的包络特征吸附到最近的目标特征（每轴独立，只取距离 ≤ tolerance 的最近一个）。
 * 返回需要额外施加的 dx/dy 与参考线；同距离时优先边（min/max）再中心，结果确定。
 */
export function featureSnap(moving: Rect2, targets: readonly SnapTarget[], toleranceMm: number): FeatureSnapResult {
  const result: FeatureSnapResult = { dx: 0, dy: 0, snappedX: false, snappedY: false, guides: [] };
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || targets.length === 0) return result;
  for (const axis of ['x', 'y'] as const) {
    let best: { delta: number; value: number; feature: 'min' | 'center' | 'max'; target: SnapTarget } | null = null;
    for (const target of targets) {
      for (const own of features(moving, axis)) {
        for (const other of features(target.rect, axis)) {
          const delta = other.value - own.value;
          const distance = Math.abs(delta);
          if (distance > toleranceMm) continue;
          const better = !best || distance < Math.abs(best.delta) - 1e-9 ||
            (Math.abs(distance - Math.abs(best.delta)) <= 1e-9 && own.feature !== 'center' && best.feature === 'center');
          if (better) best = { delta, value: other.value, feature: own.feature, target };
        }
      }
    }
    if (!best) continue;
    const shifted = axis === 'x' ? translateRect(moving, best.delta, 0) : translateRect(moving, 0, best.delta);
    const from = axis === 'x' ? Math.min(shifted.minY, best.target.rect.minY) : Math.min(shifted.minX, best.target.rect.minX);
    const to = axis === 'x' ? Math.max(shifted.maxY, best.target.rect.maxY) : Math.max(shifted.maxX, best.target.rect.maxX);
    result.guides.push({ axis, value: clean(best.value), from: clean(from), to: clean(to), feature: best.feature, targetId: best.target.id, targetLabel: best.target.label });
    if (axis === 'x') { result.dx = clean(best.delta); result.snappedX = true; }
    else { result.dy = clean(best.delta); result.snappedY = true; }
  }
  return result;
}

export interface TranslationSnapInput {
  /** 拖动开始时主工位的偏移（主数据值） */
  startX: number;
  startY: number;
  /** 拖动产生的原始偏移（未吸附） */
  rawX: number;
  rawY: number;
  /** 0 = 关闭网格吸附 */
  gridMm: number;
  /** 只允许沿某轴移动时锁定另一轴（拖 X 轴箭头时 Y 保持 startY） */
  lockX?: boolean;
  lockY?: boolean;
  /** 主工位在拖动开始时的 XY 包络；提供 targets 时启用特征吸附 */
  startRect?: Rect2;
  targets?: readonly SnapTarget[];
  toleranceMm?: number;
}

export interface TranslationSnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
  /** 每轴实际采用的吸附来源 */
  source: { x: 'feature' | 'grid' | 'none' | 'locked'; y: 'feature' | 'grid' | 'none' | 'locked' };
}

/** 平移吸附流水线：特征吸附优先，其次网格；锁定轴保持起始值。 */
export function snapTranslation(input: TranslationSnapInput): TranslationSnapResult {
  let x = input.lockX ? input.startX : input.rawX;
  let y = input.lockY ? input.startY : input.rawY;
  const source: TranslationSnapResult['source'] = {
    x: input.lockX ? 'locked' : 'none',
    y: input.lockY ? 'locked' : 'none'
  };
  let guides: SnapGuide[] = [];
  if (input.startRect && input.targets && input.targets.length > 0 && (input.toleranceMm ?? 0) > 0) {
    const moved = translateRect(input.startRect, x - input.startX, y - input.startY);
    const snap = featureSnap(moved, input.targets, input.toleranceMm ?? 0);
    if (snap.snappedX && !input.lockX) { x += snap.dx; source.x = 'feature'; }
    if (snap.snappedY && !input.lockY) { y += snap.dy; source.y = 'feature'; }
    guides = snap.guides.filter((guide) => (guide.axis === 'x' ? !input.lockX : !input.lockY));
  }
  if (input.gridMm > 0) {
    if (source.x === 'none') { x = snapToStep(x, input.gridMm); source.x = 'grid'; }
    if (source.y === 'none') { y = snapToStep(y, input.gridMm); source.y = 'grid'; }
  }
  return { x: clean(x), y: clean(y), guides, source };
}
