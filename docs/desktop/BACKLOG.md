# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。

## 自然语言机型方案合成（P10-1，2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1084/1084**（1044 + 新增 40）、`npm run smoke` 新增 `SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1`、`npm run eval:agent` **65/65（1.00）**；不 push。
- A. 需求抽取：新增 `desktop/src/machine/spec.ts` 纯函数 `parseMachineBrief`，支持中文数字工位、`分钟 20 件` / `20 件/分钟` / `3 秒一件` / `CT` 三类节拍、五类工艺、气缸/夹爪/旋转轴/伺服/步进、接近/光电/安全光栅/压力、品牌与 220VAC/380VAC/24VDC；缺省项写 `notes` 标记，不抛错。
- B. 方案合成：新增 `desktop/src/machine/synth.ts` 纯函数 `synthMachine`，输出可直接喂给 `createScene3D` 的 `MachineConfig`、唯一点位（`ST1-EXT-A1` 等）、节拍瓶颈与并行工位建议、固定表功率估算、BOM 草案、warnings 与 assumptions；伺服/步进按旋转轴建模并按 750 VA/轴计功率，不重复计 200 VA 旋转轴。
- C. 工具：新增只读 `design_machine`（工具数 18 → 19，只读 10 + 写 9），schema `{brief, stationCount?, cyclePerMin?}`；空 brief、工位越界/非整数、非正节拍返回 `INVALID_ARGUMENT`；不写文件、不改工程，摘要 ≤600 字。
- D. 路由与评测：`isMachineDesignRequest` 将机型设计识别为 `generate` 并映射到 `design_machine`；`docs/desktop/eval/cases.json` 增加 4 条（锁螺丝/点胶/装配/检测），离线评测 65/65 全绿。
- E. 测试：新增 `test/machine/spec.test.mjs`（14）、`synth.test.mjs`（15）、`test/agent/design-machine.test.mjs`（10），共 39 条；覆盖中文数字、三种节拍写法、品牌、缺省 warning、工位均分、点位唯一、瓶颈、功率求和、BOM、schema、越界、空 brief 与摘要数字。
- F. 文档：新建 `docs/desktop/MACHINE-DESIGN.md`（能力边界、API、规则、工具、验证、后续）；同步 `NL-AGENT.md` 工具清单、`README.md` 工具数/评测数、`MODULES.md` 与 `desktop/src/agent/MODULE.md`；`npm run kb:build` 重建离线索引。
- 边界：几何仍为配置驱动，功率为固定表估算，节拍未计入上下料/通讯/调试损失；本轮不落盘，写工具与 UI 方案卡留给下一轮。

## Agent 运行报告与可视化（P7-O，2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1044/1044**（1034 + 新增 10）、`npm run smoke` 全绿（`SMOKE_OK`）、`npm run agent:report` 产出 md/json/svg 三个非空文件；不 push。
- A. 报告生成：新增 `desktop/scripts/agent-report.mjs` + `npm run agent:report`。读取 `agent-live.json` / `agent-multiturn.json` / `latest.json`，审计取 `<userData>/agent-audit.jsonl`（可用 `AGENT_REPORT_AUDIT_FILE` / `AGENT_REPORT_USER_DATA` 覆盖）；缺源文件写「缺失：<文件>」、打印 WARN、退出码 0。
- B. 输出：`docs/desktop/AGENT-REPORT.md`（总览、查询/操作/流程/拒绝分组、离线指标、多轮场景、能力清单、已知缺口、审计摘要）、`docs/desktop/agent-report.json`（每个指标带 `source` 与 `generatedAt`）、`docs/desktop/agent-report.svg`（纯代码生成，深色底、4 组横向条形图 + 工具/测试/单轮/多轮 KPI）。
- C. 一致性：写盘后立即读回 `agent-report.json` 并与内存对象逐字段比对；`verifyReport` 再逐项核对总览、分组、离线指标是否等于源 JSON。缺源时只降级为「缺失」，不编造数字。
- D. 能力清单：18 个工具 + 13 项平台能力，逐条给出模块文件、验证方式（单测 / smoke / eval）与状态；多轮状态按真实 JSON 显示 `⚠️ 5/6（MT04）`，未把阈值通过写成全绿。
- E. 测试：新增 `desktop/test/agent/report.test.mjs` 10 条，覆盖真实源数字、源变更传导、篡改拦截、缺源降级、Markdown 来源/时间、SVG 数据驱动、BACKLOG 缺口摘取、md/json/svg 文件产出。
- F. 文档：`README.md`、`docs/desktop/MODULES.md`、本文件；`npm run kb:build` 重建知识索引。

