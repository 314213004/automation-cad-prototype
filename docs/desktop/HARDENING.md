# 质量加固记录（2026-10-23）

本轮范围：**一致性审查 + 状态文档重写**，不新增功能、不改工具名/IPC 通道/文件格式/状态字符串。
基线：`main` @ `d04be5b`，674 个单测全绿。加固后：687 个单测全绿，`tsc` / smoke / `eval:agent` 全绿。

## 1. 错误文案统一

统一规则：

- 对象/记录查不到 → `<对象>不存在：<标识>`；
- 必填参数或字段缺失 → `缺少必填参数：<名>`；
- 语法类错误（如「表达式缺少右括号」）保持原描述，不强行套用上述两类。

| 文件:行 | 原 | 新 | 原因 |
|---------|----|----|------|
| `mech/interference.ts:41` | `第 N 个零件缺少名称` | `缺少必填参数：第 N 个零件的名称` | 必填字段统一格式 |
| `extension.ts:504` | `缺少 CAD UI 节点：<id>` | `CAD UI 节点不存在：<id>` | 对象缺失用「不存在」 |
| `extension.ts:803` | `零件参数缺少 id/model/category` | `缺少必填参数：零件 id/model/category` | 必填参数统一格式 |
| `parametric/features.ts:95,191,197,251,289` | `第 N 个特征（名称）：缺少必填参数「key」` / `缺少实体 id` / `缺少特征 id` 等 | `缺少必填参数：<label>.<key>` / `.id` / `.name` / `.positions` | 同一校验器内统一字段路径 |
| `parametric/model.ts:561,566,583,600,601,660` | `第 N 个特征缺少 id/名称`、`updatedAt 缺失` | `缺少必填参数：<label>.id` / `.name` / `updatedAt` | 反序列化校验与 features 模块对齐 |
| `commission/machine-config.ts:45,79,90,92` | `机型配置缺少 <label>/stations/actuators/sensors` | `缺少必填参数：机型配置.<label>` 等 | 必填配置项统一格式 |
| `commission/sequence.ts:115,117,135,137` | `阶段「x」缺少点位 id/写入值/期望值` | `缺少必填参数：阶段「x」的点位 id/写入值/期望值` | 运行时步骤参数统一格式 |
| `cost/engine.ts:344` | `成本输入缺少价格簿` | `缺少必填参数：价格簿` | 必填参数统一格式 |
| `plc/config.ts:21,23,60,63,68,73,116,117` | `第 N 个点位缺少 id`、`点位「x」缺少名称`、`逻辑规则缺少 target/expr`、`Modbus TCP 缺少 host/port` | `缺少必填参数：points[i].id`、`点位「x」的名称`、`rules[i].target/expr/set\/reset/when`、`host`、`port` | 点位/规则/连接参数统一格式 |
| `plc/sim.ts:244` | `第 N 条逻辑规则缺少 expr` | `缺少必填参数：rules[i].expr` | 与 `plc/config.ts` 对齐 |
| `plc/modbus.ts:95` | `Modbus TCP 缺少 host 或 port` | `缺少必填参数：host 或 port` | 必填参数统一格式 |
| `packs/registry.ts:55,92,256,282` | `manifest.json 缺少字段：x`、`parts[i] 缺少 id`、`ZIP 中缺少 parts.json`、`解压后缺少 manifest.json 或 parts.json` | `缺少必填参数：manifest.x`、`parts[i].id`、`ZIP 条目不存在：parts.json`、`ZIP 条目不存在：manifest.json 或 parts.json` | 参数缺失与记录缺失分开表达 |
| `shared/zip.ts:16` | `ZIP 条目缺少路径` | `缺少必填参数：ZIP 条目路径` | 必填参数统一格式 |
| `sync/client.ts:210,269` | `解析上传响应失败：缺少 packageId`、`响应缺少 items 数组` | `解析上传响应失败：缺少必填参数：packageId`、`解析设计包列表失败：响应字段不存在：items` | 区分参数缺失与响应字段缺失 |
| `sync/package.ts:129` | `没有可打包的导出文件（…均缺失）` | `导出文件不存在：BOM/PDF/GLB/DXF 均无有效内容` | 对象缺失统一用「不存在」 |
| `factory/opcua.ts:79` | `OPC UA 连接失败：缺少 endpointUrl` | `缺少必填参数：endpointUrl` | 必填参数统一格式 |
| `factory/mqtt.ts:69` | `MQTT 连接失败：缺少 brokerUrl` | `缺少必填参数：brokerUrl` | 必填参数统一格式 |
| `factory/manager.ts:148,151,229` | `缺少 endpointUrl/brokerUrl`、`缺少点位 id` | `缺少必填参数：endpointUrl/brokerUrl`、`缺少必填参数：点位 id` | 与适配器层一致，保留 code |
| `plc/manager.ts:180,189,199` | `缺少点位 id` | `缺少必填参数：点位 id` | 与工厂管理器一致，保留 code |
| `agent/tools.ts:312,365,428,444,448` | `Unknown tool: x`、`search_components 需要 q 参数`、`insert_component 需要 partId 参数`、`place_component 需要 x/y 坐标` | `工具不存在：x`、`缺少必填参数：q`、`partId`、`x/y（mm）` | 去掉英文与「需要…参数」的同义表达 |
| `agent/commands.ts:574,597,598` | `loads[i] 缺少额定功率 powerKw`、`circuits[i] 缺少线号/工作电流` | `缺少必填参数：loads[i].powerKw`、`circuits[i].wireNo/currentA` | 命令层字段路径统一 |
| `cost/agent.ts:118,172,218,306` | `bom[i] 缺少数量 qty`、`placements[i] 缺少坐标 x / y`、`plc.modules[i] 缺少 partId`、`缺少价格簿：…` | `缺少必填参数：bom[i].qty`、`placements[i].x/y`、`plc.modules[i].partId`、`pricebook（…）` | Agent 工具入参统一格式，code 不变 |
| `agent/planner.ts:214,527,545` | `缺少本机绝对路径`、`未提供确认回调`、`catch` 后静默取消 | `缺少必填参数：本机绝对路径`、`缺少必填参数：确认回调`、`确认失败：<原因>，已取消` | 统一文案并把确认异常与用户拒绝区分开 |
| `agent/session.ts:140` | `catch` 后统一按「用户拒绝」返回 | `确认对话框失败：<原因>`，仍保留 code `USER_DENIED` | 不把系统异常伪装成用户拒绝 |
| `agent/mcp-proxy.ts:107` | `未找到 AutomationCAD 桌面应用的连接凭据` | `连接凭据不存在：AutomationCAD 桌面应用的 agent-token（请先启动桌面应用）` | 「未找到」统一为「不存在」 |
| `agent/llm.ts:169,185,214` | `模型服务响应缺少 choices`、测试连接直接回传原始 message | `模型服务响应字段不存在：choices`、`测试连接失败：<原因>` | 中文前缀 + 保留原始诊断信息 |
| `agent/rpc.ts:156,168,183,192,203` | `Parse error`、`not_found`、`Invalid Request`、`Unknown tool`、`Method not found` | `JSON 解析失败`、`接口不存在`、`请求格式不合法`、`工具不存在：x`、`方法不存在：x` | JSON-RPC 错误码不变，文案中文化 |
| `cad/kinematics.ts:190,209,305,347,370` | `运动学标注缺少 axes 数组`、`缺少动件名称 part`、`缺少 bindings/点位/extend 绑定` | `缺少必填参数：axes`、`axes[i].part`、`动件「x」的 bindings/绑定点位/extend 绑定` | 校验项统一格式 |
| `cad/kinematics-ui.ts:429,432,451,456` | `运动学标注缺少 sourceFile/parts`、`parts[i] 缺少动件名称`、`缺少 meshIds` | `缺少必填参数：sourceFile/parts`、`parts[i].name`、`动件「x」的 meshIds` | UI 导入校验与数据层一致 |
| `plcgen/simulate.ts:121,125,368` | `生成结果缺少 mapping.json`、`mapping.json 缺少 points / sequence`、`缺少机型配置` | `生成结果文件不存在：mapping.json`、`缺少必填参数：mapping.json.points / sequence`、`缺少必填参数：机型配置` | 文件缺失与参数缺失分开表达 |
| `plcgen/st.ts:92` | `PLC 生成输入缺少机型配置` | `缺少必填参数：机型配置` | 必填参数统一格式 |
| `plcgen/generate.ts:252` | `PLC 生成缺少文件 <path>` | `PLC 生成文件不存在：<path>` | 对象缺失统一用「不存在」 |
| `plcgen/symbols.ts:19` | `PLC 变量表缺少第 N 行` | `PLC 变量表行不存在：N` | 对象缺失统一用「不存在」 |

