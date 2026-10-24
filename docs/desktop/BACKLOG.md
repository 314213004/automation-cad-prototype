# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。
历史归档：只保留最近一轮的迭代记录；更早的完整记录按原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不进入离线知识索引，避免挤占 400 KB 上限）。

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

### P1 电气智能辅助（线号合规 + 功率统计）
- 状态：✅ 已完成（`5352832` 规则引擎 + `652e031` 面板/PDF/Agent 工具）
- 已完成：线号合规（缺号/格式/同网重复/跨网络重号/相线电位不符/数字跳号）、功率统计（kW/kVA、需要系数、分相电流、不平衡度、主断路器+进线截面建议、24V 电源余量）、导线截面 vs 载流量与断路器配合校验；`runElectricalCheck` 汇总按级别排序
- 已完成（本轮）：`src/elec/ui.ts`「电气校验」面板（9 张统计卡 + 级别/位置/建议问题表 + 导出 PDF）、`src/elec/report.ts` A3 横向报告、Agent 命令与工具 `run_electrical_check`（含入参校验）、smoke 面板链路自检 `SMOKE_ELEC_CHECK_UI_OK rows=4 cards=9 pdf=true`
- 数据来源：面板通过 `window.__ElecDocProvider` 取电气文档，未注入时明确提示而不伪造数据 —— 待原理图数据接线后可直接复用。
- 验收：`npm test` 221/221（本轮 +14）；`npm run smoke` → `SMOKE_OK`

### P2 电箱底板画布（真实尺寸布局）
- 状态：✅ 已完成（`df8f1a2`）：185 测试、`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`；尺寸覆盖 191/371
- 内容：mm 坐标 2D 画布，底板尺寸可设，元件按 `dims{w,h,d}` 真实尺寸绘制，拖放/吸附导轨/碰撞标红/利用率统计
- 验收：`SMOKE_ENCLOSURE_CANVAS_OK placed>=1 overlap=0`

### P3 联调 3D 通用化
- 状态：✅ 配置驱动已完成（`71b5e18`）：4 工位 / 12 执行机构 / 16 传感器，smoke `parts=16 ticks=57`
- 运动学标注数据层：✅ 已完成（`8d5835d`，`desktop/src/cad/kinematics.ts`）——动件 → 轴/行程/方向/点位绑定，`checkKinematics` 中文校验（动件不在 STEP、行程非正、缩回超行程、直轴填角度、点位不在 IO 表、同点位被占）、`axisPose` 姿态解算（含双信号冲突）、`crossCheckMachineConfig` 行程/类型/未绑定核对、JSON 存取与不可变编辑；23 条单测，全套 244/244，`SMOKE_OK`
- 标注 UI：✅ 已完成（`b0e6df3`）：网格多选建动件、轴/方向/行程/缩回位/点位编辑、实时中文校验、滑块预览与复位、localStorage 按文件分桶、JSON 导入导出；联调 3D 改为标注优先/配置回退（黄条说明原因）。258/258，`SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25`
- P3 状态：✅ 完成（配置驱动 + 运动学标注闭环）

