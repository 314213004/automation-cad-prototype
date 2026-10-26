# 模块：整机布局 3D 编辑（src/layout-editor/）

职责：在 3D 视口里直接编辑整机布局（工位的位置与绕 Z 旋转），结果写回**同一份**设计主数据。
入口：整机设计向导第 4 步「当前 3D 几何俯视」区的「3D 布局编辑」按钮（模块 `design.layout-editor`，默认启用）。
不是 `src/canvas/` 的节点拓扑画布，也不是 `src/orbit/` 的原型滑台气缸示例装配。

## 主数据与写回路径（唯一来源）

```
DesignDraft.design : MachineDesign            ← 向导草稿（userData/design-draft.json，DraftPersistence 自动保存）
  └─ stationGeometryLayout                    ← 主数据：按稳定工位身份 stationIdentity 保存的刚体位姿
       schemaVersion 2：{ stationIdentity, stationName, xMm, yMm }           （纯平移，旧版本可读）
       schemaVersion 3：{ …, rotationZDeg }  （至少一个工位有非零旋转时才写 v3；全部归零自动降回 v2）

派生几何（任何地方都不另存位姿）：
  generatedGeometryForDesign(design)          规则引擎原始摆放（machine/geometry.ts）
  → applyStationGeometryLayout(…, layout, identities)   先绕「原始工位原点」转 rotationZDeg，再平移 (xMm, yMm)
  = geometryForDesign(design)                 向导俯视 / 3D 预览 / 保存工程 STL+design.json / Agent apply_machine_design 同一路径
```

编辑器 → `writeStationPoses(design, poses)`（内部 `withStationGeometryPoses`）→ 宿主 `commit(next, label)` →
向导 `applyLayoutDesign`（重算占地/几何假设、`review = null`）→ `layoutHistory.record` → `markDraftChanged` 持久化。
保存工程时 `design.json` / `project.json` / STL 走既有保存流程，自然带上位姿（`validateMachineDesign` 已接受 v3）。

**可编辑粒度 = 工位（stN 组）**。零件、执行机构在主数据里没有独立位姿（由规则引擎按工位生成），
所以零件可点选查看属性，移动/旋转作用于其所属工位；机架/输送等无工位零件只读。Z 平移、绕 X/Y 旋转没有主数据字段，不提供。

## 文件分工

| 文件 | 作用 | Node 单测 |
|---|---|---|
| `model.ts` | 编辑模型（工位单元/零件信息/台面包络）、选择逻辑、属性面板、多选整体变换、写回、撤销快照、联动校验 `runLayoutChecks`、松手后精检 | ✅ |
| `drag.ts` | 一次拖动的纯计算：锁轴 → 特征/网格吸附 → 角度吸附 → 多选刚体跟随；数值输入落点；对齐增量转位姿 | ✅ |
| `snap.ts` | 网格（1/5/10/50 mm，作用于主数据偏移值）、角度（15°/90°）、包络边/中线特征吸附 + 参考线 | ✅ |
| `align.ts` | 左/中/右/底/中/顶对齐、等距分布（≥3）、线性阵列排布（按选择顺序 N×间距） | ✅ |
| `collision.ts` | OBB 包络碰撞（XY 分离轴 + Z 区间，扫掠粗筛）、基线去重；截面多边形求交精检 | ✅ |
| `numeric.ts` | 拖动中键入：`150` = 相对位移/转角，`=150` = 绝对值，平面 `150,-20`；HUD 文案 | ✅ |
| `measure.ts` | 两点距离；两平行面沿法向面距；包络间隙 | ✅ |
| `view.ts` | three 视口（mm、Z 向上）、TransformControls（平移只露 X/Y/XY，旋转只露 Z）、拾取、框选投影、高亮/标红、参考线、测量标记 | ❌ WebGL |
| `ui.ts` | 覆盖层：工具条、属性面板、校验列表、键盘（数值输入/Esc/W/E/M/X/Y/R/Ctrl+A）、`window.AutomationCadLayoutEditor` 调试入口 | ❌ DOM |

