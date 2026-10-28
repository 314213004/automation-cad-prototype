# AutomationCAD Qt 客户端（v0.1 壳子，开发中）

状态说明（写给接手的开发者，先读再动手）：

- 本目录是 Qt6 新客户端的起点，不是完成品。布局已按 SolidWorks 式五区搭好：
  左侧 FeatureManager 设计树、顶部菜单 + 特征工具栏、中间 3D 视口占位、
  右侧 PropertyManager 属性面板、底部状态栏。
- 视口目前是占位 QWidget，OCCT AIS Viewer **尚未接入**；不要宣称已实现 3D 拾取/渲染。
- 本机 Linux 虚拟机暂无 Qt6 工具链，本工程**未在此编译**；需在装有 Qt6（Widgets + Network）
  的 Windows / Linux 机器上用 CMake 构建验证（见 `CMakeLists.txt`）。
- 数据契约：见仓库 `docs/featuretree-contract.md`（草案 v0.1）。客户端不持有可独立写回的
  树副本；一切写操作走 `featuretree-service`（默认 `http://127.0.0.1:18080`），
  带 `expectedRevision`，409 冲突时提示重新读取，禁止自动覆盖。

## 本地跑法

1. 启动契约服务（与本客户端同仓的 `../featuretree-service`）：

   ```sh
   cd ../featuretree-service
   node server.mjs          # 默认 127.0.0.1:18080，仅本地回环
   node tests.mjs           # 契约验收用例，应全部通过
   ```

2. 构建客户端（需 Qt6）：

   ```sh
   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
   cmake --build build
   ./build/automationcad-qt
   ```

3. 在客户端里点特征、改属性面板数值，即走一次 `POST /v1/operations`；
   服务端版本 +1 后界面以返回的包络全文刷新。

## 下一步（按契约第 15 节未定项推进，不要擅自默认）

- OCCT AIS 视口接入（拾取、高亮、剖切）；
- 草图对象与 SolveSpace 求解器（契约只占了字段位，v1 提交 `sketch` 会被拒绝）；
- 拓扑命名稳定层（圆角/配合引用不断链）；
- 工程包磁盘文件布局、变更事件传输方式（SSE / 长轮询）的最终拍板。
