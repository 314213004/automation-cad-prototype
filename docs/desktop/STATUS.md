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
| Agent JSON-RPC（token + 6 工具） | ✅ | `desktop/src/agent/` |
| Agent MCP stdio | ✅ | `desktop/src/agent/mcp.ts` |
| 智慧工厂 demo 适配器（2 工位 8 点位） | ✅ | `desktop/src/factory/demo.ts` |
| 智慧工厂 OPC UA / MQTT 适配器 | ✅ 已实现，未连真实设备验证 | `desktop/src/factory/` |
| 工厂面板（实时值/连接/写入确认） | ✅ | `desktop/src/factory/ui.ts` |
| 单元测试 | ✅ 34/34 | `desktop/test/` |
| headless smoke | ✅ `SMOKE_OK` | `npm run smoke` |
| 应用图标 | ✅ 多尺寸 ICO（等轴测立方体） | `desktop/build/icon.ico` |

## 验证记录（真实执行）

- `npm test` → 34 pass / 0 fail
- `npm run smoke` → `SMOKE_CAD_OK triangles=12 meshes=1` / `SMOKE_WEBGL_FALLBACK_OK` / `SMOKE_UI_OK stations=2 tags=8 packs=1 parts=8`
- CDP 实测：载入 cube.stp → 12 三角面 / 300×300×300 mm；工厂 demo 连接成功、browse 返回 2 工位 8 点位
- Windows 产物：`unzip -t` 通过，含 `AutomationCAD.exe`(PE32+ x64)、`resources/app.asar`、`resources/web/index.html`、`resources/packs/builtin/smc-cn`

## 未完成 / 风险

1. **NSIS 安装包**未产出：Linux 交叉构建需要 wine32 生成卸载器；本机安装 wine32 会破坏 PVE 的 apt 依赖（grub-common/libfreetype6 冲突），已回退 i386 架构。改用 GitHub Actions `windows-latest`，但当前 GitHub token 缺 `workflow` scope，无法推送 `.github/workflows/windows.yml`（文件在 `/root/.hermes/cache/scratch/ci/windows.yml`）。
2. 未做代码签名 → Win11 SmartScreen 会拦一次；应用图标仍是 Electron 默认图标。
3. OPC UA 只支持 SecurityPolicy=None，未接真实 PLC 验证；MQTT 未连真实 broker 验证。
4. 便携包 472 MB（Electron 45 + node-opcua 依赖），后续可按需懒加载 node-opcua 或改 sidecar 瘦身。
5. Agent 的 `import_cad` / `insert_component` / `run_interference_check` 仍返回 `NOT_IMPLEMENTED`（结构已就位，等 UI 侧命令总线和撤销栈接通）。

## 下一批建议

1. 打通 Agent 写操作：命令总线 + 撤销栈，让 `insert_component` 真实改装配树。
2. OPC UA 安全策略 Basic256Sha256 + 证书管理；MQTT TLS。
3. 用 demo 适配器做「点位 → 装配体」绑定，在 3D 视图叠加实时状态。
4. 应用图标 + 版本信息 + 代码签名（可后置）。
5. NSIS 安装包：拿到 workflow scope 后启用 CI。
