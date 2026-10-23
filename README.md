# AutomationCAD · 非标自动化整机设计软件（Windows 11 桌面版）

面向非标自动化整机的**机械 + 电气协同设计工作台**：机械域覆盖机构选型 → 标准件调用 → 装配 → 干涉校核 → 受力校核 → 出图 → BOM；电气域覆盖原理图 → IO 规划 → 柜体底板布置 → 合规校验 → 成本统计；桌面版在此基础上叠加 **CAD 轻量化查看与运动学标注、电气元件库、PLC 程序生成、PLC 通电联调、参数化建模、智慧工厂数据同步、智能体（JSON-RPC / MCP / 应用内对话）**，单机离线可用。

- 当前版本：**v0.3.0**（源码与文档就绪；本次未发布安装包，构建需老王通知后手动触发）
- 运行环境：Windows 11 x64；Electron 45 + TypeScript + Vite
- 技术底座：渲染层直接复用仓库根目录的网页原型，桌面能力全部通过**注入扩展**叠加，原型文件（`index.html` / `app.js` / `styles.css` / `electrical.*`）**零改动**
- 质量基线：**687 个单元测试全绿**，另有覆盖 CAD / 运动学 / 机核 / 导出 / PLC / PLC 代码生成（含 UI 与 zip 导出）/ 联调 / 同步 / 电气库 / 电气校验 / 底板布置 / 参数化装配与 BOM / 成本（引擎 + 面板 + 报告 + Agent）/ 智能体 / 工厂的 headless smoke

![AutomationCAD 主界面](docs/desktop/screenshots/01-home.png)

*主界面：左侧仍是原型的结构树 / 选型 / 标准件库 / 受力视图，顶栏右侧新增桌面入口——CAD 查看（STEP）、工厂、联调、数据包、电气元件、电气校验、底板布置、PLC 程序、成本、智慧工厂、智能体。桌面能力挂在原型之上，不改动原有布局与交互。*

## 界面一览

以下截图均来自 Electron 实跑（`capturePage` / CDP），不是设计稿。

| 截图 | 说明 |
|------|------|
| `01-home.png` | 主界面 |
| `02-cad-assembly.png` | CAD 查看 · STEP 装配体 |
| `03-interference.png` | 干涉检测 |
| `04-stress.png` | 受力分析 |
| `05-factory.png` | 智慧工厂 · demo 产线实时值 |
| `06-commission.png` | 通电联调 · 6 步全通过 |
| `07-packs.png` | 数据包管理 |
| `08-elec-library.png` | 电气元件库 |
| `09-agent.png` | 智能体面板 |
| `10-sync-settings.png` | 智慧工厂同步设置 |
| `11-plcgen.png` | PLC 程序生成 · 预检 + 11 文件树 |
| `12-parametric.png` | 参数化特征树 · 4 特征 + 参数表单 |
| `13-cost.png` | 成本估算 · 9 卡 + 6 行明细 |
| `14-enclosure.png` | 底板布置 · 3 元件 + 1 处重叠 |

复现：`cd desktop && npm run screenshots`（xvfb + 真实 Electron，`capturePage` 抓 1600×1000；参数化面板由 `scripts/fake-parametric-sidecar.mjs` 驱动）。headless 下 Chromium 将 WebGL 列入 blocklist 时，CAD 3D 区域会显示解析统计降级面板；本轮四张图的目标面板均为真实 DOM / SVG / 画布渲染。

### CAD 查看：真实 STEP 装配体 + 运动学标注

![CAD 查看：STEP 装配体 18 个零件](docs/desktop/screenshots/02-cad-assembly.png)

*CAD 查看：载入真实 STEP 装配体（18 个零件、5,040 个三角面），左侧零件列表可点选定位，中间 three.js 视口支持旋转 / 缩放 / 平移，底部给出解析统计。*

### 参数化建模：特征树 + 参数表单 + 重建统计

![参数化抽屉：4 个特征、孔位参数与重建统计](docs/desktop/screenshots/12-parametric.png)

*参数化抽屉：装配实体「安装底板」下是 4 个特征（底板 / 安装孔 / 腰形槽 / 四角圆角），选中「安装孔」后参数表单给出孔径、深度与 4 个孔位坐标，底部固定显示 `就绪 · 重建 12 ms · 面 19 · 体积 71.5 cm³`。这张图证明特征树、参数表单、重建统计与 sidecar 状态在真实 Electron 中同屏可用；当前无 WebGL 的 headless 环境只在中间 3D 区显示降级统计，不影响抽屉本身。*

