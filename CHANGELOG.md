# 更新日志

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化版本。

## [0.4.2] - 2026-10-25

### Fixed · 联机调试与渲染可观测性

- **CDP 内网可达**：Electron 会忽略 `--remote-debugging-address=0.0.0.0`，实际只绑回环。改为普通启动常驻 `127.0.0.1:9229`，白名单开关命中来源后再由 `cdp-forwarder` 转发到 `0.0.0.0:9222`；未命中来源返回拒绝并写审计 `cdp_access_check`。支持运行中热启停，不必重启进程。
- **token 生命周期**：启动复用已有 token（原实现每次启动重写，重启一次就得重新取 token）；文件损坏时重建；面板提供显式「重新生成」，旧 token 立即失效。
- **渲染指标**：新增 `get_render_stats` 只读工具（工具数 21 → 22），暴露渲染器字符串、是否软件渲染、像素比、质量档、零件/三角面数与拖动帧时间（均值/峰值/时间戳），同一份数据进 `/health.render`；检测到 SwiftShader 等软件渲染时自动降到 `flow` 档。

### Added · 跨平台验证

- `npm run smoke:win` / `npm run diagnose:win`：Windows 本地 headless 入口（关闭 GPU 走 SwiftShader），使「无 WebGL 降级面板」这条断言在 Windows 开发机上也能被真实覆盖；README 补对应说明。

### Verification

- `npx tsc --noEmit` 0 错误；`TZ=Asia/Shanghai npm test` **1842 总计 / 1838 通过 / 0 失败 / 4 跳过**（4 条是 `0600` 文件权限断言，Windows 无 POSIX 位；Linux 上为 1842/1842）；`build:ext` 通过。
- Windows 实跑 `npm run smoke:win`：**85 条 `SMOKE_*_OK` + `SMOKE_OK`**，退出码 0；`SMOKE_RENDER_STATS_OK gl="ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" parts=11 triangles=4832 quality=flow`，拖动平均 42 ms/帧。

## [0.4.1] - 2026-10-25

### Added · 桌面可用性

- **界面缩放**：智能体面板新增 6 档缩放（100%–150%），默认 **115%**（原 UI 偏小）；注入式 `html { zoom }` 实现，不改根目录原型样式；切换即生效并联动 3D 视口 resize；持久化 `userData/appearance.json`。
- **3D 渲染质量**：`flow / standard / high` 三档（像素比上限 1.0 / 1.5 / 2.0）；拖动旋转期间固定降采样到 0.8、松手 200 ms 恢复；启用 `powerPreference: high-performance`；零件数 > 1500 自动降级为 flow。
- **局域网联调（默认关闭）**：开关打开后 Agent JSON-RPC 绑 `0.0.0.0:7420`，来源必须先过 CIDR/单 IP 白名单再看 Bearer token，未命中返回 403 `LAN_NOT_ALLOWED` 并写审计；远程写操作仍弹本机确认框；`/health` 不返回 token。
- **远程调试 CDP（默认关闭）**：开关打开后下次启动监听 `0.0.0.0:9222`，面板显示端口、需重启状态与高风险警告。
- **联调探测脚本** `desktop/scripts/lan-debug-probe.mjs`：依次校验 `/health`、`tools/list` 与只读 `list_components`，成功输出 `LAN_DEBUG_OK`。

### Verification

- `npx tsc --noEmit` 0 错误；`npm test` **1831/1831**；`build:ext` 通过；`SMOKE_OK`（含 `SMOKE_UI_SCALE_OK` / `SMOKE_RENDER_QUALITY_OK` / `SMOKE_LAN_SWITCH_OK` / `SMOKE_LAN_ALLOWLIST_OK`）；`EVAL_AGENT_OK 1.00`。

## [0.4.0] - 2026-10-25

> 已发布：GitHub Release `v0.4.0`，Windows 安装包 `AutomationCAD-Setup-0.4.0.exe`（NSIS，未签名，约 130 MB），由 `windows-build` 在 `windows-latest` 上构建（1810 单测 / 0 失败）。

### Added · 可选模块门控与工程安全（PR #9）

- **模块 registry + 运行时启停**：8 个可选模块（`cost.estimation`、`elec.validation`、`plcgen`、`parametric.import`、`factory.plc-sync`、`agent.resume`、`project.portable`、`system.update`）统一注册，默认全启用；门控只隐藏/禁用对应入口与 Agent 工具，不卸载代码。`ipcMain.on('modules:sync-*')` 同步通道在 `createWindow()` 之前注册。
- **工程档案（project archive）**：`.acproj` v2 打包/预览/导入，导入走临时目录 + 校验 + 原子替换。
- **CAD 导入事务回滚**：导入失败回滚到导入前状态，不留半成品装配体。
- **更新通道**：`update-service` 支持 `latest.yml` + blockmap 的检查/下载/安装路径（未做真实签名与跨版本升级验收）。
- **PLC 校验补强**：数值范围与空序列校验，空序列不再生成空程序。
- 107 个文件、+11693/−442。