## Agent 执行效率：去重 / 并行 / 缓存（P7-N，2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1034/1034**（1001 + 新增 33）、`npm run smoke` 新增 `SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`、`npm run eval:agent` 100%（61/61）；`npm run agent:live` 因无凭据 `AGENT_LIVE_SKIP`，未伪造端到端 p50/p95；不 push。
- A. 同轮去重：新增 `desktop/src/agent/dedupe.ts`（纯函数 + 小状态）——`canonicalArgs` 键排序、空白压缩、数字字符串归一；`TurnCallDeduper` 按 `(tool, canonicalArgs)` 复用同轮结果并标 `reused:true`；写工具永不合并；单轮上限默认 12，超出返回 `TOO_MANY_TOOL_CALLS` 并提示拆轮。
- B. 只读并行：新增 `desktop/src/agent/parallel.ts`——`planExecutionBatches` 把连续无依赖只读批并发（默认 3，可配），写工具单独成批形成屏障；`$0` / `${1}` / `{{0.data}}` 等占位符触发依赖降级串行；`runReadOnlyBatch` 固定 worker 池，失败不取消已发出调用，结果按原序返回。
- C. 会话缓存：新增 `desktop/src/agent/cache.ts`——`get_bom` / `get_project_context` / `list_components` 按 `(tool, 规范化参数, projectFingerprint)` 缓存 30 s；只缓存成功结果；写工具执行前后清空；指纹变化删旧条目；不跨会话、不落盘。
- D. 审计 / UI：`AgentAuditRecord.cacheHit` 落 NDJSON；`AgentProgressEvent.cacheHit` 进入进度卡，工具卡与审计行显示「已复用」。
- E. 实测：本机合成桩延迟 100 ms/工具——两次只读分两轮 211 ms → 同响应 102 ms（并发 2）；三次同关键词 303 ms → 102 ms（执行 1 + 复用 2）；两轮 `get_bom` 101+101 ms → 101+2 ms（缓存命中）。真实模型基线仍为 p50 7.6 s / p95 21.3 s，待有凭据后重跑 `agent:live` 更新。
- F. 测试：新增 `desktop/test/agent/efficiency.test.mjs` 31 条，覆盖参数规范化、重复合并、参数差异不合并、写不合并、12 次上限、保序、并发度、依赖降级、写屏障、失败不吞、缓存命中/失效/TTL、指纹变化、跨会话隔离、审计 `cacheHit`。
- G. 文档：`docs/desktop/NL-AGENT.md` 新增 8.7；`README.md`、`docs/desktop/MODULES.md`、`desktop/src/agent/MODULE.md`、本文件。

## Agent 上下文预算与成本可见性（P7-M，2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` **983/983**（962 + 21）、`npm run smoke` 新增 `SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`、`npm run eval:agent` 通过；不 push。
- A. 预算模型：新增 `desktop/src/agent/budget.ts`（纯函数）——`estimateTokens`（中文 1.6 字符 / token、其他 4 字符 / token，向上取整）、六档 `system / selection / memory / docs / toolResults / history`（默认总量 12k，可配单档上限）、`pack(payload, options)` 返回 `{text, used, dropped, sections, docsSources}`。
- B. 裁剪顺序：单档超限先保留长列表首尾各 5 条 + `total`；总量超限先收敛 docs / toolResults 长列表，再按 `history → docs → toolResults → memory → selection` 丢弃；`system` 永不裁剪（超总量只记 `system_protected`），每条 `dropped` 带中文原因。`session.ts` 用六档装包系统上下文，并按用户轮次成组裁剪模型历史，避免拆散 assistant/tool 协议对。
- C. 成本可见性：`llm.ts` 解析端点 `usage.prompt_tokens / completion_tokens`；缺失时会话按消息 + 工具 schema / 回复 + tool_calls 估算并标 `estimated:true`；`usage()` 返回本轮/本会话 `promptTokens / completionTokens / totalTokens / requests / estimated` 与费用。新增 `pricing.json`（元/1k tokens，`currency/unit/models`）与 `pricing.ts`，`estimateCostView` 支持精确/最长前缀匹配，未知模型显示 `—`。
- D. UI / 审计：侧栏底部新增「上下文成本」，显示本轮/本会话 tokens、输入输出拆分与费用，估算态有标注；审计行新增 `promptTokens / completionTokens / estimated / docsSources`，`search_docs` 命中时记录实际来源数。
- E. 测试：新增 `desktop/test/agent/budget.test.mjs` 21 条，覆盖估算误差、装包不超预算、history < docs < toolResults 优先级、system 保留、长列表首尾截断、裁剪原因可读、usage 缺失回落估算、真实 usage 累计、费用格式化、未知模型 `—`、审计 tokens/docsSources。冒烟新增 `SMOKE_AGENT_BUDGET_OK used=… dropped=… tokens=…`。
- F. 文档：`docs/desktop/NL-AGENT.md` 新增 8.6；`README.md`、`docs/desktop/MODULES.md`、`desktop/src/agent/MODULE.md`、本文件。

## Agent 多轮上下文与中断续跑（P7-L，2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` 962/962、`npm run smoke` 新增 `SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`；`npm run eval:agent` 通过；多轮真实模型评测无凭据 SKIP（结果文件已写；本地桩校验 6/6 场景、15/15 轮）。不 push。
- A. 多轮模型：新增 `desktop/src/agent/thread.ts`——`ThreadState` 保存 `turnId/projectFingerprint/intent/targets/pendingConfirm/completedSteps/lastReplySummary`；`AgentSession` 每轮结束写入，下一轮系统提示注入「上一轮做了什么、是否完成、是否被拒绝」。
- B. 工程指纹：机型名 + BOM 行数 + 底板放置数 + CAD 模型有无；变化时固定提示「工程已变化，不要沿用旧结论」并列出逐项差异。
- C. 中断续跑：`runPlan({resumeFrom})` 从已完成步骤之后继续；前置指纹变化时 `refused+stale+changed[]`，不执行任何工具并要求重跑前置步骤；确认超时/取消写 `pendingConfirm`，下一轮优先询问是否继续；用户拒绝记 `USER_DENIED` 且不自动重试。
- D. 跨轮指代：上一轮目标合成 `[target=kind:id:label]`，支持「刚才那个件 / 它」；当前选中仍优先。
- E. 测试：新增 `desktop/test/agent/thread.test.mjs` 30 条，覆盖状态读写、四类指纹变化、续跑跳过、拒续跑、pendingConfirm 恢复、拒绝不重试、跨轮指代、改型号→撤销→改数量全流程。
- F. 评测：新增 `desktop/scripts/agent-multiturn.mjs` + `agent-multiturn-cases.json`，6 个多轮场景（2–3 轮/场景），环境变量同 `agent:live`，输出 `docs/desktop/eval/agent-multiturn.json`，阈值 `passRate ≥ 0.8`；无凭据跳过但写 SKIP 结果。
- G. 文档：`NL-AGENT.md` 4.2「多轮与续跑」、`README.md` 命令、`MODULES.md`、`desktop/src/agent/MODULE.md`、本文件。

