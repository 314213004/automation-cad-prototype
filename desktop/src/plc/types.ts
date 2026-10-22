export type PlcKind = 'sim' | 'modbus';
export type PlcStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type PlcArea = 'coil' | 'discrete' | 'holding' | 'input';
export type PlcDataType = 'bool' | 'int16' | 'uint16';
export type PlcValue = boolean | number;

export interface PlcPoint {
  id: string;
  name: string;
  area: PlcArea;
  address: number;
  dataType: PlcDataType;
  writable?: boolean;
  unit?: string;
}

export type SimRule =
  | { target: string; type?: 'expr'; expr: string }
  | { target: string; type: 'latch'; set: string; reset: string }
  | { target: string; type: 'timer'; when: string; delayMs: number };

export interface PlcConfig {
  kind: PlcKind;
  host?: string;
  port?: number;
  unitId?: number;
  points: PlcPoint[];
  pollMs?: number;
  /** 仅内置仿真使用：简易梯形逻辑规则。 */
  rules?: SimRule[];
  /** 仅内置仿真使用：连接时的初始点位值。 */
  initialValues?: Record<string, PlcValue>;
}

export interface PlcAdapter {
  readonly kind: PlcKind;
  connect(cfg: PlcConfig): Promise<void>;
  disconnect(): Promise<void>;
  read(id: string): Promise<PlcValue>;
  write(id: string, value: PlcValue): Promise<void>;
  readAll(): Promise<Record<string, PlcValue>>;
  subscribe(cb: (values: Record<string, PlcValue>) => void): () => void;
  onError?(cb: (message: string) => void): () => void;
  status(): PlcStatus;
}

export interface PlcStatusInfo {
  kind: PlcKind | null;
  status: PlcStatus;
  config?: PlcConfig;
  connectedAt?: string;
  error?: string;
}

export const PLC_KINDS: readonly PlcKind[] = ['sim', 'modbus'];
export const PLC_AREAS: readonly PlcArea[] = ['coil', 'discrete', 'holding', 'input'];
export const PLC_DATA_TYPES: readonly PlcDataType[] = ['bool', 'int16', 'uint16'];

export const PLC_LABELS: Record<PlcKind, string> = {
  sim: '内置 PLC 仿真器',
  modbus: 'Modbus TCP'
};
