# 自然语言设计机器（一）：方案合成器与 `design_machine`

状态：已完成（2026-10-23）。用户可以用一句中文描述机型需求，由纯函数解析并合成一份可确认的 `MachineConfig` 方案；本轮只读，不写文件、不改当前工程。

## 1. 能力边界

- **几何仍是配置驱动**：输出是 `MachineConfig`（stations / actuators / sensors / point 映射），可直接喂给 `createScene3D`，但不会生成真实三维结构，也不会从 STEP 反推机构。
- **功率是估算表**：气缸 5 VA、夹爪 15 VA、旋转轴 200 VA、伺服 750 VA、传感器 3 VA、安全光栅 20 VA。它是选型前的粗略容量参考，不是实测有功功率、启动电流或断路器选型结论。
- **节拍是估算**：单工位动作时间 = 工艺固定余量 + 机构动作时间之和；未计入上下料、通讯、人工干预、调试损失与真实加减速曲线。
- **不做安全决策**：不提安全等级、不替代风险评估；安全光栅数量只按需求记录。
- **不落盘**：`design_machine` 只返回方案与摘要。写入工程、生成 BOM/PLC 映射留给后续写工具。

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

## 4. Agent 工具 `design_machine`

只读工具，不需要二次确认；工具数从 18 增至 19（只读 10 + 写 9）。

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

## 5. 验证

- 单元测试：`desktop/test/machine/spec.test.mjs`、`synth.test.mjs`、`desktop/test/agent/design-machine.test.mjs`，覆盖中文数字、三种节拍写法、品牌、缺省 warning、工位均分、点位唯一、瓶颈、功率求和、BOM、schema、越界与摘要。
- 全量测试：`npm test` 1084/1084。
- 冒烟：`SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1`。
- 离线评测：`npm run eval:agent` 65/65，意图 / 工具 / 参数 / 拒绝均为 1.00（新增 4 条机型设计用例）。

## 6. 后续

- 第二轮：写工具 `apply_machine_design`，把方案写入 `userData/machine/` 并接入 3D/BOM/PLC 映射。
- 第三轮：工艺模板、追问策略与真实模型评测。
- 当前模板与节拍参数是显式常量，后续可抽成可配置模板库；新增模板必须同步假设文案与测试。
