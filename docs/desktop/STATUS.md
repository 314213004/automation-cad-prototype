# 项目状态 · 2026-10-23

## 分支与产物

- 分支：`main`（GitHub `owlco001/automation-cad-prototype`）
- 运行环境：Linux 开发机 / 目标 Windows 11 x64
- 当前版本：`desktop/package.json` → 0.2.0
- 安装包：GitHub Actions（`windows-latest`）产出的 NSIS `AutomationCAD-Setup-0.2.0.exe`（约 133 MB），已随 tag `v0.2.0` 发布
- 历史产物：`v0.1.0` 便携包（zip，179 MB / 解压 472 MB），保留在 Release 中备查

## 已完成

| 模块 | 状态 | 位置 |
|------|------|------|
| Electron 外壳（单实例/菜单/拖放/headless smoke） | ✅ | `desktop/electron/` |
| CAD 查看（STEP/IGES/BREP/STL/OBJ/GLTF/GLB） | ✅ | `desktop/src/cad/` |
| WebGL 不可用降级 | ✅ 真实复现后修复 | `desktop/src/cad/webgl.ts` |
| 机械校核：干涉 AABB 初筛（重叠/体积/定位/分级/白名单） | ✅ | `desktop/src/mech/interference.ts` |
| 机械校核：气缸推力 / 悬臂梁 / 螺栓预紧（公式 + 安全系数） | ✅ | `desktop/src/mech/stress.ts` |
| 导出：A3 PDF 报告 / DXF / GLB / OBJ / BOM（CSV、XLSX） | ✅ | `desktop/src/export/` |
| 数据包注册表 + 导入/启停/删除 | ✅ | `desktop/src/packs/registry.ts` |
| 数据包 UI | ✅ | `desktop/src/packs/ui.ts` |
| 电气元件库（iec-cn，44 型号 / 12 分类 / 34 个带符号） | ✅ 按需加载、分类检索、放入原理图 | `packs/builtin/iec-cn/`、`desktop/src/packs/elec-ui.ts` |
| PLC 仿真（表达式/自锁/定时器）+ Modbus TCP（FC01–06） | ✅ 仿真实测，Modbus 未连真机 | `desktop/src/plc/` |
| 通电联调（6 步上电 + 3 用例 + PDF 章节） | ✅ | `desktop/src/commission/` |
| 智慧工厂 demo 适配器（2 工位 / 8 点位） | ✅ | `desktop/src/factory/demo.ts` |
| 智慧工厂 OPC UA / MQTT 适配器 | ✅ 已实现，未连真实设备验证 | `desktop/src/factory/` |
| 工厂面板（实时值 / 连接 / 写入确认） | ✅ | `desktop/src/factory/ui.ts` |
| 智慧工厂设计同步（ZIP/manifest/指纹幂等/设置页） | ✅ 本地 mock 验证，真实后端未实现 | `desktop/src/sync/` |
| Agent JSON-RPC（token + 7 工具 + 命令总线） | ✅ | `desktop/src/agent/{rpc,tools,commands}.ts` |
| Agent MCP stdio | ✅ | `desktop/src/agent/mcp.ts` |
| MCP 写工具代理（stdio → 桌面 RPC） | ✅ 本地假服务验证 | `desktop/src/agent/mcp-proxy.ts` |
| 应用内智能体对话（LLM 工具调用 + 模型设置 + 写操作确认） | ✅ 本地假 LLM 验证 | `desktop/src/agent/{llm,llm-config,session,ui}.ts` |
| 单元测试 | ✅ 146/146 | `desktop/test/` |
| headless smoke | ✅ `SMOKE_OK` | `npm run smoke` |
| Windows 安装包 CI | ✅ `windows-latest` 手动触发（`workflow_dispatch`） | `.github/workflows/windows.yml` |
| 应用图标 | ✅ 多尺寸 ICO（等轴测立方体） | `desktop/build/icon.ico` |

## 验证记录（真实执行）

- `npm test` → 146 pass / 0 fail
- `npm run smoke` → `SMOKE_UI_OK` / `SMOKE_SYNC_UI_OK fields=8` / `SMOKE_SYNC_PACKAGE_OK files=4 sha=1` / `SMOKE_PLC_OK points=28` / `SMOKE_COMMISSION_OK` / `SMOKE_AGENT_TOOLS_OK tools=7 implemented=7` / `SMOKE_AGENT_BRIDGE_OK scene=1 bom=1` / `SMOKE_AGENT_CHAT_UI_OK fields=6 log=1` / `SMOKE_OK`
- CDP 实测：载入 `cube.stp` → 12 三角面 / 300×300×300 mm；载入 424 KB 真实装配 → 18 零件 / 5,040 三角面 / 559 ms；工厂 demo 连接成功、browse 返回 2 工位 8 点位
- 界面截图：10 张 Electron 实跑截图（1440×873）已入库 `docs/desktop/screenshots/`，见 `MODULES.md` 的截图索引

## 未完成 / 已知限制

1. **无代码签名**：Win11 SmartScreen 首次拦截，需用户点「仍要运行」。也未做自动更新。
2. **OPC UA 仅支持 SecurityPolicy=None**，未接真实 PLC 验证；MQTT 未连真实 broker；Modbus TCP 未连真机（仿真器已实测）。
3. **智慧工厂服务端未落地**：`material-flow-system` 尚未实现 `/api/v1/design-sync/*`，客户端集成测试仅用本地 HTTP mock，见 `SMART-FACTORY-INTEGRATION.md`。
4. **便携包偏大**：Electron 45 + node-opcua，解压后数百 MB；后续可按需懒加载 node-opcua 或改 sidecar。
5. **干涉为 AABB 初筛**，非精确布尔求交；贴合面与螺纹啮合可能误报，需白名单收口。
6. **应用内对话的模型兼容性**只按 OpenAI 兼容协议、用本地假服务验证；真实服务商需逐个补验证。工具写入覆盖 import/insert/undo，属性修改与删除节点尚未提供撤销。
7. **CI 仅手动触发**：`gh workflow run windows-build --ref main`，推 `v*` tag 才会发布 Release；未配置 push/PR 自动构建。
8. **截图 `05-factory.png` 与文件名不符**：实际内容是联调面板在点位表为空时的拒绝上电状态，工厂实时值面板的截图待补拍（README 已按实际内容加注）。

## 下一批建议

1. 扩展 Agent 可撤销写操作：属性修改、删除节点，并补 MCP resources。
2. OPC UA 安全策略 Basic256Sha256 + 证书管理；MQTT TLS。
3. 用 demo 适配器做「点位 → 装配体」绑定，在 3D 视图叠加实时状态；顺带补拍工厂面板截图。
4. 代码签名 + 版本信息 + 自动更新（可后置）。
5. 精确干涉（三角面 BVH 求交）作为 AABB 初筛之后的第二级。
