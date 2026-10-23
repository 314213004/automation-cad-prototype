# 自然语言设计机器（二）：应用到工程与 3D/BOM/PLC 联动

状态：已完成（2026-10-23）。用户可以用一句中文描述机型需求，由纯函数解析并合成一份可确认的 `MachineConfig` 方案；确认后通过 `apply_machine_design` 写入工程，并联动刷新 3D 联调视图、BOM 草稿与可选 PLC 点位映射。

## 1. 能力边界

- **几何仍是配置驱动**：输出是 `MachineConfig`（stations / actuators / sensors / point 映射），可直接喂给 `createScene3D`，但不会生成真实三维结构，也不会从 STEP 反推机构。
- **功率是估算表**：气缸 5 VA、夹爪 15 VA、旋转轴 200 VA、伺服 750 VA、传感器 3 VA、安全光栅 20 VA。它是选型前的粗略容量参考，不是实测有功功率、启动电流或断路器选型结论。
- **节拍是估算**：单工位动作时间 = 工艺固定余量 + 机构动作时间之和；未计入上下料、通讯、人工干预、调试损失与真实加减速曲线。
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
  stations: number,            // 1–12，默认 1
  cyclePerMin: number | null,  // 件/分钟；也接受 秒/件、CT
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
  cycle: { perMin, secondsPerPiece, bottleneck },
  power: { va, byGroup: { name, va }[] },
  bomDraft: { items: { kind, name, qty, note? }[] },
  warnings: string[],
  assumptions: string[]
}
```

合成规则：

- 工位均分机构与传感器；每个工位至少 1 个动作、至少 1 个到位检测。显式数量不足时补齐对应工位并写入 warning。
- 未给执行机构/传感器清单时，按工艺基线补全：锁螺丝为旋转轴 + 夹爪、接近 + 压力；装配为气缸 + 夹爪、双接近；点胶为旋转轴、压力；检测为旋转轴、光电 + 安全光栅；包装为气缸 + 夹爪、光电 + 接近。
- 点位按 `ST{工位}-{EXT|RET|GRIP|ROT|PRX|PHT|SAFE|PRS}-{A|S}{序号}` 生成，全部唯一。
- `secondsPerPiece = 60 / perMin`；单工位估算时间超过目标节拍时，warning 给出所需并行工位数 `ceil(单工位时间 / 节拍)`，并按「每道工序并行数 × 工位数」给出总工位建议。
- 功率按固定表求和；检测到伺服/步进时，旋转轴按 750 VA/轴计入「伺服」组，不重复计 200 VA 旋转轴。
- BOM 草案按执行机构、传感器、电气分组；型号一律标「待定」，不编造品牌型号。
- 缺工艺/工位/节拍只记 warning，不阻断；每条缺省都在 `warnings` 里点名缺省值，并在 `assumptions` 说明假设。

## 4. Agent 工具 `design_machine`（只读）

只读工具，不需要二次确认；加入写工具 `apply_machine_design` 后，工具总数为 20（只读 10 + 写 10）。

```json
{
  "brief": "设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服",
  "stationCount": 3,
  "cyclePerMin": 20
}
```

`brief` 必填；`stationCount` 为 1–12 的整数；`cyclePerMin` 必须大于 0。返回：

```ts
{ ok: true, design: { config, cycle, power, bomDraft, warnings, assumptions }, summary }
```

`summary` 为中文摘要，≤600 字，包含工位、执行机构、传感器、节拍、功率与风险。空 brief、超范围工位数、非正节拍返回 `INVALID_ARGUMENT`，不抛未捕获异常。

示例（标准输入）输出 `3` 工位、`6` 执行机构、`6` 传感器、`20` 件/分钟、约 `2313` VA，并给出 1 条节拍瓶颈 warning：工位动作约 3.18 秒/件，超过 3.00 秒/件，建议每道工序至少 2 个并行工位。

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

## 6. 验证

- 单元测试：`desktop/test/machine/spec.test.mjs`、`synth.test.mjs`、`desktop/test/agent/design-machine.test.mjs`、`apply-machine-design.test.mjs`（26 条），覆盖 brief/design 二选一、校验失败、id 重复、点位缺失、overwrite、active 指针、3D/BOM/PLC 联动、路径净化、确认拒绝、撤销恢复。
- 全量测试：`npm test` 1110/1110。
- 冒烟：`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1` 与 `SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=6 undo=1`。
- 离线评测：`npm run eval:agent` 68/68，意图 / 工具 / 参数 / 拒绝均为 1.00（新增 3 条机型落盘用例）。

## 7. 后续

- 第三轮：工艺模板、追问策略与真实模型评测。
- 当前模板与节拍参数是显式常量，后续可抽成可配置模板库；新增模板必须同步假设文案与测试。
