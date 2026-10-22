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
  symbol?: string;
  dims?: { w: number; h: number; d: number };
  railMount?: boolean;
  moduleWidth?: number;
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

interface DesktopAgentToolInfo {
  name: string;
  description: string;
}

interface DesktopAgentHistoryEntry {
  name: string;
  at: string;
  ok: boolean;
}

interface DesktopAgentInfo {
  host?: string;
  port?: number;
  url?: string;
  tokenFile?: string;
  toolCount?: number;
  tools?: DesktopAgentToolInfo[];
  history?: DesktopAgentHistoryEntry[];
  error?: string;
}

interface DesktopAgentLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  hasApiKey: boolean;
}

interface DesktopAgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DesktopAgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: DesktopAgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface DesktopAgentChatResult {
  ok: boolean;
  reply?: string;
  message?: string;
  messages: DesktopAgentChatMessage[];
}

interface DesktopAgentLlmTestResult {
  ok: boolean;
  message: string;
  model?: string;
}

interface AgentBridgeFailure {
  ok: false;
  message: string;
}

interface AgentBridgeScenePart {
  name: string;
  triangles: number;
  bbox: { min: number[]; max: number[] };
}

interface AgentBridgeBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
}

interface AgentBridgeApi {
  ready(): boolean;
  getScene(): { parts: AgentBridgeScenePart[]; source: string | null } | AgentBridgeFailure;
  getSelection(): { name: string; bbox: number[] } | AgentBridgeFailure | null;
  getBom(): AgentBridgeBomRow[] | AgentBridgeFailure;
  insertComponent(part: { id: string; model: string; vendor?: string; category: string }): { ok: boolean; meshIndex?: number; name?: string; message?: string };
  removeComponent(meshIndex: number): { ok: boolean; message?: string };
  runInterference(): { hits: number; items: { a: string; b: string; volume: number; severity: string }[] } | AgentBridgeFailure;
  importPath(path: string): Promise<{ ok: boolean; meshCount?: number; triangleCount?: number; message?: string }>;
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
    agent: {
      info(): Promise<DesktopAgentInfo>;
      getLlmConfig(): Promise<DesktopAgentLlmConfig>;
      saveLlmConfig(config: Record<string, unknown>): Promise<DesktopAgentLlmConfig>;
      testLlm(config?: Record<string, unknown>): Promise<DesktopAgentLlmTestResult>;
      chat: {
        send(text: string): Promise<DesktopAgentChatResult>;
        history(): Promise<{ ok: boolean; messages: DesktopAgentChatMessage[] }>;
        clear(): Promise<{ ok: boolean; messages: DesktopAgentChatMessage[] }>;
      };
    };
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
  __AgentBridge?: AgentBridgeApi;
  __Commission3D?: {
    stats(): {
      frames: number;
      ticks: number;
      parts: number;
      stations: number;
      sensors: number;
      actuators: number;
      webgl: boolean;
      enabled: boolean;
      active: boolean;
    };
    update(values: Record<string, boolean | number>): void;
    highlight(pointId: string, on: boolean): void;
    kinematicsMode(): {
      mode: 'annotation' | 'config';
      reason: string;
      parts: number;
      sourceFile: string;
    };
    lastDiagnosis(): {
      code: string;
      title: string;
      severity: 'error' | 'warning';
      evidence: string[];
      actions: string[];
      confidence: number;
    }[];
  };
  ElecDomain?: {
    setDomain(domain: 'mech' | 'elec'): void;
    insertSymbol(key: string, opts?: { x?: number; y?: number }): { ok: boolean; tag?: string; id?: string; message?: string };
  };
  __Enclosure?: {
    add(partId: string, x?: number, y?: number): Promise<{
      id: string;
      partId: string;
      model: string;
      x: number;
      y: number;
      w: number;
      h: number;
      railId?: string;
    } | null>;
    state(): {
      placed: number;
      overlap: number;
      collisions: number;
      ratio: number;
      usedMm2: number;
      plate: { width: number; height: number; rails: { id: string; y: number; height: number; label: string }[] };
      placements: { id: string; partId: string; model: string; x: number; y: number; w: number; h: number; railId?: string }[];
    } | null;
    open(): void;
    close(): void;
    clear(): void;
  };
  __AUTOMATION_CAD_EXTENSION_READY__?: boolean;
  /** 电气校验数据源：由原理图侧注入，返回 null 表示暂无数据。 */
  __ElecDocProvider?: () => import('./elec/check').ElecDocument | null;
  /** 电气校验面板：脚本化运行与 PDF 导出（冒烟与 Agent 共用）。 */
  __ElecCheckPanel?: {
    open(): void;
    close(): void;
    run(doc: import('./elec/check').ElecDocument): Promise<import('./elec/check').ElecCheckResult | null>;
    result(): import('./elec/check').ElecCheckResult | null;
    html(): string;
    exportPdf(): Promise<{ path: string; htmlPath: string }>;
    status(): string;
  };
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
  AutomationCadKinematics?: {
    open(): void;
    close(): void;
    state(): {
      sourceFile: string;
      meshes: { id: number; name: string; triangles: number; center: [number, number, number]; size: [number, number, number] }[];
      parts: {
        id: string;
        name: string;
        meshIds: number[];
        meshNames: string[];
        center: [number, number, number];
        size: [number, number, number];
        kind: 'linear' | 'rotary';
        axis: 'x' | 'y' | 'z';
        direction: 1 | -1;
        travelMm: number;
        retractedMm: number;
        rangeDeg: number;
        retractedDeg: number;
        point: string;
        role: 'extend' | 'retract' | 'rotate' | '';
      }[];
      errors: number;
      warnings: number;
      ok: boolean;
    };
    addMovingPart(meshIds: readonly number[], name?: string): string;
    updatePart(id: string, patch: Record<string, unknown>): void;
    slide(id: string, percent: number): { percent: number; amount: number; unit: 'mm' | 'deg'; offset: [number, number, number]; rotationRad: number; source: string } | null;
    save(): boolean;
    getAnnotation(): {
      version: 1;
      sourceFile: string;
      parts: unknown[];
    };
    getValidation(): { ok: boolean; errors: unknown[]; warnings: unknown[] };
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
