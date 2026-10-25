/** 客户端像素 → WebGL NDC。必须使用 getBoundingClientRect()，不能除以布局宽高：CSS zoom 后两者不相等。 */
export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 按下时的指针状态。 */
export interface PointerDownState {
  x: number;
  y: number;
  button: number;
}

/** 点击选中允许的最大位移（CSS px）；超过就按拖拽旋转处理，不触发选中。 */
export const CLICK_SELECT_MAX_DISTANCE = 4;

/**
 * 抬起时是否算「点击选中」。
 *
 * 注意：判定必须依赖按下时记录的 down 状态。窗口级兜底监听（pointerup/pointercancel/blur）
 * 不能在画布内的抬起之前清空它，否则点击选中会整体失效而悬停高亮照常 —— 曾经的线上症状。
 */
/**
 * 僵死拖动的判定：标记为拖动中，但没有任何按键按下的指针状态。
 *
 * OrbitControls 一旦漏掉一次 pointerup，内部状态就永久停在 ROTATE —— 表现是按住拖动没反应、
 * 滚轮被忽略、不按键移动鼠标画面却一直转。这里给出可判定的条件，让视图层主动自愈。
 */
export function isStaleDrag(dragging: boolean, hasActivePointer: boolean): boolean {
  return dragging && !hasActivePointer;
}

export function isClickSelect(
  down: PointerDownState | null,
  up: { clientX: number; clientY: number; button: number }
): boolean {
  if (!down || down.button !== 0 || up.button !== 0) return false;
  return Math.hypot(up.clientX - down.x, up.clientY - down.y) <= CLICK_SELECT_MAX_DISTANCE;
}

export function clientPointToNdc(
  clientX: number,
  clientY: number,
  rect: ClientRectLike
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1
  };
}
