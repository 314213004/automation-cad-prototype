# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。
历史归档：只保留最近一轮的迭代记录；更早的完整记录按原文移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)（不进入离线知识索引，避免挤占 400 KB 上限）。

## 修复形态选型「越界预览」（2026-10-24，本轮）

- 状态：✅ 修复完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1529/1529**（较上轮 +20）、`npm run smoke` 更新为 `SMOKE_MACHINE_FORMS_OK forms=11 picked=dial-12 meets=1`；未 push、未打包。
- 缺陷：41 轮新增 8–12 工位形态后，`pickForm` 仍用**需求工位数**给所有候选算产能。`gantry-4`（4–4）被按 12 工位预演出 `109.09` 件/分钟，进入 `meeting` 池；`dial-12` 按真实 12 工位只有 `22.64` 件/分钟，最终按工位距离回退到越界的 `gantry-4`。
- 复现（修复前输出 `gantry-4` + 非标回退 warning）：

  ```bash
  cd desktop
  node --experimental-strip-types -e "import('./src/machine/spec.ts').then(async s=>{const f=await import('./src/machine/forms.ts');const b=s.parseMachineBrief('十二工位转盘检测机，节拍 60 件/分钟');const p=f.pickForm(b,{},{stationCount:b.stations,cyclePerMin:b.cyclePerMin});console.log(p.form.id,p.warning)})"
  ```

- 根因与修复：`Candidate` 新增 `clamped` / `previewStations`；`previewModel` 统一使用 `clamp(需求, stationRange)`；选型改为四档优先级「覆盖且达标 → 仅覆盖 → 仅达标（确无覆盖时）→ 全量按工位距离」。覆盖仍按需求工位数判定，warning 同时写支持范围、需求值与实际生成工位数；`synthMachine` 用 `formPick.stations` 生成配置，被夹紧时写入 `assumptions`。
- 回归：新增 `test/machine/form-clamp.test.mjs` 20 条，覆盖 12 工位检测/长线装配、14 工位超上限、6/8/10 工位矩阵、`config.stations.length <= form.maxStations`、夹紧后产能结论、缺价文案等。
- 功率/成本核对：`power.totalKw=2.176`、`cost.total=23172`、`missingCount=9` 与 `machine-case.json` 一致；9 个缺价件的 `partId` 与名称已列在 `MACHINE-DESIGN-DEMO.md`。内置价格簿只有 4 条示例价，真实型号均无价格，确认不是匹配 bug；方案卡缺价文案改为「9 项缺价，合计为不完全统计」。

## 功率与成本接入统一模型（2026-10-24，上一轮）

- 状态：✅ 完成；`tsc` 干净、`TZ=Asia/Shanghai npm test` **1509/1509**（较上轮 +30）、`npm run smoke` 新增 `SMOKE_MACHINE_POWER_OK kw=1.092 a=1.844 breaker=6` 与 `SMOKE_MACHINE_COST_OK total=10614 missing=8`；未 commit、未 push、未打包。
- 功率：新增 `desktop/src/machine/power.ts` 纯函数，删除 `synth.ts` 中写死的 `POWER_VA` 表。优先读取元件库 `ratedW`（伺服/电源/安全光栅等），缺失时按类别默认值估算并逐条写 warning 与 assumption；支持 `Ks=0.7 / Kf=0.6 / η=0.9 / cosφ=0.9`、单相/三相/24V 电流、断路器取档（6–63 A）、24V 电源余量（>70% 告警）与已选总进线断路器交叉校验（超流/余量 >60% 可降档）。
- 成本：新增 `desktop/src/machine/cost-model.ts`，按机械件/电气件/人工分项；价格优先级为「企业价格簿 → 元件库参考价」，缺价行标 `missing` 且不计入合计；伺服按「驱动器 + 电机」成对补齐；人工按工位数 × 默认 18 h/工位 × 形态系数 × 120 元/h 估算。边界明确为方案阶段粗估，不替代 `cost/engine.ts` 正式报价。
- 参数：`<userData>/machine-pricing.json` 支持同时系数、负载率、效率、`cosφ`、工时单价与每工位工时；文件缺失/字段非法逐项回落默认值并写入 assumptions。
- 接入：`synthMachine` 返回 `power/cost`；`design_machine` 在 BOM 映射后复算功率与成本；方案卡显示 kW/A/断路器建议/24V 余量与材料/电气/人工/合计/缺价数，并合并展示设计、功率、成本 warnings；`apply_machine_design` 落盘同时校验新字段。
- 案例：`npm run build:machine-case` 重算六工位双轨案例为 `2.176 kW / 2417.79 VA / 3.673 A / 6 A 3P / 24V 余量 79.2%`；成本 `材料 5136 / 电气 2484 / 人工 15552 / 合计 23172 / 缺价 9`。人工明细 6 工位 × 18 h × 1.2 × 120 = 15552 元（129.6 h）。
- 测试：新增 `desktop/test/machine/power-cost.test.mjs`（29 条），覆盖单/三相电流公式、系数与效率影响、`cosφ`、断路器取档、24V 余量、缺额定功率、成本分项/缺价/伺服成对/工时随工位变化、参数文件缺失与非法回落、方案卡字段、两类交叉校验 warning，以及 `design_machine` 结果超过通用 10 KB 时仍完整保留给方案卡；`demo-doc.test.mjs` 增加功率/成本数字与案例 JSON 的一致性断言。
- 文档：`MACHINE-DESIGN.md` 新增「功率与成本模型」公式、默认系数、参数文件与适用范围/不适用场景；`MACHINE-DESIGN-DEMO.md` 功率/成本两节按新数字重写；根 `README.md`、`desktop/README.md` 同步测试数与 smoke 证据。

