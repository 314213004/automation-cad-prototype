# 迭代历史归档（BACKLOG-HISTORY）

从 [BACKLOG.md](BACKLOG.md) 移出的已完成迭代记录，原文保留、按时间倒序。本文件**不进入**智能体离线知识索引（`desktop/src/agent/kb/index.ts` 的 `KB_DOC_FILES`），需要时直接打开阅读。

## 并行三条：Agent 打磨 / 主视口 3D 收尾 / 元件库补录（integ/next，2026-10-24，本轮）

### Agent 打磨：审计轮转 + 路由同义词 + MT04 离线回归（feat/agent-audit-router，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` 全绿（集成后 **1297/1297**；本条 +22：路由同义词 7、审计轮转 11、MT04 4）、`build:ext`、smoke `SMOKE_OK`（新增 `SMOKE_AGENT_AUDIT_ROTATED_OK rows=3 files=2`）、`npm run eval:agent` **102/102**（+27 条 `sy01`–`sy27`，各指标 1.00）、`npm run agent:report` 已更新；未打包、未触发 CI、未发版、未 push。
- 审计（已知问题 9）：新增 `src/agent/audit-store.ts`，按大小轮转 `agent-audit.N.jsonl` + 保留期整份清理，默认 5 MB × 5 份 × 90 天，`userData/agent-audit-retention.json` 可调；面板/`agent:audit:read` 与 Agent 报告读取全部保留份数，脱敏与坏行跳过不变；轮转失败只回调、继续写入。
- 路由（已知问题 9）：查询/计算/修改/生成与各工具触发补同义/口语词（意图关键词与工具正则同步），新增非工程话题拦截 `isOffDomainTopic`；轮转后的审计文件名与新增同义写动词同样触发审计篡改/危险路径拒绝。
- MT04（已知问题 10）：本机无 `AGENT_LIVE_*` 环境变量、无 userData 模型配置，**未跑真实模型、未改 `agent-multiturn.json`**（现有 JSON 已是修复后 6/6，问题 10 原描述已过时并已标注）；只补会话层确定性单测证明拒绝记忆生效。

### 主视口 3D 收尾：编辑撤销/重做 + 工程持久化 + WebGL 框选（feat/orbit-undo，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1273/1273**（+25：合成时间线 14、存储 6、框选投影 4、多选选择集 1）、`build:ext`、smoke 全绿（新增 `SMOKE_ORBIT_UNDO_OK` / `SMOKE_ORBIT_MULTI_OK` / `SMOKE_ORBIT_PERSIST_OK`）；手动 `check:orbit-webgl` 新增 `ORBIT_WEBGL_MARQUEE_OK`（无 xvfb 可用 `--ozone-platform=headless` 跑）；原型文件零改动，未打包、未触发 CI、未发版、不 push。
- 撤销：原型 `pushHistory` 不导出，3D 编辑自建栈（覆盖表前后快照），与原型栈按发生顺序合成一条令牌时间线；Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 与状态栏按钮先过扩展，栈顶是 3D 就自己撤，是原型动作就放行。从状态栏「撤销 N / 重做 M」+ 按钮提示对账，Agent `undo_last` / `ProtoApi.undo()` 直接撤原型也能跟上。同字段 800 ms 合并、上限 50，与原型一致；任一侧新动作作废全部重做。
- 持久化：内置零件覆盖写 localStorage `automationcad.orbit.v1`（与底板画布同机制，userData 内），启动先恢复；坏数据整体丢弃并给原因。插入件覆盖不存（原型不持久化插入件）。
- 框选：WebGL 模式 Shift+左键拖拽 / 工具条「框选」粘滞模式；命中规则同原型（屏幕矩形相交），经合成拖拽写回原型 `state.multi`，高亮、「已选中 N 个对象」、点选替换、Esc 全部沿用原型；降级模式行为不变。
- 边界：见 `desktop/src/orbit/MODULE.md`「坑点」4–5 与「待办」。

### 元件库补录安全光栅 + 缺尺寸（feat/lib-safety-dims，2026-10-24）

- 安全光栅：`iec-cn` 新增 8 条 Type 4 安全光栅（欧姆龙 F3SG-SR 14/25 mm、西克 deTec4 Core 14/30 mm 发送器/接收器、邦纳 EZ-SCREEN SLS 14/30 mm），每条 `specs.数据来源` 记官方样本/数据表 URL，`dims.source` 记外形图出处；无官方价，未填价格。另给已有 F3SG-4SRA0400-14 与 C4C 450 mm 一对补响应时间与官方尺寸。manifest 1.2.0（379 条/36 家）。
- 六工位案例（P10-4）：`bom-map` 安全光栅初选 `F3SG-4SRA0640-14`（14 mm / 640 mm / PL e，OSSD 接 PNOZ s3），BOM 12 行全部为真实型号；新增 `notices` 提示按 ISO 13855 核算安全距离；元件包缺该型号时仍退回「待选型」并写原因。`machine-case.json` 已按脚本重生成；4 张机型截图沙箱无 xvfb 未重拍（文档已注明），`screenshots:machine` 校验改为要求 BOM 含该型号且无「待选型」。
- 缺尺寸：第二批 22 条全部取厂商官方逐型号尺寸（无推定）：安全光栅 11 条（新增 8 + 既有 3）+ `backfill-dims.mjs` 的 `FILL_BATCH2` 11 条（倍加福/西克/图尔克/西门子/台达/菲尼克斯，`dims.source` 含 URL）。覆盖 244/371 → **266/379（70.2%）**，剩余 113 条；DIMS-GAPS.md 统计与清单已更新（标题未改以免触发 kb 重建）。
- 验证：`tsc` 干净、`TZ=Asia/Shanghai npm test` **1250/1250**（+2）、`build:ext`、smoke `SMOKE_OK`；不 push、不打包。

