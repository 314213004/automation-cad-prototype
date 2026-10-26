// 转接板防破孔校核与策略选择（P0，见架构文档第 12.1 节）
//
// 纯函数，不依赖 DOM / Electron，可直接跑 Node 单测。
// 与文档原稿的两处修正（不要照抄原稿）：
//   1. 原稿有一行无意义的 requiredRadiusSum 计算（boltSize.slice(1) 当数字用），
//      已删除；孔壁净距只用 centerDist - (cboreDia/2 + tapMinorDia/2)。
//   2. 原稿 M5 沉头直径写 9.5mm，与仓库既有 ISO 4762 表（adapter-model.ts：M5 头部 8.5mm）
//      不一致；这里统一用仓库既有表，见 holePatternFromMountPort。
// 假设：两端孔系均为 2×2 矩形阵列（pitchXMm / pitchYMm > 0）；
// 单中心孔（两端 pitch 均为 0）是同心通孔/螺纹孔，不按孔壁净距判，直接走平板通孔。

export type BoltSize = 'M3' | 'M4' | 'M5' | 'M6' | 'M8';

export interface HolePatternSpec {
  portId: string;
  boltSize: BoltSize;
  /** 通孔直径 mm（如 M5 -> 5.5）。 */
  throughDiaMm: number;
  /** 沉头直径 mm（如 M5 -> 8.5，按仓库 ISO 4762 表）。 */
  cboreDiaMm: number;
  /** 沉头深度 mm（如 M5 -> 5）。 */
  cboreDepthMm: number;
  /** 螺纹底孔直径 mm（如 M5 -> 4.2）。 */
  tapMinorDiaMm: number;
  /** X 向孔距 mm；单孔时取 0。 */
  pitchXMm: number;
  /** Y 向孔距 mm；单孔时取 0。 */
  pitchYMm: number;
  /** 安装面法向量（不必单位化，点积只判正交与否）。 */
  normal: [number, number, number];
}

export type AdapterStrategy =
  | { kind: 'flat_through'; thicknessMm: number; offsetMm: [number, number] }
  | { kind: 'flat_blind_thick'; thicknessMm: number; blindDepthMm: number }
  | { kind: 'flat_offset'; thicknessMm: number; offsetMm: [number, number] }
  | { kind: 'l_bracket_gusset'; thicknessMm: number; flangeHeightMm: number };

export const MIN_WALL_MM = 2.5;

const SCREW_TABLE: Record<BoltSize, { throughDiaMm: number; cboreDiaMm: number; cboreDepthMm: number; tapMinorDiaMm: number }> = {
  M3: { throughDiaMm: 3.5, cboreDiaMm: 5.5, cboreDepthMm: 3, tapMinorDiaMm: 2.46 },
  M4: { throughDiaMm: 4.5, cboreDiaMm: 7, cboreDepthMm: 4, tapMinorDiaMm: 3.3 },
  M5: { throughDiaMm: 5.5, cboreDiaMm: 8.5, cboreDepthMm: 5, tapMinorDiaMm: 4.2 },
  M6: { throughDiaMm: 6.6, cboreDiaMm: 10, cboreDepthMm: 6, tapMinorDiaMm: 5 },
  M8: { throughDiaMm: 9, cboreDiaMm: 13, cboreDepthMm: 8, tapMinorDiaMm: 6.8 }
};

function assertPositive(value: number, name: string): void {
  if (!(value > 0)) throw new Error(`${name}必须大于 0`);
}

/** 由仓库既有 MountPort 形状（pitch / holeDia）+ 螺栓规格，推导 HolePatternSpec。 */
export function holePatternFromMountPort(
  port: { pitchXMm: number; pitchYMm: number; holeDiaMm: number },
  boltSize: BoltSize,
  normal: [number, number, number],
  portId: string
): HolePatternSpec {
  const spec = SCREW_TABLE[boltSize];
  if (!spec) throw new Error(`不支持的螺栓规格：${boltSize}`);
  if (!(port.pitchXMm >= 0 && port.pitchYMm >= 0)) throw new Error('孔距不能为负');
  return {
    portId,
    boltSize,
    throughDiaMm: port.holeDiaMm > 0 ? port.holeDiaMm : spec.throughDiaMm,
    cboreDiaMm: spec.cboreDiaMm,
    cboreDepthMm: spec.cboreDepthMm,
    tapMinorDiaMm: spec.tapMinorDiaMm,
    pitchXMm: port.pitchXMm,
    pitchYMm: port.pitchYMm,
    normal
  };
}

