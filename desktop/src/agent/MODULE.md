# 模块：Agent 接口（src/agent/）

职责：让外部 Agent（Hermes / Codex / Claude Code）用同一套工具驱动软件，而不是只靠人点界面。

## 两个入口，一份注册表

```
tools.ts（AgentTools + 17 个 AgentTool）
 ├─ rpc.ts        → HTTP JSON-RPC，127.0.0.1:7420，Bearer token
 ├─ mcp.ts        → MCP stdio server，工具定义直接复用
 ├─ mcp-proxy.ts  → stdio MCP → 桌面 RPC 写工具代理（10 秒超时）
 └─ commands.ts
      ├─ CommandBus        注册、执行、history、撤销栈
      └─ RendererBridge    BrowserWindow.webContents.executeJavaScript（10 秒超时）

应用内对话
 ├─ llm-config.ts  → userData/agent-llm.json（600，UI 只读掩码）
 ├─ llm.ts         → OpenAI 兼容 /chat/completions + tools
 ├─ session.ts     → 工具调用循环（最多 maxIterations，历史 20 条）
 │    ├─ router.ts  → 离线规则意图路由（7 类 + 只读工具计划）
 │    ├─ planner.ts → 多步规划 plan() + 顺序执行 executePlan()（P7-C）
 │    ├─ context.ts → 结构化上下文快照（≤1.5 KB）+ 历史工具清单文本块
 │    ├─ reference.ts → 选中/最近操作/几何三级指代消解（<0.6 不猜）
 │    ├─ memory.ts  → 最近 5 次工具调用摘要（仅内存）
 │    ├─ trim.ts    → 列表 20 条 / 文本 2 KB / 单结果 10 KB 裁剪
 │    ├─ audit.ts   → 每次工具调用一行 NDJSON（凭据脱敏 + 耗时）
 │    ├─ audit-view.ts → 审计筛选 / 时间倒序 / 200 条上限 / CSV
 │    ├─ feedback.ts → 进度事件 / 参数摘要 / 耗时 / 取消文案
 │    ├─ suggest.ts → 失败建议纯函数（六类错误码 + 未知码回落）
 │    └─ preview.ts → 侧栏视图模型（计划预览 / 统一回执）
```

渲染层通过 `extension.ts` 暴露受控的 `window.__AgentBridge`，不暴露 DOM。主进程命令总线只允许调用白名单方法。

## 数据结构

```ts
interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  handler(args): Promise<unknown>;
}

interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface Bridge {
  call<T>(method: string, args?: unknown): Promise<T>;
}
```

| 工具 | 参数 | 命令 | 状态 |
|------|------|------|------|
| `list_components` | `q? / category? / packId?` | 无（直接读 registry） | ✅ 可用 |
| `search_components` | `q` | 无（直接读 registry） | ✅ 可用 |
| `import_cad` | `path` | `import_cad` | ✅ 可用 |
| `get_bom` | 无 | `get_bom` | ✅ 简化 BOM |
| `get_project_context` | 无 | `get_project_context` | ✅ 只读：域/视图/选中/机型/底板/单位/最近操作，缺失为 null |
| `run_interference_check` | 无 | `run_interference` | ✅ 前 20 条 |
| `insert_component` | `partId / name?` | `insert_component` | ✅ 可撤销 |
| `place_component` | `partId / x / y / rotate? / railSnap?` | `place_component` | ✅ 底板放置，可撤销；越界/重叠只告警 |
| `update_component` | `partId? / ref? / model? / qty? / remark? / target?` | `update_component` | ✅ 改型号/数量/备注，可撤销；无尺寸返回 `NO_DIMENSIONS` 告警 |
| `remove_component` | `partId? / ref? / target?` | `remove_component` | ✅ 从底板或 BOM 移除，可撤销；不存在返回 `NOT_PLACED` |
| `run_electrical_check` | `wires / loads / circuits / options` | `run_electrical_check` | ✅ 只读，问题清单前 50 条 |
| `run_cost_report` | `bom? / pricebook? / placements? / plate? / plc? / options? / overrides? / wireSection? / now?` | `run_cost_report` | ✅ 只读，明细前 50 行、缺价/告警各 20 条 |
| `run_plc_generate` | `config? / target? / namePrefix? / sequenceTimeoutMs?` | `run_plc_generate` | ✅ 写：11 文件 + ZIP 落盘 `userData/exports/plc/`；预检失败不落盘 |
| `export_files` | `kind / fileName? / overwrite?` | `export_files` | ✅ 写：pdf/dxf/glb/bom(CSV)，与成本导出一套命名净化/冲突规则 |
| `export_cost_report` | `format / fileName? / overwrite?` + 同上成本参数 | `export_cost_report` | ✅ 写工具：PDF/CSV 落盘到 `userData/exports/`，需确认 |
| `verify_plc_program` | `config? / timeScale? / safetyTripAtStep? / sensorConflictAtStep?` | `verify_plc_program` | ✅ 只读：预检 + 生成 + 内置模拟器，返回步骤/报警/失败原因 |
| `undo_last` | 无 | 直接 `CommandBus.undoLast()` | ✅ 可用 |

