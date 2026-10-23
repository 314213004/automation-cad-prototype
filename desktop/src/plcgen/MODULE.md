# 模块：PLC 代码生成（src/plcgen/）

职责：在电气设计定稿后做生成前预检，并产出 IO 变量表与 IEC 61131-3 ST 基础块。P8-1 无 UI、无文件落盘，全部为可单测纯函数。

## 文件

| 文件 | 职责 |
|---|---|
| `precheck.ts` | `precheck(config, bom?)`：地址重复/越界、点位多机构占用、传感器绑定、安全件、步序点位、双线圈、BOM 点数容量；全量返回 `errors/warnings` |
| `tags.ts` | `buildTags(config)`：I/Q 顺序分配、32 字符变量名、UTF-8 BOM CSV |
| `st.ts` | `generateSt(input)`：五个 ST 文件 + `stats`，`inputHash` 取输入 JSON SHA-256 前 12 位 |
| `io.ts` | `X0/Y0` 与 `I0.0/Q0.0` 地址归一化、IO 收集与命名辅助 |
| `types.ts` | 安全点位、步序、BOM、变量表与生成结果类型 |

## 关键约定

1. **预检不短停**：每条规则独立执行，最后一次性返回全部错误。
2. **地址口径**：I/Q 各 256 点；`X0` 等价 `I0.0`、`Y0` 等价 `Q0.0`；变量表不沿用源地址，而是按稳定自然序重新从 `I0.0/Q0.0` 顺序分配。
3. **确定性**：文件正文无时间戳，排序、换行、变量名后缀全部固定；输入 JSON 一致则输出逐字节一致。
4. **安全优先**：安全点位豁免“传感器未绑定机构”，但急停/安全门缺失仍为错误；BOM 未提供时不校验容量。

## 进度与验证

- ✅ P8-1：预检 + 变量表 + `FB_Cylinder` / `FB_Gripper` / `FB_RotaryAxis` / `DB_IO` / `OB1_Main`
- ✅ 35 条单测；全套 505/505；`SMOKE_PLCGEN_OK files=5 tags=32`
- ⏳ P8-2：自动序列、报警、安全 FC；P8-3：生成 UI + zip + 历史记录

## 待办

1. P8-2 接入联调步序，生成 `FC_AutoSequence` / `FC_Alarms` / `FC_Safety` 并从 OB1 实际调用。
2. P8-3 导出 zip、`io-tags.tia.xml` 与 `mapping.json`，补 UI 预检结果定位。
3. 按真实 PLC 模块样本扩充 BOM 点数解析规则（当前支持显式字段与 `16DI/16DO`、`N 点` 文本）。
