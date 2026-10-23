# 设计完成后自动生成 PLC 程序 · 设计方案

状态：P8-1 ✅ 已实现（预检 + IO 变量表 + 五个 ST 基础块）；P8-2 ✅ 已实现（自动序列 / 报警 / 安全 FC + 汇总生成）；P8-3 ✅ 已实现（生成 UI + 文件树 + zip 导出 + 历史）；P8-4～P8-5 待做
目标：电气设计定稿（选型 + IO 表 + 动作顺序）后，一键生成**可直接导入 PLC 工程**的程序骨架与变量表，把「画完图再手工敲程序」变成「设计即程序」。

## 1. 输入（全部来自已有模块）

| 输入 | 来源 | 说明 |
|---|---|---|
| IO 点位表 | `MachineConfig`（`sensors` / `actuators`）+ IO 视图 | 点位号、地址、名称、类型、常开/常闭、所属工位 |
| 执行机构参数 | 机型配置 | 气缸行程、夹爪开合、旋转轴角度、动作时间 |
| 动作顺序 | 联调序列（commission） | 步序、每步置位/复位点位、等待条件、超时 |
| 安全件 | 元件库 + 原理图 | 急停、安全门、安全继电器、光栅对应点位 |
| 选型信息 | BOM / 元件库 | PLC CPU 型号、IO 模块型号与点数、通信模块 |

前置校验（不通过不允许生成，列出全部问题而不是第一条）：
- 点位地址重复、地址越界（超出模块容量）
- 同一点位被多个执行机构占用
- 传感器未绑执行机构 / 执行机构无到位检测
- 急停回路未定义、安全门未接
- 步序引用了不存在的点位
- 输出点无双线圈检查（同一点位在多处被赋值的静态扫描）

## 2. 输出物

目录结构（导出为 zip，与设计包同源）：

```
plc/
  README.md                生成说明、机型版本、校验结果
  io-tags.csv              IO 变量表（地址,名称,数据类型,注释,工位）
  io-tags.tia.xml          （可选）TIA Portal 变量表导入格式
  src/
    OB1_Main.st            主循环：调用手动/自动/报警
    FB_Cylinder.st         气缸功能块（伸出/缩回/超时/到位）
    FB_Gripper.st          夹爪
    FB_RotaryAxis.st       旋转轴
    FC_AutoSequence.st     按联调步序生成的状态机
    FC_Alarms.st           报警与复位
    FC_Safety.st           急停/安全门/光栅互锁
    DB_IO.st               IO 映射与状态 DB
  mapping.json             点位 ↔ 变量 ↔ 步序 ↔ 图纸元件位号
```

首期目标语言：**IEC 61131-3 Structured Text (ST)**，能被 TIA Portal、CODESYS、倍福、汇川 AM600 等直接使用或少量适配。二期再做各家专用工程文件（见第 6 节）。

## 3. 代码生成规则（模板 + 参数，不做「AI 自由发挥」）

1. **确定性生成**：同一输入必须产出逐字节相同的文件（排序稳定、无时间戳进正文，时间只写在 README）。生成器带 `inputHash`，重复生成直接命中缓存。
2. **每个块头部注释**：
   ```
   // 自动生成，请勿手工修改
   // 机型: SLIDE-ASSY-01  版本: 3  输入哈希: 9f2c…
   // 来源: AutomationCAD 生成器 v1  生成时间: 2026-10-23T06:00:00+08:00
   ```
3. **气缸 FB**：`Execute` 上升沿触发 → 置位输出 → 等待到位传感器（`TimeoutTime` 默认 3 s）→ 到位置 `Done`；超时置 `Error` 并触发报警号。缩回同理，带互锁（不允许同时置位伸出/缩回）。
4. **自动序列 FC**：CASE 状态机，每步 `StepNo`、动作、转移条件（点位 AND/OR 组合）、超时；生成时把联调序列原样映射，不重排。
5. **安全 FC**：急停/安全门用常闭串联，任一断开 → 复位所有输出（`SafeStop`），并锁存直到人工复位。
6. **报警 FC**：超时、传感器矛盾（伸出与缩回同时为 1）、安全触发，统一报警字 + 首故障锁存。
7. **手动模式**：每个执行机构一组手动按钮（HMI 位），带互锁与使能条件，不允许绕过安全。
8. **禁止生成的写法**：不使用厂商专有指令；不使用指针/间接寻址；不生成空 FC；变量全部显式声明（`VAR`/`VAR_GLOBAL`）。

