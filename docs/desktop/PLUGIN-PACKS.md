# 数据包插件格式（元器件按需加载）

程序把元器件数据做成**可插拔的数据包**：装软件时只带内置包，其余由用户导入。桌面端启动时只读 manifest 索引，进入检索/列表时才读取命中的 `parts.json`，不在启动阶段全量解析。

## 1. 包结构

```
<pack-id>/
├── manifest.json      # 必填：索引，启动时只读这一层
├── parts.json         # 元器件包必填；价格簿包用 pricebook.json
└── assets/            # 可选：<id>.stp / <id>.glb / 缩略图
```

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "id": "servo-cn",
  "name": "伺服与运动控制（汇川/台达/雷赛）",
  "vendor": "汇川、台达、雷赛",
  "version": "1.0.0",
  "license": "型号与参数取自厂商公开样本/数据表",
  "description": "SV660P/SV660N、ASDA-B3/A3、57CM 步进电机",
  "categories": ["伺服", "步进"],
  "partsCount": 25,
  "keywords": ["伺服", "SV660P", "SV660N", "ASDA-B3", "57CM"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `schemaVersion` | ✅ | 固定为 `1` |
| `id` | ✅ | 与目录名一致，匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$` |
| `name` / `vendor` / `version` | ✅ | 非空字符串 |
| `license` / `description` | ✅ | 数据授权与覆盖范围；内置包必须写 |
| `categories` | ✅ | 非空分类数组；搜索/列表先用它排除未命中包 |
| `partsCount` | ✅ | manifest 中的声明条目数；实际加载后以 `parts.json` 为准 |
| `keywords` | ⬜ | 系列/品牌/别名；只用于 manifest 级预过滤 |

`parts.json` 单项：

```json
{
  "id": "MS1H1-40B30CB-A331Z",
  "model": "MS1H1-40B30CB-A331Z",
  "category": "伺服",
  "vendor": "汇川",
  "specs": {
    "ratedW": 400,
    "voltage": "220 V AC",
    "encoder": "23 bit 绝对值",
    "flange": "60 mm",
    "brake": "无（标准型）",
    "数据来源": "汇川 SV660P 系列伺服驱动器硬件手册（2023，官方）"
  },
  "dims": {
    "w": 60, "h": 60, "d": 91,
    "source": "汇川 SV660P 系列伺服驱动器硬件手册（2023，官方）MS1H1-40B30CB-A331Z 尺寸表"
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 全局唯一；跨包重复时搜索结果按内置包优先去重 |
| `model` | ✅ | 展示型号，**不是文件名** |
| `category` | ✅ | 归入既有分类（伺服/步进/传感器/气缸/气爪/电磁阀/气源处理/气动接头等） |
| `vendor` | ⬜ | 厂商 |
| `aliasOf` | ⬜ | 指向已登记型号的 id；alias 条目不参与 `listParts` 计数，`getPartById` 会解析到目标 |
| `symbol` | ⬜ | 原理图符号键；缺省表示暂无符号 |
| `specs` | ⬜ | 键值参数，值只能是字符串或数字；新包必须带 `数据来源` |
| `dims` | ⬜ | 本体外形 `{w,h,d}`，单位 mm；三项必须为有限正数 |
| `dims.source` | dims 必填 | 官方样本/PDS 出处；查不到官方尺寸就留空，不猜 |
| `dims.estimated` | 推定必填 | 仅同系列同壳架推定写 `true` |
| `railMount` / `moduleWidth` | ⬜ | DIN 导轨安装与模数宽 |
| `asset` / `thumbnail` | ⬜ | 相对包目录的 3D 模型/缩略图 |
| `price` | ⬜ | 数字，仅用于估算；仓库内置包不写价格 |

尺寸只允许两种来源：厂商样本/PDS 的明确数值，或**同系列同壳架**的官方尺寸推定。推定必须在 `dims.source` 写参照型号并设 `dims.estimated: true`；不得跨厂商借尺寸。

## 2. 内置包清单（10 个）

| 包 | 条目 | 分类 | 体积 | 加载方式 | 内容 |
|----|------|------|------|----------|------|
| `iec-cn` | 377 | 26 | 159.1 KB | manifest 索引；命中后 `loadPack` 懒加载 | 低压配电、控制、PLC/HMI、变频/伺服/步进、传感器、安全件等 |
| `smc-cn` | 8 | 6 | 2.2 KB | manifest 索引；命中后 `loadPack` 懒加载 | SMC 气缸、气爪、电磁阀、磁性开关、接头、气源处理 |
| `servo-cn` | 25 | 2 | 17.5 KB | manifest 索引；命中后 `loadPack` 懒加载 | 汇川 SV660P/N + MS1H1/MS1H3，台达 ASDA-B3/A3 + ECMA，雷赛 57CM |
| `sensor-cn` | 32 | 1 | 20.6 KB | manifest 索引；命中后 `loadPack` 懒加载 | 电感/光电/磁性/压力/光纤，欧姆龙、倍加福、西克、基恩士、图尔克等 |
| `pneumatic-cn` | 44 | 5 | 24.0 KB | manifest 索引；命中后 `loadPack` 懒加载 | SMC CDQ2/MXQ/MGP/CQ2、MHZ2/MHL2、SY/VQ、AW/AC、KQ2 |
| `vision-cn` | 32 | 6 | 17.0 KB | manifest 索引；命中后 `loadPack` 懒加载 | 海康/大恒/Basler 相机、Computar/海康镜头、环形/条形/背光、光源控制器、读码器、视觉控制器 |
| `drive-cn` | 33 | 8 | 14.5 KB | manifest 索引；命中后 `loadPack` 懒加载 | HIWIN/TBI 丝杠、HIWIN 导轨、Neugart/APEX/绿的谐波减速机、KTR/R+W 联轴器、GT2/HTD 5M 带与带轮、齿条、HIWIN KK 模组 |
| `safety-cn` | 33（28 实型号 + 5 alias） | 5 | 18.4 KB | manifest 索引；命中后 `loadPack` 懒加载 | 欧姆龙/西克/邦纳安全光幕与激光扫描仪、皮尔兹/施耐德/西门子安全继电器、施迈赛/皮尔兹/欧姆龙门锁联锁、施耐德急停、皮尔兹/西门子安全 PLC |
| `frame-cn` | 33 | 6 | 19.6 KB | manifest 索引；命中后 `loadPack` 懒加载 | APAS 欧标槽 8/10 铝型材（40×40/40×80/45×45/45×90/80×80）、角件/内置连接/T 型螺母/端盖、网框/亚克力/铝塑板、福马轮/调节脚（100/300/600 kg）、Blickle 水平调节脚轮、安全门铰链/门框/门锁、皮带线与倍速链段 |
| `pricebook-cn` | 0 | 1 | 26.0 KB | 价格簿按需读取（`pricebook.json`） | 人民币价格簿（不进入元器件检索） |

元器件包合计 **612 条可检索型号 / 612 个唯一 id**（原始记录 617 条，含 `safety-cn` 的 5 条 `aliasOf` 重定向）。2026-10-24 起按「同一型号不跨包重复」清理历史重复：`D-M9B` 保留在 `smc-cn`（BOM 演示引用），`SR-1000` 保留在 `vision-cn`；`safety-cn` 中与 `iec-cn` 重复的 PNOZ s3/s4、XPSAC、3SK1111、NP2-BS542 只登记 alias，不再复制参数。

## 3. 懒加载机制

1. **启动/扫描**：`PackRegistry.scan()` 只 `readFileSync(manifest.json)`，建立 id → 目录 / 分类 / 条目数 / 关键词索引；不读任何 `parts.json`。
2. **列表/搜索**：`listParts({ q, category, packId })` 先按 `packId`、`manifest.categories`、包名/厂商/描述/关键词过滤；只有候选包才调用 `loadPack(id)`。
3. **单包加载**：`loadPack(id)` 首次读取并校验 `parts.json`，缓存到内存；重复搜索直接命中缓存。
4. **释放**：`unloadPack(id)` 删除该包缓存，manifest 索引保留；下次访问按需重读。
5. **去重与 alias**：候选包按内置 → 用户顺序遍历，同一 part id 只返回一次；全局索引同样内置优先；`aliasOf` 条目不进入列表/计数，`getPartById(aliasId)` 会沿 alias 链解析到已登记的目标型号，自指或环返回 `undefined`。
6. **全局索引**：`getPartById(id)` 首次调用时懒建 `Map<partId, ComponentPart>`（加载所有启用的元器件包）；`loadPack/unloadPack` 会使索引失效并在下次查询重建。
7. **查询兜底**：`q` 命中 manifest 元数据时只加载命中包；完全没命中 manifest 时回退到全量型号/规格文本扫描，保证按型号检索不失效。
8. **价格簿**：没有 `parts.json` 的包不出现在 `listParts` 结果中，但仍计入 manifest 数量与数据包面板。

## 4. 指标口径

`PackRegistry.metrics()` 返回：

| 指标 | 口径 |
|------|------|
| `packLoadMs` | 累计读取 + JSON 解析 + 校验 `parts.json` 的耗时（不含 manifest） |
| `loadedPacks` | 当前缓存中的元器件包数量 |
| `partsLoaded` | 当前缓存中的条目总数（含跨包重复 id） |
| `searchMs` | 最近一次 `listParts` 的墙钟耗时（含按需加载） |
| `packCount` | 扫描到的 manifest 数量（含价格簿） |
| `indexedParts` | 已构建的全局 partId 索引条目数；未构建为 0 |

暴露位置：

- `npm run diagnose` 的 `packMetrics` 字段与「包加载」文本行；
- `npm run smoke`：`SMOKE_PACKS_LAZY_OK packs=10 loaded=2 searchMs=… coldMs=… parts=…` 与 `SMOKE_PACKS_COUNT servo=… sensor=… pneumatic=… vision=… drive=… safety=… frame=…`；
- 单测直接断言 `metrics()`。

当前实测目标：冷启动到可搜索 ≤ 120 ms；单包 `parts.json` ≤ 400 KB；10 包全量命中搜索 ≤ 25 ms。2026-10-24 新增 `safety-cn` / `frame-cn` 后由 `TZ=Asia/Shanghai npm test` 与 `npm run smoke` 复核；最大单包仍为 `iec-cn` 159.1 KB。

## 5. 导入与安全

- ZIP 导入前校验每个 entry 路径，拒绝 `../`、绝对路径、盘符；
- `id` 必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`，且与目录名一致；
- 与内置包 id 冲突时拒绝导入（内置优先）；
- manifest 缺字段、`categories/partsCount` 非法或 JSON 损坏时，该包只标记 `error`，不影响其他包；
- `parts.json` 在首次加载时校验；坏包不会进入缓存，下次搜索继续报错但不阻断其他包。

## 6. 新增一个包

1. `mkdir -p packs/builtin/my-pack`
2. 写 `manifest.json`：`id` 与目录名一致；补 `categories`、`partsCount`、`keywords`、`license`、`description`
3. 写 `parts.json`：每条至少 `id/model/category/specs`；参数写 `specs.数据来源`；有官方尺寸才写 `dims` 与 `dims.source`
4. 检查 `id` 在全部内置包中唯一，`category` 归入既有分类
5. 确认 `parts.json ≤ 400 KB`，否则拆包（如 `servo-cn-inovance` / `servo-cn-delta`）
6. 跑 `cd desktop && TZ=Asia/Shanghai npm test && npm run build:ext && npm run smoke`
7. 可选：`node desktop/scripts/gen-reference.mjs` 生成 `docs/reference/` 下的人读表格
