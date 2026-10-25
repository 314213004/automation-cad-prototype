# 整机设计向导（五步）

面向非标自动化整机的**设计入口**：从中文需求走到可交付工程，人可操作、可回退、可续做。
在此之前，机型设计能力只对 Agent 工具（`design_machine` / `build_machine_model`）开放，界面只有装配/校核/出图；本文档描述补齐后的入口。

## 入口

| 位置 | 行为 |
|---|---|
| 顶栏「整机设计」按钮 | 打开五步向导（覆盖层） |
| 文件菜单 →「新建设计」 | 同上 |
| 有草稿时 | 按钮显示「继续设计（第 N 步）」，直接从上次的步骤继续 |
| `Esc` | 关闭向导；草稿保留 |

## 五步

### ① 需求
产品/机型名称、来料形式（散料/托盘/整列/卷料）、工艺类型（锁螺丝/点胶/检测/装配/包装，对应 `machine/templates.ts` 五类模板）、目标产能（件/分钟）、期望工位数（1–12，留空自动推荐）、上下料方式（人工/输送线/机械手）、占地限制（长×宽 mm，可留空）、供电制式（380/220 VAC）、品牌偏好（来自已启用元件库的 vendor）。
校验不通过时字段标红并在状态栏给出中文原因，不会静默失败。

### ② 方案对比（3 个候选）
同一需求用 `synthMachine` 生成 **3 个不同形态**的候选（例如 linear-4 / dial-6 / dual-lane），卡片并列展示：形态名与 id、工位数、产能与是否达标、占地、装机功率与计算电流、成本合计与缺价项数、BOM 行数、警告数；每个候选的 `assumptions` 与 `warnings` 全部展开，不折叠。可打开 3D 预览。选定一个作为主方案。

候选与 Agent 的 `design_machine` **同源**（都走 `completeDesign → synthMachine`），并有单测断言「同一 brief 两条路径输出一致」。

### ③ 工位与元件
左侧工位列表（增删/重命名/排序/切换）；右侧编辑当前工位的执行机构（名称、类型 气缸/夹爪/旋转、绑定型号、伸出/缩回/夹紧点位）与传感器（点位、安装工位、绑定型号）。每个工位有独立、自动生成的固定身份；改名和上移/下移不改变身份，已设置的真实几何 X/Y 偏移会继续跟随同一工位。复制工位若带来重复身份，系统会重建重复身份并仅清掉无法区分的相关偏移，不猜哪一份是原站；新增工位从生成器原点开始，删除工位只清掉该工位身份对应的偏移。
型号从元件库搜索选择（按 kind 过滤分类，结果 >20 条截断并显示总数）；新增机构按 `io-map` 命名规则自动分配未占用点位（`ST{n}-EXT-A{i}` 等），冲突给中文提示；型号不在库内返回 `PART_NOT_FOUND`。

### ④ 布局
包含两种彼此独立的视图：真实 `MachineGeometry.parts` 的俯视可选工位、输入 X/Y mm 或拖动平移；示意 `placements` 仍只用于二维预排布。真实几何的工位偏移会同步用于轴 pivot、3D、工程 JSON 和逐件 STL。界面中的 `st1` / `st2` 是随当前排序变化的临时编号，并非身份；需求重算会为新候选创建全新身份，旧偏移不按工位名或序号猜测迁移，向导会提示需要重新定位。若旧版工程只存了序号/名称偏移，打开后工程仍可读取，但不可靠的偏移会清除并显示告警。

工程师可在真实俯视图叠加按轴着色的**概念运动包络**，并查看未覆盖轴及「需人工复核」的 3D AABB 候选相交对象。linear 沿单位轴向量走完整 stroke，gripper 两指按 jaws ±sign 各走半程；rotary 仅覆盖枢轴/范围有效且严格绕世界 Z 的情形。其它或映射不完整的轴会显示未覆盖，不推测路径。告警是概念 AABB 初筛，可能误报/漏掉非 AABB 细节；线缆、夹具和真实机构未建模；无重叠不是无干涉或校核通过，也不改 reviewed geometry pass/errors。

