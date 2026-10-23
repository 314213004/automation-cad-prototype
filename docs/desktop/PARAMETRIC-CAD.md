# 参数化建模内核（build123d）· 决策与实现方案

状态：已选型 **build123d 0.13.0**（2026-10-23 拍板），后续需要时再换内核
前情：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)（CadQuery / build123d / replicad 三方案实测）

## 1. 为什么选 build123d

| 理由 | 数据 |
|------|------|
| 轻 | 无 VTK、无 casadi，依赖 1.0 GB（CadQuery 1.8 GB，其中 VTK 639 MB、casadi 263 MB） |
| 快 | 同零件建模 25–50 ms，STEP 8–11 ms（CadQuery 79–123 ms / 10–20 ms） |
| 许可干净 | Apache-2.0，可商用 |
| 与 CadQuery 同源 | 都基于 OCCT，几何能力同档；后期要换 CadQuery 只改适配层 |
| Python 生态 | 团队可读可改，便于以后接 BOM/工艺/成本 |

代价：需 Python 运行时（sidecar），常驻约 424 MB，冷启动 ~2.3 s。已在方案里用「按需启动 + 预热 + 空闲退出」消化。

## 2. 架构

```
Electron 主进程 (electron/parametric.ts)
  ├─ ensureSidecar(): spawn python app.py --port 7412 --token <随机>
  │    ├─ 首次打开建模面板时启动（3 s 健康检查，失败重试 2 次）
  │    ├─ 空闲 10 min 自动退出，释放 400 MB
  │    └─ 崩溃自动重启一次，再失败 → 降级为「仅查看」
  ├─ build(featureTree) → POST /build（30 s 超时，串行队列）
  └─ 退出时 kill 进程树
渲染进程
  └─ window.desktop.parametric.{health,build}（preload 白名单，不暴露任意路径）
```

安全边界：
- 只监听 `127.0.0.1`，令牌每次启动随机生成，只经 IPC 传给渲染层，不落盘、不进日志
- 请求体 ≤1 MB，ops ≤200，导出格式白名单 `step|stl`
- 产物写临时目录，返回路径 + 大小；主进程负责清理与「另存为」
- **不执行用户脚本**：前端只发声明式特征树 JSON，Python 侧只做白名单算子映射

## 3. 接口契约

`GET /health` → `{"ok":true,"kernel":"build123d","version":"0.13.0","pid":123}`

`POST /build`（Bearer）

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

响应：`{ok, kernel, stats:{volumeMm3,bbox,faces,edges,solids}, buildMs, files:{step:{path,bytes,ms}, stl:{...}}}`

算子白名单（首期）：

| op | 参数 | 说明 |
|----|------|------|
| `box` | length / width / height / centered | 底板、块体；默认中心在 XY 原点 |
| `cylinder` | diameter / height / at[x,y,z] | 凸台、轴、销 |
| `holes` | diameter / positions[[x,y]] / depth(`through` 或 mm) | 通孔 / 盲孔 |
| `slot` | length / width | 腰形槽，贯通 |
| `fillet` | radius / edges(`|Z` 或 `all`) | 圆角 |

错误一律返回 `{ok:false,error:"中文原因"}`，HTTP 400；未授权 401。

## 4. 特征树数据模型（前端）

```ts
interface FeatureNode {
  id: string;                 // f1, f2…
  type: 'box' | 'cylinder' | 'holes' | 'slot' | 'fillet';
  name: string;               // 用户可改，如「底板」「M6 安装孔」
  params: Record<string, number | number[][] | string | boolean>;
  suppressed?: boolean;       // 抑制后跳过编译
}
interface FeatureDoc {
  schemaVersion: 1;
  sourceFile?: string;        // 关联的 STEP 文件名（若有）
  features: FeatureNode[];
  updatedAt: string;          // 带时区
}
```

编译与校验拆成纯函数，便于单测：
- `validateFeatures(doc)`：必填参数、正数、坐标在板内、fillet 半径不超过最小壁厚的一半、孔间距不小于孔径、空特征树
- `compileOps(doc)`：按顺序输出 sidecar `ops`，跳过 `suppressed`，稳定排序（同输入同输出）
- `summarize(doc)`：特征数、预计孔数、包围盒估算（用于未建模时显示）

