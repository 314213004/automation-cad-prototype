# 模块：无限画布工作台 · P1 核心逻辑（src/canvas/）

职责：把画布上的「节点 + 结构化端口」拓扑，变成可信的节拍、选型、成本与可交付文本。
纯函数、无 DOM、无 Electron、无三方依赖，可直接 `node --test` 跑。**不含任何 UI**（UI 是 P2 的 `canvas/workbench.ts`）。

规格书：`docs/desktop/CANVAS-WORKBENCH.md`（第 3 节是硬约束，第 6 节是验收口径）。
原型：`docs/desktop/mockups/canvas-workbench.html`（只参考交互，不照抄 CDN/假数据）。

## 文件分工

| 文件 | 作用 |
|------|------|
| `types.ts` | `MountPort` / `CanvasNode` / `CanvasEdge` / `MachineGraph` / `AdapterParams`，字段语义写在注释里 |
| `graph.ts` | `portsCompatible` / `portDiff` / `normalizeGraph` / `findMismatchedEdges` / `insertAdapterForEdge` / `insertAdaptersForAllMismatches` / `removeNode` / `graphConsistencyIssues` |
| `metrics.ts` | `graphFlowModel` + `machineMetrics`（CT 走 `evaluateFlow`）、`costSummary`（只认注入的价格查询）、`axisSizing`（梯形曲线） |
| `export.ts` | `buildMachineGraphJson`（稳定字段顺序）、`build123dScript`（文本）、`plcSt`（复用 plcgen）、`portReport` |
| `metrics.ts` 追加 | `screwSizing`（临界转速 / 欧拉压杆 / DN）、`railMomentCheck`（导轨三向倾覆力矩） |
| `view-model.ts` | 纯视图模型：拓扑布局、2D 正交投影、甘特、多口径画板、汇总、BOM 行、转接板默认工厂 |
| `workbench.ts` | P2 界面：入口按钮 + 全屏工作台，只做 DOM/事件，数值全交给 view-model |
| `canvas.css` | 工作台样式（深色工程界面，无 CDN / 无外链字体） |
| `demo-graph.ts` | 演示拓扑（6 节点 5 边，含 1 条真实端口不匹配）+ 通用模组库（无型号、无价格） |

## 数据结构与口径

```ts
interface MountPort { family; holeDiaMm; pitchXMm; pitchYMm; count }   // 全字段相等才算兼容
interface CanvasNode { id; kind; partId?; portIn; portOut; strokeMm; leadMm; massKg; stepSec; dimsMm; io; adapter?; adapterParams?; station?; pos; ortho }
interface CanvasEdge { id; from; to }
interface MachineGraph { schemeId; title?; nodes; edges; layout?; targetPerMin?; transferSeconds?; indexSeconds?; lanes? }
```

- 长度单位 **mm**（字段名带 `Mm`），质量 kg，时间 s，力矩 N·m。SI 换算只在 `metrics.ts` 公式内部发生，并就地注释。
- 端口兼容 = `family` + `holeDiaMm` + `pitchXMm` + `pitchYMm` + `count` **五项全等**；不做浮点容差（带容差会把 60 与 60.5 判成同一接口）。
- 每个 `adapter` 节点必须 1 进 1 出；`adapterParams` 带两端端口，是 build123d 生成请求的入参。
- 节点**不存单价**。金额只来自调用方注入的 `priceLookup(partId)`；缺 `partId` 或查不到 → `null` → 进「待询价」，总额标「不完全统计」。
- `stepSec` 只服务甘特图与单轴选型；整机 CT/UPH **只能**来自 `evaluateFlow`。

## 公式

单轴（梯形速度曲线，内部 SI）：

| 量 | 公式 |
|----|------|
| 分段时间 | `t_acc = ratio·t`，`t_const = t − 2·t_acc`，`ratio` 默认 0.25 |
| 最大线速度 | `v_max = s / (t_acc + t_const)` |
| 直线加速度 | `a = v_max / t_acc` |
| 电机转速 | `n_max = v_max/(lead/1000)×60`；`ω_max = n_max·2π/60`，`α = ω_max/t_acc` |
| 丝杠惯量 | `J_screw = (π/32)·ρ·L·D⁴`（钢 7850 kg/m³） |
| 负载惯量 | `J_load = m·(lead/2000π)² + J_screw`，`惯量比 = J_load/J_rotor` |
| 摩擦 | `F = μmg + F_seal`，`T_fric = F·(lead/1000)/(2πη)` |
| 扭矩 | `T_peak = (J_load+J_rotor)·α + T_fric`；`T_rms = √[(T_peak²·2t_acc + T_fric²·t_const)/t]` |
| 悬臂 | `δ = F·L³/(3EI)`，`I = w·h³/12`；`σ = F·L/W`，`W = w·h²/6` |

默认值全部可注入（`AxisSizingOptions`）：`η=0.9`、`μ=0.05`、`F_seal=10N`、`J_rotor=1.2e-5 kg·m²`（200–400W 伺服量级）、丝杠 `D=16mm`/`L=行程+100`、悬臂 `300mm`/`60×60`、`E=70GPa`、惯量比上限 10、挠度上限 0.05mm。

判定：`惯量比 ≤ 上限` 且 `挠度 ≤ 上限` 才 `pass`；`verdict` 用中文说明差在哪、怎么改。

## 坑点

