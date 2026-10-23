# 模块：测试与构建（test/、scripts/、build/）

职责：在没有真实 Windows 机器的前提下，用可自动化的证据证明「解析正确、接口可用、界面能起」。

## 测试分层

| 层 | 位置 | 跑法 | 说明 |
|----|------|------|------|
| 纯逻辑单测 | `test/**/*.test.mjs` | `npm test`（`node --test`） | 不依赖 Electron |
| CAD 解析 | `test/cad/step.test.mjs` | 同上 | 用 `test/fixtures/cube.stp`，断言 12 面 / 300³ mm |
| Agent RPC | `test/agent/rpc.test.mjs` | 同上 | 起真实 http server，验 401 / tools/list / -32601 / 600 权限 |
| 命令总线 | `test/agent/commands.test.mjs` | 同上 | 注册/重复注册/未知命令/失败历史/撤销、参数校验、桥超时 |
| 工具表 | `test/agent/tools.test.mjs` | 同上 | 8 工具、BOM 空数组、干涉截断、插入与撤销 |
| MCP | `test/agent/mcp.test.mjs` | 同上 | `buildServer()` 后列 8 个工具 |
| 电气校验 | `test/elec/{check,report}.test.mjs`、`test/agent/elec-check.test.mjs` | 同上 | 线号/功率/截面规则、报告转义、命令入参校验、工具 schema |
| MCP 代理 | `test/agent/mcp-proxy.test.mjs` | 同上 | 写工具转发、无桌面时只读回退/写工具降级、超时不泄露 token |
| 模型配置 | `test/agent/llm-config.test.mjs` | 同上 | 默认值、apiKey 掩码、600 权限、掩码保存保留原密钥 |
| LLM 客户端 | `test/agent/llm.test.mjs` | 同上 | 本地假 HTTP：tool_calls、最终文本、401 中文错误、超时、ping max_tokens=8 |
| 会话循环 | `test/agent/session.test.mjs` | 同上 | 0/1/2 次工具调用、超轮、失败回灌、确认拒绝、20 条历史上限 |
| 工厂 | `test/factory/*.test.mjs` | 同上 | demo 连接/读取/订阅；OPC UA/MQTT 只做参数校验（不连外网） |
| PLC | `test/plc/*.test.mjs` | 同上 | sim 表达式/自锁/定时器/force、Modbus 参数与中文错误、配置持久化 |
| 联调 | `test/commission/*.test.mjs` | 同上 | 序列通过/超时/前置失败/异常；28 点位、6 步上电、3 用例；10 条诊断规则/排序/兜底 |
| 设计同步 | `test/sync/*.test.mjs` | 同上 | manifest/SHA、ZIP 路径、缺文件、配置脱敏、401/404/超时、幂等、diff |
| 数据包 | `test/packs/*.test.mjs` | 同上 | 包校验/导入、symbol 字段、iec-cn 数据契约、参考表生成、符号映射扫描 |
| 端到端冒烟 | `electron . --headless-smoke` | `npm run smoke` | xvfb 下加载页面、注入扩展、解析 fixture、断言 UI 结构 |

## smoke 的断言输出

```
SMOKE_CAD_OK triangles=12 meshes=1
SMOKE_WEBGL_FALLBACK_OK meshes=1 triangles=12 bounds=300.000 × 300.000 × 300.000 mm
SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25
SMOKE_UI_OK stations=2 tags=8 packs=2 parts=9 overlay=1
SMOKE_ELEC_LIB_OK parts=44 categories=12 symbols=34
SMOKE_SYNC_UI_OK fields=8 apiKey=password enabled=checkbox
SMOKE_SYNC_PACKAGE_OK files=4 sha=1
SMOKE_PLC_OK points=28
SMOKE_COMMISSION_OK steps=6 passed=6
SMOKE_COMMISSION_UI_OK cases=3 monitor=28 results=18
SMOKE_COMMISSION_PDF_OK path=.../report.pdf
SMOKE_COMMISSION_3D_OK ticks=... parts=16
SMOKE_COMMISSION_3D_SCALE_OK stations=4 actuators=12 sensors=16 parts=16 ticks=...
SMOKE_DIAGNOSE_OK codes=1
SMOKE_AGENT_TOOLS_OK tools=10 implemented=10
SMOKE_AGENT_BRIDGE_OK scene=1 bom=1
SMOKE_AGENT_CHAT_UI_OK fields=6 log=1
SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2 summary=ok scene=0
SMOKE_AGENT_NL_OK intents=7 tools=10 audit=3 ctx=1776
SMOKE_OK
```
任一断言失败 → 退出码 1，并打印 `SMOKE_FAIL <原因>`。

## 构建链

```
npm run build:ext
 ├─ tsc --noEmit                     # 类型门禁
 ├─ vite build                       # src/extension.ts → dist/extension.js（IIFE）
 └─ node scripts/build-electron.mjs  # electron/ + src/{packs,agent} → dist-electron/*.cjs
```
打包：`electron-builder --win zip --x64`（免 wine）或 `--win nsis`（需 wine32 / Windows runner）。

## 坑点

1. **`node --test test` 在 Node 26 会把目录当模块报 `MODULE_NOT_FOUND`**，用 `node --test`（自动发现 `*.test.mjs`）。
2. **root 下 Electron 必须 `--no-sandbox`**，smoke 脚本内置 `ELECTRON_DISABLE_SANDBOX=1`。
3. **smoke 的单实例锁**：上一次测试残留进程会让新实例直接退出，表现为端口不通；跑前 `pkill -x electron`。
4. **smoke 会把 `app.setPath('userData')` 指到 `mkdtemp` 的临时目录**（日志里的 `automationcad-smoke-*`），避免污染 `%APPDATA%/AutomationCAD`；真实运行仍是后者。
5. **不要把「构建成功」当测试证据**：`vite build` 成功不代表 WASM 路径对，必须跑 `step.test` + smoke。
6. **fixture 版权**：`cube.stp` 来自 occt-import-js 测试集，只用于测试，不要打进产品包。

## 进度

- ✅ 466 个单测全绿（含 MCP 代理、LLM 客户端、会话循环、命令总线、离线意图路由、上下文裁剪、审计脱敏、计划预览与统一回执、数据包、同步、联调诊断与配置驱动 3D）
- ✅ smoke 含智能体 10 工具/场景/BOM/对话面板/只读问答 UI（计划预览 + 审计面板）/离线路由与审计、电气元件面板、PLC、6 步上电、3 用例、联调 PDF、3D 联动与故障诊断断言
- ⏳ CI（GitHub Actions）因 token 缺 `workflow` scope 未启用，见 `docs/desktop/CI.md`
- ⏳ 性能基准（10 万面模型解析耗时）未建立

## 待办

1. 补损坏 CAD 文件、超大文件的真实渲染层导入异常用例。
2. 增加 Windows 端的 smoke（GitHub Actions windows-latest 上跑 `--headless-smoke`）。
3. 把 10 万面 STEP 纳入基准，设阈值（如 <5s）防回归。
4. 服务端 `design-sync` 落地后，用本地 `material-flow-system` 测试库替换 mock 做端到端验证。
