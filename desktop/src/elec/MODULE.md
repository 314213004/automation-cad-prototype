# 电气校验模块（desktop/src/elec/）

电气域的设计初筛：线号合规、功率统计、导线截面与断路器配合。三层结构，数据只往下流：

```
ElecDocument ──runElectricalCheck()──→ ElecCheckResult
                                        ├─ ui.ts        面板：统计卡 + 问题表 + 导出
                                        └─ report.ts    A3 横向 HTML（printToPDF）
```

## 文件

| 文件 | 职责 |
|------|------|
| `design.ts` | **通用电气描述层 `ElecDesign`**（机型无关）+ 规整化（补起停按钮/电机运行输出、分配 PLC 地址、极性检查） |
| `adapters.ts` | 适配器：①已保存工程 → ElecDesign（工艺→物理估算器注册表 + 零件名分类）；②规则引擎机型方案（config/IO 表/BOM/功率）→ ElecDesign |
| `build.ts` | ElecDesign → `Circuit` + 版面计划 `ElecPlan`（主回路支路、安全链、起保停、IO 列、端子分配） |
| `pages.ts` | 分页版面：主回路页 / 控制回路页 / PLC 输入页 / PLC 输出页，放不下自动开新页 |
| `canvas.ts` | 单页画布、空间索引、文字“候选位置 + 碰撞检测”摆放、图框列号 `columnOf` |
| `drawing.ts` | **出图唯一入口 `renderElecDrawing`**：线号、交叉引用、端子表/导线表/明细表页、逐页 + 全局自检、SVG |
| `wireno.ts` | **线号方案**：网络类别、模板/占位符、3 个预设、方案校验、网络分类 `classifyNets`、分配 `assignWireNoScheme`（含重号去重）、按方案的格式正则（`check.ts` 用） |
| `wireno-ui.ts` | 「线号格式」弹窗 + localStorage 读写（`automationcad.elec.wireScheme.v1`）+ 示例预览；入口由 `extension.ts` 注入翻页条 |
| `circuit.ts` | 电路模型（元件/引脚/网络）+ ERC；电机每相从 U/V/W 往电源侧追（多极元件 i↔i+极数、驱动器输出↔输入）；线圈驱动/停止按“拿掉该类元件后是否还能通电”判 |
| `machine-circuit.ts` | 断路器名称按型号系列（`breakerNameFor`）；`buildMachineCircuit` 为旧单页接口（只保留给单页回归测试，应用不再调用） |
| `protection.ts` | 由功率选断路器/接触器/热继档位 |
| `symbols.ts` | IEC 60617 风格符号 → 几何图元 + 引脚落点 |
| `layout.ts` | 旧单页版面（只服务 `renderSheet` 单页回归测试；单页放不下报 `IO_TOO_DENSE`，多页出图走 `pages.ts`） |
| `geometry.ts` | 图元、文字度量、相交判定、交点打点、`checkWiring` / `checkTexts` |
| `sheet.ts` | 旧 A3 单页渲染（`renderSheet`），同上只保留给回归测试 |
| `check.ts` | 纯函数规则引擎（不依赖 DOM/IPC），含 `AMPACITY_TABLE`、`BREAKER_RATINGS` |
| `report.ts` | `renderElecCheckHtml(project, result)` 生成可打印报告，全部字段做 HTML 转义 |
| `ui.ts` | 「电气校验」抽屉面板：入口按钮 `elecCheckEntryButton`、抽屉 `elecCheckDrawer`、脚本 API `window.__ElecCheckPanel` |

## 可选模块 `elec.validation`