## 待办（按优先级）

- 当前无待推进的 P1–P7 项；已完成记录已移入 [BACKLOG-HISTORY.md](BACKLOG-HISTORY.md)「已完成迭代归档（P1–P7）」。

## 待决策（需要老王拍板，不阻塞其他开发）

| # | 问题 | 选项 | 影响 | 建议 | 状态 |
|---|------|------|------|------|------|
| D1 | 价格簿的真实单价从哪来 | A 采购/财务给正式价目表；B 用公开目录价并标注来源；C 先空着只做结构 | 成本报告能否用于报价 | B 先跑通，正式报价前换 A | 待定 |
| D2 | 智慧工厂生产环境谁来部署 0.22.0 | A 对方运维；B 我们远程部署；C 只在测试环境验证 | 端到端联调能否做 | A，我们提供验收清单 | 待定 |
| D3 | PLC 程序生成首期目标平台 | A 通用 ST 优先；B 西门子 S7 优先；C 汇川/三菱优先 | 模板与变量表格式 | A，其次按现场实际 | 待定 |
| D4 | 委外加工数据智能系统是否立项 | A 立项并定义接口；B 先只做数据导出；C 暂缓 | 路线图与汇报口径 | B 过渡，接口按 A 设计 | 待定 |
| D5 | 元件库缺失尺寸（180/371）能否用「同系列壳体推定」 | A 允许并标注推定；B 只用实测/官方值，缺的留空 | 底板布置覆盖率 | A + 标注，人工复核 | ✅ 已按 A 执行：244/371（65.8%），官方 37 + 推定 16；剩余 127 条留空，清单见 `docs/desktop/DIMS-GAPS.md` |
| D6 | 参数化建模首期范围 | A 只做单件结构件；B 单件+多体装配；C 直接上草图约束 | 工期（A≈3 周，B≈6 周） | A 先交付，B/C 分期 | 待定 |
| D7 | 成本面板如何拿到 BOM（CAD 零件名 → 元器件物料号映射口径） | A 由底板画布/电气元件库直接给 partId，成本面板只读；B 允许「零件名规则匹配 + 人工确认」自动填 partId；C 保持手工导入 BOM JSON | 影响成本能否一键算；B 需要命名规范（如 `QF1:LC1D09`），否则匹配率低 | A 长期方向，短期用 C + 预留 B | 待定 |
| D8 | Agent 的 `run_cost_report` 是否允许落盘导出报告 | A 保持只读，只回摘要；B 增加写工具 `export_cost_report`（PDF/CSV，走现有二次确认）；C 由面板导出，Agent 只给「点哪里」 | 影响「一句话出报价单」的体验；B 需要确认文件名/目录规则与覆盖策略 | B：`export_cost_report` 固定写 `userData/exports/`，默认不覆盖、冲突追加序号 | 已定 B，已实现（`23cd284`） |
| D9 | 离线规则路由是否要在「模型可用时」也前置生效 | A 仅在模型失败时降级（现状）；B 高置信度只读指令直接走规则，省一次模型调用；C 全走模型 | B 更快更省 token，但规则误判时用户得不到语义纠正，且两套路径要长期保持一致 | A 先稳定；若要 B，先攒 40 条评估集对比准确率再开 | 待定 |
| D10 | 中文评估集用哪条通道跑基线 | A 只用离线规则路由（零成本、可离线、但只覆盖规则能判的句式）；B 规则 + 真实模型双跑（能测语义理解，按 token 付费）；C 只跑模型 | 决定评估结论代表「规则上限」还是「产品上限」；B 需要一把可用的付费/自建模型 key 与预算口径 | A 先立基线并进 CI 友好（无网络），B 作为发布前手动回归；已落地离线 61 条 + 真实模型 30 条（`agent:live`，30/30；拒绝/澄清 6/6） | ✅ 已按 B 执行 |

