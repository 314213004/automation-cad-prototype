# 模块：参数化特征树（parametric/）

职责：定义可序列化的声明式特征树，在进入 sidecar 前做纯函数校验与算子编译，并承载 P9-3 的编辑/持久化纯逻辑与右侧抽屉 UI。`features.ts` / `model.ts` 无 DOM、无 `child_process`、无网络访问；只有 `ui.ts` 访问 DOM 与既有 IPC。

## 数据模型

```ts
FeatureNode { id, type, name, params, suppressed? }
FeatureDoc  { schemaVersion: 1, sourceFile?, features, updatedAt }
```

`type` 白名单：`box | cylinder | holes | slot | fillet`。`params` 保持 JSON 友好类型，坐标数组不得使用对象包装。

## 校验（validateFeatures）

返回全部中文错误，不抛异常。当前规则：

- 特征树不能为空；`id` 必须存在且全树唯一。
- `type` 必须在白名单内；每个算子的必填尺寸必须为有限正数。
- `holes.positions` 必须非空且每项为 `[x, y]` 二元数字数组。
- 孔中心必须落在首个启用 `box`（底板）的 XY 包围盒内；非居中底板的范围为 `0..length/0..width`。
- 同一孔特征内任意两孔中心距不得小于孔径（恰好相等允许）。
- `fillet.radius` 不得大于所有启用 `box` 最小板厚的一半。
- `updatedAt` 必须是带 `Z` 或 `±HH:MM` 时区的合法时间。
- `centered`、`at`、`depth`、`edges` 等可选参数也做类型白名单校验。

错误定位使用「第 N 个特征（用户名称）」前缀，便于特征树 UI 直接展示。

## 编辑与持久化（model.ts）

- 编辑函数全部不可变：`addFeature` / `removeFeature` / `moveFeature` / `setSuppressed` / `toggleSuppressed` /
  `renameFeature` / `updateParams`；`updatedAt` 统一刷新为带 `Z` 的 ISO 时间。
- `createFeature` 按类型给出默认参数与递增 `fN` id；默认名称在同一类型内自动追加序号。
- `debouncePlan(lastChangeAt, now, {delayMs:300, enabled})` 返回 `{scheduled, waitMs, dueAt}`；纯函数，定时器归 UI。
- `createParametricStore(storage)` 只写一个键 `automationcad.parametric.v1`，内部格式
  `{version:1, buckets:{[sourceFile]: FeatureDoc}}`；无来源文件统一落到 `untitled`。
- `serializeDoc` / `deserializeDoc` 负责 JSON 往返；反序列化只做结构校验（允许参数尚未合法，便于继续编辑）。
- `formatBuildStatus(buildMs, stats)` 输出 `重建 50 ms · 面 19 · 体积 71.5 cm³`。
- `featureBounds` / `docBounds` 按参数估算高亮包围盒；`fillet` 无独立实体时由 UI 回退整树包围盒。

## UI（ui.ts）

- 右侧抽屉与「运动学标注」二选一；结构为状态条 → 特征树 → 参数表单 → 校验 → 选项 → 底部重建/导出/保存/载入。
- 特征树操作：上移、下移、抑制/恢复、删除、行内改名（Enter 提交、Esc 取消）。
- 参数表单按 `type` 渲染，`holes.positions` 支持逐行增删；输入后 300 ms 防抖重建，可关闭自动重建。
- 重建调用 `window.desktop.parametric.build`；成功后用 sidecar 返回的 `files.stl.path` 走
  `readFileBuffer + parseStandardCadBuffer` 载入 three.js，并在载入前捕获旧模型幽灵层。
- 校验错误逐条显示且禁用重建；sidecar 不可用时显示原因并禁用建模按钮，但仍可查看/编辑/导出 JSON。
- 来源文件变化时自动读取对应 `localStorage` 桶；保存同时写本地并走 `desktop.exportFile` 导出 JSON。

## 编译（compileOps）

- 按 `features` 数组顺序输出，跳过 `suppressed: true`。
- 只输出 sidecar 白名单字段，不把 UI 字段或未知参数传入 Python。
- 深拷贝数组参数，输出被修改不会污染原特征树；相同输入产生相同 JSON。
- `summarize` 返回总特征数、参与编译的孔位数量与抑制数量。

## 测试

```bash
cd desktop
node --test test/parametric-features.test.ts
node --test test/parametric-model.test.ts
```

`features` 覆盖空树、重复 id、未知类型、必填/非数字/非正参数、孔位格式、出界、孔间距、圆角、时区、抑制、顺序与确定性；
`model` 覆盖新建/删除/上移/下移/抑制/改名/参数更新、防抖计划、分桶键与存储、序列化往返、状态格式化、包围盒与损坏存储。