## 2. Catch 分支与英文消息

| 文件:行 | 原 | 新 | 原因 |
|---------|----|----|------|
| `packs/registry.ts:369-374` | `catch { return { disabled: [] } }` | 仅在状态文件存在时 `console.warn`，仍回落空列表 | 首次启动文件不存在属正常；损坏文件不应静默 |
| `mech/interference-ui.ts:41-43` | `catch { return [] }` | `console.warn` + 空列表 | localStorage 损坏可诊断，不阻断面板 |
| `agent/session.ts:82-84` | `catch { /* 不处理 */ }` | `console.warn('[agent] 审计写入失败', error)` | 审计失败不阻断对话，但保留告警 |
| `factory/manager.ts:159-162` | `catch { /* 新连接覆盖 */ }` | `console.warn` + 继续 | 旧适配器断开失败需留痕 |
| `factory/opcua.ts:275-298` | 3 处清理 catch 静默 | `console.warn` 后继续清理 | 不覆盖原始连接错误，但记录资源回收失败 |
| `plc/modbus.ts:112-115` | `catch { /* close 资源回收 */ }` | `console.warn` + 继续抛原始连接错误 | 保留原始错误并记录 close 失败 |
| `agent/planner.ts:540-545` | `catch { confirmed = false }` 后提示「用户拒绝」 | 返回 `确认失败：<原因>，已取消` | 异常与用户拒绝语义分离 |
| `agent/session.ts:138-143` | `catch { allowed = false }` 后提示「用户拒绝」 | 返回 `确认对话框失败：<原因>`，code 仍为 `USER_DENIED` | 不伪装用户意图，保持既有 code |
| `agent/tools.ts:539-543` | `VERIFY_FAILED` 直接回传原始 message | `验证失败：<原因>` | 中文前缀，保留 code 与原诊断 |
| `agent/llm.ts:211-216` | 测试连接直接回传原始 message | `测试连接失败：<原因>` | 中文前缀，保留诊断 |
| `agent/rpc.ts:154-158` | `Parse error` | `JSON 解析失败` | 去除英文协议文案 |
| `plcgen/simulate.ts:293-296` | `catch { return false }` 无说明 | 补注释：表达式不合法按 false，预检另行报告 | 明确这是预期降级而非吞错 |

