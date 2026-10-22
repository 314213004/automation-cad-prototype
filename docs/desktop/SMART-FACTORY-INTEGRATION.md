# 智慧工厂对接：现状、缺口与改动清单

对象项目：`owlco001/material-flow-system`（GitHub / Gitee 同名，生产 `http://221.231.106.194:5556`，本机演示 `:8000`）。
本文是给**智慧工厂侧**的改动说明（需求 #6），客户端实现见 `src/sync/`。

## 一、现状（已实现，可直接用）

鉴权：`Authorization: Bearer <token>`（`current_user` 依赖），管理台另有 Cookie + CSRF，**不适合桌面客户端**。

| 能力 | 端点 | 说明 |
|------|------|------|
| 机台图纸列表 | `GET /api/v1/devices/{device_id}/drawings` | 返回 `{deviceId, deviceNo, drawings[]}` |
| 物料图纸列表 | `GET /api/v1/materials/{code}/drawings` | 返回 `{materialCode, drawings[]}` |
| 图纸详情 | `GET /api/v1/drawings/{id}` | `_drawing_payload`，含页数、状态 |
| 图纸页 PDF | `GET /api/v1/drawings/{id}/pages/{n}` | `application/pdf`，长缓存 |
| 缩略图 | `GET /api/v1/drawings/{id}/pages/{n}/thumb` | `image/webp` |
| BOM 导入 | `POST /admin/agent/import/bom/{preview,commit}` | 管理台会话，Agent 导入 |
| 模型上传 | `POST /admin/models/upload` | 表单 + CSRF，管理台使用 |

结论：**读**已具备；**写**（设计包上传、版本比对、绑定）目前只有管理台表单，桌面端无法安全调用。

## 二、建议新增：设计同步 API（`/api/v1/design-sync`）

### 鉴权
- 新增 `X-Design-Key: <key>`，key 在管理台「设备接入」页生成，**只存哈希**（bcrypt/argon2），可吊销、可限定 `deviceId` 范围
- 与用户 Bearer 分离：设计同步是机器身份，不做用户会话
- 传输要求 HTTPS（生产已有 cloudflared/反代）

### 1) 上传设计包
```
POST /api/v1/design-sync/packages
Content-Type: multipart/form-data
X-Design-Key: ...
Idempotency-Key: <sha256 of zip>      # 相同指纹直接返回已有包，不重复入库

fields:
  deviceId      string  必填（机台编号）
  manifest      string  JSON 字符串（见下）
  file          binary  zip，≤200MB
```
manifest：
```json
{
  "schemaVersion": 1,
  "projectId": "asm-slide-cyl",
  "projectName": "滑台气缸装配体",
  "appVersion": "0.2.0",
  "createdAt": "2026-10-22T14:00:00Z",
  "bomSha256": "…",
  "files": [{ "path": "bom.csv", "sha256": "…", "size": 1234, "kind": "BOM|PDF|STEP|GLTF|DXF" }],
  "bom": [{ "no": 1, "name": "底板", "spec": "BASE-01", "qty": 1, "mat": "AL6061" }]
}
```
返回 `201 {"packageId","version","uploadedAt","duplicated":false}`；指纹重复返回 `200 {..., "duplicated": true}`。

### 2) 列表与版本
```
GET /api/v1/design-sync/packages?deviceId=&projectId=&limit=20
→ { items:[{packageId, projectId, version, bomSha256, createdAt, uploadedBy}] }
```

### 3) 版本比对
```
GET /api/v1/design-sync/packages/{id}/diff?against=latest
→ { base:{packageId,version}, bomAdded:[], bomRemoved:[], bomChanged:[{no,field,from,to}],
    filesAdded:[], filesChanged:[], filesRemoved:[] }
```

### 4) 绑定机台/物料
```
POST /api/v1/design-sync/bind
{ "packageId":"…", "targetType":"DEVICE|MATERIAL", "targetKey":"DEV-001" }
→ { "bound": true }
```
绑定后，现有 `/api/v1/devices/{id}/drawings` 应能返回该包内的 PDF（复用 `drawing_bindings` 或新增映射）。

### 5) 拉取（可选，用于双向）
```
GET /api/v1/design-sync/packages/{id}/download → zip 流
```

## 三、服务端改动清单

1. **新增路由文件** `app/design_sync.py`，在 `main.py` 注册；不改现有 `/api/v1/*` 行为。
2. **新增表**（SQLite，迁移脚本 `migrate.py` 增段）：
   ```sql
   CREATE TABLE design_keys (
     id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, label TEXT,
     device_scope TEXT, created_at TEXT, revoked_at TEXT
   );
   CREATE TABLE design_packages (
     id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT,
     device_id TEXT, version INTEGER, manifest_json TEXT,
     bom_sha256 TEXT, zip_sha256 TEXT UNIQUE, uploaded_at TEXT
   );
   CREATE TABLE design_package_files (
     package_id TEXT, path TEXT, kind TEXT, sha256 TEXT, size INTEGER,
     PRIMARY KEY (package_id, path)
   );
   ```
3. **存储**：`data/design_packages/<packageId>/` 解压后按 manifest 校验路径（拒绝 `../`），zip 原文保留用于下载。
4. **幂等**：`zip_sha256` 唯一索引 + `Idempotency-Key` 双保险。
5. **限制**：单包 ≤200MB，manifest ≤1MB，文件数 ≤500；解压前校验 zip 条目路径与总解压体积（防 zip bomb）。
6. **审计**：写入 `audit_log`（谁、何时、哪个 device、包指纹），与现有管理台审计同表。
7. **管理台**：新增「设计包」页（列表、下载、吊销 key、生成 key），复用现有 admin 布局与 CSRF。
8. **打通图纸**：绑定后把包内 PDF 注册进 `drawings`/`drawing_bindings`，让现有 APP 端图纸接口自动可见。

## 四、兼容与回滚

- 新表与新路由独立，旧接口零改动；回滚只需下线 `design_sync` 路由。
- 若暂不想加表，可先用「BOM 导入 + 模型上传」现有管理台接口，但桌面端需模拟 CSRF 会话，**不建议**。

## 五、验收清单（服务端）

- [ ] 用错误 key 上传 → 401；吊销后 → 401
- [ ] 同一 zip 上传两次 → 第二次 `duplicated:true`，库中只有一条
- [ ] manifest 含 `../evil` → 400，且磁盘无写入
- [ ] 200MB+ 包 → 413；解压总量超限 → 400
- [ ] 绑定 DEVICE 后，`/api/v1/devices/{id}/drawings` 能查到新 PDF
- [ ] diff 对 BOM 增/删/改各返回一条正确记录