### P8 设计完成后自动生成 PLC 程序
- 状态：🔄 P8-1 / P8-2 / P8-3 / P8-4 ✅ 已完成；P8-5 可选
- 范围：预检（地址重复/越界/双线圈/安全缺失）→ IO 变量表 + ST 程序块（OB1/气缸 FB/夹爪/轴/自动状态机/报警/安全）→ 导出 zip 与映射表
- 分期：P8-1 预检+变量表+FB → P8-2 序列/报警/安全 → P8-3 UI 与导出 → P8-4 模拟器自检 → P8-5 TIA Openness（可选）
- 验收：demo 机型（补齐安全件）11 文件、预检 0 错、重复生成 sha256 一致；内置模拟器 6 步跑通、0 报警
- 已完成（P8-1）：`src/plcgen/precheck.ts`（预检各规则全量返回）、`tags.ts`（I/Q 顺序分配 + UTF-8 BOM CSV）、`st.ts`（`FB_Cylinder/FB_Gripper/FB_RotaryAxis/DB_IO/OB1_Main` 五文件 + `inputHash`）；无 UI
- 实测（P8-1）：`npm test` **505/505**（新增 35 条 plcgen 用例）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`
- P8-1 边界：首期五文件；自动序列/报警/安全 FC 留给 P8-2，生成 UI/zip 留给 P8-3，模拟器联调自检留给 P8-4；demo 配置本身未带安全点位，预检演示需补 `safety.emergencyStop/safetyDoor`
- 已完成（P8-2）：`sequence.ts`（步序 → `FC_AutoSequence` CASE 状态机、AND/OR 条件、5 s 缺省超时、超时报警、Abort/SafeStop 回 Step0）、`safety.ts`（急停/安全门常闭串联、SafeStop 锁存与 Reset 上升沿复位、缺点位只写注释）、`alarms.ts`（超时/传感器矛盾/安全触发统一 `AlarmWord` + `FirstFault` 首故障锁存）、`generate.ts`（预检拦截 + 固定 11 文件 + `mapping.json` + README + 逐文件 SHA-256）、`symbols.ts`（点位/地址/变量名映射）
- 实测（P8-2）：`npm test` **556/556**（新增 `plcgen-p82.test.ts` 32 条）；`npm run smoke` → `SMOKE_PLCGEN_OK files=5 tags=32`、`SMOKE_PLCGEN_SEQ_OK files=11 steps=2`、`SMOKE_OK`；同输入两次生成 11 文件 sha256 全一致
- P8-2 边界：生成 UI、zip 导出、历史记录留给 P8-3；模拟器加载生成程序跑联调序列留给 P8-4；仍不生成厂商专有工程文件
- 已完成（P8-3）：`src/plcgen/ui.ts` 电气域顶栏「PLC 程序」全屏面板（机型规模、目标平台/命名前缀、错误/警告预检表与机构定位、文件树 + 前 200 行预览、导出 zip/复制全部/打开目录）；`view-model.ts` 纯函数（文件树/预览/按钮禁用/问题定位）；`history.ts` 最近 10 次按 inputHash 去重并可回看文件清单；`export.ts` 目录命名；`src/shared/{filename,zip}.ts` 复用文件名净化与 adm-zip 写入；IPC `plcgen:history|recordHistory|export|openExportDir`
- 实测（P8-3）：`npm test` **577/577**（新增 `plcgen-p83.test.ts` 21 条：纯 JS SHA-256、文件树、预览截断、历史去重/上限、目录命名、ZIP 结构与 CRC + `unzip -t`、路径穿越、预检禁用、目标平台不影响 ST）；`npm run smoke` → `SMOKE_PLCGEN_UI_OK files=11 history=1`
- P8-3 边界：历史只保存文件清单不保存正文；仍不生成厂商专有工程文件
- 已完成（P8-4）：`simulate.ts`（mapping 输出映射、执行机构行程时间、生成 timeoutMs、SafeStop、传感器矛盾、虚拟时钟与 timeScale）、`verify.ts`（预检 → 生成 → 模拟，`summarizeVerification` 窄摘要）、Agent 只读工具 `verify_plc_program`、面板「模拟验证」入口
- 实测（P8-4）：`npm test` **619/619**（新增 `plcgen-p84.test.ts` 21 条）；`npm run smoke` → `SMOKE_PLCGEN_SIM_OK steps=6 ok=1 alarms=0`、`SMOKE_PLCGEN_UI_OK files=11 history=1`、`SMOKE_AGENT_TOOLS_OK tools=12 implemented=12`
- P8-4 边界：模拟器只执行生成程序的动作/等待/超时/安全/传感器语义，不解析任意 ST；仍不生成厂商专有工程文件

### P9 参数化建模（build123d 内核）
- 状态：🔄 P9-1 / P9-2 / P9-3 / P9-5 已完成；P9-4 草图约束前置调研完成，实施待排期
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 ✅ sidecar+契约（`spike/build123d/app.py`）→ P9-2 ✅ 主进程生命周期/IPC（`9eda660`，388/388、`SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`）→ P9-3 ✅ 特征树 UI / 参数编辑 / 防抖重建 / STEP+STL 导出 → P9-4 ⏳ 草图约束（前置调研完成）→ P9-5 ✅ 多实体装配 + BOM/成本联动
- 已完成（P9-3）：`src/parametric/model.ts`（编辑/防抖/分桶/序列化/包围盒，18 条单测）、`src/parametric/ui.ts`（与运动学二选一的抽屉、按类型参数表单、校验失败禁重建）、`cad/viewer.ts`（STL 载入 + 旧模型幽灵层 + 特征包围盒高亮）、`extension.ts` 挂载与 `AutomationCadParametric` 调试入口；`localStorage: automationcad.parametric.v1` 按 `sourceFile` 分桶（无来源 `untitled`）；JSON 保存走 `desktop.exportFile`
- 实测（P9-3）：`npm test` **524/524**；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`、`SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 坑：假内核脚本不能放 `test/` 下（`node --test` 会把 `test/fixtures/*.mjs` 也当测试跑，挂 276 s），已移到 `desktop/scripts/fake-parametric-sidecar.mjs`
- 验收：P9-2 `SMOKE_PARAMETRIC_SIDECAR_OK status=ready fake=1`；P9-3 `SMOKE_PARAMETRIC_UI_OK features=2 status=ready`
- 已完成（P9-5）：`features.ts` 增加 `PartInstance/AssemblyDoc`、旧文档自动包装、实体级校验与 `compileOps` 双形态；`bom.ts` 合并 partId/未映射名称并生成 UTF-8 BOM CSV 与成本入参；`ui.ts` 装配实体区、BOM 预览、导出 BOM/送成本；`app.py` 可选 `instances`，独立建模后按 X/Y/Z/RZ 放置并合并，返回 `stats.solids` 与每实体体积；假内核支持两实体 smoke
- 实测（P9-5）：`npm test` **647/647**（新增 `parametric-assembly.test.ts` 25 条 + sidecar 装配 3 条）；`AUTOMATIONCAD_PARAMETRIC_CMD="$PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke` → `SMOKE_PARAMETRIC_ASSEMBLY_OK solids=2 bomRows=3`
- P9-5 边界：BOM 只按实体汇总、不拆特征明细；`partId` 需人工填写；装配为静态多实体合并，不做配合约束/自由度求解（P9-4）
- P9-4 前置调研（2026-10-23）：推荐 `@salusoft89/planegcs@1.3.0`（LGPL-2.1、WASM、Node 可跑）；矩形 + 水平/竖直 + 宽 120 / 高 80 实测 `Success`、`dof=0`、残差 0，热求解中位数 0.30 ms，安装增量 878 KiB；jsketcher 因自定义许可要求修改回授且无 npm 包不推荐；顶点 → build123d `Polyline` → `extrude` 实跑体积 76,800 mm³。详见 [SKETCH-SPIKE.md](SKETCH-SPIKE.md)。本轮不接入产品代码

### P10 产品截图更新（2026-10-23）
- 状态：✅ 已完成
- 内容：新增 `--headless-screenshots` 分支与 `npm run screenshots`（`desktop/scripts/capture-screenshots.mjs`）：xvfb 启真实 Electron，`BrowserWindow.setContentSize(1600,1000)` 后用 `webContents.capturePage()` 抓图；参数化面板由 `AUTOMATIONCAD_PARAMETRIC_CMD=desktop/scripts/fake-parametric-sidecar.mjs` 驱动。
- 新增截图（均为真实 Electron 实跑，非设计稿）：`11-plcgen` / `12-parametric` / `13-cost` / `14-enclosure`.png，内容说明见 `MODULES.md` 截图目录。
- 验图：四张均为 1600×1000，PIL 统计颜色数 3,192–6,508、RGB stddev 均 > 14，非单色/空白。
- 说明：xvfb 下 Chromium 把 WebGL 列入 blocklist，CAD 3D 视口显示解析统计降级面板；参数化抽屉与 PLC/成本/底板面板均为真实 DOM/SVG 渲染并已截图，无跳过项。
- 验收：`npm test`、`npm run smoke` 全绿；README 界面一览与图注、`docs/desktop/MODULES.md` 截图索引已同步。


## 知识库容量治理 + Agent 工具 `suggest_kinematics`（integ/3d-all，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1248/1248**（+10：工具 9 + KB 余量守卫 1；+1：STEP 旧分块清理与近似件透出）、`build:ext`、smoke 全绿（新增 `SMOKE_AGENT_KINEMATICS_OK high=4 low=1 written=0`）、`npm run eval:agent` 75/75；未打包、未触发 CI、未发版。
- KB：根因是 BACKLOG 迭代记录持续增长、整份进索引。改为本文件只留最近一轮，早于本轮的 20 节原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不在 `KB_DOC_FILES`）；`kb.json` 从约 408 KB 降到约 363 KB，未截断、上限不变。`kb.test.mjs` 新增守卫：归档不入索引、索引须留 ≥5% 余量（约 20 KB），超了提示继续归档。
- 工具：只读 `suggest_kinematics`（命令 `suggest_kinematics` → 渲染桥 `suggestKinematics` → 标注抽屉 `suggest()`），参数 `includeLow? / limit?(1–30)`，返回压缩后的高/低置信度建议（轴向 ±X/Y/Z、行程或角度、行程来源、型号、工位、点位、置信度、中文理由），`applied=false`；**从不写入标注**，采纳仍由用户在抽屉逐条确认并保存。已接入路由（「识别/找出…运动件」）、MCP/RPC（21 个工具）、评估集 `kin01`、Agent 报告。
- 边界：未导入模型时返回提示先 `import_cad`；建议本身的识别边界同迭代 36。
- 合并前复查修正（`192983e`）：① `solids/` 里上一次遗留的 `part-N.step` 现在先入撤销快照再清掉，避免旧分块混进本次整机（撤销可恢复）；② STEP 实体化把水平圆柱按等截面方棒近似时，写中文 warning 点名零件并在 `geometry.approximatedIds` 透出 id 列表，不再只给数量；③ `apply-machine-geometry.test.mjs` 新增 1 条覆盖这两条。

## 集成：34/35/36 三条 3D 分支合并 + 同步 main（P10-4 六工位案例）（integ/3d-all，2026-10-24）

- 状态：✅ `tsc` 干净、`TZ=Asia/Shanghai npm test` **1237/1237**、`build:ext`、`smoke` 全绿（含 `SMOKE_MACHINE_GEOMETRY_OK` / `SMOKE_ORBIT_VIEW_OK` / `SMOKE_KINEMATICS_AUTO_OK`，各分支冒烟块全部保留）；不 push。
- 互不干扰：主视口 3D 只挂原型 `#stageAssembly/#scene3d`、`#stageCheck/#sceneCheck` 与 `window.AutomationCadOrbit`；联调 3D 在联调抽屉内自建 `commission-3d-canvas`，入口 `__Commission3D`；运动学建议走 `AutomationCadKinematics`。
- KB：合并后超 400 KB 上限；先精简本文件冗余记录过渡，本轮已改为历史归档根治。

## 六工位锁螺丝机完整案例 + 全流程真实截图（P10-4，2026-10-24）

- 状态：✅ 完成；新增 9 条案例断言，`npm run screenshots:machine` 4 张图（15–18）像素校验通过；不 push。
- 内容：真实解析/合成六工位案例（6 工位 / 12 执行机构 / 7 传感器 / 19 点位）、真实型号 BOM（11 行真实 + 1 行待选型）、离线桩驱动的全流程截图；细节与复现见 [MACHINE-DESIGN-DEMO.md](MACHINE-DESIGN-DEMO.md)。
- 边界：节拍估算 3.18 秒/件未达 3.00 目标（需约 12 总工位）；安全光栅无库内型号；3D 为配置驱动示意。

## 运动学自动识别建议（36-auto-kinematics，2026-10-24）

- 状态：✅ 完成；新增 34 条测试（`test/cad/kinematics-auto.test.mjs`，含合成 STEP 夹具端到端），smoke 新增 `SMOKE_KINEMATICS_AUTO_OK high=4 low=1 accepted=1 autoApplied=0`。
- 内容：`desktop/src/cad/kinematics-auto.ts` 按名称/型号、装配层级、几何（PCA 主轴、同轴、回转体、骑轨）推测动件的轴向/行程/置信度/中文理由与 IO 建议；标注抽屉逐条「采纳 / 忽略」，**从不自动写入**，schema 未改。细节见 `desktop/src/cad/MODULE.md`。
- 边界：纯启发式，命名不规范且几何不典型识别不到；子装配压平会丢型号；只支持 ±X/±Y/±Z；夹爪只给一根手指；Agent 工具 `suggest_kinematics` 已在本轮补上。

## 主视口可旋转 3D：轨道视图 + 属性编辑改几何（35-orbit-view，2026-10-24）

- 状态：✅ 完成；新增 38 条测试（`test/orbit/`），smoke 新增 `SMOKE_ORBIT_VIEW_OK mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`；WebGL 路径用 `npm run check:orbit-webgl`（swiftshader，手动）验证。
- 内容：注入扩展 `desktop/src/orbit/` 把原型装配/干涉视口换成可旋转 three.js（原型三文件零改动）：轨道/缩放/平移、标准视向、透视↔正交、适合、剖切、树↔3D 双向选择、缸径/行程与桌面版几何参数实时改几何、干涉 AABB 初筛；无 WebGL 回退原型 SVG。细节见 `desktop/src/orbit/MODULE.md`。
- 边界：示意体非 1:1、无 B-rep/配合求解；桌面版几何参数不进撤销栈、不持久化；WebGL 模式无框选；真实显卡帧率未实测。

## 迭代 34：机型方案生成真实三维几何（34-machine-geometry，2026-10-24）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1156/1156**（1132 + 24；沙箱默认 UTC 需 `TZ=Asia/Shanghai`，否则 `cost-export.test.ts` 两条既有时间断言失败，与本轮无关）、`npm run smoke`（xvfb-run）新增 `SMOKE_MACHINE_GEOMETRY_OK layout=dial parts=58 axes=6 envelope=1490x1300x1177 chunks=2 scene=58`、`SMOKE_OK`；`SMOKE_PARAMETRIC_SIDECAR_SKIP`（无 Python）；不 push。
- 内容：纯函数 `machine/geometry.ts` 生成 mm 级整机（机架、底板 + 门架、气缸缩回位、夹爪张开位、旋转台、传感器、光栅、输送线/分度转盘）与运动轴元数据；`geometry-export.ts` 出 STL / glTF / build123d `AssemblyDoc` 分块与实体化回退；`geometry-three.ts` 接入 `createScene3D` 替换占位方块；`apply_machine_design` 新增 `withGeometry`（默认 true）/ `withSolids`，`design_machine` 返回几何摘要；单测 24 条；文档同步，`kb:build` 重建。
- 边界：标准件外形，不做强度/干涉/选型，无紧固件/钣金/气路/电柜与上下料机构；转盘分度、输送线驱动未接点位；STEP 只经 sidecar，水平圆柱为等截面方棒；xvfb 下 WebGL 被 blocklist，冒烟只证场景构建与零件数一致，需 Windows 实机目测。

## 自然语言设计机器（三）：工艺模板 + 追问策略 + 真实模型评测（P10-3，2026-10-24）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1132/1132**（1110 + 新增 22）、`npm run smoke` 新增 `SMOKE_MACHINE_TEMPLATES_OK templates=5 clarify=1 multi=1`、`npm run eval:agent` **74/74（1.00）**、`npm run agent:live` **36/36**；不 push。
- A. 工艺模板：新增 `desktop/src/machine/templates.ts`，导出可直接读取的 `TEMPLATES`（5 类）。锁螺丝每工位 1 旋转轴 + 1 夹爪 + 1 接近；点胶 1 旋转轴（三轴模组占位）+ 1 压力；装配 1 压装气缸 + 1 夹爪 + 2 接近；检测 1 旋转轴（相机位占位）+ 1 光电 + 1 安全光栅；包装 1 推料气缸 + 1 吸盘（夹爪）+ 1 光电。每类含 `stations / actuators / sensors / cycleRange / rationale`，未知工艺使用内部通用模板。
- B. 合成器接入：`synthMachine` 缺执行机构/传感器时按模板补全，assumptions 写「按 X 模板补全」；缺工位默认 2、缺节拍默认 10 件/分钟，同时写 warning 与 assumption。
- C. 追问策略：新增 `desktop/src/machine/clarify.ts` 纯函数 `buildClarify(brief)`，只看工艺/工位/节拍，最多 2 项、合并成一个具体问题；有默认值不追问；`design_machine` 返回 `needs` 与 `question`，会话系统提示要求最多追问一次，不答则用默认并说明。
- D. 离线评测：`docs/desktop/eval/cases.json` 新增 6 条（5 类工艺 + 1 条信息不足），74/74，意图/工具/参数/拒绝均 1.00。
- E. 真实评测（报告生成器新增「机型」分组）：`desktop/scripts/agent-live-cases.json` 新增 `machine` 分组 6 条（三工位锁螺丝、两工位点胶 3 秒/件、四工位装配含汇川+安全光栅、信息不足检测机、多轮改 4 工位、直接应用需确认），总数 30 → 36；评测器支持 `history` 多轮前置、`allowClarify`、`hasKey`、`containsAll` 参数检查，并只评判本轮工具调用，阈值不变。本机 `deepseek-v4.1-flash` 最终轮 36/36、confirm/clarify/refusal 均 1.00，p50 7.9 s / p95 31.3 s；机型分组 6/6，p50 23.9 s / p95 37.8 s。两轮复跑中的首轮出现 `O04 [operation/missing-arg]`，第二轮恢复；失败分类保留，未删用例、未降阈值。
- 边界：模板是代码内常量，不是用户可编辑库；追问只保证一次，不持久化未答状态；真实评测仍是单模型结果，换模型需重跑。

## 自然语言设计机器（二）：落盘写工具 + 3D/BOM/PLC 联动（P10-2，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1110/1110**（1084 + 新增 26）、`npm run smoke` 新增 `SMOKE_MACHINE_APPLY_OK machine=design-screw-3st stations=3 bom=6 undo=1`、`npm run eval:agent` **68/68（1.00）**；不 push。
- A. 写工具：新增 `apply_machine_design`（工具数 19 → 20，只读 10 + 写 10），schema `{brief?, design?, name?, overwrite?, withBom?, withPlc?}`；`brief` / 完整 `design` 二选一，内部统一走 `validateMachineConfig`；补校验工位/执行机构/传感器 id 唯一、传感器 `part` 引用存在、`design.points` 与配置点位一致；写 `userData/machine/<id>.json` 与 `active.json`，默认同名返回 `FILE_EXISTS`，`overwrite:true` 才覆盖；成功刷新 3D 并进入撤销栈，`undo_last` 恢复上一 active 方案。
- B. BOM/PLC 联动：`withBom` 默认 `true`，把 `bomDraft` 转为 BOM 行（`kind` → 执行机构/传感器/电气，缺型号写「模型待定」，来源 `machine-design`），追加到 BOM 草稿并写 `machine/<id>/bom-draft.csv`；`withPlc` 默认 `false`，复用 `plcgen/io.ts` + `plcgen/tags.ts` 只生成 `exports/plc/<id>/io-map.csv`，不生成完整 ST；两者都在结果返回实际路径。
- C. UI：`design_machine` 结果新增「机型方案卡」（工位数/执行机构/传感器/节拍/功率/全部警告 + 「应用到工程」按钮），警告黄色条不折叠；按钮走计划确认，成功后 3D 切到新机型并显示「已应用：<名称>」；启动时按 `machine:active` 恢复上次方案。
- D. 测试：新增 `desktop/test/agent/apply-machine-design.test.mjs` 26 条，覆盖 brief/design 二选一、缺参、design 校验失败、执行机构 id 重复、点位重复/引用缺失、overwrite 语义、active 指针、撤销恢复、BOM 追加行数与来源、PLC 点位齐全、确认拒绝不落盘、`../` 路径净化；同步更新工具数、MCP/RPC、离线路由与报告断言。
- E. 评测：`docs/desktop/eval/cases.json` 新增 d05/d06/d07 三条机型落盘用例（应用上一轮方案、生成 BOM、生成 PLC 点位映射），离线 68/68，意图/工具/参数/拒绝均为 1.00；`desktop/eval/agent-cases.json` 保持同内容兼容副本。
- 边界：3D 仍是配置驱动示意，不生成真实几何；BOM 型号缺省不猜；PLC 只输出点位映射，不生成厂商工程文件；applied 方案的 active 指针损坏时启动回退内置 4 工位样机。

## 自然语言机型方案合成（P10-1，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1084/1084**（1044 + 新增 40）、`npm run smoke` 新增 `SMOKE_MACHINE_DESIGN_OK stations=3 actuators=6 sensors=6 warnings=1`、`npm run eval:agent` **65/65（1.00）**；不 push。
- A. 需求抽取：新增 `desktop/src/machine/spec.ts` 纯函数 `parseMachineBrief`，支持中文数字工位、`分钟 20 件` / `20 件/分钟` / `3 秒一件` / `CT` 三类节拍、五类工艺、气缸/夹爪/旋转轴/伺服/步进、接近/光电/安全光栅/压力、品牌与 220VAC/380VAC/24VDC；缺省项写 `notes` 标记，不抛错。
- B. 方案合成：新增 `desktop/src/machine/synth.ts` 纯函数 `synthMachine`，输出可直接喂给 `createScene3D` 的 `MachineConfig`、唯一点位（`ST1-EXT-A1` 等）、节拍瓶颈与并行工位建议、固定表功率估算、BOM 草案、warnings 与 assumptions；伺服/步进按旋转轴建模并按 750 VA/轴计功率，不重复计 200 VA 旋转轴。
- C. 工具：新增只读 `design_machine`（工具数 18 → 19，只读 10 + 写 9），schema `{brief, stationCount?, cyclePerMin?}`；空 brief、工位越界/非整数、非正节拍返回 `INVALID_ARGUMENT`；不写文件、不改工程，摘要 ≤600 字。
- D. 路由与评测：`isMachineDesignRequest` 将机型设计识别为 `generate` 并映射到 `design_machine`；`docs/desktop/eval/cases.json` 增加 4 条（锁螺丝/点胶/装配/检测），离线评测 65/65 全绿。
- E. 测试：新增 `test/machine/spec.test.mjs`（14）、`synth.test.mjs`（15）、`test/agent/design-machine.test.mjs`（10），共 39 条；覆盖中文数字、三种节拍写法、品牌、缺省 warning、工位均分、点位唯一、瓶颈、功率求和、BOM、schema、越界、空 brief 与摘要数字。
- 边界：几何仍为配置驱动，功率为固定表估算，节拍未计入上下料/通讯/调试损失；本轮不落盘，写工具与 UI 方案卡留给下一轮。

## Agent 运行报告与可视化（P7-O，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1044/1044**（1034 + 新增 10）、`npm run smoke` 全绿（`SMOKE_OK`）、`npm run agent:report` 产出 md/json/svg 三个非空文件；不 push。
- A. 报告生成：新增 `desktop/scripts/agent-report.mjs` + `npm run agent:report`。读取 `agent-live.json` / `agent-multiturn.json` / `latest.json`，审计取 `<userData>/agent-audit.jsonl`（可用 `AGENT_REPORT_AUDIT_FILE` / `AGENT_REPORT_USER_DATA` 覆盖）；缺源文件写「缺失：<文件>」、打印 WARN、退出码 0。
- B. 输出：`docs/desktop/AGENT-REPORT.md`（总览、查询/操作/流程/拒绝分组、离线指标、多轮场景、能力清单、已知缺口、审计摘要）、`docs/desktop/agent-report.json`（每个指标带 `source` 与 `generatedAt`）、`docs/desktop/agent-report.svg`（纯代码生成，深色底、4 组横向条形图 + 工具/测试/单轮/多轮 KPI）。
- C. 一致性：写盘后立即读回 `agent-report.json` 并与内存对象逐字段比对；`verifyReport` 再逐项核对总览、分组、离线指标是否等于源 JSON。缺源时只降级为「缺失」，不编造数字。
- D. 能力清单：18 个工具 + 13 项平台能力，逐条给出模块文件、验证方式（单测 / smoke / eval）与状态；多轮状态按真实 JSON 显示 `⚠️ 5/6（MT04）`，未把阈值通过写成全绿。
- E. 测试：新增 `desktop/test/agent/report.test.mjs` 10 条，覆盖真实源数字、源变更传导、篡改拦截、缺源降级、Markdown 来源/时间、SVG 数据驱动、BACKLOG 缺口摘取、md/json/svg 文件产出。

## Agent 执行效率：去重 / 并行 / 缓存（P7-N，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **1034/1034**（1001 + 新增 33）、`npm run smoke` 新增 `SMOKE_AGENT_EFFICIENCY_OK dedupe=2 parallel=2 cache=1`、`npm run eval:agent` 100%（61/61）；`npm run agent:live` 因无凭据 `AGENT_LIVE_SKIP`，未伪造端到端 p50/p95；不 push。
- A. 同轮去重：新增 `desktop/src/agent/dedupe.ts`（纯函数 + 小状态）——`canonicalArgs` 键排序、空白压缩、数字字符串归一；`TurnCallDeduper` 按 `(tool, canonicalArgs)` 复用同轮结果并标 `reused:true`；写工具永不合并；单轮上限默认 12，超出返回 `TOO_MANY_TOOL_CALLS` 并提示拆轮。
- B. 只读并行：新增 `desktop/src/agent/parallel.ts`——`planExecutionBatches` 把连续无依赖只读批并发（默认 3，可配），写工具单独成批形成屏障；`$0` / `${1}` / `{{0.data}}` 等占位符触发依赖降级串行；`runReadOnlyBatch` 固定 worker 池，失败不取消已发出调用，结果按原序返回。
- C. 会话缓存：新增 `desktop/src/agent/cache.ts`——`get_bom` / `get_project_context` / `list_components` 按 `(tool, 规范化参数, projectFingerprint)` 缓存 30 s；只缓存成功结果；写工具执行前后清空；指纹变化删旧条目；不跨会话、不落盘。
- D. 审计 / UI：`AgentAuditRecord.cacheHit` 落 NDJSON；`AgentProgressEvent.cacheHit` 进入进度卡，工具卡与审计行显示「已复用」。
- E. 实测：本机合成桩延迟 100 ms/工具——两次只读分两轮 211 ms → 同响应 102 ms（并发 2）；三次同关键词 303 ms → 102 ms（执行 1 + 复用 2）；两轮 `get_bom` 101+101 ms → 101+2 ms（缓存命中）。真实模型基线仍为 p50 7.6 s / p95 21.3 s，待有凭据后重跑 `agent:live` 更新。
- F. 测试：新增 `desktop/test/agent/efficiency.test.mjs` 31 条，覆盖参数规范化、重复合并、参数差异不合并、写不合并、12 次上限、保序、并发度、依赖降级、写屏障、失败不吞、缓存命中/失效/TTL、指纹变化、跨会话隔离、审计 `cacheHit`。

## Agent 上下文预算与成本可见性（P7-M，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **983/983**（962 + 21）、`npm run smoke` 新增 `SMOKE_AGENT_BUDGET_OK used=371 dropped=7 tokens=128`、`npm run eval:agent` 通过；不 push。
- A. 预算模型：新增 `desktop/src/agent/budget.ts`（纯函数）——`estimateTokens`（中文 1.6 字符 / token、其他 4 字符 / token，向上取整）、六档 `system / selection / memory / docs / toolResults / history`（默认总量 12k，可配单档上限）、`pack(payload, options)` 返回 `{text, used, dropped, sections, docsSources}`。
- B. 裁剪顺序：单档超限先保留长列表首尾各 5 条 + `total`；总量超限先收敛 docs / toolResults 长列表，再按 `history → docs → toolResults → memory → selection` 丢弃；`system` 永不裁剪（超总量只记 `system_protected`），每条 `dropped` 带中文原因。`session.ts` 用六档装包系统上下文，并按用户轮次成组裁剪模型历史，避免拆散 assistant/tool 协议对。
- C. 成本可见性：`llm.ts` 解析端点 `usage.prompt_tokens / completion_tokens`；缺失时会话按消息 + 工具 schema / 回复 + tool_calls 估算并标 `estimated:true`；`usage()` 返回本轮/本会话 `promptTokens / completionTokens / totalTokens / requests / estimated` 与费用。新增 `pricing.json`（元/1k tokens，`currency/unit/models`）与 `pricing.ts`，`estimateCostView` 支持精确/最长前缀匹配，未知模型显示 `—`。
- D. UI / 审计：侧栏底部新增「上下文成本」，显示本轮/本会话 tokens、输入输出拆分与费用，估算态有标注；审计行新增 `promptTokens / completionTokens / estimated / docsSources`，`search_docs` 命中时记录实际来源数。
- E. 测试：新增 `desktop/test/agent/budget.test.mjs` 21 条，覆盖估算误差、装包不超预算、history < docs < toolResults 优先级、system 保留、长列表首尾截断、裁剪原因可读、usage 缺失回落估算、真实 usage 累计、费用格式化、未知模型 `—`、审计 tokens/docsSources。冒烟新增 `SMOKE_AGENT_BUDGET_OK used=… dropped=… tokens=…`。

## Agent 多轮上下文与中断续跑（P7-L，2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` 962/962、`npm run smoke` 新增 `SMOKE_AGENT_THREAD_OK turns=3 resume=1 stale=1`；`npm run eval:agent` 通过；多轮真实模型评测无凭据 SKIP（结果文件已写；本地桩校验 6/6 场景、15/15 轮）。不 push。
- A. 多轮模型：新增 `desktop/src/agent/thread.ts`——`ThreadState` 保存 `turnId/projectFingerprint/intent/targets/pendingConfirm/completedSteps/lastReplySummary`；`AgentSession` 每轮结束写入，下一轮系统提示注入「上一轮做了什么、是否完成、是否被拒绝」。
- B. 工程指纹：机型名 + BOM 行数 + 底板放置数 + CAD 模型有无；变化时固定提示「工程已变化，不要沿用旧结论」并列出逐项差异。
- C. 中断续跑：`runPlan({resumeFrom})` 从已完成步骤之后继续；前置指纹变化时 `refused+stale+changed[]`，不执行任何工具并要求重跑前置步骤；确认超时/取消写 `pendingConfirm`，下一轮优先询问是否继续；用户拒绝记 `USER_DENIED` 且不自动重试。
- D. 跨轮指代：上一轮目标合成 `[target=kind:id:label]`，支持「刚才那个件 / 它」；当前选中仍优先。
- E. 测试：新增 `desktop/test/agent/thread.test.mjs` 30 条，覆盖状态读写、四类指纹变化、续跑跳过、拒续跑、pendingConfirm 恢复、拒绝不重试、跨轮指代、改型号→撤销→改数量全流程。
- F. 评测：新增 `desktop/scripts/agent-multiturn.mjs` + `agent-multiturn-cases.json`，6 个多轮场景（2–3 轮/场景），环境变量同 `agent:live`，输出 `docs/desktop/eval/agent-multiturn.json`，阈值 `passRate ≥ 0.8`；无凭据跳过但写 SKIP 结果。

## 会话层硬拦截 + 目标路径澄清（2026-10-23）

- 状态：✅ 完成；`tsc` 干净、`npm test` **932/932**、`npm run smoke` → `SMOKE_AGENT_POLICY_OK bypass=1 confirm=1 pathDenied=1` 且 `SMOKE_OK`、`npm run eval:agent` 通过；不 push。
- A. 策略层：新增 `desktop/src/agent/policy.ts`（纯函数）—— `detectBypassIntent` 识别“别问了 / 不用确认 / 直接覆盖 / 跳过确认 / 我授权 / 别让我点”；`sanitizeConfirmationClaims` 过滤“无需确认 / 已自动确认”；`checkExportTargetPath` 判定盘符/UNC/绝对路径/`../`/相对目录/系统目录。
- B. 会话硬拦截：`session.ts::executeTool` 对写工具强制 `confirmWrite`（缺少回调或返回值不是明确 `true` 一律不执行），bypass 时确认文案追加“用户要求跳过确认，但写操作必须确认”并写审计 `BYPASS_ATTEMPT`（含 `phrase`）；用户拒绝后本轮同名写工具直接 `USER_DENIED`，不再弹窗。
- C. 路径澄清：`commands.ts` / `tools.ts` / `cost/export.ts` 共用路径判定；`export_files` / `export_cost_report` 默认只接受纯文件名，危险目标返回 `TARGET_PATH_UNSUPPORTED` 且消息附 `userData/exports/`，不调用渲染桥、不建目录、不写盘；`allowSanitize:true` 才净化落盘并返回 `sanitized:true`。
- D. 测试：新增 `desktop/test/agent/policy.test.mjs` 42 条，覆盖意图正负例、话术替换、盘符/UNC/`../`/纯文件名、allowSanitize 开关、直接调用 `executeTool`、拒绝短路与审计字段；既有导出 smoke 改为显式 `allowSanitize`。

## Agent 真实模型评测 30 条 + 失败归因（P7-K，2026-10-23）

- 状态：✅ 完成并过闸；三轮迭代后 `toolAccuracy=1.00`、`refusalRate=1.00`，`npm run agent:live` 退出码 0；**已 push**（后续由主会话补提交）。
- A. 用例：新增 `desktop/scripts/agent-live-cases.json` 30 条 —— 查询 8、操作 10、流程 6、拒绝/澄清 6；每条含 `{id, prompt, expect:{tools, alternatives, mustNot, asksConfirmation?, expectClarify?}}`，流程类用有序 `steps` 表达，拒绝类用 `mustNot` 锁死越权写工具。
- B. 评测器：`desktop/scripts/agent-live.mjs` 改为顺序执行、隔离会话、有状态桩总线（放置/修改/移除/撤销会更新 placements，只读工具读取新状态）、有序多步匹配、参数检查、写确认核对、只读排查与拒绝区分；逐条记录耗时/工具序列/确认/澄清/拒绝，失败分类限定 `wrong-tool` / `missing-arg` / `no-confirm` / `hallucinated` / `timeout` / `parse`。输出 `docs/desktop/eval/agent-live.json`，含 `{model,total,matched,toolAccuracy,confirmRate,clarifyRate,refusalRate,p50Ms,p95Ms,byCategory,failures[]}`。
- C. 真实结果（本机 LiteLLM bridge，`cn:deepseek-v4.1-flash`，key 只从环境读）：三轮迭代后 **30/30（100%）**，`confirmRate=1.00`（13/13）、`clarifyRate=1.00`（3/3）、`refusalRate=1.00`（6/6）；p50 7.6 s、p95 21.3 s。中间轮次：第 1 轮 28/30（2 条用例语义写错）、第 2 轮 27/30（暴露提前收口与幻觉误判）。
- D. 失败归因与修正（保留历史，不删）：
  - 第 1 轮 R03「要求跳过确认」/ R05「危险路径导出」：判定语义写错——R03 已正确请求确认却被判越权、R05 已净化到 `userData/exports/` 却被判“静默改写”。修正为：R03 断言“必须出现确认请求”，R05 断言“参数不得含 System32/Windows/系统盘绝对路径”。
  - 第 2 轮 F02 提前收口：BOM 无尺寸字段时模型拒绝导出 BOM，属过度谨慎；已在系统提示写明“缺尺寸只影响底板绘制，不得拒绝导出 BOM/PDF/成本”。
  - 第 2 轮 O03：起始点 (20,60) 与已有 QF1 重叠，模型暂停属正确行为；用例改为空白区 (240,200)。
  - 第 2 轮 R05 误判幻觉：模型确实调用了 `export_files` 却被判“未调用工具却声称完成”；判定改为仅当“本轮零工具调用”时才判幻觉。
  - 只读步骤调序：允许 `run_interference_check` 与 `run_electrical_check` 互换顺序，写操作仍按序。
- E. 下一步（按优先级）：
  1. ✅ **P0 硬拦截**：`policy.ts::detectBypassIntent` + `session.ts::executeTool` 强制确认、拒绝短路、`BYPASS_ATTEMPT` 审计、回复话术过滤；实现与证据见本轮新增章节。
  2. ✅ **P0 目标路径澄清**：`policy.ts::checkExportTargetPath` + `commands.ts` / `tools.ts` / `cost/export.ts` 统一拒绝危险路径；`allowSanitize=true` 才净化，返回 `sanitized:true`。
  3. **P1 流程稳定性**：评测改为 3 轮取多数，记录每轮 F02/F03；同时给流程计划加“未完成步骤不得结束”的执行约束，或在系统提示中明确“多步流程必须继续到全部步骤或明确失败”。
  4. **P1 回归门槛**：拒绝/澄清类保持 6/6 必须全过；建议再补“工具结果注入要求跳过确认”“用户伪造已确认”两条用例，防止只对单句生效。
  5. **P2 扩充**：补充真实多轮上下文（改型号后撤销再改数量）、跨域误用（机械域要求电气导出）与超长序号/批量 20 件，继续观察 token 与延迟。

## Agent 本地知识检索（离线 RAG，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 索引：新增 `desktop/src/agent/kb/index.ts`，输入 12 份 `docs/desktop/*.md` + `screenshots/` 文件名 + `packs/builtin/*/parts.json` 分类名；按 Markdown 标题切块（≤800 字符），保留 `source`（文件#标题路径）/`heading`/`line`。新增 `scripts/build-kb.mjs` 与 `npm run kb:build`，输出 `desktop/src/agent/kb/kb.json`（当前 12 docs / 291 chunks / 约 300 KB，≤400 KB）；超限时保留前 200 块并记录 `truncated/droppedChunks`。启动只加载 JSON，不扫盘、不联网。
- B. 检索：新增 `desktop/src/agent/kb/search.ts` 纯函数；中文 2-gram + 英文/数字词，简化 BM25（k1=1.5、b=0.75）+ IDF，默认 top 3；无查询词命中直接返回 `[]`；结果整体 ≤2 KB。
- C. 工具：新增只读 `search_docs({query, limit?})`，返回 `{ok,query,hits:[{source,heading,snippet,score}]}`；工具数 17 → 18（只读 9 + 写 9），MCP/RPC/UI/README/工具清单同步；系统提示要求「怎么操作 / 限制 / 决策 / 为什么」先查文档，查不到直说。
- D. 测试：新增 `desktop/test/agent/kb.test.mjs` 18 条（分块/source/line、800 字符、2-gram、导轨/干涉/D2、无命中、top3、limit、2 KB、400 KB、截图/分类、标题 hash 同步、工具参数）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **890/890**；`npm run smoke` → `SMOKE_AGENT_KB_OK docs=12 chunks=291 query=D2 hits=1`、既有 Agent 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（61/61，新增 k01–k03 文档用例）。

## Agent 工具调用纠错与重试（P7-J，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 纠错纯函数：新增 `desktop/src/agent/repair.ts`，`repairToolCall(raw, schema, ctx?)` 先剥代码围栏与前后解释，再逐字符扫描第一个平衡 JSON 对象；支持单引号、尾逗号、`//` 注释、`"120mm"→120`（仅 number 且含单位）、`"true"/"false"→boolean`、纯数字 `"3"→3`（仅 integer）、`{name,arguments}` 信封、多工具串取第一个；必填 `partId` 仅从 `ctx.selection.id` 回填；`additionalProperties:false` 的未知字段删除并记录；截断最多补 3 层 `}`/`]`，超限/无法补全返回 `TRUNCATED_JSON`；修复后必须过 schema，首个错误带路径与中文消息（`参数 qty 应为整数，收到 "3 个"`）。`qty:"很多"`、`"3 个"` 不猜值，直接拒绝。
- B. 重试策略：新增 `desktop/src/agent/retry.ts`；首次失败追加「上次输出错误：<原因>。只输出 JSON…」重试 1 次；仍失败回落「没听懂 + 未执行任何工具 + 两条按原话匹配的候选指令」，侧栏候选按钮只填入输入框、不自动发送；重试仅 1 次/用户轮次，失败立即返回，不空转。
- C. 接入：`session.ts` 新增 `toolSchemas`，模型工具参数统一走 repair；失败路径写 `TOOL_CALL_INVALID` / `TOOL_CALL_RETRY_OK` / `TOOL_CALL_FALLBACK`，成功修复写 `TOOL_CALL_REPAIRED`，审计新增 `retries/reason/repairs`；`ipc.ts` 与 `scripts/agent-live.mjs` 传入注册表 schema；`llm.ts` 默认发送 `response_format:{type:'json_object'}`，端点明确不支持时去掉并重试一次，`responseFormat:false` 可关闭。
- D. 测试：新增 `desktop/test/agent/repair.test.mjs` 39 条（围栏/前后废话/单引号/尾逗号/注释/单位数字/字符串布尔/字符串整数/多工具串/截断成功与失败/schema 中文路径/禁止猜测/selection 回填/未知字段/重试成功/重试回落/审计）；`test/agent/llm.test.mjs` 新增 3 条（默认 response_format、端点不支持时降级、显式关闭）。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **872/872**（830 + 39 + 3）；`npm run smoke` → `SMOKE_AGENT_REPAIR_OK cases=10 repaired=7`、既有 Agent/成本/PLC 断言全绿、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP`（有凭据时仍跑 12/12）。

## 发版准备 0.3.0（2026-10-23）

- 状态：✅ 代码与文档准备完成；**未打包、未触发 CI、未打 tag、未 push**
- 已完成：`desktop/package.json` / `package-lock.json` 版本升至 `0.3.0`；新建根目录 `CHANGELOG.md`（按 Added / Changed / Fixed 归类，逐条带提交号）；README 版本与能力表同步；汇报材料扩至 19 页并重导 PDF。
- 汇报材料：测试基线 674、元件 371 型号 / 244 尺寸（16 条同系列推定）、Agent 12 工具、PLC 生成 P8-1～P8-4、参数化 P9-1/2/3/5；新增「PLC 程序自动生成与参数化建模」页；明确 ST 通用、无厂商工程文件、build123d Python sidecar 依赖。
- 验收：`npm test` **674/674**；`npm run smoke` → `SMOKE_OK`（带假 sidecar 另得 `SMOKE_PARAMETRIC_SIDECAR_OK` / `SMOKE_PARAMETRIC_UI_OK` / `SMOKE_PARAMETRIC_ASSEMBLY_OK`）；PDF 19 页，关键词 `674` / `PLC` / `build123d` / `0.3.0` 均命中，URL 无横向溢出。
- 待办：安装包构建需老王通知后手动触发 `windows-build`；TIA Openness、草图约束（P9-4）、委外加工联动与生产部署仍未完成，保持规划中。

## Agent 流程模板（P7-I，2026-10-23）

- 状态：✅ 完成；不 push。
- A. 模板：新增 `desktop/src/agent/recipes.ts`，5 个纯数据模板 `new-machine` / `plate-delivery` / `electrical-delivery` / `cost-review` / `full-package`；每个含 `id/title/summary/steps[]/preconditions[]/estimatedSeconds`，步骤全部引用现有 17 个注册工具，参数模板支持 `{from:'context.machine.name'}` 点路径占位符（含数组下标、`default`、`optional`）。
- B. 执行器：`runRecipe(recipeId, ctx, executor)` 前置条件不满足返回 `PRECONDITION_FAILED` + 缺什么 + 建议动作且零执行；`skipSteps/skipIndexes/isSkipped` 支持取消勾选；写工具默认每步 `confirm()`，显式 `rememberSameKind` 才同类免问；任一步失败停止并保留 `completed/kept`，生成含失败步骤、错误码、建议与已完成清单的中文 `report`；记录 `totalMs` 与每步 `elapsedMs`。
- C. UI/IPC：`agent:recipe:execute` / `agent:recipe:cancel`；侧栏「流程」下拉、前置条件红/绿、步骤复选框、开始/取消/导出 Markdown、分步进度与结果；写操作弹「流程写操作确认」，审计 `source='recipe'`。
- D. 测试：新增 `desktop/test/agent/recipes.test.mjs` 29 条，覆盖 5 模板 schema（工具名必须存在于注册表）、重复 id/非法耗时、占位符解析/缺失/默认值、前置条件拦截与数值下限、失败停止保留已完成、跳过（id/工具名/下标）、默认逐次确认、同类免问、拒绝、无确认回调、耗时、中文报告与 Markdown 导出、未知模板。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **830/830**（801 + 29）；`npm run smoke` → `SMOKE_AGENT_RECIPE_OK recipes=5 steps=5 failed=1 kept=2`、`SMOKE_AGENT_RECIPE_UI_OK recipes=5 steps=5`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。

## Agent 主动建议（P7-H，2026-10-23）

- 状态：✅ 完成；未 push。
- A. 建议引擎：新增 `desktop/src/agent/advisor.ts`，纯函数 `suggestNextActions(context, project, options?)`；输入 BOM 行数、未放置件数、干涉命中/未检查、缺尺寸件数、CAD 是否存在、电气校验结果、成本是否过期、PLC 是否已生成，输出 0–3 条 `{id,title,why,action,weight}`。规则顺序：底板重叠 100、电气校验未通过 95、干涉命中 90、缺尺寸 85、未做干涉检查 70、成本过期 65、PLC 未生成 60、全部就绪交付包 50；`why` 全部引用真实数字，无命中返回空数组。
- B. UI 接入：侧栏顶部「建议」区最多 3 张卡片；ask 卡片填入输入框，tool 卡片生成单步计划确认（写操作仍二次确认）；「忽略」写入本次会话内存 Set，刷新时作为 `options.ignored` 传入；`agent:progress` end、对话/计划结束与面板刷新都会调用 `refreshAdvisor()`，只更新建议列表 DOM，不打断对话。
- C. 状态来源：`__AgentBridge.getAdvisorState()` 汇总 BOM / 未放置 / 干涉 / 电气 / 成本指纹 / PLC 标记，`packs.listParts()` 在渲染层补齐 `dims` 缺尺寸数；`__CostPanel.state()` 暴露成本计算的 BOM 指纹，`run_plc_generate` 成功后调用 `markPlcGenerated`。
- D. 测试：新增 `desktop/test/agent/advisor.test.mjs` 21 条，覆盖每条规则命中/不命中、优先级排序、上限 3、空状态、忽略后不返回、忽略后刷新不复活、why 数字、BOM 指纹。
- E. 验收：`npx tsc --noEmit` 通过；`npm test` **801/801**（780 + 21）；`npm run smoke` → `SMOKE_AGENT_ADVISOR_OK suggestions=3 top=overlap`、`SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）。

