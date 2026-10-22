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

interface Window {
  desktop?: {
    version(): Promise<DesktopVersion>;
    extensionBaseUrl: string | null;
    openCadDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    getPathForFile(file: File): string;
    packs: {
      list(): Promise<DesktopPackInfo[]>;
      importZip(path: string): Promise<DesktopPackInfo>;
      setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
      remove(id: string): Promise<{ ok: boolean }>;
      listParts(filter?: { q?: string; category?: string; packId?: string }): Promise<unknown[]>;
    };
    agent: { info(): Promise<unknown> };
    factory: {
      info(): Promise<unknown>;
      status(): Promise<unknown>;
      connect(config: unknown): Promise<unknown>;
      disconnect(): Promise<unknown>;
      browse(nodeId?: string): Promise<unknown>;
      readTags(ids: string[]): Promise<unknown>;
      writeTag(id: string, value: unknown): Promise<unknown>;
      subscribe(ids: string[]): Promise<unknown>;
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
  };
}

declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