## 交互

- 选择：点选；Ctrl/⌘ 切换多选；Shift 拖拽框选；「工位/零件」切换点选粒度；Ctrl+A 全选工位；Esc 依次取消拖动 → 退出测量 → 清空选择 → 关闭。
- gizmo：「移动」只有 X、Y 箭头与 XY 平面；「旋转 Z」只有 Z 环。拖动中 HUD 实时显示 Δ 与绝对值；直接键入数字回车确认、Esc 还原。
  未拖动时按 X / Y / R 再输入数值回车，等价于沿该轴精确移动/旋转。属性面板也可直接输入 X/Y/RZ（同字段 800 ms 内连续输入合并为一步撤销）。
- 吸附：特征吸附优先于网格；容差约 8 px 换算成 mm。几何里没有安装孔/端口（`MountPort` 只在 canvas 拓扑里），因此不做孔位吸附。
- 对齐/分布/阵列：作用于选中工位的 XY 包络，整批作为一个撤销步。
- 测量：「测量」模式下点两次；两面平行给面距，否则给点距与 ΔX/ΔY/ΔZ。只读，不写主数据。

## 碰撞与联动校验

- 拖动中：对候选位姿派生几何做 OBB 包络检测（只查被拖工位相关的对），重叠零件标红、画交集框，HUD 显示件数。
- 松手后 `runLayoutChecks`：包络干涉（相对规则引擎原始摆放只报**新增**对）、运动包络扫掠冲突（`design/motion-envelope.ts`，同样去基线、只报跨工位）、
  工位底板超出机架台面、占地评估（`assessMachineFootprint`）。列表点击定位到对应工位。
- 「精检干涉体积」：对包络命中的每一对做 XY 截面多边形求交 × Z 重叠——盒-盒精确，竖直圆柱 32 边形近似，水平圆柱只给上界。
  这是概念占位体原始形体的解析求交，**不是** build123d B-rep 布尔运算（sidecar 目前没有布尔求交接口）。
- BOM / 配置 / 成本不随位姿变化（单测断言）。`review.ts` 的签名包含 `stationGeometryLayout`，位姿一变第 5 步「一键校核」即过期，需要重新运行。

## 撤销 / 重做

并入 `src/orbit/history.ts` 的 `UnifiedHistory`（与原型、主视口 3D 编辑同一条令牌时间线），新增令牌 `'layout'`：
条目存编辑前后的 `LayoutSnapshot`（`configId + formId + stationIdentities + layout`）。Ctrl+Z / 状态栏按钮由 `orbit/ui.ts` 的捕获监听分派，
`'layout'` 交给向导注册的 applier（`applyLayoutSnapshot` 校验方案与身份一致后写回主数据并持久化）。换候选方案/放弃草稿时 `layoutHistory.clear()`；
快照与当前方案不符时 applier 返回 false，整段布局历史作废，不按名称或序号猜测。向导里原有的 X/Y 输入与俯视拖动也记入同一时间线。
注意：时间线是线性的——布局编辑器打开时按 Ctrl+Z，若栈顶是原型/主视口动作，撤销的是那一步。

## 边界与未做

- 复制工位 / 真阵列（新增工位）需要改机型配置（工位、执行机构、点位、BOM），不属于位姿编辑；「阵列」只重排已存在的工位。
- 已保存工程（工程库重开）显示的是冻结 STL，不经向导主数据；在那里没有 3D 布局编辑（需新 IPC 写 `design.json` 并重生成 STL）。
- `commission/scene3d.ts`（通电联调 3D）仍用未应用位姿的原始几何，属既有缺口。
- 运动件预览（行程动画）未接入编辑器；运动包络只做静态扫掠检查。
- DOM 交互没有 Node 单测（仓库无 jsdom）；验证脚本见 HANDOFF（离屏 Electron + 真实鼠标/键盘事件）。
