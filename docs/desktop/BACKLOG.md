# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。

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
- 验收：`tsc --noEmit` 通过；`npm test` **355/355**（新增 16 条批次层用例）；`npm run smoke` → `SMOKE_OK`
- 已知限制：冒烟环境无 GPU（走 WebGL 降级路径），实例化/LOD 的真实 FPS 尚未在有显卡的机器上实测；下一步可选做「渲染面板显示当前计划」与 GPU 实机 FPS 基准

### P5 智慧工厂服务端
- 状态：✅ 本地端到端（`scripts/sync-e2e.sh` + `desktop/scripts/sync-e2e.mjs`）；生产部署仍待决策 D2
- 已完成：material-flow-backend 0.22.0 的 `/api/v1/design-sync/*`（上传/幂等/列表/diff/下载/绑定）与本项目客户端 `src/sync/*` 在本地临时 DB 上贯通；`npm run sync:e2e` 覆盖打包 → 上传 → 重复上传 → 列表 → 第二版 diff → 下载校验 → 断开后端错误阶段
- 实测：`SYNC_E2E_OK package=dsp_4f91342229f84bbc99dfef09e51257f6 dup=true diff=1 bytes=856`；JSON 日志 `docs/desktop/eval/sync-e2e.json`；`npm test` / `npm run smoke` 不包含 e2e
- 限制：生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署与真实网络/HTTPS 未验证

### P6 机台硬件成本自动统计
- 状态：🔄 P6-1 ✅ 引擎完成（`a8c1e5f`）；P6-2 ✅ 面板与导出（`6d70ae7`）；P6-3 ✅ Agent 工具（`a66b26e`）；P6-4 ✅ Agent 落盘导出（`23cd284`）
- 已完成（P6-3）：`desktop/src/cost/agent.ts`（`runCostTool`：入参校验 + 窄输出）、命令总线 `run_cost_report`（未给 bom 时读渲染桥 `getBom`，内置价格簿由主进程 `createAgentCommandBus` 第三参注入 `readBuiltinPricebookRaw`）、Agent 工具与 MCP 白名单、`main.ts` 冒烟 `SMOKE_COST_AGENT_OK`
- 实测（P6-3）：`tsc --noEmit` 通过；`npm test` **413/413**（新增 12 条成本 Agent 用例，同步 agent 工具数 8→9）；`npm run smoke` → `SMOKE_COST_OK lines=6 missing=1 grand=1398.64`、`SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`、`SMOKE_AGENT_TOOLS_OK tools=9 implemented=9`、`SMOKE_OK`
- 已完成（P6-4）：`desktop/src/cost/export.ts`（`planExportName` + `buildCostExport`）、命令总线 `export_cost_report`（复用 `computeCostReport`，PDF 走注入的 A4 `printToPDF`，CSV 带 BOM）、IPC `export:costFile`（固定 `userData/exports/`、净化/强制扩展名/冲突序号/覆盖开关、不弹对话框）、preload/`desktop-api.d.ts`/`__AgentBridge.exportCostFile`、会话 `MUTATING_TOOLS` 与 MCP 写工具清单
- 实测（P6-4）：`tsc --noEmit` 通过；`npm test` **439/439**（新增 25 条导出 + 1 条确认用例）；`npm run smoke` → `SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`、`SMOKE_AGENT_TOOLS_OK tools=10 implemented=10`、既有成本/智能体断言全绿、`SMOKE_OK`
- 本轮提交：`23cd284`（功能）+ 本文件提交（看板）
- 下一步：P6-5 与智慧工厂采购价对接（依赖 D2）
- 分期：P6-1 价格簿+引擎 → P6-2 面板/导出 → P6-3 ✅ Agent 工具 → P6-4 ✅ Agent 落盘导出 → P6-5 与智慧工厂采购价对接
- 实测（P6-2）：`tsc --noEmit` 通过；`npm test` 401/401（新增 14 条报告用例）；`npm run smoke` → `SMOKE_COST_OK lines=6 missing=1 grand=1398.64`、`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`、`SMOKE_OK`
- P6-2 交付：`src/cost/ui.ts` 顶栏「成本估算」抽屉（9 卡 + 参数区 + 明细 + 缺价告警 + 导入 BOM/价格簿 + 导出 PDF/CSV）、`src/cost/report.ts` A4 纵向报告与 UTF-8 BOM CSV、主进程 `cost:pricebook` IPC 与 `exportReport` 可选 A3/A4
- 已知限制：BOM 需手工导入 JSON（或上层注入 `__CostBomProvider`），未做 CAD 零件名 → 元器件物料号映射；Agent 工具未传 `bom` 时用场景简化 BOM，零件无物料号 → 全部计入缺价（不按 0 计价）；面板 CSV 仍走系统保存对话框，Agent 导出固定写 `userData/exports/` 且不弹框
- 验收：单测 ≥20、`SMOKE_COST_OK`、500 行 BOM < 50ms

