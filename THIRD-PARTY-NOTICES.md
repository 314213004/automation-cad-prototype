# 第三方组件声明 / Third-Party Notices

本仓库的**源码**以 GNU GPL v3 许可证发布（见根目录 `LICENSE`）。随安装包分发的下列第三方二进制组件各有自己的许可证，
其条款覆盖对应组件本身，并且对再分发有约束。

## LibreDWG WASM（DWG 读取）

- 组件：`@mlightcad/libredwg-web`（LibreDWG 的 WebAssembly 构建 + JS 包装）
- 版本：0.8.2（打包时以 `desktop/vendor/dwg/libredwg-web` 形式随安装包分发到 `resources/dwg/`）
- 许可证：**GPL-3.0**
- 上游：
  - https://github.com/mlightcad/libredwg-web
  - https://www.gnu.org/software/libredwg/
- 用途：仅用于把 DWG 转成 DXF（`desktop/electron/dwg.ts` + `desktop/electron/dwg-convert.mjs`），
  运行在独立子进程里，不链接主程序代码。

**分发影响**：GPL-3.0 具有传染性。若对外分发包含此组件的安装包，整个发行物需按 GPL-3.0
提供对应源码。不开源分发时的替代做法：

1. 打包时跳过该组件（不执行 `desktop/scripts/vendor-dwg.mjs`，或删除 `vendor/dwg`）；
2. 由用户自行安装 ODA File Converter（免费，闭源）或 LibreDWG 命令行；
3. 程序在缺少转换器时会给出可执行指引，并提示「另存为 DXF」这条零依赖路径。

## 其他运行期依赖

| 组件 | 许可证 | 用途 |
|------|--------|------|
| Electron | MIT | 桌面运行时 |
| three.js | MIT | 3D 渲染 |
| occt-import-js（OCCT WASM） | LGPL-2.1 | STEP / IGES / BREP 解析 |
| build123d / OCCT（参数化 sidecar） | Apache-2.0 / LGPL-2.1 | 参数化建模与 STEP/STL 导出 |
| FreeCAD 1.x（可选，用户自行安装，不随包分发） | LGPL-2.1+ | 工程图（TechDraw）等后台任务；仅以独立进程 `freecadcmd` 调用，随包只带作业脚本 `resources/freecad/techdraw_job.py` |

数据包（`packs/builtin`）中的型号与参数为公开样本整理，非厂商授权数据，商用前请自行核对。
