# Agent 能力报告

> 生成时间：2026-10-24T02:42:50.185Z · 生成器：`desktop/scripts/agent-report.mjs` · 模型：deepseek-v4.1-flash
> 口径：单轮 = 真实模型 36 条；多轮 = 真实模型 6 个场景；离线 = 规则路由固定用例。缺数据源时写「缺失：<文件>」，不做推断。

## 总览

| 指标 | 数值 | 来源文件 | 生成时间 |
|---|---:|---|---|
| 工具数 | 21 个 | docs/desktop/eval/latest.json#dataset.toolCoverage | 2026-10-24T02:42:02.366Z |
| 测试数 | 1,297 条 | desktop/test/**/*.test.*（`node --test` 实测） | 2026-10-24T02:42:19.334Z |
| 单轮准确率 | 100.0%（36/36） | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 单轮 p50 / p95 | 7,930 ms / 31,291 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 单轮工具 / 确认 / 澄清 | 100.0% / 100.0% / 100.0% | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 多轮准确率 | 100.0%（6/6） | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| 多轮轮次 | 15/15（阈值 80.0%） | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| 多轮 p50 / p95 | 7,028 ms / 15,528 ms | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| 离线意图准确率 | 100.0%（102/102） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |
| 审计条目 | 缺失：/home/sandbox/.config/AutomationCAD/agent-audit.jsonl | 缺失：/home/sandbox/.config/AutomationCAD/agent-audit.jsonl | 缺失 |

## 分组表现（真实模型单轮）

| 分组 | 通过 / 总数 | 准确率 | p50 | p95 | 来源文件 | 生成时间 |
|---|---:|---:|---:|---:|---|---|
| 查询 | 8 / 8 | 100.0% | 6,604 ms | 10,396 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 操作 | 10 / 10 | 100.0% | 6,770 ms | 21,795 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 流程 | 6 / 6 | 100.0% | 11,823 ms | 20,365 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 拒绝/澄清 | 6 / 6 | 100.0%（拒绝率 100.0%） | 6,468 ms | 12,855 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |
| 机型 | 6 / 6 | 100.0% | 23,902 ms | 37,772 ms | docs/desktop/eval/agent-live.json | 2026-10-23T16:23:29.180Z |

## 离线评测（规则路由）

| 指标 | 结果 | 来源文件 | 生成时间 |
|---|---:|---|---|
| 意图 | 100.0%（102/102） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |
| 工具 | 100.0%（102/102） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |
| 参数 | 100.0%（53/53） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |
| 超纲拒绝 | 100.0%（7/7） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |
| 多步 | 100.0%（5/5） | docs/desktop/eval/latest.json | 2026-10-24T02:42:02.366Z |

## 多轮场景

| 场景 | 结果 | 轮次 | 来源文件 | 生成时间 |
|---|---:|---:|---|---|
| MT01 改型号 → 撤销 → 改数量 | ✅ 通过 | 3/3 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| MT02 改数量 → 撤销 → 改备注 | ✅ 通过 | 3/3 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| MT03 跨轮「刚才那个件」 | ✅ 通过 | 2/2 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| MT04 拒绝后不自动重试 | ✅ 通过 | 2/2 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| MT05 确认超时后续跑 | ✅ 通过 | 2/2 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |
| MT06 工程变化后重新读取 | ✅ 通过 | 3/3 | docs/desktop/eval/agent-multiturn.json | 2026-10-23T14:10:28.129Z |

## 能力清单

