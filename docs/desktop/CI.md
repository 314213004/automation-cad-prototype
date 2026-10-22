# Windows 安装包构建（CI）

工作流：[`.github/workflows/windows.yml`](../../.github/workflows/windows.yml)，运行在 `windows-latest`，产出 NSIS x64 安装包。

## 触发方式

当前**只支持手动触发**（没有 push / PR 自动跑）：

```bash
gh workflow run windows-build --ref main
gh run watch
```

推 `v*` tag 时同一流程会把 `AutomationCAD-Setup-*.exe` 与 `.blockmap` 发布到 GitHub Release（`softprops/action-gh-release`）。v0.2.0 即由此产出。

## 流程

```
npm ci → npm run build:ext → npm test
       → electron-builder --win nsis --x64 --publish never
       → upload-artifact: release/*.exe + *.blockmap（保留 14 天）
```

`CSC_IDENTITY_AUTO_DISCOVERY=false`：没有签名证书，构建时跳过签名而不是报错。安装包因此未签名，Win11 SmartScreen 首次会拦截。

## 本地产物（备用）

在 Linux 上交叉构建 NSIS 需要 wine32 生成卸载器；本机 PVE 装 i386 会与 apt 依赖冲突，因此只出免安装包：

```bash
cd desktop
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win zip --x64
```

产物在 `desktop/release/`（已在 `.gitignore` 中，不入库）。

> `docs/desktop/windows.yml.example` 是启用 CI 之前的草稿，内容已被正式工作流取代，仅留作历史参考。
