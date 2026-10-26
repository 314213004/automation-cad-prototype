# spike · 参数化 CAD 内核验证

一次性实验代码，不参与桌面端构建，结论见 [docs/desktop/PARAMETRIC-CAD-SPIKE.md](../docs/desktop/PARAMETRIC-CAD-SPIKE.md)。

- `cadquery/spike.py` — 建模 / 改参重建 / STEP+STL 导出基准
- `cadquery/app.py` — sidecar 原型（标准库 HTTP + Bearer，`/health`、`/build`）
- `build123d/app.py` — 选定内核的 sidecar 原型（`/health`、`/build`，端口 7412）
- `replicad/bench.mjs` — OCCT WASM 同件基准
- `freecad/techdraw_job.py` — FreeCAD 1.x 无界面作业脚本（零件工程图 TechDraw → PDF/DXF/SVG）；**例外：随桌面版打包**（`resources/freecad/`），由 `desktop/electron/freecad.ts` 以 `freecadcmd` 独立进程调用，`python3 spike/freecad/techdraw_job.py --self-test` 跑纯逻辑自检，详见 [FREECAD-DRAWINGS.md](../docs/desktop/FREECAD-DRAWINGS.md)
- `sketch/` — P9-4 2D 约束求解 spike（planegcs 实测 + build123d `Polyline → extrude` 衔接），结论见 [SKETCH-SPIKE.md](../docs/desktop/SKETCH-SPIKE.md)

```bash
python3 -m venv .venv && .venv/bin/pip install cadquery
.venv/bin/python spike/cadquery/spike.py
.venv/bin/python spike/cadquery/app.py --port 7411 --token dev-token

cd spike/sketch && npm install && npm run solve
```