`get_bom` 的 BOM 由「当前 CAD 零件 + 已插入占位件」生成：序号递增、名称/型号取零件名、数量 1、材料 `—`，并带 `note` 说明这是简化 BOM。没有模型时返回空数组。

## 离线路由 / 上下文 / 审计（P7-A）

断网或模型未配置时不能「什么都问不了」，也不能偷偷执行写操作，因此这三块独立成纯函数模块。

```ts
type IntentKind = 'query'|'compute'|'modify'|'generate'|'commission'|'sync'|'out_of_scope';

interface IntentMatch { intent: IntentKind; confidence: 'high'|'medium'|'low'; score: number; hits: string[]; reason: string }
interface ToolPlan { tool: string; args: Record<string,unknown>; readOnly: boolean; missing: string[]; why: string }

routeIntent(text): IntentMatch            // 关键词计分，写操作优先裁决
planTool(text): ToolPlan | null           // 中文指令 → 工具 + 参数
planReadOnly(text): ToolPlan | null       // 仅 readOnly 且在白名单内，离线通道只认这个
extractQuery(text): string                // 去客套话/动词/疑问词/类别词

buildAgentContext(input, limit = 2048): { text, bytes, truncated, toolCount, droppedTools, droppedRecent }
createAuditLog({ write, now?, onError? }): { record, entries }
maskSecrets(text): string                 // sk- / Bearer / token= / X-Design-Key
redactValue(value): unknown               // 按字段名脱敏，数组截 20 项，深度 4
parseAuditLines(text): AgentAuditEntry[]  // 坏行跳过
summarizeAudit(entries): { total, failed, tools, lastAt }
```

- 意图规则：`query / compute / modify / generate / commission / sync`，全 0 命中判 `out_of_scope`；同分按 `modify > generate > sync > commission > compute > query`，保证「搜索并插入」不会被当成只读查询。
- `planTool` 先判写（导出成本报告、插入、撤销、导入），再按 `干涉 → 电气校验 → 成本 → BOM → 元件` 的具体到泛顺序；类别同义词（空开→断路器、热继→热继电器…）按长度倒序匹配，避免「继电器」吃掉「热继电器」。
- 离线降级：`session.run()` 里 `llm.chat()` 抛错才触发 `runOffline()`；只执行 `planReadOnly`，写计划直接抛回原错误，由 UI 提示需要联网。
- 上下文：`buildAgentContext` 超限时按「删工具描述 → 逐个删工具 → 删最近操作 → 硬截断」降级，`truncated/droppedTools/droppedRecent` 如实回报。
- 审计：`session` 每次工具调用（含 `USER_DENIED`/参数非法/离线）回调 `audit`；`ipc.ts` 写 `userData/agent-audit.jsonl` 并暴露 `agent:audit:read`（最近 50 条 + 汇总）。写失败只回调 `onError`，不影响对话。