## 5. 界面

建模面板（第 4 个 CAD 抽屉，与「运动学标注」并列，可切换）：
1. 左侧特征树：列表 + 图标 + 名称，支持上移/下移/抑制/删除/重命名
2. 中间视口：复用现有 three.js；建模前显示 STEP 只读，重建后载入新 STL 叠加对比（灰=旧，彩=新）
3. 右侧参数：选中特征的参数表单（mm、整数校验），改动 300 ms 防抖后自动重建（可关「自动重建」）
4. 底部：`重建 50 ms · 面 19 · 体积 71.5 cm³`，导出 STEP / STL / 保存特征树 JSON
5. 状态：sidecar 未启动 / 启动中 / 就绪 / 崩溃降级，四种状态有明确中文提示

## 6. 打包与部署

- PyInstaller onedir（比 onefile 启动快）：`--exclude-module vtkmodules --exclude-module casadi --exclude-module llvmlite --exclude-module scipy`，预估 250–300 MB
- 随安装包放在 `resources/parametric/`，主进程按平台决定 `python` 可执行文件路径
- 首次启动做一次 `POST /build` 空跑预热，避免用户第一次重建等 2.3 s
- 若目标机不允许 Python 运行时（安全策略），退化为「只查看」并在面板说明

## 7. 失败与降级

| 场景 | 行为 |
|------|------|
| sidecar 未安装 / 启动失败 | 建模面板显示「建模内核不可用，仅可查看 STEP」，不影响其他功能 |
| 构建超时（30 s） | 终止请求，提示「模型过于复杂，建议简化特征」，保留上一次成功结果 |
| 参数非法 | 前端拦截（中文原因）；后端二次校验，防止绕过 |
| 进程崩溃 | 自动重启一次；再失败进入降级 |
| 导出磁盘满 / 无权限 | 明确提示路径与原因 |

## 8. 测试

- 单测（纯函数）：`validateFeatures` 12 条（空树、负数、孔出界、孔间距、圆角过大、抑制、重复 id…）、`compileOps` 8 条（顺序、跳过抑制、确定性）
- 集成（Node）：启动 sidecar → health → build → 断言 stats 与文件存在 → 401 未授权 → kill 后 health 失败
- smoke：`SMOKE_PARAMETRIC_OK features=4 faces=19 volume=71495.7 buildMs<200`
- 性能门槛：简单件 < 200 ms，10 特征 < 1 s

## 9. 分期

- **P9-1**：sidecar + 契约 + 特征树纯函数（本方案 + `spike/build123d/app.py` 已验证：建模 50 ms、STEP 11 ms、回读一致）
- **P9-2**：主进程生命周期管理 + preload/IPC + 降级路径
- **P9-3**：特征树 UI + 参数编辑 + 自动重建 + 导出
- **P9-4**：草图与约束（前置调研完成；推荐接 `@salusoft89/planegcs`，见 [SKETCH-SPIKE.md](SKETCH-SPIKE.md)）
- **P9-5**：装配（多实体）与 BOM/成本的联动

> **P9-4 前置调研已完成，见 [SKETCH-SPIKE.md](SKETCH-SPIKE.md)。** 结论：推荐 LGPL-2.1 的 planegcs WASM（矩形 + 水平/竖直 + 宽 120 / 高 80 实测残差 0、自由度 0、热求解约 0.3 ms）；jsketcher 因许可与分发形态不推荐。求解顶点 → build123d `Polyline` → `make_face` → `extrude` 已用 0.13.0 实跑验证。本轮不接入产品代码。

## 10. 后续换内核的代价

适配层只有 `compileOps` 与 sidecar 的 `build()` 两处：
- 换 CadQuery：`build()` 内 API 替换（约 200 行）
- 换 replicad：去掉 sidecar，同进程 WASM，`compileOps` 不变，新增 TS 适配器

特征树、UI、校验、导出链路都不受影响——这是把「内核」和「产品」解耦的目的。

## P9-2 实现记录

日期：2026-10-23。本轮完成 sidecar 的桌面端接入，不含特征树编辑 UI（留待 P9-3）。

### 新增文件

