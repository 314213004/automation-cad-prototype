# 项目状态 · 2026-10-25

## 概览

- 基线：`main` 已发布面到 **v0.4.2**（CDP 内网可达、token 生命周期、渲染性能可观测性 + Windows 本地 smoke 入口）；0.4.2 安装包在 Windows 开发机（192.168.2.117）本地构建，未走 CI、未打 tag。
- 版本：`desktop/package.json` → **0.4.2**；界面缩放 / 3D 渲染质量 / 局域网联调 / CDP 保持默认关闭。
- 测试：`TZ=Asia/Shanghai npm test` **1842 总计 / 1838 通过 / 0 失败 / 4 跳过**（Windows 无 POSIX 位，`0600` 权限断言跳过；Linux 上 1842/1842）。
- 构建与冒烟：`npm run build:ext` 通过；fake-sidecar smoke 输出 `SMOKE_OK` 与 `SMOKE_RENDER_STATS_OK`，渲染指标经 IPC → 主进程缓存 → `/health.render` → `get_render_stats` 全链路验证。
- 评估：`npm run eval:agent` **107/107 通过**，`EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
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

## 已知限制

1. **参数化内核依赖 Python**：build123d sidecar 需要本机 Python 与 `spike/build123d/app.py`；安装包只带脚本，不内置解释器。未设置 `AUTOMATIONCAD_PYTHON` 或 PATH 不可用时，参数化面板返回不可用状态。
2. **价格簿为示例价**：内置价格簿条目标注「示例，需替换」，引擎自动排除示例价；正式报价前必须导入企业价格表（D1）。
3. **运动学需人工标注**：STEP/IGES/BREP 不含动件、轴、行程与 IO 绑定；未标注时 3D 联调回退到机型配置，不能从几何自动推导。
4. **生产环境不可达**：设计同步后端 0.22.0 已实现并通过 30 项测试，本地临时 DB 端到端通过；生产实例 `221.231.106.194:5556` 从开发机不可达，线上部署/HTTPS/真实网络未验证（D2）。
5. **生产安装包未签名/更新未验收**：更新通道 MVP 已接入，但本地没有真实 Windows Authenticode 凭据；tag 发布会因缺少 `CSC_LINK` / `CSC_KEY_PASSWORD` 安全阻断。尚未在 Windows 上完成签名者、SHA-512、stable/beta、NSIS blockmap 差分与完整包回退的真实升级验收；详见 [update-channel.md](../../desktop/docs/update-channel.md)。
6. **工业协议未接真机**：OPC UA 仅 `SecurityPolicy=None`；MQTT 未连真实 broker；Modbus TCP 未连真机（仿真器已实测）。
7. **干涉为 AABB 初筛**：不是精确布尔求交；贴合面、螺纹啮合可能误报，需要白名单收口。
8. **智能体真实模型兼容性有限**：只按 OpenAI 兼容协议、用本地假服务验证；不同服务商差异需逐个补测。离线路由是关键词规则，不是语义理解。
9. **审计不轮转**：`agent-audit.jsonl` 只追加，未做轮转与保留期清理；审计面板只列最近 8 条，无筛选/导出，回执不含 token 用量。
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
npm test                            # 1842 条单测/集成测试
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