## 上下文快照 / 指代 / 记忆 / 结果裁剪（P7-E）

四个模块都是纯函数或纯内存类，无 DOM / fs / net 依赖。

```ts
interface AgentContext {
  domain: 'mech'|'elec'|null; view: string|null;
  selection: { kind:'component'|'mesh'|'placement'|'feature'; id:string; label:string } | null;
  machine: { name:string; stations:number; actuators:number; sensors:number } | null;
  plate: { width:number; height:number; placed:number; overlaps:number } | null;
  recentActions: Array<{ tool:string; summary:string; at:string }>;  // 最近 3 条
  units: 'mm';
  placements?: Array<{ id:string; label:string; x:number; y:number; w:number; h:number }>;
}

collectAgentContext(providers, now?): AgentContext          // 每字段独立容错，失败为 null
serializeAgentContext(ctx, limit=1536): { text, bytes, truncated, droppedRecent, context }
resolveReference(text, ctx): { target, confidence, reason }
trimListResult / trimLongText / trimToolResult / serializeToolResult
AgentMemory.record / entries / prompt / clear
```

- **采集**：`extension.ts` 的 `getProjectContext()` 依次读取底板选中 placement → 运动学选中网格 → 参数化选中特征 → CAD 选中零件，并返回机型、底板与 placement 列表；`commands.ts` 把命令历史摘要（带 `[target=kind:id:label]`）并入 `recentActions`。主进程 `AgentSession.contextProvider` 每轮调 `get_project_context`，失败返回 null 快照，不阻断对话。
- **序列化**：1.5 KB 上限；超限顺序为「删旧 recentActions → 压长字段 → UTF-8 码点边界硬截断」。`[工程上下文]` 中的 recent 摘要会剥掉 target 标记。
- **指代优先级**：选中对象 0.95 → 最近操作对象 0.72 → 几何 placement 0.78；没有候选返回 `NO_CANDIDATES`，对象信息不足返回 `LOW_CONFIDENCE`，低于 0.6 统一 `target:null`。几何排序：左边 x 升序、右边 x 降序、上面 y 升序、下面 y 降序，读序 y→x。
- **路由补全**：`planTool/planToolSequence/planReadOnly` 接收可选 `AgentContext`；命中后把对象填进 `partId` / `ref`，清掉对应 `missing`，并写 `resolvedFrom` / `resolvedLabel`。`preview.ts` 与侧栏步骤卡片据此显示「已使用选中对象：QF1」。
- **会话记忆**：`AgentSession` 每次工具调用后记录 `{tool, args, code}`（关键参数白名单，不含密钥），最多 5 条；系统提示顺序为 `SYSTEM_PROMPT → 上下文快照 → [最近工具调用]`。`clear()` 同时清空记忆。
- **结果裁剪**：`serializeToolResult` 是模型上下文的唯一入口；列表字段 >20 条变成 `{items,total,truncated}`，字符串 >2 KB 截断并附原文字节数，最终 JSON >10 KB 时保留 `ok` 与 `preview` 兜底。

冒烟：`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`。单测在 `test/agent/context-memory-trim.test.mjs`（28 条）。

## 侧栏只读问答 UI（P7-A-2）

`ui.ts` 只做渲染，判定逻辑全在 `preview.ts`（纯函数，可直接单测）。

```ts
buildPlanPreview(text): {
  tone: 'read'|'write'|'none'; title; detail; hint;
  intent; intentLabel; tool: string|null; args; readOnly; offlineAllowed; missing: string[]
}
summarizeTurn(messages): { toolCalls, failures }        // 只数 role==='tool'
buildReceipt({ mode:'online'|'offline', elapsedMs, toolCalls?, failures? }): { tone, modeLabel, text, note }
describeAuditEntry(entry): { tone, title, meta }
auditSummaryText(summary): string                        // 空审计 → 「暂无审计记录」
```

