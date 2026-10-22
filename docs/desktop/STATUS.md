# 项目状态 · 2026-10-22

## 分支与产物

- 分支：`feat/win11-desktop`（已推送 GitHub）
- 运行环境：Linux 开发机 / 目标 Windows 11 x64
- 便携构建：`desktop/release/AutomationCAD-0.1.0-win.zip`（179 MB，解压 472 MB）
- Release：`v0.1.0`（AutomationCAD 0.1.0 · Win11 便携版）

## 已完成

| 模块 | 状态 | 位置 |
|------|------|------|
| Electron 外壳（单实例/菜单/拖放/headless smoke） | ✅ | `desktop/electron/` |
| CAD 查看（STEP/IGES/BREP/STL/OBJ/GLTF） | ✅ | `desktop/src/cad/` |
| WebGL 不可用降级 | ✅ 真实复现后修复 | `desktop/src/cad/webgl.ts` |
| 数据包注册表 + 导入/启停/删除 | ✅ | `desktop/src/packs/` |
| 数据包 UI | ✅ | `desktop/src/packs/ui.ts` |
| Agent JSON-RPC（token + 7 工具 + 命令总线） | ✅ | `desktop/src/agent/` |
| Agent MCP stdio | ✅ | `desktop/src/agent/mcp.ts` |
| MCP 写工具代理（stdio → 桌面 RPC） | ✅ 本地假服务验证 | `desktop/src/agent/mcp-proxy.ts` |
| 应用内智能体对话（LLM 工具调用 + 设置） | ✅ 本地假 LLM 验证 | `desktop/src/agent/{llm,session,ui}.ts` |
| 智慧工厂 demo 适配器（2 工位 8 点位） | ✅ | `desktop/src/factory/demo.ts` |
| 智慧工厂 OPC UA / MQTT 适配器 | ✅ 已实现，未连真实设备验证 | `desktop/src/factory/` |
| 工厂面板（实时值/连接/写入确认） | ✅ | `desktop/src/factory/ui.ts` |
| 智慧工厂设计同步（ZIP/manifest/幂等/设置页） | ✅ 本地 mock 验证，真实后端未实现 | `desktop/src/sync/` |
| PLC 仿真 + Modbus TCP | ✅ 仿真实测，Modbus 未连真机 | `desktop/src/plc/` |
| 通电联调（6 步 + 3 用例 + PDF） | ✅ | `desktop/src/commission/` |
| 电气元件库（iec-cn，44 型号/12 分类） | ✅ 按需加载、分类检索、放入原理图 | `packs/builtin/iec-cn/`、`desktop/src/packs/elec-ui.ts` |
| 单元测试 | ✅ 146/146 | `desktop/test/` |
| headless smoke | ✅ `SMOKE_OK` | `npm run smoke` |
| 应用图标 | ✅ 多尺寸 ICO（等轴测立方体） | `desktop/build/icon.ico` |

## 验证记录（真实执行）

- `npm test` → 146 pass / 0 fail
- `npm run smoke` → `SMOKE_UI_OK` / `SMOKE_SYNC_UI_OK fields=8` / `SMOKE_SYNC_PACKAGE_OK files=4 sha=1` / `SMOKE_PLC_OK points=28` / `SMOKE_COMMISSION_OK` / `SMOKE_AGENT_TOOLS_OK tools=7 implemented=7` / `SMOKE_AGENT_BRIDGE_OK scene=1 bom=1` / `SMOKE_AGENT_CHAT_UI_OK fields=6 log=1` / `SMOKE_OK`
- CDP 实测：载入 cube.stp → 12 三角面 / 300×300×300 mm；工厂 demo 连接成功、browse 返回 2 工位 8 点位
- Windows 产物：`unzip -t` 通过，含 `AutomationCAD.exe`(PE32+ x64)、`resources/app.asar`、`resources/web/index.html`、`resources/packs/builtin/smc-cn`

## 未完成 / 风险

1. **NSIS 安装包**未产出：Linux 交叉构建需要 wine32 生成卸载器；本机安装 wine32 会破坏 PVE 的 apt 依赖（grub-common/libfreetype6 冲突），已回退 i386 架构。改用 GitHub Actions `windows-latest`，但当前 GitHub token 缺 `workflow` scope，无法推送 `.github/workflows/windows.yml`（文件在 `/root/.hermes/cache/scratch/ci/windows.yml`）。
2. 未做代码签名 → Win11 SmartScreen 会拦一次；应用图标仍是 Electron 默认图标。
3. OPC UA 只支持 SecurityPolicy=None，未接真实 PLC 验证；MQTT 未连真实 broker 验证。
4. 便携包 472 MB（Electron 45 + node-opcua 依赖），后续可按需懒加载 node-opcua 或改 sidecar 瘦身。
5. 应用内对话的测试连接与工具调用只使用本地假服务验证；真实 LLM 的兼容性需按服务商补充验证。
6. 智慧工厂设计同步只完成桌面客户端；`material-flow-system` 尚未落地 `/api/v1/design-sync/*`，当前集成测试仅使用本地 HTTP mock。

## 下一批建议

1. 扩展 Agent 可撤销写操作：属性修改、删除节点，并补 MCP resources。
2. OPC UA 安全策略 Basic256Sha256 + 证书管理；MQTT TLS。
3. 用 demo 适配器做「点位 → 装配体」绑定，在 3D 视图叠加实时状态。
4. 应用图标 + 版本信息 + 代码签名（可后置）。
5. NSIS 安装包：拿到 workflow scope 后启用 CI。
