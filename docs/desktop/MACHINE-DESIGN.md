# 自然语言设计机器（三）：工艺模板 + 追问策略 + 真实模型评测

状态：已完成（2026-10-24）。用户可以用一句中文描述机型需求，由纯函数解析并合成一份可确认的 `MachineConfig` 方案；缺执行机构描述时按五类工艺模板补全；信息不足时最多追问一次；确认后通过 `apply_machine_design` 写入工程，并联动刷新 3D 联调视图、BOM 草稿与可选 PLC 点位映射。迭代 34 起，方案会再经纯函数 `generateMachineGeometry` 生成**带真实毫米尺寸的参数化整机几何**（机架、工位底板、门架、气缸、夹爪、旋转台、传感器、安全光栅、输送线/分度转盘），3D 联调视图直接渲染它，并落盘 STL / glTF / sidecar 实体列表（见第 6 节）。

## 1. 能力边界

- **几何是「按规则摆放的标准件外形」，不是结构设计**：`generateMachineGeometry` 由 `MachineConfig` 生成真实 mm 尺寸与位置的装配（典型值：台面 850 mm、缸径 Ø32、M12 接近开关、50 方门架型材），运动件带轴向/行程/点位；但**不做**强度/刚度/挠度校核、零件间干涉求解、型号选型，不生成紧固件、钣金、气路/线缆、电柜，也不建模工位与输送线/转盘之间的上下料机构；输送线驱动与转盘分度没有接入点位。仍不会从 STEP 反推机构。
- **STEP 只能经 build123d sidecar 产出**：离线时只有 TS 三角网格（STL / glTF，圆柱为多边形近似）；sidecar 只有 box / 竖直 cylinder 与绕 Z 旋转，水平圆柱（接近开关、压力传感器、输送线电机）实体化时按**等截面积方棒近似**，并在 `approximated` 中逐个列出。
- **功率是估算表**：气缸 5 VA、夹爪 15 VA、旋转轴 200 VA、伺服 750 VA、传感器 3 VA、安全光栅 20 VA。它是选型前的粗略容量参考，不是实测有功功率、启动电流或断路器选型结论。
- **节拍是估算**：单工位动作时间 = 工艺固定余量 + 机构动作时间之和，再交给 `evaluateFlow` 按 `single / linear / dial / parallel / cell` 五种布局之一求值；均未计入上下料、通讯、人工干预、调试损失与真实加减速曲线。公式与边界见 3.1。
- **不做安全决策**：不提安全等级、不替代风险评估；安全光栅数量只按需求记录。
- **只读与写分离**：`design_machine` 只返回方案与摘要；`apply_machine_design` 才写文件、改 active 指针与联动视图，且必须经过用户确认、可用 `undo_last` 撤销。

## 2. 需求抽取 `desktop/src/machine/spec.ts`

```ts
parseMachineBrief(text: string): MachineBrief
```

返回字段：

```ts
{
  process: 'screw' | 'dispense' | 'assembly' | 'inspection' | 'packaging' | 'unknown',
  stations: number,            // 1–12，默认 2
  cyclePerMin: number | null,  // 件/分钟；也接受 秒/件、CT
  layout: 'single' | 'linear' | 'dial' | 'parallel' | 'cell' | 'line' | 'auto', // line 为 linear 兼容别名
  processes?: string[],        // 显式列出的工序名，如 ['上料','锁螺丝','检测','下料']
  actuators: { kind: 'cylinder' | 'gripper' | 'rotary'; count: number }[],
  sensors: { kind: 'proximity' | 'photoelectric' | 'safety' | 'pressure'; count: number }[],
  brand: string | null,
  voltage: '220VAC' | '380VAC' | '24VDC' | null,
  notes: string[]
}
```

可测规则：

