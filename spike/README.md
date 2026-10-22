# spike · 参数化 CAD 内核验证

一次性实验代码，不参与桌面端构建，结论见 [docs/desktop/PARAMETRIC-CAD-SPIKE.md](../docs/desktop/PARAMETRIC-CAD-SPIKE.md)。

- `cadquery/spike.py` — 建模 / 改参重建 / STEP+STL 导出基准
- `cadquery/app.py` — sidecar 原型（标准库 HTTP + Bearer，`/health`、`/build`）
- `replicad/bench.mjs` — OCCT WASM 同件基准

```bash
python3 -m venv .venv && .venv/bin/pip install cadquery
.venv/bin/python spike/cadquery/spike.py
.venv/bin/python spike/cadquery/app.py --port 7411 --token dev-token
```
