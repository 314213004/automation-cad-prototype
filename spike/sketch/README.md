# spike/sketch · 2D 草图约束验证（P9-4 前置）

一次性实验，不参与桌面端构建。结论见
[docs/desktop/SKETCH-SPIKE.md](../../docs/desktop/SKETCH-SPIKE.md)。

- `solve-planegcs.mjs`：用 `@salusoft89/planegcs@1.3.0` 求解矩形（水平/竖直 + 宽 120 + 高 80），输出顶点、残差、DOF 与耗时。
- `result.json`：一次实测输出快照（计时随机器变化）。
- `check-build123d.py`：把求解顶点转成 build123d `Polyline → make_face → extrude`，断言体积与包围盒。

```bash
cd spike/sketch
npm install
npm run solve
node solve-planegcs.mjs > result.json

python3 -m venv .venv
.venv/bin/pip install build123d==0.13.0
.venv/bin/python check-build123d.py
```

期望：矩形顶点 `(0,0) (120,0) (120,80) (0,80)`，6 条残差均为 0；挤出 8 mm 后体积 76,800 mm³。
