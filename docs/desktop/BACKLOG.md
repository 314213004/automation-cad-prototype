# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。
历史归档：只保留最近一轮的迭代记录；更早的完整记录按原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不进入离线知识索引，避免挤占 400 KB 上限）。

## 整机形态选型一致性修复（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1426/1426**（较上轮 +18）、`npm run smoke` 更新 `SMOKE_MACHINE_FORMS_OK forms=6 picked=dial-6`、`npm run eval:agent` **1.00**；未 push。
- 缺陷：第 37 轮形态库把 `gantry-2` 的 `stationRange` 写成 1–6，选型器又让布局/得分压过工位数，导致双工位龙门承接 3/6 工位需求。复现命令（在 `desktop/` 下）：
  ```bash
  node --experimental-strip-types -e "import('./src/machine/spec.ts').then(async s=>{const y=await import('./src/machine/synth.ts'); for (const t of ['六工位锁螺丝机，节拍 20 件/分钟','三工位点胶机，节拍 15 件/分钟','四工位装配线，节拍 12 件/分钟']) {const d=y.synthMachine(s.parseMachineBrief(t)); console.log(t.slice(0,20), d.form.id, d.config.stations.length)}})"
  ```
  修复前输出：三工位、六工位均 `gantry-2`；修复后：`dial-6 / dial-6 / linear-4`。
- 修复：`forms.ts` 改为 `minStations + defaultStations + maxStations` 单一来源推导 `stationRange`，六个形态区间收敛为 `gantry-2 [1,2] / dial-6 [2,6] / dial-8 [6,8] / linear-4 [2,4] / linear-8 [5,8] / dual-lane [4,6]`；加载期 `assertMachineFormsConsistent()` 校验 `stationRange[0] <= defaultStations <= stationRange[1]`，越界直接抛错。
- 选型：`pickForm` 先按工位数硬筛，再按工艺适配 → 节拍达标 → 占地系数最小 → 推荐工位数最接近排序；布局意图只在覆盖工位数的候选内生效。无覆盖时取区间最接近形态并输出「该形态支持 X–Y 工位，需求 N 工位，已按 X/Y 生成，请确认是否需要非标设计」。
- 一致性：`design_machine.form` 增加 `stationRange/defaultStations`；`build-machine-case.mjs` 把 `design.form` 写入 `machine-case.json`；`apply_machine_design` 落盘的 machine json 保存 `form.id/stationRange/defaultStations`，`readStoredMachineDesign` 重载后可复现 `dial-6`。
- 后果说明：六工位案例因形态改为 `dial-6`，产能模型从 `parallel 113.21` 变为 `dial 15.87` 件/分钟；20 件/分钟目标不再达标，案例与文档保留真实缺口 warning，不硬凑达标。
- 文档：`MACHINE-DESIGN.md` 形态表补 `defaultStations/maxStations` 与选型优先级；`MACHINE-DESIGN-DEMO.md` 写明本案例选中 `dial-6` 的理由与重算结果。


## 软件整体优化（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1408/1408**（较上轮 +30）、`npm run smoke` 新增 `SMOKE_PERF_OK parts=1000 buildMs=22.4 tickMs=0.092` 与新 `SMOKE_DIAGNOSE_OK fields=app,webgl,userDataPath,dataPack,kb,audit,recentErrors errors=2`、`npm run eval:agent` **1.00**；未 commit、未 push、未打包。
- 实测：见 [PERF.md](PERF.md)，原始数据 [PERF-before.json](PERF-before.json) / [PERF-after.json](PERF-after.json)。3000 件场景构建 `184.63 → 42.34 ms`、tick `1.5007 → 0.6755 ms`、堆峰值 `60.72 → 38.52 MB`；1000 件场景构建 `73.69 → 15.09 ms`。

### 已优化项