实跑时顶栏「参数化」按钮会在右侧打开与「运动学」二选一的抽屉：装配实体区可增删实体并编辑名称 / partId / X/Y/Z/RZ，特征树支持上移/下移/抑制/改名/删除，参数表单按特征类型渲染；底部提供重建、导出 STEP/STL、导出 BOM、送成本、保存/载入特征树。参数改动默认 300 ms 防抖自动重建，成功后把 sidecar 返回的 STL 载入 three.js，并可半透明叠加旧模型对比。

STEP/IGES/BREP 本身不含运动学信息，因此右侧新增**运动学标注**抽屉：网格多选合并为一个动件 → 指定轴类型（直线 / 旋转）、方向、行程、缩回位、绑定 IO 点位 → 中文实时校验（动件不在 STEP、行程非正、缩回超行程、直轴填角度、点位不存在、同点位冲突）→ 行程滑块直接拖动 3D 中的动件预览。标注按文件名存 `localStorage`，可导出 / 导入 JSON；无标注时 3D 联调回退到机型配置驱动，并在面板顶部说明原因。

### 干涉检测：28 处命中按严重度分组

![干涉检测：28 处命中、按严重度分组](docs/desktop/screenshots/03-interference.png)

*干涉检测：AABB 初筛一次跑出 28 处候选，按严重度分组并给出重叠尺寸与体积；点击结果可在 3D 视口定位到两个零件，「忽略」会把该零件对写入白名单。*

### 受力分析：公式与安全系数可见

![受力分析：气缸推力与安全系数](docs/desktop/screenshots/04-stress.png)

*受力分析：气缸推力按 `F = p·πD²/4·η` 计算，同时给出拉力（0.85 系数）、余量与安全系数；悬臂梁挠度 `δ ≤ L/500`、螺栓预紧 `F0 = 0.7σy·As` 同页，超限项直接标红并给出改法建议。*

### 智慧工厂：demo 产线实时值

![智慧工厂：demo 适配器连接后 2 工位 8 点位实时刷新](docs/desktop/screenshots/05-factory.png)

*智慧工厂：内置 demo 适配器连接后自动列出 2 个工位 × 4 个点位（运行 / 节拍 / 良品数 / 报警），每秒刷新；可写点位会弹出确认，OPC UA 与 MQTT 共用同一适配器接口。*

### 通电联调：上电序列 + 3D 联动 + 故障诊断

![通电联调：6 步上电全部通过](docs/desktop/screenshots/06-commission.png)

*通电联调：内置 PLC 仿真器连接成功，点位表就绪，6 步上电（主回路 → 24V → PLC RUN → 气源 → 回原点 → 就绪）全部通过并记录每步耗时，结果可导出 A3 PDF 联调章节。*

3D 联动已改为**机型配置驱动**：`MachineConfig` 描述工位、执行机构（气缸 / 夹爪 / 旋转轴）、行程与传感器点位，demo 配置为 4 工位 / 12 执行机构 / 16 传感器，换机型只换配置不改源码。诊断侧 7 条规则 + 兜底，按置信度给出原因与处置建议。

### 数据包：内置包、导入与启停

![数据包：内置包列表与检索](docs/desktop/screenshots/07-packs.png)

*数据包：内置包只读展示，支持 ZIP 导入、启停与型号 / 厂商 / 类别检索；启停即时影响标准件搜索结果，「插入」写入渲染层覆盖层而不修改原型代码。*

### 电气元件库：371 型号 / 26 分类 / 191 个真实尺寸

![电气元件库：按需加载与放入图纸](docs/desktop/screenshots/08-elec-library.png)

*电气元件库：iec-cn 数据包按需加载，26 个分类共 371 个型号，其中 219 个带原理图符号、191 个录入了可核实的真实外形尺寸（`dims{w,h,d}`）与导轨 / 模数信息；卡片标注符号位号，点「放入图纸」即插入原理图，点「放入底板」即进入布置画布。*

### 底板布置画布：真实毫米与重叠标红

![底板布置：3 个元件、1 处重叠标红](docs/desktop/screenshots/14-enclosure.png)

*底板布置：600×800 mm 画布、两条 35 mm DIN 导轨，放入 3 个带真实尺寸的元件；其中两个 1P 断路器故意错开 6 mm 叠放，重叠的一对同时显示红色描边与 `!` 角标，底部状态栏给出「已放置 3 · 利用率 1.5% · 冲突 1 处」。这张图证明画布用真实 `dims` 绘制并实时计算碰撞，不是静态示意。*

### PLC 程序生成：预检 + 文件树

![PLC 生成：预检通过、11 个文件树与 README 预览](docs/desktop/screenshots/11-plcgen.png)