- 预览：输入框 `input` 事件即算，把结果写进 `#agentPlanPreview` 的 `data-tool / data-read-only / data-offline`，只展示不执行；写操作在提示里点名缺的参数（如 `partId`）。
- 回执：`agent:chat:send` 返回 `mode` 与 `elapsedMs`（`AgentSession.mode()` 记录本轮是否降级），UI 用同一套字段渲染，离线是告警色而非错误色。
- 审计面板：打开抽屉/发送后调 `window.desktop.agent.audit.read()`；P7-F 起为最近 200 条、时间倒序，支持工具/结果筛选、CSV 导出与单条完整 JSON 展开；读取失败给中文原因，不静默空白。
- 冒烟钉住三条：只读指令 `offline=1`、写指令 `offline=0` 且提示含 `partId`、预览前后场景零件数不变（预览不执行）。

## 执行反馈 / 取消 / 失败建议（P7-F）

```ts
interface AgentProgressEvent {
  runId: string; phase: 'start'|'end'; index: number; total: number;
  tool: string; argsSummary: string; startedAt: number; callId?: string;
  elapsedMs?: number; ok?: boolean; code?: string; message?: string;
  source?: 'chat'|'plan';
}
suggestFailure({ code, message, tool, args }): { advice: string; alternatives: string[] }
formatDuration / stepLabel / runningDurationText / aggregateDurationText / cancellationText
filterAuditEntries / auditToolNames / limitAuditEntries / auditCsv / auditEntryJson / auditExportFileName
```

- **进度通道**：`AgentSession.run(text, { signal, onProgress, runId })` 与 `executePlan(..., { signal, onProgress })` 在每步开始/结束发事件；`ipc.ts` 通过 `agent:progress` 推给渲染层，`preload.ts` 暴露 `agent.onProgress()`。
- **执行前**：`feedback.ts` 用 `redactValue` + `maskSecrets` 生成参数摘要，事件先于确认与命令执行发出；UI 显示「正在执行 `tool` · 第 n/N 步」。
- **执行中**：UI 500 ms 刷新秒表；`runningDurationText` 在 ≥10 s 时追加「仍在执行，可取消」。
- **完成**：结果卡片包含 `✓/×`、耗时、结果码；每 3 个完成步骤输出「连续 3 步汇总耗时」。
- **取消**：`agent:chat:cancel` / `agent:plan:cancel` 触发 `AbortController.abort()`；会话与计划都在步骤边界检查信号，并把当前工具的等待用 `withAbort` 中断。`AgentCancelledError.completedSteps` 只含已结束步骤。
- **取消文案**：无写步骤 → 「已取消，未写入任何更改」；已有写步骤 → 逐条列出并提示 `undo_last`；当前写工具中断但结果未知 → 明确要求核对，不谎称未写入。
- **失败建议**：`suggest.ts` 覆盖 `PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED`；`PRECHECK_FAILED` 取第一条错误并指向点位/执行机构/传感器修复位置；未知码只复述消息。
- **审计增强**：`AgentAuditRecord.elapsedMs` 由会话与计划写盘；`audit-view.ts` 负责筛选、倒序、200 条上限、CSV（UTF-8 BOM）与整条 JSON 脱敏。CSV 文件名复用 `sanitizeFileName`，导出仍经主进程 `export:saveFile` 校验扩展名与路径。

单测：`test/agent/ux.test.mjs` 21 条（六类错误码、未知码、耗时格式、参数掩码、取消状态、审计筛选/CSV/上限/JSON 脱敏）。冒烟：`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`。

## 多步规划与执行（P7-C）

`planner.ts` 与 `router.ts` 一样是无 IO 的纯函数模块，供侧栏预览（渲染层）与 IPC 执行（主进程）共用。

```ts
plan(input, context?): AgentPlan
// steps: { tool, args, why, readOnly, missing? }[]
// { confidence, refused?, reason?, suggestions?, warnings? }

executePlan(plan, deps): Promise<ExecutePlanResult>
// deps: { execute(step,index), confirmPlan?(request), now?, startAt?, maxSteps? }
// → { ok, confirmationRequired, confirmed, cancelled?, failedAt?, failedIndex?, results[], totalMs, summary, undoHint? }
```