### P4 大模型性能
- 状态：✅ 已完成（`f6962b3` 规划层 + `71c0e9b` 批次层与视图器接入）
- 已完成（规划层）：零件元数据（三角面/包围球/几何指纹）、平移无关指纹（STEP 顶点是世界坐标，仅平移不同的同款件仍能合批）、视锥剔除、覆盖率 → LOD0/1/2 分级（小件不降级）、实例分组（同指纹同色、仅 LOD0，附带每实例中心）、drawCall/三角面预算、中文配置校验与中文概要 `describePlan`
- 已完成（批次层，`src/cad/render-batch.ts`）：几何按中心归零 + 每实例平移矩阵（列主序，可直接喂 `Matrix4.fromArray`）、确定性三角面抽样简化、包围盒代理（12 面）、渲染指令表 `buildRenderOps`（hidden/lodCounts/drawCalls/triangles）与中文概要 `describeRenderOps`
- 已完成（视图器接入）：`viewer.ts` 建 `batchGroup`，按指令表开关可见性、按 LOD 换几何（LOD0 原模 / LOD1 抽样 / LOD2 代理盒）、按实例组建 `InstancedMesh`（原始 mesh 保留给拾取、导出与运动学，仅隐藏不绘制）、相机移动 150ms 节流重算、运动学姿态变化后刷新实例矩阵、拾取支持 `instanceId → partIndex`；新增 `getRenderPlanText()`
- 基准：`npm run bench:render` → 10 万面 / 500 零件 `metaMs≈61 planMs≈1.3 drawCalls 500→20（省 96%）budget=OK`
- 验收：`npm test` **355/355**（新增 16 条批次层用例）；`npm run smoke` → `SMOKE_OK`
- 已知限制：冒烟环境无 GPU（走 WebGL 降级路径），实例化/LOD 的真实 FPS 尚未在有显卡的机器上实测；下一步可选做「渲染面板显示当前计划」与 GPU 实机 FPS 基准

### P5 智慧工厂服务端
- 状态：✅ 本地端到端（`scripts/sync-e2e.sh` + `desktop/scripts/sync-e2e.mjs`）；生产部署仍待决策 D2
- 已完成：material-flow-backend 0.22.0 的 `/api/v1/design-sync/*`（上传/幂等/列表/diff/下载/绑定）与本项目客户端 `src/sync/*` 在本地临时 DB 上贯通；`npm run sync:e2e` 覆盖打包 → 上传 → 重复上传 → 列表 → 第二版 diff → 下载校验 → 断开后端错误阶段
- 实测：`SYNC_E2E_OK package=dsp_4f91342229f84bbc99dfef09e51257f6 dup=true diff=1 bytes=856`；JSON 日志 `docs/desktop/eval/sync-e2e.json`；`npm test` / `npm run smoke` 不包含 e2e
- 限制：生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署与真实网络/HTTPS 未验证

### P6 机台硬件成本自动统计
- 状态：🔄 P6-1 ✅ 引擎完成（`a8c1e5f`）；P6-2 ✅ 面板与导出（`6d70ae7`）；P6-3 ✅ Agent 工具（`a66b26e`）；P6-4 ✅ Agent 落盘导出（`23cd284`）
- 已完成（P6-3）：`desktop/src/cost/agent.ts`（`runCostTool`：入参校验 + 窄输出）、命令总线 `run_cost_report`（未给 bom 时读渲染桥 `getBom`，内置价格簿由主进程 `createAgentCommandBus` 第三参注入 `readBuiltinPricebookRaw`）、Agent 工具与 MCP 白名单、`main.ts` 冒烟 `SMOKE_COST_AGENT_OK`
- 实测（P6-3）：`npm test` **413/413**（新增 12 条成本 Agent 用例，同步 agent 工具数 8→9）；`npm run smoke` → `SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`、`SMOKE_AGENT_TOOLS_OK tools=9 implemented=9`
- 已完成（P6-4）：`desktop/src/cost/export.ts`（`planExportName` + `buildCostExport`）、命令总线 `export_cost_report`（复用 `computeCostReport`，PDF 走注入的 A4 `printToPDF`，CSV 带 BOM）、IPC `export:costFile`（固定 `userData/exports/`、净化/强制扩展名/冲突序号/覆盖开关、不弹对话框）、preload/`desktop-api.d.ts`/`__AgentBridge.exportCostFile`、会话 `MUTATING_TOOLS` 与 MCP 写工具清单
- 实测（P6-4）：`npm test` **439/439**（新增 25 条导出 + 1 条确认用例）；`npm run smoke` → `SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`、`SMOKE_AGENT_TOOLS_OK tools=10 implemented=10`
- 本轮提交：`23cd284`（功能）+ 本文件提交（看板）
- 下一步：P6-5 与智慧工厂采购价对接（依赖 D2）
- 分期：P6-1 价格簿+引擎 → P6-2 面板/导出 → P6-3 ✅ Agent 工具 → P6-4 ✅ Agent 落盘导出 → P6-5 与智慧工厂采购价对接
- 实测（P6-2）：`npm test` 401/401（新增 14 条报告用例）；`npm run smoke` → `SMOKE_COST_OK lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`
- P6-2 交付：`src/cost/ui.ts` 顶栏「成本估算」抽屉（9 卡 + 参数区 + 明细 + 缺价告警 + 导入 BOM/价格簿 + 导出 PDF/CSV）、`src/cost/report.ts` A4 纵向报告与 UTF-8 BOM CSV、主进程 `cost:pricebook` IPC 与 `exportReport` 可选 A3/A4
- 已知限制：BOM 需手工导入 JSON（或上层注入 `__CostBomProvider`），未做 CAD 零件名 → 元器件物料号映射；Agent 工具未传 `bom` 时用场景简化 BOM，零件无物料号 → 全部计入缺价（不按 0 计价）；面板 CSV 仍走系统保存对话框，Agent 导出固定写 `userData/exports/` 且不弹框
- 验收：单测 ≥20、`SMOKE_COST_OK`、500 行 BOM < 50ms