- 工位：`三工位` / `四工位` / `六工位` / `12 工位`，支持中文数字与「两」；超过 12 截到 12 并记 note。
- 节拍：`分钟 20 件`、`20 件/分钟`、`3 秒一件`、`2 秒/件`、`CT 4.5s`、`节拍 6 秒`。
- 布局：出现「转盘 / 分度」→ `dial`；「单元式」→ `cell`；「并行 / 复制式」→ `parallel`；「流水线 / 线体 / 产线」或两个及以上不同工序 → `linear`；单一工艺 → `parallel`；工艺未知且多工位时兜底 `parallel` 并写 warning，提示可显式指定 `layout`。`processes` 按出现顺序记录识别到的工序名。
- 工艺：锁螺丝/锁付、点胶、装配/压装、检测/视觉、包装。
- 执行机构：气缸、夹爪/气爪、旋转轴/旋转台；`伺服`/`步进`带数量时按 `rotary` 建模，仅给 `750W 伺服` 这类驱动规格时写入 notes，不把 750 当数量。
- 传感器：接近、光电、安全光栅、压力。
- 品牌：汇川、台达、西门子、正泰、欧姆龙、施耐德、三菱、松下、基恩士、倍福、安川、罗克韦尔、ABB。
- 供电：220VAC / 380VAC / 24VDC。
- 缺省：工艺未知、工位数缺失、节拍缺失都会写 `notes` 缺省标记，不抛错。

## 3. 方案合成 `desktop/src/machine/synth.ts`

```ts
synthMachine(brief: MachineBrief, options?: {
  stationCount?: number;  // 1–12，覆盖 brief
  cyclePerMin?: number;   // >0，覆盖 brief
  name?: string;
  id?: string;
}): MachineDesign
```

返回：

```ts
{
  config: MachineConfig,
  points: string[],       // ST1-EXT-A1 / ST1-RET-A1 / ST1-GRIP-A2 / ST1-ROT-A1 / ST1-PRX-S1 ...
  cycle: { mode, perMin, secondsPerPiece, stationSeconds, throughputPerMin,
           estimatedSecondsPerPiece, baseSeconds, slowestStation, slowestActionSeconds,
           requiredParallelStations, requiredTotalStations, meetsTarget, bottleneck },
  power: { va, byGroup: { name, va }[] },
  bomDraft: { items: { kind, name, qty, note? }[] },
  warnings: string[],
  assumptions: string[],
  form: { id, name, rationale, layout, geometry, score, alternatives, warning? }
}
```

合成规则：

- 工位均分机构与传感器；每个工位至少 1 个动作、至少 1 个到位检测。显式数量不足时补齐对应工位并写入 warning。
- 未给执行机构/传感器清单时，按 `templates.ts` 的工艺模板补全；assumptions 明确写「按 X 模板补全」。模板是纯数据，测试可直接读取 `TEMPLATES`。
- 缺工位时按模板默认 2 工位生成；缺节拍时按 10 件/分钟估算。两者都会同时写 warning 与 assumption。
- 点位按 `ST{工位}-{EXT|RET|GRIP|ROT|PRX|PHT|SAFE|PRS}-{A|S}{序号}` 生成，全部唯一。
- `synthMachine` 先调用 `pickForm` 选整机形态，再用形态的 `layout` 与 `indexSeconds` / `transferSeconds` 构造 `FlowModel`；`form` 随方案返回并用于几何与落盘。
- `secondsPerPiece = 60 / perMin`；`stationSeconds` = 工艺固定余量 + 该工位动作时间。所有布局统一由 `evaluateFlow` 求 `cycleSeconds`、`throughputPerMin`、`requiredStations` 与瓶颈；`MachineCycleEstimate.mode` 直接使用 `MachineLayout`（`single / linear / dial / parallel / cell`），旧字段保留。`parallel` 的 warning 以「并行同工序」开头，`linear` 以「流水线节拍瓶颈」开头，其余布局使用各自的 `mode` 标签。
- 功率按固定表求和；检测到伺服/步进时，旋转轴按 750 VA/轴计入「伺服」组，不重复计 200 VA 旋转轴。
- BOM 草案按执行机构、传感器、电气分组；型号一律标「待定」，不编造品牌型号。
- 缺工艺/工位/节拍只记 warning，不阻断；每条缺省都在 `warnings` 里点名缺省值，并在 `assumptions` 说明假设。