*PLC 程序生成：电气域打开全屏面板，4 工位 / 12 执行机构 / 34 点位的机型预检为 0 错误 0 警告，生成 11 个文件；中间文件树列出路径、行数与字节数，右侧预览 `README.md`，底部统计「11 个文件 · 变量 34 · 步序 2 · 生成 22 ms」。这张图证明预检、生成、文件树/预览与生成历史在真实 Electron 中走通。*

### 硬件成本统计：9 张统计卡 + 明细表

![成本估算：9 张统计卡、6 行明细与缺价告警](docs/desktop/screenshots/13-cost.png)

*成本估算：载入内置/样例价格簿与 7 行 BOM 后算出 6 行可计价明细，顶部 9 张卡展示硬件、辅材、人工、小计、加成、税金、运费、合计与缺价；表格逐行给出物料号、数量、单价、小计与价格来源，缺价 1 项单列。这张图证明成本引擎、面板渲染与缺价口径在真实 Electron 中一致（合计 ¥1,398.64）。*

### 智能体：对话 / 工具 / 模型设置

![智能体面板：对话、工具、模型设置](docs/desktop/screenshots/09-agent.png)

*智能体面板：自上而下是对话与工具调用区、模型设置（OpenAI 兼容 baseUrl / model / apiKey，密钥只回显掩码）、本机服务信息（127.0.0.1:7420、12 个工具、token 文件路径）。写操作执行前会弹出二次确认。*

### 智慧工厂同步设置

![智慧工厂同步：baseUrl / 机台编号 / 项目 / API Key 掩码](docs/desktop/screenshots/10-sync-settings.png)

*智慧工厂同步设置：baseUrl、机台编号（device_no）、项目、API Key（保存后只回显掩码，配置文件权限 600）与启用开关；「测试连接 / 立即同步」均手动触发，没有后台自动同步。*

## 功能矩阵

### 机械域（原型 5 视图 + 桌面校核）

| 能力 | 内容 | 状态 |
|------|------|------|
| 装配工作台 | 结构树 ↔ 3D 联动、属性即时编辑、框选、DOF 角标 | ✅ 原型 |
| 选型计算 | 8 项工况参数重算、缸径系列对比、推荐型号回写装配 | ✅ 原型 |
| 标准件库 | 品牌 / 品类筛选、7 列排序、规格预览 | ✅ 原型 |
| 干涉校核 | AABB 初筛：重叠量 / 体积 / 定位 / 严重度分级 / 忽略白名单 | ✅ 桌面 |
| 受力校核 | 气缸推力、悬臂梁挠度、螺栓预紧，带公式与安全系数 | ✅ 桌面 |
| 出图与 BOM | A3 PDF 报告、DXF、GLB、OBJ、BOM（CSV / XLSX） | ✅ 桌面 |

### 电气域（原型 3 视图 + 桌面增强）

| 能力 | 内容 | 状态 |
|------|------|------|
| 电气原理图 | A3 横向白纸、图框与标题栏、主回路 / 控制回路、符号拖放与交叉引用 | ✅ 原型 |
| IO 规划 | 点位表、建议 / 未分配 / 冲突编码、机械派生链追溯 | ✅ 原型 |
| 柜体布置（原型） | 柜门与侧视图、导轨吸附、温升 / 载流 / 空间余量重算 | ✅ 原型 |
| 电气元件库 | iec-cn 数据包：371 型号 / 26 分类 / 219 符号 / 191 真实尺寸，插件式加载 | ✅ 桌面 |
| **底板布置画布** | 毫米坐标 SVG、底板尺寸可设、1mm 吸附、两条 35mm 导轨、重叠标红、利用率统计、JSON 导出与刷新恢复 | ✅ 桌面 |
| **电气合规校验** | 线号（缺号 / 格式 / 同网重复 / 跨网重号 / 相线电位不符 / 跳号）、功率统计（kW / kVA / 分相电流 / 不平衡度 / 主断路器与进线截面建议 / 24V 余量）、导线截面 vs 载流量；A3 PDF 报告 | ✅ 桌面 |
| **参数化建模（P9-5）** | build123d sidecar + 右侧「参数化」抽屉：多实体装配（独立特征树 + X/Y/Z/RZ + partId，旧单件文档自动包装）、特征树增删/排序/抑制/改名、按类型参数表单（box/holes/slot/fillet/cylinder）、300 ms 防抖自动重建、旧模型半透明对比、特征包围盒高亮、STEP/STL 导出；BOM 按相同 partId / 未映射名称合并，导出 UTF-8 BOM CSV 并一键送成本（未映射走 `NO_PART_ID`，不猜物料号） | ✅ 生命周期 + IPC + 装配/BOM 联动 |
| **硬件成本统计** | 价格簿（阶梯价 / 来源 / 更新日期 / 示例价自动排除）+ 纯函数引擎：BOM × 阶梯价 + 底板推算线缆 / 端子 / 导轨 / 线槽 + 人工 + 税 / 加成 / 运费；缺价单列「待询价」；成本面板（9 张统计卡 + 明细表 + 缺价告警）导出 A4 PDF 与 UTF-8 BOM 的 CSV；Agent 工具 `run_cost_report` 只读返回同一份报告摘要，`export_cost_report` 按一句话把 PDF/CSV 落到 `userData/exports/` | ✅ 引擎 + 面板 + 导出 + Agent 问答/落盘 |
| **PLC 程序自动生成** | 由机型配置与 IO 点位生成 IEC 61131-3 ST：全量预检（地址冲突 / 类型不符 / 互锁缺失）+ IO 变量表 + 五个基础块 + 自动序列 / 报警 / 安全 FC + `mapping.json`，固定 11 文件与逐文件 SHA-256；生成 UI、zip 导出、最近 10 次历史；内置模拟器执行生成序列（超时 / SafeStop / 传感器矛盾）。边界：通用 ST，不生成厂商专有工程文件；TIA Openness 仍为规划项 | ✅ P8-1～P8-4 |

