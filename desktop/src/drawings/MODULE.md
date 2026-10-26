# 模块：FreeCAD 零件工程图（drawings/）

可选模块 `drawings.techdraw`（v1.0.0 / API 1，依赖 `core` + `cad.parametric-import`，默认启用）。
本目录是 renderer 与主进程共用的纯逻辑层 + 参数化抽屉里的 UI 分区；进程管理在 `desktop/electron/freecad.ts`、
编排在 `desktop/electron/drawings-service.ts`、IPC 在 `desktop/electron/drawings-ipc.ts`、FreeCAD 侧脚本在
`spike/freecad/techdraw_job.py`（随包登记为 `resources/freecad/techdraw_job.py`）。

## 分工与边界

| 角色 | 负责 | 不负责 |
|---|---|---|
| build123d sidecar | 参数化零件、整机模板、实体化；本模块用它**逐件**导出 STEP | 出图 |
| AutomationCAD 本体 | 装配、摆位、运动、BOM、电气、成本；工程图入口/队列/清单/过期判定 | 投影与隐藏线计算 |
| FreeCAD 1.x（`freecadcmd`，独立进程，LGPL，用户可选安装） | TechDraw 页面、三视图/轴测、尺寸、PDF/DXF；之后钣金展开 DXF、FEM | 建模、改参 |

- **特征树 JSON 是唯一主数据**。STEP、PDF、DXF、SVG 都是产物；不在 FreeCAD 里反向编辑，不回读 STEP 改特征树。
- **不在同一 Python 进程里 import build123d 和 FreeCAD**（两份 OCCT 冲突），只用文件中转。
- 只用 FreeCAD 1.0 自带 Part/TechDraw 工作台，不依赖 A2plus、SheetMetal 等第三方插件。
- FreeCAD 未安装：模块仍“启用”，出图按钮禁用并显示原因 + 安装指引；建模、重建、导出 STEP 全部不受影响。

## 数据流

```
AssemblyDoc（参数化抽屉 getDoc）
  └─ planDrawingParts：按 partKey（partId，否则 inst:<实体id>）合并 → 数量、几何哈希、指纹、fileStem
       └─ IPC drawings:generate {projectKey, doc, instanceIds?, onlyStale?, meta, titleBlock}   ← 不含任何路径
            └─ DrawingsService：逐件单件 FeatureDoc → ParametricManager.build → files.step.path
                 └─ FreecadRunner（串行队列）：临时目录 in/<stem>.step（记 SHA-256）+ job.json
                      └─ freecadcmd techdraw_job.py（AUTOMATIONCAD_FREECAD_JOB=job.json）
                           ├─ stdout  @@ACAD {"event":"part-start|part-done|done"}  → 进度广播 drawings:job-changed
                           └─ out/<stem>.pdf|dxf|svg + result.json
                 └─ 只交付作业约定文件名 → 工程目录 drawings/ + manifest.json（applyJobResults）
renderer：drawingStatus(manifest, plan) → 最新 / 过期（原因）/ 未出图；可「重出过期」或勾选自动重出
```

工程目录：`projectKey` 命中工程库（`userData/projects/<id>/project.json`）时写 `projects/<id>/drawings/`；
否则 `userData/drawings/<ASCII 片段>-<sha256(projectKey) 前 12 位>/`。renderer 的 projectKey 取
CAD 工程身份 projectId，缺省为 `src:<来源文件名>`，再缺省 `untitled`。

## 文件

- `protocol.ts`：作业协议 `automationcad.drawing-job/1` / 结果 `automationcad.drawing-result/1`；`buildDrawingJob`、`validateDrawingJob`
  （中文全量错误）、`normalizeDrawingOptions`、`parseDrawingJobResult`（只采信与作业零件一一对应、文件名等于 `<fileStem>.<fmt>` 的条目）、
  `parseProgressLine`、`partFileStem`（ASCII 片段 + partKey SHA-256 前 8 位，中文物料号也稳定唯一）。
- `stale.ts`：`partKeyOf`、`geometryHashOf`（compileOps 后的算子，忽略名称/摆位/抑制特征）、`drawingFingerprint`
  （几何 + 名称/partId/数量/材料/图号/比例/图幅 + 脚本版本）、`planDrawingParts`、`drawingStatus`、`affectedPartKeys`、
  `applyJobResults`（成功替换；失败保留旧图并记 `lastError` → 判过期）、`parseDrawingManifest`（丢弃伪造文件名/错 fileStem）。