- v1.0.0 / Module API 1，默认启用以兼容既有安装，依赖 `core`。能力声明：`elec.validation.rules`、`elec.validation.panel`、`agent.electrical-check`、`elec.validation.report.export`。
- 控制校验面板、PDF 导出及 Agent `run_electrical_check` 命令/工具、JSON-RPC 与 MCP。关闭后面板入口隐藏并收起，脚本运行/PDF 导出、旧工具名与命令直调均在执行前失败关闭并返回 `MODULE_DISABLED`；renderer 状态同步获主进程接受后才开启，主进程工具列表与 MCP 代理使用同一状态。桌面状态不可达时 MCP 隐藏该工具且不回退本地执行。
- 重新启用后规则、结果和报告恢复。开关只保存模块状态，不改电气原理图/项目数据、元件库、底板布置或 Agent 审计历史；这些设计与数据入口不归本模块管理。

## 数据契约

- `ElecDocument = { wires?, loads?, circuits?, options? }`；`ElecCheckResult = { findings, summary, counts }`。
- 面板本身不造数据：从 `window.__ElecDocProvider()` 取文档，未注入时只提示「尚未接入电气数据源」。
- Agent 侧同一套判定：命令 `run_electrical_check`（`src/agent/commands.ts` 里做入参解析与中文报错）+ 工具 `run_electrical_check`（`src/agent/tools.ts`，返回 `counts/summary/findings`，超过 50 条标 `truncated`）。

## 出图管线（应用与 Agent 只走这一条）

```
已保存工程 ─elecDesignFromProject─┐
机型方案(MachineDesign/config) ─elecDesignFromMachine─┤→ ElecDesign → buildElec → Circuit+ElecPlan
                                                      → runErc → 分页版面 → 线号 → 交叉引用 → 文字摆放 → 逐页/全局自检 → 每页 SVG
```

`extension.ts` 只决定数据源（最近“打开/生成的工程”或“应用的机型方案”，谁新用谁；选源与缓存在 `source.ts` 的 `ElecSourceTracker`），然后 `renderElecDrawing(design)`。
数据源入口：Agent `apply_machine_design`（新建/幂等重复/覆盖/撤销，渲染桥 `applyMachineConfig` 载荷带 `design.bomDraft` + `design.power`）、
启动恢复 active 方案（`machine:active` 整份方案）、工程库打开工程、`build_machine_model` 生成并装配的整机。只收到 config 的旧载荷按缺省功率出图，
并在图纸说明首条写明“未携带 BOM/功率”。顶栏电气按钮/快捷键/菜单/覆盖层电气按钮都经 `body[data-domain]` 刷新到当前数据源；
没有机型分支、不认零件名、不写死图号。图号由适配器按数据给（`EL-<工艺码>-<标识末段>`），页码 n/N 由分页给。
多页经 `ElecDomain.setSchematic` 逐页送进电气域画布，画布底部的翻页条（`.cad-elec-pager`）切页；
`window.__ElecDocProvider` 同时注入线号/负载数据，电气校验面板读的就是出图这份；Agent `run_electrical_check` 不传数据时经渲染桥 `getElecDocument` 读同一份。

### ElecDesign 字段

| 字段 | 含义 |
|------|------|
| `project` / `drawingNo` / `source` / `notes` / `date` / `designer` | 标题栏与说明栏 |
| `supply.mainBreakerModel?` | 总进线断路器型号（缺省按最大相电流 ×1.25 选 iC65N/NSX） |
| `plc.model` / `psu.{model,watts}` | PLC、24V 开关电源 |
| `motors[]` | `{id,name,purpose,starter:'dol'\|'vfd'\|'servo',powerKw,spec?,motorModel?,driveModel?,breakerModel?}`；直启=QF-KM-FR-M，变频=QF-U-M（380V），伺服=QF(1P 或 1P+N)-U-M（单相 220V，按 L1/L2/L3 轮流取相） |
| `inputs[]` | `device`：photoelectric/proximity/pressure（三线，`output` PNP/NPN）、proximity-2w（两线）、button-no/nc（`role` start/stop/reset/other）、safety-status（`safetyOf` 'estop' 或光栅 id，接安全继电器 Y32）；`address?`/`point?` |
| `outputs[]` | `device`：valve/lamp/buzzer/relay/motor-run（`motorId`；直启→FR 常闭+KM 线圈，变频→DI1，伺服→SON） |
| `safety` | `estops` 个数；`curtains[]`（每套 OSSD 双通道配一只安全继电器）；`relay`：急停是否经安全继电器（有光栅自动为真） |
| `startStop` | hardwired（起保停硬接线：1 台直启电机为经典自锁，多台用 -KA 运行继电器）/ plc（起/停按钮进 PLC，自动补）/ none（无起停按钮） |