### CAD 与数据

| 能力 | 内容 | 状态 |
|------|------|------|
| CAD 查看 | occt-import-js（STEP / IGES / BREP）+ three.js（STL / OBJ / GLTF / GLB） | ✅ |
| 大装配实测 | 424 KB 装配体 → 5,040 三角面，解析 559 ms | ✅ |
| 运动学标注 | 任意装配体：动件 → 轴 / 行程 / 方向 / 缩回位 / 点位；校验 + 姿态解算 + 滑块预览 | ✅ |
| 无 WebGL 降级 | 渲染不可用时退化为解析统计面板，不白屏；标注仍可编辑 | ✅ |
| 数据包 | 内置包 + 用户 ZIP 导入、manifest 校验、路径穿越防护、启停、检索 | ✅ |

### PLC / 联调 / 工厂

| 能力 | 内容 | 状态 |
|------|------|------|
| PLC 适配器 | 仿真器（表达式 / 自锁 / 定时器）+ Modbus TCP（FC01–06） | ✅ |
| 点位模型 | 读写在主进程统一超时 | ✅ |
| 通电联调 | 上电序列 + 用例，逐步 / 一键执行，导出 PDF 章节 | ✅ 仿真验证 |
| 3D 联动 | 机型配置驱动（4 工位 / 12 执行机构 / 16 传感器）+ 运动学标注优先 | ✅ |
| 故障诊断 | 7 条规则 + 兜底，按置信度排序给出原因与处置 | ✅ |
| PLC 程序生成 | P8-1～P8-4：全量预检 + IO 变量表 CSV + 五个基础块 + 自动序列/报警/安全 FC + `mapping.json`，固定 11 文件与逐文件 SHA-256；电气域「PLC 程序」面板（问题定位、文件树、200 行预览）、目标平台/命名前缀、导出 zip（含 CRC）与最近 10 次生成历史；内置模拟器按 `mapping.json` 执行联调序列（行程时间 / `timeScale` / `TimeoutTime` / SafeStop / 传感器矛盾），面板「模拟验证」与 Agent 只读工具 `verify_plc_program` 共用 `verifyGenerated` | ✅ 桌面（生成 + 模拟验证） |
| 智慧工厂 | demo（2 工位 / 8 点位）、OPC UA、MQTT 三适配器 + 实时值面板 | ✅ demo 实测 |
| 设计包同步 | manifest / SHA-256 幂等、`X-Design-Key`、版本 diff、手动上传、失败阶段可区分 | ✅ 本地端到端（后端 0.22.0） |

### 智能体