1. **别拿 `ΣstepSec` 当 CT**。它只在 `single` 布局下恰好等于整机节拍；`dial`/`linear`/`parallel`/`cell` 会算错（测试里 dial 3 工位：Σ=1.2s，真实 CT=1.1s）。`graphFlowModel` 的缺省工位归集是「每个运动节点一个工位」，实际排布不同请在节点上写 `station`。
2. **同 family 不同孔距不是兼容**。原型的 `isPortCompatible` 只比字符串，是本模块第一个要修掉的假能力。
3. **插板不许挪坐标**。原型 `insertAdapterPlateForEdge` 会顺手 `toNode.x = max(...)` 并把下游再推 260px；本模块只新建 adapter 节点，其余坐标一律不动（有单测逐节点比对）。
4. **删转接板要恢复直连**。只清边会让「装配关系」从图上消失，用户以为问题解决了。`removeNode` 把上游→下游重新连成一条边，`findMismatchedEdges` 立刻重新标红；只剩一端的空转接板会被连带清理。
5. **价格一律外部注入**。`costSummary` 传 `undefined` 的 `priceLookup` 会直接抛中文错误，防止有人图省事塞个常量表。
6. **PLC ST 不硬凑**。画布节点只有 `io.di/io.do` 点数，没有点位地址；`plcSt` 无 `plcConfig` 时返回 `supported:false` + Graph JSON IR，有配置也先过 `plcgen/precheck`，有错就降级，绝不生成「看着像代码」的 ST。
7. **build123d 只出文本**。生成的是参数化脚本（孔位来自两端 `MountPort`），本模块不执行、不调 OCCT；节点占位体是 `Box`，不是真实零件外形。对外只说「仅参数」，别说「已建模」。
8. `normalizeGraph` 是深拷贝：返回的节点/端口都是新对象，调用方改返回值不会污染输入（有单测）。

## 进度

- ✅ `types.ts`：结构化端口、转接板参数、布局透传字段
- ✅ `graph.ts`：规范化（去重 id / 孤儿边 / 自环 / 重复连线）、全字段兼容判定、不匹配检测、插板（拆一为二 + 两端端口参数）、删节点（恢复直连 + 清理空转接板）、一键补齐（16 条单测）
- ✅ `metrics.ts`：`evaluateFlow` 口径 CT/UPH（dial/parallel/显式 flow 对照）、注入式成本与待询价、梯形曲线选型（14 条单测）
- ✅ `export.ts`：稳定字段顺序 Graph JSON、build123d 文本、plcgen 复用/降级、端口报告（9 条单测）
- ✅ P2：`canvas/workbench.ts` + `canvas.css`——拓扑（拖拽/选中/⚡ 插板）、2D 正交（mm 刻度/包络虚线）、多画板（single/linear/dial 真实评估）、Inspector 三页签、甘特（拖条改 stepSec）、导出预览（JSON/build123d/PLC）
- ✅ 扩充：`screwSizing`（n_cr / P_cr / DN）、`railMomentCheck`（M_pitch/M_roll/M_yaw）、干涉面板文案改为「AABB 初筛 / N 处疑似，需人工确认」
- ⏳ P3：候选来自 `design/synthesis`、元件来自 `packs`、价格来自 `pricebook-cn`
- ⏳ 转接板真实建模（build123d sidecar）、B-Rep 精确干涉

## 坑点（P2 追加）

9. **甘特是单步时间，不是产能**：甘特条相加（1.85s）和整机 CT（0.75s）本来就不等，界面上两处都写了口径；别为了「看着一致」把 KPI 改成 Σ。
10. **2D 俯视投影重叠 ≠ 干涉**：Y 轴压在 X 轴滑块上，俯视图必然重叠。文案统一写「平面投影重叠…（含叠层安装，非干涉结论）」，禁止出现「0 碰撞」。
11. **⚡ 按钮只在真正不匹配的边上出现**：匹配的边不渲染按钮；插板后按钮自动消失（`is-mismatch` 由 `portDiff` 决定）。
12. **多画板不是三套方案**：三块画板是同一张拓扑在 single/linear/dial 三种产能口径下的真实评估；候选方案要等 P3 接 `design/synthesis`，现在不伪造三套 BOM。
13. **默认转接板工厂价格恒为 null**：尺寸/质量可算（孔距 + 余量、体积×密度），价格必须询价；P2 没有接价格簿，所以 KPI 显示「¥0（N 项待询价）」是正确状态，不是 bug。

## 验证命令

```bash
cd desktop
npx tsc --noEmit                     # 0 错误
node --test test/canvas              # 本模块单测（P1 39 条 + P2 15 条 + metrics 追加 7 条）
npm test                             # 全量（基线只增不减）
npm run build:ext && npm run smoke   # 冒烟：SMOKE_CANVAS_TOPOLOGY_OK / _ADAPTER_OK / _ORTHO_OK / _EXPORT_OK
```

冒烟断言（必须在 `SMOKE_OK` 之前打印具体数字）：
`SMOKE_CANVAS_TOPOLOGY_OK nodes=… edges=… mismatched=…`、
`SMOKE_CANVAS_ADAPTER_OK mismatch=1->0 adapters=1 bridges=match`、
`SMOKE_CANVAS_ORTHO_OK stations=… artboards=3 gantt=…`、
`SMOKE_CANVAS_EXPORT_OK json=… build123d=… plc=… ct=…s uph=… pendingQuote=…`。
