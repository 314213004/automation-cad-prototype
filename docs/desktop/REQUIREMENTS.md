# 需求：非标自动化整机设计软件（Win11 桌面版）

来源：老王 2026-10-22 指令。目标平台：**Windows 11 桌面软件**。

## 1. 预留 Agent 接口
软件要能被外部 AI Agent 驱动，而不是只靠人点界面。

- 本机回环地址提供受 token 保护的 **JSON-RPC / REST** 接口（默认 `127.0.0.1:7420`）。
- 同时提供 **MCP (stdio)** 入口，便于 Claude Code / Codex / Hermes 直接挂载。
- 首批工具：`list_components`、`search_components`、`import_cad`、`get_bom`、`run_interference_check`、`insert_component`、`query_factory_tags`。
- 工具注册表只有一份，Agent 接口与内部命令面板共用；新增能力只加一条注册项。
- 所有写操作（插入零件、改属性）必须走与 UI 相同的事务入口，保证撤销栈一致。

## 2. 对接智慧工厂
- 统一的 `FactoryAdapter` 接口：`connect / disconnect / browse / readTags / writeTag / subscribe`。
- 首批实现：`demo`（内置仿真产线，开箱即用）、`opcua`（node-opcua）、`mqtt`（mqtt.js）。REST 预留。
- 连接配置存 `%APPDATA%/AutomationCAD/factory.json`，界面里可切换/测试连接。
- 机台点位可绑定到装配体/零件（例如「压装工位 → 气缸组」），在属性面板显示实时状态；写点位需二次确认。
- 断线自动重连 + 状态栏提示，不允许阻塞 UI。

## 3. 模块化加载元器件数据（用户可选）
- 元器件数据以「数据包（pack）」为单位：一个目录或 zip。
- 包结构：
  ```
  manifest.json   # id/name/vendor/version/schemaVersion/license/description
  parts.json      # 元器件数组（型号、类别、规格、价格、供应商、模型文件相对路径）
  assets/         # 可选：STEP/GLB 模型、缩略图
  ```
- 存放：内置包只读（随安装包）；用户包放 `%APPDATA%/AutomationCAD/packs/<id>/`。
- 界面：包管理页，支持导入 zip、启用/禁用、删除用户包、查看条目数；禁用即时从库中移除。
- 包校验：manifest 必填字段、id 冲突、路径穿越防护；坏包只报错不崩溃。
- 后续可加：在线包仓库、签名校验（本期只留字段）。

## 4. CAD 文件支持（轻量化）
- 目标：不装 SolidWorks、不买商业内核，也能**看**主流 CAD 文件并做基础测量。
- 选型（已在 2026-10-22 冒烟验证）：
  - `occt-import-js`（OpenCascade → WASM）：STEP / IGES / BREP 解析，输出三角网格。
  - `three.js`：渲染、剖切、拾取、尺寸测量。
  - three 自带 loader：STL / OBJ / GLTF/GLB / 3MF。
  - DXF（二维图纸）后续用 `dxf-parser` + Canvas/SVG。
- 已验证：424 KB STEP 装配体（as1-oc-214.stp）→ 5040 三角面 / 多零件 / 559 ms；10 mm 立方体包围盒精确 300×300×300（源文件单位 mm）。
- 能力边界：只做**网格级查看/测量/包围盒干涉初筛**，不做 B-rep 建模与真实布尔运算；界面需明示「轻量化查看模式」。
- 交互：菜单打开、拖拽到窗口、最近文件；导入后自动缩放到适合、显示零件树与三角面统计。

## 非目标（本期）
- 不做参数化建模内核、不做真实装配求解、不做 CAM。
- 不做云端多人协同。
