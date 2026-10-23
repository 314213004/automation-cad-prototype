# 2D 草图约束 spike（P9-4 前置验证）

日期：2026-10-23
状态：调研与可行性验证完成；**本轮不接入产品代码**
相关：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md) · [spike/sketch/](../../spike/sketch/)

## 1. 结论

- **推荐** `@salusoft89/planegcs@1.3.0`（FreeCAD PlaneGCS 的 Emscripten/WASM 构建）作为 P9-4 的 2D 约束求解器。
- **不推荐** `xibyte/jsketcher` 作为依赖：许可要求修改回授给 Autodrop3d（或购买商业许可），且没有可用的 npm 包，入口绑定浏览器应用。
- **不需要自研**：矩形 + 水平/竖直 + 宽 120 / 高 80 的约束系统已实测收敛，最大绝对残差为 0，自由度 0。
- 前置门禁：planegcs 为 **LGPL-2.1**，发布进 Electron 安装包前需法务确认分发方式（保留版权与许可、提供库源码/可替换方式、不静态并入闭源主体）。
- 与 build123d 的衔接已验证：求解顶点 → `Polyline(..., close=True)` → `make_face()` → `extrude()`，120×80×8 得到体积 76,800 mm³、包围盒 120×80×8、6 面 / 12 边 / 1 实体。

## 2. 候选调研

数据为 2026-10-23 通过 `gh api repos/<owner>/<repo>`、README、LICENSE、package.json 取证；stars 为该日快照。

| 项目 | stars | 许可 | main 最近提交 | WASM | 尺寸约束 | 分发形态 |
|------|------:|------|---------------|------|----------|----------|
| `xibyte/jsketcher` | 1,747 | 自定义（GitHub `NOASSERTION`） | 2023-10-30（`c1905c4`） | 2D solver 纯 JS；3D 建模用 OCCT WASM | 支持：线长、点到线距离、半径、角度、尺寸变量 | 无 npm 包（`jsketcher` 2024-04-12 已下架）；仓库是浏览器应用 |
| `Salusoft89/planegcs` | 109 | LGPL-2.1（LICENSE；package.json 写 `LGPL-2.0-or-later`） | 2026-10-05（`9d26bae`，v1.3.0） | 是，Emscripten，浏览器与 Node 均可 | 支持：`p2p_distance`、`p2p_angle`、`circle_radius`、`equal` 等 | npm `@salusoft89/planegcs@1.3.0` |

补充事实：

- jsketcher README 明确写「parametric 2D and 3D CAD modeler written in pure javascript」，但 3D 布尔依赖 OpenCascade WASM；2D solver 在 `web/app/sketcher/constr/solver.js`，无 DOM 依赖。
- jsketcher 的 GitHub `pushed_at` 为 2026-04-16，但 `main` 分支最近提交停在 2023-10-30，可能是其他分支活动；选型按 main 判断。
- jsketcher LICENSE 要求：对软件的任何修改必须以不可撤销的版权转让提交给 Autodrop3d；未购买商业许可且未回授修改将失去全部授权。这对内部二次开发是实质性限制。
- planegcs README 明确「port of the C++ code to WebAssembly, so that it can be used in the browser or node environments」，并列出完整 TypeScript 类型与全部 planegcs 约束。
- 选型不以 stars 为主：jsketcher 更成熟，但许可与分发形态不适合直接依赖；planegcs 直接移植 FreeCAD 的 planegcs，2026-10 仍在更新，npm 包、WASM 与 TypeScript 类型完整。
- 一次性 headless 探针中，用 esbuild 手工打包 jsketcher 内部 solver 模块后，同一矩形也能求解；说明算法本身可在 Node 跑，但需要抽取内部模块、绕过浏览器应用入口，维护成本高，因此不作为候选。

## 3. planegcs 实测

### 3.1 环境

- Node `v26.7.0`，Linux x86_64
- `@salusoft89/planegcs@1.3.0`
- 计时用 `node:perf_hooks`，结果文件名 `spike/sketch/result.json`

### 3.2 输入

矩形 `p1-p2-p3-p4`，四条边 `l1-l4`；`p1` 固定在原点，其余点给一个明显错误的初值，强迫求解器工作：

```text
p1 (0, 0) 固定
p2 (117, 3)
p3 (123.5, 77)
p4 (-2, 82.5)
```

约束共 6 条：4 条定向约束保证仍是矩形，2 条尺寸约束是需求中的宽/高：