> 工程操作：第 4 步俯视中的 X/Y 是**相对生成器原点的真实工位平移**，会用于几何预览、保存工程和单件 STL；二维 placements 是独立示意，不驱动这些几何。若恢复草稿时显示身份/偏移告警，按提示检查第 4 步，调整后重新运行一键校核。保存为工程会清除向导草稿；重开工程可查看已保存的偏移几何，但不会恢复成可编辑的向导草稿。

### ⑤ 校核与产出
一键校核四项：干涉（`mech/interference`）、节拍复核（`flow`）、功率与电流（`power`）、成本（`cost-model`）。结果分「错误（阻断）/ 警告（可继续）/ 通过」。
产出全部调用现有能力：生成 BOM、生成 PLC 工程（`plcgen`）、生成电气原理图、导出 PDF 报告。
最后「保存为工程」写入工程库（`projects:save`），并清理草稿；成功后文件菜单出现该工程，主视口载入该机型。已保存的真实工位几何偏移随工程几何可重开查看，但被清理的向导草稿不会作为可编辑状态恢复。

## 草稿与状态机

`userData/design-draft.json`（0600、原子写），结构：

```ts
interface DesignDraft {
  version: 1;
  step: 1 | 2 | 3 | 4 | 5;
  brief: MachineBriefInput;
  candidates?: MachineDesign[];   // 3 个
  selectedIndex?: 0 | 1 | 2;
  design?: MachineDesign;         // 含 stationIdentities 与可选 stationGeometryLayout
  stationIdentityNotice?: string; // 无法安全迁移时，持久提醒工程师
  stations: StationDraft[];       // id 是每站不可变身份，不是数组序号
  placements: Placement[];        // mm 坐标
  updatedAt: string;              // ISO 8601 +08:00
}
```

- 每次「下一步」自动保存；关闭向导不清草稿，只有保存工程或「放弃草稿」才删除。
- 草稿损坏时安全回落到第 1 步并提示。
- 修改第 1 步后显式重新生成候选；机构/传感器编辑只在旧、新两侧工位名称都唯一时才按名称尽力保留。重名时不猜配；真实几何偏移从不按名称或序号跨新方案迁移。

## 与 Agent 的关系

| 能力 | 向导 | Agent 工具 |
|---|---|---|
| 合成方案 | 第 2 步（3 候选） | `design_machine`（只读） |
| 落盘工程 | 第 5 步保存 | `apply_machine_design`（写，需确认） |
| 出实体模型 | — | `build_machine_model`（写视口，需确认） |
| 校核 | 第 5 步一键校核 | `run_interference_check` / `run_electrical_check` / `run_cost_report` |

两者共用同一套纯函数；任何一侧改算法，另一侧必须同步通过一致性测试。

## 验证

```bash
cd desktop
npx tsc --noEmit
TZ=Asia/Shanghai npm test                      # 含 test/design/* 与一致性用例
npm run build:ext
AUTOMATIONCAD_PARAMETRIC_CMD="node $PWD/scripts/fake-parametric-sidecar.mjs" npm run smoke
```

smoke 断言：

```text
SMOKE_DESIGN_ENTRY_OK
SMOKE_DESIGN_WIZARD_OK steps=5
SMOKE_DESIGN_CANDIDATES_OK count=3 distinct=3
SMOKE_DESIGN_CANDIDATE_DATA linear-4:18.87 件/分钟 · 达标 dial-6:15.87 件/分钟 · 达标 dual-lane:28.57 件/分钟 · 达标
SMOKE_DESIGN_LAYOUT_OK placements=13 overlaps=0
SMOKE_DESIGN_SAVE_OK project=<工程名>
```

## 已知边界

- 保存后主视口的零件计数正常（`cadPartCount` 为 61），但 `__AgentBridge.getScene().parts` 仍返回空，smoke 会打印
  `SMOKE_DESIGN_SCENE_BRIDGE_WARN bridgeScene=0 partCount=61`。两者是不同实例/时序问题，已记入 BACKLOG（影响 Agent 的 `get_bom`/`get_project_context` 对已打开工程的感知），待修。
- 几何俯视仍是概念占位体与 AABB 提醒；不是精确干涉、安全或工程签核。工位移出机架/占地需工程师人工复核。
- 候选固定 3 个（不同布局），不是穷举全部 11 形态。
