# cost · 机台硬件成本统计

价格簿 → BOM → 计算引擎 → 面板 / 报告（A4 PDF） / CSV / Agent 工具。全部为纯函数 + 一个注入式面板，不改原型文件。

## 文件

| 文件 | 职责 |
|------|------|
| `defaults.ts` | 工程默认值（价格时效 180 天、线缆折损 1.35、人工/辅材费率），单测锁定公式 |
| `pricebook.ts` | 价格簿校验（时区日期、币种、阶梯价、费率）、`parsePricebook`、`isUsablePricebookItem`（示例条目不计价） |
| `engine.ts` | `computeCost`：物料定价 → 人工 / 辅材 → 加成 / 税 / 运费；`CostReport` 是唯一数据源 |
| `report.ts` | `renderCostReportHtml`（A4 纵向）、`costReportCsv`（UTF-8 BOM，明细 + 汇总 + 缺价 + 告警四块）、`describeCost`、`money` |
| `agent.ts` | `computeCostReport`：取数/校验/计算的唯一入口；`runCostTool` 输出 Agent 只读窄结果（明细 50 行、缺价/告警 20 条） |
| `export.ts` | `planExportName`（净化/扩展名强制/≤80 字符/冲突序号/目录限定）与 `buildCostExport`（PDF/CSV 渲染 + 可注入落盘桥），Agent 导出纯逻辑 |
| `ui.ts` | 顶栏「成本估算」入口 + 抽屉面板 + `window.__CostPanel` 脚本接口 |

## 数据结构

```ts
CostInput  { bom, placements?, plate?, plc?, pricebook, overrides?, options?, now?, wireSection? }
CostBomRow { partId?, name, model?, category?, spec?, specs?, qty, terminationPoints?, assemblyMinutesPerUnit? }
CostReport { lines, byCategory, missing, labor, extras, totals, warnings }
CostToolResult { bomSource, bomRows, pricebook{label,usableItems,exampleItems}, totals, labor, extras, byCategory, counts, lines, missing, warnings, truncated, notes, summary }
CostExportSuccess { ok, path, bytes, format, lines, grand }
PlanExportNameOptions { directory, format, fileName?, suggestedName?, overwrite?, exists?, maxLength? }
```

价格优先级：`overrides` > 用户价格簿 > 内置价格簿 > 缺价（进 `missing`，不写成 0）。示例条目（`example: true` 或 `source === '示例，需替换'`）不参与计价。

## 面板行为

- 入口：顶栏「成本估算」；`window.__CostPanel.open()` 亦可。
- 价格簿来源：导入 JSON 文件 → `__CostPricebookProvider` → 主进程 IPC `cost:pricebook`（读 `packs/builtin/pricebook-cn/pricebook.json`）。内置价格簿只有示例条目，面板会显示「示例 N 条（不计价）」并提示替换，不会伪造价格。
- BOM 来源：`api.setBom()` / 导入 BOM JSON（`{bom, placements, plate, plc, options, wireSection}` 或纯数组）→ `__CostBomProvider`。
- 参数：加成率 %、税率 %、运费、线缆截面（mm²），改后重算即生效，不写回价格簿。
- 导出：PDF 走 `desktop.exportReport({ page: { size: 'A4', landscape: false } })`；CSV 走 `desktop.exportFile`（系统保存对话框，桌面版）。
- 缺价 / 告警单独成块，不混进合计；缺价时合计会明确偏低并在状态栏标红。

## Agent 工具 `run_cost_report`（只读）

- 入口：`agent.ts` 的 `runCostTool(args, deps)`；命令总线 `run_cost_report` 负责取场景 BOM，主进程注入 `loadBuiltinPricebook`。
- 入参：`bom?`（不给则用当前场景 BOM）、`pricebook?`、`placements?`、`plate?`、`plc?`、`options?`、`overrides?`、`wireSection?`、`now?`。
- 出参：`totals / labor / extras / byCategory / counts / notes / summary`，明细最多 50 行、缺价与告警各 20 条（超出只给数量并置 `truncated: true`）。
- 只读：不写价格簿、不落盘、不进撤销栈；与面板共用同一个 `computeCost`，不会出现「面板一个数、Agent 另一个数」。
- 诚实性：场景 BOM 的零件没有 `partId`，一律进 `missing`（`NO_PART_ID`）并在 `notes` 说明，绝不按 0 计入合计；内置价格簿全为示例条目时也会在 `notes` 提示。