### P7 自然语言交互 Agent
- 状态：✅ P7-A / P7-B / P7-C 完成（P7-A：离线规则路由 + 上下文裁剪 + 审计 + 侧栏只读问答 UI + 评估集；P7-B：`place_component` 底板放置 + 二次确认 + 撤销联动；P7-C：离线多步规划 + 计划卡片 + 顺序执行 + 失败停止）
- 已完成（P7-A-1，`424711c`）：
  - `src/agent/router.ts`：7 类意图关键词计分（写操作同分优先）、`planTool` 中文→工具+参数、`planReadOnly` 只读白名单、类别同义词按长度倒序（热继电器不被继电器吃掉）、`extractQuery` 去客套/动词/疑问词
  - `src/agent/context.ts`：`buildAgentContext` 默认 ≤2048 字节，降级顺序「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」，回报 `bytes/truncated/droppedTools/droppedRecent`
  - `src/agent/audit.ts`：NDJSON 审计、`maskSecrets`（sk-/Bearer/token=/X-Design-Key）、`redactValue` 按字段名脱敏、坏行跳过、写失败不阻断
  - `session.ts`：`llm.chat()` 抛错才降级离线；写指令不执行并抛原错误；每次工具调用（含 `USER_DENIED`/参数非法/离线）写审计
  - `electron/ipc.ts`：审计落 `userData/agent-audit.jsonl`，新增 `agent:audit:read`（最近 50 条 + 汇总）