### 分页与交叉引用

- 主回路页：总进线 PE/N/L1/L2/L3 → -QF0 → 母线；每路负载占一列（50 mm），每页 7 路；超出开下一页，母线在页边断开。
- 控制回路页：+24V/0V 上下母线；第一块是 -FU1 → 急停（无安全继电器时串联）/ 各安全继电器 13-14 → 安全母线 S（线号数字），之后是起保停电流路径、安全继电器块（急停双通道 S11-S12/S21-S22、复位 S33-S34、Y32 状态）、光栅块、PLC 电源块；按宽度从左往右排，放不下开新页。
- PLC 输入/输出页：每页 14 点（每点 24.5 mm 一列），PLC 画成片段框（每页只画本页端子），输入公共端 1M、输出组电源 3L+（取自安全母线 S，急停切断全部输出）/3M。
- 列号 1–8、行号 A–F 画在图框边带上；交叉引用写成 `/页.列`。跨页网络在每页都留电位断点（`←/页.列` 指回上一页、`→/页.列` 指向下一页）。
- 触点镜像：接触器/继电器线圈下方页脚列出 `主 1-6 /页.列` 与各辅助触点位置；主触点、热继、驱动器旁写线圈/常闭/控制端子的位置；安全继电器写安全输出位置。
- 文字一律走候选位置 + 碰撞检测（`canvas.ts`）；摆不下记 `LABEL_UNPLACED`，绝不硬压。
- 表格页：端子表（每 44 行一页）、导线表、元件明细表（含页.列位置）。

### 线号方案（`wireno.ts`；出图与 `check.ts` 校验同一份——方案即规则）

`WireNoScheme = { version: 1, preset: 'digital'|'potential'|'pagecol'|'custom', templates: Record<类别, 模板>, numStart, dedupe }`。
`renderElecDrawing(design, { wireScheme })` 按它出图，缺省“数字连续”（逐字等于旧输出，测试断言 SVG 一致）。
`ElecDrawing.wireScheme / wireCategories / wireNoAdjusted`；`document.wireScheme` 与 `document.wires[].category` 交给电气校验面板与 Agent。

**类别**（17 个；母线类别整图一个电位、图上用母线标签不逐根标线号，模板不能用位置/序号占位符）：

| id | 含义 | 网络（build.ts 命名） |
|---|---|---|
| `mainIn`（母线） | 三相·总进线前 | 标签 L1/L2/L3 |
| `mainBus` | 三相·总开关后 | `BUS-Lk` |
| `branch` | 三相·支路断路器后（含单相支路相线） | `Bn-L`、`Bn-Qi` |
| `branchK` | 三相·接触器后、热继前 | `Bn-Ki` |
| `neutralMain`（母线）/ `neutralBranch` | N 总进线 / 1P+N 断路器后 | 标签 N / `Bn-N` |
| `pe`、`dc24`、`dc0`（母线） | PE、+24V、0V | 标签 |
| `motor` | 电机出线 U/V/W | `Bn-U/V/W` |
| `plcIn` / `plcOut` / `analog` | PLC 每点 | `IN-<地址>` / `OUT-<地址>` / 地址 AI/AQ/IW/QW |
| `plcCommon` | PLC 公共端单独成网时（COM/M/L+） | 例：`S24` 接 3L+（有 PLC 输出时安全母线就是输出组电源） |
| `safety` | 安全回路 | `S24`（无 PLC 输出时）、`CH-i`、含安全继电器/光栅的网络 |
| `control` / `other` | 其余控制网络 / 无引脚网络 | |

