# 智能体文档历史（不进离线索引）

## 10. 分期

- A（1 周）：只读问答 + 4 个查询/计算工具接入 + 侧栏聊天 + 审计
- B（1 周）：单步写操作（放件、导出）+ 确认机制 + 撤销联动
- C（2 周）：✅ 多步规划（计划预览 / 顺序执行 / 失败停止 / 写步骤一次确认）+ 成本工具
- D（持续）：联调/同步类工具、语音、评估集扩容；主动建议已在 P7-H 落地

## 11. 验收（A 期）

- 10 条典型中文指令在无网络模型下（规则路由）也能正确调用只读工具 —— ✅ 11 条样例覆盖 7 类意图，`SMOKE_AGENT_NL_OK intents=7 tools=20 audit=3 ctx=595`；`SMOKE_AGENT_TOOLS_V2 tools=20`；`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=1`；`SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`；`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=5 undo=1`
- 断网时给出明确提示，不静默失败 —— ✅ 回复以「当前模型不可用，已切换为离线规则路由」开头；写指令仍抛原始网络错误，不执行命令
- 审计文件可查，凭据掩码正确 —— ✅ `<userData>/agent-audit.jsonl`（NDJSON）+ IPC `agent:audit:read`；`sk-live-*`、`Bearer`、`token` 字段在 smoke 中真实落盘后回读校验
- 单测覆盖：意图路由、参数校验、上下文裁剪、审计写入 —— ✅ 全套 1132/1132，其中机型落盘 26 条（`test/agent/apply-machine-design.test.mjs`）、模板 9 条、追问 9 条、PLC 模拟验证 21 条、放置类 21 条（`test/agent/place-component.test.mjs`）、工具扩展 v1 30 条（`test/agent/tools-v2.test.mjs`）
- 侧栏只读问答 UI —— ✅ P7-A-2：输入即出计划预览（只读标「可离线」、写操作标「需联网确认」并点名缺参）、在线/离线共用一张回执（通道·耗时·工具次数·失败数）、审计面板展示最近 8 条与汇总；`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`，预览前后场景零件数不变（当前全套 1132/1132）
- 评估集与回归 —— ✅ 74 条中文用例（20 工具全覆盖 + 6 类拒绝），`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（74/74 意图、74/74 工具、40/40 参数、5/5 超纲拒绝、5/5 多步）；真实模型 36 条评测 `matched=36/36`、`refusalRate=1.00`（见 9.1，含历史三轮迭代与本轮结果）
- 确认与路径策略 —— ✅ 策略层纯函数 + `executeTool` 硬确认 + 拒绝后短路 + 回复话术过滤；导出默认只接受纯文件名，绝对路径/盘符/UNC/`../` 返回 `TARGET_PATH_UNSUPPORTED`，`allowSanitize=true` 才净化落盘；`policy.test.mjs` 42 条，smoke `SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1`
- 底板放置与撤销 —— ✅ P7-B：`place_component` 走命令总线与真实 `window.__Enclosure`，越界/重叠返回 `OVERLAP`/`OUT_OF_BOUNDS` 告警；`undo_last` 回滚并返回 `removed`；smoke `SMOKE_AGENT_PLACE_OK placed=1 undo=1`
- 多步规划 —— ✅ P7-C：`planner.ts` 五类组合 + 通用拆句；未知工具过滤 + warning；置信度 < 0.6 拒绝；`executePlan` 顺序执行、写步骤一次确认、失败立即停止、可撤销写回提示 `undo_last`；侧栏计划卡片支持全部/逐步/取消与逐项打勾；smoke `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`
- 待补：写操作的逐步确认 UI（当前多步计划一次确认；单步模型工具调用仍是一次性弹窗）
- 可复用流程 —— ✅ P7-I：5 个纯数据模板、占位符、前置条件拦截、步骤可跳过、写工具逐次确认（默认）、失败停止保留已完成、Markdown 记录；`SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`