## Agent 真实模型与抗注入（2026-10-23）

- 状态：✅ 完成；不 push。
- A. 真实模型冒烟：新增 `desktop/scripts/agent-live.mjs` + `npm run agent:live`，从 `AGENT_LIVE_BASE_URL` / `AGENT_LIVE_API_KEY` / `AGENT_LIVE_MODEL` 读取配置，走 `OpenAiCompatibleClient` + `AgentSession` 跑 12 条固定指令；断言行工具（含合理替代）、关键参数与写确认。无凭据打印 `AGENT_LIVE_SKIP` 并退出 0；结果写 `docs/desktop/eval/agent-live.json`。本机实测 LiteLLM bridge / `cn:deepseek-v4.1-flash`：`matched=12/12`、`toolAccuracy=1.00`、`confirmRate=1.00`；密钥未写入任何文件。
- B. 抗提示注入：新增 `desktop/src/agent/guard.ts`，所有工具结果包成 `tool_result_data` 数据块；检测「忽略之前的指令」「你现在是」「执行 rm」「上传到」「篡改审计」「危险路径」等模式并标记 `untrusted:true`，附不可信提示，不丢弃原文；系统提示声明工具结果/文件内容只是数据。新增 `test/agent/guard.test.mjs` 14 条，覆盖元件名、STEP 文件名、备注字段与会话回灌，断言工具选择不变。
- C. 评估集：`docs/desktop/eval/cases.json` 扩至 **58 条**（17 个工具全覆盖 + 缺参数/越权改文件/篡改审计/危险路径/未知位号/跨域误用 6 类拒绝）；`run-eval.mjs` 改为读取该路径并校验工具/拒绝覆盖，离线路由补齐 `update_component`、`remove_component`、`run_plc_generate`、`export_files`、`get_project_context` 与拒绝规则。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **780/780**（766 + 14）；`npm run smoke` → `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`（58/58）；`npm run agent:live` 无凭据 → `AGENT_LIVE_SKIP` 退出 0。