function holeCenters(pattern: HolePatternSpec): Array<[number, number]> {
  if (pattern.pitchXMm === 0 && pattern.pitchYMm === 0) return [[0, 0]];
  return [
    [-pattern.pitchXMm / 2, -pattern.pitchYMm / 2],
    [pattern.pitchXMm / 2, -pattern.pitchYMm / 2],
    [-pattern.pitchXMm / 2, pattern.pitchYMm / 2],
    [pattern.pitchXMm / 2, pattern.pitchYMm / 2]
  ];
}

export function planAdapterGeometry(
  parentPort: HolePatternSpec,
  childPort: HolePatternSpec
): { strategy: AdapterStrategy; minClearanceMm: number } {
  assertPositive(parentPort.cboreDiaMm, '母件沉头直径');
  assertPositive(parentPort.throughDiaMm, '母件通孔直径');
  assertPositive(childPort.tapMinorDiaMm, '子件螺纹底孔直径');

  // 1. 法向量近似正交 -> 90° L 型带肋角座（文档 12.1 规则，|dot| < 0.15）
  const dot =
    parentPort.normal[0] * childPort.normal[0] +
    parentPort.normal[1] * childPort.normal[1] +
    parentPort.normal[2] * childPort.normal[2];
  if (Math.abs(dot) < 0.15) {
    return {
      strategy: {
        kind: 'l_bracket_gusset',
        thicknessMm: 12,
        flangeHeightMm: Math.max(childPort.pitchYMm + 30, 75)
      },
      minClearanceMm: 999
    };
  }

  // 2. 两端均为单中心孔：同心孔系，不按孔壁净距判。
  if (
    parentPort.pitchXMm === 0 && parentPort.pitchYMm === 0 &&
    childPort.pitchXMm === 0 && childPort.pitchYMm === 0
  ) {
    return {
      strategy: { kind: 'flat_through', thicknessMm: 12, offsetMm: [0, 0] },
      minClearanceMm: 999
    };
  }

  // 3. 平行安装面：母件沉头孔与子件螺纹孔之间的最小孔壁净距
  const pHoles = holeCenters(parentPort);
  const cHoles = holeCenters(childPort);
  let minWall = Infinity;
  for (const [px, py] of pHoles) {
    for (const [cx, cy] of cHoles) {
      const centerDist = Math.hypot(px - cx, py - cy);
      const wall = centerDist - (parentPort.cboreDiaMm / 2 + childPort.tapMinorDiaMm / 2);
      if (wall < minWall) minWall = wall;
    }
  }

  // 情况 A：孔壁距充足 -> 标准 12mm 平板
  if (minWall >= MIN_WALL_MM) {
    return {
      strategy: { kind: 'flat_through', thicknessMm: 12, offsetMm: [0, 0] },
      minClearanceMm: Number(minWall.toFixed(2))
    };
  }

  // 情况 B：沉头孔与螺纹孔局部干涉，但通孔柱面未穿透 -> 加厚至 18mm，正反不贯通盲孔
  const shankWall = minWall + (parentPort.cboreDiaMm - parentPort.throughDiaMm) / 2;
  if (shankWall >= MIN_WALL_MM) {
    return {
      strategy: { kind: 'flat_blind_thick', thicknessMm: 18, blindDepthMm: 10 },
      minClearanceMm: Number(shankWall.toFixed(2))
    };
  }

  // 情况 C：孔距高度重合 -> 沿 Y 轴偏置错位 16mm，板厚 14mm
  return {
    strategy: { kind: 'flat_offset', thicknessMm: 14, offsetMm: [0, 16] },
    minClearanceMm: Number(minWall.toFixed(2))
  };
}
