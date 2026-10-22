# 参数化 CAD 内核评估 · CadQuery 实测报告

日期：2026-10-23
结论：**CadQuery 2.8.0 可作为参数化建模内核**，能力与许可都没问题；但如果目标是「塞进 Windows 安装包」，它的运行时体积与内存偏高，**replicad 更适合内嵌**。建议按部署形态二选一，详见第 6 节。

## 1. 测试环境

- Linux (PVE 容器) / Python 3.11.2 / Node 26.7.0，15 GB 内存
- CadQuery 2.8.0（Apache-2.0，2026-06 发布）
- build123d 0.13.0（同一 OCCT 内核，无 VTK，对照项）
- replicad 1.x + replicad-opencascadejs 1.1.0（OCCT WASM，对照项）

## 2. CadQuery 实测

测试件：120×80×8 底板 + 四角 Ø6 孔 + 50×18 腰形减重槽 + 40 高立筋 + R2 圆角。

| 指标 | 结果 |
|------|------|
| 首次建模 | 122.6 ms |
| 改参数重建（孔径 6→8、筋厚 6→10） | 114.8 ms |
| 体积变化 | 92,128.2 → 107,424.5 mm³（拓扑重建生效，非仅改尺寸） |
| 面 / 边 / 实体 | 50 / 120 / 1 |
| STEP 导出 | 19.6 ms，165 KB |
| STL 导出（0.1 容差） | 50.0 ms，1.84 MB |
| STEP 回读校验 | 体积 92,128.2 mm³、50 面，与原始模型完全一致 |

Sidecar 原型（`spike/cadquery/app.py`，标准库 HTTP + Bearer）：

| 指标 | 结果 |
|------|------|
| `GET /health` | 正常返回版本与 PID |
| `POST /build`（底板+4 孔+槽+圆角，导出 STEP+STL） | **78.7 ms**（建模）+ 9.6 ms（STEP）+ 18.1 ms（STL） |
| 无 Token 请求 | `401 unauthorized` |
| 进程 RSS（建模服务常驻） | 491 MB |
| `import cadquery` 冷启动 | 1.77 s |
| 虚拟环境体积 | **1.8 GB**（OCP 164 MB、OCP libs 101 MB、VTK 639 MB、casadi 263 MB、llvmlite 173 MB、scipy 113 MB） |

关键发现：`import cadquery` 会连带加载 **vtkmodules 与 casadi**（可视化与装配约束求解），这是体积与内存的大头，纯建模用不到。

## 3. 三方案对比

| 维度 | CadQuery 2.8 | build123d 0.13 | replicad 1.x |
|------|-------------|----------------|--------------|
| 许可 | Apache-2.0 ✅ | Apache-2.0 ✅ | MIT ✅ |
| 运行方式 | Python 进程 | Python 进程 | Node / 浏览器 WASM |
| 冷启动 | 1.77 s | 2.35 s | **0.20 s** |
| 建模（同件） | 79–123 ms | **25.5 ms** | 44 ms |
| STEP 导出 | 10–20 ms | **8.1 ms** | 59 ms |
| 依赖体积 | 1.8 GB（可裁剪） | 1.0 GB | **57 MB** |
| 峰值内存 | 491 MB | 428 MB | **240 MB** |
| 装配 / 约束 | 强（CASADI 求解） | 中 | 弱 |
| 生态 / 示例 | 最多 | 较新 | 中 |
| 嵌入 Electron | 需 sidecar | 需 sidecar | **同进程直接调用** |

## 4. 集成方案（CadQuery sidecar）

```
Electron 主进程
  ├─ 启动时按需 spawn: python app.py --port 7411 --token <随机>
  ├─ 健康检查（GET /health，2 s 超时，失败重试 3 次）
  ├─ 建模请求（POST /build，超时 30 s，串行队列）
  └─ 退出时 kill；崩溃自动重启一次，再失败则降级为「仅查看」
渲染进程 ── window.desktop.cad.build(featureTree) ──▶ 主进程 ──▶ sidecar
```

要点：
- 只监听 `127.0.0.1`，Bearer token 每次启动随机生成，经 IPC 传给渲染层，不落盘
- 请求体上限 1 MB，ops 数量上限 200，导出格式白名单（step / stl）
- 产物写到临时目录，返回路径 + 大小 + 耗时；由主进程负责清理
- 建模与查看分工：**CadQuery 负责精确几何与导出，现有 three.js 负责显示**（STEP/STL 都可回读）

特征树（声明式，前端只发数据，不执行脚本）示例：

```json
{
  "ops": [
    { "op": "box", "length": 120, "width": 80, "height": 8 },
    { "op": "holes", "diameter": 6, "positions": [[-44,-24],[44,-24],[-44,24],[44,24]] },
    { "op": "slot", "length": 50, "width": 18 },
    { "op": "fillet", "radius": 6, "edges": "|Z" }
  ],
  "exports": ["step", "stl"]
}
```

## 5. 打包成本

- **PyInstaller 单文件**：预估 350–450 MB；加 `--exclude-module vtkmodules --exclude-module casadi --exclude-module llvmlite` 可压到 250–300 MB，但需回归验证 cadquery 是否会因缺模块报错（当前版本 import 链会触碰 casadi）
- 现有 Electron 安装包约 133 MB，叠加 sidecar 后预计 **350–450 MB**，对内部工具可接受，对外分发偏大
- replicad 方案只需多打 ~50 MB wasm，安装包约 190 MB，且无跨进程开销

## 6. 建议

1. **如果要「单机离线、装完即用、安装包别太大」** → 选 **replicad**（MIT、同进程、0.2 s 启动、57 MB），CadQuery 作为算法参考
2. **如果要「工业级特征、装配约束、团队熟悉 Python」** → **CadQuery sidecar**，接受 350–450 MB 与 491 MB 常驻内存；建议只在对内工程机分发
3. **折中** → sidecar 用 **build123d**（无 VTK、建模更快），体积约 1.0 GB venv、PyInstaller 约 250 MB

无论选哪个，交互层（特征树、草图、约束 UI）都是主要工作量，内核只占三成。

## 7. 复现

```bash
# CadQuery
python3 -m venv .venv && .venv/bin/pip install cadquery
.venv/bin/python spike/cadquery/spike.py          # 建模/重建/导出基准
.venv/bin/python spike/cadquery/app.py --port 7411 --token dev-token
curl -s localhost:7411/health

# replicad
mkdir rep && cd rep && npm init -y && npm i replicad replicad-opencascadejs
node spike/replicad/bench.mjs
```
