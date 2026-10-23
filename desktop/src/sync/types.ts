export const DESIGN_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface SyncConfig {
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
}

export type DesignFileKind = 'BOM' | 'PDF' | 'STEP' | 'GLTF' | 'DXF';

export interface DesignFileEntry {
  path: string;
  sha256: string;
  size: number;
  kind: DesignFileKind;
}

export interface DesignBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
  remark?: string;
}

export interface DesignManifest {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt: string;
  bomSha256: string;
  files: DesignFileEntry[];
  bom: DesignBomRow[];
}

/** 渲染层交给主进程的导出物；主进程负责打 zip 并上传。 */
export interface SyncUploadPayload {
  projectName: string;
  bomCsv: string | Uint8Array;
  reportHtml: string;
  glb: Uint8Array;
  dxf: string | Uint8Array;
  bom: DesignBomRow[];
}

export type SyncStage = '打包' | '连接' | '上传' | '解析' | '列表' | '比对' | '下载';

export interface SyncResult {
  ok: boolean;
  packageId?: string;
  version?: number;
  duplicated?: boolean;
  message?: string;
  stage?: SyncStage;
  /** 阶段错误码，例如 UPLOAD_FAILED；成功时不返回。 */
  code?: string;
}

export interface SyncPackageSummary {
  packageId: string;
  projectId: string;
  version: number;
  bomSha256: string;
  createdAt: string;
  uploadedBy?: string;
}

export interface DesignDiff {
  base: { packageId: string; version: number };
  bomAdded: DesignBomRow[];
  bomRemoved: DesignBomRow[];
  bomChanged: Array<{ no: number | string; field: string; from: unknown; to: unknown }>;
  filesAdded: string[];
  filesChanged: string[];
  filesRemoved: string[];
}

export type SyncListResult =
  | { ok: true; items: SyncPackageSummary[] }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

export type SyncDiffResult =
  | { ok: true; diff: DesignDiff }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

export type SyncDownloadResult =
  | { ok: true; zip: Uint8Array; bytes: number; sha256: string; etag?: string }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

/** 给 UI 的配置视图，绝不包含明文 apiKey。 */
export interface SyncPublicConfig {
  baseUrl: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
}