其余 localStorage / DOM 查询 / 可选响应字段的 catch 已逐项复核：均返回明确默认值（空列表、空桶、`null`）或由上层给出中文提示，本轮不改行为；已有注释的保留注释。

## 3. 死导出清理

对 `desktop/**` 全量 `grep -rn -w`，确认以下导出零引用后删除：

| 文件:行（原） | 导出 | 处理 | 原因 |
|---------------|------|------|------|
| `agent/planner.ts:607` | `isMultiStepInstruction` | 删除 | 无任何调用；拆句函数 `splitInstructionSteps` 仍在使用 |
| `agent/router.ts:24` | `INTENT_ORDER` | 删除 | 无调用；意图顺序无运行时消费者 |
| `agent/router.ts:597` | `explainIntent` | 删除 | 无调用；UI 使用自己的预览文案 |
| `cad/kinematics-ui.ts:384` | `annotationToDoc` | 删除 | 无调用；`partToAxis` 仍被其他路径使用 |
| `cad/kinematics.ts:469` | `axisPoses` | 删除 | 无调用；单轴 `axisPose` 仍在使用 |
| `cad/step.ts:103` | `getOcctWasmUrl` | 删除 | 无调用；内部 `occtWasmUrl` 仍用于 locateFile |
| `commission/standard.ts:193` | `findCase` | 删除 | 无调用；`COMMISSION_CASES` 仍被 UI 使用 |
| `cost/export.ts:261` | `isCostExportSaveResult` | 删除 | 无调用 |
| `factory/types.ts:58` | `FACTORY_LABELS` | 删除 | 无调用；管理器自带列表 |
| `parametric/bom.ts:98` | `assemblyBomCsv` | 删除 | 无调用；`bomToCsv` 仍被 UI 使用 |
| `parametric/model.ts:225` | `findInstance` | 删除 | 无调用 |
| `plcgen/symbols.ts:53` | `inputBindings` | 删除 | 无调用；`outputBindings` 仍在使用 |