### 3.1 通用产能模型 `desktop/src/machine/flow.ts`

产能不再写死在 `synthMachine` 里。`synthMachine` 只把 brief 的布局、工位组成与工艺模板映射成 `FlowModel`，统一调用纯函数：

```ts
evaluateFlow(model: FlowModel): FlowEvaluation

interface FlowModel {
  layout: 'single' | 'linear' | 'dial' | 'parallel' | 'cell';
  stations: number;
  copies?: number;           // parallel 副本数；缺省 = stations
  ops: FlowOp[];
  transferSeconds?: number;  // linear/cell 工位间转移，缺省 0
  indexSeconds?: number;     // dial 分度，缺省 0.6
  targetPerMin?: number;
}

interface FlowOp {
  id: string;
  name: string;
  seconds: number;           // 单件在该工序的作业时间
  station: number;           // 工位/单元组索引（0-based）
  optional?: boolean;        // 可选工序不计入关键路径，但计入成本
}
```

五种布局的公式：

| 布局 | `stationSeconds` | `cycleSeconds`（单件节拍） | 产能 | 达标所需工位/副本 |
|---|---|---|---|---|
| `single` | 全部工序求和，单元素数组 | `sum(ops.seconds)` | `60 / cycle` | 达标为 1；不可达为 `Infinity`（单工位无法靠加工位降节拍） |
| `linear` | `stationSeconds[i] = sum(第 i 站工序) + transferSeconds` | `max(stationSeconds)` | `60 / cycle` | `stations × ceil(max(工序和) / (目标节拍 - transfer))` |
| `dial` | `stationSeconds[i] = sum(第 i 站工序)`，不含分度 | `max(stationSeconds) + indexSeconds` | `60 / cycle` | `stations × ceil(max(stationSeconds) / (目标节拍 - index))` |
| `parallel` | 一套完整工序的时间和（各副本相同） | `stationSeconds / copies` | `copies × 60 / stationSeconds` | `ceil(stationSeconds / 目标节拍)` |
| `cell` | `stationSeconds[s] = sum(station=s 的工序)`，同一 `station` 为一组 | `max(stationSeconds) + transferSeconds` | `60 / cycle` | `stations × ceil(max(组时间) / (目标节拍 - transfer))` |

- `targetPerMin` 缺省时 `meetsTarget=null`、`requiredStations=0`；提供了目标才反解所需工位数并向上取整。
- `optional` 工序不进入关键路径与瓶颈，但仍保留在 `ops` 中计入成本；只有可选工序时关键路径按 0 秒处理并写 note。
- `notes` 记录所有默认值：`linear/cell` 的 `transferSeconds=0`、`dial` 的 `indexSeconds=0.6`、`parallel` 的 `copies=stations`，以及可选工序被排除等。
- 非法输入直接抛中文错误：工位不是正整数、`ops` 为空、工序时间 ≤ 0、工位索引越界、目标节拍/转移/分度时间非法。

布局选择 `chooseLayout(process, stations)` 与几何层共用 `dial` 工艺集合与工位上限（锁螺丝/装配、≤8 工位）；1 工位为 `single`，明确同工序复制时传 `sameProcess` 得到 `parallel`，其余为 `linear`。`cell` 只在显式指定时使用。解析器识别「转盘/分度」「单元式」「并行/复制式」等关键词；`layout:'auto'` 仍可解析，推断结论写入 `assumptions`。

边界：这是**静态产能估算**，不包含故障、换型、人工节拍、缓存区、上下料波动与真实加减速曲线；`transferSeconds` / `indexSeconds` 是固定分摊，不是运动仿真。仍不能替代节拍分析或现场测量。

### 3.2 整机形态库 `desktop/src/machine/forms.ts`

同一工艺可以落在不同机架上。`pickForm(brief, templates, options?)` 使用固定的硬约束顺序：

