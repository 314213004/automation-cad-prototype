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
}

declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