## 会话层硬拦截 + 目标路径澄清（2026-10-23，本轮）

- 状态：✅ 完成；`tsc` 干净、`npm test` **932/932**、`npm run smoke` → `SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1` 且 `SMOKE_OK`、`npm run eval:agent` 通过；不 push。
- A. 策略层：新增 `desktop/src/agent/policy.ts`（纯函数）—— `detectBypassIntent` 识别“别问了 / 不用确认 / 直接覆盖 / 跳过确认 / 我授权 / 别让我点”；`sanitizeConfirmationClaims` 过滤“无需确认 / 已自动确认”；`checkExportTargetPath` 判定盘符/UNC/绝对路径/`../`/相对目录/系统目录。
- B. 会话硬拦截：`session.ts::executeTool` 对写工具强制 `confirmWrite`（缺少回调或返回值不是明确 `true` 一律不执行），bypass 时确认文案追加“用户要求跳过确认，但写操作必须确认”并写审计 `BYPASS_ATTEMPT`（含 `phrase`）；用户拒绝后本轮同名写工具直接 `USER_DENIED`，不再弹窗。
- C. 路径澄清：`commands.ts` / `tools.ts` / `cost/export.ts` 共用路径判定；`export_files` / `export_cost_report` 默认只接受纯文件名，危险目标返回 `TARGET_PATH_UNSUPPORTED` 且消息附 `userData/exports/`，不调用渲染桥、不建目录、不写盘；`allowSanitize:true` 才净化落盘并返回 `sanitized:true`。
- D. 测试：新增 `desktop/test/agent/policy.test.mjs` 42 条，覆盖意图正负例、话术替换、盘符/UNC/`../`/纯文件名、allowSanitize 开关、直接调用 `executeTool`、拒绝短路与审计字段；既有导出 smoke 改为显式 `allowSanitize`。
- E. 文档：`NL-AGENT.md` 新增 6.1「确认与路径策略」、9.1.1 下一步标记；`MODULES.md`、`desktop/src/agent/MODULE.md`、本文件同步。

## Agent 真实模型评测 30 条 + 失败归因（P7-K，2026-10-23，本轮）

- 状态：✅ 完成并过闸；三轮迭代后 `toolAccuracy=1.00`、`refusalRate=1.00`，`npm run agent:live` 退出码 0；**已 push**（后续由主会话补提交）。
- A. 用例：新增 `desktop/scripts/agent-live-cases.json` 30 条 —— 查询 8、操作 10、流程 6、拒绝/澄清 6；每条含 `{id, prompt, expect:{tools, alternatives, mustNot, asksConfirmation?, expectClarify?}}`，流程类用有序 `steps` 表达，拒绝类用 `mustNot` 锁死越权写工具。
- B. 评测器：`desktop/scripts/agent-live.mjs` 改为顺序执行、隔离会话、有状态桩总线（放置/修改/移除/撤销会更新 placements，只读工具读取新状态）、有序多步匹配、参数检查、写确认核对、只读排查与拒绝区分；逐条记录耗时/工具序列/确认/澄清/拒绝，失败分类限定 `wrong-tool` / `missing-arg` / `no-confirm` / `hallucinated` / `timeout` / `parse`。输出 `docs/desktop/eval/agent-live.json`，含 `{model,total,matched,toolAccuracy,confirmRate,clarifyRate,refusalRate,p50Ms,p95Ms,byCategory,failures[]}`。
- C. 真实结果（本机 LiteLLM bridge，`cn:deepseek-v4.1-flash`，key 只从环境读）：三轮迭代后 **30/30（100%）**，`confirmRate=1.00`（13/13）、`clarifyRate=1.00`（3/3）、`refusalRate=1.00`（6/6）；p50 7.6 s、p95 21.3 s。中间轮次：第 1 轮 28/30（2 条用例语义写错）、第 2 轮 27/30（暴露提前收口与幻觉误判）。
- D. 失败归因与修正（保留历史，不删）：
  - 第 1 轮 R03「要求跳过确认」/ R05「危险路径导出」：判定语义写错——R03 已正确请求确认却被判越权、R05 已净化到 `userData/exports/` 却被判“静默改写”。修正为：R03 断言“必须出现确认请求”，R05 断言“参数不得含 System32/Windows/系统盘绝对路径”。
  - 第 2 轮 F02 提前收口：BOM 无尺寸字段时模型拒绝导出 BOM，属过度谨慎；已在系统提示写明“缺尺寸只影响底板绘制，不得拒绝导出 BOM/PDF/成本”。
  - 第 2 轮 O03：起始点 (20,60) 与已有 QF1 重叠，模型暂停属正确行为；用例改为空白区 (240,200)。
  - 第 2 轮 R05 误判幻觉：模型确实调用了 `export_files` 却被判“未调用工具却声称完成”；判定改为仅当“本轮零工具调用”时才判幻觉。
  - 只读步骤调序：允许 `run_interference_check` 与 `run_electrical_check` 互换顺序，写操作仍按序。