1. **几何缓存**：`generateMachineGeometry` 增加 16 项 LRU（config + process + layout + form layout 为键），同内容克隆也命中；`bypassCache` 仅供诊断；3000 件热构建 8.96 → 0.85 ms。
2. **场景资源共享**：`buildThreeMachine` 按形状/材质键复用 BufferGeometry 与 MeshStandardMaterial；3000 件材质 3000 → 410，场景构建 -77.1%。
3. **静态矩阵冻结 + 增量变换**：非运动节点 `matrixAutoUpdate=false`；`applyAxisValue` 相同值跳过并返回 `false`，只写 mover/jaw；`Commission3DStats.transformUpdates` 可观测有效写入次数。
4. **运动/传感器降频**：`MachineMotion.advance` 只推进 active 执行机构；传感器只在状态变化时重绘。
5. **大输入保护**：BOM > 5,000 行、STEP > 200 MB、其它 CAD > 50 MB 在读取/追加前拒绝，错误码 `STEP_TOO_LARGE` / `FILE_TOO_LARGE` / `BOM_TOO_MANY_ROWS`，中文提示给出拆分/轻量化动作。
6. **幂等写盘**：`apply_machine_design` 用不含 `appliedAt` 的稳定内容 hash 判重；同参数重复执行返回 `idempotent:true`，不重写方案/active/BOM，BOM 批次 id 改内容 hash，重复追加返回 0。
7. **资源释放**：`disposeThreeMachine`、`CommissionScene3D.dispose`、`FactoryManager.dispose`、`PlcManager.dispose`、`disposeIpcRuntime` 与 `before-quit` 接通；PLC/工厂/Parametric 的 timer 走显式计数。
8. **catch 审计**：静默返回空值的 catch 补齐 `recordDiagnosticError` 或带 `site`/`code` 的 `console.warn/debug`；UI 分支保留中文可操作提示。源码中仅注释、无处理的 catch 清零。
9. **诊断**：`--diagnose` / `npm run diagnose` 输出环境、WebGL、userData、数据包版本、KB 条数、审计大小与最近 20 条错误；未捕获异常写 `userData/diagnostics/last-crash.json`，字段固定且脱敏。
10. **启动路径**：smoke 的 three.js 性能 workload 改为动态加载，普通桌面启动不再静态引入几何生成器与 three.js。

### 未优化项（及原因）

- **GPU / WebGL 帧率**：headless 无 GPU，本机 `--diagnose` 也显示 WebGL blocklisted；缺 Windows 实机数据，贸然改 draw call / instancing 无法用当前基线验证。
- **LRU 按条数不按字节**：实现简单、可预测；3000 件几何仍可能占数十 MB，等出现多机型频繁切换的真实用户样本后再做字节预算。
- **tick 仍遍历全部执行机构**：3000 件 P95 0.91 ms，已远低于 16.7 ms 帧预算；引入脏集合会增加状态同步复杂度，收益不足以覆盖风险。
- **BOM 5,000 行只覆盖渲染层追加与 BOM 导入**：CSV/XLSX 批量导入路径尚未统一接入同一限流函数，需先确认导入入口的现有分批策略。
- **审计文件损坏行只告警跳过**：保留 AI 可读性优先，未做自动隔离/上报；`last-crash.json` 也不做自动上传，避免未授权外传。
- **崩溃报告仅覆盖主进程未捕获异常/未处理拒绝/子进程退出**：渲染进程崩溃已记录，但 GPU 进程 OOM、原生扩展崩溃仍依赖 Electron 自身日志。

## 整机形态库（2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1378/1378**（+28：`forms.test.mjs` 25 + apply 落盘 3）、smoke 新增 `SMOKE_MACHINE_FORMS_OK forms=6 picked=dial-6`、`npm run eval:agent` **1.00**（106 条，新增 4 条同工艺换布局用例）；未 push、未打包、未触发 CI。
- 数据：新增 `desktop/src/machine/forms.ts`，6 种形态 `dial-6 / dial-8 / linear-4 / linear-8 / gantry-2 / dual-lane`；纯数据字段含 `layout / stationRange / indexSeconds / transferSeconds / footprintScale / suits / rationale / geometry`，`validateMachineForms()` 校验布局与 flow 对齐、工位区间、几何映射与 id 唯一。
- 选型：`pickForm(brief, templates)` 先按布局意图 + 工艺适配筛候选，再用 `evaluateFlow` 在工位范围内预演；达标者优先、工位范围小者优先；无匹配时回退最近形态并给 warning（工位超出/产能缺口），不硬凑达标；固定返回 2 条备选，差异文案覆盖占地、成本、换型。
- 接入：`synthMachine` 先选形态，按 `form.layout` 与 `form.indexSeconds/transferSeconds` 构造 FlowModel；`design_machine` 返回 `design.form` 并在方案卡显示形态名/理由/备选；`generateMachineGeometry` 优先用 `form.geometry.kind`（dial/linear/gantry/dual），1 工位回退 single；`apply_machine_design` 把 `form.id` 与几何写进 machine json，3D 刷新同时传 layout。
- 文档：`MACHINE-DESIGN.md` 新增「整机形态库」表与选型规则；`MACHINE-DESIGN-DEMO.md` 增加「同一需求的两种形态对比」；README / MODULES 已同步 smoke 与测试数。