- 实测（P7-A-1）：`./node_modules/.bin/tsc --noEmit` 通过；`npm test` **457/457**（新增 18 条，覆盖意图/计划/只读隔离/上下文/脱敏/离线降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776`、既有 `SMOKE_AGENT_TOOLS_OK tools=10`／`SMOKE_AGENT_CHAT_UI_OK`／成本四条断言全绿、`SMOKE_OK`
- 已完成（P7-A-2，`b3b9aee`）：
  - `src/agent/preview.ts`：纯函数视图模型。`buildPlanPreview` 输出 tone（read/write/none）、工具、参数、`offlineAllowed`、缺参；`buildReceipt` 让在线/离线共用「通道 · 耗时 · 工具次数 · 失败数」；`describeAuditEntry` / `auditSummaryText` 供审计面板
  - `session.ts`：新增 `mode()` 记录本轮通道（`llm.chat()` 抛错并成功降级才算 offline），`ipc.ts` 的 `agent:chat:send` 回传 `mode` 与 `elapsedMs`
  - `ui.ts`：输入框 `input` 事件实时渲染计划预览（`data-tool`/`data-read-only`/`data-offline`，只展示不执行）；回复下方渲染统一回执；新增审计区（最近 8 条 + 汇总 + 刷新按钮），打开抽屉与每次发送后自动刷新
  - `preload.ts` / `desktop-api.d.ts`：新增 `agent.audit.read()`
  - `main.ts`：新增 `SMOKE_AGENT_READONLY_UI_OK` —— 只读样例 `offline=1`、写样例 `offline=0` 且提示含 `partId`、预览前后场景零件数不变、审计面板读到 2 条
- 实测（P7-A-2）：`tsc --noEmit` 通过；`npm test` **466/466**（新增 9 条，覆盖预览只读/写/超纲、本轮工具统计、回执在线/离线/异常耗时、审计行与汇总、会话 mode 的在线/离线/清空/写指令不降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`、`SMOKE_AGENT_CHAT_UI_OK fields=6 log=1`、`SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776`、`SMOKE_AGENT_TOOLS_OK tools=10`、成本四条断言全绿、`SMOKE_OK`
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
- 实测（P7-B）：`tsc --noEmit` 通过；`npm test` **598/598**（新增 21 条放置用例）；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（46/46 意图、46/46 工具、20/20 参数、5/5 超纲拒绝、5/5 多步）；`npm run smoke` → `SMOKE_AGENT_PLACE_OK placed=1 undo=1`、`SMOKE_AGENT_TOOLS_OK tools=11 implemented=11`、`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028`、`SMOKE_OK`
- 已完成（P7-C）：
  - `src/agent/planner.ts`：`plan(input, context)` 五类离线组合（查件→放置→校验 / BOM→成本→导出 / 导入→干涉 / PLC 生成→模拟验证 / 设计包→上传）+ 通用拆句；未知工具过滤并记 `warnings`；不命中或置信度 < 0.6 返回 `refused:true` + 建议
  - `executePlan(plan, deps)`：只读直接执行；含写步骤时一次 `confirmPlan` 汇总确认；任一步失败立即停止；每步记录 `elapsedMs`/结果码；可撤销写已成功时返回 `undoHint`（`undo_last`）；支持 `startAt/maxSteps` 逐步执行
  - `electron/ipc.ts` / `preload.ts` / `desktop-api.d.ts`：新增 `agent:plan:execute`，主进程二次校验工具注册与步骤结构，确认弹窗一次，审计 `source='plan'`
  - `src/agent/ui.ts` / `panels.css`：侧栏多步计划卡片（序号/工具/参数/原因/缺参/读写标记）+「全部执行/逐步执行/取消」；执行中 `…`、成功 `✓`、失败 `×` 并显示错误码与原因