## 4. 界面与流程

入口：设计定稿后，「出图」页新增「生成 PLC 程序」按钮，或在联调面板顶部提示。

流程：
1. 点「生成」→ 弹出预检结果（通过/问题清单，问题可点击定位到 IO 表/原理图）
2. 选择目标（ST 通用 / 西门子 S7-1200 / S7-1500 / CODESYS）与命名前缀（默认机型编号）
3. 生成 → 展示文件树 + 每个块的行数与摘要 + 变量统计（I/Q/M/DB 数量）
4. 「导出 zip」「复制到剪贴板」「在文件夹中显示」
5. 生成记录写入 `plc-gen-history.json`（时间、inputHash、目标、文件数），可回溯

## 5. 质量与验证

- **静态自检**（生成器内部）：变量声明完整、地址唯一、无空块、无未使用变量（仅告警）、ST 语法用 `st-parser`（或自写轻量词法）解析通过
- **逻辑自检**：用内置 PLC 模拟器（已有 `desktop/src/plc/` Modbus 模拟器）加载生成的 IO 映射，跑一遍联调序列，断言每步到位 —— 生成即验证
- **单测**：≥18 条（气缸时序、超时、互锁、状态机转移、安全复位、确定性输出、预检各类错误）
- **smoke**：`SMOKE_PLC_GEN_OK files=9 vars=24 steps=6 errors=0`

## 6. 二期：厂商工程文件

| 目标 | 方式 | 前提 |
|---|---|---|
| 西门子 S7-1200/1500 | TIA Openness（.NET API）生成变量表 + 块；或导出 SCL 由人导入 | Windows + 已装 TIA（本机 wine 不行，需目标机） |
| 三菱 FX5U / iQ-R | GX Works3 不支持脚本；输出 ST + 点位 CSV，人工粘贴 | 无自动化路径 |
| 欧姆龙 NX/NJ | Sysmac Studio 支持 IEC ST，直接导入 | 需人工确认库差异 |
| 汇川 AM400/AM600 | InoProShop 支持 ST | 同上 |

结论：**首期只做 ST + 变量表**，覆盖所有主流平台的手工导入；TIA Openness 作为可选增强，不阻塞交付。

## 7. 与智慧工厂的关系

- 生成的 `plc/` 目录随设计包一起上传（manifest 增加 `kind: "PLC"` 文件项，服务端已支持任意 kind 白名单需确认）
- 智慧工厂侧可读取 `mapping.json` 做「图纸元件 ↔ 点位 ↔ 程序变量」追溯
- 需要对方确认：`FILE_KINDS` 是否允许新增 `PLC`；若不改，则用 `OTHER` 并备注

## 8. 验收（首期）

- 用 demo 机型（4 工位 / 12 执行机构 / 16 传感器）生成 9 个文件，预检 0 错误
- 生成的 ST 通过语法解析，变量表与 IO 表逐条一致
- 同一输入连续生成 3 次，文件 sha256 完全一致
- 内置模拟器跑通 6 步联调序列，无超时
- 不修改用户手写文件：输出目录已存在时提示覆盖/另存，默认另存带时间戳

## 9. 分期

- P8-1：预检器 + 变量表 + 气缸/夹爪/轴 FB + 单测（无 UI）
- P8-2：自动序列 FC + 报警/安全 FC + 确定性校验
- P8-3：生成 UI + 导出 zip + 历史记录
- P8-4：模拟器联调自检 + 设计包上传集成
- P8-5（可选）：TIA Openness 导出

## 10. P8-1 实现记录（2026-10-23）

状态：✅ 核心完成（无 UI）。交付 `desktop/src/plcgen/`：`precheck.ts`、`tags.ts`、`st.ts`，共享的 `io.ts` / `types.ts` / `hash.ts` 与统一导出 `index.ts`。

### 输入扩展

`precheck` / `buildTags` / `generateSt` 接受原 `MachineConfig`，并可附加以下可选字段（不改原有配置格式）：