五类规则组合：

| 场景 | 步骤 |
|---|---|
| 查件 → 放置 → 校验 | `search_components` → `place_component` → `run_electrical_check` |
| 查 BOM → 成本 → 导出 | `get_bom` → `run_cost_report` → `export_cost_report` |
| 导入 CAD → 干涉 | `import_cad` → `run_interference_check` |
| 生成 PLC → 模拟验证 | `verify_plc_program`（只读，一次完成生成/模拟） |
| 生成设计包 → 上传 | `sync_design_package`（需确认；当前未注册，默认过滤并拒绝） |

规则细节：
- 工具名默认取 `READ_ONLY_TOOLS + WRITE_TOOLS`（与 `tools.ts` 注册表一致）；UI/IPC 传入实时工具列表后逐条过滤，未注册工具写入 `warnings`，全部被过滤则 `refused:true`。**不允许硬编码不存在的工具执行。**
- 通用多步按 `splitInstructionSteps` 拆句，每句必须能由 `planTool` 接住；任一句落空整单不执行。
- 规则不命中 `confidence=0.2`；低于 `PLAN_CONFIDENCE_THRESHOLD=0.6`（或 `context.minConfidence`）时拒绝，并返回 5 条可执行建议。
- 执行器对写步骤按 `READ_ONLY_TOOLS` 判定（不信任步骤里的 `readOnly` 标记），一次汇总确认；拒绝返回 `cancelled:true` 且 `results` 为空。
- 失败停止：业务 `ok:false`、嵌套 `error.code`、抛异常都归一为结果码（异常 `TOOL_EXCEPTION`）；`failedAt` 为 1 基步骤号，`failedIndex` 为 0 基下标。
- `insert_component`/`place_component`/`update_component`/`remove_component` 成功过且有失败时返回 `undoHint`，提示可用 `undo_last` 回退。
- 逐步执行由 `deps.startAt / deps.maxSteps` 驱动，UI「全部执行」不传 `maxSteps`，「逐步执行」固定 `maxSteps=1`。

IPC 与 UI：
- `agent:plan:execute` 在主进程再次校验步骤结构与工具是否注册，确认弹窗只出现一次，审计 `source='plan'`。
- 侧栏输入多步指令时显示 `#agentPlanCard`：序号、工具、参数 JSON、原因、缺参、只读/写；按钮为「全部执行 / 逐步执行 / 取消」。执行中当前步 `…`、成功 `✓`、失败 `×` 并显示错误码与原因。
- 冒烟：`SMOKE_AGENT_PLAN_OK steps=3 confirm=1`；额外验证侧栏对两步只读计划点击「全部执行」后两项都变 `is-done`。

## 命令总线与撤销

