# FreeCAD 后台任务 · 第 1 步：零件工程图

> 状态：`feat/freecad-techdraw` 已交付第 1 步与通用 FreeCAD 任务基础设施；钣金展开 DXF、总装图 + BOM 表、FEM 为后续步骤。
> 模块文档：[desktop/src/drawings/MODULE.md](../../desktop/src/drawings/MODULE.md)；主进程：[desktop/electron/MODULE.md](../../desktop/electron/MODULE.md)。

## 已定方案（老王认可）

- build123d sidecar：参数化零件/整机模板/实体化（`spike/build123d/app.py`，`parametric.ts` JSON 协议）。
- AutomationCAD 本体：装配、摆位、运动、BOM、电气、成本。
- FreeCAD 无界面后台任务（`freecadcmd`，独立进程）：TechDraw 工程图 → 之后钣金展开 DXF、FEM。
- 特征树 JSON 是唯一主数据；STEP 只是产物，不在 FreeCAD 里反向编辑；两份 OCCT 不进同一 Python 进程，只用文件中转。
- 主进程把逐件 STEP + 任务 JSON（partId、名称、材料、图号、比例…）交给 FreeCAD；输出写回工程目录按 partId 关联；记录指纹/STEP 哈希，参数一改受影响图纸标过期，可一键/自动重出。
- FreeCAD 是可选组件（LGPL，独立进程调用，不随包分发）；未安装只禁用这些任务。路径可在工程图分区指定，默认探测 Windows 常见安装路径与 PATH。

## 安装与配置（Windows）

1. 安装 FreeCAD 1.0 或更新版本（默认 `C:\Program Files\FreeCAD 1.0\`）。
2. 打开参数化抽屉 → 底部「工程图（FreeCAD）」→ 显示「FreeCAD 1.0.x 可用」即可；否则点「指定 freecadcmd 路径…」选 `bin\freecadcmd.exe`（不是 `FreeCAD.exe`）。
3. 探测顺序：设置路径（`userData/freecad.json`）→ 环境变量 `AUTOMATIONCAD_FREECAD_CMD` → `Program Files[ (x86)]\FreeCAD 1.x\bin\freecadcmd.exe`（新版本优先）、`%LOCALAPPDATA%\Programs\FreeCAD 1.x\…` → PATH 中 `freecadcmd` / `FreeCADCmd`。要求 `--version` ≥ 1.0。

## 出图规则（techdraw_job.py）

- 图幅：A4/A3 横放，GB/T 14689 留装订边（a=25、c=5）；标题栏 180×56 右下（简化 GB/T 10609.1：设计/审核/工艺/批准、名称、单位、张数、图号、材料、比例、数量）+ 第一角投影识别符号。
- 投影：TechDraw `DrawProjGroup`，`ProjectionType = "First Angle"`：主视图左上、左视图在其右、俯视图在其下；轴测图（方向 (1,−1,1)）放剩余空白，必要时按半比例。
- 比例：GB/T 14690 系列 5:1、2:1、1:1、1:1.5、1:2、1:2.5、1:3、1:4、1:5、1:10、1:20、1:50、1:100；取能放下的最大比例。A4 能 ≥1:1 放下用 A4，否则取能给出更大比例的幅面（同比例取 A4）。可按零件或作业指定 `paper` / `scale`。
- 尺寸：外形总尺寸——长（主视水平）、高（主视竖直）、宽（左视水平）；同时在 TechDraw 页面建 `makeExtentDim`（进入 DXF）。
- 产物：`<fileStem>.pdf`（Qt 矢量 PDF）、`.dxf`（TechDraw `writeDXFPage` + 脚本追加图框/标题栏）、`.svg`（PDF 兜底源）；可选 `.FCStd`。
- FreeCAD 1.0 无界面的两处实测坑：① TechDraw 隐藏线在后台线程计算，必须有 Qt 事件循环（脚本创建 `QGuiApplication` 并轮询 `processEvents`），否则边线为空、`viewPartAsSvg` 段错误；② 比例要在 `addProjection` 之前设在投影组上（子视图 `ScaleType=Page` 由组统一缩放），事后改子视图 `Scale` 不触发重新投影。

## 沙箱实测（2026-10-26）

- 环境：Debian 13 aarch64，conda-forge `freecad 1.0.0`（`micromamba create -c conda-forge freecad=1.0 python=3.11`），build123d 0.13.0（pip），Noto Sans CJK 字体。
- 端到端：特征树（转接板 ×2：底板 + 4 沉头孔 + 2 定位孔 + 腰形槽 + R5 圆角；立柱：柱体 + 法兰）→ sidecar 逐件 STEP → freecadcmd → A3 PDF/DXF/SVG + manifest；两件批量出图约 1 s（不含 sidecar 首次加载）。改转接板长度 200→240 后仅转接板判过期（几何参数已变更），「重出过期」只重出这一件后全部最新。
- DXF 经 ezdxf `recover` 读取 0 错误，含 LINE/ARC/CIRCLE/ELLIPSE/SPLINE/DIMENSION 与中文标题栏 TEXT。

## 后续步骤

1. **钣金展开 DXF**：SheetMetal 是第三方工作台（方案要求不依赖插件）——先评估 FreeCAD 1.x 自带能力，否则在作业脚本内对折弯特征自写展开（K 因子 + 折弯线图层），复用同一作业协议（`kind: "unfold"`）、队列、清单与过期判定。
2. **总装图 + BOM 明细表**：多零件 STEP + 装配摆位 → TechDraw 装配视图、序号气泡、明细栏（复用 `toBom`）。
3. **FEM**：FreeCAD 自带 FEM + CalculiX，先做单件静力校核（材料库 + 固定/载荷面由特征语义推断，需人工确认）。
4. 补强：孔中心线与孔径/孔位标注、DXF 隐藏线分层（HIDDEN 线型）、主视方向自动选择、设置页统一入口、Windows 1.0/1.1 实机验收（含中文字体与安装路径）。