### Security

- **Agent IPC 传输安全（PR #6）**：所有 `ipcMain.handle` 走可信 sender 校验（`isTrustedIpcSender`），渲染层 URL 白名单（`isTrustedUiUrl`），MCP/RPC 写操作统一授权（`authorizeAgentToolCall`），API Key 传输策略 `assertSafeApiKeyUrl` 泛内网段放行 HTTP（10/8、172.16/12、192.168/16、169.254、IPv6 ULA/链路本地），仅公网强制 HTTPS。
- 设计包同步限制单包体积（`MAX_DESIGN_PACKAGE_BYTES`），`.acproj` 导入做路径穿越与大小校验。

### Added · 机型设计与元件库（迭代 37–48）

- 整机形态库扩到 **11 种**（工艺 × 布局 × 机型），选型优先级为「工位覆盖 → 产能达标 → 工艺适配 → 布局偏好（仅同分）→ 占地」，候选产能夹紧到自身工位范围，禁止越界形态凭虚高吞吐入选。
- 统一功率/成本模型：按实际选型额定功率 × 同时系数 0.7 / 负载率 0.6 / 效率 0.9 / cosφ 0.9 计算 kW、VA、计算电流、断路器建议与 24V 余量；成本分项与缺价计数进入方案卡。
- 元件库扩到 **9 个内置包 / 617 型号**（新增 `vision-cn`、`drive-cn`、`safety-cn`、`frame-cn`），保留按需懒加载：启动只读 manifest，命中包才读 `parts.json`，`partsSha256` 校验完整性。
- 价格簿扩到真实分销价条目，案例 BOM 覆盖率提升；缺价项照实计入「待询价」，示例价自动排除。

### Fixed

- **Windows CRLF 检出不误判 integrity**：Windows runner 的 `core.autocrlf=true` 会把 `packs/builtin/*/parts.json` 检出为 CRLF，而 `manifest.partsSha256` 按 LF 计算，导致 `PACK_INTEGRITY_FAILED` 使全部内置包加载失败（CI 18 个用例红）。`assertPartsIntegrity` 与 `scripts/pack-stats.mjs` 统一 `CRLF→LF` 后再取 SHA-256，并新增根目录 `.gitattributes` 对文本文件强制 `eol=lf`；新增回归用例覆盖 CRLF 字符串与 Buffer（`ba5787a`）。

## [0.3.0] - 2026-10-23

> 已发布：GitHub Release `v0.3.0`，Windows 安装包 `AutomationCAD-Setup-0.3.0.exe`（NSIS，未签名，129 MB），由 `windows-build` 手动触发在 `windows-latest` 上构建（1248 单测 / 0 失败）。

> 说明：能力条目均附真实提交号；本次发版追加的整机 3D 能力见下方「Added · 整机 3D」。

### Added · 整机 3D（迭代 34–36，PR #4）

- 机型方案生成参数化整机几何：`machine/geometry.ts` 由 `MachineConfig` 生成 mm 级整机（机架、工位、气缸、夹爪、转台、传感器、光栅、输送线）与运动轴元数据，导出 STL / glTF / build123d sidecar 清单，STEP 由内核实体化（`bd5adc1`）。
- 主视图可旋转 three.js 3D：`src/orbit/` 注入扩展提供旋转/缩放/平移、六向标准视图、透视↔正交、剖切、树↔3D 双向选择与属性实时改几何，无 WebGL 时回退原型 SVG，原型 `index.html` / `app.js` / `styles.css` 零改动（`5fb16f9`）。
- STEP 装配体运动件自动识别：按零件名/型号、装配层级与几何推断轴向、行程、置信度与中文理由，只出建议、逐条采纳才写标注（`bcef010`）。
- Agent 只读工具 `suggest_kinematics`（工具数 20 → 21），命令 → 渲染桥 → 标注抽屉，`applied=false` 从不写标注（`310f164`）。
- KB 容量治理：BACKLOG 历史归档不入索引，`kb.json` 约 408 KB → 363 KB，新增「索引留 ≥5% 余量」守卫（`310f164`）。

### Fixed · 合并前复查