以下导出零引用但属于公共/兼容别名或文档明确保留的 API，本轮**保留并加注释**，避免外部脚本或后续模块引用断裂：

`cost/agent.ts:22` `COST_TOOL_NAME`、`cost/engine.ts:486,488` `calculateCost` / `runCostReport`、`parametric/bom.ts:111` `toCostReportInput`、`parametric/model.ts:211,300` `assemblyFromDoc` / `setInstanceFeatures`、`plcgen/alarms.ts:134` `generateAlarmBlock`、`plcgen/generate.ts:333` `generatePlcProject`、`plcgen/precheck.ts:512` `precheckMachineConfig`、`plcgen/safety.ts:104` `generateSafetyBlock`、`plcgen/sequence.ts:389` `generateAutoSequence`、`plcgen/simulate.ts:40,682` `GeneratedProject` / `simulateGeneratedProject`、`plcgen/st.ts:455` `generatePlcSt`、`plcgen/tags.ts:76` `generateTags`、`plcgen/ui.ts:842,844` `openPlcGen` / `closePlcGen`、`plcgen/verify.ts:244` `runPlcVerification`。

## 4. 测试补强（+13）

| 文件 | 新增用例 | 断言的具体行为 |
|------|----------|----------------|
| `test/parametric-features.test.ts` | `compileOps：空特征树返回空数组` | 空输入返回 `[]`，不抛错 |
| 同上 | `compileOps：重复特征 id 不去重且保持输入顺序` | 两个同 id 特征都保留，`length` 依次为 10、20 |
| 同上 | `compileOps：未知特征类型抛出中文错误` | 抛出 `未知特征类型「cone」` |
| 同上 | `compileOps：空 instances 返回空 ops 与空实例` | 精确等于 `{ ops: [], instances: [] }` |
| 同上 | `compileOps：Unicode 名称与 partId 原样保留` | emoji/中文名称、`PART-零件-01` 不被改写 |
| 同上 | `compileOps：transform 的 NaN/Infinity 回落为 0` | `NaN`/`±Infinity` → 0，有限值 5 保留 |
| `test/cost-export.test.ts` | `planExportName：Unicode 文件名原样保留并强制扩展名` | `报价单·夹具机🚀.csv` → `.pdf`，路径仍在导出目录 |
| 同上 | `planExportName：fileName 非字符串抛 INVALID_ARGUMENT` | 抛出 `CostExportError`，code 与中文 message 精确匹配 |
| 同上 | `planExportName：maxLength 小于扩展名时退化为最短安全文件名` | 结果精确为 `a.csv`，长度 5 |
| 同上 | `planExportName：fileName 与 suggestedName 都为空时回落成本报告` | 结果精确为 `成本报告.csv` |
| `test/plcgen.test.ts` | `变量表：跨来源重复点位只保留首次出现` | 传感器与执行机构同用 `X0` 时仅 1 行，地址 `I0.0` |
| 同上 | `变量表：Unicode 工位与 emoji 名称按白名单净化且保留中文` | 名称只含字母/数字/下划线，保留「上料/气缸/伸出」，不含 🚀，≤32 字符 |
| 同上 | `变量表：完全空配置只输出 BOM 与表头` | `rows.length === 0`，CSV 精确等于 BOM + 表头 |

## 5. 验证

- `npx tsc --noEmit`：0 错误。
- `npm test`：687/687，0 fail，0 skipped。
- `npm run build:ext` + `npm run smoke`：源码定义 46 个 `SMOKE_*` 断言名（含条件分支）；本轮无 fake sidecar 实跑 42 个（40 个 `_OK` + 2 个预期 `_SKIP`），最终 `SMOKE_OK`。
- `npm run eval:agent`：`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- 未 push；未打包；未触发 CI。