```ts
{
  version?: string | number,
  safety?: { emergencyStop?, estop?, safetyDoor?, safetyDoors?, reset? },
  sequence?: Step[] | steps?: Step[],
  ioPoints?: { point, area?, address?, name?, station?, role? }[]
}
```

- 安全点位也可用传感器 `role: 'estop' | 'safetyDoor'`，或 `part` 中的「急停 / 安全门 / 光栅」识别；安全传感器不参与“未绑定执行机构”检查。
- 步序支持 `point`、`points`、`setPoints`、`resetPoints`、`waitPoints` 与 `condition` 表达式。
- BOM 兼容现有 `BomRow[]`、`{ modules }` / `{ bom }` / `{ plc.modules }`；点数可用 `inputPoints`/`outputPoints`/`points`，或从 `16DI/16DO`、`8 点` 等文本解析。

### 预检（全量返回，不遇错即停）

`precheck(config, bom?) → { errors, warnings }`，错误码：`ADDRESS_DUPLICATE`、`ADDRESS_OUT_OF_RANGE`、`POINT_MULTI_ACTUATOR`、`ACTUATOR_SENSOR_MISSING`、`SENSOR_UNBOUND`、`ESTOP_UNDEFINED`、`SAFETY_DOOR_UNDEFINED`、`SEQUENCE_POINT_NOT_FOUND`、`DOUBLE_COIL`、`BOM_PLC_INPUT_POINTS_INSUFFICIENT`、`BOM_PLC_OUTPUT_POINTS_INSUFFICIENT`、`BOM_PLC_POINTS_INSUFFICIENT`。I/Q 各自上限 256 点；旧命名 `X0/Y0` 与 `I0.0/Q0.0` 按同一物理地址归一化。

### IO 变量表

`buildTags(config) → { rows, csv }`：输入先于输出，按点位自然序稳定排序后分别从 `I0.0` / `Q0.0` 分配；名称 `<工位>_<机构>_<用途>`，非法字符替换为 `_`、最长 32 字符、重名追加 `_2`。CSV 为 UTF-8 BOM + `地址,名称,数据类型,注释,工位`，换行 `CRLF`。

### ST 生成

`generateSt({ config, version?, timeoutTimeMs?, toleranceDeg? })` 或直接 `generateSt(config)`，输出：

| 文件 | 内容 |
|---|---|
| `src/FB_Cylinder.st` | `R_TRIG` 上升沿、伸出/缩回互斥、到位 `Done`、`TON` 超时 `Error` |
| `src/FB_Gripper.st` | 开/合两路输出互斥、开合传感器冲突、超时 |
| `src/FB_RotaryAxis.st` | `ABS(ActualAngle - TargetAngle) <= Tolerance` 到位判断 + 超时 |
| `src/DB_IO.st` | 变量表逐条映射为 `AT %I... / %Q...` 声明 |
| `src/OB1_Main.st` | 手动、自动、报警占位调用注释，P8-2 接线 |

- 默认 `TimeoutTime = T#3s`，默认角度容差 `0.5`；超时必须是正整数毫秒，容差必须为非负有限数。
- 每个文件头含机型、机型版本、`inputHash`（输入 JSON 的 SHA-256 前 12 位）与生成器版本 `v1.0.0`；正文不含时间戳，连续生成逐字节一致。
- `stats = { files, lines, tags, inputs, outputs, actuators, stations, inputHash, timeoutTimeMs, toleranceDeg }`。

### 验证证据

- `npx tsc --noEmit`：通过。
- `npm test`：**505/505**，其中 `desktop/test/plcgen.test.ts` **35 条**。
- `npm run smoke`：`SMOKE_PLCGEN_OK files=5 tags=32` → `SMOKE_OK`。
- demo 机型（4 工位 / 12 执行机构 / 16 传感器）生成 5 文件、32 个变量；demo 未带安全点位，因此直接跑 P8-1 预检会如实报 `ESTOP_UNDEFINED` / `SAFETY_DOOR_UNDEFINED`，接入安全件后为 0 错误。

## 11. P8-2 实现记录（2026-10-23）

状态：✅ 核心完成（无 UI）。新增 `sequence.ts`、`safety.ts`、`alarms.ts`、`symbols.ts`、`generate.ts`，并扩展 `st.ts` / `types.ts` / `io.ts` / `precheck.ts`。

