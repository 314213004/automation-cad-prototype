# 模块：主视口可旋转 3D（src/orbit/）

职责：把原型「装配」「干涉校核」两个视口的**固定等轴测 SVG** 换成可旋转的 three.js 3D，并让属性编辑真正改几何。**原型文件零改动**：全部通过注入扩展挂到原型 DOM 上；WebGL 不可用时什么都不替换，原型等轴测 SVG 原样工作。

## 文件分工

| 文件 | 作用 | 可在 Node 单测 |
|------|------|----------------|
| `camera.ts` | 标准视图方向（前/后/左/右/俯/仰/等轴测）、fitDistance、正交视锥、透视↔正交换算、坐标轴指示器投影、最近标准视图 | ✅ |
| `model.ts` | 滑台气缸装配体参数化几何：默认参数逐项复刻原型 `buildScene()`；叠放链（底板→导轨→滑台→气缸→杆/开关）；参数表 + 校验；插入件放置复刻 `replicatePlacements` | ✅ |
| `selection.ts` | 结构树 ↔ 3D：`partsForNode` / `nodeForPart` / `resolveSelection`（框选多选原样返回）/ `insertedIdsFromTree` | ✅ |
| `history.ts` | `UnifiedHistory`：3D 编辑栈（覆盖表前后快照、800 ms 同字段合并、上限 50）+ 与原型撤销栈合成的令牌时间线；从状态栏「撤销 N / 重做 M」与按钮提示对账 | ✅ |
| `persist.ts` | 工程存储：localStorage `automationcad.orbit.v1`（只存内置零件覆盖，读回按参数表 + 装配规则校验） | ✅ |
| `marquee.ts` | WebGL 框选命中：包围盒 8 角点投影 → 屏幕矩形，与框相交即命中（同原型），剖切时排除被裁掉的零件 | ✅（只用 three 核心） |
| `proto-sync.ts` | 从原型 SVG 反算缸径/行程 + 吸附到已知值（`snapValue`） | ✅ |
| `three-scene.ts` | Assembly → three Group（每零件一组、userData.partId）、高亮写材质、干涉重叠体、剖切面 | ✅（只用 three 核心） |
| `view.ts` | `OrbitView`：WebGLRenderer + 透视/正交双相机 + OrbitControls、按需渲染、拾取、裁剪、坐标轴/气泡投影 | ❌（需 WebGL） |
| `ui.ts` | 与原型 DOM 的桥：挂载、观察、事件转发、属性面板注入、`window.AutomationCadOrbit` | ❌（需 DOM） |
| `orbit.css` | 覆盖层样式（复用原型 token） | — |

## 数据流

```
原型 DOM（只读观察）                       扩展（本模块）
#scene3d/#sceneCheck 重新挂载 ─childList─→ rebuild(): ProtoApi.getTree() + 缸径/行程 + 插入件 → buildAssembly → OrbitView.setAssembly
g.part[data-sel|hover|hit] 变化 ─attr────→ syncHighlight(): resolveSelection(树, SVG 选中, 当前树节点) → 材质高亮
左栏树重绘 / 右栏属性重绘 ──────────────→ 组节点展开；右栏追加「3D 几何 · 桌面版」分组
3D 点击 / 悬停 ────────────────────────→ 在 SVG 对应 g.part 上派发 click / mouseover → 原型 selectPart / applyIssue
「3D 几何」输入 ──────────────────────→ applyParamEdit（校验）→ overrides → history.recordOrbit → saveOrbit → rebuild
状态栏「撤销 N / 重做 M」变化 ─────────→ history.observeProto（对账：原型新动作 / 外部撤销 / 外部重做）
Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / 状态栏按钮 → 时间线栈顶 'orbit' → 扩展撤/重做（换回快照）；'proto' → 放行给原型
WebGL Shift+拖拽 / 「框选」模式拖拽 ─────→ partsInRect → 原型框选（隐藏未命中 g.part + 合成拖拽）→ state.multi
```

## 关键约定

