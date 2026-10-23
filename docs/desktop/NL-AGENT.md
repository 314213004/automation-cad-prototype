# 自然语言交互 Agent · 完整设计方案

状态：P7-A 已完成（离线规则路由 / 上下文裁剪 / 审计 / 只读问答 UI / 评估集）；P7-B 已完成（`place_component` 底板放置 + 二次确认 + 撤销联动，评估集扩至 46 条）；P7-C 已完成（离线多步规划 + 计划卡片 + 顺序执行 + 失败停止）；P7-D 已完成（Agent 工具扩展 v1，12 → 17 个工具）；P7-E 已完成（上下文快照 / 指代消解 / 会话记忆 / 结果裁剪）；P7-F 已完成（执行进度 / 取消 / 失败建议 / 审计筛选与导出）
目标：用户用中文一句话完成「查、算、改、出图、联调、同步」，不必记菜单路径；Agent 不替代界面，而是并行的快捷通道。

## 1. 设计边界

做什么：
- 理解工程语境下的中文指令（含省略、指代、单位、方言式说法）
- 调用已有模块的**结构化能力**（元件库、BOM、电气校验、成本、干涉、导出、同步、联调）
- 多步任务编排（查件 → 放置 → 校验 → 出报告）
- 解释结果（为什么报错、怎么改）

不做什么：
- 不直接操作 DOM / 不模拟鼠标点击
- 不执行 shell、不读写任意路径
- 不代替人做安全/合规决策（改线号规则、改报价策略需人确认）
- 不上传图纸或整份文档到外部模型（只发结构化摘要，可关闭）

## 2. 总体架构

```
[用户输入]
   │  聊天侧栏 / 命令面板 / @对象 / 语音(后期)
   ▼
[会话层 Session]  上下文注入 + 指代消解 + 权限
   ▼
[规划层 Planner]  意图分类 → 任务分解 → 工具序列(dry-run)
   ▼
[执行层 Executor] 工具调用 + 参数校验 + 结果聚合
   ▼
[工具层 Tools]   纯函数 API（无 UI 依赖，可单测）
   ▼
[回执层 Responder]  结构化结果 → 中文说明 + 可点击跳转 + 审计记录
```

关键约束：**工具层必须是唯一写入口**，UI 与 Agent 共用同一套 API，避免两套逻辑漂移。

## 3. 工具清单（已实现 17 个：只读 8 + 写 9；另 3 个规划中）

| 工具 | 类型 | 说明 |
|---|---|---|
| `list_components` | 只读 | 按类别 / 数据包列出元件 |
| `search_components` | 只读 | 型号、品牌、类别、规格全文检索 |
| `get_bom` | 只读 | 当前装配体简化 BOM |
| `get_project_context` | 只读 | 当前域 / 视图 / 选中对象 / 机型 / 底板 / 单位制 / 最近操作；缺失项返回 null |
| `run_interference_check` | 只读 | 包围盒干涉初筛 |
| `run_electrical_check` | 只读 | 线号 / 功率 / 截面 / 断路器校验 |
| `run_cost_report` | 只读 | 按 BOM 与价格簿计算成本 |
| `verify_plc_program` | 只读 | 预检 + 生成 + 内置模拟器跑联调序列，返回步骤/报警/失败原因；不落盘、不写 PLC |
| `import_cad` | 写 | 导入 CAD 文件（需确认） |
| `insert_component` | 写 | 插入装配体占位件（需确认，可撤销） |
| `place_component` | 写 | 底板指定坐标放置（旋转 / 导轨吸附；越界/重叠只告警；需确认，可撤销） |
| `update_component` | 写 | 按 partId / 位号修改型号 / 数量 / 备注；新型号不存在返回 `PART_NOT_FOUND`，新件无尺寸返回 `NO_DIMENSIONS` 告警（需确认，可撤销） |
| `remove_component` | 写 | 按位号 / partId 从底板或 BOM 移除；不存在返回 `NOT_PLACED`（需确认，可撤销） |
| `run_plc_generate` | 写 | 按当前机型生成 11 个 PLC 工程文件 + ZIP，落盘到 `userData/exports/plc/<机型>-<时间>/`；预检有 error 返回 `PRECHECK_FAILED` 且不落盘（需确认） |
| `export_files` | 写 | 导出 PDF / DXF / GLB / BOM(CSV) 到 `userData/exports/`，默认不覆盖（需确认） |
| `export_cost_report` | 写 | 成本报告落盘 PDF/CSV（需确认） |
| `undo_last` | 写 | 撤销最近一次可撤销写操作（需确认） |

