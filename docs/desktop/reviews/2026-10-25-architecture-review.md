# Automation CAD Prototype 系统架构与技术文档

> **项目仓库**：[owlco001/automation-cad-prototype (`main` 分支)](https://github.com/owlco001/automation-cad-prototype/tree/main)  
> **定位**：面向工业自动化领域的下一代 **机械 CAD + 电气 EDA + PLC 控制 + AI Agent** 一体化非标整机设计桌面端原型（Windows 11 Desktop Edition）。

## 1. 项目概述与核心设计理念

传统的非标自动化整机设计流程往往割裂在多个独立软件中：机械工程师使用三维 CAD 进行结构设计，电气工程师使用 EDA 绘制原理图与控制柜布局，控制工程师在 PLC 编程软件中编写逻辑，最后再进行高风险的现场调试。

**[owlco001/automation-cad-prototype](https://github.com/owlco001/automation-cad-prototype/tree/main)** 旨在打破机电控软件孤岛，在统一的数据模型与参数化引擎之上，构建**机械-电气-控制-算法闭环**的一体化设计平台：

- **机电控同源联动**：三维机械结构（`cad` / `mech`）、电气原理图（`elec`）、电柜板金布局（`enclosure`）与 PLC 控制程序（`plc` / `plcgen`）共享底层组件包与 IO 拓扑，一处修改全局同步。
- **AI 原生与 MCP 驱动**：内置基于 `@modelcontextprotocol/sdk` 的本地 Model Context Protocol (MCP) 服务端与多角色 Agent 引擎（规划、选型顾问、合规审计、预算控制、自动修复），支持通过自然语言完成复杂整机方案生成与校验。
- **参数化建模与双几何引擎**：结合 **Three.js** 实时渲染与 **OpenCASCADE (`occt-import-js`)** 精确 B-Rep 拓扑几何解析，支持标准件参数化装配、运动学求解与电机负载惯量计算。
- **工业协议虚拟调试（数字孪生）**：原生集成 **OPC UA**、**Modbus RTU/TCP** 与 **MQTT** 客户端，可直接连接真实或仿真 PLC 实时驱动三维机构运动。
- **工程交付一键导出**：支持直接导出 2D 工程图（`DXF`）、3D 模型（`STEP`）、物料成本清单（`Excel BOM`）及 PLC 结构化控制代码（ST / 梯形图）。

## 2. 系统分层架构

项目采用 **双形态架构**（根目录轻量 Web 原型 + `desktop/` 完整 Electron 桌面端工程），其中核心生产能力集中在 `desktop/` 目录下，整体分为五层：

| 架构层级 | 核心模块 / 目录 | 关键职责与技术实现 |
| :--- | :--- | :--- |
| **表现与交互层 (UI & Viewport)** | `desktop/src/ui/`、`desktop/src/orbit/`、`index.html` | 提供多面板工作区、三维视口相机控制（Orbit）、电气原理图画布及参数属性面板 |
| **AI 智能体与协议层 (Agent & MCP)** | `desktop/src/agent/`、`desktop/src/mcp-server.ts` | 暴露 MCP 工具集，执行任务拆解（Planner）、行业知识库检索（KB）、合规审计（Audit）与自动修复（Repair） |
| **领域业务引擎层 (Domain Engines)** | `cad/`、`mech/`、`elec/`、`enclosure/`、`plc/`、`plcgen/`、`factory/`、`cost/` | 承载三维几何建模、机械选型计算、自动布线、电柜导轨排布、PLC 逻辑生成、产线仿真及 BOM 成本核算 |
| **工业互联与交付层 (I/O & Export)** | `desktop/src/commission/`、`desktop/src/export/`、`desktop/src/sync/` | 通过 Modbus / OPC UA / MQTT 实现数字孪生虚拟调试；导出 DXF、STEP、Excel BOM；支持多端状态同步 |
| **宿主与系统运行时层 (Electron Host)** | `desktop/electron/` (`main.ts`, `ipc.ts`, `preload.ts`, `parametric.ts`) | 管理 Windows 11 桌面窗口生命周期、原生文件系统访问、主进程参数化计算绑定与离屏渲染截图 |

## 3. 仓库完整目录结构

```text
automation-cad-prototype/
├── .github/
│   └── workflows/                    # CI/CD 自动化构建与测试工作流
├── desktop/                          # Windows 11 Electron 桌面端主工程
│   ├── build/                        # 打包配置与安装程序构建资源
│   ├── electron/                     # Electron 主进程与系统桥接层
│   │   ├── main.ts                   # 桌面应用主进程入口与窗口管理
│   │   ├── ipc.ts                    # 主进程与渲染进程 IPC 通信通道注册
│   │   ├── preload.ts                # 安全上下文隔离与渲染进程 API 暴露
│   │   ├── parametric.ts             # 主进程侧参数化几何计算绑定
│   │   ├── screenshots.ts            # 3D 视口快照与工程视图截图导出
│   │   └── machine-screenshots.ts    # 整机模型多视角自动快照渲染
│   ├── eval/                         # 自动化评测、Smoke 测试与基准测试脚本
│   ├── scripts/                      # 构建辅助与后处理脚本
│   ├── src/                          # 桌面端渲染进程核心源码 (TypeScript)
│   │   ├── agent/                    # AI Agent 智能设计引擎
│   │   │   └── kb/                   # 工业自动化领域知识库与选型规则
│   │   ├── cad/                      # 3D CAD 渲染与几何内核 (Three.js + OCCT)
│   │   ├── commission/               # 虚拟调试引擎 (Modbus / OPC UA / MQTT)
│   │   ├── cost/                     # BOM 物料成本估算与报价分析引擎
│   │   ├── elec/                     # 电气原理图设计、网络表与自动连线
│   │   ├── enclosure/                # 电气控制柜结构、DIN 导轨与线槽排布
│   │   ├── export/                   # 多格式工程文件导出 (DXF, STEP, Excel BOM)
│   │   ├── factory/                  # 工厂产线级布局与物流节拍仿真
│   │   ├── machine/                  # 整机机型模板与模块化组装逻辑
│   │   ├── mech/                     # 机械结构设计、运动学求解与电机选型
│   │   ├── orbit/                    # 3D 场景相机控制与视角导航
│   │   ├── packs/                    # 标准件与元器件资源包加载器
│   │   ├── parametric/               # 参数化建模引擎与脚本解释执行
│   │   ├── plc/                      # PLC 运行仿真与 IO 点位映射
│   │   ├── plcgen/                   # PLC 控制代码 (ST / 梯形图) 自动生成
│   │   ├── shared/                   # 跨模块共享数据模型、常量与工具函数
│   │   ├── sync/                     # 状态同步与多用户协同设计模块
│   │   ├── ui/                       # 桌面端工作区界面组件与属性面板
│   │   ├── extension.ts              # 第三方扩展插件系统接口
│   │   ├── mcp-server.ts             # 本地 Model Context Protocol (MCP) 服务端
│   │   ├── main.ts                   # 渲染进程前端主入口
│   │   └── types.ts                  # 全局核心 TypeScript 类型定义
│   ├── package.json                  # 桌面端依赖管理与构建脚本配置
│   ├── tsconfig.json                 # TypeScript 编译配置
│   └── vite.config.ts                # Vite 前端构建与打包配置
├── docs/                             # 架构设计文档、开发规范与协议说明
├── packs/
│   └── builtin/                      # 内置机械标准件与电气元器件定义数据包
├── scripts/                          # 根目录代码生成与工程维护脚本
├── spike/                            # 实验性技术验证与原型探索代码
├── app.js                            # Web 端轻量原型主逻辑
├── electrical.js                     # Web 端电气原理图渲染与交互逻辑
├── electrical.css                    # Web 端电气原理图样式表
├── index.html                        # Web 端轻量原型入口页面
├── styles.css                        # Web 端全局样式表
├── CHANGELOG.md                      # 版本迭代与变更记录
└── README.md                         # 项目总体说明文档
```

## 4. 技术栈与核心依赖清单

基于 `desktop/package.json`，项目采用现代 TypeScript 全栈桌面端架构，结合工业级 CAD 内核与工业通信协议库：

| 类别 | 依赖包 / 工具 | 版本规范 | 核心用途说明 |
| :--- | :--- | :--- | :--- |
| **桌面端宿主与构建** | `electron` | `^45.0.0` | 跨进程桌面容器，提供原生文件、网络端口与硬件加速支持 |
| **桌面端打包** | `electron-builder` / `esbuild` | `^26.0.12` / `^0.25.11` | Windows 安装包构建与主进程高速编译打包 |
| **前端开发与构建** | `typescript` / `vite` | `^5.9.3` / `^7.1.10` | 强类型工程化开发与极速热更新构建 |
| **AI 与大模型协议** | `@modelcontextprotocol/sdk` | `^1.20.2` | 实现标准 MCP 服务端，向 LLM 暴露 CAD 建模、选型与审计工具 |
| **3D 渲染与 CAD 内核** | `three` / `occt-import-js` | `^0.186.0` / `0.0.23` | Three.js 实时场景渲染 + OpenCASCADE WebAssembly 精确几何解析 |
| **2D 工程图导出** | `dxf-writer` | `^1.18.4` | 自动生成符合 CAD 标准的二维 DXF 工程图纸与电气图 |
| **工业虚拟调试协议** | `node-opcua` / `modbus-serial` / `mqtt` | `2.186.15` / `^8.0.25` / `^5.14.1` | 对接 PLC、传感器与工业网关，驱动三维数字孪生实时运动 |
| **工程文档与压缩包** | `xlsx` / `adm-zip` | `^0.18.5` / `^0.5.16` | Excel 格式 BOM 物料清单生成导出，以及组件包/工程包 Zip 读写 |

## 5. 核心子系统深度解析

### 5.1 AI Agent 与 MCP 智能设计子系统 (`desktop/src/agent/` & `mcp-server.ts`)

该子系统将传统 CAD 的手动交互升级为“声明式意图 + Agent 闭环执行”模式：

- **MCP 协议服务 (`mcp-server.ts` & `agent/mcp.ts`)**：通过 `@modelcontextprotocol/sdk` 将整机设计操作封装为标准化 Tool 和 Resource，允许外部或内置大模型读取当前工程树、调用参数化建模接口、查询元器件库并触发合规检查。
- **任务规划与配方执行 (`planner.ts` & `recipes.ts`)**：将用户的高层需求（例如“设计一台三轴视觉点胶机，负载 5kg，节拍 3s”）拆解为有序的设计步骤（机构选型 → 空间布局 → 电气配电 → IO 分配 → 成本核算）。
- **行业知识库与选型顾问 (`kb/` & `advisor.ts`)**：内置常见非标机构（丝杠模组、同步带、旋转台、气动夹爪、伺服电机等）的选型经验公式与安全系数规范，提供实时参数推荐。
- **合规审计与自动修复 (`audit.ts`、`budget.ts` & `repair.ts`)**：
  - **机械干涉与行程审计**：检测机构运动包络面碰撞与安装孔位匹配。
  - **电气负载与线径审计**：校核开关电源功率裕量、断路器额定电流与端子排编号。
  - **成本预算监控 (`budget.ts`)**：实时汇总当前方案 BOM 成本，超出目标预算时触发降本替代方案建议。
  - **一键修复 (`repair.ts`)**：针对审计发现的违规项自动生成修正补丁并更新模型。

### 5.2 三维 CAD、参数化与机械运动学子系统 (`cad/`、`parametric/`、`mech/`、`machine/`)

- **双几何内核协同 (`cad/`)**：
  - 使用 `occt-import-js` 解析外部导入的工业标准 `STEP` / `IGES` 零件模型，提取精确拓扑面、边与包围盒。
  - 使用 `three` 管理场景图（Scene Graph）、材质光照、装配约束矩阵与交互拾取，并通过 `orbit/` 提供符合工程师习惯的三维视图旋转、平移与标准正交视图切换。
- **参数化建模与主进程加速 (`parametric/` & `electron/parametric.ts`)**：支持基于参数表达式驱动尺寸变更；复杂几何求交与模型生成可通过 IPC 卸载至 Electron 主进程执行，避免阻塞 UI 渲染帧率。
- **机械设计与电机选型 (`mech/` & `machine/`)**：内置运动学链（Kinematics Chain）定义、负载惯量比计算、丝杠导程/扭矩校核，以及整机机架（铝型材/焊接机架）与防护外罩的快速模板组装。

### 5.3 电气原理图与控制柜布局子系统 (`elec/` & `enclosure/`)

- **电气原理图自动生成 (`elec/`)**：
  - 当机械侧确定伺服电机、步进电机、电磁阀及光电传感器后，`elec` 模块自动推导所需的主回路（断路器、接触器、开关电源）与控制回路（PLC 模块、中继端子）。
  - 自动生成网络表（Netlist）、线号标注与端子排接线图。
- **三维/二维电柜布局 (`enclosure/`)**：
  - 根据元器件外形尺寸自动计算控制柜体积，规划 DIN 导轨、走线槽与散热风扇位置，验证门板开孔与柜内安全间距。

### 5.4 PLC 自动生成与数字孪生虚拟调试 (`plc/`、`plcgen/`、`commission/`)

- **IO 映射与代码生成 (`plc/` & `plcgen/`)**：
  - 自动汇总全机传感器输入（DI/AI）与执行器输出（DO/AO），生成标准化 IO 点表。
  - 根据工艺动作顺序（步进状态机）自动生成 IEC 61131-3 结构化文本（ST）或梯形图逻辑骨架，包含急停连锁、回原点（Homing）与报警诊断模板。
- **多协议虚拟调试 (`commission/`)**：
  - 通过 `modbus-serial`、`node-opcua` 或 `mqtt` 建立通信链路，将 PLC 输出寄存器实时绑定到 3D 场景中的气缸伸缩、丝杠位移与转盘角度，同时将虚拟限位开关状态回写给 PLC，在无物理样机阶段完成控制逻辑验证。

### 5.5 多格式工程交付与评估体系 (`export/`、`cost/`、`desktop/eval/`)

- **工程导出 (`export/`)**：
  - **2D 图纸**：通过 `dxf-writer` 导出机械视图、开孔图与电气原理图（`.dxf`）。
  - **3D 装配体**：导出标准三维交换格式（`.step`）及通过 `electron/machine-screenshots.ts` 生成多视角高清渲染图。
  - **BOM 与成本报表 (`cost/` + `xlsx`)**：按机械标准件、机加工件、电气元器件分类汇总型号、数量、单价与供应商信息，直接导出 `.xlsx` 表格。
- **自动化评测体系 (`desktop/eval/`)**：包含针对参数化建模、Agent 规划准确度及渲染性能的回归测试与基准评测脚本。

## 6. 核心业务数据流与闭环工作流

```text
[用户自然语言需求 / 机型模板选择]
          │
          ▼
┌───────────────────────────────────────────────────────────┐
│ 1. AI Agent 规划与知识库选型 (agent/planner, advisor, kb) │
└─────────────────────────┬─────────────────────────────────┘
                          │ 生成整机参数化配方 (Recipe)
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌─────────────────┐ ┌───────────┐ ┌──────────────────┐
│ 2A. 机械与3D建模│ │ 2B. 电气图│ │ 2C. 控制与IO分配 │
│ (cad/mech/pack) │ │  (elec/)  │ │  (plc/plcgen/)   │
└────────┬────────┘ └─────┬─────┘ └────────┬─────────┘
         │                │                │
         ▼                ▼                ▼
┌───────────────────────────────────────────────────────────┐
│ 3. 统一工程数据模型与电柜布局同步 (shared/, enclosure/)   │
└─────────────────────────┬─────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ 4. 自动合规审计、预算核算与修复 (audit, budget, repair)   │
└────────────┬──────────────────────────────┬───────────────┘
             │                              │
             ▼                              ▼
┌────────────────────────────┐ ┌────────────────────────────┐
│ 5A. 虚拟调试与数字孪生     │ │ 5B. 工程交付物一键导出     │
│ (commission/: OPC UA/      │ │ (export/: DXF / STEP /     │
│  Modbus/MQTT 实时驱动 3D)  │ │  Excel BOM / PLC ST 代码)  │
└────────────────────────────┘ └────────────────────────────┘
```

## 7. 快速开始与开发指南

### 7.1 环境要求

- **操作系统**：Windows 11（推荐，完整支持 Electron 桌面端特性）或 macOS / Linux 开发环境
- **Node.js**：建议使用 Node.js LTS（`>= 20.x`）
- **包管理器**：`npm`

### 7.2 安装与运行桌面端工程 (`desktop/`)

```bash
# 1. 克隆仓库
git clone https://github.com/owlco001/automation-cad-prototype.git
cd automation-cad-prototype/desktop

# 2. 安装项目依赖
npm install

# 3. 启动开发环境 (Vite 前端热更新 + Electron 桌面端)
npm run dev

# 4. 编译并打包 Windows 桌面端安装包
npm run build
```

### 7.3 运行根目录轻量 Web 原型

若仅需快速预览基础 Web 端交互与电气图原型（`index.html`、`app.js`、`electrical.js`），可直接在仓库根目录启动任意静态文件服务器：

```bash
# 在仓库根目录下运行
npx serve .
```

### 7.4 扩展开发建议

1. **新增机械/电气标准件**：在 `packs/builtin/` 或 `desktop/src/packs/` 下按既有 Schema 添加元器件三维几何参数、安装孔位定义、电气引脚及参考单价。
2. **扩展 AI Agent 工具能力**：在 `desktop/src/mcp-server.ts` 与 `desktop/src/agent/mcp.ts` 中注册新的 MCP Tool，并在 `desktop/src/agent/kb/` 中补充对应的行业校核规则。
3. **接入新工业协议或 PLC 品牌**：在 `desktop/src/commission/` 中实现对应的通信适配器接口，并在 `desktop/src/plcgen/` 中扩展目标品牌（如三菱、西门子、汇川、倍福）的代码生成模板。

## 8. 架构演进与工程优化建议

结合 [owlco001/automation-cad-prototype](https://github.com/owlco001/automation-cad-prototype/tree/main) 当前的目录组织、依赖配置与业务闭环设计，建议从以下六个维度推进工程化演进与性能优化：

### 8.1 仓库结构优化：从“双端并存”演进为 Monorepo 架构

- **现状分析**：仓库根目录保留了早期轻量 Web 原型（`index.html`、`app.js`、`electrical.js`、`packs/builtin/`），而 `desktop/` 下维护了完整的 TypeScript 桌面端实现（`desktop/src/elec/`、`desktop/src/packs/`）。双轨代码与元器件包并存容易引发数据 Schema 与业务逻辑不同步。
- **优化措施**：
  - 引入 `pnpm workspaces` 或 `npm workspaces`，将项目重构为标准 Monorepo 结构（例如 `packages/core-ir`、`packages/packs`、`packages/engines`、`apps/desktop`、`apps/web`）。
  - 将 `packs/builtin/` 标准件库与 `shared/`、`mech/`、`cost/`、`plcgen/` 等纯计算模块抽离为跨平台共享包，使 Web 端轻量预览与 Electron 桌面端完全复用同一套业务内核。

### 8.2 三维渲染与几何计算性能：Worker 线程化与 InstancedMesh 优化

- **现状分析**：`desktop/src/cad/` 同时依赖 `three` (`^0.186.0`) 与 `occt-import-js` (`0.0.23`)，部分参数化计算通过 `electron/parametric.ts` 走主进程 IPC。当整机包含大量标准件（铝型材、导轨、滑块、紧固件、传感器）时，主线程三角化或跨进程序列化大体积顶点数据容易造成界面卡顿。
- **优化措施**：
  - **几何解析异步化**：将 `occt-import-js` 的 STEP/IGES 解析与 B-Rep 布尔运算封装进独立 Web Worker，利用 `Transferable Objects`（零拷贝传递 `Float32Array` 顶点与法线缓冲区）直接构建 Three.js `BufferGeometry`。
  - **大装配体渲染加速**：针对机架型材连接件、端子排、导轨滑块等高频重复标准件，在 `cad/` 渲染层默认启用 `THREE.InstancedMesh` 与多级细节（LOD），大幅降低 Draw Call 数量。

### 8.3 虚拟调试 (`commission/`) 实时性：高频工业通信与 UI 状态解耦

- **现状分析**：`node-opcua` (`2.186.15`)、`modbus-serial` (`^8.0.25`) 与 `mqtt` (`^5.14.1`) 在虚拟调试时需高频读写寄存器。若每次点位变化均触发常规 IPC 消息与 UI 状态树更新，在 10ms~20ms 采样周期下易产生通信抖动和渲染掉帧。
- **优化措施**：
  - **独立通信进程与环形缓冲**：将工业协议客户端放入 Electron `UtilityProcess`，通过固定频率快照或 `SharedArrayBuffer` 向渲染层同步 IO 映像表（Process Image）。
  - **运动学帧间插值**：在 `commission/` 与 `mech/` 联动层引入基于时间戳的线性/样条插值（Lerp），将网络采样频率（如 20Hz~50Hz）与 Three.js 渲染帧率（60FPS/120FPS）解耦，消除三维机构运动卡顿感。

### 8.4 机电控统一数据底座：构建强类型整机中间表示（Machine IR）与事务日志

- **现状分析**：机械（`mech`）、电气（`elec`）、电柜（`enclosure`）与控制（`plc`）之间存在紧密级联关系，点对点同步逻辑随着机型扩展容易产生网状耦合，且难以实现跨领域的撤销/重做（Undo/Redo）。
- **优化措施**：
  - **基于有向图的统一 IR**：在 `desktop/src/shared/` 与 `types.ts` 中定义统一的整机有向属性图（机械装配树 + 电气网络表 + IO 映射表），并引入 `zod` 或 JSON Schema 对元器件包（`packs/`）及工程存档进行严格运行时校验。
  - **原子化变更事务（Command / CRDT）**：结合 `desktop/src/sync/` 模块，将所有对工程模型的修改封装为可逆 Operation Patch。例如“在机械模组上添加一个气缸”自动触发的“增加电磁阀 → 分配 DO/DI 点位 → 更新电柜端子 → 累加 BOM 成本”作为单一事务提交，支持一键回滚与多用户协同合并。

### 8.5 AI Agent (`agent/` & `mcp-server.ts`) 可靠性：拓扑约束原语替代绝对坐标

- **现状分析**：大语言模型在三维空间绝对坐标 $(x, y, z)$ 与欧拉角计算上容易产生空间幻觉，单纯依赖事后 `audit.ts` 审计和 `repair.ts` 修复会增加推理耗时与 Token 消耗。
- **优化措施**：
  - **暴露语义化装配原语**：在 `mcp.ts` 工具定义中，减少直接传入绝对坐标的接口，改为提供基于配合面与装配语义的 MCP 工具（如 `attachComponent(targetId, mountFace, alignRule, offset)`），由底层几何引擎求解精确变换矩阵。
  - **评测闭环接入 CI**：将 `desktop/eval/` 中的自动化评测脚本接入 `.github/workflows/`，针对常见标准机型 Recipe 定期量化跟踪“一次规划成功率”、“干涉审计通过率”与“BOM 预算偏差”。

### 8.6 工程交付 (`export/` & `plcgen/`) 工业生态兼容性升级

- **现状分析**：目前通过 `dxf-writer` (`^1.18.4`)、`xlsx` (`^0.18.5`) 和自定义 ST 模板导出交付物，距离下游主流工业软件（SolidWorks、EPLAN、TIA Portal、TwinCAT、Codesys）的无缝导入仍有提升空间。
- **优化措施**：
  - **支持 PLCopen XML 标准**：在 `desktop/src/plcgen/` 中增加符合 **IEC 61131-10 (PLCopen XML)** 标准的导出器，使生成的符号表、功能块（FB）与步进逻辑可直接导入博途（TIA Portal）、倍福（TwinCAT）及汇川（AutoShop/InoProShop）。
  - **升级表格导出依赖**：开源版 `xlsx` (`0.18.5`) 存在长期未更新的已知安全通告且不支持原生的单元格样式/图片嵌入，建议迁移至维护活跃的 `exceljs`，从而在导出 BOM 时直接内嵌 `machine-screenshots.ts` 生成的整机/部件缩略图与格式化报价单公式。


## 9. 主线最新提交（设计能力专项）深度复盘与根因诊断

针对主分支近期围绕“强化非标设计能力”密集提交的 20 个 Commit（从 `ba19d3f` 到最新的 `99bc0e8`），以下结合具体代码改动（Diff）与模块实现，复盘近期所做的工作，并深入剖析**为什么这批更新后“非标设计能力依然显得偏弱、达不到实战预期”**的深层原因及改进方案。

### 9.1 近期主线核心改动盘点

| 提交范围 | 涉及模块 | 实际完成的功能改动 |
| :--- | :--- | :--- |
| **`99bc0e8`** | `desktop/src/design/*`、`router.ts`、`projects.ts` | 新增约 1700 行代码的**整机设计五步向导**（需求解析 ➔ 3 套候选方案对比 ➔ 工位元件定义 ➔ 毫米级三维布局 ➔ 选型与干涉校核 ➔ 工程落盘） |
| **`86a3b48`、`f165459`、`327a706`、`8bc150b`** | `desktop/src/machine/model-builders.ts`、`conveyor-assembly.ts`、`agent/tools.ts` | 引入 `MODEL_BUILDERS` 注册表与通用 `build_machine_model` 工具；打通 Python `build123d` 参数化内核 `perPart` 导出（将皮带输送机拆分为 29 个独立 STL/STEP 实体），并手动修正滚筒、端板、横撑、张紧滑座之间的坐标碰撞 |
| **`6b28026`** | `desktop/src/assembly/ui.ts`、`snap.ts` | 新增标准件拖拽进入 3D 视口落位、基于规格文本解析代理包围盒、表面法向对齐与贴面吸附（Snap） |
| **`8b2a585`、`9cf2101`、`764ed27`** | `desktop/src/cad/viewer.ts`、`frustum.ts`、`dxf.ts`、`dwg.ts` | 修复 Gribb-Hartmann 视锥平面提取公式错误（解决 3D 实体被误剔除仅剩线框的问题）；支持导入 DXF/DWG 作为二维线段底图 |
| **`ff3435b`、`3a38769`、`41c87ad`** | `desktop/src/elec/{schema,erc,layout,render}.ts` | 将电气原理图从固定手绘 `EL-001` 重构为基于工程 BOM 的自动拓扑布局与电气规则检查（ERC）引擎 |

### 9.2 为什么最新提交后“非标设计能力”仍不令人满意？（四大核心症结）

#### 症结一：“伪参数化生成、真硬编码拼装”——高度依赖单一预制模板 (`conveyor-assembly.ts`)

- **代码现状**：虽然 `86a3b48` 抽象了 `MODEL_BUILDERS` 注册表并接入了 Python `build123d` 内核，但目前真正具备高精度实体建模能力的**只有皮带输送机（`conveyor-assembly.ts`）这一种写死的模板**。
- **暴露的问题**：查看 `8bc150b`（*“横撑躲开端板与回程皮带”*）与 `327a706`（*“滚筒让开端板、电机外挂留隙、横撑避开张紧滑座”*）的代码 Diff 可以发现，零件之间的空间关系完全靠程序员在 TypeScript 代码里**手写坐标加减偏移量（Hardcoded Offset）**来凑位置。
- **后果**：一旦用户的需求脱离“标准皮带线”（例如非标最常见的**凸轮分割器转盘多工位组装机、三轴龙门抓取贴合机、视觉飞拍上下料机构**），由于没有对应的硬编码 Builder，系统只能退化为摆放粗糙的占位长方体（Placeholder Box），缺乏真正的“非标机构组合生成”能力。

#### 症结二：缺失非标设计的灵魂——“非标机加工件 / 转接板自动生成”

- **代码现状**：五步向导（`99bc0e8` `desktop/src/design/*`）和装配吸附（`6b28026` `snap.ts`）都只解决了**外购标准件（气缸、导轨、电机、传感器）的罗列与摆放**。
- **暴露的问题**：在真实的非标机械设计中，标准件是不能直接悬空粘在一起的——把 Z 轴滑台装到 X 轴滑块上需要**十字转接板**，把伺服电机装到模组上需要**电机安装座**，把传感器固定到铝型材上需要**L 型/Z 型钣金支架**。
- **后果**：当前生成的 3D 模型之所以看起来像“外行拼积木”而非“工程级 CAD 装配体”，核心就在于**完全没有自动生成非标连接板/支架（Mounting Bracket / Adapter Plate）与孔位配打（Hole Pattern Matching）的逻辑**。

#### 症结三：装配约束与干涉检查停留在 AABB 包围盒层 (`snap.ts` & `mech/interference.ts`)

- **代码现状**：
  - `desktop/src/cad/MODULE.md` 明确指出前端 `Three.js` 仅负责网格渲染与拾取，没有任何 B-Rep/CSG 几何感知能力。
  - `desktop/src/mech/interference.ts` 仅实现了**轴对齐包围盒（AABB）**的重叠计算；`snap.ts` 也只是基于粗略包围盒做贴面。
- **暴露的问题**：在机械结构中，轴插入孔、轴承装入座、螺栓穿过法兰、皮带绕过滚筒，它们的 **AABB 包围盒 100% 会发生重叠**。用 AABB 做干涉检查，必然产生大量“假阳性碰撞报警”，迫使开发者在 `8bc150b` 中通过人为把零件拉开缝隙来消除报警；同时，对于旋转摆臂、倾斜机构或运动过程中的扫掠包络面（Swept Volume）干涉，AABB 完全无法准确检测。

#### 症结四：五步向导（`design/*`）与选型计算（`mech/stress.ts`）工程深度不足

- **代码现状**：`99bc0e8` 搭建了 5 步向导 UI 框架，但底层支撑第 4 步“选型与校核”的 `desktop/src/mech/stress.ts` 仅包含 3 个极简公式：`cylinderForce`（气缸推力）、`cantileverDeflection`（悬臂梁弯曲挠度）、`boltPreload`（螺栓预紧力）。
- **暴露的问题**：五步向导把交互拉长了，但每一步背后的工程计算密度极低：
  1. 缺少从**工艺节拍（Cycle Time / 时序图）**到**机构运动加减速曲线（梯形/S 型速度规划）**的推导；
  2. 缺少**伺服/步进电机转动惯量比匹配、RMS 有效扭矩与峰值扭矩校核**；
  3. 缺少**直线导轨倾覆力矩（$M_p, M_y, M_r$）与滚珠丝杠临界转速/压杆稳定性校核**。

### 9.3 针对“真正提升非标设计能力”的破局重构路线

要让项目从“皮带机演示原型”蜕变为真正好用的“非标自动化设计软件”，建议立即调整研发重心，按以下四步重构核心设计引擎：

| 改造方向 | 替代现有模块 | 核心技术实现方案 |
| :--- | :--- | :--- |
| **1. 引入“功能模组（Sub-Assembly）+ 拓扑接口（Port）”组合架构** | 替代 `model-builders.ts` 中按“整机”硬编码的路线 | 将粒度从“整机模板”下沉到**可复用的非标标准功能模组**（如：单轴丝杠模组、三轴龙门架、气动升降旋转夹爪、铝型材机架底座、分度转盘）。为每个构件定义带语义的**装配接口坐标系（`MountPort`：安装面法向、定位销孔距、螺纹孔阵列、负载挂载点）**，通过端口对齐矩阵自动推导装配坐标，彻底告别手写加减偏移量 |
| **2. 在 `build123d` 内核中实现“参数化转接板/支架自动生成器”** | 补齐 `parametric/` 与 `machine/` 缺失的连接件生成能力 | 当两个标准件的 `MountPort` 孔位不匹配或存在空间间距时，自动调用 Python `build123d` 生成**参数化非标机加工件**（一端匹配母件滑块孔距的沉头孔，另一端匹配子件气缸/电机的螺纹孔，自动倒角与减重槽），这才是打动非标机械工程师的核心刚需 |
| **3. 将干涉与配合检查下沉至 Python `build123d` (OCCT B-Rep) 内核** | 升级 `desktop/src/mech/interference.ts` 与 `assembly/snap.ts` | 弃用纯 AABB 判定，分为两级：**粗筛阶段**在前端用 OBB（有向包围盒）快速过滤；**精算阶段**调用 `build123d` / OpenCASCADE 执行精确实体布尔求交（`shapeA.intersect(shapeB).volume > tolerance`），并基于装配树过滤掉合法的“螺纹连接/轴孔配合面”假报警 |
| **4. 扩充 `mech/` 工业级传动选型与节拍运动学引擎** | 重构 `desktop/src/mech/stress.ts` 与 `design/` 第 4 步 | 在五步向导第 2~4 步中增加**工步时序甘特图（Cycle Time Chart）**输入，自动计算各轴行程与加减速时间，并在 `mech/` 中补齐：**丝杠导程/惯量/扭矩计算器、导轨力矩校核器、气缸耗气量与缓冲计算器**，输出带完整公式推导过程的选型计算书 |


## 10. 交互范式升级：从“五步线性向导”转向“画布式（Canvas）设计工作台”

针对 `99bc0e8` 刚引入的“整机设计五步向导”（`desktop/src/design/*`）在非标设计自由度上的局限，将核心设计界面升级为**“无限画布式（Canvas-based）多维联动工作台”**是极具价值的演进方向。

### 10.1 为什么“画布式界面”比“五步向导 + 纯 3D 拖拽”更契合非标设计？

1. **打破线性漏斗，契合非标方案的非线性迭代**：
   - 五步向导（需求 ➔ 方案 ➔ 元件 ➔ 布局 ➔ 校核）本质是表单向导，一旦在第 4 步发现空间放不下或节拍超标，退回第 2 步修改会打断设计上下文。
   - **画布式界面**允许工程师在同一个无限空间内同时展开**工艺流程图、多套候选方案画板（Artboards）、2D 平面尺寸布局与 3D 局部预览**，随时局部替换某个工位模组并即时看到 BOM 与干涉反馈。
2. **弥合 AI 大模型（擅长拓扑图）与 3D CAD（要求精确坐标）之间的鸿沟**：
   - 让 LLM 直接在 3D 空间猜 $(x, y, z)$ 坐标极易出错，而让人类工程师直接在 3D 透视视口中拖拽零件（`6b28026` `assembly/snap.ts`）又容易受到透视深度误导。
   - 在**画布模式**下，人与 AI 共同操作的是**“带装配接口（Port）的模组节点与约束连线”**以及**“带智能标尺吸附（Smart Guides）的 2D 工程网格”**，再由底层 `build123d` 参数化内核实时编译为精确的 3D 实体。

### 10.2 非标设计画布的三层语义缩放（Semantic Zoom）架构

可在同一个无限画布中支持三种视图模式（或分屏联动）：

| 画布模式 / 图层 | 核心视觉元素与交互方式 | 对接的底层模块 (`desktop/src/`) |
| :--- | :--- | :--- |
| **1. 工艺与装配拓扑画布**<br>*(Node-Graph 模式，类似 ReactFlow / Blender Geometry Nodes)* | - **节点（Node）**：代表基准件（铝型材机架、分度转盘、皮带线）或功能子模组（丝杠滑台、气动夹爪、视觉相机支架）<br>- **端口（Port）**：左侧为 `MountIn`（底座安装面/电源/气源输入），右侧为 `MountOut`（滑块挂载面/末端负载接口）<br>- **连线（Edge）**：拖拽连线即声明**机械父子挂载关系**（如 `X轴模组.滑块 ➔ 转接板 ➔ Z轴气缸.背板`）；若两端孔距不匹配，连线上自动浮现 `⚡ 生成转接板` 按钮 | 直接生成装配约束树交由 `parametric/` 与 `build123d` 求解 3D 坐标；同时由节点拓扑直接导出 `elec/` 原理图与 `plcgen/` 状态机 |
| **2. 2D 工程平面布局画布**<br>*(2D Ortho Layout 模式，类似 Figma + AutoCAD 俯视/主视图)* | - 提供毫米级自适应网格、中心轴对齐辅助线（Smart Guides）与直接尺寸标注驱动（改标注数字如 `450mm` 即移动工位间距）<br>- 显示各工位机构的**最大运动包络框（Motion Envelope）**与安全开门边界，直观排查工位间干涉 | 复用 `desktop/src/cad/dxf.ts` 底图能力，将 2D 平面坐标 $(X, Y)$ 与工位高度基准 $Z$ 实时同步给 `cad/viewer.ts` 的 3D 场景 |
| **3. AI 多方案画板对比模式**<br>*(Artboard Exploration 模式，类似 Figma 多画板)* | - AI Agent 将生成的 3 套整机方案作为 3 个独立画板（Artboard）并排铺在画布上<br>- 每个画板顶部实时挂载 **BOM 总价（`cost/`）、单工步瓶颈节拍（CT）、干涉报警数（`mech/`）** 指标胶囊<br>- 支持跨画板框选组合（如将“画板 A 的转盘底座”与“画板 B 的上下料机械手”拖拽合并为新画板） | 升级替代 `99bc0e8` 中 `desktop/src/design/` 的静态方案对比表，支持画板级快照直接存盘（`projects.ts`） |

### 10.3 界面整体布局重构建议（对标现代工业级 Canvas IDE）

建议将现有 `desktop/src/design/`（1,700 行五步向导）中的业务逻辑拆解并重组为以下五区画布工作台：

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 顶栏：工程文件 (projects.ts) | 视图模式切换：[拓扑图] [2D平面画布] [3D装配视口] [电气ERC] │
├──────────────┬───────────────────────────────────────────────────┬──────────────┤
│ 左侧资产面板 │                 中央无限设计画布                  │ 右侧检查器   │
│ (Packs/组件) │                                                   │ (Inspector)  │
│              │   ┌─────────────┐        ┌──────────────┐         │              │
│ ▸ 整机底座   │   │ 铝型材机架  ├──Mount─► X轴丝杠模组  │         │ [当前选中]   │
│ ▸ 直线模组   │   └─────────────┘        └──────┬───────┘         │ 行程: 400mm  │
│ ▸ 旋转/分割器│                                 │ (自动生成转接板)│ 导程: 10mm   │
│ ▸ 气动执行器 │                          ┌──────▼───────┐         │              │
│ ▸ 视觉/传感器│                          │ Z轴气缸+吸盘 │         │ [力学与选型] │
│ ▸ 非标转接件 │                          └──────────────┘         │ 惯量比: 3.2✓ │
│              │   ┌─────────────────────────┐                     │ 挠度: 0.02mm │
│ [AI 对话框]  │   │ 3D 实时联动小窗 (PiP)   │                     │              │
│ "把Z轴行程改 │   │ (Three.js + build123d)  │                     │ [实时 BOM]   │
│  为200并加光 │   └─────────────────────────┘                     │ ¥ 14,850     │
│  电限位..."  │                                                   │ 0 处真干涉 ✓ │
├──────────────┴───────────────────────────────────────────────────┴──────────────┤
│ 底部抽屉：工步节拍甘特图 (Cycle Time Timeline) —— 拖动动作条实时校核电机加减速与气缸节拍 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 10.4 基于现有代码的渐进式落地路径

1. **第一阶段（抽离通用 2D 画布底座）**：复用 `ff3435b` 在 `desktop/src/elec/{layout,render}.ts` 中已经实现的二维画布平移/缩放、节点布局与连线渲染逻辑，将其沉淀为通用的 `desktop/src/canvas/` 组件，用于绘制机械装配拓扑图（Station & Mount Graph）。
2. **第二阶段（五步向导“去模态化”改造）**：保留 `99bc0e8` (`desktop/src/design/*`) 中的需求解析、候选方案生成、BOM 定价（`pricing.ts`）和 `build_machine_model` 调用链，但取消强制性的“上一步/下一步”步骤锁，改为在画布上直接生成节点图，右侧常驻选型校核与 BOM 面板。
3. **第三阶段（画布与 3D 视口双工同步）**：将 `cad/viewer.ts` 作为画布的联动视口（支持画中画 PiP 或左右分屏）。在画布上选中或连接某个模组节点时，3D 视口自动高亮对应 STL/STEP 部件并聚焦相机（Orbit Focus）；在 3D 视口中贴面吸附（`snap.ts`）时，画布自动新增一条装配约束边。
