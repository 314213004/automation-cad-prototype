# 模块：渲染层扩展与面板（src/extension.ts、src/ui/、src/cad.css）

职责：在**不改动原型**（index.html / app.js / styles.css / electrical.*）的前提下，把桌面能力挂到现有界面：顶栏入口、CAD 覆盖层、工厂与数据包侧滑面板。

## 注入方式

```
main.ts did-finish-load
  └─ <script src="file://.../dist/extension.js">（IIFE）
       └─ init()
            ├─ injectStyles()      # cad.css + panels.css 插到 <head>
            ├─ buildEntryButton() # 顶栏追加「CAD 查看」「工厂」「数据包」
            ├─ buildOverlay()     # #automationCadOverlay
            └─ bindWindowEvents() # 拖放、Esc、菜单事件
```

## 关键 DOM 契约

| id / class | 用途 |
|------------|------|
| `#automationCadOverlay` | CAD 全屏覆盖层根节点 |
| `.cad-entry-btn` | 顶栏入口按钮 |
| `[data-cad-action="open\|fit\|wire\|close"]` | 覆盖层工具条 |
| `#cadNotice` | 加载/错误提示条 |
| `window.AutomationCadViewer` | `{ open, close, importPath, inspectPath }`，smoke 测试用 |
| `window.__AUTOMATION_CAD_EXTENSION_READY__` | 注入完成标志，smoke 等待它 |

工厂面板与数据包面板分别由 `initFactoryPanel()` / `initPackPanel()` 在 `src/extension.ts` 里初始化，样式在 `src/ui/panels.css`。

## 数据流

- 打开 CAD：菜单/按钮/拖放 → `desktop.readFileBuffer(path)` → Worker 解析 → viewer 渲染
- 工厂：面板 → `window.desktop.factory.*` → 主进程 Manager → 适配器 → `onValues` 事件回推 UI
- 数据包：面板 → `desktop.packs.*`；「插入」写 `localStorage` 覆盖层，不改原型数据

## 坑点

1. **原型没有模块系统**：扩展只能以 IIFE 注入，不能用 `import` 直接改原型作用域；需要读原型状态时走 DOM 与 `window.ElecDomain` / `window.AutomationCadViewer`。
2. **CSS 变量沿用原型 token**（`--bg`、`--line`、`--accent` 等），新增颜色会被视觉评审打回；图纸与 3D 的描边体系不能混。
3. **覆盖层 z-index 要高于原型工具栏与命令面板**，且打开时锁 `body` 滚动（原型的弹层用 `position:fixed`）。
4. **Esc 必须只关最上层**：捕获阶段监听并 `stopPropagation`，否则原型的命令面板会一起关。
5. **拖放要 `preventDefault` 两次**（dragover + drop），否则 Electron 会尝试导航到文件。
6. **入口按钮要插在顶栏右侧分隔符之前**，硬编码 `appendChild` 会跑到窗口控制区外。

## 进度

- ✅ 顶栏 3 个入口（CAD 查看 / 工厂 / 数据包）
- ✅ CAD 覆盖层（工具条、零件树、统计、空白态、降级态）
- ✅ 工厂面板（状态灯、连接表单、工位树、实时值、写入确认）
- ✅ 数据包面板（列表、开关、导入、删除、搜索、插入）
- ⏳ 面板宽度/折叠记忆、键盘可达性（焦点环）
- ⏳ 与原型「标准件库」视图的深度联动（当前是 localStorage 覆盖层）

## 待办

1. 把「插入」从 localStorage 覆盖层升级为原型的真实库数据源（需要原型侧提供 API，或改为重渲染库视图）。
2. 面板状态持久化（`userData/ui-state.json`）。
3. 统一 toast/状态条，避免三个模块各自提示风格不一致。