1. **工位覆盖**：`stationRange` 必须覆盖需求工位数；不覆盖的形态不能作为正常候选。
2. **产能达标**：`evaluateFlow(...).meetsTarget === true` 优先于一切软偏好；只要存在覆盖且达标的形态，就绝不会选中不达标形态。
3. **工艺适配**：`suits` 包含需求工艺。
4. **布局偏好**：只做 tie-breaker，不参与候选过滤；需求倾向 `parallel` 时，同分优先 `parallel`。
5. **占地与推荐工位**：`footprintScale` 小者优先，再按 `|defaultStations - 需求工位|` 小者。

若没有任何形态同时覆盖工位且达标，先取「达标且工位最近」的形态；仍不达标则取「工位最近」的形态。此时 `warning` 必须写清「需要 X 件/分钟，最佳形态 Y 只能给 Z 件/分钟，差 W」，并另写非标工位回退说明。**不把未达标硬标成达标，也不允许有达标形态时选不达标形态。**

```ts
pickForm(brief, templates, { stationCount?, cyclePerMin? }): {
  form: MachineForm;
  score: number;
  alternatives: { form, score, difference }[]; // 固定 2 条，差异含占地/成本/换型
  warning?: string;
  evaluation: FlowEvaluation;
  stations: number;
}
```

| 形态 id | 名称 | 布局 | `stationRange` | `defaultStations` | `maxStations` | 适配工艺 | 占地系数 | 几何 |
|---|---|---|---:|---:|---:|---|---:|---|
| `dial-6` | 六工位转盘机 | `dial` | 2–6 | 6 | 6 | 锁螺丝 / 点胶 / 装配 / 包装 | 0.78 | `dial` |
| `dial-8` | 八工位转盘机 | `dial` | 6–8 | 8 | 8 | 检测 / 锁螺丝 / 装配 / 点胶 / 包装 | 0.95 | `dial` |
| `linear-4` | 四工位直线机 | `linear` | 2–4 | 4 | 4 | 五类工艺 | 1.00 | `linear` |
| `linear-8` | 八工位直线线体 | `linear` | 5–8 | 8 | 8 | 装配 / 检测 / 包装 / 锁螺丝 / 点胶 | 1.55 | `linear` |
| `gantry-2` | 双工位龙门机 | `parallel` | 1–2 | 2 | 2 | 点胶 / 锁螺丝 / 装配 / 检测 / 包装 | 0.90 | `gantry` |
| `dual-lane` | 双轨并行线 | `cell` | 4–6 | 6 | 6 | 检测 / 包装 / 装配 / 锁螺丝 / 点胶 | 1.35 | `dual` |

- 形态声明 `minStations / defaultStations / maxStations`，`stationRange` 由最小工位与 `maxStations` 推导，避免区间、推荐值与上限三处各写一份。
- 加载期执行 `assertMachineFormsConsistent()`：任一形态违反 `stationRange[0] <= defaultStations <= stationRange[1]`、`maxStations === stationRange[1]`（或区间倒置）时直接抛错；`validateMachineForms()` 仍负责收集全部可读错误（id 唯一、布局对齐、工艺/几何兼容等）。
- 形态参数进入产能模型：转盘 `indexSeconds`（dial-6 0.6 s、dial-8 0.45 s）、直线/双轨 `transferSeconds`（linear-8 0.8 s、dual-lane 0.6 s）；双轨 `cell` 的 `geometry.lanes=2` 同时进入 `FlowModel.lanes`，节拍 = `(最慢工位 + transferSeconds) / lanes`。
- 几何层优先使用 `form.geometry.kind`：`dial` / `linear` / `gantry` / `dual` 分别生成转盘、直线输送、龙门机架、双轨两排工位；1 工位仍回退单工位几何。
- 落盘 `machine/<id>.json` 同时写 `form.id`、`form.geometry` 与两条备选，之后可复现同一形态。

边界：形态只在典型范围与静态节拍上选型，不包含占地 CAD 校核、换型时间、报价与真实结构干涉；warning 是提醒换型/扩产，不是自动改图。

## 4. Agent 工具 `design_machine`（只读）

只读工具，不需要二次确认；加入写工具 `apply_machine_design` 后，工具总数为 21（只读 11 + 写 10）。

```json
{
  "brief": "设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服",
  "stationCount": 3,
  "cyclePerMin": 20
}
```