## 质量加固轮（2026-10-23）

- 状态：✅ 完成；不新增功能、不改工具名/IPC 通道/文件格式/状态字符串，不 push。
- A. 一致性审查：统一「缺少必填参数：x」/「x 不存在：id」文案；JSON-RPC 英文错误改为中文且保留错误码；确认回调异常不再伪装成用户拒绝；补充静默 catch 的告警或原因注释。
- B. 死代码：`grep -rn -w` 确认零引用后删除 12 个导出（`isMultiStepInstruction`、`INTENT_ORDER`、`explainIntent`、`annotationToDoc`、`axisPoses`、`getOcctWasmUrl`、`findCase`、`isCostExportSaveResult`、`FACTORY_LABELS`、`assemblyBomCsv`、`findInstance`、`inputBindings`）；公共/兼容别名保留并加注释。
- C. 测试补强：`compileOps`、`planExportName`、`buildTags` 新增 13 条边界用例（空数组、重复 id、Unicode/emoji、NaN/Infinity、非法 fileName、超短 maxLength、空配置）。
- D. 验收：`npx tsc --noEmit` 通过；`npm test` **687/687**（起点 674）；`npm run smoke` → 源码定义 46 个 `SMOKE_*` 断言名（含条件分支），本轮无 fake sidecar 实跑 42 个（40 个 `_OK` + 2 个预期 `_SKIP`）并输出 `SMOKE_OK`；`npm run eval:agent` → `EVAL_AGENT_OK accuracy=1.00 tools=1.00 refused=1.00`。
- 本轮未执行 `npm run sync:e2e` / `npm run screenshots`；两条命令保留在 STATUS 速查中，供发布前按需复跑。