- 实测（P7-C）：`tsc --noEmit` 通过；`npm test` **674/674**（新增 27 条规划/执行器用例）；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；`npm run smoke` → `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，且侧栏两步只读计划「全部执行」后两项均为 `is-done`，`SMOKE_OK`
- 下一步：联调/同步工具注册后把 `tool: null` 用例替换为真实工具；单步模型工具调用仍使用一次性确认，逐步确认 UI 可在后续补齐
- 验收（A/B/C 期）：`SMOKE_AGENT_NL_OK intents=7 tools=11 audit=3 ctx=2028` + `SMOKE_AGENT_READONLY_UI_OK` + `SMOKE_AGENT_PLACE_OK placed=1 undo=1` + `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`，误写率 0（写计划不进入离线通道、预览不执行、拒绝确认不执行，均有单测/冒烟钉住）

### P8 设计完成后自动生成 PLC 程序
- 状态：🔄 P8-1 / P8-2 / P8-3 / P8-4 ✅ 已完成；P8-5 可选
- 范围：预检（地址重复/越界/双线圈/安全缺失）→ IO 变量表 + ST 程序块（OB1/气缸 FB/夹爪/轴/自动状态机/报警/安全）→ 导出 zip 与映射表
- 分期：P8-1 预检+变量表+FB → P8-2 序列/报警/安全 → P8-3 UI 与导出 → P8-4 模拟器自检 → P8-5 TIA Openness（可选）
- 验收：demo 机型（补齐安全件）11 文件、预检 0 错、重复生成 sha256 一致；内置模拟器 6 步跑通、0 报警
- 已完成（P8-1）：`src/plcgen/precheck.ts`（预检各规则全量返回）、`tags.ts`（I/Q 顺序分配 + UTF-8 BOM CSV）、`st.ts`（`FB_Cylinder/FB_Gripper/FB_RotaryAxis/DB_IO/OB1_Main` 五文件 + `inputHash`）；无 UI
- 实测（P8-1）：`tsc --noEmit` 通过；`npm test` **505/505**（新增 35 条 plcgen 用例）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_OK`
- P8-1 边界：首期五文件；自动序列/报警/安全 FC 留给 P8-2，生成 UI/zip 留给 P8-3，模拟器联调自检留给 P8-4；demo 配置本身未带安全点位，预检演示需补 `safety.emergencyStop/safetyDoor`
- 已完成（P8-2）：`sequence.ts`（步序 → `FC_AutoSequence` CASE 状态机、AND/OR 条件、5 s 缺省超时、超时报警、Abort/SafeStop 回 Step0）、`safety.ts`（急停/安全门常闭串联、SafeStop 锁存与 Reset 上升沿复位、缺点位只写注释）、`alarms.ts`（超时/传感器矛盾/安全触发统一 `AlarmWord` + `FirstFault` 首故障锁存）、`generate.ts`（预检拦截 + 固定 11 文件 + `mapping.json` + README + 逐文件 SHA-256）、`symbols.ts`（点位/地址/变量名映射）
- 实测（P8-2）：`tsc --noEmit` 通过；`npm test` **556/556**（新增 `plcgen-p82.test.ts` 32 条）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_OK`；同输入两次生成 11 文件 sha256 全一致
- P8-2 边界：生成 UI、zip 导出、历史记录留给 P8-3；模拟器加载生成程序跑联调序列留给 P8-4；仍不生成厂商专有工程文件
- 已完成（P8-3）：`src/plcgen/ui.ts` 电气域顶栏「PLC 程序」全屏面板（机型规模、目标平台/命名前缀、错误/警告预检表与机构定位、文件树 + 前 200 行预览、导出 zip/复制全部/打开目录）；`view-model.ts` 纯函数（文件树/预览/按钮禁用/问题定位）；`history.ts` 最近 10 次按 inputHash 去重并可回看文件清单；`export.ts` 目录命名；`src/shared/{filename,zip}.ts` 复用文件名净化与 adm-zip 写入；IPC `plcgen:history|recordHistory|export|openExportDir`
- 实测（P8-3）：`tsc --noEmit` 通过；`npm test` **577/577**（新增 `plcgen-p83.test.ts` 21 条：纯 JS SHA-256、文件树、预览截断、历史去重/上限、目录命名、ZIP 结构与 CRC + `unzip -t`、路径穿越、预检禁用、目标平台不影响 ST）；`npm run smoke` → `SMOKE_PLCGEN_UI_OK files=11 history=1`、`SMOKE_OK`
- P8-3 边界：历史只保存文件清单不保存正文；仍不生成厂商专有工程文件
- 已完成（P8-4）：`simulate.ts`（mapping 输出映射、执行机构行程时间、生成 timeoutMs、SafeStop、传感器矛盾、虚拟时钟与 timeScale）、`verify.ts`（预检 → 生成 → 模拟，`summarizeVerification` 窄摘要）、Agent 只读工具 `verify_plc_program`、面板「模拟验证」入口
- 实测（P8-4）：`tsc --noEmit` 通过；`npm test` **619/619**（新增 `plcgen-p84.test.ts` 21 条）；`npm run smoke` → `SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`、`SMOKE_AGENT_TOOLS_OK tools=12 implemented=12`、`SMOKE_OK`
- P8-4 边界：模拟器只执行生成程序的动作/等待/超时/安全/传感器语义，不解析任意 ST；仍不生成厂商专有工程文件

### P9 参数化建模（build123d 内核）
- 状态：🔄 P9-1 / P9-2 / P9-3 / P9-5 已完成；P9-4 草图约束待做
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 ✅ sidecar+契约（`spike/build123d/app.py`）→ P9-2 ✅ 主进程生命周期/IPC（`9eda660`，388/388、`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`）→ P9-3 ✅ 特征树 UI / 参数编辑 / 防抖重建 / STEP+STL 导出 → P9-4 草图约束 → P9-5 ✅ 多实体装配 + BOM/成本联动
- 已完成（P9-3）：`src/parametric/model.ts`（编辑/防抖/分桶/序列化/包围盒，18 条单测）、`src/parametric/ui.ts`（与运动学二选一的抽屉、按类型参数表单、校验失败禁重建）、`cad/viewer.ts`（STL 载入 + 旧模型幽灵层 + 特征包围盒高亮）、`extension.ts` 挂载与 `AutomationCadParametric` 调试入口；`localStorage: automationcad.parametric.v1` 按 `sourceFile` 分桶（无来源 `untitled`）；JSON 保存走 `desktop.exportFile`
- 实测（P9-3）：`npx tsc --noEmit` 通过；`npm test` **524/524**；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`、`SMOKE_OK`
- 坑：假内核脚本不能放 `test/` 下（`node --test` 会把 `test/fixtures/*.mjs` 也当测试跑，挂 276 s），已移到 `desktop/scripts/fake-parametric-sidecar.mjs`
- 验收：P9-2 `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`；P9-3 `SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 已完成（P9-5）：`features.ts` 增加 `PartInstance/AssemblyDoc`、旧文档自动包装、实体级校验与 `compileOps` 双形态；`bom.ts` 合并 partId/未映射名称并生成 UTF-8 BOM CSV 与成本入参；`ui.ts` 装配实体区、BOM 预览、导出 BOM/送成本；`app.py` 可选 `instances`，独立建模后按 X/Y/Z/RZ 放置并合并，返回 `stats.solids` 与每实体体积；假内核支持两实体 smoke
- 实测（P9-5）：`npx tsc --noEmit` 通过；`npm test` **647/647**（新增 `parametric-assembly.test.ts` 25 条 + sidecar 装配 3 条）；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`
- P9-5 边界：BOM 只按实体汇总、不拆特征明细；`partId` 需人工填写；装配为静态多实体合并，不做配合约束/自由度求解（P9-4）