## 通用产能引擎（feat/flow-engine，2026-10-24，本轮）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1350/1350**（+34：`flow.test.mjs` 23 + `flow-archetypes.test.mjs` 6 + `flow-synth.test.mjs` 5）、smoke 新增 `SMOKE_FLOW_ENGINE_OK modes=5 archetypes=6`、`npm run eval:agent` 1.00、`build:machine-case` 重算六工位案例（`parallel` / 3.18 s / 113.21 件/分钟 / 需 2 工位）；未打包、未触发 CI、未发版、不 push。
- 数据模型：新增 `desktop/src/machine/flow.ts` 纯函数 `evaluateFlow`，统一支持 `single / linear / dial / parallel / cell`；公式、默认值（transfer=0、index=0.6、copies=stations）、`optional` 排除、目标反解与中文非法输入错误全部在引擎内，不为单一机型写特例。
- 对接：`synthMachine` 只把 brief/模板/工位映射为 `FlowModel`，`MachineCycleEstimate.mode` 改为 `MachineLayout`，旧字段保留；`chooseLayout` 与几何层共用 dial 工艺集合/上限，`cell` 仅显式指定；`layout:'auto'` 的推断写入 `assumptions`。
- 回归：6 个机型覆盖 5 种布局（六工位并行锁螺丝、转盘点胶、5 工位直线、单工位检测、2×2 单元、2 副本并行点胶），每个机型断言 mode/cycle/throughput/meetsTarget/requiredStations/瓶颈工位。
- 文档：`MACHINE-DESIGN.md` 新增五种布局公式表、字段、默认值与适用边界；`MACHINE-DESIGN-DEMO.md` 标注本案例为 `parallel` 实例；README 能力表与 KB 已同步。
- KB：为留出 ≥5% 余量，将上一轮「并行三条」及已完成 P8/P9/P10 记录原文移入 `BACKLOG-HISTORY.md`（不进入索引）。

## 待办（按优先级）

- 当前无待推进的 P1–P7 项；已完成记录已移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)「已完成迭代归档（P1–P7）」。

## 待决策（需要老王拍板，不阻塞其他开发）