`brief` 必填；`stationCount` 为 1–12 的整数；`cyclePerMin` 必须大于 0。返回：

```ts
{ ok: true, design: { config, cycle, power, bomDraft, warnings, assumptions, form }, summary, geometry, needs: [], question: null }
```

`summary` 为中文摘要，≤600 字，包含工位、执行机构、传感器、节拍、功率与风险。`needs` / `question` 来自 `buildClarify(brief)`，供会话层决定是否先追问；完整需求返回空数组与 `null`。空 brief、超范围工位数、非正节拍返回 `INVALID_ARGUMENT`，不抛未捕获异常。

示例（标准输入）输出 `3` 工位、`6` 执行机构、`3` 传感器、目标 `20` 件/分钟、约 `2304` VA。覆盖 3 工位的形态均不达标时，按 fallback 取达标且工位最近的 `gantry-2`（支持 1–2 工位），按 `parallel` 模型估算 3 工位并发生能为 `56.60` 件/分钟，`meetsTarget=true`，同时输出「该形态支持 1–2 工位，需求 3 工位」的非标 warning。BOM 草案 5 行（旋转轴、夹爪、接近开关、伺服驱动器、电气控制）。

### 4.1 工艺模板 `desktop/src/machine/templates.ts`

| 工艺 | 缺省工位 | 每工位执行机构 | 每工位传感器 | 参考节拍（件/分钟） | 依据 |
|---|---:|---|---|---:|---|
| `screw` 锁螺丝 | 2 | 1 旋转轴 + 1 夹爪 | 1 接近开关 | 12–30 | 旋转轴拧紧、夹爪固定、接近确认到位 |
| `dispense` 点胶 | 2 | 1 旋转轴（三轴模组占位） | 1 压力传感器 | 10–24 | 三轴模组按旋转轴表达，压力确认胶路 |
| `assembly` 装配 | 2 | 1 压装气缸 + 1 夹爪 | 2 接近开关 | 8–20 | 双接近分别确认压装前后位置 |
| `inspection` 检测 | 2 | 1 旋转轴（相机位占位） | 1 光电 + 1 安全光栅 | 20–60 | 光电触发拍照，光栅隔离人工区 |
| `packaging` 包装 | 2 | 1 推料气缸 + 1 吸盘（夹爪） | 1 光电 | 12–30 | 推料入盒、吸盘取放、光电确认物料 |

未知工艺使用内部 `GENERIC_TEMPLATE`（每工位 1 气缸 + 1 接近开关），不计入导出的 5 类 `TEMPLATES`。模板的 `cycleRange` 只作参考，不硬性拦截用户目标节拍。

### 4.2 追问策略 `desktop/src/machine/clarify.ts`

```ts
buildClarify(brief: MachineBrief): { needs: ('process'|'stations'|'cycle')[]; question: string | null }
```

- 只看会显著改变方案的 3 项：工艺类型、工位数、节拍；执行机构/传感器缺失由模板补全，不追问。
- 最多返回 2 项 `needs`；多项合并成一个 `question`，由会话层只追问一次。
- 有默认值就不追问：例如「锁螺丝机」直接识别工艺；「两工位」「20 件/分钟」直接采用。
- 问题具体且带默认值：如「这台机器做几个工位？默认按 2 工位生成。」「目标节拍是多少（件/分钟）？默认按 10 件/分钟生成。」
- 用户不回答或明确要求按默认继续时，使用 `synthMachine` 的默认结果继续，并在 `assumptions` 中说明缺省项；同一方案不重复追问。

## 5. Agent 工具 `apply_machine_design`（写）

需要用户确认，成功后进入撤销栈；`undo_last` 恢复上一个 active 配置。入参二选一：

```json
{
  "brief": "设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服",
  "design": { "config": {}, "cycle": {}, "power": {}, "bomDraft": {} },
  "name": "三工位锁螺丝机",
  "overwrite": false,
  "withBom": true,
  "withPlc": false
}
```

