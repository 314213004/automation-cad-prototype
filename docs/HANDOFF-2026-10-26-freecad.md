# 交接 · 2026-10-26 · FreeCAD 后台任务（第 1 步：零件工程图）

分支 `feat/freecad-techdraw`（基于 origin/main `1f0ba79`，未基于 PR #12），已推送到 fork，未开 PR。

## 一、交付

| 层 | 文件 | 说明 |
|---|---|---|
| FreeCAD 侧 | `spike/freecad/techdraw_job.py` | 读 STEP → TechDraw 第一角三视图 + 轴测、自动图幅/比例、外形尺寸、国标标题栏 → PDF/DXF/SVG；多零件一次作业；`--self-test` 纯逻辑自检 |
| 运行器 | `desktop/electron/freecad.ts` | 探测/版本、串行队列、超时/取消/进程树、stderr 尾部、临时目录清理、PDF 兜底钩子 |
| 编排 | `desktop/electron/drawings-service.ts` | 特征树 → 逐件 STEP（sidecar）→ 作业 → 工程目录 + manifest |
| IPC | `desktop/electron/drawings-ipc.ts`、`preload.ts`、`ipc.ts`（导出 `createTrustedIpcHandler`）、`main.ts` | `freecad:*` / `drawings:*`，受信 sender + 模块 fail-closed，renderer 不传路径 |
| 纯逻辑 | `desktop/src/drawings/protocol.ts`、`stale.ts` | 协议校验/序列化/结果解析；指纹、过期、受影响集合、清单合并 |
| UI | `desktop/src/drawings/ui.ts`、`extension.ts`、`parametric/ui.ts`（`selectedInstanceId()`）、`cad.css` | 参数化抽屉「工程图（FreeCAD）」分区 |
| 模块 | `desktop/src/modules/registry.ts` | `drawings.techdraw`（依赖参数化，默认启用） |
| 打包 | `desktop/package.json` extraResources、`scripts/update-installed.mjs` | `resources/freecad/techdraw_job.py` |
| 测试 | `desktop/test/drawings/*`、`test/modules/drawings-module.test.mjs`、`scripts/fake-freecadcmd.mjs` | +45 条 |
| 文档 | `docs/desktop/FREECAD-DRAWINGS.md`、`desktop/src/drawings/MODULE.md`、MODULES/BACKLOG/electron/modules MODULE、THIRD-PARTY-NOTICES | |

## 二、验证

- `npx tsc --noEmit`、`npm run build:ext` 通过；`TZ=Asia/Shanghai npm test`：2414 条，2412 过、1 跳过（真 FreeCAD 门控用例）、1 失败为已知 `wizard-overlap-dom`（沙箱无 `/usr/bin/xvfb-run`）。
- 真 FreeCAD：沙箱 conda-forge FreeCAD 1.0.0 + build123d 0.13 端到端跑通（产物见项目 `work/freecad/`）；`AUTOMATIONCAD_FREECAD_REAL=<freecadcmd> node --test test/drawings/techdraw-script.test.mjs` 可复跑。

## 三、别当成已做

- Windows 实机（FreeCAD 安装版路径、Qt 平台插件、中文字体）未验收。
- 只有外形总尺寸；孔位/公差/技术要求/中心线没有。DXF 隐藏线未分层。
- 钣金展开、总装图 + BOM 表、FEM 未开工（见 FREECAD-DRAWINGS.md「后续步骤」）。