规划中但尚未注册：`start_commission`（启动联调）、`diagnose_fault`（按点位/报警码给建议）、`sync_design_package`（打包上传，需确认并明文展示 deviceId/baseUrl）。未注册的工具不会进入可执行计划。

已实现的成本工具：`run_cost_report`（只读，见 COSTING.md 4.2）与 `export_cost_report`（写，PDF/CSV 落盘到 `userData/exports/`，见 COSTING.md 4.3）。PLC 模拟验证：`verify_plc_program`（只读，复用 `verifyGenerated`，见 PLC-CODEGEN.md 13）；PLC 工程落盘：`run_plc_generate`。通用导出 `export_files` 与 `export_cost_report` 共用 `src/cost/export.ts` 的文件名净化、扩展名强制、冲突序号和目录逃逸检查。

每个工具：JSON Schema 入参（顶层 `additionalProperties: false`）、结构化返回、稳定 `error.code` 与中文消息。

### 写操作分级

| 级别 | 范围 | 约束 |
|---|---|---|
| 只读 | 8 个查询/计算/验证工具 | 可离线直接执行，不产生副作用；`get_project_context` 缺失项必须返回 null |
| W1 可撤销装配写 | `insert_component`、`place_component`、`update_component`、`remove_component` | 执行前二次确认；成功后写入撤销栈，`undo_last` 恢复插入件 / 放置 / 型号与备注 / 被移除元件 |
| W2 文件写 | `import_cad`、`run_plc_generate`、`export_files`、`export_cost_report` | 执行前二次确认；导入只读用户明确给出的 CAD 路径，导出固定写入 `userData/exports/`，不接受任意写入路径，文件名走统一净化与冲突策略 |
| W3 外部副作用 | 规划的 `start_commission` / `sync_design_package` | 除二次确认外，还需明文展示目标地址与机台编号 |

`undo_last` 本身也走确认，但只回滚栈顶的一条可撤销写，不会删除文件或撤销外部操作。

稳定错误码：`INVALID_ARGUMENT`（缺参/类型错误）、`PART_NOT_FOUND`（新型号不在数据包）、`NOT_PLACED`（删除目标不在底板/BOM）、`PRECHECK_FAILED`（PLC 预检错误，不落盘）、`UNSUPPORTED_FORMAT`（导出格式不在白名单）、`WRITE_FAILED` / `EXPORT_FAILED`（落盘与内容生成失败）。

## 4. 上下文注入与指代消解（已实现）

每次会话固定注入 `AgentContext` 快照（序列化 ≤1.5 KB，`CONTEXT_BYTE_LIMIT=1536`）：
- `domain`：`mech` / `elec` / null；`view`：装配、底板、原理图等当前视图
- `selection`：`{ kind: 'component'|'mesh'|'placement'|'feature', id, label }`；依次采集底板选中 placement、运动学选中网格、参数化选中特征、CAD 选中零件
- `machine`：机型名、工位数、执行机构数、传感器数
- `plate`：底板宽高、已放置数、重叠数；可附 placement 列表供几何指代
- `recentActions`：最近 3 条工具操作（工具名、摘要、时间），摘要可带 `[target=kind:id:label]` 供指代回退
- `units`：固定 `mm`

采集入口是 `desktop/src/agent/context.ts` 的 `collectAgentContext()`：每个 provider 单独 `try/catch`，采集失败字段为 null，不抛错、不新增全局单例。`serializeAgentContext()` 超限时按「删旧 recentActions → 压长字段 → UTF-8 码点边界硬截断」降级，并回报 `bytes / truncated / droppedRecent`。历史调用方仍可用 `buildAgentContext()` 的工具清单文本块（同样受 1.5 KB 上限约束）。

**指代优先级**（`desktop/src/agent/reference.ts` 的纯函数 `resolveReference(text, ctx)`）：
1. `这个 / 它 / 刚才那个 / 选中的` → 当前 `selection`（置信度 0.95）；
2. 其次最近一次带对象标记的 `recentActions`（0.72）；
3. `左边第二个 / 上面那个 / 第 N 个` → 按 placement 几何排序取第 N 个（左边 x 升序、右边 x 降序、上面 y 升序、下面 y 降序；0.78）；
4. 无候选 → `NO_CANDIDATES`；对象信息不足 → `LOW_CONFIDENCE`。**低于 0.6 一律返回 null，由调用方追问一次，不猜对象。**