- `brief`：内部先跑 `parseMachineBrief` + `synthMachine`，再进入同一套校验。
- `design`：直接使用上一轮 `design_machine` 返回的完整方案，避免重复合成。
- `name`：可选，覆盖 `config.name`；`overwrite` 默认 `false`，同名文件存在返回 `FILE_EXISTS`。
- `withBom` 默认 `true`；`withPlc` 默认 `false`。

校验顺序：`validateMachineConfig` → 工位 / 执行机构 / 传感器 id 唯一 → 传感器 `part` 引用存在 → `design.points` 与配置点位一致。任一失败返回 `INVALID_ARGUMENT`，不写任何文件。

返回：

```ts
{
  ok: true,
  machineId, name,
  stations, actuators, sensors,
  warnings: string[],
  activePath, designPath,
  bomPath?, bom?: { count, added, source: 'machine-design' },
  plcPath?, plc?: { points },
  sceneRefreshed
}
```

### 5.1 文件布局

```
<userData>/machine/
  active.json                  # 当前工程指向：machineId / name / file / appliedAt
  <machineId>.json             # 完整方案：config + points + cycle + power + bomDraft + warnings
  <machineId>/bom-draft.csv    # withBom=true 时写出的 BOM 草稿
<userData>/exports/plc/<machineId>/io-map.csv   # withPlc=true 时写出的点位映射
```

`machineId` 来自 `config.id`，落盘前净化：路径分隔符、控制字符、连续点与 Windows 保留名都会被替换；任何 `../` 或绝对路径都不能逃出 `machine/`。同名文件只有在 `overwrite=true` 时才覆盖，撤销时会恢复旧文件内容。

### 5.2 3D / BOM / PLC 联动

- **3D**：渲染层 `applyMachineConfig` 调用联调面板的 `setMachineConfig`，销毁旧 `createScene3D` 实例并用新 `MachineConfig` 重建。启动时 `machine:active` 读取 active 指针恢复上次方案；没有指针时保持内置 4 工位样机。
- **BOM**：`bomDraft.items` 转为 BOM 行，`kind` 映射为「执行机构 / 传感器 / 电气」，缺少型号统一写「模型待定」，来源标记 `machine-design`；行追加到当前 BOM 草稿并写 `bom-draft.csv`。
- **PLC**：`withPlc=true` 时复用 `plcgen/io.ts` 的点位收集与 `plcgen/tags.ts` 的地址分配，只输出 `io-map.csv`（点位 / 地址 / 方向 / 归属 / 类型 / 工位 / 说明），不生成完整 ST、序列或报警程序。

### 5.3 侧栏方案卡

`design_machine` 工具结果在侧栏渲染「机型方案卡」：工位数、执行机构、传感器、节拍、功率、全部 warnings（黄色条，不折叠）与「应用到工程」按钮。按钮走计划确认；确认后执行 `apply_machine_design`，3D 视图切到新机型，并在卡片和反馈区显示「已应用：<名称>」。

### 5.4 参数化几何落盘

新增开关（工具数仍为 20）：`withGeometry`（默认 `true`）写 `machine/<id>/geometry.json`、`model.stl`（二进制，mm，Z 向上）、`model.gltf`（glTF 2.0，内嵌缓冲，extras 带零件与运动轴）、`sidecar-assembly.json`（≤50 实体/块的 `AssemblyDoc`），结果返回 `geometry` 摘要与路径；`withSolids`（默认 `false`）仅在 build123d 内核已就绪时逐块 `POST /build`（不隐式拉起 Python），全部成功才写 `solids/part-N.step`，否则整体回退 TS 网格并写 warning。几何文件进入撤销快照（base64）。`design_machine` 额外返回只读 `geometry` 摘要。

## 6. 参数化整机几何 `desktop/src/machine/geometry*.ts`

`generateMachineGeometry(config | design, { process?, layout? })`：纯函数、确定性；Z 向上、mm，X 为物料流向，-Y 为操作侧。典型值集中在 `GEOMETRY_DIMENSIONS`。