**占位符**：`{seq}` 类别内序号（阅读顺序；PLC 类按地址顺序 = `{pt}`）、`{num}` 全局流水号（从 numStart 连续，只数用它的网络）、
`{page}`/`{col}`/`{row}` 网络首次画出的页/列/行、`{cseq}` 同页同列内序号、`{cdot}` 同页同列多网络时为 `.n` 否则为空、
`{phase}` 1/2/3（三相与电机类）、`{grp}` 所属支路/电机编号（位号数字：-QF2→2、-M1→1）、`{addr}` PLC 地址、`{pt}` PLC 第几点、
`{tag}` 元件位号（去前导 -）、`{pin}` 引脚；其余字符原样（只许 `A-Za-z0-9 . + - _ / :`）。

**校验**（`validateWireNoScheme` / `validateTemplate`，UI、localStorage、Agent 入参共用）：空、首尾空格、非法字符、过长（模板 ≤24、后缀 ≤6）、
未知占位符、花括号不配对、母线用位置占位符、非三相类用 `{phase}`、非 PLC 类用 `{addr}/{pt}`、只有 `{cdot}` → 拒绝并给中文原因；缺的类别按预设补齐。

**预设**：

| 预设 | 规则 | 六工位锁螺丝示例 |
|---|---|---|
| 数字连续（缺省，现行） | 母线固定 L1/L2/L3/N/PE/24V/0V，其余 `{num}` 101 起按页→列→行 | 101、102…164 |
| 电位-类别 | `L{phase}`、总开关后 `L{phase}1`、支路 `{grp}L{phase}`、接触器后 `{grp}T{phase}`、`N`/`N{grp}`、`+24V`/`0V`、电机 `{grp}{pin}`、`DI{seq}`/`DO{seq}`/`COM`/`AI{seq}`、安全 `S{seq}`、其余 `{num}` | L11/L21/L31、1L1、2L2、N1、1U/1V/1W、DI1…DI9、DO1…DO13、COM、S1… |
| 页.列（IEC） | 母线固定，其余 `{page}.{col}{cdot}` | 1.1.1、1.2.1、1.3.3、3.2、2.4.2 |

**分配**：母线类别先分（保住模板原值），其余按“页 → 列（x）→ 行（y）”阅读顺序，没画出来的排最后。同一网络始终一个线号；
不同网络若模板产生同号（大小写不敏感），后出现的追加 `dedupe` 后缀（`.{k}`→.1/.2，`-{a}`→-a/-b，撞上已有号继续往后取），
记入 `wireNoAdjusted` 并出一条 `WIRENO_SUFFIXED` 警告（不阻断交付，标题栏“校验通过（n 条提示）”，画布提示条也会说）。三个预设在矩阵上零去重（测试断言）。

**校验口径**（`checkWireNumbers(wires, scheme = 数字连续)`）：带类别的导线按该类别模板（+ 可选后缀）判格式，不带的符合任一类别即可；
跨网同号 → 严重；同网重复 → 警告；`L1/L2/L3/N/PE` 字面线号与电位不一致 → 严重；纯 `{num}` 类别的数字跳号 → 汇总警告。
`classifyWireNo` 保留旧口径（只给“数字连续”的粗分类用）。

**长线号**：横写放不下（如三相间距里的 `1.3.3`）时，沿竖线竖写（`TextPrim.rot = 90`，`textBox` 按旋转后的框做碰撞），排在所有横写候选之后，所以缺省方案出图不变。

**设置入口**：电气域画布翻页条右端「线号格式」→ 弹窗选预设 / 逐类别改模板 / 改起始号与后缀，逐键校验 + 示例预览；保存写 localStorage 并 `ElecSourceTracker.setWireScheme` 后停在当前页重画，导线表/端子表/校验面板/Agent 同一份。
**遗留**：方案是本机全局设置，没有写进工程文件（`project.json` 由主进程 `electron/projects.ts` 管理，需要新 IPC）或机型方案。