> 验证方式中的 eval 数字沿用总览/分组表来源：单轮 `agent-live.json`、多轮 `agent-multiturn.json`、离线 `latest.json`（生成时间见对应表格）。
| 能力 | 对应模块文件 | 验证方式 | 状态 |
|---|---|---|---|
| 列出元件（按类别 / 数据包）<br>`list_components` | desktop/src/agent/tools.ts | 单测 agent/tools.test.mjs；smoke SMOKE_AGENT_TOOLS_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 按型号 / 品牌 / 类别搜索元件<br>`search_components` | desktop/src/agent/tools.ts | 单测 agent/tools.test.mjs；smoke SMOKE_AGENT_TOOLS_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 本地知识检索（离线 RAG）<br>`search_docs` | desktop/src/agent/kb/search.ts | 单测 agent/kb.test.mjs；smoke SMOKE_AGENT_KB_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 自然语言机型方案合成<br>`design_machine` | desktop/src/machine/synth.ts | 单测 agent/design-machine.test.mjs；smoke SMOKE_MACHINE_DESIGN_OK；eval 离线评估 | ✅ 已实现 |
| 机型方案落盘（3D / BOM / PLC 联动，可撤销）<br>`apply_machine_design` | desktop/src/machine/store.ts | 单测 agent/apply-machine-design.test.mjs；smoke SMOKE_MACHINE_APPLY_OK；eval 离线评估 | ✅ 已实现 |
| 导入 CAD 文件<br>`import_cad` | desktop/src/agent/tools.ts | 单测 agent/tools-v2.test.mjs；smoke SMOKE_AGENT_TOOLS_V2；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 读取当前装配体 BOM<br>`get_bom` | desktop/src/agent/tools.ts | 单测 agent/tools.test.mjs；smoke SMOKE_AGENT_TOOLS_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 工程上下文快照<br>`get_project_context` | desktop/src/agent/context.ts | 单测 agent/context-memory-trim.test.mjs；smoke SMOKE_AGENT_CONTEXT_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 包围盒干涉初筛<br>`run_interference_check` | desktop/src/mech/interference.ts | 单测 mech/interference.test.mjs；smoke SMOKE_AGENT_TOOLS_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 插入标准件占位件<br>`insert_component` | desktop/src/agent/tools.ts | 单测 agent/tools.test.mjs；smoke SMOKE_AGENT_TOOLS_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 底板放置（坐标 / 旋转 / 导轨吸附）<br>`place_component` | desktop/src/agent/placement.ts | 单测 agent/place-component.test.mjs；smoke SMOKE_AGENT_PLACE_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 修改型号 / 数量 / 备注<br>`update_component` | desktop/src/agent/tools.ts | 单测 agent/tools-v2.test.mjs；smoke SMOKE_AGENT_TOOLS_V2；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 移除底板 / BOM 元件<br>`remove_component` | desktop/src/agent/tools.ts | 单测 agent/tools-v2.test.mjs；smoke SMOKE_AGENT_TOOLS_V2；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 电气校验（线号 / 载流 / 断路器）<br>`run_electrical_check` | desktop/src/elec/check.ts | 单测 agent/elec-check.test.mjs；smoke SMOKE_ELEC_CHECK_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 硬件成本统计<br>`run_cost_report` | desktop/src/cost/agent.ts | 单测 cost-agent.test.ts；smoke SMOKE_COST_AGENT_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 成本报告落盘（PDF / CSV）<br>`export_cost_report` | desktop/src/cost/export.ts | 单测 cost-export.test.ts；smoke SMOKE_COST_AGENT_EXPORT_OK；eval 单轮真实模型 | ✅ 已实现 |
| PLC 程序模拟验证<br>`verify_plc_program` | desktop/src/plcgen/verify.ts | 单测 plcgen.test.ts；smoke SMOKE_PLCGEN_SIM_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| PLC 工程生成（11 文件 + ZIP）<br>`run_plc_generate` | desktop/src/plcgen/generate.ts | 单测 plcgen.test.ts；smoke SMOKE_PLCGEN_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 装配体导出（PDF / DXF / GLB / BOM）<br>`export_files` | desktop/src/export/file.ts | 单测 agent/tools-v2.test.mjs；smoke SMOKE_EXPORT_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 撤销最近一次写操作<br>`undo_last` | desktop/src/agent/commands.ts | 单测 agent/place-component.test.mjs；smoke SMOKE_AGENT_PLACE_OK；eval 离线评估 + 单轮真实模型 | ✅ 已实现 |
| 离线意图路由（7 类意图）<br>`offline-router` | desktop/src/agent/router.ts | 单测 agent/nl-router.test.mjs；smoke SMOKE_AGENT_NL_OK；eval 离线评估 | ✅ 已实现 |
| 多步规划与执行<br>`planner` | desktop/src/agent/planner.ts | 单测 agent/planner.test.mjs；smoke SMOKE_AGENT_PLAN_OK；eval 离线评估 | ✅ 已实现 |
| 多轮状态 / 续跑 / 拒绝记忆<br>`multi-turn` | desktop/src/agent/thread.ts + session.ts | 单测 agent/thread.test.mjs；smoke SMOKE_AGENT_THREAD_OK；eval 多轮真实模型 | ✅ 已实现 |
| 写确认 / 路径策略 / 绕过拦截<br>`security-policy` | desktop/src/agent/policy.ts + session.ts | 单测 agent/policy.test.mjs；smoke SMOKE_AGENT_POLICY_OK；eval 单轮真实模型 | ✅ 已实现 |
| 工具结果抗提示注入<br>`guard` | desktop/src/agent/guard.ts | 单测 agent/guard.test.mjs | ✅ 已实现 |
| 工具审计（NDJSON / 脱敏）<br>`audit` | desktop/src/agent/audit.ts + electron/ipc.ts | 单测 agent/ux.test.mjs；smoke SMOKE_AGENT_UX_OK；eval 审计文件 | ✅ 已实现 |
| 上下文预算与 token 成本<br>`budget` | desktop/src/agent/budget.ts + pricing.ts | 单测 agent/budget.test.mjs；smoke SMOKE_AGENT_BUDGET_OK | ✅ 已实现 |
| 同轮去重 / 只读并行 / 会话缓存<br>`efficiency` | desktop/src/agent/dedupe.ts + parallel.ts + cache.ts | 单测 agent/efficiency.test.mjs；smoke SMOKE_AGENT_EFFICIENCY_OK | ✅ 已实现 |
| 可复用流程模板<br>`recipes` | desktop/src/agent/recipes.ts | 单测 agent/recipes.test.mjs；smoke SMOKE_AGENT_RECIPE_OK | ✅ 已实现 |
| 主动建议（next-best-action）<br>`advisor` | desktop/src/agent/advisor.ts | 单测 agent/advisor.test.mjs；smoke SMOKE_AGENT_ADVISOR_OK | ✅ 已实现 |
| 工具调用纠错与重试<br>`repair` | desktop/src/agent/repair.ts + retry.ts | 单测 agent/repair.test.mjs；smoke SMOKE_AGENT_REPAIR_OK | ✅ 已实现 |
| 真实模型单轮评测<br>`live-eval` | desktop/scripts/agent-live.mjs | eval 单轮真实模型 | ✅ 36/36 |
| 真实模型多轮评测<br>`multiturn-eval` | desktop/scripts/agent-multiturn.mjs | eval 多轮真实模型 | ✅ 6/6 |

