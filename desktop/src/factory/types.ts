export type FactoryKind = 'demo' | 'opcua' | 'mqtt';
export type FactoryStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type TagDataType = 'boolean' | 'number' | 'string' | 'unknown';
export type TagQuality = 'good' | 'bad' | 'uncertain';

export interface FactoryConfig {
  kind: FactoryKind;
  label?: string;
  endpointUrl?: string;
  brokerUrl?: string;
  topicMap?: Record<string, string>;
  securityPolicy?: 'None' | 'Basic256Sha256';
  username?: string;
  password?: string;
}

export interface TagNode {
  id: string;
  name: string;
  kind?: 'station' | 'folder' | 'tag';
  dataType?: TagDataType;
  unit?: string;
  writable?: boolean;
  station?: string;
  children?: TagNode[];
}

export interface TagValue {
  id: string;
  value: unknown;
  quality: TagQuality;
  timestamp: string;
  dataType?: TagDataType;
  unit?: string;
}

export interface FactoryAdapter {
  readonly kind: FactoryKind;
  connect(config: FactoryConfig): Promise<void>;
  disconnect(): Promise<void>;
  browse(nodeId?: string): Promise<TagNode[]>;
  readTags(ids: string[]): Promise<Record<string, TagValue>>;
  writeTag(id: string, value: unknown): Promise<void>;
  subscribe(ids: string[], callback: (value: TagValue) => void): () => void;
  status(): FactoryStatus;
}

export interface FactoryStatusInfo {
  kind: FactoryKind | null;
  status: FactoryStatus;
  config?: Omit<FactoryConfig, 'password'> & { hasPassword?: boolean };
  connectedAt?: string;
  error?: string;
}

export const FACTORY_KINDS: FactoryKind[] = ['demo', 'opcua', 'mqtt'];