路由接入：`planTool` / `planToolSequence` / `planReadOnly` 接受可选 `AgentContext`，命中指代时补全对象参数，并在计划步骤上标 `resolvedFrom: 'selection'|'recent'|'geometry'` 与 `resolvedLabel`。侧栏计划预览与步骤卡片显示「已使用选中对象：QF1」这类依据；会话系统提示同时注入上下文快照与会话内记忆。

会话内记忆（`desktop/src/agent/memory.ts`）只保留最近 5 次工具调用（工具名、关键参数、结果码），滚动丢弃，不落盘、不上传，并追加在系统提示末尾。工具结果进入模型前统一经 `desktop/src/agent/trim.ts` 裁剪：列表 >20 条保留前 20 + `total` + `truncated:true`，长文本按 2 KB 截断，单个结果硬上限 10 KB。

冒烟：`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`；单测覆盖采集容错、1.5 KB 体积、指代优先级、几何排序、低置信不猜、记忆滚动、UTF-8 截断与 10 KB 封顶。

## 5. 意图分类与路由

一级意图（规则 + 小模型分类，不依赖大模型也能跑）：
1. 查询（有哪些、多少钱、在哪、参数是多少）
2. 计算（够不够、合不合规、成本多少、干涉没有）
3. 修改（放一个、改线号、换型号、删掉）
4. 生成（出图、出 BOM、出报告）
5. 联调（上电、跑序列、查故障）
6. 同步（上传设计包、看版本差）
7. 闲聊/超纲 → 明确说「这个我做不了」并给替代路径

多步任务：Planner 输出 `[{tool, args, why}]`，执行前展示「我准备做这 3 步」，写操作逐步确认（可设置「本次全部允许」）。

已实现（`desktop/src/agent/router.ts`，规则层，不依赖模型）：
- `routeIntent()` 关键词计分判 7 类（含 `out_of_scope`），同分按 `modify > generate > sync > commission > compute > query` 裁决；
- `planTool()` 把中文指令映射成 `{tool, args, readOnly, missing, why}`：先判写（导出成本报告/底板放置/插入/撤销/导入），再按「干涉 → 电气校验 → 成本 → BOM → 元件」由具体到泛；类别同义词（空开→断路器、热继→热继电器、触摸屏→HMI）按长度倒序匹配；
- `placement.ts` 从「放/摆/加 + 型号 + 在 x, y」抽取 `partId/x/y/rotate/railSnap`；路由只填型号候选，工具层再做唯一模糊匹配，多义回 `AMBIGUOUS` 并列出候选；
- `planReadOnly()` 只放行 `READ_ONLY_TOOLS` 内的计划；`session.run()` 仅在 `llm.chat()` 抛错时降级到它，写操作一律不执行并如实报错；
- 未命中任何关键词 → `out_of_scope`，回「这个我做不了 + 可问范围」，不猜。

### 5.1 规划器实现与限制（P7-C）

`desktop/src/agent/planner.ts` 提供两个纯函数，不依赖模型、网络、DOM 或 Electron：

```ts
plan(input, context?) → {
  steps: Array<{ tool, args, why, readOnly, missing? }>,
  confidence: number,          // 0–1
  refused?: boolean,
  reason?: string,
  suggestions?: string[],
  warnings?: string[]
}

executePlan(plan, deps) → {
  ok, confirmationRequired, confirmed, cancelled?, refused?,
  failedAt?, failedIndex?, failedTool?,
  results: Array<{ index, step, tool, ok, code, message?, elapsedMs, data? }>,
  totalMs, summary, undoHint?
}
```

规则组合（全部离线）：

| # | 场景 | 有序工具 | 说明 |
|---|---|---|---|
| 1 | 查件 → 放置 → 校验 | `search_components` → `place_component` → `run_electrical_check` | 从「放到 x, y」抽取坐标；型号不唯一时由工具层回 `AMBIGUOUS`，规划器不猜 |
| 2 | 查 BOM → 成本 → 导出 | `get_bom` → `run_cost_report` → `export_cost_report` | 导出格式按 `CSV/表格` 判 CSV，否则 PDF；导出步骤为写操作 |
| 3 | 导入 CAD → 干涉 | `import_cad` → `run_interference_check` | 支持 Windows 绝对路径；受力校核暂无注册工具，只记 warning |
| 4 | 生成 PLC → 模拟验证 | `verify_plc_program` | 该只读工具一次完成预检、生成与内置模拟器验证，不落盘、不写 PLC |
| 5 | 生成设计包 → 上传 | `sync_design_package` | 外部副作用，需确认；当前工具尚未注册，默认会被过滤并拒绝执行 |