### P7 自然语言交互 Agent
- 状态：✅ P7-A / P7-B / P7-C / P7-D / P7-E / P7-F / P7-G / P7-H 完成（P7-A：离线规则路由 + 上下文裁剪 + 审计 + 侧栏只读问答 UI + 评估集；P7-B：`place_component` 底板放置 + 二次确认 + 撤销联动；P7-C：离线多步规划 + 计划卡片 + 顺序执行 + 失败停止；P7-D：Agent 工具扩展 v1，12 → 17 个工具；P7-E：上下文快照与指代；P7-F：执行进度/取消/失败建议/审计增强；P7-G：真实模型冒烟 + 抗注入；P7-H：主动建议 next-best-action）
- 已完成（P7-A-1，`424711c`）：
  - `src/agent/router.ts`：7 类意图关键词计分（写操作同分优先）、`planTool` 中文→工具+参数、`planReadOnly` 只读白名单、类别同义词按长度倒序（热继电器不被继电器吃掉）、`extractQuery` 去客套/动词/疑问词
  - `src/agent/context.ts`：`buildAgentContext` 默认 ≤2048 字节，降级顺序「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」，回报 `bytes/truncated/droppedTools/droppedRecent`
  - `src/agent/audit.ts`：NDJSON 审计、`maskSecrets`（sk-/Bearer/token=/X-Design-Key）、`redactValue` 按字段名脱敏、坏行跳过、写失败不阻断
  - `session.ts`：`llm.chat()` 抛错才降级离线；写指令不执行并抛原错误；每次工具调用（含 `USER_DENIED`/参数非法/离线）写审计
  - `electron/ipc.ts`：审计落 `userData/agent-audit.jsonl`，新增 `agent:audit:read`（最近 50 条 + 汇总）