| 文件 | 职责 |
|------|------|
| `desktop/src/parametric/features.ts` | 特征树数据模型、全量校验、`compileOps`、摘要；无 DOM / child_process |
| `desktop/electron/parametric.ts` | Python/脚本解析、随机端口与 token、spawn、健康检查、构建代理、崩溃重启与空闲退出 |
| `desktop/scripts/fake-parametric-sidecar.mjs` | `node:http` 假 sidecar，供集成测试与 smoke 使用 |
| `desktop/test/parametric-features.test.ts` | 纯函数单测（22 条） |
| `desktop/test/parametric-sidecar.test.ts` | 假 sidecar 生命周期集成测试（11 条） |
| `desktop/src/parametric/MODULE.md` | 特征树模块边界与编译契约 |

### IPC 契约

渲染层只拿状态与构建结果，不拿 `port` / `token`；所有 `/build` 请求由主进程代发。

| 通道 | 方向 | 返回 |
|------|------|------|
| `parametric:status` | invoke | `{status, message, version?}` |
| `parametric:start` | invoke | `{ok, status, message, version?}`；成功时内部启动，但**不返回端口与 token** |
| `parametric:build` | invoke | `{ok, stats?, buildMs?, files?}` 或 `{ok:false, code:'UNAVAILABLE'|'TIMEOUT'|'BUILD_FAILED', message}` |
| `parametric:stop` | invoke | 停止后的 `{status, message}` |
| `parametric:status-changed` | event | 状态机每次迁移时推送同结构状态 |

`preload.ts` 暴露 `window.desktop.parametric.{status,start,build,stop,onStatus}`。调试入口 `window.__Parametric.{status,build}` 仅用于 smoke，不暴露启动参数。

### 状态机

```
stopped ──start──> starting ──health ok──> ready
                       │                    │
                       └──失败────────────> unavailable
ready ──进程退出──> starting（自动重启一次）──> ready
                                  └──再失败──> crashed
ready/starting ──stop 或空闲 10 min──> stopped
```

- 端口从 7430–7449 随机探测，token 由 `crypto.randomBytes(32)` 生成。
- `/health` 每 300 ms 重试，最多 3 s；`/build` 使用 `AbortController`，30 s 超时。
- POSIX 以 `detached` 启动并 `kill(-pid)` 杀进程树；Windows 使用 `taskkill /T /F`。
- 日志与 IPC 状态均不包含 token；Python stdout 直接丢弃。
- 打包态脚本路径为 `resources/parametric/app.py`，`package.json` 已加入该资源映射。

### 测试命令

```bash
cd desktop
npx tsc --noEmit
node --test test/parametric-features.test.ts
node --test test/parametric-sidecar.test.ts
npm test
```

smoke 默认跳过参数化断言；指定假 sidecar 后执行完整启动与构建：

```bash
AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
# SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1
# 未设置环境变量时输出 SMOKE_PARAMETRIC_SIDECAR_SKIP
```

## P9-3 实现记录

日期：2026-10-23。本轮完成特征树 UI、参数编辑、防抖重建、视口联动与本地/JSON 持久化；不改 `index.html` / `app.js` / `styles.css` / `electrical.*`。

### 新增与修改

| 文件 | 职责 |
|------|------|
| `desktop/src/parametric/model.ts` | 纯逻辑：新建/删除/上移/下移/抑制/改名/参数更新、300 ms 防抖计划、`localStorage` 分桶、序列化/反序列化、底部状态与特征包围盒；无 DOM / IPC |
| `desktop/src/parametric/ui.ts` | 右侧「参数化」抽屉：特征树、按类型参数表单、校验提示、重建/导出/保存/载入、旧模型对比开关 |
| `desktop/src/cad/viewer.ts` | 新增幽灵层（旧模型半透明叠加、可开关）、`highlightBounds()` 特征包围盒高亮、`load(..., { ghost: true })` |
| `desktop/src/extension.ts` | 与「运动学」抽屉二选一挂载；载入 CAD 后同步来源文件；暴露 `window.AutomationCadParametric` 调试入口 |
| `desktop/src/cad.css` | 参数化抽屉样式（复用现有 CAD token，未新增主色） |
| `desktop/src/export/file.ts` | `exportFile` 白名单补充 `.step` / `.stl` / `.json`，STEP/STL 导出与特征树 JSON 保存复用同一 IPC |
| `desktop/test/parametric-model.test.ts` | 18 条模型/持久化/防抖/格式化单测 |
| `desktop/scripts/fake-parametric-sidecar.mjs` | 假内核额外写出真实二进制 STL 与 STEP 临时文件，便于 smoke 验证视口载入 |