- 导出给校验面板的 `ElecDocument.wires` 每个网络一条（同网多根导线不重复登记，否则会报 `WIRE_NO_DUPLICATE`）；逐根导线在导线表 `wireList`（按线号分配顺序排）。

### 端子排 -X1

- 凡是“柜内元件与现场元件同在一个网络”，现场元件（电机、传感器、阀、灯、按钮、急停、光栅）的**每个引脚各占一个端子**；纯现场网络（急停串联之间）不经端子；现场 PE 一律经 PE 端子。
- 端子号按现场元件出现顺序 1…N 连续；端子在电路里是 `kind:'terminal'` 的两脚元件（i 柜内侧 / o 现场侧，同属一个网络），图上画在现场引脚旁的导线上，`checkWiring` 把端子两侧按桥接处理。
- 明细表里 `-X1` 一行写端子总数（通用/PE），逐个端子见端子表页。

### 出图自检代码（多页新增）

| 代码 | 含义 |
|------|------|
| `LABEL_UNPLACED` | 位号/说明/线号/交叉引用找不到不压线的位置 |
| `WIRENO_MISSING` | 某非母线网络在某页画了导线但没有线号文字 |
| `WIRENO_RULE` / `WIRENO_DUPLICATE` | 线号不符合当前线号方案（`check.ts`）/ 两个网络同号（大小写不敏感） |
| `WIRENO_SUFFIXED`（ERC 警告，不阻断） | 线号模板产生重号，已自动加区分后缀 |
| `XREF_MISSING` / `XREF_DANGLING` | 跨页网络在某页没有电位断点 / 断点指不到任何别的页 |
| `PIN_DRAWN_TWICE` | 同一引脚在图上画了两次 |

其余（`PIN_NOT_DRAWN`、`NET_BROKEN`、`NET_SHORT`、`WIRE_DANGLING`、`WIRE_THROUGH_SYMBOL`、`TEXT_OVERLAP`、`SYMBOL_OVERLAP`、`BOM_NOT_DRAWN`、`BOM_NAME_MODEL`、`LADDER_TOO_LONG`）沿用单页口径，按页做（本页子电路 = 本页画出的引脚 + 电位断点伪元件）。

## 规则口径

- 线号：按线号方案（见上，缺省“数字连续”= `L1/L2/L3/N/PE`、`24V/0V`、≥3 位数字）；缺号 → 警告，格式不合规 → 警告，同一网络重复 → 警告，跨网络同号 → 严重，相线线号与电位不一致 → 严重，`{num}` 流水号跳号 → 一条汇总警告。
- 功率：3P 按 `√3·U·cosφ·η`，单相按 `U·cosφ·η`，DC24 按 `P/U`；全部乘需要系数（默认 0.8）；最大相电流 × 1.25 就近选标准壳架，再按载流量表反推进线截面。
- 截面：按铜芯 30℃ 穿管表；`breakerA > 载流量` 判为导线失去保护（严重）。
- **注意**：只要登记了负载，`MAIN_BREAKER_SUGGEST` 一定是 `info` 级 finding，所以「零问题」只可能出现在无负载文档里；写测试别断言 `findings.length === 0`。

## 原理图出图自检（`renderSheet` → `problems`）

图面先全部生成为图元，再自检；**任何一项 → `deliverable=false`、标题栏写“有待处理问题”、图上打红框清单**。代码形如 `[CODE] 说明`：