- `execute(name, args)` 始终返回 `CommandResult`，异常被转换成中文错误，不向调用方抛。
- 每次已注册命令执行都写入 `history`；面板只显示最近 5 条。
- `run_cost_report` 未显式给 `bom` 时先 `bridge.call('getBom')` 取场景 BOM；场景零件没有物料号，引擎按 `NO_PART_ID` 记缺价，不按 0 计价。
- `export_cost_report` 复用 `computeCostReport`：命令层取场景 BOM/项目名，`buildCostExport` 渲染 PDF（A4 纵向）或 CSV（UTF-8 BOM），再经渲染桥 `exportCostFile` → IPC `export:costFile` 写到固定 `userData/exports/`。命名/冲突/净化由 `src/cost/export.ts` 的 `planExportName` 统一处理。
- 导出 PDF 的字节由主进程 `renderCostPdf`（复用 `printToPDF`）生成，base64 过桥；渲染层不接触文件系统。
- 该命令通过构造参数 `createAgentCommandBus(registry, bridge, { loadBuiltinPricebook })` 拿到内置价格簿读取器（主进程读 `packs/builtin/pricebook-cn/pricebook.json`），与 `cost:pricebook` IPC 同源。
- `insert_component` 成功后将 `meshIndex` 作为 undo token 入栈；`undo_last` 调用 `removeComponent` 后索引会重排。
- `place_component` 先由 `placement.ts` 做型号解析（精确 id → 唯一模糊命中；多义返回 `AMBIGUOUS` + 候选），再由命令总线校验 `dims`，经渲染桥 `placeEnclosurePart` 调用真实 `window.__Enclosure.place`。放置 id 作为 undo token；`undo_last` 调 `removeEnclosurePart` 并返回 `{command:'place_component',removed:<placementId>}`。越界/重叠不拒绝，返回 `warnings[{code:'OUT_OF_BOUNDS'|'OVERLAP'}]`。
- `update_component` 先解析新型号；不在已启用数据包则 `PART_NOT_FOUND`。新件 `dims` 缺失只回 `NO_DIMENSIONS` 告警并保留原尺寸。底板目标以 placement 快照撤销，BOM 目标以行号/`partId` 定位后恢复。
- `remove_component` 底板目标用 placement 快照、BOM 目标用 `detachPart` 对象快照，二者都以 opaque token 交给 `undo_last` 恢复；不存在统一 `NOT_PLACED`。
- `run_plc_generate` 先 `generateProject` 预检；有任何 error 直接 `PRECHECK_FAILED`，不创建目录。成功后写 11 个文件 + ZIP，目录名 `<机型>-<yyyyMMdd-HHmm>`，冲突追加 `-2`。
- `export_files` 由渲染桥生成内容，主进程落盘；`kind=bom` 固定 `.csv`，PDF 走独立 A3 报告打印管线，GLB 以 base64 过桥。
- `PART_NOT_FOUND`、`NOT_PLACED`、`PRECHECK_FAILED`、`UNSUPPORTED_FORMAT`、`FILE_NOT_FOUND`、`RENDERER_TIMEOUT`、`RENDERER_UNAVAILABLE` 均为结构化错误码。

## MCP 写工具代理

- 独立 stdio MCP 启动时读取 `userData/agent-token`，调用 `POST http://127.0.0.1:7420/rpc` 的 `tools/call`，工具名和参数原样转发，默认 10 秒超时。
- 桌面可达时所有已知工具都转发，写操作走主进程 CommandBus 与渲染桥。
- 桌面不可达时：`list_components` / `search_components` 回退本地 registry；其余 13 个桌面工具（含 `place_component`、`update_component`、`run_plc_generate`、`export_files`）返回 `{ok:false,code:'DESKTOP_NOT_RUNNING',message:'请先启动 AutomationCAD 桌面应用，再调用该工具'}`。
- 代理错误不包含 token；401 单独返回鉴权错误，不降级成“桌面未运行”。

## 应用内智能体对话

- `agent-llm.json` 保存 `{baseUrl,apiKey,model,maxIterations}`，POSIX 权限 600。默认 `https://api.openai.com/v1`、`gpt-4o-mini`、6 轮。
- UI 读取时 apiKey 只返回掩码（如 `sk-****abcd`）；保存时掩码/空值保留原密钥。
- `llm.ts` 以 OpenAI 兼容格式发送 17 工具 JSON Schema，60 秒超时；非 2xx 返回含状态码的中文错误。
- `session.ts` 注入 `{llm,bus,confirmWrite}`：工具结果以 `role:'tool'` 回灌，先经 `serializeToolResult` 裁剪、再由 `guard.ts` 包成不可信数据块，失败不中断；历史只保留最近 20 条；超轮返回「已达到最大工具调用轮数（N），请缩小任务范围」。
- `import_cad`、`insert_component`、`place_component`、`update_component`、`remove_component`、`run_plc_generate`、`export_files`、`export_cost_report`、`undo_last` 执行前由主进程弹出确认；拒绝时回灌 `USER_DENIED`。
- 面板包含对话消息流/工具卡片、模型设置（apiKey 为 password）与测试连接（ping，`max_tokens=8`）。