### 面板行为

- 顶栏「参数化」与「运动学」并列；打开一个会收起另一个，右侧同时只显示一个抽屉。
- 特征树行：类型图标 + 名称 + 类型；操作支持上移 / 下移 / 抑制（可恢复）/ 删除 / 改名（行内输入，Enter 提交、Esc 取消）。
- 参数表单按 `type` 渲染：
  - `box`：长度、宽度、高度、XY 居中；
  - `holes`：孔径、深度、孔位 `[x, y]` 列表，可逐行增删；
  - `slot`：长度、宽度；
  - `fillet`：半径、边选择（`|Z` / `all`）；
  - `cylinder`：直径、高度、位置 X/Y/Z。
- 参数改动写入文档后默认 300 ms 防抖重建；关闭「自动重建」后仅手动点「重建」。
- 校验失败时逐条展示 `validateFeatures` 的中文错误并禁用重建；sidecar `unavailable/crashed` 时显示原因、禁用建模按钮，但特征树仍可查看/编辑/导出 JSON。
- 底部状态显示 `<就绪/启动中/不可用> · 重建 50 ms · 面 19 · 体积 71.5 cm³`；`volumeMm3` 转 cm³ 保留 1 位小数。

### 视口联动

- 重建成功后经主进程 IPC 返回 `files.stl.path`，渲染层用现有 `readFileBuffer` + `parseStandardCadBuffer`（STLLoader）路径载入 three.js；不新增第二套解析器。
- 载入新 STL 前把当前模型复制到幽灵层（灰色、透明 0.22、不参与拾取），可勾选「叠加旧模型」开关显示/隐藏。
- 选中特征时按参数估算包围盒并用黄色 `Box3Helper` 高亮；`fillet` 没有独立实体时回退整树包围盒。

### 持久化

- `localStorage` 键固定为 `automationcad.parametric.v1`，内部 `{version:1,buckets:{...}}` 按 `sourceFile` 分桶；无来源文件落到 `untitled`。
- 每次编辑、重建、保存都会写回当前桶；载入 CAD 时自动读取对应桶。
- 「保存特征树」先写 `localStorage`，再走 `desktop.exportFile` 导出 `<name>.parametric.json`；「载入特征树」走文件选择器解析 JSON。无桌面桥时退回复制 JSON 到剪贴板。

### 测试与验收

```bash
cd desktop
npx tsc --noEmit
node --test test/parametric-model.test.ts   # 18
npm test                                    # 524
AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
# SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1
# SMOKE_PARAMETRIC_UI_OK features=2 status=ready
# 未设置环境变量：SMOKE_PARAMETRIC_SIDECAR_SKIP / SMOKE_PARAMETRIC_UI_SKIP
```

smoke 使用假 sidecar，不依赖 Python；同时断言抽屉可见、特征行数 2、状态 `ready`、STL 已载入视口、底部包含「面 19 / 体积 71.5 cm³」。

### 边界

- 首期仍是单件结构件；草图与约束（P9-4）、多实体装配/BOM/成本联动（P9-5）未做。
- 特征高亮是参数估算包围盒，不是精确 B-rep 面组；重建后如 sidecar 能按特征分组网格，再升级为网格级高亮。
- 旧模型幽灵层来自当前视口模型，不额外读取 STEP；载入新文件时默认清空。

## P9-5 实现记录

日期：2026-10-23。本轮完成多实体装配、sidecar `instances` 契约、BOM 汇总与成本面板联动；单件 `FeatureDoc` 路径保持完全兼容。

### 数据模型

```ts
PartInstance {
  id: string; name: string; partId?: string;
  transform: { x: number; y: number; z: number; rz: number };
  features: FeatureNode[];
}
AssemblyDoc { schemaVersion: 1 | 2; sourceFile?: string; instances: PartInstance[]; updatedAt: string }
```

