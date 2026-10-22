# 二期需求拆分（2026-10-22）

老王提出 6 项，按「可独立验证」拆成 4 批。每批都要有单测/冒烟证据，不允许只交付界面。

## 需求 → 模块映射

| # | 需求 | 落点 | 批次 |
|---|------|------|------|
| 1 | 机械：受力分析 + 干涉检测 | `desktop/src/mech/`（新建）+ 复用 `cad` 包围盒 | P2-A |
| 2 | 电气：PLC 模块（实体优先，无实体用模拟） | `desktop/src/plc/`（新建） | P2-B |
| 3 | 联调模块：模拟通电联调 | `desktop/src/commission/`（新建） | P2-B |
| 4 | 导出 PDF / CAD / 3D / BOM | `desktop/src/export/`（新建） | P2-A |
| 5 | 对接智慧工厂（Git 项目），文件同步 + 设置入口 | `desktop/src/sync/` + `factory` 设置页 | P2-C |
| 6 | 需要对方改动的文档 | `docs/desktop/SMART-FACTORY-INTEGRATION.md` | P2-C |

## P2-A 机械分析 + 导出

### 干涉检测（`mech/interference.ts`）
- 输入：`CadMeshData[]`（每件带 `name`、包围盒）
- 算法：AABB 两两相交 → 输出候选对；精确到三角形暂不做（标注「包围盒级初筛」）
- 输出：
  ```ts
  interface InterferenceHit {
    a: string; b: string;            // 零件名
    overlap: [number, number, number]; // 三轴重叠量 mm
    volumeApprox: number;            // 重叠盒体积，用于排序
    severity: 'error' | 'warning' | 'info';
    center: [number, number, number]; // 定位点，用于 3D 高亮
  }
  ```
- UI：右侧「干涉」面板，按 severity 分组，点击定位并高亮两件；支持「忽略并记录」（写 `localStorage` 白名单）
- 与原型 `ISSUES` 的关系：原型是写死的演示数据，本模块对**真实导入模型**计算，互不替代

### 受力分析（`mech/stress.ts`）
- 首版覆盖工程师最常手算的三类，全部给公式与安全系数：
  1. **气缸推力/拉力**：`F = p·A·η`，A 按缸径，η 取 0.85；对比负载得推力余量
  2. **悬臂梁（导轨/支臂）**：`δ = FL³/(3EI)`、`σ = M/W`，工字/矩形截面 I、W 由宽高算
  3. **螺栓预紧**：`F0 = 0.7·σy·As`，按 M4/M5/M6… 查 `As`，给滑移/分离安全系数
- 输出 `StressResult { formula, inputs, outputs: {value, unit}[], safetyFactor, verdict }`
- UI：左侧栏新增「受力」页签，参数可编辑，实时重算（150ms 防抖），不安全时状态栏变黄/红

### 导出（`export/`）
| 格式 | 实现 | 说明 |
|------|------|------|
| PDF | Electron `webContents.printToPDF`（主进程） | 由渲染层生成打印视图（图框 + 尺寸 + BOM），A3 横向 |
| 3D | three `GLTFExporter` / `OBJExporter` | 导出当前查看器场景，含零件名 |
| CAD | DXF（`dxf-writer`） | 先出 2D 视图（三视图/包围盒轮廓），不做 B-rep |
| BOM | CSV + XLSX（`xlsx`） | 列：序号/名称/型号/数量/材料/备注 |
- 统一入口：顶栏「导出」菜单 + `Ctrl+E`，导出前弹格式与范围选择
- 产物落 `userData/exports/<timestamp>/`，完成后在系统文件管理器中定位

## P2-B PLC 与联调

### PLC 模块（`plc/`）
- 统一接口 `PlcAdapter`：`connect / readCoils / writeCoil / readRegisters / writeRegister / subscribe / status`
- 实体优先：**Modbus TCP**（`modbus-serial`）覆盖绝大多数小型 PLC；预留 Siemens S7（`nodes7`）与 OPC UA（复用 `factory/opcua`）
- 无实体：内置 **PLC 模拟器**（线圈/寄存器内存表 + 简易梯形逻辑：串联/并联/自锁/定时器），UI 可强制点位
- 点位表从 IO 规划导出（28 点位，DI/DO/AI/AO），映射到 Modbus 地址（0x/1x/4x）

### 联调（`commission/`）
- 上电顺序：主回路 → 24V → PLC RUN → 气源 → 回原点，每步有前置条件与检查项
- 自动用例：按钮点动、气缸伸出/缩回、互锁验证、急停链路
- 结果：`{ step, expected, actual, pass, at }`，失败给出「阶段 + 点位 + 原因」，可导出 PDF 报告
- 仿真模式：PLC 模拟器 + 工厂 demo 适配器联动，无需真机即可跑完整流程

## P2-C 智慧工厂同步

- 后端：`material-flow-system`（GitHub/Gitee `owlco001/material-flow-system`，生产 `221.231.106.194:5556`）
- 现有能力：`GET /api/v1/devices/{id}/drawings`、`/api/v1/materials/{code}/drawings`、`/api/v1/drawings/{id}/pages/{n}`、BOM 导入（admin）、模型上传（admin，CSRF）
- 缺口：**机器对机器的设计包上传/版本比对接口**（admin 表单有 CSRF，不适合桌面客户端）
- 方案：新增 `/api/v1/design-sync/*`（API Key 鉴权）：
  - `POST /api/v1/design-sync/packages` 上传 zip（manifest + BOM + PDF + 3D + 指纹）
  - `GET  /api/v1/design-sync/packages?deviceId=` 列表与版本
  - `GET  /api/v1/design-sync/packages/{id}/diff` 与线上版本比对
  - `POST /api/v1/design-sync/bind` 绑定机台/物料
- 客户端：设置页填 `baseUrl + apiKey + deviceId`，测试连接；「同步」按钮做增量（按 sha256 跳过未变文件）
- 详细字段与改动清单见 `SMART-FACTORY-INTEGRATION.md`

### 实现状态（2026-10-22）

- ✅ 桌面客户端：`src/sync/`（固定路径 ZIP、manifest/SHA-256、15 秒超时、幂等上传、列表/diff）
- ✅ IPC `sync:getConfig/saveConfig/test/upload/list/diff` + `desktop.sync.*`
- ✅ 顶栏「智慧工厂」设置页：密钥掩码、启用开关、测试连接、立即同步、最近结果
- ✅ 本地 mock 单测 15 条；smoke 输出 `SMOKE_SYNC_UI_OK` 与 `SMOKE_SYNC_PACKAGE_OK files=4 sha=1`
- ⏳ 服务端 `/api/v1/design-sync/*` 尚未实现；本轮不改 material-flow 仓库，真实联调与绑定机台留待下一步

## 验收口径

- P2-A：给定两个相交立方体 STEP，干涉模块必须报出该对且重叠量正确（±0.01mm）；受力三个公式各一条单测；导出四种格式文件非空且可被对应解析器打开
- P2-B：模拟器下跑通 6 步上电 + 3 条用例，全部 pass；接真实 PLC 时同一用例不改代码
- P2-C：设置页「测试连接」成功；同步后后端能查到包与版本；二次同步因指纹相同而跳过上传
