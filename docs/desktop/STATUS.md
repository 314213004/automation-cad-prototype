# 项目状态 · 2026-10-25

## 概览

- 基线：`main` 已发布面到 **v0.4.2**（CDP 内网可达、token 生命周期、渲染性能可观测性 + Windows 本地 smoke 入口）；当前 `desktop/package.json` 为 **0.5.0**（电气出图引擎 + 整机设计五步向导 + CI/文档守卫），已打源码 tag `v0.5.0`，安装包仍未构建。
- 版本：`desktop/package.json` → **0.5.0**；界面缩放 / 3D 渲染质量 / 局域网联调 / CDP 保持默认关闭。
- 测试（2026-10-26 本机 Linux 实跑）：`npx tsc --noEmit` 0 错误；`npm test` **1967 总计 / 1967 通过 / 0 失败 / 0 跳过**。
- 构建与冒烟：`npm run build:ext` 通过；`xvfb-run npm run smoke` 收尾 `SMOKE_OK`，`SMOKE_DESIGN_WIZARD_OK steps=5`、`_CANDIDATES_OK count=3`、`_LAYOUT_OK placements=13 overlaps=0`、`_SAVE_OK project=Smoke-整机设计`，不再出现 `SMOKE_DESIGN_SCENE_BRIDGE_WARN`。
- 评估：`npm run eval:agent` **109/109 通过**，`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`；`docs/desktop/eval/cases.json` 已覆盖注册表全部工具（含 `build_machine_model` 的 bm01/bm02）。
- 离线知识索引：`npm run kb:build` → `KB_BUILD_OK docs=13 chunks≈348 bytes≈383 KB`（约占 400 KB 上限的 93.6%，满足单测要求的 5% 余量）。
- 最近发布：`v0.4.0` NSIS `AutomationCAD-Setup-0.4.0.exe`（约 130 MB，未签名）；上一版 `v0.3.0`。更新通道代码已随模块门控落地，但未做真实签名与跨版本升级验收。

## 验证记录（本轮真实执行）

| 命令 | 结果 |
|------|------|
| `TZ=Asia/Shanghai npm test`（Windows 192.168.2.117） | 1838 pass / 0 fail / 4 skipped（`0600` 权限断言） |
| `npx tsc --noEmit` | 0 错误 |
| `npm run build:ext` | 通过（`tsc --noEmit`、Vite 扩展、Electron main/preload、MCP） |
| `AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` | 通过；`SMOKE_RENDER_STATS_OK gl="…SwiftShader…" parts=11 triangles=4832 quality=flow`、最终 `SMOKE_OK`；退出码 0 |
| `npm run eval:agent` | 107/107；`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00` |
| `node scripts/lan-debug-probe.mjs` | 在 `test/agent/lan-rpc.test.mjs` 的临时真实 HTTP 服务上完成 health / tools/list / `list_components`，输出 `LAN_DEBUG_OK` |
| `npm run smoke:win`（Windows） | 通过；85 条 `SMOKE_*_OK` + `SMOKE_OK`，退出码 0（`--disable-gpu` 走 SwiftShader，覆盖无 WebGL 降级面板） |
| `git diff --check` | 通过（提交前复核） |
| `npx tsc --noEmit`（2026-10-26 Linux 主线） | 0 错误 |
| `npm test`（2026-10-26 Linux 主线） | 1967 / 1967 通过，0 失败、0 跳过 |
| `xvfb-run npm run smoke`（2026-10-26） | 退出码 0，`SMOKE_OK`；5 条 `SMOKE_DESIGN_*` 带具体数字，无 `SCENE_BRIDGE_WARN` |
| `npm run eval:agent`（2026-10-26） | 109/109；`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00` |

**跨平台行尾修复（2026-10-24）**：Windows 的 `core.autocrlf=true` 把 `packs/builtin/*/parts.json` 检出为 CRLF，`partsSha256` 按 LF 算 → `PACK_INTEGRITY_FAILED`，内置包全挂（CI 18 红）。修复：`assertPartsIntegrity`、`scripts/pack-stats.mjs` 统一 `CRLF→LF` 后取 SHA-256，加 `.gitattributes` 强制 `eol=lf`；回归用例见 `test/packs/lifecycle.test.mjs`。

Smoke 在 fake sidecar 退出时记录一次非致命动态端口 `ECONNREFUSED` 重试；断言全过、退出码 0。

## Smoke 断言（本轮新增）

