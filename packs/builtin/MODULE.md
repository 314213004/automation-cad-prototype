# 模块：内置数据包 packs/builtin/

职责：随安装包分发的只读元器件库，给「标准件库」和 Agent 的 `list_components` 提供数据。

## 目录

```
packs/builtin/
└── smc-cn/
    ├── manifest.json      # schemaVersion=1, id=smc-cn, vendor=SMC, version=1.0.0
    ├── parts.json         # 8 个型号
    └── assets/            # 预留：<id>.stp / <id>.glb 与缩略图（当前为空）
```

## 数据结构

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "id": "smc-cn",
  "name": "SMC 常用气动元件",
  "vendor": "SMC",
  "version": "1.0.0",
  "license": "数据仅用于选型演示，型号与参数以厂商样本为准",
  "description": "非标自动化常用 SMC 气缸、电磁阀、磁性开关、接头与气源处理元件。"
}
```

`parts.json`（数组，字段见 `src/shared/types.ts` 的 `ComponentPart`）：

```json
{
  "id": "MXQ20-50",
  "model": "MXQ20-50",
  "category": "气缸",
  "vendor": "SMC",
  "specs": { "品牌": "SMC", "缸径": "20 mm", "行程": "50 mm", "动作方式": "双作用", "价格": 468 },
  "price": 468
}
```

当前 8 个型号：`MXQ20-50`、`MGP32-200`、`CDQ2B32-50DZ`、`MHZ2-20D`、`SY5120-5LZD`、`D-M9B`、`KQ2H06-01AS`、`AW30-03`，覆盖气缸 / 气爪 / 电磁阀 / 传感器 / 气动接头 / 气源处理 6 类。

## 坑点

1. **`model` 是型号，不是文件名**。早期把 `model` 写成 `MXQ20-50.stp`，库里显示成文件名；已修正为型号，模型文件放 `assets/<id>.stp`，路径写入 `asset` 字段。
2. **`specs` 的键是中文**（缸径/行程/动作方式），因为直接展示给工程师；检索时会拼平参与匹配，不要改成英文键。
3. **`price` 同时存在于 `specs.价格` 和顶层 `price`**：顶层用于排序与合计，`specs` 用于展示；改价要同步两处。
4. **`asset` 路径必须相对包目录**，且不能越界（`../`）；加载前由 registry 校验。
5. **型号与厂商参数仅供演示**，`license` 已声明「以厂商样本为准」，不要当成选型依据。
6. **内置包不可删除**：`registry.remove()` 对 `builtin: true` 直接拒绝。

## 进度

- ✅ 8 个真实型号 + 分类 + 规格 + 价格
- ✅ manifest 校验、启用/禁用、检索
- ⏳ 模型资产（STEP/GLB）与缩略图未提供
- ⏳ 扩展更多厂商（THK / HIWIN / 米思米 / 费斯托）

## 待办

1. 为每个型号补 `assets/<id>.stp` 与 `thumbnails/<id>.png`，让「插入」能真实进 3D。
2. 增加 `minAppVersion`，避免旧客户端读新包字段。
3. 新增 `hiwin-cn`、`misumi-cn` 两个包，验证多包并存与类别合并。