| # | 问题 | 选项 | 影响 | 建议 | 状态 |
|---|------|------|------|------|------|
| D1 | 价格簿的真实单价从哪来 | A 采购/财务给正式价目表；B 用公开目录价并标注来源；C 先空着只做结构 | 成本报告能否用于报价 | B 先跑通，正式报价前换 A | 待定 |
| D2 | 智慧工厂生产环境谁来部署 0.22.0 | A 对方运维；B 我们远程部署；C 只在测试环境验证 | 端到端联调能否做 | A，我们提供验收清单 | 待定 |
| D3 | PLC 程序生成首期目标平台 | A 通用 ST 优先；B 西门子 S7 优先；C 汇川/三菱优先 | 模板与变量表格式 | A，其次按现场实际 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | A 立项并定义接口；B 先只做数据导出；C 暂缓 | 路线图与汇报口径 | B 过渡，接口按 A 设计 | 待定 |
| D5 | 元件库缺失尺寸（180/371）能否用「同系列壳体推定」 | A 允许并标注推定；B 只用实测/官方值，缺的留空 | 底板布置覆盖率 | A + 标注，人工复核 | ✅ 已按 A 执行：244/371（65.8%），官方 37 + 推定 16；剩余 127 条留空，清单见 `docs/desktop/DIMS-GAPS.md` |
| D6 | 参数化建模首期范围 | A 只做单件结构件；B 单件+多体装配；C 直接上草图约束 | 工期（A≈3 周，B≈6 周） | A 先交付，B/C 分期 | 待定 |
| D7 | 成本面板如何拿到 BOM（CAD 零件名 → 元器件物料号映射口径） | A 由底板画布/电气元件库直接给 partId，成本面板只读；B 允许「零件名规则匹配 + 人工确认」自动填 partId；C 保持手工导入 BOM JSON | 影响成本能否一键算；B 需要命名规范（如 `QF1:LC1D09`），否则匹配率低 | A 长期方向，短期用 C + 预留 B | 待定 |
| D8 | Agent 的 `run_cost_report` 是否允许落盘导出报告 | A 保持只读，只回摘要；B 增加写工具 `export_cost_report`（PDF/CSV，走现有二次确认）；C 由面板导出，Agent 只给「点哪里」 | 影响「一句话出报价单」的体验；B 需要确认文件名/目录规则与覆盖策略 | B：`export_cost_report` 固定写 `userData/exports/`，默认不覆盖、冲突追加序号 | 已定 B，已实现（`23cd284`） |
| D9 | 离线规则路由是否要在「模型可用时」也前置生效 | A 仅在模型失败时降级（现状）；B 高置信度只读指令直接走规则，省一次模型调用；C 全走模型 | B 更快更省 token，但规则误判时用户得不到语义纠正，且两套路径要长期保持一致 | A 先稳定；若要 B，先攒 40 条评估集对比准确率再开 | 待定 |
| D10 | 中文评估集用哪条通道跑基线 | A 只用离线规则路由（零成本、可离线、但只覆盖规则能判的句式）；B 规则 + 真实模型双跑（能测语义理解，按 token 付费）；C 只跑模型 | 决定评估结论代表「规则上限」还是「产品上限」；B 需要一把可用的付费/自建模型 key 与预算口径 | A 先立基线并进 CI 友好（无网络），B 作为发布前手动回归；已落地离线 61 条 + 真实模型 30 条（`agent:live`，30/30；拒绝/澄清 6/6） | ✅ 已按 B 执行 |

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决；STEP 不含运动学，任意装配体仍需标注层。36-auto-kinematics 起可按名称/型号/层级/几何自动给出标注**建议**（需逐条确认），但识别是启发式：命名不规范或几何不典型的机构仍需人工标注，斜向运动只能取最近主轴，夹爪对侧手指、缩回位与无型号行程仍需人工确认。 迭代 34 起机型方案的 3D 改为参数化整机几何，但仍是标准件外形，不是结构设计。
2. **尺寸数据覆盖不全**：已补至 266/379（70.2%；16 条同系列推定，2026-10-24 第二批 22 条全部为官方尺寸），仍缺 113 条；缺失元件在底板画布上按「未标注尺寸」处理，需人工补（清单与来源见 DIMS-GAPS.md）。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：原型自身 3D 仍为固定等轴测投影（插入与撤销已真实化）。**桌面版已缓解（35-orbit-view + 收尾）**：有 WebGL 时主视口为可旋转 three.js，缸径/行程与桌面版尺寸/位置编辑沿叠放链重建几何；桌面版几何编辑已进撤销栈（与原型合成一条时间线）、内置零件覆盖持久化到工程存储，WebGL 模式支持 Shift+拖拽 / 「框选」模式多选。仍未解决：几何为参数化示意体（非 B-rep、无配合求解、缸径为原型示意比例）；插入件尺寸覆盖不持久化（原型不持久化插入件）；3D 存储为单键、不按机型分桶；撤销对账依赖原型状态栏文案（原型改文案需同步改 `parseProtoCounts`）；无 WebGL 时回到固定等轴测。
8. **真实模型拒绝/澄清类**：已从 4/6 修到 6/6（判定语义修正 + 两条系统提示）；但仍是单模型单轮结果，换模型或换措辞需重跑 `npm run agent:live`，不要把 30/30 当成通用结论。
9. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板最多显示最近 200 条（可筛选/导出），回执不含 token 用量（网关未回传 usage）。 **2026-10-24 更新（feat/agent-audit-router）**：① 审计已按大小轮转 + 保留期清理（默认 5 MB × 5 份 × 90 天，可配置），面板/报告读全部保留份数；被保留期删除的份数不可恢复，CSV 仍只导出面板当前列表（≤200 条）。② 路由已系统补同义/口语词并加非工程话题拦截（评估集 102 条）；仍是关键词规则：未收录的说法照旧判超纲，「撞」「会动」「规划」等单字/泛词可能把边缘句子拉进工程意图，非工程话题表是有限枚举。回执 token 用量问题未变。
10. **多轮评测证据仍是 5/6**：`docs/desktop/eval/agent-multiturn.json`（Fri 2026-10-23 8:28 PM CST (UTC+08:00)）中 MT04「拒绝后自动重试」两轮未过；会话层拒绝记忆已修复，但尚未有新的真实模型多轮 JSON，报告按现有证据展示，重跑 `npm run eval:agent:multiturn` 后再更新。 **2026-10-24 更新**：上述描述已过时——仓库内 `agent-multiturn.json` 已是修复后的真实模型结果（`cn:deepseek-v4.1-flash`，生成于 Fri 2026-10-23 10:08 PM CST (UTC+08:00)，6/6 场景、15/15 轮，MT04 通过），Agent 报告按此展示。本轮补了 `test/agent/multiturn-mt04.test.mjs` 会话层确定性回归（fake LLM 回放 MT04：原样重试与 `partId` 写法重试都被短路、不弹确认）。本机无 `AGENT_LIVE_BASE_URL/API_KEY/MODEL`，**真实模型重跑待有 key 时执行**（换模型/换措辞仍需重跑，单模型单次结果不是通用结论）。遗留边界：拒绝记忆按「工具 + 目标」匹配，模型若在「继续」后改用别的写工具动同一目标（如 `remove_component QF1`）仍会走确认框，真实评测会算违规。
11. **两条成本导出单测依赖本地时区**：`test/cost-export.test.ts` 的文件名断言按 Asia/Shanghai 本地时间（`…-20261023-1200`）；在 UTC 环境（如本轮沙箱）直接 `npm test` 会 1130/1132，需 `TZ=Asia/Shanghai npm test`。35-orbit-view 未改这两条断言，只记录。
12. **安全光栅型号（已补录，2026-10-24）**：`iec-cn` 已补 8 条官方来源的 Type 4 安全光栅，六工位案例 BOM 初选 `F3SG-4SRA0640-14`，`machine-case.json` 与 MACHINE-DESIGN-DEMO.md 已更新；仍待：安全距离按 ISO 13855 现场核算、机型截图在有显示环境时重拍（具体是 `15-machine-design-card.png`、`16-machine-3d.png`、`17-machine-bom.png`、`18-machine-iomap.png` 四张，其中 17 仍显示「待选型」，与已选 `F3SG-4SRA0640-14` 的 BOM 不一致）。
13. ✅ **已修复（提交号：accaf9d）——节拍模型未区分「并行同工序」与「流水线分工序」**（原问题记录，2026-10-24 发现）：`synthMachine` 原先只按流水线建模——产能由最慢工位决定，补并行工位只针对瓶颈工序。因此「六工位锁螺丝机、20 件/分钟」被判为不达标（3.18 s/件 > 3.00 s/件，建议 12 工位），但 6 个**同工序并行**工位的实际产能应为 `6 / 3.18 × 60 ≈ 113 件/分钟`。影响：机型方案卡与 `machine-case.json` 的节拍结论偏保守，`MACHINE-DESIGN-DEMO.md` 已如实标注「若坚持该估算模型需 12 工位」。修复：`MachineBrief` 增加 `layout` 与 `processes`，解析器按流水线关键词/多工序推断 `line`，单一工艺推断 `parallel`；`MachineCycleEstimate` 增加 `mode`、`stationSeconds`、`throughputPerMin`，并行按 `stations / stationSeconds × 60`、流水线按 `60 / 最慢工位` 计算；新增 `test/machine/cycle-mode.test.mjs` 19 条与 `SMOKE_MACHINE_CYCLE_OK`，六工位案例重算为 `113.21 件/分钟`、`meetsTarget=true`。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败

## 仓库双推约定（GitHub + Gitee，2026-10-24 起）

- 主仓库：`origin` = GitHub `owlco001/automation-cad-prototype`；镜像：`gitee` = Gitee 同名仓库（公开）
- `origin` 配置了两个 push URL（GitHub 在前、Gitee 在后），因此 `git push origin main` 会自动双推；任一远端失败则整体失败，**不允许只推成功一边**
- 推 tag 必须用 `git bothpush`（等价于 `git push origin main && git push origin --tags`），普通 push 不带 tag
- 新增 tag 后必须核对：`git ls-remote origin refs/tags/<tag>` 与 `git ls-remote gitee refs/tags/<tag>` 都存在且指向同一提交
- 发版/合并后复核三方 HEAD 一致：
  `git rev-parse HEAD`、`git ls-remote origin refs/heads/main`、`git ls-remote gitee refs/heads/main`
- Gitee 偶发 5xx 或超时：重试一次即可，不要改成只推 GitHub 了事；连续失败要在本文件记录时间与错误码
- 凭据只存在 `~/.git-credentials`，禁止写进仓库、提交信息或日志