### 汇总生成

`generateProject({ config, bom? }) → { ok, files, stats, precheck }`：

- 先跑 `precheck`；有 error 时返回 `{ ok:false, errors }`，不生成任何文件。
- 成功时固定输出 11 个文件，顺序为：`src/OB1_Main.st`、`src/DB_IO.st`、`src/FB_Cylinder.st`、`src/FB_Gripper.st`、`src/FB_RotaryAxis.st`、`src/FC_AutoSequence.st`、`src/FC_Alarms.st`、`src/FC_Safety.st`、`io-tags.csv`、`mapping.json`、`README.md`。
- `stats` 追加 `steps`、`sequenceEmpty`、`precheckWarnings`、`sequenceWarnings` 与每个文件的 `hashes`（SHA-256）。
- 同一输入连续生成，11 个文件逐字节一致，`hashes` 逐项相同；正文与 README 均不写时间戳。

### 自动序列 `FC_AutoSequence.st`

`generateSequence(input) → { content, steps, warnings }`，把 `sequence` / `steps` 直译为 `CASE StepNo OF`：

- 支持 `action` / `type` 的 set/reset/wait/expect，以及 `point`、`points`、`setPoints`、`resetPoints`、`waitPoints`、`sets`、`resets`、`waits`、`condition`、`expect`、`value`。
- 条件中的点位转换为 `"DB_IO".<变量名>`，保留 AND/OR/NOT 与括号；`expect=false` 生成 `NOT`。
- 每步缺省超时 `T#5s`，可用 `timeoutMs` 覆盖；超时置 `StepNo := STEP_ERROR`、`SeqTimeout := TRUE`、`ErrorCode := 16#8101` 并写 `AlarmWord := AlarmWord OR ALARM_SEQ_TIMEOUT`。
- `Abort` 上升沿或 `SafeStop` 回到 `STEP_IDLE`（Step0）；最后一步完成后回 Step0。
- 空步序仍输出可编译骨架，并返回 `SEQUENCE_EMPTY` warning（不报错）；无转移条件给 `SEQUENCE_NO_CONDITION` warning。

### 安全 `FC_Safety.st`

`generateSafety(config)`：急停、安全门、光栅按常闭串联（`SafetyHealthy := ch1 AND ch2 ...`）。任一断开置 `SafeStop := TRUE`、`SafetyTriggered := TRUE`，并复位所有输出；仅当安全条件恢复且 `Reset` 出现上升沿时解除锁存。缺失急停或安全门时输出 `(* 未配置急停/安全门 *)` 与失效保护 `SafeStop := TRUE`，不伪造任何输入变量。

### 报警 `FC_Alarms.st`

`generateAlarms(config)`：统一 `AlarmWord` 汇总超时（`16#8101`）、传感器矛盾（`16#8202`）、安全触发（`16#8301`）。同一执行机构按绑定顺序取前两路传感器，同时为 1 时置 `SensorConflict`；`FirstFault` 按 超时 → 传感器矛盾 → 安全触发 的优先级锁存首故障，`Reset` 上升沿清空。

### 映射与接线

- `mapping.json` 顶层含 `schemaVersion`、`inputHash`、机型、IO 计数；`points[]` 串起位号（`ref`）、源点位、分配地址、变量名、注释、工位与引用步序；`sequence[]` 保留每步动作、条件与超时。
- `OB1_Main.st` 已从占位改为实际调用 `FC_AutoSequence` / `FC_Alarms` / `FC_Safety`；安全块最后执行，确保 `SafeStop` 在同扫描周期复位输出。
- `safety.reset` 若配置为实际点位，会作为输入进入变量表；未配置时由 HMI 的 `Reset` 形参驱动。

### 验证证据

- `npx tsc --noEmit`：通过。
- `npm test`：**556/556**，其中新增 `desktop/test/plcgen-p82.test.ts` **32 条**（序列转移/超时/中止、安全串联与锁存、报警首故障、空步序、确定性、文件顺序、预检拦截）。
- `npm run smoke`：`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2` → `SMOKE_OK`。
- P8-2 边界：仍不生成 zip / UI / 厂商专用工程；模拟器联调自检留给 P8-4。