### P10 产品截图更新（本轮，2026-10-23）
- 状态：✅ 已完成
- 内容：新增 `--headless-screenshots` 分支与 `npm run screenshots`（`desktop/scripts/capture-screenshots.mjs`）：xvfb 启真实 Electron，`BrowserWindow.setContentSize(1600,1000)` 后用 `webContents.capturePage()` 抓图；参数化面板由 `AUTOMATIONCAD_PARAMETRIC_CMD=desktop/scripts/fake-parametric-sidecar.mjs` 驱动。
- 新增截图（均为真实 Electron 实跑，非设计稿）：
  - `docs/desktop/screenshots/11-plcgen.png`：预检 0 错误 + 11 文件树 + README 预览，167,125 B；
  - `docs/desktop/screenshots/12-parametric.png`：4 特征树 + 孔位参数 + `面 19 / 体积 71.5 cm³`，152,671 B；
  - `docs/desktop/screenshots/13-cost.png`：9 卡 + 6 行明细 + 缺价 1 项（¥1,398.64），307,220 B；
  - `docs/desktop/screenshots/14-enclosure.png`：3 元件 + 1 处重叠红框/角标，281,093 B。
- 验图：四张均为 1600×1000，PIL 统计颜色数 3,192–6,508、RGB stddev 均 > 14，非单色/空白。
- 说明：xvfb 下 Chromium 把 WebGL 列入 blocklist，CAD 3D 视口显示解析统计降级面板；参数化抽屉与 PLC/成本/底板面板均为真实 DOM/SVG 渲染并已截图，无跳过项。
- 验收：`npm test`、`npm run smoke` 全绿；README 界面一览与图注、`docs/desktop/MODULES.md` 截图索引已同步。

