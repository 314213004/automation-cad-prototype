# 数据包插件格式（元器件按需加载）

程序把元器件数据做成**可插拔的数据包**：装软件时只带内置包，其余由用户导入，运行时按需加载，不把数据库写死在代码里。

## 1. 包结构

```
<pack-id>/
├── manifest.json      # 必填
├── parts.json         # 必填，ComponentPart[]
└── assets/            # 可选：<id>.stp / <id>.glb / 缩略图
```

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "id": "iec-cn",
  "name": "电气元件库（常用）",
  "vendor": "多家",
  "version": "1.0.0",
  "license": "选型参考，以厂商样本为准",
  "description": "断路器/接触器/PLC/传感器等"
}
```

`parts.json` 单项：

```json
{
  "id": "LC1D18M7C",
  "model": "LC1D18M7C",
  "category": "接触器",
  "vendor": "施耐德",
  "symbol": "km1",
  "specs": { "额定电流": "18 A（AC-3）", "线圈电压": "220 V AC" },
  "dims": { "w": 45, "h": 77, "d": 86, "source": "施耐德 LC1D 系列样本 官方" },
  "railMount": true,
  "asset": "assets/LC1D18M7C.stp",
  "thumbnail": "assets/LC1D18M7C.png",
  "price": 168
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 包内唯一，建议用型号 |
| `model` | ✅ | 展示型号（**不是文件名**） |
| `category` | ✅ | 分类，如 断路器/接触器/PLC/传感器 |
| `vendor` | ⬜ | 厂商 |
| `symbol` | ⬜ | 原理图符号键（见下表），缺省表示「暂无符号」，只能查看/选型不能放图 |
| `specs` | ⬜ | 键值参数，值只能是字符串或数字 |
| `dims` | ⬜ | 本体外形 `{w,h,d}`，单位 mm；三项必须为有限正数 |
| `dims.source` | 补录必填 | 官方文档写 `"<厂商> <文档名/型号> 官方"`；推定写 `"同系列推定：<参照型号>"` |
| `dims.estimated` | 推定必填 | 仅推定条目写 `true`，不得用于官方明确尺寸 |
| `railMount` | ⬜ | 是否 35 mm DIN 导轨安装，布尔值 |
| `moduleWidth` | ⬜ | 模数宽（mm）；导轨件应为 9 mm 的整数倍，面板开孔件按既有约定可存开孔直径 |
| `asset` | ⬜ | 3D 模型相对路径（STEP/GLB） |
| `thumbnail` | ⬜ | 缩略图相对路径 |
| `price` | ⬜ | 数字，仅用于估算（仓库内置包不写价格） |

尺寸只允许两种来源：厂商样本/PDS 的明确数值，或**同系列同壳架**的官方尺寸推定。推定必须在 `dims.source` 写参照型号并设 `dims.estimated: true`；不得跨厂商借尺寸，查不到就留空。

## 2. 原理图符号键（当前 12 个）

| 键 | 含义 | 典型元件 |
|----|------|----------|
| `qf1` | 断路器 | MCB / MCCB |
| `km1` | 接触器线圈 | 接触器 |
| `km1c` | 接触器触点 | 辅助触点 |
| `fr1` | 热继电器 | 过载保护 |
| `ka1` | 中间继电器 | 继电器 |
| `sb1` | 按钮/急停 | 按钮 |
| `a1` | PLC/模块 | PLC、IO 模块 |
| `m1` | 电机 | 电机、变频器、伺服 |
| `yv1` / `yv2` | 电磁阀 | 气动阀 |
| `x1` | 端子 | 端子排 |

未列出的类别（指示灯、开关电源、传感器）当前无符号，`symbol` 留空。

## 3. 加载策略（按需）

- **启动不扫全量**：主进程只读 manifest，不解析 `parts.json`；
- 进入「电气」域或打开「电气元件」面板时，才调用 `packs.listParts({ category, q })`；
- 搜索结果在渲染层缓存 30s，切换分类不重复 IPC；
- 禁用包即时从结果中剔除（`packs-state.json` 的 `disabled`）；
- 数据包很多时（>20 个）只加载启用的包，内置包与用户包同权。

## 4. 导入与安全

- ZIP 导入前校验每个 entry 路径，拒绝 `../`、绝对路径、盘符；
- `id` 必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/`，且与目录名一致；
- 与内置包 id 冲突时拒绝导入（内置优先）；
- 坏包只标记 `error`，不影响其他包加载。

## 5. 新增一个包的最小步骤

1. `mkdir -p packs/builtin/my-pack && cd packs/builtin/my-pack`
2. 写 `manifest.json`（`id: "my-pack"`）
3. 写 `parts.json`（数组，至少 1 项）
4. 重启应用 → 「数据包」面板应显示该包与条目数
5. `node desktop/scripts/gen-reference.mjs`（可选）生成 `docs/reference/` 下的人读表格