通用多步补充：含「然后 / 接着 / 之后 / 最后 / 并且 / 同时 / 再 / 并」的指令会逐句调用 `planTool()`；任何一句落空都整单拒绝，避免做一半。单句仍回落到 `planTool()`。

工具清单（以 `tools.ts` 注册表为准）：
- 只读 8：`list_components`、`search_components`、`get_bom`、`get_project_context`、`run_interference_check`、`run_electrical_check`、`run_cost_report`、`verify_plc_program`
- 写 9：`import_cad`、`insert_component`、`place_component`、`update_component`、`remove_component`、`run_plc_generate`、`export_files`、`export_cost_report`、`undo_last`
- 规划中但未注册：`start_commission`、`diagnose_fault`、`sync_design_package`；未注册前不会进入可执行计划

工具名与过滤：
- 默认工具集合来自 `router.ts` 的 `READ_ONLY_TOOLS + WRITE_TOOLS`，与 `tools.ts` 当前 17 个注册工具一致；IPC/UI 调用时传入实时 `AgentTools.summaries()` 名称。
- 规划阶段逐条校验工具名；不存在的工具从步骤中移除并写入 `warnings`（例如 `忽略未注册工具 sync_design_package（第 1 步）`）。全部被过滤时 `refused:true`，不会执行空计划。
- 不编造工具名；`sync_design_package` 注册后无需改规划规则即可自动纳入。

拒绝策略：
- 规则不命中：`confidence=0.2`、`refused:true`，附 5 条可执行示例；
- 置信度 `< 0.6`（可用 `context.minConfidence` 抬高）：`refused:true`，`reason` 写明阈值；
- 拒绝时 `steps` 必为空，执行器与 UI 都不得调用任何工具。

执行器语义：
- 只读步骤直接执行；计划含写步骤时，在执行前用 `confirmPlan({message,steps,writeIndexes,totalSteps})` **汇总一次**并请求确认，拒绝则零执行；
- 严格按 `steps` 顺序 `await`；任一步返回 `ok:false`、业务错误码或抛异常即停止，后续步骤不执行；
- 每步记录 `elapsedMs` 与结果码（成功 `OK`，失败保留业务码，异常归一为 `TOOL_EXCEPTION`）；
- 若有可撤销装配写（`insert_component`/`place_component`）已成功，回执带 `undoHint`：「已执行的装配写操作可用 undo_last 回退」；
- 支持 `deps.startAt / deps.maxSteps` 逐步执行，UI「逐步执行」每次只推进下一步，执行完逐步打勾，失败标红并显示错误码与原因。

限制（当前明确不做）：
- 不做输出串联：`search_components` 的候选不会自动回填到 `place_component.partId`；型号不唯一时仍由工具层要求用户指定。
- 规划器不调用大模型，不处理自由文本里的隐含指代；复杂任务由在线模型的工具调用循环承接。
- 「生成设计包 → 上传」等联调/同步工具尚未注册；规划层只给 warning/refusal，不伪造执行结果。「导出全部文件」已由 `export_files` 提供，可用 `kind=pdf|dxf|glb|bom` 选择格式。
- 受力校核没有注册工具，CAD 组合到此为止（导入 + 干涉初筛）。

UI 与 IPC：
- 输入多步指令时，侧栏在单步预览下方显示计划卡片：步骤序号、工具、参数 JSON、为什么、缺参、只读/写标记；
- 按钮「全部执行」「逐步执行」「取消」；执行中当前步显示 `…`，成功 `✓`，失败 `×` 并给原因；
- `agent:plan:execute` 在主进程再次校验工具名与步骤结构，弹一次「多步计划确认」，并写审计（source=`plan`）。

## 6. 安全与权限

- **写操作分级**：只读默认放行；可撤销装配写（`insert_component`、`place_component`）与文件写（`import_cad`、`export_cost_report`）需确认，前者进入撤销栈；影响对外系统（上传、下发 PLC）需二次确认并显示目标地址
- **路径白名单**：仅项目工作区与用户数据目录
- **审计**：每次工具调用写 `agent-audit.jsonl`（时间、工具、参数摘要、结果码），可在设置页查看/导出
- **敏感信息**：`X-Design-Key` 等凭据不出现在日志与回执里，只显示掩码
- **失败兜底**：模型故障或超时 → 降级为「只读建议」模式，不执行写操作

