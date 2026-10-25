# 无限画布设计工作台（Canvas Workbench）· 落地方案

状态：**方案 + 模板归档，未实现**（2026-10-26）
模板：`docs/desktop/mockups/canvas-workbench.html`（106 KB 单文件原型，Tailwind CDN + three r128，md5 `724fb0c3…`）
来源：架构评审 §9「非标设计能力为什么弱」+ §10「从五步线性向导转向画布式工作台」

---

## 1. 模板已实现的东西（逐段读过，不是只看截图）

| 区域 | 内容 | 交互 |
|------|------|------|
| 顶栏 | 3 个机型预设（龙门贴合 / 转盘组装 / 皮带分拣）、三视图切换、KPI（总成本 / 瓶颈 CT+UPH / 审计计数）、一键生成全部转接板、虚拟调试、导出 | 切预设会克隆整套 nodes/edges |
| 左栏 | 模组库 4 类 8 件（机架、分割器、X/Y 丝杠模组、导杆气缸、旋转电爪、飞拍相机、转接板），每件带 `mountIn/mountOut/stroke/lead/mass/cost/stepDuration/dims/io` | 点击即挂到当前选中节点后面并加边 |
| 中：拓扑 | HTML 节点 + SVG 贝塞尔连线 + 边上的「⚡生成转接板」气泡；拖拽平移、缩放、选中 | 端口不匹配的边标橙色 |
| 中：2D 正交 | canvas 毫米栅格、工位框拖动、中心基准吸附、运动包络虚线框、图例 | 拖动改 `orthoX/orthoY` |
| 中：多画板 | 3 个候选画板并排，指标胶囊（成本/CT/惯量比/干涉）、勾选模组合并成「混合最优方案」 | 勾选 + 合并按钮 |
| 右下 3D | three.js 盒体装配（颜色区分标准件/转接板）、线框、重置视角、放大 | 轨道旋转（自写球坐标） |
| 底部甘特 | 每个动作一条，可拖拽改 `stepDuration`，联动 CT、峰值/RMS 扭矩、惯量比、仿真时刻 | 拖拽 + 播放 |
| 右 Inspector | ①属性+转接板 2D 开孔预览 ②力学选型（梯形速度曲线、J_load、惯量比、T_peak/T_rms、悬臂挠度） ③BOM+PLC IO | 三页签 |
| 导出弹窗 | ① build123d Python 脚本 ② IEC 61131-3 ST ③ Machine Graph JSON | 复制到剪贴板 |

**最有价值的两个点**（也是架构 §9 症结 1/2 的正面回答）：节点-端口（MountPort）拓扑 + 「端口不匹配就合成转接板」这条闭环。

---

## 2. 与现有代码的映射（禁止重复造第二套引擎）

| 模板能力 | 已有模块 | 落地方式 |
|----------|----------|----------|
| 3 个候选方案 | `design/synthesis.ts`、`machine/synth.ts`、`machine/forms.ts`（11 形态） | 候选来自真实合成器，不写死 3 套 JSON |
| 节点/边/端口 | 无（新） | 新增 `desktop/src/canvas/graph.ts`（纯类型 + 规范化 + 校验） |
| 节拍 / 产能 | `machine/flow.ts` 的 `evaluateFlow`（single/linear/dial/parallel/cell） | **CT 必须走 FlowModel**，不能用模板的 Σstep |
| 惯量 / 扭矩 / 挠度 | `mech/`（目前只有气缸推力、悬臂挠度、螺栓预紧） | 补 `mech/servo-sizing.ts`：梯形曲线 → v_max/α → J_load → 惯量比 → T_peak/T_rms |
| 干涉 | `mech/interference.ts`（AABB 初筛） | 保留 AABB 初筛 + 明确「B-Rep 精确干涉未实现」，不许显示假的 0 碰撞 |
| 价格 / BOM | `packs/pricebook-cn` + `cost/engine.ts` | 节点只存 `partId`，价格由价格簿按 `partId` 查；缺价进「待询价」且不计总额 |
| 元件型号 | `packs/builtin/*/parts.json` | 模组库按 `category` 从数据包取，禁止硬编码型号/价格 |
| PLC ST | `plcgen/` | 导出复用 `generatePlcSt`，不另写模板 |
| 3D | `cad/viewer.ts` + `orbit/`（three 0.186） | PiP 复用现有 viewer 实例或轻量 scene，不引 three r128 |
| 2D mm 画布 | `enclosure/`（mm 画布、导轨吸附）、`elec/layout.ts`（平移缩放） | 抽公共平移/缩放/吸附，避免第三套坐标实现 |
| 导出弹窗 | `export/`、`sync/` | 只做「预览 + 复制」，落盘仍走既有导出通道（需确认） |

---

## 3. 必须纠正的 5 处模板偏差（照抄会引入新的「假能力」）

