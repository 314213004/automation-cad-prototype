# 模块：PLC 代码生成（src/plcgen/）

职责：在电气设计定稿后做生成前预检，并产出 IO 变量表、IEC 61131-3 ST 基础块、自动序列/报警/安全 FC 与映射表。P8-2 仍无 UI、无文件落盘，全部为可单测纯函数。

## 文件

| 文件 | 职责 |
|---|---|
| `precheck.ts` | `precheck(config, bom?)`：地址重复/越界、点位多机构占用、传感器绑定、安全件、步序点位、双线圈、BOM 点数容量；全量返回 `errors/warnings` |
| `tags.ts` | `buildTags(config)`：I/Q 顺序分配、32 字符变量名、UTF-8 BOM CSV |
| `st.ts` | `generateSt(input)`：五个 ST 文件 + `stats`，`inputHash` 取输入 JSON SHA-256 前 12 位 |
| `sequence.ts` | `generateSequence(input)`：联调步序 → `FC_AutoSequence.st` 的 CASE 状态机，含动作、AND/OR 条件、步超时与 Abort/SafeStop 复位 |
| `safety.ts` | `generateSafety(config)`：`FC_Safety.st`，急停/安全门/光栅常闭串联、SafeStop 锁存、Reset 上升沿解除、输出复位 |
| `alarms.ts` | `generateAlarms(config)`：`FC_Alarms.st`，超时/传感器矛盾/安全触发汇总到 `AlarmWord`，`FirstFault` 首故障锁存 |
| `generate.ts` | `generateProject(input)`：预检拦截 + 固定 11 文件顺序 + `mapping.json` / `README.md` / 每文件 SHA-256 |
| `symbols.ts` | 点位 / 地址 / 变量名 ↔ `"DB_IO".<变量>` 的稳定映射 |
| `io.ts` | `X0/Y0` 与 `I0.0/Q0.0` 地址归一化、IO 收集与命名辅助 |
| `types.ts` | 安全点位、步序、BOM、变量表与生成结果类型 |

## 关键约定

1. **预检不短停**：每条规则独立执行，最后一次性返回全部错误。
2. **地址口径**：I/Q 各 256 点；`X0` 等价 `I0.0`、`Y0` 等价 `Q0.0`；变量表不沿用源地址，而是按稳定自然序重新从 `I0.0/Q0.0` 顺序分配。
3. **确定性**：文件正文无时间戳，排序、换行、变量名后缀全部固定；输入 JSON 一致则输出逐字节一致。
4. **安全优先**：安全点位豁免“传感器未绑定机构”，但急停/安全门缺失仍为错误；BOM 未提供时不校验容量。
5. **汇总不短路**：`generateProject` 先跑完整预检；有 error 时只返回 `{ ok:false, errors }`，不产生半套文件。
6. **安全最后执行**：`OB1_Main` 调用顺序为序列 → 报警 → 安全，确保 `SafeStop` 同周期复位输出。
7. **无伪造点位**：安全点位缺失时只生成 `(* 未配置急停/安全门 *)` 与失效保护，不编造变量名。

## 进度与验证

- ✅ P8-1：预检 + 变量表 + `FB_Cylinder` / `FB_Gripper` / `FB_RotaryAxis` / `DB_IO` / `OB1_Main`
- ✅ P8-2：`FC_AutoSequence` / `FC_Alarms` / `FC_Safety` + `mapping.json` + 11 文件汇总与逐文件 SHA-256
- ✅ 67 条 plcgen 单测（P8-1 35 + P8-2 32）；全套 556/556；`SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`
- ⏳ P8-3：生成 UI + zip 导出 + 历史记录；P8-4：模拟器联调自检

## 待办

1. P8-3 导出 zip、`io-tags.tia.xml` 与生成 UI，补预检结果定位。
2. P8-4 用内置模拟器加载生成程序并跑通联调序列。
3. 按真实 PLC 模块样本扩充 BOM 点数解析规则（当前支持显式字段与 `16DI/16DO`、`N 点` 文本）。
