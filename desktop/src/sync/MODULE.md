# 模块：智慧工厂设计同步（src/sync/）

职责：把当前模型的 BOM/PDF/GLB/DXF 导出物打成设计包，按 `/api/v1/design-sync/*` 契约上传到智慧工厂。网络请求、PDF 生成、ZIP 与服务端文件读写全部在主进程完成；渲染层只生成导出数据并显示结果。

## 文件分工

| 文件 | 作用 |
|------|------|
| `types.ts` | `SyncConfig` / `DesignManifest` / `SyncResult`，以及列表、diff、上传载荷类型 |
| `package.ts` | 纯函数：固定路径打包、SHA-256、manifest 生成、缺失文件跳过与记录 |
| `client.ts` | `SyncClient`：测试连接、上传、列表、diff、下载；统一 15 秒超时并返回中文错误/阶段码 |
| `config.ts` | `userData/sync.json` 读写、权限 600、API Key 掩码与保留策略 |
| `ui.ts` | 顶栏「智慧工厂」设置页、测试连接、立即同步、最近结果与包列表 |

## 契约

```ts
interface SyncConfig { baseUrl; apiKey; deviceId; projectId; enabled }
interface DesignManifest {
  schemaVersion: 1; projectId; projectName; appVersion; createdAt; bomSha256;
  files: { path; sha256; size; kind: 'BOM'|'PDF'|'STEP'|'GLTF'|'DXF' }[];
  bom: { no; name; spec; qty; mat; remark? }[];
}
```

上传：

- `POST {baseUrl}/api/v1/design-sync/packages`
- `X-Design-Key: <apiKey>`
- `Idempotency-Key: <sha256(zip)>`
- `multipart/form-data`：`deviceId` / `manifest` / `file`
- `201` 新包；`200` 命中幂等并返回 `duplicated:true`

测试连接走现有 Bearer 接口：`GET {baseUrl}/api/v1/devices/{deviceId}/drawings`。

## ZIP 固定路径

| 路径 | kind | 来源 |
|------|------|------|
| `bom.csv` | BOM | 复用 `export/bom.ts` |
| `report.pdf` | PDF | 主进程隐藏窗口 `printToPDF` |
| `model.glb` | GLTF | 复用 `export/mesh.ts` |
| `drawing.dxf` | DXF | 复用 `export/dxf.ts` |
| `manifest.json` | — | 最后写入，含文件 SHA 与 `bomSha256` |

缺失或空文件不写入 ZIP，文件名记入 `skipped`；四个产物全缺失时拒绝打包。`manifest.bomSha256` 是 `bom.csv` 的 SHA-256。

## IPC 与 UI

| IPC | 方向 | 说明 |
|-----|------|------|
| `sync:getConfig` | 渲染 → 主 | 返回脱敏配置，绝不回传明文 key |
| `sync:saveConfig` | 渲染 → 主 | 空/掩码 key 保留原值；写 `sync.json` 并 chmod 600 |
| `sync:test` | 渲染 → 主 | Bearer 验证 baseUrl/deviceId/apiKey |
| `sync:upload` | 渲染 → 主 | 生成 PDF → 打 ZIP → 上传；返回 `packageId/version/duplicated` |
| `sync:list` / `sync:diff` | 渲染 → 主 | 最近包与版本差异 |

「立即同步」顺序：生成导出物（打包阶段）→ 测试连接（连接阶段）→ 上传（上传/解析阶段）。只有用户点击才执行，本期没有后台自动同步。失败提示带阶段与可操作原因。

## 坑点

1. **真实后端已实现 `/api/v1/design-sync/*`（0.22.0）**：单测仍只打本地 HTTP mock；真实链路验证走 `cd desktop && npm run sync:e2e`（临时 DB，不碰生产）。
2. **不能用 Bearer 上传**：设计同步是机器身份，必须 `X-Design-Key`；Bearer 只用于兼容现有设备图纸查询。
3. **幂等键取 ZIP 原始字节的 SHA-256**，不是 manifest SHA；同一文件重复上传必须命中 `200 + duplicated`。
4. **API Key 不进渲染层**：`getConfig/saveConfig` 只回掩码；UI 输入框留空或回传掩码时保留原密钥。
5. **Node API 不能进渲染层**：`adm-zip`、PDF 打印、文件读取与 `fetch` 都在主进程；渲染层只传 `Uint8Array`/HTML。
6. **超时要可注入**：生产默认 15 秒，测试用短超时，避免单测等待 15 秒。

## 进度

- ✅ 打包 / manifest / SHA-256 / 缺失文件跳过
- ✅ `testConnection / upload / list / diff / download` 与 15 秒超时中文错误（失败带 `UPLOAD_FAILED` 等阶段码）
- ✅ `sync.json` 权限 600、API Key 掩码
- ✅ IPC + preload `desktop.sync.*`
- ✅ 「智慧工厂」设置页与立即同步流程
- ✅ 单测 15 条 + smoke `SMOKE_SYNC_UI_OK` / `SMOKE_SYNC_PACKAGE_OK`
- ✅ 本地真实服务端端到端（`npm run sync:e2e`）；生产部署仍待 D2
- ⏳ 绑定机台/物料与增量文件同步（本期整包上传）
