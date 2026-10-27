# cadgen 侧车：转接板

这是架构文档 12.1.2 里一直没落地的 build123d 侧脚本的第一步，
用 text-to-cad 的 cadgen 引擎（不是把 text-to-cad 整个仓库拷进来）
把画布转接板节点的 FeatureDoc 翻译成可构建的实体。

## 模型

`adapter_plate.py`：规范演示转接板（`desktop/src/canvas/adapter-model.ts`
的 `adapterFeatureDoc()`，SLIDER60 → BODY48）：

- 板体 90×90×12 mm，6061-T6，平板通孔策略
- 从端 60×60（±30, ±30）：Ø5.5 通孔，顶面各带 Ø8.5×5 mm 沉窝（M5 头）
- 对端 48×36（±24, ±18）：Ø5.5 通孔，不沉孔
- 无定位销孔；四条竖直边 R3 圆角

注意：build123d 的 `fillet` 会返回一个丢掉标签和材料的新实体，
所以本脚本在圆角之后重新设置了标签、颜色和材料。

## 怎么跑（Linux 已验证，Windows 尚未验证）

```bash
# 先关遥测，再装 cadgen 0.8.0（首次下载较慢）
uvx --no-config --managed-python --python 3.13 \
  --from cadgen==0.8.0 cadgen telemetry off
uvx --no-config --managed-python --python 3.13 \
  --from cadgen==0.8.0 cadgen doctor

# 构建并导出 STEP（在本目录下跑）
cadgen run adapter_plate.py
cadgen export <id> adapter_plate.step
```

`<id>` 是构建输出里的那串 id。无头 Linux 上截图需要虚拟显示，
例如 `xvfb-run -a cadgen snapshot <id> out.png`。

## 校验目标（已验证）

- 包围盒：90×90×12 mm
- 体积：94,167 mm³
- 质量：0.2543 kg（6061）
- 导出的 STEP 独立重读后，包围盒、体积、质量与上述一致

## 未做 / 风险

- 还没有把 `planAdapterGeometry` / `adapterParams` 自动接进这个脚本，
  目前参数是按演示节点手写进脚本的；自动接线是下一步，不是本 PR 的范围。
- 本 PR 不改任何 TypeScript / 画布 / 成本代码，也不进入 `node --test`。
- Windows 11 风险未验证：OCP wheel 带未签名原生模块，
  Smart App Control 开启时可能报 DLL 加载失败，
  不要为此关掉 Smart App Control（关了需重装系统才能再开），
  可先在 WSL 下验证。
