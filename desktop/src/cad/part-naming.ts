// 导入模型零件命名
//
// 背景：STEP 按实体拆件已经没问题（occt-import-js 每个 solid 一个网格），但很多模型导出时
// 实体名是 COMPOUND / SOLID / Part 这类通用名，甚至全空。直接拿来当零件名会导致：
//   - 左侧结构树 94 行全叫 COMPOUND，认不出是哪个件；
//   - 存为工程时 partsList 变成 COMPOUND、COMPOUND-2…，下次打开还是认不出。
//
// 这里只做「名字不可用时用可核对的信息替代」：序号 + 包围盒尺寸。**不猜语义**
// （不写"立柱/托条"——那需要结构信息，猜就是编数据）。

export interface NamedBox {
  name: string;
  sizeMm: [number, number, number];
}

/** 通用/无意义名：COMPOUND、SOLID、Part12、未命名、空串等。 */
const GENERIC = /^(?:(?:compound|solid|shell|body|part|mesh|unnamed|feature|result)(?:[-_ ]?\d+)?|实体|零件|未命名)$/i;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isGeneric(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === '' || GENERIC.test(trimmed.replace(/\s+/g, ''));
}

/**
 * 给一批网格名 + 尺寸生成可读零件名：
 * - 名字可用 → 保留原名（重复时加 -2/-3）
 * - 名字是通用名/空 → `零件-NN（W×D×H）`，尺寸来自该网格自身包围盒
 * 编号从 1 开始，补齐两位，保证树里顺序稳定。
 */
export function readablePartNames(boxes: readonly NamedBox[]): string[] {
  const used = new Map<string, number>();
  const unique = (base: string): string => {
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
  return boxes.map((box, index) => {
    const raw = (box.name ?? '').trim();
    if (!isGeneric(raw)) return unique(raw);
    const [w, d, h] = box.sizeMm.map(round1);
    return unique(`零件-${String(index + 1).padStart(2, '0')}（${w}×${d}×${h}）`);
  });
}

/** 供测试与调用方判断：这个名字是否属于「需要替换」的通用名。 */
export function isGenericPartName(name: string): boolean {
  return isGeneric(name);
}