## 已知问题（记录，不阻塞）

1. **3D 联动原为写死 5 零件**：已由 P3 通用化改造解决；STEP 不含运动学，任意装配体仍需标注层。36-auto-kinematics 起可按名称/型号/层级/几何自动给出标注**建议**（需逐条确认），但识别是启发式：命名不规范或几何不典型的机构仍需人工标注，斜向运动只能取最近主轴，夹爪对侧手指、缩回位与无型号行程仍需人工确认。 迭代 34 起机型方案的 3D 改为参数化整机几何，但仍是标准件外形，不是结构设计。
2. **尺寸数据覆盖不全**：已补至 266/379（70.2%；16 条同系列推定，2026-10-24 第二批 22 条全部为官方尺寸），仍缺 113 条；缺失元件在底板画布上按「未标注尺寸」处理，需人工补（清单与来源见 DIMS-GAPS.md）。
3. **OPC UA 仅 SecurityPolicy=None**：接真实 PLC 前必须加证书与 Basic256Sha256（Issue #3）。
4. **无代码签名**：Win11 SmartScreen 会拦一次；发行前需证书。
5. **CI 为手动触发**：按老王要求，不自动构建；要包时 `gh workflow run windows-build`。
6. **数据准确性**：元器件参数为公开样本汇总，定型前以铭牌/最新样本为准（manifest 已声明）。
7. **前端原型限制**：原型自身 3D 仍为固定等轴测投影（插入与撤销已真实化）。**桌面版已缓解（35-orbit-view + 收尾）**：有 WebGL 时主视口为可旋转 three.js，缸径/行程与桌面版尺寸/位置编辑沿叠放链重建几何；桌面版几何编辑已进撤销栈（与原型合成一条时间线）、内置零件覆盖持久化到工程存储，WebGL 模式支持 Shift+拖拽 / 「框选」模式多选。仍未解决：几何为参数化示意体（非 B-rep、无配合求解、缸径为原型示意比例）；插入件尺寸覆盖不持久化（原型不持久化插入件）；3D 存储为单键、不按机型分桶；撤销对账依赖原型状态栏文案（原型改文案需同步改 `parseProtoCounts`）；无 WebGL 时回到固定等轴测。
8. **真实模型拒绝/澄清类**：已从 4/6 修到 6/6（判定语义修正 + 两条系统提示）；但仍是单模型单轮结果，换模型或换措辞需重跑 `npm run agent:live`，不要把 30/30 当成通用结论。
9. **离线意图路由是关键词规则**：同义表达未收录会判「超纲」；审计文件只追加、未做轮转与保留期清理；审计面板最多显示最近 200 条（可筛选/导出），回执不含 token 用量（网关未回传 usage）。 **2026-10-24 更新（feat/agent-audit-router）**：① 审计已按大小轮转 + 保留期清理（默认 5 MB × 5 份 × 90 天，可配置），面板/报告读全部保留份数；被保留期删除的份数不可恢复，CSV 仍只导出面板当前列表（≤200 条）。② 路由已系统补同义/口语词并加非工程话题拦截（评估集 102 条）；仍是关键词规则：未收录的说法照旧判超纲，「撞」「会动」「规划」等单字/泛词可能把边缘句子拉进工程意图，非工程话题表是有限枚举。回执 token 用量问题未变。
10. **多轮评测证据仍是 5/6**：`docs/desktop/eval/agent-multiturn.json`（Fri 2026-10-23 8:28 PM CST (UTC+08:00)）中 MT04「拒绝后自动重试」两轮未过；会话层拒绝记忆已修复，但尚未有新的真实模型多轮 JSON，报告按现有证据展示，重跑 `npm run eval:agent:multiturn` 后再更新。 **2026-10-24 更新**：上述描述已过时——仓库内 `agent-multiturn.json` 已是修复后的真实模型结果（`cn:deepseek-v4.1-flash`，生成于 Fri 2026-10-23 10:08 PM CST (UTC+08:00)，6/6 场景、15/15 轮，MT04 通过），Agent 报告按此展示。本轮补了 `test/agent/multiturn-mt04.test.mjs` 会话层确定性回归（fake LLM 回放 MT04：原样重试与 `partId` 写法重试都被短路、不弹确认）。本机无 `AGENT_LIVE_BASE_URL/API_KEY/MODEL`，**真实模型重跑待有 key 时执行**（换模型/换措辞仍需重跑，单模型单次结果不是通用结论）。遗留边界：拒绝记忆按「工具 + 目标」匹配，模型若在「继续」后改用别的写工具动同一目标（如 `remove_component QF1`）仍会走确认框，真实评测会算违规。
11. **两条成本导出单测依赖本地时区**：`test/cost-export.test.ts` 的文件名断言按 Asia/Shanghai 本地时间（`…-20261023-1200`）；在 UTC 环境（如本轮沙箱）直接 `npm test` 会 1130/1132，需 `TZ=Asia/Shanghai npm test`。35-orbit-view 未改这两条断言，只记录。
12. **安全光栅型号与截图（已补录，2026-10-24）**：`iec-cn` 已补 8 条官方来源的 Type 4 安全光栅，六工位案例 BOM 初选 `F3SG-4SRA0640-14`；四张机型截图已在 xvfb + Electron 下重拍，17 号 BOM 图不再显示「待选型」。仍待：安全距离按 ISO 13855 用现场停机时间核算。
13. ✅ **已修复（提交号：accaf9d）——节拍模型未区分「并行同工序」与「流水线分工序」**（原问题记录，2026-10-24 发现）：`synthMachine` 原先只按流水线建模——产能由最慢工位决定，补并行工位只针对瓶颈工序。因此「六工位锁螺丝机、20 件/分钟」被判为不达标（3.18 s/件 > 3.00 s/件，建议 12 工位），但 6 个**同工序并行**工位的实际产能应为 `6 / 3.18 × 60 ≈ 113 件/分钟`。影响：机型方案卡与 `machine-case.json` 的节拍结论偏保守，`MACHINE-DESIGN-DEMO.md` 已如实标注「若坚持该估算模型需 12 工位」。修复：`MachineBrief` 增加 `layout` 与 `processes`，解析器按流水线关键词/多工序推断 `line`，单一工艺推断 `parallel`；`MachineCycleEstimate` 增加 `mode`、`stationSeconds`、`throughputPerMin`，并行按 `stations / stationSeconds × 60`、流水线按 `60 / 最慢工位` 计算；新增 `test/machine/cycle-mode.test.mjs` 19 条与 `SMOKE_MACHINE_CYCLE_OK`，六工位案例重算为 `113.21 件/分钟`、`meetsTarget=true`。

