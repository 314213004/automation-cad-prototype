# 模块：网页原型（仓库根 index.html / app.js / styles.css / electrical.*）

职责：产品视觉与交互的**基座**。桌面版直接加载它，再用注入扩展叠加能力；它本身必须保持「双击即开」。

## 文件与体量

| 文件 | 行数 | 作用 |
|------|------|------|
| `index.html` | 304 | 外壳：顶栏、上下文条、8 个视图、状态栏、命令面板 |
| `styles.css` | 615 | 设计 token、组件、机械域三视图 |
| `app.js` | 1789 | 等轴测投影、结构树、属性面板、选型、库、校核、出图 |
| `electrical.css` | 586 | 电气域样式（复用 token，不新增 UI 色） |
| `electrical.js` | 2286 | 原理图 / IO 规划 / 柜体布置 |

## 核心数据结构

```js
// app.js — 全局状态
const state = {
  view: 'assembly', selNode: 'cyl', selectedPart: 'cyl', multi: [],
  hoverPart: null, hitPart: null, issueIdx: 0, treeOpen: {},
  values: {}, undo: null
};

// 结构树（递归，part 关联 PARTS / 场景 g[data-part]）
TREE = [{ id:'root', kind:'asm', children:[
  { id:'g-slide', kind:'grp', children:[
    { id:'base', part:'base', meta:'AL6061' },
    { id:'rail', part:'rail', meta:'GCr15' },
    { id:'carriage', part:'carriage', dof:'1' },
    { id:'g-cyl', part:'cyl', dof:'2', children:[
      { id:'cyl', part:'cyl' }, { id:'rod', part:'rod', dof:'1' }, { id:'sensor', part:'sensor' }
    ]}
  ]},
  { id:'g-std', kind:'folder', meta:'12', children:[...] }
]}];

// 零件属性（驱动右侧面板）
PARTS = { cyl: { name, code, tag, groups:[ { title, fields:[ {k, key, type:'text|num|select', v, options, unit, ro} ] } ] }, ... }

// 选型库 / 出图 / 校核
LIB    = [{ model, brand, cat, bore, stroke, port, price, stock }, ...];
BOM    = [{ no, name, spec, qty, mat }, ...];
ISSUES = [{ sev:'error|warning|info', part, title, sub, gap, allow, x, y, path }, ...];
VIEW_MODE = { assembly:'assembly', sizing:'model', library:'assembly', check:'check', drafting:'drafting' };
```

```js
// electrical.js — 电气域状态
ES = {
  domain: 'mech' | 'elec', view,
  defs: {}, split: 0.46,
  io:  { sel, seg, tree, adopted: {}, ignored: false },
  enc: { W:800, H:1200, D:300, sel, comps:[], seq:{Q,K,A,X,G,FN}, place, drag, calc, res:{temp,load,margin} }
};
```

## 视图与入口

- 机械：`assembly`（结构树/装配）、`sizing`（选型，顶栏「建模」）、`library`（标准件库）、`check`（干涉）、`drafting`（出图）
- 电气：`schematic`、`io`、`enclosure`（顶栏「机械 | 电气」切换）
- 切换实现：`setView(v)` 只改 `hidden` 与按钮 `is-active`，**不重建 DOM**
- 视图状态用 `hidden` 属性，不是 class；`section.view.is-active` 只是初始 HTML 写法，脚本不维护

## 坑点（原型自身）

1. **`state` 是模块级 const，没有导出**：桌面扩展拿不到；需要读状态只能走 DOM（`[data-sel]`、`.is-active`）或注入自己的数据。
2. **视图切换靠 `hidden` 属性**：用 `.is-active` 判断当前视图永远是 `assembly`，写测试时容易误判。
3. **`app.js` 末尾 `init()` 立即执行**，扩展脚本必须等 `DOMContentLoaded` 之后再注入，否则拿到空 DOM。
4. **3D 是固定等轴测投影**（`(x−y)·cos30 / (x+y)·0.5−z`），不是真 3D；旋转/缩放不可用，只有 `fit`。
5. **拖放是假插入**：`drop` 只弹 toast「已插入 1 个零件」，不建树、不改场景——这是 README「下一步」里要打通的动线。
6. **撤销栈只有单步**（`state.undo` 只存一个字段级回滚）。
7. **电气域是「加而不改」范例**：`app.js` 零改动，新增 `electrical.js/css`，通过 `data-domain` 切换模式组。桌面扩展沿用同一模式。

## 进度

- ✅ 8 个视图全部可切换，无控制台报错（1920×1080）
- ✅ 电气域三视图（原理图 12 符号、IO 28 点位、柜体布置）
- ✅ 截图 `docs/screenshots/` 与 README 决策文档
- ⏳ 「拖气缸进视口 → 自动生成配合约束」未实现（原型与桌面版共用此缺口）
- ⏳ 无持久化、无真实导出

## 待办

1. 给原型加一个**只读的公共 API**（`window.ProtoApi = { getTree, getSelection, insertPart, setView }`），让桌面扩展不再靠猜 DOM。
2. 把拖放插入做成真实流程：写入 `TREE` → 重渲染树 → 场景加占位体 → 生成 DOF 与配合候选。
3. 撤销栈改为命令栈（与桌面 `CommandBus` 合并）。
