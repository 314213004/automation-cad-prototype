interface DesktopVersion {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

interface DesktopPackInfo {
  id: string;
  name: string;
  vendor: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  partCount: number;
  error?: string;
}

interface DesktopComponentPart {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  specs: Record<string, string | number>;
  asset?: string;
  thumbnail?: string;
  price?: number;
  packId?: string;
  packName?: string;
}

interface DesktopFactoryResult<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

interface DesktopFactoryStatusInfo {
  kind: 'demo' | 'opcua' | 'mqtt' | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  config?: Record<string, unknown>;
  connectedAt?: string;
  error?: string;
}

interface DesktopTagNode {
  id: string;
  name: string;
  kind?: 'station' | 'folder' | 'tag';
  dataType?: 'boolean' | 'number' | 'string' | 'unknown';
  unit?: string;
  writable?: boolean;
  station?: string;
  children?: DesktopTagNode[];
}

interface DesktopTagValue {
  id: string;
  value: unknown;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: string;
  dataType?: 'boolean' | 'number' | 'string' | 'unknown';
  unit?: string;
}

type DesktopPlcKind = 'sim' | 'modbus';
type DesktopPlcStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type DesktopPlcValue = boolean | number;

interface DesktopPlcPoint {
  id: string;
  name: string;
  area: 'coil' | 'discrete' | 'holding' | 'input';
  address: number;
  dataType: 'bool' | 'int16' | 'uint16';
  writable?: boolean;
  unit?: string;
}

interface DesktopPlcConfig {
  kind: DesktopPlcKind;
  host?: string;
  port?: number;
  unitId?: number;
  points: DesktopPlcPoint[];
  pollMs?: number;
  rules?: Array<Record<string, unknown>>;
  initialValues?: Record<string, DesktopPlcValue>;
}

interface DesktopPlcStatusInfo {
  kind: DesktopPlcKind | null;
  status: DesktopPlcStatus;
  config?: DesktopPlcConfig;
  connectedAt?: string;
  error?: string;
}

interface DesktopSyncPublicConfig {
  baseUrl: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

interface DesktopSyncResult {
  ok: boolean;
  packageId?: string;
  version?: number;
  duplicated?: boolean;
  message?: string;
  stage?: '打包' | '连接' | '上传' | '解析';
}

interface DesktopSyncPackageSummary {
  packageId: string;
  projectId: string;
  version: number;
  bomSha256: string;
  createdAt: string;
  uploadedBy?: string;
}

interface DesktopSyncListResult {
  ok: boolean;
  items?: DesktopSyncPackageSummary[];
  message?: string;
}

interface DesktopSyncDiffResult {
  ok: boolean;
  diff?: {
    base: { packageId: string; version: number };
    bomAdded: unknown[];
    bomRemoved: unknown[];
    bomChanged: unknown[];
    filesAdded: string[];
    filesChanged: string[];
    filesRemoved: string[];
  };
  message?: string;
}

interface DesktopSyncUploadPayload {
  projectName: string;
  bomCsv: string | Uint8Array;
  reportHtml: string;
  glb: Uint8Array;
  dxf: string | Uint8Array;
  bom: Array<{ no: number; name: string; spec: string; qty: number; mat: string; remark?: string }>;
}

interface Window {
  desktop?: {
    version(): Promise<DesktopVersion>;
    extensionBaseUrl: string | null;
    openCadDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    getPathForFile(file: File): string;
    exportFile(name: string, data: Uint8Array | string): Promise<{ canceled: boolean; path: string | null }>;
    exportReport(payload: { html: string; projectName?: string }): Promise<{ path: string; htmlPath: string }>;
    packs: {
      list(): Promise<DesktopPackInfo[]>;
      chooseZip(): Promise<{ canceled: boolean; filePaths: string[] }>;
      importZip(path: string): Promise<DesktopPackInfo>;
      setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
      remove(id: string): Promise<{ ok: boolean }>;
      listParts(filter?: { q?: string; category?: string; packId?: string }): Promise<DesktopComponentPart[]>;
    };
    agent: { info(): Promise<unknown> };
    factory: {
      info(): Promise<unknown>;
      status(): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      list(): Promise<DesktopFactoryResult<{ kind: string; label: string }[]>>;
      getConfig(): Promise<DesktopFactoryResult<Record<string, unknown> | null>>;
      connect(config: unknown): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      disconnect(): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      browse(nodeId?: string): Promise<DesktopFactoryResult<DesktopTagNode[]>>;
      readTags(ids: string[]): Promise<DesktopFactoryResult<Record<string, DesktopTagValue>>>;
      writeTag(id: string, value: unknown): Promise<DesktopFactoryResult<null>>;
      subscribe(ids: string[]): Promise<DesktopFactoryResult<string[]>>;
      onValues(callback: (value: DesktopTagValue) => void): () => void;
      onStatus(callback: (status: DesktopFactoryStatusInfo) => void): () => void;
    };
    plc: {
      info(): Promise<unknown>;
      status(): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      list(): Promise<DesktopFactoryResult<{ kind: DesktopPlcKind; label: string }[]>>;
      getConfig(): Promise<DesktopFactoryResult<DesktopPlcConfig | null>>;
      connect(config: DesktopPlcConfig): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      disconnect(): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      read(id: string): Promise<DesktopFactoryResult<DesktopPlcValue>>;
      readAll(): Promise<DesktopFactoryResult<Record<string, DesktopPlcValue>>>;
      write(id: string, value: DesktopPlcValue): Promise<DesktopFactoryResult<null>>;
      force(id: string, value: DesktopPlcValue): Promise<DesktopFactoryResult<null>>;
      onValues(callback: (values: Record<string, DesktopPlcValue>) => void): () => void;
      onStatus(callback: (status: DesktopPlcStatusInfo) => void): () => void;
    };
    sync: {
      getConfig(): Promise<DesktopSyncPublicConfig>;
      saveConfig(config: Record<string, unknown>): Promise<DesktopSyncPublicConfig>;
      test(): Promise<DesktopSyncResult>;
      upload(payload: DesktopSyncUploadPayload): Promise<DesktopSyncResult>;
      list(): Promise<DesktopSyncListResult>;
      diff(packageId: string): Promise<DesktopSyncDiffResult>;
    };
    onOpenCad(callback: (payload: { path: string; source: string }) => void): () => void;
    onImportPack(callback: (payload: { path: string }) => void): () => void;
    onSetDomain(callback: (domain: 'mech' | 'elec') => void): () => void;
  };
  ElecDomain?: {
    setDomain(domain: 'mech' | 'elec'): void;
  };
  __AUTOMATION_CAD_EXTENSION_READY__?: boolean;
  AutomationCadViewer?: {
    open(): void;
    close(): void;
    importPath(path: string): Promise<void>;
    inspectPath(path: string): Promise<{ meshCount: number; triangleCount: number; elapsedMs: number; format: string }>;
    runInterference(parts?: { name: string; bbox: { min: [number, number, number]; max: [number, number, number] } }[]): { a: string; b: string; overlap: [number, number, number]; volumeApprox: number; center: [number, number, number]; severity: 'error' | 'warning' }[];
    exportMesh(format: 'glb' | 'obj'): Promise<{ format: string; size: number }>;
    exportData(format: 'csv' | 'xlsx' | 'dxf' | 'glb' | 'obj' | 'pdf'): Promise<{ format: string; size: number }>;
    exportReportPdf(): Promise<{ path: string; htmlPath: string }>;
  };
  AutomationCadCommission?: {
    open(): void;
    getReport(): {
      plcKind: DesktopPlcKind | null;
      plcStatus: DesktopPlcStatus;
      startedAt: string;
      completedAt: string;
      powerUp: { pass: boolean; results: unknown[] };
      cases: unknown[];
      points: unknown[];
    };
    runPowerUp(): Promise<boolean>;
    runCase(id: string): Promise<boolean>;
    runAllCases(): Promise<boolean>;
  };
}

declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
