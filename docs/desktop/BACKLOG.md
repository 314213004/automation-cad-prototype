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
- 状态：⏸ 需老王确认是否动 material-flow 仓库
- 内容：按 `docs/desktop/SMART-FACTORY-INTEGRATION.md` 实现 `/api/v1/design-sync/*`

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
- 状态：🔄 P7-A 第一段 ✅（`424711c`：离线规则路由 + 上下文裁剪 + 审计）；侧栏只读问答 UI 与评估集待做
- 已完成（P7-A-1，`424711c`）：
  - `src/agent/router.ts`：7 类意图关键词计分（写操作同分优先）、`planTool` 中文→工具+参数、`planReadOnly` 只读白名单、类别同义词按长度倒序（热继电器不被继电器吃掉）、`extractQuery` 去客套/动词/疑问词
  - `src/agent/context.ts`：`buildAgentContext` 默认 ≤2048 字节，降级顺序「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」，回报 `bytes/truncated/droppedTools/droppedRecent`
  - `src/agent/audit.ts`：NDJSON 审计、`maskSecrets`（sk-/Bearer/token=/X-Design-Key）、`redactValue` 按字段名脱敏、坏行跳过、写失败不阻断
  - `session.ts`：`llm.chat()` 抛错才降级离线；写指令不执行并抛原错误；每次工具调用（含 `USER_DENIED`/参数非法/离线）写审计
  - `electron/ipc.ts`：审计落 `userData/agent-audit.jsonl`，新增 `agent:audit:read`（最近 50 条 + 汇总）
- 实测（P7-A-1）：`./node_modules/.bin/tsc --noEmit` 通过；`npm test` **457/457**（新增 18 条，覆盖意图/计划/只读隔离/上下文/脱敏/离线降级）；`npm run build:ext` + `npm run smoke` → `SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776`、既有 `SMOKE_AGENT_TOOLS_OK tools=10`／`SMOKE_AGENT_CHAT_UI_OK`／成本四条断言全绿、`SMOKE_OK`
- 下一步：P7-A-2 侧栏只读问答（计划预览 + 在线/离线统一回执 + 审计面板入口）、40 条中文评估集与 `npm run eval:agent`
- 验收（A 期）：`SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3`，误写率 0（写计划不进入离线通道，已有单测钉住）

### P8 设计完成后自动生成 PLC 程序
- 状态：🔄 设计完成（`docs/desktop/PLC-CODEGEN.md`）
- 范围：预检（地址重复/越界/双线圈/安全缺失）→ IO 变量表 + ST 程序块（OB1/气缸 FB/夹爪/轴/自动状态机/报警/安全）→ 导出 zip 与映射表
- 分期：P8-1 预检+变量表+FB → P8-2 序列/报警/安全 → P8-3 UI 与导出 → P8-4 模拟器自检 → P8-5 TIA Openness（可选）
- 验收：demo 机型 9 文件、预检 0 错、三次生成 sha256 一致、模拟器 6 步跑通

### P9 参数化建模（build123d 内核）
- 状态：🔄 已选型 build123d 0.13.0（2026-10-23 拍板），P9-1 sidecar 原型已验证
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 ✅ sidecar+契约（`spike/build123d/app.py`）→ P9-2 ✅ 主进程生命周期/IPC（`9eda660`，388/388、`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`）→ P9-3 特征树 UI → P9-4 草图约束 → P9-5 装配与 BOM/成本联动
- 坑：假内核脚本不能放 `test/` 下（`node --test` 会把 `test/fixtures/*.mjs` 也当测试跑，挂 276 s），已移到 `desktop/scripts/fake-parametric-sidecar.mjs`
- 验收：`SMOKE_PARAMETRIC_OK features=4 faces=19 volume=71495.7`

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

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决中；STEP 不含运动学，任意装配体仍需标注层。
2. **尺寸数据覆盖不全**：只收录可核实条目，缺失的元件在底板画布上按「未标注尺寸」处理，需人工补。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：3D 为固定等轴测投影，属性编辑不改拓扑（插入与撤销已真实化）。
8. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；`agent:audit:read` 尚无面板入口（下一步 P7-A-2）。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败