- STEP 实体化把水平圆柱按等截面方棒近似时写中文 warning 点名零件并透出 `approximatedIds`；`solids/` 上一次遗留的 `part-N.step` 先入撤销快照再清理（`192983e`）。
- Windows CI 上 4 条平台脆弱断言（文件名时间戳写死 `+08:00`、`/tmp` 路径、sidecar 脚本分隔符正则）改为时区/分隔符无关（`823caf4`）。

### Added

- 电气元件库扩展至 371 型号 / 26 分类，并补充 191 个可核实的真实外形尺寸与导轨 / 模数信息（`e6f354f`、`31530ac`、`acca35a`、`9e9cabd`、`d8e12c5`、`d5713b6`、`337559b`、`7cc1e86`、`cb9c5d3`、`8729688`）。
- 电箱底板真实尺寸画布：毫米坐标、1 mm 吸附、35 mm 导轨、重叠标红、利用率统计、JSON 导出（`df8f1a2`、`b4bf1a1`）。
- 电气合规校验：线号合规、功率统计、导线截面与断路器配合校验，配套 9 卡面板、A3 PDF 报告与 Agent 工具 `run_electrical_check`（`5352832`、`652e031`）。
- STEP 运动学标注：动件 / 轴类型 / 方向 / 行程 / 缩回位 / IO 点位绑定，中文校验、姿态解算、滑块预览与 JSON 导入导出（`8d5835d`、`b0e6df3`）。
- 3D 联调新增故障诊断规则与诊断面板（`e1e02c9`）。
- 成本统计闭环：价格簿与纯函数引擎（`a8c1e5f`）、成本面板与 A4 / CSV 报告（`6d70ae7`）、Agent 工具 `run_cost_report`（`a66b26e`）与 `export_cost_report`（`23cd284`）。
- 自然语言 Agent：离线规则路由、上下文裁剪、NDJSON 审计（`424711c`）、侧栏只读问答与审计面板（`b3b9aee`）、底板放置 `place_component` 与撤销联动（`1c356e9`）、离线多步规划与计划卡片执行（`e70ef77`）、46 条中文评估集（`cb3cc93`）。
- PLC 程序自动生成：预检、IO 变量表、五个基础 ST 块（`b36635b`）、自动序列 / 报警 / 安全 FC 与 11 文件汇总（`ccbd0fc`）、生成 UI / 文件树 / zip 导出 / 最近 10 次历史（`1f50bac`）、内置模拟器执行联调序列与 Agent 工具 `verify_plc_program`（`a6b0534`）。
- 参数化建模：选定 build123d 内核与 sidecar 契约（`5c2a8c3`、`371e6f0`）、主进程生命周期与 IPC（`9eda660`）、特征树 / 参数表单 / 防抖重建 / STEP+STL 导出（`8867853`）、多实体装配与 BOM / 成本联动（`449d060`）。
- CAD 大装配渲染批次层：实例化合批、视锥剔除、LOD 分级与 10 万面基准（`f6962b3`、`71c0e9b`）。
- 原型侧零件插入、约束建议与多步撤销（`7d98af5`）。
- 桌面端 14 张真实 Electron 截图与一键截图脚本（`e409ea8`）。
- 智慧工厂设计同步本地端到端脚本与验证记录（`ce11575`）。

### Changed

- 桌面版本号由 `0.2.0` 升至 `0.3.0`（`desktop/package.json`、`desktop/package-lock.json`；本次发版准备，未提交）。
- 3D 联调由写死零件改为机型配置驱动，并在有运动学标注时优先使用标注（`71b5e18`、`b0e6df3`）。
- Agent 工具注册表由 7 个扩展到 12 个，离线多步计划统一走同一工具注册表（`424711c`、`b3b9aee`、`1c356e9`、`e70ef77`、`a6b0534`）。
- 质量基线由 301 个单测提升到 674 个单测，并补充 PLC 生成、参数化装配、智能体规划等冒烟断言（`b36635b`、`ccbd0fc`、`1f50bac`、`a6b0534`、`8867853`、`449d060`、`e70ef77`）。
- 汇报材料由 18 页扩展到 19 页，补充 PLC 程序生成与参数化建模能力边界（本次发版准备，未提交）。

### Fixed

- 收紧智慧工厂同步字段契约，明确 `deviceId` / `createdAt` / `qty` 的校验口径（`68f5186`）。
- 参数化假内核脚本移出 `test/`，避免被 `node --test` 当作测试执行，并修正 smoke 版本判定（`18c353b`）。

## [0.2.0] - 2026-10-22

- 机械校核 / 导出 / PLC / 联调 / 智慧工厂同步基线版本；NSIS 安装包随 `v0.2.0` 发布（`552fd5a`）。