- E. 下一步（按优先级）：
  1. ✅ **P0 硬拦截**：`policy.ts::detectBypassIntent` + `session.ts::executeTool` 强制确认、拒绝短路、`BYPASS_ATTEMPT` 审计、回复话术过滤；实现与证据见本轮新增章节。
  2. ✅ **P0 目标路径澄清**：`policy.ts::checkExportTargetPath` + `commands.ts` / `tools.ts` / `cost/export.ts` 统一拒绝危险路径；`allowSanitize=true` 才净化，返回 `sanitized:true`。
  3. **P1 流程稳定性**：评测改为 3 轮取多数，记录每轮 F02/F03；同时给流程计划加“未完成步骤不得结束”的执行约束，或在系统提示中明确“多步流程必须继续到全部步骤或明确失败”。
  4. **P1 回归门槛**：拒绝/澄清类保持 6/6 必须全过；建议再补“工具结果注入要求跳过确认”“用户伪造已确认”两条用例，防止只对单句生效。
  5. **P2 扩充**：补充真实多轮上下文（改型号后撤销再改数量）、跨域误用（机械域要求电气导出）与超长序号/批量 20 件，继续观察 token 与延迟。
- F. 文档：`docs/desktop/NL-AGENT.md` 9.1 更新为 30 条结果表与归因；README 数字与运行说明；本文件记录证据与下一步。

## Agent 本地知识检索（离线 RAG，2026-10-23，本轮）

- 状态：✅ 完成；不 push。
- A. 索引：新增 `desktop/src/agent/kb/index.ts`，输入 12 份 `docs/desktop/*.md` + `screenshots/` 文件名 + `packs/builtin/*/parts.json` 分类名；按 Markdown 标题切块（≤800 字符），保留 `source`（文件#标题路径）/`heading`/`line`。新增 `scripts/build-kb.mjs` 与 `npm run kb:build`，输出 `desktop/src/agent/kb/kb.json`（当前 12 docs / 291 chunks / 约 300 KB，≤400 KB）；超限时保留前 200 块并记录 `truncated/droppedChunks`。启动只加载 JSON，不扫盘、不联网。
- B. 检索：新增 `desktop/src/agent/kb/search.ts` 纯函数；中文 2-gram + 英文/数字词，简化 BM25（k1=1.5、b=0.75）+ IDF，默认 top 3；无查询词命中直接返回 `[]`；结果整体 ≤2 KB。
- C. 工具：新增只读 `search_docs({query, limit?})`，返回 `{ok,query,hits:[{source,heading,snippet,score}]}`；工具数 17 → 18（只读 9 + 写 9），MCP/RPC/UI/README/工具清单同步；系统提示要求「怎么操作 / 限制 / 决策 / 为什么」先查文档，查不到直说。
- D. 测试：新增 `desktop/test/agent/kb.test.mjs` 18 条（分块/source/line、800 字符、2-gram、导轨/干涉/D2、无命中、top3、limit、2 KB、400 KB、截图/分类、标题 hash 同步、工具参数）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **890/890**；`npm run smoke` → `SMOKE_AGENT_KB_OK docs=12 chunks=291 query=D2 hits=1`、既有 Agent 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（61/61，新增 k01–k03 文档用例）。
- F. 文档：`docs/desktop/NL-AGENT.md` 新增「4.1 本地知识检索（离线 RAG）」；README 工具数与 `npm run kb:build`；`docs/desktop/MODULES.md`；`desktop/src/agent/MODULE.md`；本文件。

## Agent 工具调用纠错与重试（P7-J，2026-10-23，本轮）