1. **CDN 依赖**：`cdn.tailwindcss.com`、`three@r128`、Google Fonts 全部去掉。桌面端离线运行，样式进 `canvas.css`，three 用仓库已有依赖。
2. **节拍口径**：模板 `totalCT = Σ stepDuration` 是纯串行口径。同一台并行/单元式机器会被算慢，和 `flow.ts` 冲突 → 一律走 `evaluateFlow`，甘特只展示工序时间，不负责产能。
3. **价格与型号**：模板里 `cost: 3450`、`KK86`、`MGPM25-100Z` 是示例值。落地必须 `partId → parts.json → pricebook-cn`，缺价显示「待询价」，总额标注「不完全统计」。
4. **端口是字符串相等**：`isPortCompatible` 只比 `mountOut === mountIn`，转接板节点没有任何孔位参数。落地要结构化端口：`{family, holeDiaMm, pitchXMm, pitchYMm, count}`；转接板按两端端口生成参数（沉头孔/定位销/外形），先产出「生成请求 JSON」，build123d 实际建模仍走 `parametric/` sidecar（内核不可用时明确降级为「仅生成图纸参数」）。
5. **假的 B-Rep 干涉**：模板 `trueBrepCollisions = brepFilterMode ? 0 : rawAabbCollisions` 是演示开关，会误导成「已支持精确干涉」。落地要么真调 OCCT，要么写「AABB 初筛，N 处疑似，需人工确认」。

---

## 4. 数据契约（初稿，实现时以此为准）

```ts
interface MountPort {
  family: 'grid' | 'slider' | 'body' | 'plate' | 'dial' | 'floor' | 'optical' | 'tip';
  holeDiaMm: number;
  pitchXMm: number;
  pitchYMm: number;
  count: number;
}

interface CanvasNode {
  id: string;
  kind: 'frame' | 'indexer' | 'linear' | 'actuator' | 'gripper' | 'vision' | 'adapter';
  partId?: string;            // packs/builtin 里的真实型号；无型号时缺省并在 BOM 标「待选型」
  name: string;
  spec: string;
  portIn: MountPort;
  portOut: MountPort;
  strokeMm: number;
  leadMm: number;
  massKg: number;
  stepSec: number;            // 仅用于甘特与单轴选型，不用于整机产能
  dimsMm: [number, number, number];
  io: { di: number; do: number; desc: string };
  adapter?: boolean;
  pos: { x: number; y: number };        // 拓扑画布
  ortho: { x: number; y: number };      // 2D 平面（mm）
}

interface CanvasEdge { id: string; from: string; to: string; }

interface MachineGraph { schemeId: string; nodes: CanvasNode[]; edges: CanvasEdge[]; }
```

不变量：

- 一条边只有在 `portOut(from)` 与 `portIn(to)` 全字段相等时才算「直连」；否则必须有且仅有一个 `adapter` 节点串在中间。
- 插转接板只允许**拆一条边为两条**，不得移动其它节点坐标（模板会顺手改下游 x，属副作用，落地去掉）。
- 删除节点时孤儿边一并清理；`adapter` 节点被删则两端若不匹配，重新标红。

---

## 5. 分阶段落地

| 阶段 | 内容 | 交付/验收 |
|------|------|-----------|
| **P1 核心逻辑** | `canvas/graph.ts`（类型/规范化/端口兼容/插转接板/删节点）、`canvas/metrics.ts`（CT 走 `evaluateFlow`、单轴伺服选型）、`canvas/export.ts`（build123d 脚本 / ST 复用 plcgen / Graph JSON） | 纯函数单测：不匹配必出转接板、匹配不得插、adapter 后两端均匹配、CT 与 `evaluateFlow` 同 brief 一致、缺价不计总额 |
| **P2 三视图 UI** | `canvas/workbench.ts` + `canvas.css`：拓扑 / 2D 正交 / 多画板 + Inspector 三页签 + 甘特 + 导出预览 | smoke：`SMOKE_CANVAS_TOPOLOGY_OK`、`_ADAPTER_OK`、`_ORTHO_OK`、`_EXPORT_OK`；所有交互元素带 `data-action` |
| **P3 接真实数据** | 候选来自 `design/synthesis`、元件来自 packs、价格来自价格簿、BOM 与成本引擎对齐 | 单台真实机器的 BOM 行回查 `parts.json` 全命中 |
| **P4 3D 联动** | PiP 复用 `cad/viewer.ts`，选中节点聚焦对应零件；运动包络与 `MachineMotion` 对齐 | smoke 断言选中联动；3D 不可用时降级提示 |

五步向导保留（向导负责「先有方案」，画布负责「改方案」），P2 完成后再决定是否把向导降级为「从画布一键生成初始拓扑」。

---

## 6. 验收口径

- 单测只增不减；新增模块必须有自己的 `MODULE.md`（数据结构 / 坑 / 进度）。
- smoke 断言必须在 `SMOKE_OK` 之前打出具体数字，且用 `data-action` 而不是 class。
- 文档同步：本文 + `MODULES.md` 目录表 + `BACKLOG.md` 提交号与实测数字。
- 对外表述：B-Rep 干涉、真实转接板建模、3D 联动未落地前，一律写「规划中 / 仅参数」。