## JSON-RPC 协议

```
GET  /health           → { ok, version, toolCount, tools, uptime }
POST /rpc              → { jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments } }
Authorization: Bearer <token>
```
- token 启动时 `randomBytes(32)` 生成，写 `%APPDATA%/AutomationCAD/agent-token`，权限 600
- 401 = 缺 token / 不匹配；-32601 = 方法或工具不存在；-32600 = 请求体非法或超过 2 MB
- 只绑 `127.0.0.1`，不对外暴露

## 渲染桥

```ts
window.__AgentBridge = {
  ready(), getScene(), getSelection(), getBom(), getPlcGenConfig(),
  insertComponent(part), removeComponent(meshIndex),
  placeEnclosurePart({ partId, x, y, rotate?, railSnap? }),
  removeEnclosurePart(placementId),
  getProjectContext(), updateComponent(payload), removeProjectComponent(payload),
  restoreProjectComponent(token), exportArtifact({ kind }),
  runInterference(), importPath(path)
}
```

- `addPlaceholderPart(name)` 在 three 场景加入 20×20×20 mm 实体 + 线框占位盒，同时进入零件列表与干涉 `modelParts`。
- 占位件沿已有包围盒右侧排布，避免默认重叠。
- 未就绪时桥方法返回 `{ ok:false, message:'渲染层尚未就绪' }`，不抛异常。

## 坑点

1. **不要把 token 写进日志**：`startAgent` 只打印 token 文件路径。
2. **stdio MCP 不需要 token**（父进程即信任边界），但不要把它暴露成 TCP。
3. **写操作只能走命令总线**：否则撤销栈会错乱。独立 stdio 进程没有渲染桥时返回 `AGENT_UNAVAILABLE`。
4. **`timingSafeEqual` 长度不等会抛异常**，先比长度再比内容。
5. **Codex/Claude 的 MCP 配置**要写绝对路径（`npm run mcp` 的输出目录），见 `desktop/README.md`。
6. **不要把大对象直接 JSON.stringify 回传**：网格数据会撑爆 body 上限（2 MB），工具只回摘要。
7. **渲染桥参数必须走 JSON 白名单**：不允许任意表达式拼接，避免 Agent 代码进入渲染进程。
8. **意图关键词不要把单字塞进去**：`查` 会被「检查」误命中、`列` 会被「列举/列出」重复计分；用 `查一下/列一下/搜一下` 这类最短完整词，并让类别词按长度倒序剔除，否则「继电器」会把「热继电器」拆成「热」。
9. **离线通道只能用 `planReadOnly`**：直接调 `planTool` 会把 `export_cost_report` 这类写工具在断网时执行掉；`READ_ONLY_TOOLS`/`WRITE_TOOLS` 两个集合之和必须等于工具总数（现有单测钉住）。
10. **预览绝不能顺手执行**：`buildPlanPreview` 只允许读 `router.ts` 的纯函数，不要为了「省一次点击」在预览里调命令总线——冒烟已钉住预览前后场景零件数不变。
11. **回执的通道要由主进程给**：`mode` 从 `AgentSession.mode()` 取，别在渲染层用「回复文案里有没有『离线』」猜，否则离线失败回包会被误标成在线。
12. **审计数据先脱敏再写**：`maskSecrets` 只处理文本，结构化参数必须走 `redactValue`（按字段名），否则 `{apiKey}` 会原样落盘；写文件失败要吞掉，不能让审计把对话打断。
13. **放置告警要在钳制前判断**：`placementWarnings` 的 `intended` 是吸附后、`clampToPlate` 前的矩形；用钳制后的坐标判越界会永远没有 `OUT_OF_BOUNDS`。旋转必须先交换宽高，再算导轨吸附与碰撞。
14. **指代优先级不能反**：有选中对象时「刚才那个」也先用选中对象；几何指代（左边第二个）必须优先于「这个」，否则会拿错 placement。没有候选或置信度 <0.6 时宁可追问，不能回退成搜索关键词。
15. **上下文裁剪要按 UTF-8 码点落刀**：`slice(0,-1)` 会把汉字或 emoji 代理对切成 U+FFFD；统一用 `truncateUtf8`。工具结果进模型前必须走 `serializeToolResult` + `guardToolResult`，不能在别处直接 `JSON.stringify` 大对象；guard 只标记不可信数据，不能改变工具选择。
16. **命令历史摘要只放白名单参数**：`recentActions` 会进系统提示，`summarizeCommandResult` 不得拼接 `apiKey/token/password` 等字段；对象标记 `[target=...]` 仅用于回退解析，展示前要剥离。

