# 模块索引与维护约定

本目录记录**每个模块的数据结构、坑点、进度、待办**。每个模块自己的文档放在该模块目录下的 `MODULE.md`，本页只做索引与跨模块关系。

## 索引

| 模块 | 文档 | 一句话职责 |
|------|------|-----------|
| 网页原型（根目录） | [PROTOTYPE.md](PROTOTYPE.md) | 视觉与交互基座，双击即开，桌面版直接加载 |
| Electron 主进程 | [desktop/electron/MODULE.md](../../desktop/electron/MODULE.md) | 窗口、菜单、IPC、Agent 启动、打包路径 |
| CAD 查看 | [desktop/src/cad/MODULE.md](../../desktop/src/cad/MODULE.md) | STEP/IGES/STL/OBJ/GLTF 解析与 three.js 渲染 |
| 元器件数据包 | [desktop/src/packs/MODULE.md](../../desktop/src/packs/MODULE.md) | 包格式、校验、导入/启停/删除、检索、电气元件库面板 |
| 内置包数据 | [packs/builtin/MODULE.md](../../packs/builtin/MODULE.md) | smc-cn 8 个型号、iec-cn 44 型号 / 12 分类与字段约定 |
| Agent 接口 | [desktop/src/agent/MODULE.md](../../desktop/src/agent/MODULE.md) | 工具注册表、JSON-RPC、MCP stdio |
| 智慧工厂 | [desktop/src/factory/MODULE.md](../../desktop/src/factory/MODULE.md) | demo / OPC UA / MQTT 适配器与点位模型 |
| 智慧工厂同步 | [desktop/src/sync/MODULE.md](../../desktop/src/sync/MODULE.md) | 设计包 ZIP、manifest、上传/列表/diff 与设置页 |
| PLC | [desktop/src/plc/MODULE.md](../../desktop/src/plc/MODULE.md) | sim / Modbus TCP 适配器、28 点位与 plc.json |
| 通电联调 | [desktop/src/commission/MODULE.md](../../desktop/src/commission/MODULE.md) | 6 步上电、3 条用例、序列执行与报告 |
| 机械校核 | [desktop/src/mech/MODULE.md](../../desktop/src/mech/MODULE.md) | 包围盒干涉初筛 + 气缸/悬臂梁/螺栓计算 |
| 电气校验 | [desktop/src/elec/MODULE.md](../../desktop/src/elec/MODULE.md) | 线号合规、功率统计、导线截面与断路器配合、校验面板与 PDF |
| 导出 | [desktop/src/export/MODULE.md](../../desktop/src/export/MODULE.md) | PDF 报告 / DXF / GLB / OBJ / BOM |
| 渲染层扩展与面板 | [desktop/src/ui/MODULE.md](../../desktop/src/ui/MODULE.md) | 注入方式、DOM 契约、三块面板 |
| 测试与构建 | [desktop/test/MODULE.md](../../desktop/test/MODULE.md) | 单测/smoke/打包链与证据口径 |

其它文档：需求 `REQUIREMENTS.md`、架构 `ARCHITECTURE.md`、当前状态 `STATUS.md`、CI 启用 `CI.md`、插件格式 `PLUGIN-PACKS.md`、元器件资料 [`../reference/`](../reference/README.md)。项目总览与界面截图见根 [README.md](../../README.md)。

## 截图目录（docs/desktop/screenshots/）

Electron 实跑 + CDP 抓取，1440×873，不是设计稿。文件名与内容：

| 文件 | 内容 |
|------|------|
| `01-home.png` | 主界面：原型 8 视图 + 桌面入口（CAD 查看 / 工厂 / 联调 / 数据包 / 电气元件 / 智慧工厂 / 智能体） |
| `02-cad-assembly.png` | CAD 查看：STEP 装配体 18 零件 / 5,040 三角面、零件列表 |
| `03-interference.png` | 干涉检测：28 处候选、按严重度分组、点击定位 |
| `04-stress.png` | 受力分析：气缸推力公式、余量与安全系数 |
| `05-factory.png` | 智慧工厂：demo 适配器连接后 2 工位 × 4 点位实时值 |
| `06-commission.png` | 通电联调：sim 已连接、6 步上电全部通过 |
| `07-packs.png` | 数据包：内置包列表、导入/启停、检索 |
| `08-elec-library.png` | 电气元件库：44 型号 / 12 分类、符号标记与「放入图纸」 |
| `09-agent.png` | 智能体面板：对话、工具、模型设置、本机服务信息 |
| `10-sync-settings.png` | 智慧工厂同步设置：baseUrl / 机台编号 / 项目 / API Key 掩码 |

引用约定：README 与文档一律用**相对仓库根**的路径（如 `docs/desktop/screenshots/01-home.png`），保证 GitHub 上可直接渲染；补拍或替换截图时保持同名覆盖，避免文档批量改链接。

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

## 当前总体进度（2026-10-23）

- ✅ v0.2.0 已发布：GitHub Actions `windows-latest` 产出 NSIS 安装包（手动触发 `workflow_dispatch`）
- ✅ 146 个单测 + 完整 smoke 断言全绿
- ✅ CAD 轻量化查看（STEP 实测 18 零件 / 5,040 面 / 559 ms）、WebGL 降级
- ✅ 数据包机制 + 面板 + Agent 检索；iec-cn 电气元件库（44 型号 / 12 分类 / 34 带符号）
- ✅ 机械校核（干涉 AABB + 气缸/悬臂梁/螺栓）与五种导出（PDF / DXF / GLB / OBJ / BOM）
- ✅ PLC 抽象 + 仿真/Modbus TCP + 通电联调（6 步 + 3 用例）
- ✅ 智慧工厂三适配器 + 设计包同步客户端 + 设置页（真实服务端待实现）
- ✅ Agent 写操作（导入/插入/撤销/BOM/干涉）+ MCP 本机代理 + 应用内对话面板
- ⏳ 真实 PLC 联调、代码签名、设计同步服务端接口

## 参数化建模（P9）

- `desktop/electron/parametric.ts`：sidecar 生命周期（随机端口/令牌、健康检查、30 s 构建超时、10 min 空闲退出、崩溃重启一次、进程树清理）
- `desktop/src/parametric/features.ts`：特征树 `FeatureDoc`、中文全量校验、`compileOps`（跳过抑制、稳定顺序）、`summarize`
- `spike/build123d/app.py`：Python sidecar（`/health`、`/build`，算子白名单 box/cylinder/holes/slot/fillet）
- 内核选型与分期见 [PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；实测见 [PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)

## 维护约定

1. **改模块先改文档**：新增字段/接口时同步更新该模块 `MODULE.md` 的「数据结构」。
2. **坑点只记真实踩过的**，写清现象与解法；不要写泛泛的「注意异常处理」。
3. **进度用 ✅ / ⏳ 标记**，不要写完成日期以外的猜测。
4. **待办按可验证性排序**，每条要能被测试或人工步骤验收。
5. 跨模块的决策写进 `ARCHITECTURE.md`，不要散落在各模块文档里。