| id | 约束 |
|----|------|
| c1 | horizontal(p1, p2) |
| c2 | vertical(p1, p4) |
| c3 | vertical(p2, p3) |
| c4 | horizontal(p4, p3) |
| c5 | p2p_distance(p1, p2) = 120 |
| c6 | p2p_distance(p2, p3) = 80 |

说明：需求写「水平、宽=120、高=80」，其中「水平」是定向约束；要让四个点仍构成矩形，另外三条边也需要水平/竖直关系，否则高度约束只保证 p3 在 p2 的半径 80 圆上，不保证右上角。

### 3.3 输出

`status = Success`，`dof = 0`，最终顶点：

```text
p1 (0, 0)
p2 (120, 0)
p3 (120, 80)
p4 (0, 80)
```

残差（按最终坐标重新计算，打印精度 1e-9）：

| 约束 | 残差 |
|------|-----:|
| horizontal(p1,p2) | 0 |
| vertical(p1,p4) | 0 |
| vertical(p2,p3) | 0 |
| horizontal(p4,p3) | 0 |
| width = 120 | 0 |
| height = 80 | 0 |

最大绝对残差：**0**。`result.json` 中同时保留 `startVertices`、`vertices`、`residuals` 与计时，便于复核。

### 3.4 体积与耗时

| 指标 | 实测 |
|------|------|
| npm 解包体积 | 865,993 B（846 KiB），54 个文件 |
| `node_modules` 逻辑体积 | 899,193 B（878 KiB），1 个直接依赖 |
| WASM 文件 | 484,003 B（473 KiB） |
| 初始化（加载/实例化 WASM） | 14.9–16.2 ms（空载，5 次运行） |
| 首次求解（含 JIT 预热） | 6.7–7.7 ms（空载，5 次运行） |
| 热路径：新建 wrapper + 重推图元 + 求解 | 中位数 0.28–0.32 ms，P95 0.39–0.52 ms（空载；首轮 P95 3.1 ms 属冷启动抖动，并行跑测试时可升至约 4 ms） |

热路径计时方法：WASM 已编译一次，随后每轮新建 `GcsSystem`/`GcsWrapper`、重推 14 个图元（4 点 + 4 线 + 6 约束）并求解；每次运行 30 轮，取中位数与 P95，共 5 次运行。该数字比「复用同一 wrapper 只改尺寸」更保守，可作为 P9-4 重建耗时的上界参考。Electron 渲染进程中的实际值需在接入后复测。

### 3.5 结论

技术可行性成立：安装增量 < 1 MB，初始化十几毫秒，稳态求解亚毫秒；矩形约束系统收敛且无残差。对 P9-4 的交互拖拽与 300 ms 防抖重建都绰绰有余。

## 4. 与 build123d 的衔接

### 4.1 数据流

```text
渲染进程：草图点/线/约束
  → planegcs 求解
  → 输出有序闭合顶点 [[x,y], ...]
  → 作为 sketch 特征写入特征树
  → compileOps 生成 sidecar 请求
  → Python build123d：Polyline → make_face → extrude
  → 现有 STEP/STL 回传与视口载入链路
```

求解留在 TypeScript/渲染进程（或 Worker），Python 侧只接收「已求解的顶点 + 挤出高度」，不重复实现约束求解。这样 sidecar 契约简单，也避免把 LGPL WASM 再嵌进 Python 包。

### 4.2 build123d 0.13.0 验证

`spike/sketch/check-build123d.py` 用求解结果实际运行：

```python
with BuildPart() as part:
    with BuildSketch(Plane.XY):
        with BuildLine():
            Polyline(*[(x, y) for x, y in vertices], close=True)
        make_face()
    extrude(amount=height)
```

实测输出：

| 指标 | 结果 |
|------|------|
| 顶点 | `(0,0) (120,0) (120,80) (0,80)` |
| 挤出高度 | 8 mm |
| 体积 | 76,800 mm³ |
| 包围盒 | X 0–120，Y 0–80，Z 0–8 |
| 拓扑 | 6 面 / 12 边 / 1 实体 |
| 建模耗时 | 约 9–10 ms（不含 import） |

build123d v0.13.0 的 `Polyline` 源码确认支持 `close=True`，官方文档也给出 `Polyline → make_face → extrude` 的同一写法。结论：**可行，且不需要改现有 sidecar 的建模/导出主干**，只需新增一个草图挤出算子。

### 4.3 边界

- 首期只支持**单外轮廓**；多轮廓（外轮廓 + 内孔）需要约定外环逆时针、内环顺时针，并逐个 `make_face` 后做布尔差。
- 顶点顺序、闭合性和自交必须在 TS 侧先校验，不能把无效轮廓送进 OCCT。
- 单位固定 mm；草图平面首期固定 `Plane.XY`，后续再扩展基准面。
- 圆弧/样条暂不进入首期约束模型，先做点/线/矩形。

