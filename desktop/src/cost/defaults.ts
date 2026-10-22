/**
 * 成本估算的工程默认值。
 *
 * 这里集中所有可调常量，便于单测锁定公式；默认费率只用于缺省估算，
 * 不是任何厂商的官方报价。
 */
export interface CostDefaults {
  /** 价格超过该天数在报告中告警 */
  priceMaxAgeDays: number;
  /** 线缆曼哈顿距离折损系数 */
  cableWasteFactor: number;
  /** 单根线缆最少长度（米） */
  minCableMeters: number;
  /** 元件未提供接线点数时的默认值 */
  defaultTerminationPoints: number;
  /** 装配工时（分钟/件） */
  assemblyMinutesPerUnit: number;
  /** 底板未提供导轨时的默认导轨数量 */
  defaultRailCount: number;
  /** 未指定线缆截面时使用的档位 */
  defaultWireSection: string;
  labor: {
    panelWiringPerPoint: number;
    terminalPerWire: number;
    assemblyHourly: number;
    source: string;
  };
  accessories: {
    dinRail35PerMeter: number;
    wireDuctPerMeter: number;
    wirePerMeter: Record<string, number>;
    source: string;
  };
}

export const DEFAULTS: CostDefaults = {
  priceMaxAgeDays: 180,
  cableWasteFactor: 1.35,
  minCableMeters: 0.3,
  defaultTerminationPoints: 2,
  assemblyMinutesPerUnit: 3,
  defaultRailCount: 2,
  defaultWireSection: '2.5',
  labor: {
    panelWiringPerPoint: 12,
    terminalPerWire: 1.5,
    assemblyHourly: 120,
    source: '工程默认值，非官方报价'
  },
  accessories: {
    dinRail35PerMeter: 18,
    wireDuctPerMeter: 22,
    wirePerMeter: { '1.5': 3.2, '2.5': 4.8, '4': 7.5 },
    source: '工程默认值，非官方报价'
  }
};