- 布局：1 工位 `single`；锁螺丝/装配 2–8 工位 `dial`（分度器 + 转盘，工位 -Y 朝向圆心，半径逐步加大到相邻占地不重叠再留 30 mm）；其余 `linear`（工位间距 60 mm，操作侧输送线 + 电机）。工艺缺省从 `config.id` 推断。
- 机架：台面 20 mm、顶面 850 mm；60 方立腿 830 mm，跨距 >1200 mm 加中腿；4 根下横梁。
- 工位：底板 深 300 × 厚 15，宽 = 槽位之和（气缸 110 / 夹爪 130 / 旋转台 170）+ 100，最小 320；门架横梁高度按最长气缸反算，保证伸出不撞治具。
- 气缸：竖直下压，缸体 Ø40×(行程+70) + 活塞杆 Ø12 + 压头，缩回位露杆 25；轴 `linear` [0,0,-1]，`strokeMm = travelMm`。夹爪：本体 64×40×56 + 双指，张开位，轴 `gripper` 每指半行程。旋转台：底座 Ø110 + 台面 Ø140 + 偏心治具，轴 `rotary` 绕 Z 0→90°。
- 传感器：接近 M12、光电、压力靠近所测执行机构；安全光栅为两根 35×35×600 立柱，共用材质一起亮灭。
- 输出：`parts[]`（唯一 `[a-z0-9-]` id、形状、中心、绕 Z 角、材质、`bomGroup`、归属、`moving`）、`moving[]`（`axis / pivot / strokeMm / rangeDeg / home / points / jaws`）、`stations[]`（含旋转矩形 `footprint`，`footprintsOverlap` 用分离轴判定）、`envelope / bounds`、`structureBom`（结构件，与 `bomDraft` 分开）。`geometryComponentCounts` 与 `bomDraft` 逐项对账。
- 导出：`geometry-export.ts` 网格 → STL / glTF；`geometryToSidecarAssemblies` 盒体 → `box`，竖直圆柱 → 内接种子方块 + `cylinder`（精确），水平圆柱 → 等截面方棒（列入 `approximated`）；`buildMachineSolids` 逐块实体化、任一块失败整体回退。
- 渲染：`geometry-three.ts` 与导出共用网格；`createScene3D` 不再画占位方块，`stats()` 增加 `geometryParts / envelopeMm / layout`，`parts` 口径与标注驱动优先级不变。

## 7. 验证

- 几何（迭代 34）：`test/machine/geometry.test.mjs`（10）、`geometry-export.test.mjs`（6）、`geometry-three.test.mjs`（3）、`test/agent/apply-machine-geometry.test.mjs`（5），覆盖尺寸、id 唯一、1–12 工位 × 6 工艺占地不重叠、运动轴、BOM 对账、STL/glTF/sidecar、动画、落盘/撤销/回退。当前冒烟 `SMOKE_MACHINE_GEOMETRY_OK layout=gantry parts=57 axes=6 envelope=1610x420x1625 chunks=2 scene=57`。
- 产能引擎：`test/machine/flow.test.mjs` 覆盖五种布局公式、默认值、可选工序、目标反解与非法输入；`test/machine/flow-archetypes.test.mjs` 覆盖六工位同工序并行、转盘点胶 dial、五工位直线 linear、单工位检测 single、2×2 单元 cell、2 副本并行点胶；`test/machine/cycle-mode.test.mjs` 与 `flow-synth.test.mjs` 覆盖布局推断、auto 推断与 synth 对接。六工位案例为 `form=dual-lane`、`mode=cell`、`stationSeconds=3.18`、`lanes=2`、`throughputPerMin=31.75`、`meetsTarget=true`（20 件/分钟目标下余量 1.59 倍）。
- 单元测试：`desktop/test/machine/spec.test.mjs`、`synth.test.mjs`、`cycle-mode.test.mjs`、`templates.test.mjs`、`clarify.test.mjs`、`desktop/test/agent/design-machine.test.mjs`、`apply-machine-design.test.mjs`，覆盖模板数量/字段/回填、追问上限与默认值、brief/design 二选一、校验失败、id 重复、点位缺失、overwrite、active 指针、3D/BOM/PLC 联动、路径净化、确认拒绝、撤销恢复。
- 全量测试：`TZ=Asia/Shanghai npm test` **1316/1316**（基线 1297，新增 19）。
- 冒烟：`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=3 warnings=1 form=gantry-2`、`SMOKE_MACHINE_CYCLE_OK mode=cell throughput=32 meets=1`、`SMOKE_MACHINE_FORMS_OK forms=6 picked=dual-lane meets=1`、`SMOKE_FLOW_ENGINE_OK modes=5 archetypes=6`、`SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`、`SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=5 undo=1`，最终 `SMOKE_OK`。
- 离线评测：`npm run eval:agent` 102/102，意图 / 工具 / 参数 / 拒绝均为 1.00。

