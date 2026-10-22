# Windows 安装包 CI（待启用）

当前 GitHub token 缺 `workflow` scope，无法推送 `.github/workflows/`。启用步骤：

1. 授权：`gh auth refresh -h github.com -s workflow`
2. 把 `docs/desktop/windows.yml.example` 复制为 `.github/workflows/windows.yml`
3. 推送后即触发 `windows-build`，产物为 `AutomationCAD-Setup-<version>.exe`（NSIS x64）

在此之前，本机可产出便携包：
```bash
cd desktop
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win zip --x64
```
（Linux 上 NSIS 需要 wine32 生成卸载器，本机 PVE 不宜安装 i386 架构。）