## 12. P8-3 实现记录（2026-10-23）

状态：✅ 完成。新增 `desktop/src/plcgen/ui.ts`、`plcgen.css`、`view-model.ts`、`export.ts`、`history.ts`，共享 `desktop/src/shared/filename.ts`、`desktop/src/shared/zip.ts`，并把面板接到电气域顶栏与 Electron IPC。

### 面板与交互

- 入口：电气域顶栏「PLC 程序」。面板为全屏覆盖层，沿用底板画布「电气域可见 / 关闭其他抽屉」的范式。
- 顶部：机型名称、机型编号、`工位数 / 执行机构 / 点位数`；目标平台（通用 ST / S7-1200 / S7-1500 / CODESYS）与命名前缀（默认机型编号）。
- 预检：错误/警告分级列表，带 issue code、消息、配置路径；能解析 `actuators[i]` 或问题中的点位，点击后高亮并滚动到对应执行机构。
- 生成：`generateProject` 同步执行；有 error 时按钮禁用，warning 不拦截。文件树展示路径、行数、UTF-8 字节数；点文件在右侧等宽预览前 200 行，明确标注截断与总行数。
- 底部：`N 个文件 · 变量 N · 步序 N · 生成 N ms`；「导出 zip」「复制全部」「打开导出目录」。
- 历史：`<userData>/plc-gen-history.json`，最近 10 次；按 `inputHash` 去重并采用最新一条，记录时间、inputHash、目标、命名前缀、文件数、文件清单。点击历史记录回看文件清单（历史不保存正文）。

### 目标平台与命名前缀

- `GenerateProjectInput` 新增可选 `target` 与 `namePrefix`。两者只写入 `README.md`（目标平台/命名前缀），并参与导出命名；不进入 ST 正文。
- 为保证确定性，`generateProject` 在计算 `inputHash` 与调用 `generateSt/sequence/safety/alarms` 前剥离这两个展示字段；同一配置切换目标平台时，除 README 外 10 个文件逐字节一致、SHA-256 相同。

### 导出 zip

- 使用已有依赖 `adm-zip`（`desktop/src/shared/zip.ts`），集中在 `createZip` 写 CRC 与中央目录；`normalizeZipPath` 拒绝绝对路径、盘符、控制字符、`.`/`..`。
- 落盘目录：`<userData>/exports/plc/<机型>-<yyyyMMdd-HHmm>/`，同名追加 `-2`、`-3`；机型净化与时间戳统一来自 `src/shared/filename.ts`（成本导出也改用同一实现）。
- 目录内直接写 11 个文件，并额外生成 `<目录名>.zip`；IPC 返回 `path / zipPath / bytes / files`，UI 提示落盘路径。
- 「打开导出目录」只允许 `userData/exports/plc` 及其子目录，主进程用 `shell.openPath` 打开。

### 历史与持久化

- `history.ts` 为纯函数：`normalizeHistoryEntry`、`parsePlcHistory`、`mergePlcHistory`、`createHistoryEntry`；同 `inputHash` 去重、保持新→旧、上限 10。
- 主进程 IPC：`plcgen:history`、`plcgen:recordHistory`、`plcgen:export`、`plcgen:openExportDir`；渲染层无 fs 权限。无桌面桥时 UI 退化为 `localStorage` 会话历史。

### 验证证据

- `npx tsc --noEmit`：通过。
- `npm test`：**577/577**，新增 `desktop/test/plcgen-p83.test.ts` **21 条**：纯 JS SHA-256、文件树、200 行截断、UTF-8 字节、按钮禁用、问题定位、复制包、历史去重/上限/解析顺序、目录命名/冲突、ZIP 条目与 CRC + `unzip -t`、路径穿越、目标平台不影响 ST、预检拦截。
- `npm run smoke`：新增 `SMOKE_PLCGEN_UI_OK files=11 history=1`（无机型配置时输出 `SMOKE_PLCGEN_UI_SKIP no_machine_config`）；导出目录与 zip 均经 `existsSync` 断言，zip 另用 `unzip -t` 人工复核通过。
- P8-3 边界：仍不生成厂商专用工程文件；模拟器加载生成程序跑联调序列留给 P8-4。