- 实测（P7-A-1）：`npm test` **457/457**（新增 18 条，覆盖意图/计划/只读隔离/上下文/脱敏/离线降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776`
- 已完成（P7-A-2，`b3b9aee`）：
  - `src/agent/preview.ts`：纯函数视图模型。`buildPlanPreview` 输出 tone（read/write/none）、工具、参数、`offlineAllowed`、缺参；`buildReceipt` 让在线/离线共用「通道 · 耗时 · 工具次数 · 失败数」；`describeAuditEntry` / `auditSummaryText` 供审计面板
  - `session.ts`：新增 `mode()` 记录本轮通道（`llm.chat()` 抛错并成功降级才算 offline），`ipc.ts` 的 `agent:chat:send` 回传 `mode` 与 `elapsedMs`
  - `ui.ts`：输入框 `input` 事件实时渲染计划预览（`data-tool`/`data-read-only`/`data-offline`，只展示不执行）；回复下方渲染统一回执；新增审计区（最近 8 条 + 汇总 + 刷新按钮），打开抽屉与每次发送后自动刷新
  - `preload.ts` / `desktop-api.d.ts`：新增 `agent.audit.read()`
  - `main.ts`：新增 `SMOKE_AGENT_READONLY_UI_OK` —— 只读样例 `offline=1`、写样例 `offline=0` 且提示含 `partId`、预览前后场景零件数不变、审计面板读到 2 条
- 实测（P7-A-2）：`npm test` **466/466**（新增 9 条，覆盖预览只读/写/超纲、本轮工具统计、回执在线/离线/异常耗时、审计行与汇总、会话 mode 的在线/离线/清空/写指令不降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`
- 已完成（P7-A-3，提交号待补）：
  - `desktop/eval/agent-cases.json`：40 条中文用例，覆盖 7 类意图；16 条指代、5 条歧义、5 条多步、5 条超纲；工具名全部来自 `tools.ts` 注册表
  - `desktop/eval/run-eval.mjs`：离线规则回归，统计意图准确率 / 工具选择率 / 参数抽取率 / 超纲拒绝率 / 多步完成率，输出表格并写 `docs/desktop/eval/latest.json`（时间戳、版本、逐条明细）；低于阈值退出码 1
  - `src/agent/router.ts`：修复指代词被当搜索词、联调/同步误落元件搜索、歧义句乱调工具；新增 `splitInstructionSteps` / `planToolSequence` 多步规划，写操作参数支持 `partId` 与 CAD 路径抽取
  - 实测：`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（40/40 意图、40/40 工具、14/14 参数、5/5 超纲拒绝、5/5 多步）；`npx tsc --noEmit` 通过；`npm test` 470/470
- 已完成（P7-B）：
  - `src/agent/placement.ts`：中文放置参数抽取（逗号坐标 / `x=`/`y=` / 旋转 / 关闭吸附）与型号解析（精确 id → 唯一模糊命中；多义回 `AMBIGUOUS` + 候选）
  - `src/enclosure/layout.ts`：`placementWarnings`（`OVERLAP` / `OUT_OF_BOUNDS`）、`rotateSize`、`railSnapPlacement` 纯函数
  - `src/enclosure/canvas.ts`：`__Enclosure.place/remove`、`placePart` 支持旋转与可选导轨吸附、按 placementId 撤销；`src/agent/commands.ts` 注册 `place_component` 并把 placementId 写入撤销栈
  - `src/agent/tools.ts` / `session.ts` / `mcp.ts`：新工具、`MUTATING_TOOLS` 二次确认、MCP 写工具清单
  - `router.ts`：放/摆/加 + 坐标 → `place_component`；插入仍走 `insert_component`
  - `desktop/eval/agent-cases.json`：新增 6 条放置类用例，共 46 条
- 实测（P7-B）：`npm test` **598/598**（新增 21 条放置用例）；`eval:agent` 全 1.00（46/46 意图、46/46 工具、20/20 参数、5/5 超纲拒绝、5/5 多步）；`npm run smoke` → `SMOKE_AGENT_PLACE_OK placed=1 undo=1`、`SMOKE_AGENT_TOOLS_OK tools=11 implemented=11`、`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028`
- 已完成（P7-C）：
  - `src/agent/planner.ts`：`plan(input, context)` 五类离线组合（查件→放置→校验 / BOM→成本→导出 / 导入→干涉 / PLC 生成→模拟验证 / 设计包→上传）+ 通用拆句；未知工具过滤并记 `warnings`；不命中或置信度 < 0.6 返回 `refused:true` + 建议
  - `executePlan(plan, deps)`：只读直接执行；含写步骤时一次 `confirmPlan` 汇总确认；任一步失败立即停止；每步记录 `elapsedMs`/结果码；可撤销写已成功时返回 `undoHint`（`undo_last`）；支持 `startAt/maxSteps` 逐步执行
  - `electron/ipc.ts` / `preload.ts` / `desktop-api.d.ts`：新增 `agent:plan:execute`，主进程二次校验工具注册与步骤结构，确认弹窗一次，审计 `source='plan'`
  - `src/agent/ui.ts` / `panels.css`：侧栏多步计划卡片（序号/工具/参数/原因/缺参/读写标记）+「全部执行/逐步执行/取消」；执行中 `…`、成功 `✓`、失败 `×` 并显示错误码与原因
- 实测（P7-C）：`npm test` **674/674**（新增 27 条规划/执行器用例）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，且侧栏两步只读计划「全部执行」后两项均为 `is-done`
- 已完成（P7-D，提交号待补）：
  - `tools.ts` 注册表新增 5 个工具：`get_project_context`（只读，缺失字段返回 null）、`update_component`（改型号/数量/备注，可撤销）、`remove_component`（底板/BOM 移除，可撤销）、`run_plc_generate`（预检失败不落盘）、`export_files`（pdf/dxf/glb/bom，复用统一文件名净化与冲突规则）
  - `commands.ts` / `extension.ts` / `viewer.ts` / `enclosure`：新增工程上下文、元件更新/移除快照恢复、PLC 目录落盘、通用导出渲染桥；`ipc.ts` 注入 A3 装配报告 PDF 管线
  - `session.ts` / `mcp.ts` / `router.ts` / `planner.ts`：4 个写工具加入 `MUTATING_TOOLS` 与二次确认，MCP 桌面依赖清单同步，读写集合保持 8 + 9 = 17；`update_component` / `remove_component` 纳入可撤销写
  - 错误码：`PART_NOT_FOUND`、`NOT_PLACED`、`PRECHECK_FAILED`、`UNSUPPORTED_FORMAT`、`INVALID_ARGUMENT` 均为稳定结构化返回
  - 测试：新增 `desktop/test/agent/tools-v2.test.mjs` 30 条（schema 完整性、参数校验、未知型号、无尺寸告警、移除不存在、预检拦截不落盘、导出白名单/路径净化/覆盖序号、确认拒绝）
- 实测（P7-D）：`npm test` **717/717**（687 → 717，新增 30 条）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_TOOLS_OK tools=17 implemented=17`、`SMOKE_AGENT_TOOLS_V2 tools=17`、`SMOKE_AGENT_NL_OK intents=7 tools=17 audit=3 ctx=541`
- 已完成（P7-F，提交号待补）：
  - `src/agent/feedback.ts`：进度事件类型、参数摘要（`redactValue` + `maskSecrets`）、耗时格式化、n/N 与 10 s 提示、连续 3 步汇总、取消文案
  - `src/agent/suggest.ts`：`PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED` 中文建议与替代方案；未知码明确「无法判断具体原因」
  - `session.ts` / `planner.ts`：`run(text, {signal,onProgress,runId})`、`executePlan(..., {signal,onProgress})`；每步 start/end 事件；`AbortController` 中断当前等待；`AgentCancelledError.completedSteps` 只记录已结束步骤
  - `ipc.ts` / `preload.ts` / `desktop-api.d.ts`：`agent:progress` 事件、`agent:chat:cancel`、`agent:plan:cancel`、`agent.onProgress()`
  - `ui.ts` / `panels.css`：执行前进度、500 ms 秒表、>10 s 可取消、结果卡片（✓/×、耗时、结果码）、3 步汇总、取消按钮与取消文案、失败建议卡片
  - `audit-view.ts`：工具/结果筛选、时间倒序、最近 200 条上限与丢弃提示、CSV（UTF-8 BOM、统一文件名净化）、单条完整 JSON 递归脱敏；`AgentAuditRecord.elapsedMs`
  - `test/agent/ux.test.mjs`：21 条新单测；main smoke 新增 `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- 实测（P7-F）：`npm test` **766/766**（745 → 766，新增 21 条）；`eval:agent` 全 1.00；`npm run smoke` → `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- 下一步：联调/同步工具注册后把 `tool: null` 用例替换为真实工具；单步模型工具调用仍使用一次性确认，逐步确认 UI 可在后续补齐
- 验收（A/B/C 期）：`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028` + `SMOKE_AGENT_READONLY_UI_OK` + `SMOKE_AGENT_PLACE_OK placed=1 undo=1` + `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，误写率 0（写计划不进入离线通道、预览不执行、拒绝确认不执行，均有单测/冒烟钉住）

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