- 新文档以 `schemaVersion: 2` 保存；`instances` 存在时即按装配解析。
- 旧 `FeatureDoc`（`schemaVersion: 1` + `features`）由 `toAssembly()` 自动包成单实体 `p1 / 零件 1`，位置与旋转均为 0；旧 CLI/测试仍可直接调用 `compileOps(featureDoc)` 得到算子数组。
- `compileOps(assembly)` 返回 `{ops, instances}`：`ops` 是所有实体算子按实体顺序的拼接，`instances[]` 携带每实体的 `id / name / partId / transform / ops`。sidecar 优先消费 `instances`。
- 实体上限 50；校验重复实体 id、缺失名称、非数字 `transform.x/y/z`、非数字 `rz`、空实体特征列表，并逐实体复用原特征树校验（错误前缀「第 N 个实体（名称）」）。不同实体可以使用相同特征 id。

### sidecar 多实体

`POST /build` 新增可选 `instances`（与顶层 `ops` 二选一）：

```json
{
  "instances": [
    { "id": "p1", "name": "底板", "transform": {"x":0,"y":0,"z":0,"rz":0},
      "ops": [{"op":"box","length":120,"width":80,"height":8}] },
    { "id": "p2", "name": "顶板", "transform": {"x":140,"y":0,"z":0,"rz":90},
      "ops": [{"op":"box","length":60,"width":40,"height":6}] }
  ],
  "exports": ["step", "stl"]
}
```

- 每实体用现有白名单算子独立建模，再 `bd.Pos(x,y,z) * (bd.Rot(0,0,rz) * shape)` 放置，最后用 `Part + Part` 合并。
- 返回 `stats.solids`、`stats.volumeMm3` 与 `stats.instances[] = {id,name,volumeMm3}`（每实体建模体积）。
- 中文拒绝：实体 id 重复、`transform` 非对象、`transform.x/y/z/rz` 非有限数字、实体数 > 50、空 `instances`。
- 未传 `instances` 时仍走原单实体 `ops` 路径，响应结构与现有测试不变。

### BOM 与成本

`desktop/src/parametric/bom.ts` 为纯函数：

- `toBom(assembly)`：相同 `partId` 合并数量；无 `partId` 按名称合并并标 `unmapped: true`；序号按首次出现顺序从 1 连续分配；`spec` 取首个启用 box 的 `长×宽×高 mm`，无 box 时回退圆柱尺寸/特征数。
- `bomToCsv(rows)`：UTF-8 BOM（`\uFEFF`）+ 固定表头 `序号,物料号,名称,规格,数量,未映射`，逗号/引号/换行按 CSV 规则转义。
- `toCostBomRows` / `toCostInput`：映射件保留 `partId`；未映射件不带 `partId`，交给现有成本引擎按 `NO_PART_ID` 记缺价，绝不猜物料号。
- 面板新增「装配实体」区（增删实体、名称/partId、X/Y/Z/RZ 编辑）、BOM 预览表、「导出 BOM」与「送成本」；送成本复用 `__CostPanel.setBom({bom}, '参数化装配 BOM')`，与 `computeCostReport` 入参同形。

### 测试与验收

```bash
cd desktop
npx tsc --noEmit
node --test test/parametric-assembly.test.ts   # 25
npm test                                       # 647
AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
# SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1
# SMOKE_PARAMETRIC_UI_OK features=2 status=ready
# SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3
```

新增测试覆盖：旧文档包装、单件 `compileOps` 兼容、多实体顺序/拼接、抑制、`rz` 默认值、重复实体 id、transform 非数字、实体数 50 上限、空装配、跨实体同特征 id、BOM 合并/未映射/同名分流/确定性、CSV BOM 与转义、成本入参与 `NO_PART_ID`。

### 边界

- BOM 只按实体汇总，不按特征明细拆行；`spec` 是参数级摘要，不是加工工艺卡。
- 装配为静态多实体合并，不做配合约束/自由度求解（仍属 P9-4）。
- `partId` 仍由人工填写；本轮不做名称规则自动匹配（见 BACKLOG D7）。