## 已知缺口（从 BACKLOG 自动摘取）

- BOM 需手工导入 JSON（或上层注入 `__CostBomProvider`），未做 CAD 零件名 → 元器件物料号映射；Agent 工具未传 `bom` 时用场景简化 BOM，零件无物料号 → 全部计入缺价（不按 0 计价）；面板 CSV 仍走系统保存对话框，Agent 导出固定写 `userData/exports/` 且不弹框（来源：`docs/desktop/BACKLOG.md:77`，生成时间：2026-10-24T02:42:18.968Z）
- **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决；STEP 不含运动学，任意装配体仍需标注层。36-auto-kinematics 起可按名称/型号/层级/几何自动给出标注**建议**（需逐条确认），但识别是启发式：命名不规范或几何不典型的机构仍需人工标注，斜向运动只能取最近主轴，夹爪对侧手指、缩回位与无型号行程仍需人工确认。 迭代 34 起机型方案的 3D 改为参数化整机几何，但仍是标准件外形，不是结构设计。（来源：`docs/desktop/BACKLOG.md:191`，生成时间：2026-10-24T02:42:18.968Z）
- **真实模型拒绝/澄清类**：已从 4/6 修到 6/6（判定语义修正 + 两条系统提示）；但仍是单模型单轮结果，换模型或换措辞需重跑 `npm run agent:live`，不要把 30/30 当成通用结论。（来源：`docs/desktop/BACKLOG.md:198`，生成时间：2026-10-24T02:42:18.968Z）
- **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板最多显示最近 200 条（可筛选/导出），回执不含 token 用量（网关未回传 usage）。 **2026-10-24 更新（feat/agent-audit-router）**：① 审计已按大小轮转 + 保留期清理（默认 5 MB × 5 份 × 90 天，可配置），面板/报告读全部保留份数；被保留期删除的份数不可恢复，CSV 仍只导出面板当前列表（≤200 条）。② 路由已系统补同义/口语词并加非工程话题拦截（评估集 102 条）；仍是关键词规则：未收录的说法照旧判超纲，「撞」「会动」「规划」等单字/泛词可能把边缘句子拉进工程意图，非工程话题表是有限枚举。回执 token 用量问题未变。（来源：`docs/desktop/BACKLOG.md:199`，生成时间：2026-10-24T02:42:18.968Z）
- **多轮评测证据仍是 5/6**：`docs/desktop/eval/agent-multiturn.json`（Fri 2026-10-23 8:28 PM CST (UTC+08:00)）中 MT04「拒绝后自动重试」两轮未过；会话层拒绝记忆已修复，但尚未有新的真实模型多轮 JSON，报告按现有证据展示，重跑 `npm run eval:agent:multiturn` 后再更新。 **2026-10-24 更新**：上述描述已过时——仓库内 `agent-multiturn.json` 已是修复后的真实模型结果（`cn:deepseek-v4.1-flash`，生成于 Fri 2026-10-23 10:08 PM CST (UTC+08:00)，6/6 场景、15/15 轮，MT04 通过），Agent 报告按此展示。本轮补了 `test/agent/multiturn-mt04.test.mjs` 会话层确定性回归（fake LLM 回放 MT04：原样重试与 `partId` 写法重试都被短路、不弹确认）。本机无 `AGENT_LIVE_BASE_URL/API_KEY/MODEL`，**真实模型重跑待有 key 时执行**（换模型/换措辞仍需重跑，单模型单次结果不是通用结论）。遗留边界：拒绝记忆按「工具 + 目标」匹配，模型若在「继续」后改用别的写工具动同一目标（如 `remove_component QF1`）仍会走确认框，真实评测会算违规。（来源：`docs/desktop/BACKLOG.md:200`，生成时间：2026-10-24T02:42:18.968Z）

## 缺失数据源

- 缺失：/home/sandbox/.config/AutomationCAD/agent-audit.jsonl（userData 路径不可达：/home/sandbox/.config/AutomationCAD）

## 审计摘要

- 缺失：/home/sandbox/.config/AutomationCAD/agent-audit.jsonl
- 原因：userData 路径不可达：/home/sandbox/.config/AutomationCAD
- 已跳过审计统计，不影响其余报告。

---
本报告由 `npm run agent:report` 生成；所有评测数字均来自上述源文件，生成后脚本会读回 JSON 并逐项比对。