| 能力 | 内容 | 状态 |
|------|------|------|
| 工具集 | `list_components` / `search_components` / `import_cad` / `get_bom` / `run_interference_check` / `insert_component` / `place_component` / `run_electrical_check` / `run_cost_report` / `verify_plc_program` / `export_cost_report` / `undo_last`（12 个：只读 7 + 写 5；写操作走二次确认） | ✅ |
| JSON-RPC | `127.0.0.1:7420`，Bearer token（userData 下 `agent-token`），仅监听本机 | ✅ |
| MCP stdio | 复用同一工具注册表；写工具经桌面 RPC 代理，桌面未启动时明确返回 `DESKTOP_NOT_RUNNING` | ✅ |
| 应用内对话 | OpenAI 兼容接口、工具调用循环、写操作二次确认、密钥仅本机进程 | ✅ |
| 离线规则路由 | 无模型/断网时按关键词规则判 7 类意图并只执行只读工具（写操作明确拒绝），`ctx` 上限 2 KB | ✅ |
| 上下文裁剪 | 工程上下文分级降级（删工具描述 → 删工具 → 删最近操作 → 硬截断），默认 ≤2048 字节 | ✅ |
| 审计 | 每次工具调用一行 NDJSON 写 `<userData>/agent-audit.jsonl`，`sk-`/`Bearer`/`token` 等凭据脱敏；`agent:audit:read` 只读接口 | ✅ |
| 计划预览 | 侧栏输入时实时显示「只读 · 可离线」或「写操作 · 需联网确认」，写操作缺参数直接点名（如 `partId`）；预览只展示、不执行 | ✅ |
| 多步规划 | `planner.ts` 离线规则：查件→放置→校验、BOM→成本→导出、导入→干涉、PLC 生成→模拟验证、设计包→上传；未知工具过滤 + warning，规则不命中/置信度 < 0.6 明确拒绝并给建议 | ✅ P7-C |
| 多步执行 | 侧栏计划卡片（序号/工具/参数/原因）+「全部执行/逐步执行/取消」；只读直接跑，写步骤一次确认，任一步失败立即停止，逐项打勾/标红，写操作可提示 `undo_last` | ✅ P7-C |
| 统一回执 | 在线模型与离线规则共用一张回执：通道 / 耗时 / 工具次数 / 失败数，离线额外注明只跑只读工具 | ✅ |
| 审计面板 | 侧栏「审计」区展示最近 8 条（工具 · 成功/失败 · 来源 · 错误码）与汇总，可手动刷新 | ✅ |
| 离线评估 | `desktop/eval/agent-cases.json` 46 条中文用例（16 指代 / 7 歧义 / 5 多步 / 5 超纲）；在 `desktop/` 下运行 `npm run eval:agent`，只跑离线规则、不调模型，结果写 `docs/desktop/eval/latest.json` | ✅ 100% 意图 / 100% 工具 / 100% 超纲拒绝（[NL-AGENT.md](docs/desktop/NL-AGENT.md)） |
| 底板放置 | `place_component`：坐标 / 旋转 / 导轨吸附；越界与重叠以 `warnings` 返回；成功后进入撤销栈，`undo_last` 返回 `removed` id | ✅ P7-B |
| 自然语言完整方案 | 12 个已实现工具 + 5 个规划工具、上下文注入、意图路由、离线多步规划、审计、46 条中文评估集 | ✅ P7-A / P7-B / P7-C 已落地（[NL-AGENT.md](docs/desktop/NL-AGENT.md)） |

## 快速开始

### 方式一：网页原型（零依赖，双击即开）

仓库根的 `index.html` 就是完整原型，不需要 Node、不需要构建：

```bash
# Windows
start index.html
# macOS
open index.html
# Linux
xdg-open index.html
```

如遇浏览器对 `file://` 的限制，可起一个静态服务器：`python3 -m http.server 8099`，访问 `http://localhost:8099`。建议 1920×1080 视口。

### 方式二：桌面版（Windows 11）