## 待决策（需要老王拍板，不阻塞其他开发）

| # | 问题 | 选项 | 影响 | 建议 | 状态 |
|---|------|------|------|------|------|
| D1 | 价格簿的真实单价从哪来 | A 采购/财务给正式价目表；B 用公开目录价并标注来源；C 先空着只做结构 | 成本报告能否用于报价 | B 先跑通，正式报价前换 A | 待定 |
| D2 | 智慧工厂生产环境谁来部署 0.22.0 | A 对方运维；B 我们远程部署；C 只在测试环境验证 | 端到端联调能否做 | A，我们提供验收清单 | 待定 |
| D3 | PLC 程序生成首期目标平台 | A 通用 ST 优先；B 西门子 S7 优先；C 汇川/三菱优先 | 模板与变量表格式 | A，其次按现场实际 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | A 立项并定义接口；B 先只做数据导出；C 暂缓 | 路线图与汇报口径 | B 过渡，接口按 A 设计 | 待定 |
| D5 | 元件库缺失尺寸（180/371）能否用「同系列壳体推定」 | A 允许并标注推定；B 只用实测/官方值，缺的留空 | 底板布置覆盖率 | A + 标注，人工复核 | 待定 |
| D6 | 参数化建模首期范围 | A 只做单件结构件；B 单件+多体装配；C 直接上草图约束 | 工期（A≈3 周，B≈6 周） | A 先交付，B/C 分期 | 待定 |
| D7 | 成本面板如何拿到 BOM（CAD 零件名 → 元器件物料号映射口径） | A 由底板画布/电气元件库直接给 partId，成本面板只读；B 允许「零件名规则匹配 + 人工确认」自动填 partId；C 保持手工导入 BOM JSON | 影响成本能否一键算；B 需要命名规范（如 `QF1:LC1D09`），否则匹配率低 | A 长期方向，短期用 C + 预留 B | 待定 |
| D8 | Agent 的 `run_cost_report` 是否允许落盘导出报告 | A 保持只读，只回摘要；B 增加写工具 `export_cost_report`（PDF/CSV，走现有二次确认）；C 由面板导出，Agent 只给「点哪里」 | 影响「一句话出报价单」的体验；B 需要确认文件名/目录规则与覆盖策略 | B：`export_cost_report` 固定写 `userData/exports/`，默认不覆盖、冲突追加序号 | 已定 B，已实现（`23cd284`） |
| D9 | 离线规则路由是否要在「模型可用时」也前置生效 | A 仅在模型失败时降级（现状）；B 高置信度只读指令直接走规则，省一次模型调用；C 全走模型 | B 更快更省 token，但规则误判时用户得不到语义纠正，且两套路径要长期保持一致 | A 先稳定；若要 B，先攒 40 条评估集对比准确率再开 | 待定 |
| D10 | 46 条中文评估集用哪条通道跑基线 | A 只用离线规则路由（零成本、可离线、但只覆盖规则能判的句式）；B 规则 + 真实模型双跑（能测语义理解，按 token 付费）；C 只跑模型 | 决定评估结论代表「规则上限」还是「产品上限」；B 需要一把可用的付费/自建模型 key 与预算口径 | A 先立基线并进 CI 友好（无网络），B 作为发布前手动回归 | 待定 |

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决中；STEP 不含运动学，任意装配体仍需标注层。
2. **尺寸数据覆盖不全**：只收录可核实条目，缺失的元件在底板画布上按「未标注尺寸」处理，需人工补。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：3D 为固定等轴测投影，属性编辑不改拓扑（插入与撤销已真实化）。
8. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板只列最近 8 条、无筛选/导出，回执不含 token 用量（网关未回传 usage）。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败