## 夜间执行约束

- 只做代码与文档，不打包、不触发 CI、不发版
- 每轮只推进一步；改完必须 `npm test` + `npm run smoke` 全绿才提交
- 失败则回滚本次改动（`git checkout -- <改动文件>`），把原因写入本文件
- 不修改 `index.html` / `app.js` / `styles.css` / `electrical.*`，除非该任务明确要求
- 不删除既有测试来「变绿」；不放宽断言规避失败

## 仓库双推约定（GitHub + Gitee，2026-10-24 起）

- 主仓库：`origin` = GitHub `owlco001/automation-cad-prototype`；镜像：`gitee` = Gitee 同名仓库（公开）
- `origin` 配置了两个 push URL（GitHub 在前、Gitee 在后），因此 `git push origin main` 会自动双推；任一远端失败则整体失败，**不允许只推成功一边**
- 推 tag 必须用 `git bothpush`（等价于 `git push origin main && git push origin --tags`），普通 push 不带 tag
- 新增 tag 后必须核对：`git ls-remote origin refs/tags/<tag>` 与 `git ls-remote gitee refs/tags/<tag>` 都存在且指向同一提交
- 发版/合并后复核三方 HEAD 一致：
  `git rev-parse HEAD`、`git ls-remote origin refs/heads/main`、`git ls-remote gitee refs/heads/main`
- Gitee 偶发 5xx 或超时：重试一次即可，不要改成只推 GitHub 了事；连续失败要在本文件记录时间与错误码
- 凭据只存在 `~/.git-credentials`，禁止写进仓库、提交信息或日志
