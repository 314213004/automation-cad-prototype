# 模块：Agent 接口（src/agent/）

职责：让外部 Agent（Hermes / Codex / Claude Code）用同一套工具驱动软件，而不是只靠人点界面。

## 两个入口，一份注册表

```
tools.ts（AgentTools + 10 个 AgentTool）
 ├─ rpc.ts        → HTTP JSON-RPC，127.0.0.1:7420，Bearer token
 ├─ mcp.ts        → MCP stdio server，工具定义直接复用
 ├─ mcp-proxy.ts  → stdio MCP → 桌面 RPC 写工具代理（10 秒超时）
 └─ commands.ts
      ├─ CommandBus        注册、执行、history、撤销栈
      └─ RendererBridge    BrowserWindow.webContents.executeJavaScript（10 秒超时）

应用内对话
 ├─ llm-config.ts  → userData/agent-llm.json（600，UI 只读掩码）
 ├─ llm.ts         → OpenAI 兼容 /chat/completions + tools
 └─ session.ts     → 工具调用循环（最多 maxIterations，历史 20 条）
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
| `run_interference_check` | 无 | `run_interference` | ✅ 前 20 条 |
| `insert_component` | `partId / name?` | `insert_component` | ✅ 可撤销 |
| `run_electrical_check` | `wires / loads / circuits / options` | `run_electrical_check` | ✅ 只读，问题清单前 50 条 |
| `run_cost_report` | `bom? / pricebook? / placements? / plate? / plc? / options? / overrides? / wireSection? / now?` | `run_cost_report` | ✅ 只读，明细前 50 行、缺价/告警各 20 条 |
| `export_cost_report` | `format / fileName? / overwrite?` + 同上成本参数 | `export_cost_report` | ✅ 写工具：PDF/CSV 落盘到 `userData/exports/`，需确认 |
| `undo_last` | 无 | 直接 `CommandBus.undoLast()` | ✅ 可用 |

`get_bom` 的 BOM 由「当前 CAD 零件 + 已插入占位件」生成：序号递增、名称/型号取零件名、数量 1、材料 `—`，并带 `note` 说明这是简化 BOM。没有模型时返回空数组。

## 命令总线与撤销

- `execute(name, args)` 始终返回 `CommandResult`，异常被转换成中文错误，不向调用方抛。
- 每次已注册命令执行都写入 `history`；面板只显示最近 5 条。
- `run_cost_report` 未显式给 `bom` 时先 `bridge.call('getBom')` 取场景 BOM；场景零件没有物料号，引擎按 `NO_PART_ID` 记缺价，不按 0 计价。
- `export_cost_report` 复用 `computeCostReport`：命令层取场景 BOM/项目名，`buildCostExport` 渲染 PDF（A4 纵向）或 CSV（UTF-8 BOM），再经渲染桥 `exportCostFile` → IPC `export:costFile` 写到固定 `userData/exports/`。命名/冲突/净化由 `src/cost/export.ts` 的 `planExportName` 统一处理。
- 导出 PDF 的字节由主进程 `renderCostPdf`（复用 `printToPDF`）生成，base64 过桥；渲染层不接触文件系统。
- 该命令通过构造参数 `createAgentCommandBus(registry, bridge, { loadBuiltinPricebook })` 拿到内置价格簿读取器（主进程读 `packs/builtin/pricebook-cn/pricebook.json`），与 `cost:pricebook` IPC 同源。
- `insert_component` 成功后将 `meshIndex` 作为 undo token 入栈；`undo_last` 调用 `removeComponent` 后索引会重排。
- `PART_NOT_FOUND`、`UNSUPPORTED_FORMAT`、`FILE_NOT_FOUND`、`RENDERER_TIMEOUT`、`RENDERER_UNAVAILABLE` 均为结构化错误码。

## MCP 写工具代理

- 独立 stdio MCP 启动时读取 `userData/agent-token`，调用 `POST http://127.0.0.1:7420/rpc` 的 `tools/call`，工具名和参数原样转发，默认 10 秒超时。
- 桌面可达时所有已知工具都转发，写操作走主进程 CommandBus 与渲染桥。
- 桌面不可达时：`list_components` / `search_components` 回退本地 registry；其余 8 个工具（含 `export_cost_report`）返回 `{ok:false,code:'DESKTOP_NOT_RUNNING',message:'请先启动 AutomationCAD 桌面应用，再调用该工具'}`。
- 代理错误不包含 token；401 单独返回鉴权错误，不降级成“桌面未运行”。

## 应用内智能体对话

- `agent-llm.json` 保存 `{baseUrl,apiKey,model,maxIterations}`，POSIX 权限 600。默认 `https://api.openai.com/v1`、`gpt-4o-mini`、6 轮。
- UI 读取时 apiKey 只返回掩码（如 `sk-****abcd`）；保存时掩码/空值保留原密钥。
- `llm.ts` 以 OpenAI 兼容格式发送 10 工具 JSON Schema，60 秒超时；非 2xx 返回含状态码的中文错误。
- `session.ts` 注入 `{llm,bus,confirmWrite}`：工具结果以 `role:'tool'` 回灌，失败不中断；历史只保留最近 20 条；超轮返回「已达到最大工具调用轮数（N），请缩小任务范围」。
- `insert_component`、`import_cad`、`undo_last`、`export_cost_report` 执行前由主进程弹出确认；拒绝时回灌 `USER_DENIED`。
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
  ready(), getScene(), getSelection(), getBom(),
  insertComponent(part), removeComponent(meshIndex),
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

## 进度

- ✅ 注册表 + 10 工具 + 鉴权 + 结构化错误码
- ✅ MCP stdio（真实握手 `tools/list` 返回 10 个）
- ✅ 命令总线：注册/执行/历史/失败记录/撤销
- ✅ 渲染桥：场景、选择、BOM、插入、移除、干涉、导入
- ✅ MCP 写工具本机 RPC 代理（转发/降级/超时）
- ✅ 应用内智能体对话（LLM 客户端、会话循环、设置与确认）
- ✅ 单测：全套 439/439；smoke：`SMOKE_AGENT_TOOLS_OK tools=10 implemented=10`、`SMOKE_AGENT_BRIDGE_OK scene=1 bom=1`、`SMOKE_AGENT_CHAT_UI_OK fields=6 log=1`、`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes=737 name=sanitized`
- ⏳ 更多可撤销写操作（属性修改、删除节点）与 MCP resources

## 待办

1. 为 MCP 增加 `resources`（当前装配树、数据包清单），让 Agent 能先读后写。
2. 把 `updateProperty / deleteNode` 也接入命令总线与撤销栈。
