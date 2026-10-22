# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。

## 待办（按优先级）

### P1 电气智能辅助（线号合规 + 功率统计）
- 状态：✅ 已完成（`5352832` 规则引擎 + `652e031` 面板/PDF/Agent 工具）
- 已完成：线号合规（缺号/格式/同网重复/跨网络重号/相线电位不符/数字跳号）、功率统计（kW/kVA、需要系数、分相电流、不平衡度、主断路器+进线截面建议、24V 电源余量）、导线截面 vs 载流量与断路器配合校验；`runElectricalCheck` 汇总按级别排序
- 已完成（本轮）：`src/elec/ui.ts`「电气校验」面板（9 张统计卡 + 级别/位置/建议问题表 + 导出 PDF）、`src/elec/report.ts` A3 横向报告、Agent 命令与工具 `run_electrical_check`（含入参校验）、smoke 面板链路自检 `SMOKE_ELEC_CHECK_UI_OK rows=4 cards=9 pdf=true`
- 数据来源：面板通过 `window.__ElecDocProvider` 取电气文档，未注入时明确提示而不伪造数据 —— 待原理图数据接线后可直接复用。
- 验收：`npm test` 221/221（本轮 +14）；`npm run smoke` → `SMOKE_OK`

### P2 电箱底板画布（真实尺寸布局）
- 状态：✅ 已完成（`df8f1a2`）：185 测试、`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`；尺寸覆盖 191/371
- 内容：mm 坐标 2D 画布，底板尺寸可设，元件按 `dims{w,h,d}` 真实尺寸绘制，拖放/吸附导轨/碰撞标红/利用率统计
- 验收：`SMOKE_ENCLOSURE_CANVAS_OK placed>=1 overlap=0`

### P3 联调 3D 通用化
- 状态：✅ 配置驱动已完成（`71b5e18`）：4 工位 / 12 执行机构 / 16 传感器，smoke `parts=16 ticks=57`
- 运动学标注数据层：✅ 已完成（`8d5835d`，`desktop/src/cad/kinematics.ts`）——动件 → 轴/行程/方向/点位绑定，`checkKinematics` 中文校验（动件不在 STEP、行程非正、缩回超行程、直轴填角度、点位不在 IO 表、同点位被占）、`axisPose` 姿态解算（含双信号冲突）、`crossCheckMachineConfig` 行程/类型/未绑定核对、JSON 存取与不可变编辑；23 条单测，全套 244/244，`SMOKE_OK`
- 标注 UI：✅ 已完成（`b0e6df3`）：网格多选建动件、轴/方向/行程/缩回位/点位编辑、实时中文校验、滑块预览与复位、localStorage 按文件分桶、JSON 导入导出；联调 3D 改为标注优先/配置回退（黄条说明原因）。258/258，`SMOKE_KINEMATICS_UI_OK parts=2 errors=1 slide=25`
- P3 状态：✅ 完成（配置驱动 + 运动学标注闭环）

### P4 大模型性能
- 状态：✅ 已完成（`f6962b3` 规划层 + `71c0e9b` 批次层与视图器接入）
- 已完成（规划层）：零件元数据（三角面/包围球/几何指纹）、平移无关指纹（STEP 顶点是世界坐标，仅平移不同的同款件仍能合批）、视锥剔除、覆盖率 → LOD0/1/2 分级（小件不降级）、实例分组（同指纹同色、仅 LOD0，附带每实例中心）、drawCall/三角面预算、中文配置校验与中文概要 `describePlan`
- 已完成（批次层，`src/cad/render-batch.ts`）：几何按中心归零 + 每实例平移矩阵（列主序，可直接喂 `Matrix4.fromArray`）、确定性三角面抽样简化、包围盒代理（12 面）、渲染指令表 `buildRenderOps`（hidden/lodCounts/drawCalls/triangles）与中文概要 `describeRenderOps`
- 已完成（视图器接入）：`viewer.ts` 建 `batchGroup`，按指令表开关可见性、按 LOD 换几何（LOD0 原模 / LOD1 抽样 / LOD2 代理盒）、按实例组建 `InstancedMesh`（原始 mesh 保留给拾取、导出与运动学，仅隐藏不绘制）、相机移动 150ms 节流重算、运动学姿态变化后刷新实例矩阵、拾取支持 `instanceId → partIndex`；新增 `getRenderPlanText()`
- 基准：`npm run bench:render` → 10 万面 / 500 零件 `metaMs≈61 planMs≈1.3 drawCalls 500→20（省 96%）budget=OK`
- 验收：`tsc --noEmit` 通过；`npm test` **355/355**（新增 16 条批次层用例）；`npm run smoke` → `SMOKE_OK`
- 已知限制：冒烟环境无 GPU（走 WebGL 降级路径），实例化/LOD 的真实 FPS 尚未在有显卡的机器上实测；下一步可选做「渲染面板显示当前计划」与 GPU 实机 FPS 基准

