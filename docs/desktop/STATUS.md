# 项目状态 · 2026-10-23

## 分支与产物

- 分支：`main`（GitHub `owlco001/automation-cad-prototype`）
- 运行环境：Linux 开发机 / 目标 Windows 11 x64
- 当前版本：`desktop/package.json` → 0.3.0（源码与文档就绪；本次未打包）
- 安装包：最近发布为 `v0.2.0` NSIS `AutomationCAD-Setup-0.2.0.exe`（约 133 MB）；`v0.3.0` 需老王通知后手动触发构建
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
| 电气元件库（iec-cn，371 型号 / 26 分类 / 191 个真实尺寸） | ✅ 按需加载、分类检索、放入原理图与底板 | `packs/builtin/iec-cn/`、`desktop/src/packs/elec-ui.ts` |
| 电气校验（线号合规 / 功率统计 / 导线截面与断路器 / 面板 + PDF 报告 + Agent 工具） | ✅ | `desktop/src/elec/`、`src/agent/{commands,tools}.ts` |
| PLC 仿真（表达式/自锁/定时器）+ Modbus TCP（FC01–06） | ✅ 仿真实测，Modbus 未连真机 | `desktop/src/plc/` |
| 通电联调（6 步上电 + 3 用例 + PDF 章节） | ✅ | `desktop/src/commission/` |
| 智慧工厂 demo 适配器（2 工位 / 8 点位） | ✅ | `desktop/src/factory/demo.ts` |
| 智慧工厂 OPC UA / MQTT 适配器 | ✅ 已实现，未连真实设备验证 | `desktop/src/factory/` |
| 工厂面板（实时值 / 连接 / 写入确认） | ✅ | `desktop/src/factory/ui.ts` |
| 智慧工厂设计同步（ZIP/manifest/指纹幂等/设置页） | ✅ 本地端到端（后端 0.22.0），生产部署未验证 | `desktop/src/sync/` |
| Agent JSON-RPC（token + 12 工具 + 命令总线） | ✅ | `desktop/src/agent/{rpc,tools,commands}.ts` |
| Agent MCP stdio | ✅ | `desktop/src/agent/mcp.ts` |
| MCP 写工具代理（stdio → 桌面 RPC） | ✅ 本地假服务验证 | `desktop/src/agent/mcp-proxy.ts` |
| 应用内智能体对话（LLM 工具调用 + 模型设置 + 写操作确认） | ✅ 本地假 LLM 验证 | `desktop/src/agent/{llm,llm-config,session,ui}.ts` |
| 单元测试 | ✅ 674/674 | `desktop/test/` |
| headless smoke | ✅ `SMOKE_OK` | `npm run smoke` |
| Windows 安装包 CI | ✅ `windows-latest` 手动触发（`workflow_dispatch`） | `.github/workflows/windows.yml` |
| 应用图标 | ✅ 多尺寸 ICO（等轴测立方体） | `desktop/build/icon.ico` |

## 验证记录（真实执行）

- `npm test` → 674 pass / 0 fail
- `npm run smoke` → `SMOKE_PLCGEN_*` / `SMOKE_ELEC_LIB_OK parts=371 categories=26` / `SMOKE_AGENT_TOOLS_OK tools=12 implemented=12` / `SMOKE_PARAMETRIC_*_OK`（带假 sidecar）/ `SMOKE_OK`
- CDP 实测：载入 `cube.stp` → 12 三角面 / 300×300×300 mm；载入 424 KB 真实装配 → 18 零件 / 5,040 三角面 / 559 ms；工厂 demo 连接成功、browse 返回 2 工位 8 点位
- 界面截图：14 张 Electron 实跑截图已入库 `docs/desktop/screenshots/`，见 `MODULES.md` 的截图索引

## 未完成 / 已知限制

1. **无代码签名**：Win11 SmartScreen 首次拦截，需用户点「仍要运行」。也未做自动更新。
2. **OPC UA 仅支持 SecurityPolicy=None**，未接真实 PLC 验证；MQTT 未连真实 broker；Modbus TCP 未连真机（仿真器已实测）。
3. **智慧工厂生产部署未验证**：`material-flow-system` 0.22.0 的 `/api/v1/design-sync/*` 已实现并通过 30 项测试，本地临时 DB 端到端已通过；生产实例 `221.231.106.194:5556` 当前从开发机不可达，部署仍待 D2 决策。
4. **便携包偏大**：Electron 45 + node-opcua，解压后数百 MB；后续可按需懒加载 node-opcua 或改 sidecar。
5. **干涉为 AABB 初筛**，非精确布尔求交；贴合面与螺纹啮合可能误报，需白名单收口。
6. **应用内对话的模型兼容性**只按 OpenAI 兼容协议、用本地假服务验证；真实服务商需逐个补验证。工具写入覆盖 import/insert/undo，属性修改与删除节点尚未提供撤销。
7. **CI 仅手动触发**：`gh workflow run windows-build --ref main`，推 `v*` tag 才会发布 Release；未配置 push/PR 自动构建。
8. **截图覆盖**：`05-factory.png` 为智慧工厂 demo 连接后的实时值面板（2 工位 × 4 点位）；点表为空时的拒绝路径由联调面板负责，不再单独截图。

## 下一批建议

1. 扩展 Agent 可撤销写操作：属性修改、删除节点，并补 MCP resources。
2. OPC UA 安全策略 Basic256Sha256 + 证书管理；MQTT TLS。
3. 用 demo 适配器做「点位 → 装配体」绑定，在 3D 视图叠加实时状态；顺带补拍工厂面板截图。
4. 代码签名 + 版本信息 + 自动更新（可后置）。
5. 精确干涉（三角面 BVH 求交）作为 AABB 初筛之后的第二级。
