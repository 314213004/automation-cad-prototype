# AutomationCAD 桌面版

Windows 11 桌面外壳（Electron）+ 原型渲染层扩展。根目录的 `index.html` / `app.js` / `styles.css` / `electrical.*` 保持原样，桌面能力全部由 `desktop/src/extension.ts` 注入。

> 模块划分、数据结构、坑点与待办见 [`docs/desktop/MODULES.md`](../docs/desktop/MODULES.md)（索引）；各模块目录下有 `MODULE.md`。

## 常用命令

```bash
cd desktop
npm ci
npm run build:ext   # tsc + Vite 扩展 + Electron main/preload + MCP 入口
npm test            # node:test，单元/集成测试
npm run smoke       # xvfb + Electron --headless-smoke，强制无 WebGL 路径
npm start           # 启动桌面应用
npm run mcp         # 启动 stdio MCP server（需先 build:ext）
```

`npm run smoke` 会验证：

- CAD 解析统计（`cube.stp` → 1 个零件 / 12 个三角面）；
- 无 WebGL 时显示「当前环境不支持 WebGL，无法显示 3D 模型」降级面板，并展示解析统计；
- 「工厂」面板连接内置仿真产线后出现 2 个工位 / 8 个点位；
- 「数据包」面板能列出内置包、搜索元器件并写入 localStorage 覆盖层。

## MCP（stdio）接入

MCP 入口直接复用 `src/agent/tools.ts` 的 6 个工具：`list_components`、`search_components`、`import_cad`、`get_bom`、`run_interference_check`、`insert_component`。

先构建：

```bash
cd desktop
npm run build:ext
```

### Claude Code

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "automation-cad": {
      "command": "node",
      "args": ["C:/path/to/automation-cad-prototype/desktop/dist-electron/mcp.cjs"]
    }
  }
}
```

或使用 CLI：

```bash
claude mcp add automation-cad -- node "C:/path/to/automation-cad-prototype/desktop/dist-electron/mcp.cjs"
```

### Codex

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.automation-cad]
command = "node"
args = ["C:\\path\\to\\automation-cad-prototype\\desktop\\dist-electron\\mcp.cjs"]
```

stdio 本身是受信任的本机通道，不需要读取 userData 下的 Agent token。MCP 进程会读取：

- 内置包：仓库 `packs/builtin`，或环境变量 `AUTOMATIONCAD_BUILTIN_PACKS` 指定的目录；
- 用户包：`%APPDATA%/AutomationCAD/packs`（Linux 为 `~/.config/AutomationCAD/packs`）；
- 包启停状态：同目录下 `packs-state.json`。

## JSON-RPC 接口

桌面主进程启动后会监听 `127.0.0.1:7420`，并生成 token 文件：

- Windows：`%APPDATA%/AutomationCAD/agent-token`
- Linux：`~/.config/AutomationCAD/agent-token`

请求必须带 `Authorization: Bearer <token>`。示例：

```bash
TOKEN=$(cat ~/.config/AutomationCAD/agent-token)
curl -s http://127.0.0.1:7420/health -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:7420/rpc \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 智慧工厂

- 适配器：`demo`（内置仿真产线）、`opcua`（node-opcua，起步 `securityPolicy=None`）、`mqtt`（mqtt.js，按配置的 topic→点位映射订阅）。
- 配置持久化：`%APPDATA%/AutomationCAD/factory.json`，写入时权限 `0600`，密码不会通过状态接口回传。
- 主进程 `FactoryManager` 统一做 10 秒超时，并通过 EventEmitter 广播 `status` / `values`。
- 渲染层只能通过 preload 的 `window.desktop.factory.*` 访问；写点位前必须经过 `window.confirm` 二次确认。
- 连接失败、参数错误、超时都会以中文 `{ ok: false, code, message }` 返回，不向主进程抛未捕获异常。

## 数据包 UI

- 内置包只读；用户包导入 ZIP 后落到 `%APPDATA%/AutomationCAD/packs/<id>/`。
- 导入校验包含 manifest 必填字段、ID 冲突、ZIP 路径穿越；错误原因会原样显示在面板状态区。
- 启用/禁用即时影响标准件搜索结果。
- 「插入」写入 `localStorage` 键 `automationcad.parts.overlay.v1`，并派发 `automationcad:parts-overlay-changed` 事件；不修改 `app.js`。
