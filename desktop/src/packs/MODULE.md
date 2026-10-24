# 模块：元器件数据包（src/packs/ + packs/builtin/）

职责：把「供应商元器件库」做成可插拔的数据包，用户可导入、启停、删除；库检索给 UI 与 Agent 共用。

## 包格式

```
<pack-id>/
├── manifest.json     # 必填：schemaVersion=1, id, name, vendor, version
│                     # 选填：license, description
├── parts.json        # ComponentPart[]
└── assets/           # 可选：STEP/GLB 模型、缩略图（parts[].asset 相对路径）
```

```ts
interface ComponentPart {
  id: string; model: string; category: string;
  vendor?: string; specs: Record<string, string | number>;
  asset?: string; thumbnail?: string; price?: number;
  packId?: string; packName?: string;   // registry 注入，磁盘上不必写
}
interface PackInfo {
  id; name; vendor; version; description?; license?;
  enabled: boolean; builtin: boolean; path: string;
  partCount: number; error?: string;    // 坏包只标 error，不阻断其他包
}
```

## 按需加载（2026-10-24）

- `scan()` 只读 `manifest.json`，建立 id/目录/分类/条目数/关键词索引，不读 `parts.json`；
- `listParts()` 先用 `packId`、`manifest.categories`、包名/厂商/描述/关键词预过滤，命中包才 `loadPack`；
- `loadPack(id)` 首次读 `parts.json` 并缓存；`unloadPack(id)` 释放；重复搜索命中缓存；
- 跨包同 id 去重，内置包优先；`getPartById()` 首次调用懒建全局 partId 索引；
- `metrics()` 返回 `packLoadMs / loadedPacks / partsLoaded / searchMs / packCount / indexedParts`，diagnose 的 `packMetrics` 与 smoke 的 `SMOKE_PACKS_LAZY_OK` 复用同一口径；
- `readTextFile` 注入仅用于测试，可断言 manifest / parts 的实际读取次数。

## 目录与持久化

| 位置 | 说明 |
|------|------|
| `packs/builtin/<id>/` | 随安装包分发，只读；`remove()` 会拒绝 |
| `%APPDATA%/AutomationCAD/packs/<id>/` | 用户导入 |
| `%APPDATA%/AutomationCAD/packs-state.json` | `{ disabled: string[] }`，只记禁用项 |

## 校验规则（`validateManifest` / `importZip`）

- `schemaVersion` 必须 `=== 1`
- `id` 必须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/`，且与目录名一致
- 必填字段缺失 → 该包 `error`，其余包照常可用
- ZIP 解压前逐条检查 entry 路径，拒绝 `../`、绝对路径、盘符（`adm-zip` entryName 归一化后判断）
- id 冲突：内置包优先，用户包同 id 导入报「已存在」

## 坑点

1. **路径穿越**必须在写盘前判断，不能解压后再清理；测试用 `../evil.txt` 覆盖。
2. **id 与目录名不一致**的包会让「禁用/删除」指向错目录，直接判非法。
3. **`packId/packName` 是运行时注入字段**，导入时不要写回 `parts.json`，否则二次导入会带脏字段。
4. **禁用状态存「禁用列表」而不是「启用列表」**：新导入的包默认可用，不会被漏掉。
5. **中文检索要同时匹配 model/vendor/category/specs 值**（`listParts` 内已拼平再 includes）。
6. **大包不要在主进程同步读**：`scan()` 是 async，但 `listParts` 是内存索引；万级条目要换 SQLite FTS（未做）。

## 进度

- ✅ 内置 5 个元器件包 + 价格簿：`iec-cn` 379、`smc-cn` 8、`servo-cn` 25、`sensor-cn` 32、`pneumatic-cn` 44；启动只读 manifest，按需加载/卸载与全局索引已实现
- ✅ 懒加载单测 32 条：manifest 校验、read spy、缓存命中、unload 重载、分类/包名过滤、跨包去重、全局索引、体积/字段/性能
- ✅ 扫描 / 校验 / ZIP 导入 / 启停 / 删除 / 搜索
- ✅ 面板：列表、开关、导入、删除、搜索并插入（写入 localStorage 覆盖层）
- ✅ 单测 6 条（合法、缺 id、id 不符、zip 穿越、禁用生效、合法导入）
- ⏳ 在线包仓库与签名校验（`license` 字段已预留）
- ⏳ 型号去重与版本升级（同 id 新版本覆盖策略未定）

## 待办

1. 包内资产（STEP/GLB）在「插入」时真实加载到 CAD 查看器，而不是只写库记录。
2. 包索引落 SQLite（`userData/packs.db`），支持万级条目与规格区间筛选。
3. manifest 增加 `signature` / `minAppVersion`，导入时校验。
