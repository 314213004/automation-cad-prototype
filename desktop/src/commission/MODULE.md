# 模块：通电联调（src/commission/）

职责：在仿真或真实 PLC 上按固定顺序上电，执行动作/信号检查用例，并输出可归档的联调报告。

## 数据结构

```ts
interface Step {
  id: string;
  name: string;
  precondition?: (values: Record<string, boolean | number>) => string | null;
  action: 'wait' | 'set' | 'expect';
  point?: string;
  value?: boolean | number;
  timeoutMs?: number;
  expect?: boolean | number;
}

interface StepResult {
  stepId: string;
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  at: string;
  durationMs: number;
  message?: string;
}
```

`runSequence()` 顺序执行：`set` 写入并回读；`wait` / `expect` 每 50ms 轮询，默认 3 秒超时；任一步失败立即停止，消息包含阶段、点位、期望值与实际值。

## 标准内容

- 28 点位：15 DI（X0~X14）、9 DO（Y0~Y8）、2 AI、2 AO，编号与内置 IO 规划对应。
- 6 步上电：主回路 → 24V → PLC RUN → 气源 → 回原点 → 就绪。
- 3 条用例：点动、气缸伸出/缩回、急停链路。
- 仿真默认规则：反馈跟随输出、安全门/急停联锁、500ms 就绪定时器、急停锁存。
- 单跑用例时若上电未完成，UI 会先自动执行 6 步上电。

## 报告

`export/report.ts` 新增 `commission` 章节，包含 PLC 类型/状态、上电明细、用例明细、期望/实际与耗时。主进程仍走 `webContents.printToPDF` 的 A3 横向通道。

## 坑点

1. **动作只写线圈/保持寄存器**，传感器输入只读；否则换到真实 PLC 会因写离散输入失败。
2. **上电步骤之间有前置条件**，不能一键跳到最后一步；失败时保留首次失败点。
3. **异步轮询不能用固定 sleep 总时长**，必须按 deadline 判断，避免慢 PLC 把 3 秒拖成更久。
4. **报告里的 expected/actual 是字符串快照**，便于 PDF 直接展示；结构化值仍保留在点位快照中。

## 进度

- ✅ 纯函数序列执行器与失败定位
- ✅ 28 点位、6 步上电、3 条用例、仿真全通过
- ✅ 联调面板、逐步/一键、单跑/全跑、强制写入确认
- ✅ PDF 联调章节与 smoke 断言
- ⏳ 真机 IO 校验与报告签字/归档流程

## 待办

1. 支持用例参数化（不同机型/工位）。
2. 记录操作员与设备序列号。
3. 历史联调报告列表与版本对比。
