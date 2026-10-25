/** 客户端像素 → WebGL NDC。必须使用 getBoundingClientRect()，不能除以布局宽高：CSS zoom 后两者不相等。 */
export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
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