### P5 智慧工厂服务端
- 状态：⏸ 需老王确认是否动 material-flow 仓库
- 内容：按 `docs/desktop/SMART-FACTORY-INTEGRATION.md` 实现 `/api/v1/design-sync/*`

### P6 机台硬件成本自动统计
- 状态：🔄 P6-1 ✅ 引擎完成（`a8c1e5f`）：价格簿校验 + 计算引擎，43 条成本用例，301/301，`SMOKE_COST_OK lines=6 missing=1 grand=1398.64`；示例价条目自动排除。下一步 P6-2 面板/导出
- 分期：P6-1 价格簿+引擎 → P6-2 面板/导出 → P6-3 Agent 工具 → P6-4 与智慧工厂采购价对接
- 验收：单测 ≥20、`SMOKE_COST_OK`、500 行 BOM < 50ms

### P7 自然语言交互 Agent
- 状态：🔄 设计完成（`docs/desktop/NL-AGENT.md`）
- 范围：15 个工具、上下文注入、意图路由、写操作确认、审计、40 条中文评估集
- 分期：A 只读问答 → B 单步写 → C 多步规划 → D 联调/同步/语音
- 验收：`SMOKE_AGENT_NL_OK intents=7 tools=15 audit=3`，误写率 0

### P8 设计完成后自动生成 PLC 程序
- 状态：🔄 设计完成（`docs/desktop/PLC-CODEGEN.md`）
- 范围：预检（地址重复/越界/双线圈/安全缺失）→ IO 变量表 + ST 程序块（OB1/气缸 FB/夹爪/轴/自动状态机/报警/安全）→ 导出 zip 与映射表
- 分期：P8-1 预检+变量表+FB → P8-2 序列/报警/安全 → P8-3 UI 与导出 → P8-4 模拟器自检 → P8-5 TIA Openness（可选）
- 验收：demo 机型 9 文件、预检 0 错、三次生成 sha256 一致、模拟器 6 步跑通

### P9 参数化建模（build123d 内核）
- 状态：🔄 已选型 build123d 0.13.0（2026-10-23 拍板），P9-1 sidecar 原型已验证
- 实测：建模 25–50 ms、STEP 8–11 ms、回读体积/面数一致、常驻 424 MB、冷启动 2.3 s
- 方案：[PARAMETRIC-CAD.md](PARAMETRIC-CAD.md)；对比：[PARAMETRIC-CAD-SPIKE.md](PARAMETRIC-CAD-SPIKE.md)
- 分期：P9-1 sidecar+契约 → P9-2 主进程生命周期/IPC → P9-3 特征树 UI → P9-4 草图约束 → P9-5 装配与 BOM/成本联动
- 验收：`SMOKE_PARAMETRIC_OK features=4 faces=19 volume=71495.7`

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决中；STEP 不含运动学，任意装配体仍需标注层。
2. **尺寸数据覆盖不全**：只收录可核实条目，缺失的元件在底板画布上按「未标注尺寸」处理，需人工补。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：3D 为固定等轴测投影，属性编辑不改拓扑（插入与撤销已真实化）。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败