## 5. P9-4 分期建议

前置门禁：法务确认 LGPL-2.1 在 Electron 安装包中的分发方式；未确认前不进入第 2 期打包。

| 期 | 内容 | 验收 |
|----|------|------|
| 1. 约束模型 | 纯 TS：`SketchPoint` / `SketchLine` / `Constraint` 类型、id 唯一性、尺寸正数、闭合轮廓、序列化/反序列化；不碰 DOM 与 IPC | 矩形文档 JSON 往返一致；非法尺寸/重复 id/不闭合轮廓有中文错误；单测覆盖 |
| 2. 求解器接入 | 封装 planegcs：图元编译、`solve/apply_solution`、残差与 `dof`、冲突/冗余约束映射；放进 Web Worker，WASM 按 Vite `?url` 打包 | 120×80 矩形残差 < 1e-6；热求解 < 10 ms；超约束返回可读中文原因；主线程不卡顿 |
| 3. 交互 | 草图画布：点/线/矩形工具、拖拽、水平/竖直/尺寸约束工具、欠约束/过约束提示、撤销重做 | 拖拽时求解稳定；欠/过约束状态可见；约束删除后几何保持合理 |
| 4. 与特征树合并 | 新增 `sketch` 特征（保存求解后的顶点快照 + 高度）；`compileOps` 输出草图挤出算子；sidecar 实现；持久化与重建 | 特征树保存/载入后重建一致；挤出体积/包围盒与 build123d 断言一致；STEP/STL 导出不回归 |

第 1、2 期可先做无 UI 的纯函数与 Worker 验证；第 3 期才引入画布交互；第 4 期才改产品特征树。这样每期都能独立验收，不会把约束求解风险扩散到现有 P9-1～P9-5 链路。

## 6. 风险与边界

- **许可**：LGPL-2.1 是推荐方案的主要非技术风险；需法务确认动态加载、源码提供与可替换性。若不可接受，备选是自研小型牛顿/最小二乘求解器，但工作量和鲁棒性成本显著更高。
- **WASM 打包**：Vite 下需显式 `?url` 定位 `.wasm`；Electron `file://` 与 asar 路径要在 P9-4 第 2 期实测。
- **数值退化**：重合点、零长度线、初值离解太远会导致不收敛；必须在 TS 侧做前置校验，并把 `Failed`/冲突约束转成中文提示，不能静默返回旧坐标。
- **范围**：本轮只验证 2D 点/线/矩形与尺寸约束；不涉及 3D 装配配合、圆弧/样条、约束传播到特征历史。
- **本轮不接入产品代码**：`desktop/src/`、`index.html`、`app.js`、`styles.css` 均未改动，`npm test` / `npm run smoke` 不受影响。

## 7. 复现

### 7.1 求解与计时

```bash
cd spike/sketch
npm install
npm run solve
# 或保存结果：
node solve-planegcs.mjs > result.json
```

期望：`statusName = "Success"`、`dof = 0`、顶点 `(0,0) (120,0) (120,80) (0,80)`、6 条残差均为 0。

### 7.2 build123d 衔接

```bash
cd spike/sketch
python3 -m venv .venv
.venv/bin/pip install build123d==0.13.0
.venv/bin/python check-build123d.py
```

期望：体积 76,800 mm³、包围盒 120×80×8、6 面 / 12 边 / 1 实体。venv 约 1.0 GB，仅用于本 spike，已被 `.gitignore` 忽略。

### 7.3 产品回归

```bash
cd desktop
npm test        # 687/687
npm run smoke   # SMOKE_OK；未设 AUTOMATIONCAD_PARAMETRIC_CMD 时参数化相关断言 SKIP
```

## 8. 本轮文件

| 文件 | 说明 |
|------|------|
| `spike/sketch/package.json` | 隔离的 spike 依赖，不进入桌面端构建 |
| `spike/sketch/package-lock.json` | 锁定 `@salusoft89/planegcs@1.3.0` |
| `spike/sketch/solve-planegcs.mjs` | 矩形约束求解、残差与 30 轮热路径计时 |
| `spike/sketch/result.json` | 本次实测输出快照 |
| `spike/sketch/check-build123d.py` | 顶点 → Polyline → extrude 验证 |
| `spike/sketch/README.md` | spike 目录说明与复现命令 |

产品代码零改动；`git status` 只应有 `spike/`、`docs/` 与根目录文档索引 `README.md`。
