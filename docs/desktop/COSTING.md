# 机台硬件成本自动统计 · 设计方案

状态：设计完成，待实现（P6）
目标：从已有 BOM / 底板布置 / PLC 配置自动算出每台机台的硬件成本，单价可追溯、可覆盖、可导出。

## 1. 原则

1. **代码里不写死价格**。所有单价来自可替换的「价格簿」数据包，随元器件库一起版本化。
2. **缺价不猜**。查不到单价的物料单列「待询价」，不计入总额，报告里明确标注缺失数量。
3. **单价有来源和时间**。每条价格带 `source` 与 `updatedAt`，超过 180 天在报告里标「价格过期」。
4. **一份数据多处复用**：BOM、底板布置、PLC 模块、线缆估算都归到同一成本模型，不各算各的。

## 2. 数据层：价格簿数据包

位置：`packs/builtin/pricebook-cn/pricebook.json`（内置只读），用户包 `%APPDATA%/AutomationCAD/packs/pricebook-<corp>/` 可覆盖。

```json
{
  "schemaVersion": 1,
  "currency": "CNY",
  "updatedAt": "2026-10-23T00:00:00+08:00",
  "source": "2026 年公开渠道价，含税，未含项目折扣",
  "items": {
    "iC65N-C16-1P": {
      "list": 78.0,
      "tiers": [{ "minQty": 1, "price": 78.0 }, { "minQty": 10, "price": 68.0 }],
      "source": "施耐德 2026 价格表",
      "updatedAt": "2026-09-01T00:00:00+08:00"
    }
  },
  "labor": {
    "panelWiringPerPoint": 12.0,
    "terminalPerWire": 1.5,
    "assemblyHourly": 120.0
  },
  "accessories": {
    "dinRail35PerMeter": 18.0,
    "wireDuctPerMeter": 22.0,
    "wirePerMeter": { "1.5": 3.2, "2.5": 4.8, "4": 7.5 }
  }
}
```

规则：
- 价格查找顺序：项目覆盖 > 用户价格簿 > 内置价格簿 > 未命中（待询价）
- 阶梯价按 BOM 行数量取满足条件的最高 `minQty`
- 价格簿校验：`schemaVersion=1`、金额非负、`updatedAt` 带时区、`tiers` 的 `minQty` 递增

## 3. 计算引擎 `desktop/src/cost/engine.ts`（纯函数）

输入：

```ts
interface CostInput {
  bom: Array<{ partId?: string; name: string; spec?: string; qty: number }>;
  placements?: Placement[];          // 底板布置，用于线缆/导轨/线槽估算
  plate?: PlateSpec;
  plc?: { ioPoints: number; modules: Array<{ partId: string; qty: number }> };
  pricebook: Pricebook;
  overrides?: Record<string, number>; // 本次报价手工改价
  options?: { markupRate?: number; taxRate?: number; freight?: number };
}
```

输出：

```ts
interface CostReport {
  lines: CostLine[];       // partId/model/category/qty/unit/subtotal/priceSource/priceAgeDays
  byCategory: Array<{ category: string; subtotal: number; count: number }>;
  missing: Array<{ name: string; spec?: string; qty: number; reason: 'NO_PRICE' | 'NO_PART_ID' }>;
  labor: { wiring: number; terminals: number; assembly: number; total: number };
  extras: { dinRail: number; duct: number; wire: number };
  totals: { hardware: number; extras: number; labor: number; subtotal: number; markup: number; tax: number; freight: number; grand: number };
  warnings: string[];      // 价格过期、缺价、数量为 0
}
```

估算规则（全部写进单测，不允许「大概」）：
- 线缆长度：底板布置中相邻元件按曼哈顿距离 × 1.35 折损系数，单根最少 0.3 m，按截面分档计价
- 端子数量：每个元件接线点（`specs.接线点数`，缺失按 2）累加，按 `terminalPerWire` 计工
- 导轨：按底板导轨总长（`PlateSpec.rails` 累加，默认 2 × 底板宽）计米
- 线槽：底板宽 × 2 + 底板高 × 2（周长）估算
- 人工：`wiring = 接线点 × panelWiringPerPoint`，`assembly = 装配工时(默认 qty×3min) × assemblyHourly/60`
- 加成/税/运费：只在 `totals` 末尾加，不污染单行价格

## 4. 界面 `desktop/src/cost/ui.ts`

入口：电气域顶栏「成本」；或 CAD 覆盖层底部。

面板结构：
1. 顶部：项目名、机台编号（device_no）、价格簿选择、币种、报价日期
2. 统计卡：硬件小计 / 辅材 / 人工 / 含税总价 / 待询价行数
3. 明细表：分类、型号、数量、单价、小计、价格来源、价格年龄（>180 天标红）
4. 「待询价」区：缺价物料清单，可手工填价（写入本次 overrides，不落价格簿）
5. 操作：导出 CSV、导出 PDF（复用 A3 报告样式）、复制汇总文本

## 5. 与其他模块的关系

- **BOM 导出**：`export/bom.ts` 增加 `unitPrice/subtotal` 两列（有价时），保持原有列不变
- **Agent**：新增工具 `run_cost_report`（只读，返回 `CostReport` 摘要），自然语言「这台机台硬件成本多少」直接调用
- **智慧工厂同步**：manifest 增加可选 `cost: { grand, currency, pricedAt }`，服务端可落库做采购参考（需对方确认字段，先在文档标注「待对接」）
- **底板画布**：布置变化后成本面板显示「布置已变更，需重算」提示，不自动重算以免误改报价

## 6. 数据获取策略

- 首批价格：只填**可公开核实**的目录价（施耐德/西门子/正泰/明纬官方价目表或授权渠道公开报价），来源写进 `source`
- 不批量抓电商价（价格波动、含促销、不可追溯）
- 用户可在价格簿 UI 里批量导入 CSV：`partId,price,currency,source,updatedAt`

## 7. 验收

- 单测 ≥20：阶梯价、缺价、override 优先、线缆估算、端子/人工、税与加成、价格过期告警、空 BOM、qty=0 拒绝
- smoke：`SMOKE_COST_OK lines=6 missing=1 grand=1234.56`（固定 fixture）
- 报告 PDF 字段齐全，与面板数字一致（同一次计算的结果对象）
- 性能：500 行 BOM 计算 < 50 ms

## 8. 分期

- P6-1：价格簿格式 + 校验 + 计算引擎 + 单测（无 UI）
- P6-2：成本面板 + CSV/PDF 导出 + BOM 增列
- P6-3：Agent 工具 `run_cost_report` + 自然语言问答
- P6-4：与智慧工厂采购价字段对接（需对方确认）