## 7. 模型接入

- 通道：本机 JSON-RPC `127.0.0.1:7420`（Bearer）+ MCP stdio（供外部 Agent 调用）
- 模型：可配置本地（llama.cpp / Ollama）或远程 OpenAI 兼容端点；按任务路由（分类用小模型、规划用大模型）
- 工具调用协议：OpenAI tools schema；对不支持 function calling 的模型走「JSON 文本 + 解析 + 重试一次」
- 上下文预算：系统提示 ≤1.5k tokens，工具结果按需截断（列表类只回前 20 条 + 总数）
- 离线优先：无网络时仍可用规则路由完成「查件、算成本、跑校验」这些确定性任务

## 8. 交互形态

1. **侧栏聊天**（主）：右侧抽屉，支持工具执行进度、结果卡片（表格/图片/文件）与取消
2. **命令面板**（快）：`Ctrl+K` 模糊搜索 + 自然语言混合，回车即执行只读命令
3. **@ 对象**：在画布/原理图上选中元件后 `@`，指令自动带上该对象
4. **语音**（后期）：本地 STT，仅对白名单指令生效
5. **主动建议**（后期）：检测到「未绑点位」「缺价」「干涉」时在状态栏提示，一键让 Agent 处理

### 8.1 执行反馈（P7-F）

工具调用通过主进程 `agent:progress` 事件逐条推送到侧栏，在线模型与离线规则共用同一套字段：

| 阶段 | 侧栏表现 |
|---|---|
| 执行前 | 「正在执行 `tool` · 第 n/N 步」+ 参数摘要；参数按字段名与裸文本双重脱敏，长值截断 |
| 执行中 | 每 500 ms 刷新秒表；超过 10 s 追加「仍在执行，可取消」 |
| 完成 | 结果卡片：`✓` 成功 / `×` 失败 + 耗时 + 结果码；连续 3 步追加「连续 3 步汇总耗时」 |
| 取消 | 侧栏「取消执行」→ `agent:chat:cancel` / `agent:plan:cancel` → `AbortController.abort()`；会话与计划执行器都在步骤边界检查信号 |

取消文案不把未知状态说成安全：确认没有写步骤时输出「已取消，未写入任何更改」；已有写步骤完成时列出「第 n 步 tool（成功）」，并提示可撤销的装配写可用 `undo_last`；当前写工具被中断但结果未知时明确要求先核对装配体/文件。

### 8.2 失败建议（P7-F）

`src/agent/suggest.ts` 是纯函数 `{code, message, tool, args} → {advice, alternatives}`，失败卡片与多步计划都复用：

| 错误码 | 建议口径 |
|---|---|
| `PART_NOT_FOUND` | 先 `search_components`，给出型号关键词，并检查数据包是否启用 |
| `NO_DIMENSIONS` | 换带尺寸的同系列型号，或到元件库补录 `dims{w,h,d}` |
| `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` | 分别检查对应服务（如 Python sidecar）或启动桌面应用、7420 端口与 token 文件 |
| `PRECHECK_FAILED` | 引用结果里的第一条错误，并按点位/执行机构/传感器指向修复位置；强调未落盘 |
| `USER_DENIED` | 明确未执行、装配体与文件未改动，并说明重新发起与点「允许」的路径 |
| 未知码 | 只复述错误码与消息，明确「无法判断具体原因」，不编造原因 |

### 8.3 审计面板（P7-F）

- 列表列：时间、工具、参数摘要、结果码、耗时；按时间倒序。
- 按工具与结果（全部 / 仅成功 / 仅失败）筛选；导出当前筛选结果为 CSV，文件名走统一 `sanitizeFileName`，内容带 UTF-8 BOM。
- 单条展开显示完整 JSON；整条记录再次递归脱敏，历史记录里的裸密钥也不会重新出现在界面或导出文件。
- 最多展示最近 200 条；更早记录丢弃并在面板提示数量。审计文件本身仍只追加保留。

## 9. 质量评估

固定 46 条中文用例，位于 `desktop/eval/agent-cases.json`：覆盖 7 类意图，其中 16 条含指代、7 条歧义、5 条多步、5 条超纲；新增 6 条底板放置用例（精确型号、多义型号、缺尺寸件、越界坐标、缺参）。工具名以 `desktop/src/agent/tools.ts` 的注册表为准，评估脚本会拒绝不存在的工具名。多步用例用 `expect.steps` 描述有序工具序列，单步用例用 `expect.tool + expect.argsContains`。