## 进度

- ✅ 注册表 + 17 工具（只读 8 / 写 9）+ 鉴权 + 结构化错误码
- ✅ MCP stdio（真实握手 `tools/list` 返回 17 个）
- ✅ 命令总线：注册/执行/历史/失败记录/撤销
- ✅ 渲染桥：场景、选择、BOM、插入、移除、底板放置/撤销、干涉、导入
- ✅ MCP 写工具本机 RPC 代理（转发/降级/超时）
- ✅ 应用内智能体对话（LLM 客户端、会话循环、设置与确认）
- ✅ 离线规则路由（7 类意图）+ 历史工具清单上下文裁剪 + NDJSON 审计与凭据脱敏（P7-A）
- ✅ P7-E 上下文快照（选中/机型/底板/最近 3 条，≤1.5 KB）+ 三级指代消解 + 最近 5 次工具记忆 + 列表/文本/10 KB 结果裁剪
- ✅ 侧栏只读问答 UI：计划预览（只读可离线 / 写操作需联网）+ 在线离线统一回执 + 审计面板（P7-A-2）
- ✅ P7-C 多步规划：五类离线组合 + 通用拆句、未知工具过滤、置信度拒绝；`executePlan` 写步骤一次确认、失败立即停止、可撤销写回提示；侧栏计划卡片全部/逐步/取消
- ✅ 单测：全套 780/780（P7-G `guard.test.mjs` 14 条；`context-memory-trim.test.mjs` 28 条；P7-F `ux.test.mjs` 21 条）；smoke：`SMOKE_AGENT_TOOLS_OK tools=17 implemented=17`、`SMOKE_AGENT_TOOLS_V2 tools=17`、`SMOKE_AGENT_BRIDGE_OK scene=1 bom=1`、`SMOKE_AGENT_PLACE_OK placed=1 undo=1`、`SMOKE_AGENT_CHAT_UI_OK fields=6 log=1`、`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2`、`SMOKE_AGENT_PLAN_OK steps=3 confirm=1`、`SMOKE_AGENT_CONTEXT_OK selection=1 recent=3`、`SMOKE_AGENT_NL_OK intents=7 tools=17 audit=3 ctx=541`、`SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`、`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`
- ✅ P7-A-3 + P7-B：46 条中文评估集（`desktop/eval/agent-cases.json`）+ 离线回归 `npm run eval:agent`（结果写 `docs/desktop/eval/latest.json`）；当前基线 100% 意图 / 100% 工具 / 100% 超纲拒绝
- ✅ P7-G：`scripts/agent-live.mjs` 真实模型 12 指令冒烟（本机 deepseek-v4.1-flash 12/12）+ `guard.ts` 工具结果数据块与提示注入检测；评估集扩至 58 条，覆盖 17 工具与 6 类拒绝
- ⏳ MCP resources、单步模型工具调用的逐步确认、其余属性编辑（几何参数/装配层级）；联调/诊断/同步工具注册后补充真实工具用例

## 待办

1. 为 MCP 增加 `resources`（当前装配树、数据包清单），让 Agent 能先读后写。
2. 把剩余属性编辑（几何参数 / 装配层级）接入命令总线与撤销栈；元件型号/数量/备注与移除已完成。
