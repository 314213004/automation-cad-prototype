# 模块：参数化特征树（parametric/）

职责：定义可序列化的声明式特征树，并在进入 sidecar 前做纯函数校验与算子编译。本模块无 DOM、无 `child_process`、无网络访问，可在 Node 单测与渲染层中复用。

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

## 编译（compileOps）

- 按 `features` 数组顺序输出，跳过 `suppressed: true`。
- 只输出 sidecar 白名单字段，不把 UI 字段或未知参数传入 Python。
- 深拷贝数组参数，输出被修改不会污染原特征树；相同输入产生相同 JSON。
- `summarize` 返回总特征数、参与编译的孔位数量与抑制数量。

## 测试

```bash
cd desktop
node --test test/parametric-features.test.ts
```

测试覆盖空树、重复 id、未知类型、必填/非数字/非正参数、孔位格式、出界、孔间距、圆角、时区、抑制、顺序与确定性。