- `ui.ts`：参数化抽屉底部「工程图（FreeCAD）」分区：FreeCAD 状态/重新检测/指定 freecadcmd 路径、设计者/单位、
  零件表（材料、图号输入，状态徽标，PDF/DXF/目录）、选中零件出图/全部出图/重出过期/取消、自动重出开关、进度行。
  偏好存 `localStorage` 键 `automationcad.drawings.v1`（标题栏、按工程/零件的材料与图号、自动重出）。1.5 s 轮询特征树签名，
  改动时用纯逻辑重算过期（不走 IPC）；输入框聚焦时不重绘零件表。

## 协议样例

作业（主进程写 `job.json`）：

```json
{
  "protocol": "automationcad.drawing-job/1",
  "jobId": "fc-mvp2egjx-7e2c5121",
  "kind": "techdraw",
  "outputDir": "<临时目录>/out",
  "options": { "formats": ["pdf", "dxf", "svg"], "paper": "auto", "scale": "auto", "iso": true, "hiddenLines": true, "hlrTimeoutSec": 60 },
  "titleBlock": { "designer": "老王", "company": "AutomationCAD", "date": "2026-10-26" },
  "parts": [
    { "partId": "P-ADP-001", "fileStem": "P-ADP-001-d0a9ef70", "name": "转接板", "material": "6061-T6",
      "drawingNo": "AC-ADP-001", "quantity": 2, "step": "<临时目录>/in/P-ADP-001-d0a9ef70.step" }
  ]
}
```

结果（脚本写 `out/result.json`）：

```json
{
  "protocol": "automationcad.drawing-result/1", "jobId": "fc-mvp2egjx-7e2c5121", "scriptVersion": "1.0.0",
  "ok": true, "freecadVersion": "1.0.0", "elapsedMs": 1180,
  "parts": [
    { "partId": "P-ADP-001", "ok": true,
      "files": { "svg": "P-ADP-001-d0a9ef70.svg", "dxf": "P-ADP-001-d0a9ef70.dxf", "pdf": "P-ADP-001-d0a9ef70.pdf" },
      "warnings": [], "bbox": [200, 120, 15], "solids": 1, "paper": "A3", "scale": "1:1",
      "dimensions": { "length": 200, "width": 120, "height": 15 }, "views": ["front", "iso", "left", "top"], "elapsedMs": 581 }
  ]
}
```

## 测试

`test/drawings/`：`protocol`（构建/校验/注入/结果解析/进度行）、`stale`（指纹、合并计数、冲突、fresh→stale→失败保留→重出、孤儿、
受影响集合、清单校验）、`freecad-runner`（候选排序 Win/Linux、版本、假 freecadcmd：批量成功、单件失败、STEP 导出失败、崩溃、超时、
取消排队/运行、PDF 兜底、伪造路径、stderr 截断、未安装）、`drawings-service`（请求校验、目录映射、同号只建一次、onlyStale、
工程库目录、模块关闭/未安装 fail-closed）、`techdraw-script`（常量一致、无 build123d import、python3 自检/语法；
`AUTOMATIONCAD_FREECAD_REAL=<freecadcmd>` 时真 FreeCAD 端到端）。`test/modules/drawings-module.test.mjs` 守注册与依赖。

## 已知边界

- 只标外形总尺寸（长/宽/高）；没有孔位/孔径/公差/粗糙度/技术要求，也没有中心线。
- DXF 来自 TechDraw `writeDXFPage`：视图与尺寸为真实图元，隐藏线与可见线同层（TechDraw 限制）；图框/标题栏由脚本追加（TEXT 用 `\U+` 转义中文）。
- PDF 在 FreeCAD 进程内用 Qt（QSvgRenderer + QPdfWriter）渲染，中文字体按 Microsoft YaHei → SimSun → Noto Sans CJK… 选本机可用的；失败时主进程用隐藏窗口打印 SVG 兜底。
- 视图取标准方向（主视 = 从 −Y 看），不自动选“最能反映形状特征”的主视方向。
- Windows 实机（FreeCAD 1.0/1.1 安装版）尚未验收。
