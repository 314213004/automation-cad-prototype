import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parsePlcConfig, publicPlcConfig } from './config.ts';
import { ModbusPlcAdapter } from './modbus.ts';
import { SimPlcAdapter } from './sim.ts';
import {
  PLC_KINDS,
  PLC_LABELS,
  type PlcAdapter,
  type PlcConfig,
  type PlcKind,
  type PlcStatusInfo,
  type PlcValue
} from './types.ts';

export interface PlcManagerOptions {
  configFile: string;
  timeoutMs?: number;
  createAdapter?: (kind: PlcKind) => PlcAdapter;
}

export type PlcActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isPlcValue(value: unknown): value is PlcValue {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

export class PlcManager extends EventEmitter {
  private readonly configFile: string;
  private readonly timeoutMs: number;
  private readonly createAdapter: (kind: PlcKind) => PlcAdapter;
  private readonly adapters = new Map<PlcKind, PlcAdapter>();
  private active: PlcAdapter | null = null;
  private activeConfig: PlcConfig | null = null;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private unsubscribeValues: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;
  private readonly valueListeners = new Set<(values: Record<string, PlcValue>) => void>();

  constructor(options: PlcManagerOptions) {
    super();
    this.configFile = options.configFile;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.createAdapter = options.createAdapter ?? ((kind) => (
      kind === 'sim' ? new SimPlcAdapter() : new ModbusPlcAdapter()
    ));
  }

  list(): { kind: PlcKind; label: string }[] {
    return PLC_KINDS.map((kind) => ({ kind, label: PLC_LABELS[kind] }));
  }

  getStatus(): PlcStatusInfo {
    const info: PlcStatusInfo = {
      kind: this.active?.kind ?? (this.activeConfig?.kind ?? null),
      status: this.active?.status() ?? (this.lastError ? 'error' : 'disconnected')
    };
    if (this.activeConfig) info.config = publicPlcConfig(this.activeConfig);
    if (this.connectedAt) info.connectedAt = this.connectedAt;
    if (this.lastError) info.error = this.lastError;
    return info;
  }

  async connect(rawConfig: unknown): Promise<PlcActionResult<PlcStatusInfo>> {
    let config: PlcConfig;
    try {
      config = parsePlcConfig(rawConfig);
    } catch (error) {
      this.lastError = readableError(error);
      this.emit('status', this.getStatus());
      return { ok: false, code: 'INVALID_CONFIG', message: this.lastError };
    }
    this.lastError = null;
    this.connectedAt = null;
    if (this.active) {
      this.stopSubscriptions();
      try {
        await withTimeout(this.active.disconnect(), this.timeoutMs, '断开 PLC');
      } catch (error) {
        this.lastError = `切换适配器时断开旧连接失败：${readableError(error)}`;
        this.emit('status', this.getStatus());
        return { ok: false, code: 'DISCONNECT_FAILED', message: this.lastError };
      }
      this.active = null;
    }
    this.activeConfig = config;
    const adapter = this.adapterFor(config.kind);
    this.active = adapter;
    this.emit('status', this.getStatus());
    try {
      await withTimeout(adapter.connect(config), this.timeoutMs, 'PLC 连接');
      this.connectedAt = new Date().toISOString();
      this.lastError = null;
      this.unsubscribeValues = adapter.subscribe((values) => {
        this.emit('values', values);
        for (const listener of this.valueListeners) listener(values);
      });
      if (adapter.onError) {
        this.unsubscribeError = adapter.onError((message) => {
          this.lastError = message;
          this.emit('status', this.getStatus());
        });
      }
      try {
        this.writeConfig(config);
      } catch (error) {
        this.lastError = `PLC 已连接，但配置保存失败：${readableError(error)}`;
        this.emit('status', this.getStatus());
        return { ok: false, code: 'CONFIG_SAVE_FAILED', message: this.lastError };
      }
      this.emit('status', this.getStatus());
      return { ok: true, data: this.getStatus() };
    } catch (error) {
      this.lastError = readableError(error);
      this.connectedAt = null;
      this.emit('status', this.getStatus());
      return { ok: false, code: 'CONNECT_FAILED', message: this.lastError };
    }
  }

  async disconnect(): Promise<PlcActionResult<PlcStatusInfo>> {
    this.stopSubscriptions();
    const adapter = this.active;
    this.active = null;
    this.connectedAt = null;
    if (!adapter) {
      this.lastError = null;
      this.emit('status', this.getStatus());
      return { ok: true, data: this.getStatus() };
    }
    try {
      await withTimeout(adapter.disconnect(), this.timeoutMs, '断开 PLC');
      this.lastError = null;
      this.emit('status', this.getStatus());
      return { ok: true, data: this.getStatus() };
    } catch (error) {
      this.lastError = `断开 PLC 失败：${readableError(error)}`;
      this.emit('status', this.getStatus());
      return { ok: false, code: 'DISCONNECT_FAILED', message: this.lastError };
    }
  }

  async read(id: string): Promise<PlcActionResult<PlcValue>> {
    if (typeof id !== 'string' || !id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    return await this.run('读取点位', (adapter) => adapter.read(id));
  }

  async readAll(): Promise<PlcActionResult<Record<string, PlcValue>>> {
    return await this.run('读取全部点位', (adapter) => adapter.readAll());
  }

  async write(id: string, value: PlcValue): Promise<PlcActionResult<null>> {
    if (typeof id !== 'string' || !id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (!isPlcValue(value)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    return await this.run('写入点位', async (adapter) => {
      await adapter.write(id, value);
      return null;
    });
  }

  /** 仿真适配器保持强制值；Modbus 适配器等价于普通写入。 */
  async force(id: string, value: PlcValue): Promise<PlcActionResult<null>> {
    if (typeof id !== 'string' || !id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少点位 id' };
    if (!isPlcValue(value)) return { ok: false, code: 'INVALID_ARGUMENT', message: '点位值必须是布尔值或数字' };
    return await this.run('强制写入点位', async (adapter) => {
      if (adapter instanceof SimPlcAdapter) await adapter.force(id, value);
      else await adapter.write(id, value);
      return null;
    });
  }

  subscribe(callback: (values: Record<string, PlcValue>) => void): PlcActionResult<true> {
    if (typeof callback !== 'function') return { ok: false, code: 'INVALID_ARGUMENT', message: '订阅回调必须是函数' };
    const adapter = this.requireConnected();
    if ('ok' in adapter) return adapter;
    this.valueListeners.add(callback);
    return { ok: true, data: true };
  }

  getConfig(): PlcActionResult<PlcConfig | null> {
    try {
      const config = this.activeConfig ?? this.readConfigFile();
      return { ok: true, data: config ? publicPlcConfig(config) : null };
    } catch (error) {
      return { ok: false, code: 'CONFIG_READ_FAILED', message: `读取 PLC 配置失败：${readableError(error)}` };
    }
  }

  readConfigFile(): PlcConfig | null {
    if (!existsSync(this.configFile)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`plc.json 解析失败：${readableError(error)}`);
    }
    return parsePlcConfig(parsed);
  }

  private adapterFor(kind: PlcKind): PlcAdapter {
    const existing = this.adapters.get(kind);
    if (existing) return existing;
    const adapter = this.createAdapter(kind);
    this.adapters.set(kind, adapter);
    return adapter;
  }

  private requireConnected(): PlcAdapter | PlcActionResult<never> {
    if (!this.active || this.active.status() !== 'connected') {
      return { ok: false, code: 'NOT_CONNECTED', message: 'PLC 尚未连接' };
    }
    return this.active;
  }

  private async run<T>(
    label: string,
    operation: (adapter: PlcAdapter) => Promise<T>
  ): Promise<PlcActionResult<T>> {
    const adapter = this.requireConnected();
    if ('ok' in adapter) return adapter;
    try {
      return { ok: true, data: await withTimeout(operation(adapter), this.timeoutMs, label) };
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: `${label}失败：${readableError(error)}` };
    }
  }

  private stopSubscriptions(): void {
    this.unsubscribeValues?.();
    this.unsubscribeValues = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.valueListeners.clear();
  }

  private writeConfig(config: PlcConfig): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    const temp = `${this.configFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.configFile);
  }
}
