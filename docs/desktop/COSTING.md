# 机台硬件成本自动统计 · 设计方案

状态：P6-1 引擎 ✅、P6-2 面板与导出 ✅、P6-3 Agent 工具 ✅（2026-10-23）
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

## 4. 界面 `desktop/src/cost/ui.ts`（已实现，P6-2）

入口：顶栏「成本估算」`costEntryButton`，抽屉 `costDrawer`。

已落地结构：
1. 状态行 `#costStatus`（`成本：合计 ¥x · 明细 n 行 · 缺价 m 项 · 警告 k 条`）与价格簿来源行 `#costSource`（来源 / 可用条数 / 示例条数 / 更新日期）
2. 参数区：加成率 %、税率 %、运费、线缆截面（mm²），改参数后重算即生效，不写回价格簿
3. 统计卡 9 张：硬件 / 辅材 / 人工 / 小计 / 加成 / 税金 / 运费 / 合计 / 缺价
4. 明细表：物料号、型号、分类、数量、单价、小计、价格来源与价格天数
5. 缺价与告警分块：缺价行标明 `NO_PRICE` / `NO_PART_ID`，缺价时状态行标红、合计明确偏低
6. 操作：计算成本、导入 BOM（JSON）、导入价格簿（JSON）、导出 PDF（A4 纵向）、导出 CSV（UTF-8 BOM）

数据来源：价格簿 = 导入文件 → `__CostPricebookProvider` → 主进程 `cost:pricebook`（内置 `packs/builtin/pricebook-cn`，只含示例条目，面板会提示需替换）；BOM = `setBom()` / 导入 JSON → `__CostBomProvider`。未注入时明确提示，不伪造数据。

## 4.1 报告与导出 `desktop/src/cost/report.ts`

- `renderCostReportHtml`：A4 纵向，五节（总价构成 / 硬件明细 / 分类小计 / 缺价清单 / 告警）+ 价格说明与页脚
- `costReportCsv`：`明细` / `汇总` / `缺价` / `告警` 四块，块间空行；金额两位小数不加千分位，便于二次计算
- `describeCost` / `money`：状态栏与报告共用同一格式化口径
- `exportReport` 增加可选 `page: { size: 'A3'|'A4', landscape }`，默认 A3 横向，成本报告传 A4 纵向

## 4.2 Agent 工具 `run_cost_report`（P6-3）

实现 `desktop/src/cost/agent.ts` + 命令总线 `run_cost_report`，MCP / JSON-RPC / 应用内对话共用同一份工具定义。

- **入参**：`bom?`（不给则取当前场景 BOM）、`pricebook?`（不给则读内置价格簿）、`placements?` / `plate?` / `plc?` / `options?` / `overrides?` / `wireSection?` / `now?`
- **出参**：`bomSource`、`bomRows`、`pricebook{label, usableItems, exampleItems}`、`totals / labor / extras / byCategory`、`counts{lines, missing, warnings}`、`lines`（≤50）、`missing`（≤20）、`warnings`（≤20）、`truncated`、`notes`、`summary`
- **只读**：不写价格簿、不落盘、不进撤销栈
- **诚实性**：显式 BOM 的 `partId` 缺失、价格簿未命中都会进 `missing` 并在 `notes` 写明「合计偏低，不要当作报价单」；场景 BOM 没有物料号时全部计入 `NO_PART_ID`，不会按 0 计价
- **错误码**：`INVALID_ARGUMENT`（带 `bom[0].qty` 这类行号）、`NO_BOM`、`PRICEBOOK_UNAVAILABLE`、`COST_FAILED`

自然语言「这台机台硬件成本多少」→ 模型调用该工具 → 用 `summary` 与 `totals` 复述，缺价时说明还需要哪些物料号。

## 5. 与其他模块的关系

- **BOM 导出**：`export/bom.ts` 增加 `unitPrice/subtotal` 两列（有价时），保持原有列不变
- **Agent**：`run_cost_report` 已实现（只读，返回 `CostReport` 窄摘要），自然语言「这台机台硬件成本多少」直接调用
- **智慧工厂同步**：manifest 增加可选 `cost: { grand, currency, pricedAt }`，服务端可落库做采购参考（需对方确认字段，先在文档标注「待对接」）
- **底板画布**：布置变化后成本面板显示「布置已变更，需重算」提示，不自动重算以免误改报价

## 6. 数据获取策略

- 首批价格：只填**可公开核实**的目录价（施耐德/西门子/正泰/明纬官方价目表或授权渠道公开报价），来源写进 `source`
- 不批量抓电商价（价格波动、含促销、不可追溯）
- 用户可在价格簿 UI 里批量导入 CSV：`partId,price,currency,source,updatedAt`

## 7. 验收（P6-3 实测）

- 单测 43 条引擎/价格簿 + 14 条报告（HTML/CSV）+ 12 条 Agent 工具（入参校验/场景 BOM/示例价/截断/命令透传），全套 `npm test` **413/413**
- smoke：`SMOKE_COST_OK lines=6 missing=1 grand=1398.64`（引擎 fixture）
- smoke：`SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`（命令总线 → 工具层，与引擎数字一致）
- smoke：`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`（面板：打开 → 载入价格簿 → 计算 → 9 卡 6 行 → A4 PDF 落盘；内置价格簿 IPC 返回 `exampleItems=4`）
- 报告、面板、Agent 三处数字同源（同一次 `computeCost` 结果对象），都断言合计 `1398.64`
- 性能：500 行 BOM < 50 ms（引擎单测已覆盖）

## 8. 分期

- P6-1：价格簿格式 + 校验 + 计算引擎 + 单测（无 UI）
- P6-2：成本面板 + CSV/PDF 导出 + BOM 增列
- P6-3：✅ Agent 工具 `run_cost_report`（2026-10-23）
- P6-4：与智慧工厂采购价字段对接（需对方确认）