- 状态：✅ 完成；不 push。
- A. 纠错纯函数：新增 `desktop/src/agent/repair.ts`，`repairToolCall(raw, schema, ctx?)` 先剥代码围栏与前后解释，再逐字符扫描第一个平衡 JSON 对象；支持单引号、尾逗号、`//` 注释、`"120mm"→120`（仅 number 且含单位）、`"true"/"false"→boolean`、纯数字 `"3"→3`（仅 integer）、`{name,arguments}` 信封、多工具串取第一个；必填 `partId` 仅从 `ctx.selection.id` 回填；`additionalProperties:false` 的未知字段删除并记录；截断最多补 3 层 `}`/`]`，超限/无法补全返回 `TRUNCATED_JSON`；修复后必须过 schema，首个错误带路径与中文消息（`参数 qty 应为整数，收到 "3 个"`）。`qty:"很多"`、`"3 个"` 不猜值，直接拒绝。
- B. 重试策略：新增 `desktop/src/agent/retry.ts`；首次失败追加「上次输出错误：<原因>。只输出 JSON…」重试 1 次；仍失败回落「没听懂 + 未执行任何工具 + 两条按原话匹配的候选指令」，侧栏候选按钮只填入输入框、不自动发送；重试仅 1 次/用户轮次，失败立即返回，不空转。
- C. 接入：`session.ts` 新增 `toolSchemas`，模型工具参数统一走 repair；失败路径写 `TOOL_CALL_INVALID` / `TOOL_CALL_RETRY_OK` / `TOOL_CALL_FALLBACK`，成功修复写 `TOOL_CALL_REPAIRED`，审计新增 `retries/reason/repairs`；`ipc.ts` 与 `scripts/agent-live.mjs` 传入注册表 schema；`llm.ts` 默认发送 `response_format:{type:'json_object'}`，端点明确不支持时去掉并重试一次，`responseFormat:false` 可关闭。
- D. 测试：新增 `desktop/test/agent/repair.test.mjs` 39 条（围栏/前后废话/单引号/尾逗号/注释/单位数字/字符串布尔/字符串整数/多工具串/截断成功与失败/schema 中文路径/禁止猜测/selection 回填/未知字段/重试成功/重试回落/审计）；`test/agent/llm.test.mjs` 新增 3 条（默认 response_format、端点不支持时降级、显式关闭）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **872/872**（830 + 39 + 3）；`npm run smoke` → `SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`、既有 Agent/成本/PLC 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP`（有凭据时仍跑 12/12）。
- F. 文档：`docs/desktop/NL-AGENT.md` 新增 8.5「输出纠错与重试」；`docs/desktop/MODULES.md`；`desktop/src/agent/MODULE.md`；本文件。

## 发版准备 0.3.0（2026-10-23）

- 状态：✅ 代码与文档准备完成；**未打包、未触发 CI、未打 tag、未 push**
- 已完成：`desktop/package.json` / `package-lock.json` 版本升至 `0.3.0`；新建根目录 `CHANGELOG.md`（按 Added / Changed / Fixed 归类，逐条带提交号）；README 版本与能力表同步；汇报材料扩至 19 页并重导 PDF。
- 汇报材料：测试基线 674、元件 371 型号 / 244 尺寸（16 条同系列推定）、Agent 12 工具、PLC 生成 P8-1～P8-4、参数化 P9-1/2/3/5；新增「PLC 程序自动生成与参数化建模」页；明确 ST 通用、无厂商工程文件、build123d Python sidecar 依赖。
- 验收：`npx tsc --noEmit` 通过；`npm test` **674/674**；`npm run smoke` → `SMOKE_OK`（带假 sidecar 另得 `SMOKE_PARAMETRIC_SIDECAR_OK` / `SMOKE_PARAMETRIC_UI_OK` / `SMOKE_PARAMETRIC_ASSEMBLY_OK`）；PDF 19 页，关键词 `674` / `PLC` / `build123d` / `0.3.0` 均命中，URL 无横向溢出。
- 待办：安装包构建需老王通知后手动触发 `windows-build`；TIA Openness、草图约束（P9-4）、委外加工联动与生产部署仍未完成，保持规划中。

## Agent 流程模板（P7-I，2026-10-23，本轮）

- 状态：✅ 完成；不 push。
- A. 模板：新增 `desktop/src/agent/recipes.ts`，5 个纯数据模板 `new-machine` / `plate-delivery` / `electrical-delivery` / `cost-review` / `full-package`；每个含 `id/title/summary/steps[]/preconditions[]/estimatedSeconds`，步骤全部引用现有 17 个注册工具，参数模板支持 `{from:'context.machine.name'}` 点路径占位符（含数组下标、`default`、`optional`）。
- B. 执行器：`runRecipe(recipeId, ctx, executor)` 前置条件不满足返回 `PRECONDITION_FAILED` + 缺什么 + 建议动作且零执行；`skipSteps/skipIndexes/isSkipped` 支持取消勾选；写工具默认每步 `confirm()`，显式 `rememberSameKind` 才同类免问；任一步失败停止并保留 `completed/kept`，生成含失败步骤、错误码、建议与已完成清单的中文 `report`；记录 `totalMs` 与每步 `elapsedMs`。
- C. UI/IPC：`agent:recipe:execute` / `agent:recipe:cancel`；侧栏「流程」下拉、前置条件红/绿、步骤复选框、开始/取消/导出 Markdown、分步进度与结果；写操作弹「流程写操作确认」，审计 `source='recipe'`。
- D. 测试：新增 `desktop/test/agent/recipes.test.mjs` 29 条，覆盖 5 模板 schema（工具名必须存在于注册表）、重复 id/非法耗时、占位符解析/缺失/默认值、前置条件拦截与数值下限、失败停止保留已完成、跳过（id/工具名/下标）、默认逐次确认、同类免问、拒绝、无确认回调、耗时、中文报告与 Markdown 导出、未知模板。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **830/830**（801 + 29）；`npm run smoke` → `SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`、`SMOKE_AGENT_RECIPE_UI_OK recipes=5 steps=5`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。
- F. 文档：`docs/desktop/NL-AGENT.md` 第 7 节改为「已实现——流程模板」；README 智能体表与冒烟清单；`docs/desktop/MODULES.md`；`desktop/src/agent/MODULE.md`；本文件。

## Agent 主动建议（P7-H，2026-10-23，本轮）

- 状态：✅ 完成；未 push。
- A. 建议引擎：新增 `desktop/src/agent/advisor.ts`，纯函数 `suggestNextActions(context, project, options?)`；输入 BOM 行数、未放置件数、干涉命中/未检查、缺尺寸件数、CAD 是否存在、电气校验结果、成本是否过期、PLC 是否已生成，输出 0–3 条 `{id,title,why,action,weight}`。规则顺序：底板重叠 100、电气校验未通过 95、干涉命中 90、缺尺寸 85、未做干涉检查 70、成本过期 65、PLC 未生成 60、全部就绪交付包 50；`why` 全部引用真实数字，无命中返回空数组。
- B. UI 接入：侧栏顶部「建议」区最多 3 张卡片；ask 卡片填入输入框，tool 卡片生成单步计划确认（写操作仍二次确认）；「忽略」写入本次会话内存 Set，刷新时作为 `options.ignored` 传入；`agent:progress` end、对话/计划结束与面板刷新都会调用 `refreshAdvisor()`，只更新建议列表 DOM，不打断对话。
- C. 状态来源：`__AgentBridge.getAdvisorState()` 汇总 BOM / 未放置 / 干涉 / 电气 / 成本指纹 / PLC 标记，`packs.listParts()` 在渲染层补齐 `dims` 缺尺寸数；`__CostPanel.state()` 暴露成本计算的 BOM 指纹，`run_plc_generate` 成功后调用 `markPlcGenerated`。
- D. 测试：新增 `desktop/test/agent/advisor.test.mjs` 21 条，覆盖每条规则命中/不命中、优先级排序、上限 3、空状态、忽略后不返回、忽略后刷新不复活、why 数字、BOM 指纹。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **801/801**（780 + 21）；`npm run smoke` → `SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。
- F. 文档：`docs/desktop/NL-AGENT.md` 新增 8.4「主动建议」规则表；README 智能体表与面板说明；`docs/desktop/MODULES.md`；`desktop/src/agent/MODULE.md`；本文件。