| 代码 | 含义 |
|------|------|
| `PIN_NOT_DRAWN` / `PIN_UNWIRED` | 元件引脚没画出 / 没有导线落点（漏画元件、导线停在符号外） |
| `NET_BROKEN` / `NET_SHORT` | 同一网络在图上不连通（断口、端点偏移）/ 不同网络连到一起 |
| `WIRE_DANGLING` / `WIRE_THROUGH_SYMBOL` | 两头都没接元件的导线 / 导线穿过符号本体 |
| `TEXT_OVERLAP` / `TEXT_OUT_OF_FRAME` | 文字框压到任何线条/圆/框/其他文字，或越出图框（标题栏、表格也查） |
| `DEVICE_NOT_PLACED` / `BOM_NOT_DRAWN` | 电路里有、版面没放 / 明细表里有、图上没有位号 |
| `BOM_QTY` / `BOM_NAME_MODEL` | 明细表数量 ≠ 位号去重 / 断路器名称与型号系列不符 |
| `SYMBOL_OVERLAP` / `SYMBOL_OUT_OF_FRAME` / `LADDER_TOO_LONG` / `IO_TOO_DENSE` | 版面容量与重叠 |

- 连通性按几何判：线段端点落在另一线段上（端点或 T 接）才算连；十字交叉不算连、也不打点；≥3 条支路汇于一点自动打点。
- 文字宽度按「中日韩 1em、其余 0.6em」保守估算；表格/标题栏/说明一律 `fitText` 截断。
- 状态栏两种文字（“校验通过”/“有待处理问题”）都先排一遍做自检，保证都放得下。
- `extension.ts` 用 `renderElecDrawing` 的 `issues`（ERC/设计层）与 `problems`（图面自检）生成提示条，与图面问题框一致。

## 坑

- `tsconfig` 开了 `exactOptionalPropertyTypes`，构造可选字段（如统计卡 `tone`）要条件展开，不能写 `tone: undefined`。
- 报告里的位置串是 `from→to`（无空格）多段用 `、` 连接，断言要按实际拼接结果写。
- 新增 Agent 工具会同时打破 3 处计数断言（`test/agent/{tools,mcp,rpc}.test.mjs`）与 smoke 的 `SMOKE_AGENT_TOOLS_OK`，必须一起改，且直接改成新数字而不是放宽。
- 面板 PDF 走 `window.desktop.exportReport({html, projectName})`（A3 横向、输出名固定 `report.pdf`），不是浏览器 `window.print()`。

- 原理图测试写几何断言（引脚坐标、线段端点、文字框与笔画相交），别写 SVG 快照；新增符号要给关键笔画打 `role`（lead/blade/hook/linkage/body/tag…），测试按 role 取图元。
- 离线看图：`node /tmp/elr/variants.mjs [名称过滤]` 把 `test/elec/matrix.mjs` 每个方案的每一页渲染成 `/tmp/elr/out/<名称>-p<页>.png`（resvg + 文泉驿字体，脚本备份在项目 `work/elr/`）。
- 线号方案：`test/elec/wireno.test.mjs`（占位符、非法模板、去重、方案即规则、持久化、Agent 同源）；`drawing-matrix.test.mjs` 里三个预设 × 15 机型 + 12 种子全部走同一组断言。
  离线看图 `node work/elr/wireno.mjs`（项目 work 目录）出两个预设下六工位锁螺丝的主回路/PLC 输入页及左半局部。
- 测试矩阵 `test/elec/matrix.mjs`（输送机 3 档、规则引擎 5 类工艺 + 规则引擎输送机、极端用例）与随机化矩阵（`drawing-matrix.test.mjs` 内 12 个种子）共用同一组断言：ERC 0 error、自检 0 问题、可交付、每引脚恰画一次、线号同网同号/异网异号且 `checkWireNumbers` 零发现、混合网络现场引脚全经端子、端子号连续、分页数 = ⌈数量/容量⌉、交叉引用指向的页真有该网络、明细表位号都画在图上。

## 验证

`npm test`（`test/elec/*`，其中 `drawing-matrix.test.mjs` 是多页出图矩阵、`sheet-geometry.test.mjs` 是旧单页图面回归、`test/agent/elec-check.test.mjs`）；`npm run smoke` 打印
`SMOKE_ELEC_CHECK_OK`（规则引擎）与 `SMOKE_ELEC_CHECK_UI_OK rows=… cards=9 pdf=true`（面板 + PDF）。
