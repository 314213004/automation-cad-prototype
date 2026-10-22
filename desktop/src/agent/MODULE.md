# 模块：Agent 接口（src/agent/）

职责：让外部 Agent（Hermes / Codex / Claude Code）用同一套工具驱动软件，而不是只靠人点界面。

## 两个入口，一份注册表

```
tools.ts（AgentTools + 6 个 AgentTool）
 ├─ rpc.ts   → HTTP JSON-RPC，127.0.0.1:7420，Bearer token
 └─ mcp.ts   → MCP stdio server，工具定义直接复用
```

## 数据结构

```ts
interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  handler(args): Promise<unknown>;
}
```

| 工具 | 参数 | 状态 |
|------|------|------|
| `list_components` | `q? / category? / packId?` | ✅ 可用 |
| `search_components` | `q`（型号/品牌/类别/规格） | ✅ 可用 |
| `import_cad` | `path`（本机绝对路径） | ⚠️ 返回 `NOT_IMPLEMENTED` |
| `get_bom` | 无 | ⚠️ `NOT_IMPLEMENTED` |
| `run_interference_check` | 无 | ⚠️ `NOT_IMPLEMENTED` |
| `insert_component` | `partId / parentNode?` | ⚠️ `NOT_IMPLEMENTED` |

未实现统一返回 `{ ok:false, code:'NOT_IMPLEMENTED', message }`，**不假装成功**。

## JSON-RPC 协议

```
GET  /health           → { ok, version, tools, uptime }
POST /rpc              → { jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments } }
Authorization: Bearer <token>
```
- token 启动时 `randomBytes(32)` 生成，写 `%APPDATA%/AutomationCAD/agent-token`，权限 600
- 401 = 缺 token / 不匹配；-32601 = 方法或工具不存在；-32600 = 请求体非法或超过 2 MB
- 只绑 `127.0.0.1`，不对外暴露

## 坑点

1. **不要把 token 写进日志**：`startAgent` 只打印 token 文件路径。
2. **stdio MCP 不需要 token**（父进程即信任边界），但不要把它暴露成 TCP。
3. **工具必须走与 UI 相同的事务入口**：否则撤销栈会错乱（当前写操作未实现，正是卡在这一层）。
4. **`timingSafeEqual` 长度不等会抛异常**，先比长度再比内容。
5. **Codex/Claude 的 MCP 配置**要写绝对路径（`npm run mcp` 的输出目录），见 `desktop/README.md`。
6. **不要把大对象直接 JSON.stringify 回传**：网格数据会撑爆 body 上限（2 MB），工具只回摘要。

## 进度

- ✅ 注册表 + 6 工具 + 鉴权 + 错误码
- ✅ MCP stdio（真实握手 `tools/list` 返回 6 个）
- ✅ 单测：401、未知工具、权限 600、NOT_IMPLEMENTED 结构
- ⏳ 写操作（insert/import/BOM/干涉）——需要先有命令总线

## 待办

1. 增加 `CommandBus`：UI 与 Agent 共用 `insertComponent / updateProperty / deleteNode`，统一进撤销栈。
2. 接 `get_bom`（读 `BOM` 常量 + 当前装配树）与 `run_interference_check`（复用 ISSUES 计算）。
3. `import_cad` 走主进程读文件 → 渲染层解析的既有链路，返回统计摘要。
4. 为 MCP 增加 `resources`（当前装配树、数据包清单），让 Agent 能先读后写。