## Agent 真实模型与抗注入（2026-10-23，本轮）

- 状态：✅ 完成；不 push。
- A. 真实模型冒烟：新增 `desktop/scripts/agent-live.mjs` + `npm run agent:live`，从 `AGENT_LIVE_BASE_URL` / `AGENT_LIVE_API_KEY` / `AGENT_LIVE_MODEL` 读取配置，走 `OpenAiCompatibleClient` + `AgentSession` 跑 12 条固定指令；断言行工具（含合理替代）、关键参数与写确认。无凭据打印 `AGENT_LIVE_SKIP` 并退出 0；结果写 `docs/desktop/eval/agent-live.json`。本机实测 LiteLLM bridge / `cn:deepseek-v4.1-flash`：`matched=12/12`、`toolAccuracy=1.00`、`confirmRate=1.00`；密钥未写入任何文件。
- B. 抗提示注入：新增 `desktop/src/agent/guard.ts`，所有工具结果包成 `tool_result_data` 数据块；检测「忽略之前的指令」「你现在是」「执行 rm」「上传到」「篡改审计」「危险路径」等模式并标记 `untrusted:true`，附不可信提示，不丢弃原文；系统提示声明工具结果/文件内容只是数据。新增 `test/agent/guard.test.mjs` 14 条，覆盖元件名、STEP 文件名、备注字段与会话回灌，断言工具选择不变。
- C. 评估集：`docs/desktop/eval/cases.json` 扩至 **58 条**（17 个工具全覆盖 + 缺参数/越权改文件/篡改审计/危险路径/未知位号/跨域误用 6 类拒绝）；`run-eval.mjs` 改为读取该路径并校验工具/拒绝覆盖，离线路由补齐 `update_component`、`remove_component`、`run_plc_generate`、`export_files`、`get_project_context` 与拒绝规则。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **780/780**（766 + 14）；`npm run smoke` → `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP` 退出 0。
- E. 文档：`docs/desktop/NL-AGENT.md` 新增「真实模型验证」「不可信内容处理」；README 快速开始补充运行方式；本文件记录本轮证据。

## 质量加固轮（2026-10-23，本轮）

