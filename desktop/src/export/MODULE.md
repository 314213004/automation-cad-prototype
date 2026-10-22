# 模块：导出（src/export/）

职责：把当前模型与校核结果导出为 BOM、DXF、GLB/OBJ 和 A3 PDF 报告。渲染层只生成数据，文件落盘统一走主进程 IPC。

## 文件分工

| 文件 | 作用 |
|------|------|
| `bom.ts` | `toCsv`（RFC 4180 转义）/ `toXlsx`（SheetJS） |
| `dxf.ts` | A3 图框 + 主视/俯视/左视包围盒投影（`dxf-writer`） |
| `mesh.ts` | three `GLTFExporter` / `OBJExporter` → Blob |
| `report.ts` | A3 横向可打印 HTML（项目信息 + BOM + 干涉 + 受力） |
| `file.ts` | 导出文件名/扩展名/路径校验（纯函数） |

## IPC 与产物

- `desktop.exportFile(name, data)` → `export:saveFile`：`showSaveDialog` 后写 `Uint8Array` 或字符串。
- `desktop.exportReport({ html, projectName })` → `export:report`：隐藏 `BrowserWindow` 加载报告 HTML，`printToPDF({ landscape:true, pageSize:'A3' })`，产物落 `userData/exports/<timestamp>/report.pdf`，同时保留 `report.html` 便于排查。
- 允许扩展名：`.pdf / .dxf / .glb / .obj / .csv / .xlsx`。
- 渲染层传入的默认文件名必须是纯文件名；含 `/`、`\\`、`..`、盘符或非法扩展名直接拒绝。

## 数据与格式约定

BOM 列固定：`序号 / 名称 / 型号 / 数量 / 材料 / 备注`。CSV 对逗号、双引号、换行做双引号包裹与 `""` 转义；XLSX 写单 sheet `BOM`。

DXF 单位 mm，图框 420×297，三视图用包围盒矩形/圆近似，不做 B-rep 投影。GLB 用二进制，OBJ 用文本，零件名写入 object 名。

## 坑点

1. **不要把 Node API 带进渲染层**：写入、对话框、打印全在主进程；渲染层只传 `Uint8Array|string`。
2. `xlsx` 体积大，当前打进扩展 IIFE；后续可改异步分包，但不要为省体积牺牲 CSV 转义/XLSX 可读性。
3. PDF 报告必须用 A3 横向；HTML 内已写 `@page { size: A3 landscape; margin: 0 }`。
4. `printToPDF` 结果是空 Buffer 时要抛错，不能返回假成功路径。
5. DXF 只是二维初稿，斜置零件的包围盒投影会偏大，报告/UI 应注明「包围盒近似」。
6. 保存路径的扩展名在写盘前再校验一次，防止用户把 `.csv` 改成 `.exe`。

## 进度

- ✅ CSV/XLSX（转义、xlsx 回读单测）
- ✅ DXF 图框三视图（SECTION/ENTITIES 单测）
- ✅ GLB/OBJ 导出入口（当前 viewer 场景，WebGL 降级时用解析数据重建临时 Group）
- ✅ A3 横向 PDF 报告 + `userData/exports` 归档
- ✅ 文件名安全校验（路径穿越/非法扩展名单测）