在 `desktop/` 下运行：

```bash
npm run eval:agent
```

脚本只调用离线规则路由（`routeIntent` / `planTool` / `planToolSequence`），不联网、不调模型；输出逐条表格，并把时间戳、版本、阈值、汇总指标与逐条明细写入 `docs/desktop/eval/latest.json`。每次改提示词、规则或工具 schema 都必须跑。

指标与门禁：
- 意图准确率 ≥ 90%（设计目标 95%）
- 工具选择正确率 ≥ 85%（设计目标 90%）
- 参数抽取准确率 ≥ 90%（编号、型号、类别、格式、路径）
- 多步任务完成率 ≥ 80%
- 超纲拒绝率 = 100%（超纲不得产生任何工具计划）
- 误写率 = 0（未确认的写操作一律视为失败）

任一指标低于上述阈值时脚本退出码为 1；当前离线基线（2026-10-23，v0.2.0）：

```
意图准确率   100.0%  (46/46)
工具选择率   100.0%  (46/46)
参数抽取率   100.0%  (20/20)
超纲拒绝率   100.0%  (5/5)
多步完成率   100.0%  (5/5)
EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00
```

说明：联调/同步工具尚未注册，评估集把这两类记为 `tool: null`，规则层必须明确说“暂不支持”，不能误落到 `search_components`；歧义用例同样要求不调用工具并追问。

## 10. 分期

- A（1 周）：只读问答 + 4 个查询/计算工具接入 + 侧栏聊天 + 审计
- B（1 周）：单步写操作（放件、导出）+ 确认机制 + 撤销联动
- C（2 周）：✅ 多步规划（计划预览 / 顺序执行 / 失败停止 / 写步骤一次确认）+ 成本工具
- D（持续）：联调/同步类工具、主动建议、语音、评估集扩容

## 11. 验收（A 期）

- 10 条典型中文指令在无网络模型下（规则路由）也能正确调用只读工具 —— ✅ 11 条样例覆盖 7 类意图，`SMOKE_AGENT_NL_OK intents=7 tools=17 audit=3 ctx=541`；`SMOKE_AGENT_TOOLS_V2 tools=17`
- 断网时给出明确提示，不静默失败 —— ✅ 回复以「当前模型不可用，已切换为离线规则路由」开头；写指令仍抛原始网络错误，不执行命令
- 审计文件可查，凭据掩码正确 —— ✅ `<userData>/agent-audit.jsonl`（NDJSON）+ IPC `agent:audit:read`；`sk-live-*`、`Bearer`、`token` 字段在 smoke 中真实落盘后回读校验
- 单测覆盖：意图路由、参数校验、上下文裁剪、审计写入 —— ✅ 全套 717/717，其中 PLC 模拟验证 21 条、放置类 21 条（`test/agent/place-component.test.mjs`）、工具扩展 v1 30 条（`test/agent/tools-v2.test.mjs`）
- 侧栏只读问答 UI —— ✅ P7-A-2：输入即出计划预览（只读标「可离线」、写操作标「需联网确认」并点名缺参）、在线/离线共用一张回执（通道·耗时·工具次数·失败数）、审计面板展示最近 8 条与汇总；`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0`，预览前后场景零件数不变（该阶段 466/466；当前全套 717/717）
- 评估集与回归 —— ✅ P7-A-3 + P7-B：46 条中文用例 + 离线规则基线，`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（46/46 意图、46/46 工具、20/20 参数、5/5 超纲拒绝、5/5 多步）
- 底板放置与撤销 —— ✅ P7-B：`place_component` 走命令总线与真实 `window.__Enclosure`，越界/重叠返回 `OVERLAP`/`OUT_OF_BOUNDS` 告警；`undo_last` 回滚并返回 `removed`；smoke `SMOKE_AGENT_PLACE_OK placed=1 undo=1`
- 多步规划 —— ✅ P7-C：`planner.ts` 五类组合 + 通用拆句；未知工具过滤 + warning；置信度 < 0.6 拒绝；`executePlan` 顺序执行、写步骤一次确认、失败立即停止、可撤销写回提示 `undo_last`；侧栏计划卡片支持全部/逐步/取消与逐项打勾；smoke `SMOKE_AGENT_PLAN_OK steps=3 confirm=1`
- 待补：写操作的逐步确认 UI（当前多步计划一次确认；单步模型工具调用仍是一次性弹窗）
