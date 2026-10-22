# 模块索引与维护约定

本目录记录**每个模块的数据结构、坑点、进度、待办**。每个模块自己的文档放在该模块目录下的 `MODULE.md`，本页只做索引与跨模块关系。

## 索引

| 模块 | 文档 | 一句话职责 |
|------|------|-----------|
| 网页原型（根目录） | [PROTOTYPE.md](PROTOTYPE.md) | 视觉与交互基座，双击即开，桌面版直接加载 |
| Electron 主进程 | [desktop/electron/MODULE.md](../../desktop/electron/MODULE.md) | 窗口、菜单、IPC、Agent 启动、打包路径 |
| CAD 查看 | [desktop/src/cad/MODULE.md](../../desktop/src/cad/MODULE.md) | STEP/IGES/STL/OBJ/GLTF 解析与 three.js 渲染 |
| 元器件数据包 | [desktop/src/packs/MODULE.md](../../desktop/src/packs/MODULE.md) | 包格式、校验、导入/启停/删除、检索 |
| 内置包数据 | [packs/builtin/MODULE.md](../../packs/builtin/MODULE.md) | smc-cn 8 个型号与字段约定 |
| Agent 接口 | [desktop/src/agent/MODULE.md](../../desktop/src/agent/MODULE.md) | 工具注册表、JSON-RPC、MCP stdio |
| 智慧工厂 | [desktop/src/factory/MODULE.md](../../desktop/src/factory/MODULE.md) | demo / OPC UA / MQTT 适配器与点位模型 |
| 智慧工厂同步 | [desktop/src/sync/MODULE.md](../../desktop/src/sync/MODULE.md) | 设计包 ZIP、manifest、上传/列表/diff 与设置页 |
| PLC | [desktop/src/plc/MODULE.md](../../desktop/src/plc/MODULE.md) | sim / Modbus TCP 适配器、28 点位与 plc.json |
| 通电联调 | [desktop/src/commission/MODULE.md](../../desktop/src/commission/MODULE.md) | 6 步上电、3 条用例、序列执行与报告 |
| 机械校核 | [desktop/src/mech/MODULE.md](../../desktop/src/mech/MODULE.md) | 包围盒干涉初筛 + 气缸/悬臂梁/螺栓计算 |
| 导出 | [desktop/src/export/MODULE.md](../../desktop/src/export/MODULE.md) | PDF 报告 / DXF / GLB / OBJ / BOM |
| 渲染层扩展与面板 | [desktop/src/ui/MODULE.md](../../desktop/src/ui/MODULE.md) | 注入方式、DOM 契约、三块面板 |
| 测试与构建 | [desktop/test/MODULE.md](../../desktop/test/MODULE.md) | 单测/smoke/打包链与证据口径 |

其它文档：需求 `REQUIREMENTS.md`、架构 `ARCHITECTURE.md`、当前状态 `STATUS.md`、CI 启用 `CI.md`。

## 跨模块数据流

```
用户操作 ─┬─ 菜单/拖放 ──→ electron/main.ts ──IPC──→ renderer
          ├─ CAD 文件 ──→ readFileBuffer → Worker(occt WASM) → CadImportResult → three 渲染
          ├─ 数据包   ──→ packs/registry（主进程）→ listParts → 面板 / Agent
          ├─ 工厂     ──→ factory/manager → adapters → TagValue → 面板
          └─ 设计同步 ──→ sync/client（主进程）→ /api/v1/design-sync/* → 面板

外部 Agent ──→ agent/rpc.ts 或 mcp.ts ──→ agent/tools.ts ──→ packs/registry（只读）
```

**边界原则**：渲染层无 fs/net 权限；主进程不做几何计算；Agent 与 UI 共用同一份工具/命令注册表。

## 当前总体进度（2026-10-22）

- ✅ Win11 便携构建可运行；34 个单测 + 四段 smoke 断言全绿
- ✅ CAD 轻量化查看（STEP 实测 5040 面 / 559 ms）、WebGL 降级
- ✅ 数据包机制 + 面板 + Agent 检索
- ✅ 工厂三适配器 + 面板（demo 实测）
- ✅ 机械校核（干涉 + 三类受力计算）与四种导出（P2-A，56 单测）
- ✅ PLC 抽象 + 仿真/Modbus TCP + 通电联调（P2-B）
- ✅ 智慧工厂设计包同步客户端 + 设置页（P2-C，92 单测；真实服务端待实现）
- ⏳ Agent 写操作、真实 PLC 联调、NSIS 安装包（Issues #2/#3）

## 维护约定

1. **改模块先改文档**：新增字段/接口时同步更新该模块 `MODULE.md` 的「数据结构」。
2. **坑点只记真实踩过的**，写清现象与解法；不要写泛泛的「注意异常处理」。
3. **进度用 ✅ / ⏳ 标记**，不要写完成日期以外的猜测。
4. **待办按可验证性排序**，每条要能被测试或人工步骤验收。
5. 跨模块的决策写进 `ARCHITECTURE.md`，不要散落在各模块文档里。