## Agent 导出 `export_cost_report`（写）

- 入口：`export.ts` 的 `buildCostExport(args, deps)`；命令总线 `export_cost_report` 负责取场景 BOM/项目名，主进程注入 `renderPdf` 与 `loadBuiltinPricebook`。
- 入参：`format`（必填 `pdf`/`csv`）、`fileName?`（不含扩展名）、`overwrite?`（默认 false）、其余同 `run_cost_report`。
- 落盘：IPC `export:costFile` 固定写 `join(app.getPath('userData'), 'exports')`，创建目录后由 `planExportName` 命名；不接受任意路径、不弹系统对话框。
- 命名：默认 `成本报告-<项目名或 device_no>-<yyyyMMdd-HHmm>.<ext>`；去掉 `/\:*?"<>|`、控制字符与首尾空白/点，最终 ≤80 字符；扩展名按 format 强制；`overwrite=false` 冲突时追加 ` (1)`、` (2)`…。
- 渲染：PDF 复用 `renderCostReportHtml`（A4 纵向）+ 主进程 `printToPDF`；CSV 复用 `costReportCsv`（UTF-8 BOM）。两者与 `run_cost_report` 共用 `computeCostReport`，数字同源。
- 返回：`{ok:true,path,bytes,format,lines,grand}`；失败 `DENIED` / `WRITE_FAILED` / `UNSUPPORTED_FORMAT`（缺 BOM/价格簿沿用可操作错误码）。
- 确认：`session.ts` 的 `MUTATING_TOOLS` 包含该工具，应用内对话执行前二次确认；MCP 写工具白名单同步。

## 验证命令

```bash
cd desktop
./node_modules/.bin/tsc --noEmit
npm test          # cost-engine / pricebook / cost-report / cost-agent / cost-export
npm run build:ext # smoke 跑 dist，改主进程/渲染层后必须重建
npm run smoke     # 断言 SMOKE_COST_OK / SMOKE_COST_AGENT_OK / SMOKE_COST_AGENT_EXPORT_OK / SMOKE_COST_UI_OK
```

实测（2026-10-23，P6-4）：`npm test` **439/439**；`SMOKE_COST_OK lines=6 missing=1 grand=1398.64`；`SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`；`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`；`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`。

## 坑点

1. **`npx tsc` 在 cron 里被安全扫描拦截**：直接用 `./node_modules/.bin/tsc`。
2. **smoke 读的是 `dist/` 与 `dist-electron/`**：只改源码不重建会“全绿但没生效”，必须先 `npm run build:ext`。
3. **`exportReport` 原来写死 A3 横向**：成本报告是 A4 纵向，已给 payload 增加可选 `page: { size, landscape }`，默认仍是 A3 横向（不影响电气/联调报告）。
4. **`exactOptionalPropertyTypes: true`**：`Partial<CostInput>` 的字段不能直接展开进 `CostInput`，要逐项判断后再赋值。
5. **CSV 必须带 UTF-8 BOM**，否则 Excel 打开中文乱码；金额用 `toFixed(2)` 不加千分位分隔符，便于二次计算。
6. **新增 Agent 工具要同步 4 处硬编码的工具数**：`test/agent/tools.test.mjs`（工具表）、`test/agent/mcp.test.mjs`、`test/agent/rpc.test.mjs`（tools.length 与 health.toolCount）、`electron/main.ts` 里的 `SMOKE_AGENT_TOOLS_OK` 断言；漏一处就是 9/10 不一致的失败。
7. **`run_cost_report` 与引擎的 `runCostReport` 不是同一个名字**：`engine.ts` 底部有 `export const runCostReport = computeCost` 的历史别名，工具层用 `runCostTool` 以免混淆。
8. **`export_cost_report` 的 PDF 字节必须走主进程打印**：渲染层只能拿到 `window.desktop.exportCostFile`，PDF 由注入的 `renderCostPdf` 生成后以 base64 过桥；不要尝试在渲染层用 DOM 打印。
9. **文件名净化与冲突策略只有 `planExportName` 一份实现**：IPC 与单测共用，避免「测试过了、落盘还带非法字符」。
