# 模块：主视口可旋转 3D（src/orbit/）

职责：把原型「装配」「干涉校核」两个视口的**固定等轴测 SVG** 换成可旋转的 three.js 3D，并让属性编辑真正改几何。**原型文件零改动**：全部通过注入扩展挂到原型 DOM 上；WebGL 不可用时什么都不替换，原型等轴测 SVG 原样工作。

## 文件分工

| 文件 | 作用 | 可在 Node 单测 |
|------|------|----------------|
| `camera.ts` | 标准视图方向（前/后/左/右/俯/仰/等轴测）、fitDistance、正交视锥、透视↔正交换算、坐标轴指示器投影、最近标准视图 | ✅ |
| `model.ts` | 滑台气缸装配体参数化几何：默认参数逐项复刻原型 `buildScene()`；叠放链（底板→导轨→滑台→气缸→杆/开关）；参数表 + 校验；插入件放置复刻 `replicatePlacements` | ✅ |
| `selection.ts` | 结构树 ↔ 3D：`partsForNode` / `nodeForPart` / `resolveSelection` / `insertedIdsFromTree` | ✅ |
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
「3D 几何」输入 ──────────────────────→ applyParamEdit（校验）→ overrides → rebuild
```

## 关键约定

- 坐标：毫米、Z 向上、右手系；前视 = 从 −Y 看；等轴测方向 (1,−1,1)。原型 SVG 投影 `(x−y)·cos30, (x+y)/2−z` 是镜像等轴测，所以 3D 的等轴测与原型左右相反，这是刻意的（真实右手系）。
- 缸径→半径 `4 + bore·0.32`、杆长 `10 + stroke·0.12` 沿用原型**示意比例**（夹紧 12–63 / 10–200），保证降级 SVG 与 3D 是同一个装配体；不是 1:1 真实气缸尺寸。
- 原型 `state` 不导出：缸径/行程优先读气缸面板输入框（精确）；面板不在时从 SVG 反算（缸径 ±0.13 mm、行程 ±0.9 mm），吸附到「用户输入过的值 + 标准缸径/行程表」，吸附不上标记 `boreExact/strokeExact=false`。
- 插入件坐标：原型 `findFreePlacement()` 是确定性的，按树中插入顺序复刻；`proto-parity.test.mjs` 在 vm 里执行原型脚本逐字比对 7 次插入的轮廓，smoke 再对真实页面比对一次。
- 桌面版几何参数（底板/导轨/滑台尺寸、滑台位置 X、开关槽内高度、插入件尺寸与位置）只存在扩展内存里：不进原型撤销栈、不持久化（原型自身也不持久化插入件），每组有「恢复默认」。
- 按需渲染：相机/模型/高亮变化才画一帧；材质或裁剪平面变化会触发着色器重编译，`settle()` 在 120/500 ms 补帧，避免 swiftshader 等并行编译首帧画空。

## 公共调试入口

`window.AutomationCadOrbit`：`state()`、`setView(view, stage?)`、`setProjection('perspective'|'orthographic')`、`fit()`、`select(partId, stage?)`、`setParam(partId, key, value)`、`resetPart(partId)`、`sync()`。降级模式下视图类方法返回 `false`，模型/选择/属性联动仍可用。

## 验证

- 单测 `test/orbit/*.test.mjs`（38 条）：相机数学、模型/叠放链/校验、原型一致性（vm 执行原型 app.js）、树↔3D 映射、SVG 反算吸附、three 场景包围盒/高亮/拾取/干涉层。
- `npm run smoke`：`SMOKE_ORBIT_VIEW_OK mode=fallback …`（冒烟进程关闭 WebGL，验证降级 + 模型/选择/属性联动）。
- `npm run check:orbit-webgl`（手动，不进 CI）：swiftshader 打开 WebGL，验证画布替换、标准视图、投影往返、真实射线拾取、面板几何编辑、剖切裁剪与气泡定位，输出 `ORBIT_WEBGL_OK`。

## 坑点

1. **隐藏窗口截图是旧帧**：`show:false` 的 BrowserWindow 不重绘、rAF 被节流，`capturePage` 拿到的是旧画面；验证脚本必须 `show:true` + `backgroundThrottling:false`（xvfb 下没有真实显示器，无副作用）。
2. **裁剪/新材质首帧空白**：见上「按需渲染」；只渲染一次时会停在空帧。
3. **画布事件要截断冒泡**：原型在 stage 上绑了框选（pointerdown/move/up）与 click 委托，不截断会和 OrbitControls 抢拖拽。代价是 WebGL 模式下没有框选多选（降级模式仍有）。

## 待办

1. WebGL 模式下的框选多选（需要原型暴露设置 `state.multi` 的入口，或在扩展内维护多选并只读同步到属性面板）。
2. 桌面版几何参数进入原型撤销栈（需要原型公开 `pushHistory`，属于对 app.js 的 API 扩展，待评审）。
3. 气缸尺寸改为 1:1 真实比例（需同步改原型示意比例，或接受两边不一致）。
