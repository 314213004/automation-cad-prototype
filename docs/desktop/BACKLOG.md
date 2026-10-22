# 夜间迭代看板（BACKLOG）

用途：无人值守时按优先级逐条推进，每条必须有测试/冒烟证据；遇到阻塞只记录、不硬改。
维护规则：完成一项把状态改为 ✅ 并写提交号；新问题追加到「已知问题」，不要删除历史。

## 待办（按优先级）

### P1 电气智能辅助（线号合规 + 功率统计）
- 状态：⬜ 待开工
- 内容：`desktop/src/elec/` 规则引擎：
  - 线号合规：重复线号、缺号、格式（`L1/L2/L3`、`24V/0V`、`101…`）、同一线号跨电位
  - 功率统计：按元件额定功率汇总 kW/kVA、分相电流、需要系数、主断路器与进线建议、24V 电源余量
  - 导线截面 vs 电流对照校验
- 交互：电气域新增「电气校验」面板，列出问题（级别/位置/建议），可导出 PDF；新增 Agent 工具 `run_electrical_check`
- 验收：`npm test` 新增≥10；smoke `SMOKE_ELEC_CHECK_OK findings>=1`

### P2 电箱底板画布（真实尺寸布局）
- 状态：✅ 已完成（`df8f1a2`）：185 测试、`SMOKE_ENCLOSURE_CANVAS_OK placed=2 overlap=1`；尺寸覆盖 191/371
- 内容：mm 坐标 2D 画布，底板尺寸可设，元件按 `dims{w,h,d}` 真实尺寸绘制，拖放/吸附导轨/碰撞标红/利用率统计
- 验收：`SMOKE_ENCLOSURE_CANVAS_OK placed>=1 overlap=0`

### P3 联调 3D 通用化
- 状态：✅ 配置驱动已完成（`71b5e18`）：4 工位 / 12 执行机构 / 16 传感器，smoke `parts=16 ticks=57`
- 下一步：STEP 运动学标注（选动件 / 轴 / 行程 / 绑点位）——未开工

### P4 大模型性能
- 状态：⬜ 待开工
- 内容：CAD 查看器 InstancedMesh、LOD、按需加载；目标 10 万面模型首帧 <3s
- 验收：基准脚本输出解析耗时与 FPS

### P5 智慧工厂服务端
- 状态：⏸ 需老王确认是否动 material-flow 仓库
- 内容：按 `docs/desktop/SMART-FACTORY-INTEGRATION.md` 实现 `/api/v1/design-sync/*`

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