以下为本轮实际输出；完整历史断言矩阵见 [STATUS-HISTORY.md](STATUS-HISTORY.md#smoke-断言清单)。

| 断言 | 实测 |
|------|------|
| `SMOKE_UI_SCALE_OK` | `scale=1.15` |
| `SMOKE_RENDER_QUALITY_OK` | `quality=standard draggingRatio=0.8` |
| `SMOKE_LAN_SWITCH_OK` | `enabled=false host=127.0.0.1 allowlist=1` |
| `SMOKE_LAN_ALLOWLIST_OK` | `allowed=1 denied=0` |
| `SMOKE_RENDER_STATS_OK` | `gl="ANGLE (… SwiftShader …)" parts=11 triangles=4832 quality=flow` |
| `SMOKE_RENDER_STATS_HEALTH` | `{"isSoftware":true,"quality":"flow","partCount":11,"triangleCount":4832,"dragAvgFrameMs":42,...}` |
| `SMOKE_OK` | 全部 smoke 分支完成后输出 |

## 模块状态（P1–P9）

图例：✅ 完成；🔄 主体完成、仍有明确待办；⏸ 暂停/未启动。

| 阶段 | 状态 | 范围 | 提交号 | 备注 |
|------|------|------|--------|------|
| P1 电气智能辅助 | ✅ | 线号合规、功率统计、导线截面/断路器校验、面板与 PDF、Agent 工具 | `5352832`、`652e031` | 规则与面板闭环 |
| P2 电箱底板画布 | ✅ | 真实尺寸布局、拖放、导轨吸附、碰撞、利用率 | `df8f1a2` | 尺寸覆盖 244/371（16 条同系列推定） |
| P3 联调 3D 通用化 | ✅ | 配置驱动 4 工位 / 12 执行机构 / 16 传感器；运动学标注与滑块预览 | `8d5835d`、`b0e6df3`、`71b5e18` | STEP 无运动学时需人工标注 |
| P4 大模型性能 | ✅ | 渲染规划（合批/视锥/LOD）与视图器接入、10 万面基准 | `f6962b3`、`71c0e9b` | 纯函数规划 + 批次层 |
| P5 智慧工厂服务端 | 🔄 | 设计包 ZIP/manifest/幂等/上传/列表/diff/下载；本地端到端 | `0a1733e`、`ce11575` | 生产实例不可达，待 D2 |
| P6 硬件成本统计 | 🔄 | 价格簿、引擎、面板、A4/CSV 导出、Agent 工具与落盘 | `a8c1e5f`、`6d70ae7`、`a66b26e`、`23cd284` | P6-5 采购价对接待 D2 |
| P7 自然语言交互 Agent | ✅ | 离线路由、上下文裁剪、审计、只读问答、底板放置、多步规划、工具扩展、本地知识检索、机型方案合成与落盘联动 | `424711c`、`b3b9aee`、`1c356e9`、`e70ef77` | 22 工具（只读 12 / 写 10）；新增只读渲染指标；真实模型仅按 OpenAI 兼容协议验证 |
| P8 PLC 程序生成 | 🔄 | 预检、变量表、五个基础块、自动序列/报警/安全、11 文件、UI/zip/历史、模拟器 | `b36635b`、`ccbd0fc`、`1f50bac`、`a6b0534` | P8-5 厂商工程文件未做 |
| P9 参数化建模 | 🔄 | build123d sidecar、特征树、防抖重建、STEP/STL、多实体装配与 BOM/成本联动 | `5c2a8c3`、`9eda660`、`8867853`、`449d060` | P9-4 草图约束未做；依赖 Python |

补充：P10 产品截图更新已完成（`e409ea8`）；机型全流程截图新增 15–18，共 18 张 Electron 实跑截图位于 `docs/desktop/screenshots/`。六工位案例见 [MACHINE-DESIGN-DEMO.md](MACHINE-DESIGN-DEMO.md)。

## 整机设计向导改进（2026-10-26，PR 候选）

基于原始 HEAD `99bc0e8` 的本地功能改动，已整理到最新 `origin/main` 上的 PR 候选；非生产验收。第 4 步真实几何支持选站及 X/Y mm 输入/拖动；整组零件、origin/workPoint、轴 pivot 和包络同步更新，3D、工程 JSON、逐件 STL 共用偏移；示意 placements 独立。

工位以 `MachineDesign.stationIdentities` 固定身份关联；偏移 schema v2 按身份键保存。改名/重排保留合法偏移，删除只清理失效身份，新工位零偏移；需求重算/候选切换不按名称或序号迁移。旧 v1 偏移安全清除但工程仍可读取，并在向导提示重新定位。身份映射/偏移纳入 review signature；坏坐标/映射 fail-closed，不改几何尺寸、形状或行程。仍是概念占位体，非型号 CAD。

新增第 4 步独立概念运动提醒：使用偏移后的几何，未知轴标未覆盖；候选 AABB 仅供工程师复核，不写 review pass/errors、不签核。细节见 [MACHINE-DESIGN.md](MACHINE-DESIGN.md)。

**候选验证（Linux）**：`TZ=Asia/Shanghai npm test` 2091/2091；`npm run build:ext`、`npm run smoke`（`SMOKE_OK`，含 `SMOKE_DESIGN_VIEWPORT_FALLBACK_OK scene=61 triangles=0 parsedMeshes=61 viewport=unavailable`）与 `git diff --check` 通过。`npm run kb:build` 为 13 份文档、345 个 chunks、381622/409600 bytes（93.17%，余量 27978 bytes），未截断。B-rep/结构/节拍/工程签核未完成，AABB 非精检，Windows smoke 未跑。

## 已知限制

1. **参数化内核依赖 Python**：build123d sidecar 需要本机 Python 与 `spike/build123d/app.py`；安装包只带脚本，不内置解释器。未设置 `AUTOMATIONCAD_PYTHON` 或 PATH 不可用时，参数化面板返回不可用状态。
2. **价格簿为示例价**：内置价格簿条目标注「示例，需替换」，引擎自动排除示例价；正式报价前必须导入企业价格表（D1）。
3. **运动学需人工标注**：STEP/IGES/BREP 不含动件、轴、行程与 IO 绑定；未标注时 3D 联调回退到机型配置，不能从几何自动推导。
4. **生产环境不可达**：设计同步后端 0.22.0 已实现并通过 30 项测试，本地临时 DB 端到端通过；生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署/HTTPS/真实网络未验证（D2）。
5. **生产安装包未签名/更新未验收**：更新通道 MVP 已接入，但本地没有真实 Windows Authenticode 凭据；tag 发布会因缺少 `CSC_LINK` / `CSC_KEY_PASSWORD` 安全阻断。尚未在 Windows 上完成签名者、SHA-512、stable/beta、NSIS blockmap 差分与完整包回退的真实升级验收；详见 [update-channel.md](../../desktop/docs/update-channel.md)。
6. **工业协议未接真机**：OPC UA 仅 `SecurityPolicy=None`；MQTT 未连真实 broker；Modbus TCP 未连真机（仿真器已实测）。
7. **干涉为 AABB 初筛**：不是精确布尔求交；贴合面、螺纹啮合可能误报，需要白名单收口。
8. **智能体真实模型兼容性有限**：只按 OpenAI 兼容协议、用本地假服务验证；不同服务商差异需逐个补测。离线路由是关键词规则，不是语义理解。
9. **审计回执仍无 token 用量**：审计已按大小轮转并清理保留期（默认 5 MB × 5 份 × 90 天）；CSV 只导出当前列表，回执不含 token 用量。
10. **CI 仅手动触发**：`gh workflow run windows-build --ref main`；未配置 push/PR 自动构建。
11. **便携包偏大**：Electron 45 + node-opcua，解压后数百 MB；可考虑按需懒加载或 sidecar。
12. **原型固有投影限制（桌面版已部分缓解，35-orbit-view）**：有 WebGL 时主视口为可旋转 three.js，属性编辑沿叠放链改几何；仍是参数化示意体而非 B-rep，插入件为示意占位体；无 WebGL 时回到固定等轴测。
13. **无 WebGL 的 headless 截图**：xvfb 下 Chromium 将 WebGL 列入 blocklist，CAD 3D 区域显示解析统计降级面板；参数化/PLC/成本/底板面板仍为真实 DOM/SVG 渲染。

## 待决策索引（D1–D8）

完整选项、影响与建议见 [BACKLOG.md](BACKLOG.md) 的「待决策」表。

| # | 待决策 | 状态 |
|---|--------|------|
| D1 | 价格簿真实单价来源 | 待定 |
| D2 | 智慧工厂生产环境由谁部署 0.22.0 | 待定 |
| D3 | PLC 程序生成首期目标平台 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | 待定 |
| D5 | 缺失尺寸能否用同系列壳体推定 | 待定 |
| D6 | 参数化建模首期范围 | 待定 |
| D7 | 成本面板的 CAD 零件名 → 物料号映射口径 | 待定 |
| D8 | Agent 是否允许落盘导出成本报告 | 已定 B，已实现（`23cd284`） |

BACKLOG 另含 D9（离线规则是否在模型可用时前置）与 D10（评估集跑基线的通道），本轮未改变其状态。

## 验证命令速查

```bash
cd desktop
npx tsc --noEmit                    # 类型检查
npm test                            # 2088 条单测/集成测试
npm run build:ext                   # tsc + Vite + Electron main/preload + MCP
npm run smoke                       # xvfb + Electron headless（无 WebGL，Linux）
npm run smoke:win                   # Windows headless（关 GPU 走 SwiftShader）
AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
npm run eval:agent                  # 107 条中文 Agent 评估集
npm run sync:e2e                    # 本地临时 DB 的设计同步端到端
npm run screenshots                 # 真实 Electron 截图（14 张）
npm run screenshots:machine         # 机型全流程截图（15–18，离线桩 + 真实 Electron）
```

本轮加固的逐项代码改动与原因见 [HARDENING.md](HARDENING.md)。
