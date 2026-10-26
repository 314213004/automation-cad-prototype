# home（启动首页）

启动后盖在原型界面之上的一层「工作台首页」：最近工程 + 新建入口。首屏不再直接展示
根目录 `app.js` 里硬编码的「滑台气缸装配体」示例工程（那份数据是演示几何，不是真实工程）。

## 文件

| 文件 | 职责 |
| :--- | :--- |
| `model.ts` | 纯逻辑：最近工程排序（创建时间倒序）/裁剪/时间格式化（今天、昨天、N 天前）/空态与失败文案 |
| `home-screen.ts` | DOM 层：首页结构、卡片、「最近工程」列表、样式注入；暴露 `initHomeScreen()` 句柄 |

## 行为

- 启动：首页可见，原型 `#app` 设为 `opacity:0 + pointer-events:none + aria-hidden + inert`
- 新建：空白画布（0 节点，`openCanvasWorkbench({ blank: true })`）／演示拓扑（6 工位）
- 打开最近工程：走既有 `openSavedProject(id)`（恢复逐件 STL 与零件树）；打开失败首页重新显示
- 进入经典原型界面：关闭首页，露出示例装配（明确是演示）
- 顶部工具条注入「首页」按钮，随时回到最近工程；Esc 关闭首页

## 坑点

1. **不能用 `visibility:hidden` / `display:none` 藏 `#app`**：3D 视口按容器尺寸挂 WebGL，
   藏起来会量到 0×0，`SMOKE orbit_view` 直接降级 fallback（reasons=2）。改用 `opacity:0` 保住布局。
2. **`opacity:0` 的内容仍在可访问树里**：必须同时 `aria-hidden="true"` + `inert`，否则读屏软件仍会读出示例装配。
3. **「最近工程」为空是正常状态**：本机没有保存过工程时显示空态提示，不要拿示例填充。

## 验证

```bash
cd desktop
npx tsc --noEmit
node --test test/home/model.test.mjs      # 7 条
npm test                                   # 全量
npm run smoke                              # 含 SMOKE orbit_view / 画布七段
```