**安装包**：从 [Releases · v0.2.0](https://github.com/owlco001/automation-cad-prototype/releases/tag/v0.2.0) 下载 `AutomationCAD-Setup-0.2.0.exe`，双击安装。未做代码签名，SmartScreen 会拦一次，选「更多信息 → 仍要运行」。

> v0.3.0 本次只做版本与文档准备，未构建安装包；需要安装包时由老王通知后手动触发 `windows-build`。

**从源码运行**（需 Node 22+）：

```powershell
git clone https://github.com/owlco001/automation-cad-prototype.git
cd automation-cad-prototype\desktop
npm ci
npm run build:ext   # 首次必需：dist/ 与 dist-electron/ 不入库
npm start
```

构建过一次之后，日常只需 `cd desktop` + `npm start`。Linux 开发机可用 `npm run smoke`（xvfb + `--headless-smoke`）验证主流程。

本地验证设计同步全链路（需 `/root/mf-main/material-flow-backend` 的 `.venv`）：`cd desktop && npm run sync:e2e`。脚本会起临时后端，跑通打包 → 上传 → 幂等 → 列表 → diff → 下载 → 断连错误，日志写 `docs/desktop/eval/sync-e2e.json`。

### 方式三：把桌面能力接给外部 Agent

桌面启动后即开放 JSON-RPC；MCP（stdio）入口在 `desktop/dist-electron/mcp.cjs`。Claude Code / Codex 的配置样例、token 位置、curl 示例见 [desktop/README.md](desktop/README.md)。

## 目录结构

```
.
├── index.html / app.js / styles.css          # 网页原型：外壳、交互与计算、设计 token
├── electrical.js / electrical.css            # 电气域三视图（原型扩展）
├── desktop/                                  # Electron 桌面版
│   ├── electron/                             # 主进程、preload、IPC 路由
│   ├── src/
│   │   ├── extension.ts                      # 渲染层注入入口（原型零改动）
│   │   ├── cad/                              # STEP 解析、three.js 查看器、运动学标注与 UI
│   │   ├── parametric/                       # 特征树模型/编辑、参数表单、重建与导出 UI
│   │   ├── mech/                             # 干涉初筛 + 气缸/悬臂梁/螺栓校核
│   │   ├── elec/                             # 线号合规、功率统计、校验面板与 PDF
│   │   ├── enclosure/                        # 底板布置几何层 + SVG 画布
│   │   ├── cost/                             # 价格簿校验 + 硬件成本引擎 + 成本面板/报告 + Agent 工具
│   │   ├── export/                           # PDF / DXF / GLB / OBJ / BOM
│   │   ├── packs/                            # 数据包注册表、面板、电气元件库
│   │   ├── plc/                              # 仿真器 + Modbus TCP
│   │   ├── commission/                       # 机型配置、3D 联动、诊断、联调报告
│   │   ├── factory/                          # demo / OPC UA / MQTT 适配器与面板
│   │   ├── sync/                             # 智慧工厂设计包同步客户端
│   │   ├── agent/                            # JSON-RPC、MCP、应用内对话
│   │   ├── ui/                               # 注入方式与面板壳
│   │   └── shared/                           # 共享类型
│   ├── test/                                 # node:test 单测与集成测试（687 个）
│   ├── build/                                # 应用图标
│   ├── scripts/                              # esbuild 打包 main / preload / MCP
│   └── release/                              # 本地产物（不入库）
├── packs/builtin/                            # smc-cn（8 型号）、iec-cn（371 型号）、pricebook-cn（价格簿）
├── docs/
│   ├── desktop/                              # 需求、架构、看板、二期方案、工厂对接
│   ├── desktop/screenshots/                  # 桌面版真实截图（14 张）
│   ├── report/                               # 领导汇报材料（HTML/PDF）
│   ├── reference/                            # 电气元件参考表
│   └── screenshots/                          # 网页原型截图
├── tasks/                                    # 开发任务拆解
└── .github/workflows/windows.yml             # windows-latest 构建 NSIS（手动触发）
```

## 架构要点

- **加而不改**：渲染层就是原型页面，`desktop/src/extension.ts` 在其上挂载 CAD 视图与各面板。原型仍可单独双击运行，桌面版升级不会分叉出第二套 UI。
- **进程边界**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染层只有 `window.desktop.*`，没有 fs / net 权限。文件、数据包、协议连接、Agent server 全在主进程。
- **重活不堵 UI**：occt WASM 解析在 Web Worker 中执行；three.js 渲染在渲染层。
- **计算与界面分离**：几何（`enclosure/layout.ts`）、成本（`cost/engine.ts`）、电气规则（`elec/`）、运动学（`cad/kinematics.ts`）、参数化编辑/防抖/分桶（`parametric/model.ts`）都是纯函数，可单测、可被 Agent 复用。
- **同一份工具注册表**：UI 按钮、JSON-RPC、MCP 共用 `src/agent/tools.ts`，能力不会三处漂移。
- **失败要说清楚**：WebGL 不可用退化为统计面板；桌面未启动时 MCP 返回 `DESKTOP_NOT_RUNNING`；工厂 / PLC 连接失败返回中文 `{ ok:false, code, message }`，不抛未捕获异常。

## 测试与构建

```bash
cd desktop
npm test          # 687 个单测（node:test）
npm run smoke     # xvfb + Electron headless，强制走无 WebGL 路径
npm run sync:e2e  # 本地起 material-flow 后端，跑设计同步端到端（不进单测）
npm run build:ext # tsc --noEmit + Vite 扩展 + esbuild main/preload/MCP
```

smoke 覆盖并断言：

- CAD 解析统计（`cube.stp` → 1 零件 / 12 三角面）与无 WebGL 降级面板；
- 运动学标注（`SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25`）；
- 干涉、受力、导出的计算与文件写出；
- PLC 点位、上电序列、用例；
- PLC 代码生成（`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`）：五个基础块、11 文件汇总、自动序列/安全/报警 FC 与确定性校验；内置模拟器按 mapping 跑 6 步联调（0 报警）；UI 从电气域入口打开、预检、生成、模拟验证、历史与 zip 落盘全链路；
- 参数化 sidecar、特征树 UI 与多实体 BOM（假内核，`AUTOMATIONCAD_PARAMETRIC_CMD` 指向 `desktop/scripts/fake-parametric-sidecar.mjs`）：`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`、`SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`；不设环境变量时输出 `SMOKE_PARAMETRIC_UI_SKIP`；
- 3D 联动机型规模（`SMOKE_COMMISSION_3D_SCALE_OK stations=4 actuators=12 sensors=16 parts=16`）与故障诊断；
- 智慧工厂 demo 连接与设计包同步（manifest / ZIP / 幂等）；
- 电气元件库、底板布置（`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`）、电气校验（`SMOKE_ELEC_CHECK_OK findings=4 errors=3`）、成本引擎（`SMOKE_COST_OK lines=6 missing=1 grand=1398.64`）、成本 Agent 工具（`SMOKE_COST_AGENT_OK bomSource=argument lines=6 missing=1 grand=1398.64`，与引擎合计一致）、成本 Agent 导出（`SMOKE_COST_AGENT_EXPORT_OK format=csv bytes>0 name=sanitized`，假桥接直接调命令、不弹窗）与成本面板（`SMOKE_COST_UI_OK rows=6 cards=9 grand=1398.64 book=6 pdf=1`：打开面板 → 载入价格簿 → 计算 → 渲染 9 卡 6 行 → 导出 A4 PDF）；
- 智能体工具注册、渲染桥读写、对话面板字段；只读问答 UI（`SMOKE_AGENT_READONLY_UI_OK preview=2 offline=1 rows=2`：只读指令标可离线、写指令标需联网并点名缺 `partId`、预览不改变场景、审计面板读到 2 条）；离线规则路由（`SMOKE_AGENT_NL_OK intents=7 tools=12 audit=3 ctx=447`：7 类意图全覆盖、写计划不进入离线通道、上下文 ≤2 KB、审计 3 条且密钥不落原文）；底板放置与撤销（`SMOKE_AGENT_PLACE_OK placed=1 undo=1`：真实 `__Enclosure` 放置 1 件、吸附导轨、撤销后归零）。

输出形如 `SMOKE_UI_OK`、`SMOKE_PLC_OK`、`SMOKE_AGENT_TOOLS_OK`，最后 `SMOKE_OK`。

**CI**：`.github/workflows/windows.yml` 在 `windows-latest` 上跑 `npm ci → build:ext → test → electron-builder --win nsis --x64`，产物为 `AutomationCAD-Setup-*.exe` + blockmap。当前**仅手动触发**：`gh workflow run windows-build --ref main`；推 `v*` tag 时额外发布到 GitHub Release。本地只想出免安装包可用 `npx electron-builder --win zip --x64`。

## 已知限制

- **安装包未签名**：无代码签名证书，Win11 SmartScreen 首次会提示。
- **OPC UA 只支持 SecurityPolicy=None**，未接真实 PLC；MQTT 未连真实 broker；Modbus 未连真机（仿真器已实测）。
- **价格簿尚无真实报价**：内置价格簿只含明确标注「示例，需替换」的条目，引擎会自动排除示例价；真实成本需导入企业价格表后才能用于报价。
- **成本面板的 BOM 需手工导入**：面板接受 BOM JSON（或由上层注入 `__CostBomProvider`），尚未把 CAD 模型零件名自动映射到元器件物料号（映射口径待定，见 BACKLOG D7）；Agent 工具 `run_cost_report` 未传 `bom` 时回落到当前场景 BOM，场景零件没有物料号，会全部计入「缺物料号」而不会按 0 计价。Agent 导出工具 `export_cost_report` 固定写 `<userData>/exports/`（Windows 通常为 `%APPDATA%/AutomationCAD/exports/`），不接受任意绝对路径、不弹系统保存对话框；面板里的 CSV 仍走系统保存对话框。
- **运动学标注需人工指定**：STEP 不含运动学，动件 / 轴 / 行程 / 点位由人标注；未标注时联调回退到机型配置。
- **参数化建模已完成 P9-5 多实体与 BOM 联动**：右侧抽屉可维护多个实体（独立 box / holes / slot / fillet / cylinder 特征与 X/Y/Z/RZ），自动重建后载入 sidecar 返回的 STL 并叠加旧模型；BOM 按 partId 合并、未映射件显式标黄，可导出 UTF-8 BOM CSV 并送成本面板，未映射件按 `NO_PART_ID` 缺价（[PARAMETRIC-CAD.md](docs/desktop/PARAMETRIC-CAD.md)）。仍需 Python sidecar 运行时；草图约束（P9-4）未做。
- **PLC 程序自动生成完成 P8-1～P8-4**：预检、IO 变量表、五个基础块、自动序列/报警/安全 FC、`mapping.json`、生成 UI、zip 导出、最近 10 次历史，以及内置模拟器执行联调序列（超时/SafeStop/传感器矛盾）已落地（[PLC-CODEGEN.md](docs/desktop/PLC-CODEGEN.md)）；仍不生成厂商专有工程文件。
- **委外加工数据智能系统为规划项**：仅在设计方案与汇报材料中描述，未开发。
- **便携包偏大**（Electron 45 + node-opcua，解压后数百 MB），后续可按需懒加载 node-opcua 或改 sidecar。
- **干涉为 AABB 初筛**，不是精确布尔求交；贴合面、螺纹啮合可能被误报，需要白名单收口。
- **智能体对话的真实模型兼容性**只按 OpenAI 兼容协议验证，测试连接与工具调用使用本地假服务；各服务商差异需逐一验证。
- **离线意图路由是关键词规则，不是语义理解**：只覆盖 7 类意图与元件/成本/BOM/干涉/电气校验等有限句式，同义表达未收录会判为「超纲」；离线通道只执行只读工具，写操作一律要求联网确认。审计文件 `agent-audit.jsonl` 目前只追加、未做轮转与保留期清理；审计面板只列最近 8 条、无筛选与导出，回执不含 token 用量（网关未回传 usage）。
- **生产环境未验证**：`/api/v1/design-sync/*` 后端 0.22.0 已实现并通过 30 项测试，本地临时 DB 端到端已通过（`npm run sync:e2e`）；生产实例 `221.231.106.194:5556` 当前从开发机不可达，线上部署仍待 D2 决策。
- **原型侧的固有限制仍在**：3D 视口为固定等轴测示意投影，不支持真实几何求解；属性编辑只重算尺寸不改拓扑；插入件为示意占位体。桌面版的 CAD 查看是独立视图，不替代原型建模。

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/desktop/STATUS.md](docs/desktop/STATUS.md) | 当前进度、验证记录、未完成项与风险 |
| [docs/desktop/BACKLOG.md](docs/desktop/BACKLOG.md) | 夜间迭代看板：待办优先级、已完成提交号、已知问题 |
| [docs/desktop/MODULES.md](docs/desktop/MODULES.md) | 模块索引、跨模块数据流、维护约定 |
| [docs/desktop/ARCHITECTURE.md](docs/desktop/ARCHITECTURE.md) | 技术选型、进程与安全边界、关键接口 |
| [docs/desktop/REQUIREMENTS.md](docs/desktop/REQUIREMENTS.md) | 需求来源与验收口径 |
| [docs/desktop/PHASE2.md](docs/desktop/PHASE2.md) | 二期需求拆分（干涉/受力/PLC/联调/导出/同步） |
| [docs/desktop/COSTING.md](docs/desktop/COSTING.md) | 硬件成本统计：价格簿格式、计算口径、验收 |
| [docs/desktop/NL-AGENT.md](docs/desktop/NL-AGENT.md) | 自然语言 Agent：架构、12 个已实现工具、写操作分级、安全、评估集 |
| [docs/desktop/PARAMETRIC-CAD.md](docs/desktop/PARAMETRIC-CAD.md) | 参数化建模：build123d 选型、sidecar 契约、特征树与分期 |
| [docs/desktop/PARAMETRIC-CAD-SPIKE.md](docs/desktop/PARAMETRIC-CAD-SPIKE.md) | CadQuery / build123d / replicad 三方案实测对比 |
| [docs/desktop/PLC-CODEGEN.md](docs/desktop/PLC-CODEGEN.md) | 设计完成后自动生成 PLC 程序（ST + IO 表 + 预检） |
| [docs/desktop/SMART-FACTORY-INTEGRATION.md](docs/desktop/SMART-FACTORY-INTEGRATION.md) | 智慧工厂接口契约与联调口径 |
| [docs/desktop/PLUGIN-PACKS.md](docs/desktop/PLUGIN-PACKS.md) | 数据包格式与加载规则 |
| [docs/desktop/CI.md](docs/desktop/CI.md) | Windows 安装包构建与手动触发方式 |
| [docs/report/PROJECT-INTRO.html](docs/report/PROJECT-INTRO.html) | 领导汇报用项目简介（19 页，可打印 A4） |
| [docs/reference/electrical-components.md](docs/reference/electrical-components.md) | 电气元件参数参考 |
| [desktop/README.md](desktop/README.md) | 桌面版命令、MCP 接入、JSON-RPC 与各面板细节 |

> `packs/builtin` 中的元器件参数与价格仅用于选型 / 成本演示，定型与报价前请以厂商最新样本、铭牌与正式报价为准。