- 坐标：毫米、Z 向上、右手系；前视 = 从 −Y 看；等轴测方向 (1,−1,1)。原型 SVG 投影 `(x−y)·cos30, (x+y)/2−z` 是镜像等轴测，所以 3D 的等轴测与原型左右相反，这是刻意的（真实右手系）。
- 缸径→半径 `4 + bore·0.32`、杆长 `10 + stroke·0.12` 沿用原型**示意比例**（夹紧 12–63 / 10–200），保证降级 SVG 与 3D 是同一个装配体；不是 1:1 真实气缸尺寸。
- 原型 `state` 不导出：缸径/行程优先读气缸面板输入框（精确）；面板不在时从 SVG 反算（缸径 ±0.13 mm、行程 ±0.9 mm），吸附到「用户输入过的值 + 标准缸径/行程表」，吸附不上标记 `boreExact/strokeExact=false`。
- 插入件坐标：原型 `findFreePlacement()` 是确定性的，按树中插入顺序复刻；`proto-parity.test.mjs` 在 vm 里执行原型脚本逐字比对 7 次插入的轮廓，smoke 再对真实页面比对一次。
- 参数校验：导轨不超出底板、滑台不脱出导轨；非法值输入框红框 + 中文原因，且不生效。HUD 显示当前标准视图/自由视角与透视开关，左下坐标轴按相机实时重画。
- **撤销/重做（合成时间线）**：原型 `pushHistory` 不导出、app.js 不能改，所以 3D 编辑有自己的栈，但和原型栈按发生顺序排成一条令牌时间线。Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 与状态栏撤销/重做按钮在捕获阶段先过扩展：栈顶是 3D 编辑就由扩展换回覆盖表快照（提示写同一个 `#stMsg` / `#toast`），是原型动作就原样放行，原型的提示与字段合并逻辑不变。任一侧新动作都作废全部重做；原型重做栈扩展清不掉，记为 orphan，重做入口被拦截（提示「没有可重做的操作」）。同字段 800 ms 内的连续输入合并为一步（与原型 `pushEdit` 一致）；「恢复默认」也是一步。状态栏按钮里追加「3D n」徽标，3D 栈顶时提示换成 3D 动作名（原型原文暂存在 `data-proto-title`，回到原型动作时还原）。
- **整机布局编辑并入同一时间线**：令牌新增 `'layout'`（`src/layout-editor/` 与向导俯视 X/Y 编辑）。`ui.ts` 导出 `layoutHistory`（record / setApplier / undo / redo / clear / bound）；栈顶为 `'layout'` 时由宿主注册的 applier 把快照写回 `MachineDesign.stationGeometryLayout`，applier 拒绝（方案已换）则整段布局历史作废。状态栏徽标计数含布局条目。
- **对账**：原型计数只能从 `#stUndoText「撤销 N」/ #stRedoText「重做 M」` 读；`(U−k, R+k)` = 外部撤销、`(U+k, R−k)` = 外部重做、`R=0` 且增长 = 新动作。撤销 1 步后做新动作与重做的计数完全一样，用按钮提示里的栈顶动作名区分。Agent `undo_last` / `ProtoApi.undo()` 直接撤原型时同样被识别。
- **持久化**：内置零件（底板/导轨/滑台/开关）的覆盖每次变化（编辑、撤销、重做、恢复默认）立即写 localStorage `automationcad.orbit.v1`（与底板画布 `automationcad.enclosure.v1` 同一机制，位于 userData，重启 / 重新打开保留），全部恢复默认时删键；启动时先恢复再首次重建，恢复值不进撤销栈。插入件覆盖不持久化（原型本身不持久化插入件）。坏数据（非 JSON、版本不符、越界、滑台脱轨）整体丢弃，`state().store.reason` 给原因。
- **框选（WebGL）**：左键拖拽仍是旋转，**Shift+左键拖拽**临时框选，工具条「框选」按钮切换粘滞框选模式（光标变十字）。宿主捕获阶段先于 OrbitControls 截获，拖拽框复用原型舞台的 `.marquee`。命中后写回原型 `state.multi`：临时 `display:none` 未命中的隐形 SVG `g.part`，在舞台上同步派发一次覆盖全舞台的合成拖拽，原型框选只命中剩下的零件，随后恢复样式——高亮、「已选中 N 个对象」、点选替换框选、Esc 清除都沿用原型。降级模式原型自带框选，行为不变。
- 按需渲染：相机/模型/高亮变化才画一帧；材质或裁剪平面变化会触发着色器重编译，`settle()` 在 120/500 ms 补帧，避免 swiftshader 等并行编译首帧画空。

