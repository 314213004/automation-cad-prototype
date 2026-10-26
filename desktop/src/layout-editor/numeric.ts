/**
 * 整机布局编辑：拖动中键盘精确输入（纯函数）。
 *
 * 约定（与常见 DCC 工具一致）：
 * - 拖动轴/平面时直接键入数字 = 相对拖动起点的位移（mm）或转角（°），回车确认、Esc 取消；
 * - 以 `=` 开头 = 绝对值（写入主数据的偏移 / 转角本身）；
 * - 平面拖动（XY）输入两个数，用逗号或空格分隔：`150,-20`；单轴只接受一个数。
 */
export interface LayoutPose {
  xMm: number;
  yMm: number;
  rotationZDeg: number;
}

export type NumericEntry = { kind: 'delta' | 'absolute'; values: number[] };
export type NumericParse = { ok: true; entry: NumericEntry } | { ok: false; error: string };

/** 拖动手柄：X/Y/XY 平移，Z 为绕 Z 旋转。 */
export type DragHandle = 'X' | 'Y' | 'XY' | 'RZ';

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const MAX_ABS = 1_000_000;

export function parseNumericEntry(text: string): NumericParse {
  let body = text.trim();
  if (!body) return { ok: false, error: '请输入数值' };
  let kind: NumericEntry['kind'] = 'delta';
  if (body.startsWith('=')) {
    kind = 'absolute';
    body = body.slice(1).trim();
  }
  const tokens = body.split(/[\s,，]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 2) return { ok: false, error: '最多输入两个数（X,Y）' };
  const values: number[] = [];
  for (const token of tokens) {
    if (!NUMBER.test(token)) return { ok: false, error: `「${token}」不是有效数字` };
    const value = Number(token);
    if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS) return { ok: false, error: `「${token}」超出允许范围` };
    values.push(value);
  }
  return { ok: true, entry: { kind, values } };
}

/** 键盘缓冲：只接受数字、小数点、正负号、等号、逗号/空格与退格。返回 null 表示该键不属于数值输入。 */
export function appendNumericKey(buffer: string, key: string): string | null {
  if (key === 'Backspace') return buffer.slice(0, -1);
  if (key.length !== 1) return null;
  if (/[0-9.+\-=, ]/.test(key)) {
    if (key === '=' && buffer.length > 0) return buffer;
    if (buffer.length >= 40) return buffer;
    return buffer + key;
  }
  return null;
}

/** 把数值输入应用到拖动起点位姿，得到新位姿；输入与手柄不匹配时返回错误。 */
export function applyNumericEntry(
  entry: NumericEntry,
  handle: DragHandle,
  start: LayoutPose
): { ok: true; pose: LayoutPose } | { ok: false; error: string } {
  const pose = { ...start };
  const [a, b] = entry.values as [number, number | undefined];
  if (handle === 'XY') {
    if (b === undefined) return { ok: false, error: '平面拖动请输入两个数：X,Y' };
    pose.xMm = entry.kind === 'delta' ? start.xMm + a : a;
    pose.yMm = entry.kind === 'delta' ? start.yMm + b : b;
  } else {
    if (b !== undefined) return { ok: false, error: '单轴拖动只接受一个数' };
    if (handle === 'X') pose.xMm = entry.kind === 'delta' ? start.xMm + a : a;
    else if (handle === 'Y') pose.yMm = entry.kind === 'delta' ? start.yMm + a : a;
    else pose.rotationZDeg = entry.kind === 'delta' ? start.rotationZDeg + a : a;
  }
  const round = (value: number): number => {
    const rounded = Math.round(value * 1000) / 1000;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  return { ok: true, pose: { xMm: round(pose.xMm), yMm: round(pose.yMm), rotationZDeg: round(pose.rotationZDeg) } };
}

/** HUD 文案：拖动中实时显示位移与绝对值。 */
export function formatDragReadout(handle: DragHandle, start: LayoutPose, current: LayoutPose, buffer = ''): string {
  const n = (value: number): string => (Math.round(value * 100) / 100).toString();
  const typed = buffer ? ` · 输入：${buffer}▌（回车确认 / Esc 取消）` : ' · 可直接键入数值';
  if (handle === 'RZ') {
    return `旋转 Δ${n(current.rotationZDeg - start.rotationZDeg)}° → RZ ${n(current.rotationZDeg)}°${typed}`;
  }
  const dx = current.xMm - start.xMm;
  const dy = current.yMm - start.yMm;
  if (handle === 'X') return `X Δ${n(dx)} mm → X ${n(current.xMm)} mm${typed}`;
  if (handle === 'Y') return `Y Δ${n(dy)} mm → Y ${n(current.yMm)} mm${typed}`;
  return `Δ(${n(dx)}, ${n(dy)}) mm → (${n(current.xMm)}, ${n(current.yMm)}) mm${typed}`;
}
