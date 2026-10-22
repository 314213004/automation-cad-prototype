# 元器件资料库（reference/）

存放**给人看**的元器件参数资料；**给程序读**的数据在 `packs/builtin/<pack-id>/`。

| 目录/文件 | 用途 |
|-----------|------|
| `electrical-components.md` | 内置元器件型号与关键参数（由 `desktop/scripts/gen-reference.mjs` 汇总生成） |
| `packs/builtin/iec-cn/` | 电气元件数据包（插件，程序按需加载） |
| `packs/builtin/smc-cn/` | 气动元件数据包（气缸/电磁阀/磁性开关等） |

## 数据口径

- 参数取自厂商公开样本的**常用值**，用于选型与原理图设计参考；
- 不同批次或新旧版本可能有差异，**定型前以铭牌/最新样本为准**；
- 价格类字段不写入仓库（波动大且易过期），由采购系统维护。

## 更新流程

1. 修改 `packs/builtin/<id>/parts.json`（程序读的就是它）；
2. 跑 `node desktop/scripts/gen-reference.mjs` 重新生成 `electrical-components.md`（可选，保持人读版同步）；
3. `npm test`（会校验 manifest、id、字段合法性与 id 唯一性）。

## 新增一个数据包（插件）

见 `docs/desktop/PLUGIN-PACKS.md`：复制一个现有包 → 改 `manifest.json` 的 `id/name/vendor/version` → 填 `parts.json` → 在「数据包」面板导入或放入 `packs/builtin/`。