## 公共调试入口

`window.AutomationCadOrbit`：`state()`（含 `history` 时间线快照、`store` 恢复/保存状态）、`setView(view, stage?)`、`setProjection('perspective'|'orthographic')`、`fit()`、`select(partId, stage?)`、`setParam(partId, key, value)`、`resetPart(partId)`、`sync()`、`undo()` / `redo()`（与快捷键同一路径）、`selectMany(ids, stage?)`（写原型多选，两种模式都可用）、`marquee({x0,y0,x1,y1} 归一化, stage?)`、`setMarqueeMode(on, stage?)`。降级模式下视图类方法与 `marquee` 返回 `false` / `null`，模型/选择/属性/撤销/持久化仍可用。

## 验证

- 单测 `test/orbit/*.test.mjs`（63 条）：相机数学、模型/叠放链/校验、原型一致性（vm 执行原型 app.js）、树↔3D 映射、SVG 反算吸附、three 场景包围盒/高亮/拾取/干涉层；合成时间线（交错撤销/重做顺序、合并窗口、重做作废与 orphan、外部撤销、上限滚动、重做与新动作区分）、存储往返与坏数据拒绝、框选投影命中与剖切排除。
- `npm run smoke`：`SMOKE_ORBIT_VIEW_OK mode=fallback …`；`SMOKE_ORBIT_UNDO_OK timeline=proto,orbit,orbit …`（Ctrl+Z / 按钮 / Ctrl+Y / Ctrl+Shift+Z 按时间线交错撤销重做、新动作作废重做）；`SMOKE_ORBIT_MULTI_OK …`（多选写回原型）；`SMOKE_ORBIT_PERSIST_OK …`（新开窗口从存储恢复）。
- `npm run check:orbit-webgl`（手动，不进 CI）：swiftshader 打开 WebGL，验证画布替换、标准视图、投影往返、真实射线拾取、面板几何编辑、剖切裁剪与气泡定位，输出 `ORBIT_WEBGL_OK`；新增 `ORBIT_WEBGL_MARQUEE_OK`（API 框选、真实 Shift 拖拽不转相机、粘滞框选模式、面板编辑 Ctrl+Z/Ctrl+Y 输入框同步、写入存储）。每次运行用临时 userData；没有 xvfb 时可 `ELECTRON_DISABLE_SANDBOX=1 npx electron scripts/orbit-webgl-check.cjs --ozone-platform=headless`（脚本已加 `ozone-override-screen-size`，否则 headless 屏幕 1×1、舞台 0 尺寸，拾取/框选断言必挂）。

## 坑点

1. **隐藏窗口截图是旧帧**：`show:false` 的 BrowserWindow 不重绘、rAF 被节流，`capturePage` 拿到的是旧画面；验证脚本必须 `show:true` + `backgroundThrottling:false`（xvfb 下没有真实显示器，无副作用）。
2. **裁剪/新材质首帧空白**：见上「按需渲染」；只渲染一次时会停在空帧。
3. **画布事件要截断冒泡**：原型在 stage 上绑了框选（pointerdown/move/up）与 click 委托，不截断会和 OrbitControls 抢拖拽。WebGL 框选因此由扩展自己在宿主捕获阶段处理，再经合成拖拽写回原型。
4. **原型框选后 140 ms 内忽略点击**（`state.justMarqueed`）：`selectMany` / 框选之后立即 `select()` 会被吞掉，脚本里要等过这个窗口。
5. **原型字段合并只看它自己的栈顶**：原型改缸径 → 3D 编辑 → 800 ms 内再改缸径，原型会把第二次并进第一条（它看不到 3D 条目），撤销时缸径一步回到最初值。窗口很短，记录不处理。

## 待办

1. 气缸尺寸改为 1:1 真实比例（需同步改原型示意比例，或接受两边不一致）。
2. 若原型将来公开 `pushHistory` / `setMulti`，可把合成时间线与合成框选换成直接调用（行为不变，去掉对状态栏文案与隐形 SVG 的依赖）。
3. 3D 几何按「工程 / 机型」分桶存储（现为单键；原型装配体是固定示例，与机型方案无关，暂不需要）。
4. Agent 暂无写 3D 几何参数的工具，`undo_last` 只覆盖 Agent 命令；3D 编辑走快捷键 / 状态栏撤销。