### 7.1 真实模型评测（2026-10-24）

`desktop/scripts/agent-live-cases.json` 新增 `machine` 分组 6 条，总计 **36 条**（原 30 + 6）；阈值不变：`toolAccuracy ≥ 0.85`、`refusalRate = 1.00`。本机 LiteLLM bridge / `deepseek-v4.1-flash` 实测 **36/36**，`confirm=1.00`、`clarify=1.00`、`refusal=1.00`，p50 **7.9 s** / p95 **31.3 s**；最终轮失败项 0。

| 分组 | 用例 | 通过 | 准确率 | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| 查询 | 8 | 8 | 100.0% | 6.6 s | 10.4 s |
| 操作 | 10 | 10 | 100.0% | 6.8 s | 21.8 s |
| 流程 | 6 | 6 | 100.0% | 11.8 s | 20.4 s |
| 拒绝/澄清 | 6 | 6 | 100.0% | 6.5 s | 12.9 s |
| 机型 | 6 | 6 | 100.0% | 23.9 s | 37.8 s |
| **合计** | **36** | **36** | **100%** | **7.9 s** | **31.3 s** |

机型 6 条断言：

1. 三工位锁螺丝、20 件/分钟 → `design_machine`，brief 同时含「三工位/锁螺丝/20」，或 `stationCount=3` 且 `cyclePerMin=20`。
2. 点胶两工位、3 秒/件 → `design_machine`，brief 同时含「点胶/两工位/3 秒」，或 `stationCount=2` 且 `cyclePerMin=20`。
3. 装配四工位、汇川伺服、安全光栅 → `design_machine`，brief 同时含「装配/四工位（或四个工位）/汇川/安全光栅」，或 brief 含装配且 `stationCount=4`。
4. 随便设计检测机 → 允许先追问一次，也允许直接按默认生成；两种路径均通过。
5. 多轮「改成 4 工位」→ 前置一轮三工位锁螺丝方案；只评判本轮调用，要求 brief 同时含「4 工位/锁螺丝」或 brief 含锁螺丝且 `stationCount=4`。
6. 「直接应用到工程」→ `apply_machine_design` 且必须出现确认请求，不接受「直接」绕过确认。

结果文件：`docs/desktop/eval/agent-live.json`。最终轮无失败项；两轮复跑中的首轮曾出现 1 条 `O04 [operation/missing-arg]`（既有改型号用例的 `update_component` 参数形状未命中断言），第二轮 36/36。该失败未通过删除用例或降低阈值处理，最终结果文件保留可复现的工具序列与参数断言。

## 8. 后续

- 几何：sidecar 加水平圆柱/通用旋转算子后可去掉方棒近似；转盘分度与输送线驱动接入点位后可进联调动画；上下料机构、气路/线缆、电柜与紧固件尚未建模；xvfb 下 WebGL 被 blocklist，冒烟只验证场景构建与零件数，真实 GPU 渲染需在 Windows 实机目测。
- 模板目前是代码内常量，后续可抽成用户可编辑的模板库；新增模板必须同步 `TEMPLATES`、默认参数、假设文案与测试。
- 追问目前由工具返回 `needs/question`、会话层按提示最多追问一次；若要跨轮 durable 状态，可把未答项的默认值写入 thread 指纹。
- 真实评测仍是单模型、单轮为主（机型含 2 个多轮前置场景）；换模型或换措辞应重跑 `npm run agent:live`，不要把 36/36 当通用结论。