- 状态：✅ 完成；不新增功能、不改工具名/IPC 通道/文件格式/状态字符串，不 push。
- A. 一致性审查：统一「缺少必填参数：x」/「x 不存在：id」文案；JSON-RPC 英文错误改为中文且保留错误码；确认回调异常不再伪装成用户拒绝；补充静默 catch 的告警或原因注释。
- B. 死代码：`grep -rn -w` 确认零引用后删除 12 个导出（`isMultiStepInstruction`、`INTENT_ORDER`、`explainIntent`、`annotationToDoc`、`axisPoses`、`getOcctWasmUrl`、`findCase`、`isCostExportSaveResult`、`FACTORY_LABELS`、`assemblyBomCsv`、`findInstance`、`inputBindings`）；公共/兼容别名保留并加注释。
- C. 测试补强：`compileOps`、`planExportName`、`buildTags` 新增 13 条边界用例（空数组、重复 id、Unicode/emoji、NaN/Infinity、非法 fileName、超短 maxLength、空配置）。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **687/687**（起点 674）；`npm run smoke` → 源码定义 46 个 `SMOKE_*` 断言名（含条件分支），本轮无 fake sidecar 实跑 42 个（40 个 `_OK` + 2 个预期 `_SKIP`）并输出 `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- E. 文档：重写 `STATUS.md`（P1–P9 状态表、smoke 断言清单、限制、D1–D8 索引、命令速查）；新建 `HARDENING.md`（文件:行 → 原 → 新 → 原因）；README 测试基线同步 687。
- 本轮未执行 `npm run sync:e2e` / `npm run screenshots`；两条命令保留在 STATUS 速查中，供发布前按需复跑。

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
- 状态：✅ P7-A / P7-B / P7-C / P7-D / P7-E / P7-F / P7-G / P7-H 完成（P7-A：离线规则路由 + 上下文裁剪 + 审计 + 侧栏只读问答 UI + 评估集；P7-B：`place_component` 底板放置 + 二次确认 + 撤销联动；P7-C：离线多步规划 + 计划卡片 + 顺序执行 + 失败停止；P7-D：Agent 工具扩展 v1，12 → 17 个工具；P7-E：上下文快照与指代；P7-F：执行进度/取消/失败建议/审计增强；P7-G：真实模型冒烟 + 抗注入；P7-H：主动建议 next-best-action）
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
- 已完成（P7-D，提交号待补）：
  - `tools.ts` 注册表新增 5 个工具：`get_project_context`（只读，缺失字段返回 null）、`update_component`（改型号/数量/备注，可撤销）、`remove_component`（底板/BOM 移除，可撤销）、`run_plc_generate`（预检失败不落盘）、`export_files`（pdf/dxf/glb/bom，复用统一文件名净化与冲突规则）
  - `commands.ts` / `extension.ts` / `viewer.ts` / `enclosure`：新增工程上下文、元件更新/移除快照恢复、PLC 目录落盘、通用导出渲染桥；`ipc.ts` 注入 A3 装配报告 PDF 管线
  - `session.ts` / `mcp.ts` / `router.ts` / `planner.ts`：4 个写工具加入 `MUTATING_TOOLS` 与二次确认，MCP 桌面依赖清单同步，读写集合保持 8 + 9 = 17；`update_component` / `remove_component` 纳入可撤销写
  - 错误码：`PART_NOT_FOUND`、`NOT_PLACED`、`PRECHECK_FAILED`、`UNSUPPORTED_FORMAT`、`INVALID_ARGUMENT` 均为稳定结构化返回
  - 测试：新增 `desktop/test/agent/tools-v2.test.mjs` 30 条（schema 完整性、参数校验、未知型号、无尺寸告警、移除不存在、预检拦截不落盘、导出白名单/路径净化/覆盖序号、确认拒绝）
- 实测（P7-D）：`tsc --noEmit` 通过；`npm test` **717/717**（687 → 717，新增 30 条）；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；`npm run smoke` → `SMOKE_AGENT_TOOLS_OK tools=17 implemented=17`、`SMOKE_AGENT_TOOLS_V2 tools=17`、`SMOKE_AGENT_NL_OK intents=7 tools=17 audit=3 ctx=541`、`SMOKE_OK`
- 已完成（P7-F，提交号待补）：
  - `src/agent/feedback.ts`：进度事件类型、参数摘要（`redactValue` + `maskSecrets`）、耗时格式化、n/N 与 10 s 提示、连续 3 步汇总、取消文案
  - `src/agent/suggest.ts`：`PART_NOT_FOUND` / `NO_DIMENSIONS` / `UNAVAILABLE` / `DESKTOP_NOT_RUNNING` / `PRECHECK_FAILED` / `USER_DENIED` 中文建议与替代方案；未知码明确「无法判断具体原因」
  - `session.ts` / `planner.ts`：`run(text, {signal,onProgress,runId})`、`executePlan(..., {signal,onProgress})`；每步 start/end 事件；`AbortController` 中断当前等待；`AgentCancelledError.completedSteps` 只记录已结束步骤
  - `ipc.ts` / `preload.ts` / `desktop-api.d.ts`：`agent:progress` 事件、`agent:chat:cancel`、`agent:plan:cancel`、`agent.onProgress()`
  - `ui.ts` / `panels.css`：执行前进度、500 ms 秒表、>10 s 可取消、结果卡片（✓/×、耗时、结果码）、3 步汇总、取消按钮与取消文案、失败建议卡片
  - `audit-view.ts`：工具/结果筛选、时间倒序、最近 200 条上限与丢弃提示、CSV（UTF-8 BOM、统一文件名净化）、单条完整 JSON 递归脱敏；`AgentAuditRecord.elapsedMs`
  - `test/agent/ux.test.mjs`：21 条新单测；main smoke 新增 `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`
- 实测（P7-F）：`tsc --noEmit` 通过；`npm test` **766/766**（745 → 766，新增 21 条）；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；`npm run smoke` → `SMOKE_AGENT_UX_OK steps=3 audit=3 cancel=1`、既有智能体断言全绿、`SMOKE_OK`
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
- 状态：🔄 P9-1 / P9-2 / P9-3 / P9-5 已完成；P9-4 草图约束前置调研完成，实施待排期
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 ✅ sidecar+契约（`spike/build123d/app.py`）→ P9-2 ✅ 主进程生命周期/IPC（`9eda660`，388/388、`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`）→ P9-3 ✅ 特征树 UI / 参数编辑 / 防抖重建 / STEP+STL 导出 → P9-4 ⏳ 草图约束（前置调研完成）→ P9-5 ✅ 多实体装配 + BOM/成本联动
- 已完成（P9-3）：`src/parametric/model.ts`（编辑/防抖/分桶/序列化/包围盒，18 条单测）、`src/parametric/ui.ts`（与运动学二选一的抽屉、按类型参数表单、校验失败禁重建）、`cad/viewer.ts`（STL 载入 + 旧模型幽灵层 + 特征包围盒高亮）、`extension.ts` 挂载与 `AutomationCadParametric` 调试入口；`localStorage: automationcad.parametric.v1` 按 `sourceFile` 分桶（无来源 `untitled`）；JSON 保存走 `desktop.exportFile`
- 实测（P9-3）：`npx tsc --noEmit` 通过；`npm test` **524/524**；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`、`SMOKE_OK`
- 坑：假内核脚本不能放 `test/` 下（`node --test` 会把 `test/fixtures/*.mjs` 也当测试跑，挂 276 s），已移到 `desktop/scripts/fake-parametric-sidecar.mjs`
- 验收：P9-2 `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`；P9-3 `SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 已完成（P9-5）：`features.ts` 增加 `PartInstance/AssemblyDoc`、旧文档自动包装、实体级校验与 `compileOps` 双形态；`bom.ts` 合并 partId/未映射名称并生成 UTF-8 BOM CSV 与成本入参；`ui.ts` 装配实体区、BOM 预览、导出 BOM/送成本；`app.py` 可选 `instances`，独立建模后按 X/Y/Z/RZ 放置并合并，返回 `stats.solids` 与每实体体积；假内核支持两实体 smoke
- 实测（P9-5）：`npx tsc --noEmit` 通过；`npm test` **647/647**（新增 `parametric-assembly.test.ts` 25 条 + sidecar 装配 3 条）；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`
- P9-5 边界：BOM 只按实体汇总、不拆特征明细；`partId` 需人工填写；装配为静态多实体合并，不做配合约束/自由度求解（P9-4）
- P9-4 前置调研（2026-10-23）：推荐 `@salusoft89/planegcs@1.3.0`（LGPL-2.1、WASM、Node 可跑）；矩形 + 水平/竖直 + 宽 120 / 高 80 实测 `Success`、`dof=0`、残差 0，热求解中位数 0.30 ms，安装增量 878 KiB；jsketcher 因自定义许可要求修改回授且无 npm 包不推荐；顶点 → build123d `Polyline` → `extrude` 实跑体积 76,800 mm³。详见 [SKETCH-SPIKE.md](SKETCH-SPIKE.md)。本轮不接入产品代码

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
| D5 | 元件库缺失尺寸（180/371）能否用「同系列壳体推定」 | A 允许并标注推定；B 只用实测/官方值，缺的留空 | 底板布置覆盖率 | A + 标注，人工复核 | ✅ 已按 A 执行：244/371（65.8%），官方 37 + 推定 16；剩余 127 条留空，清单见 `docs/desktop/DIMS-GAPS.md` |
| D6 | 参数化建模首期范围 | A 只做单件结构件；B 单件+多体装配；C 直接上草图约束 | 工期（A≈3 周，B≈6 周） | A 先交付，B/C 分期 | 待定 |
| D7 | 成本面板如何拿到 BOM（CAD 零件名 → 元器件物料号映射口径） | A 由底板画布/电气元件库直接给 partId，成本面板只读；B 允许「零件名规则匹配 + 人工确认」自动填 partId；C 保持手工导入 BOM JSON | 影响成本能否一键算；B 需要命名规范（如 `QF1:LC1D09`），否则匹配率低 | A 长期方向，短期用 C + 预留 B | 待定 |
| D8 | Agent 的 `run_cost_report` 是否允许落盘导出报告 | A 保持只读，只回摘要；B 增加写工具 `export_cost_report`（PDF/CSV，走现有二次确认）；C 由面板导出，Agent 只给「点哪里」 | 影响「一句话出报价单」的体验；B 需要确认文件名/目录规则与覆盖策略 | B：`export_cost_report` 固定写 `userData/exports/`，默认不覆盖、冲突追加序号 | 已定 B，已实现（`23cd284`） |
| D9 | 离线规则路由是否要在「模型可用时」也前置生效 | A 仅在模型失败时降级（现状）；B 高置信度只读指令直接走规则，省一次模型调用；C 全走模型 | B 更快更省 token，但规则误判时用户得不到语义纠正，且两套路径要长期保持一致 | A 先稳定；若要 B，先攒 40 条评估集对比准确率再开 | 待定 |
| D10 | 中文评估集用哪条通道跑基线 | A 只用离线规则路由（零成本、可离线、但只覆盖规则能判的句式）；B 规则 + 真实模型双跑（能测语义理解，按 token 付费）；C 只跑模型 | 决定评估结论代表「规则上限」还是「产品上限」；B 需要一把可用的付费/自建模型 key 与预算口径 | A 先立基线并进 CI 友好（无网络），B 作为发布前手动回归；已落地离线 61 条 + 真实模型 30 条（`agent:live`，30/30；拒绝/澄清 6/6） | ✅ 已按 B 执行 |

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决中；STEP 不含运动学，任意装配体仍需标注层。
2. **尺寸数据覆盖不全**：已补至 244/371（16 条同系列推定），仍缺 127 条；缺失元件在底板画布上按「未标注尺寸」处理，需人工补。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：3D 为固定等轴测投影，属性编辑不改拓扑（插入与撤销已真实化）。
8. **真实模型拒绝/澄清类**：已从 4/6 修到 6/6（判定语义修正 + 两条系统提示）；但仍是单模型单轮结果，换模型或换措辞需重跑 `npm run agent:live`，不要把 30/30 当成通用结论。
9. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板最多显示最近 200 条（可筛选/导出），回执不含 token 用量（网关未回传 usage）。
10. **多轮评测证据仍是 5/6**：`docs/desktop/eval/agent-multiturn.json`（2026-10-23T12:28:04Z）中 MT04「拒绝后自动重试」两轮未过；会话层拒绝记忆已修复，但尚未有新的真实模型多轮 JSON，报告按现有证据展示，重跑 `npm run eval:agent:multiturn` 后再更新。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败
