# 模块：机械校核（src/mech/）

职责：对当前 CAD 模型做**包围盒级干涉初筛**，并提供气缸、悬臂梁、螺栓三类常用手算。全部计算是纯函数，不依赖 DOM / Electron，可直接跑 Node 单测。

## 文件分工

| 文件 | 作用 |
|------|------|
| `interference.ts` | AABB 两两相交、重叠量/中心/近似体积、severity、ignoredPairs |
| `stress.ts` | `cylinderForce` / `cantileverDeflection` / `boltPreload` |
| `ui.ts` | CAD 左侧「受力」页签，输入 150ms 防抖实时计算 |
| `interference-ui.ts` | CAD 右侧「干涉」面板，忽略白名单、点击按名高亮 |

## 数据结构与口径

```ts
interface InterferencePart { name: string; bbox: { min: [number,number,number]; max: [number,number,number] } }
interface InterferenceHit {
  a: string; b: string;
  overlap: [number, number, number];  // mm
  volumeApprox: number;               // mm³，重叠盒体积
  center: [number, number, number];   // mm，三维定位点
  severity: 'error' | 'warning';
}
```

- 任一轴重叠 `<= 0` 即不报；**相切重叠 0 不算干涉**。
- `volumeApprox > 1000` 或任一轴重叠 `> 5mm` → `error`，否则 `warning`。
- 输出按 `volumeApprox` 降序。`ignoredPairs` 的键为两个零件名排序后 `a|b`。
- UI 忽略记录存 `localStorage["automationcad.interference.ignored.v1"]`。

## 受力公式

| 计算 | 公式 | 通过条件 |
|------|------|----------|
| 气缸 | `F推 = p·π·D²/4·η`；`F拉 = 0.85·F推` | `F推 ≥ F负载` |
| 悬臂梁 | `I = wh³/12`；`δ = FL³/(3EI)`；`σ = FL/W`，`W = wh²/6` | `δ ≤ L/500` |
| 螺栓 | 查 `As`；`F0 = 0.7·σy·As` | `F0/F负载 ≥ 1.5` |

单位：长度 mm、力 N、压力/弹性模量 MPa（N/mm²）、应力 MPa。所有结果同时返回 `formula / inputs / outputs / safetyFactor / verdict`。

螺栓表：M4 `As=8.78`、M5 `14.2`、M6 `20.1`、M8 `36.6` mm²；8.8 级 `σy=640 MPa`，10.9 级 `σy=940 MPa`。

## 坑点

1. **只是包围盒初筛**：斜置零件、凹形零件会产生误报，报告里必须标注「包围盒级」。
2. **相切不是干涉**：`intersection <= 0` 必须跳过，否则贴合面会刷满 warning。
3. 气缸拉力按需求固定取 `0.85·F推`，与 `η` 是两个独立折减，修改公式时别合并。
4. 受力函数遇到 0/负值、非法螺栓规格/等级一律抛**中文错误**，UI 显示错误而不是保留旧结果。
5. 高亮按 `name` 匹配；同名 mesh 会一起高亮，导入时应尽量保留唯一零件名。

## 进度

- ✅ AABB 干涉、忽略对、排序、severity（6 条单测）
- ✅ 三类受力公式与边界（7 条单测）
- ✅ 左侧受力页签、右侧干涉面板、按名高亮、localStorage 白名单
- ⏳ 三角面/B-rep 精检、间隙检测、梁截面库、螺栓滑移/分离双安全系数
