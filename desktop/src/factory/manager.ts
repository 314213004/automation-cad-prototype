import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DemoFactoryAdapter } from './demo.ts';
import { MqttFactoryAdapter } from './mqtt.ts';
import { OpcUaFactoryAdapter } from './opcua.ts';
import {
  FACTORY_KINDS,
  type FactoryAdapter,
  type FactoryConfig,
  type FactoryKind,
  type FactoryStatusInfo,
  type TagNode,
  type TagValue
} from './types.ts';

export interface FactoryManagerOptions {
  configFile: string;
  timeoutMs?: number;
  createAdapter?: (kind: FactoryKind) => FactoryAdapter;
}

export type FactoryActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseConfig(value: unknown): FactoryConfig {
  if (!isRecord(value)) throw new Error('工厂配置必须是对象');
  const kind = value.kind;
  if (typeof kind !== 'string' || !FACTORY_KINDS.includes(kind as FactoryKind)) {
    throw new Error(`不支持的适配器类型：${String(kind ?? '(空)')}`);
  }
  const config: FactoryConfig = { kind: kind as FactoryKind };
  if (typeof value.label === 'string' && value.label.trim()) config.label = value.label.trim();
  if (typeof value.endpointUrl === 'string' && value.endpointUrl.trim()) config.endpointUrl = value.endpointUrl.trim();
  if (typeof value.brokerUrl === 'string' && value.brokerUrl.trim()) config.brokerUrl = value.brokerUrl.trim();
  if (value.topicMap !== undefined) {
    if (!isRecord(value.topicMap)) throw new Error('topicMap 必须是对象');
    const topicMap: Record<string, string> = {};
    for (const [topic, tagId] of Object.entries(value.topicMap)) {
      if (typeof tagId !== 'string' || !tagId.trim()) throw new Error(`topicMap["${topic}"] 必须是非空字符串`);
      topicMap[topic] = tagId.trim();
    }
    config.topicMap = topicMap;
  }
  if (value.securityPolicy === 'None' || value.securityPolicy === 'Basic256Sha256') {
    config.securityPolicy = value.securityPolicy;
  }
  if (typeof value.username === 'string') config.username = value.username;
  if (typeof value.password === 'string') config.password = value.password;
  return config;
}

function redactConfig(config: FactoryConfig): Omit<FactoryConfig, 'password'> & { hasPassword?: boolean } {
  const { password, ...rest } = config;
  return typeof password === 'string' && password.length > 0
    ? { ...rest, hasPassword: true }
    : rest;
}

export class FactoryManager extends EventEmitter {
  private readonly configFile: string;
  private readonly timeoutMs: number;
  private readonly createAdapter: (kind: FactoryKind) => FactoryAdapter;
  private readonly adapters = new Map<FactoryKind, FactoryAdapter>();
  private active: FactoryAdapter | null = null;
  private activeConfig: FactoryConfig | null = null;
  private connectedAt: string | null = null;
  private lastError: string | null = null;
  private unsubscribeCurrent: (() => void) | null = null;

  constructor(options: FactoryManagerOptions) {
    super();
    this.configFile = options.configFile;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.createAdapter = options.createAdapter ?? ((kind) => {
      if (kind === 'demo') return new DemoFactoryAdapter();
      if (kind === 'opcua') return new OpcUaFactoryAdapter();
      return new MqttFactoryAdapter();
    });
  }

  list(): { kind: FactoryKind; label: string }[] {
    return [
      { kind: 'demo', label: '内置仿真产线' },
      { kind: 'opcua', label: 'OPC UA' },
      { kind: 'mqtt', label: 'MQTT' }
    ];
  }

  getStatus(): FactoryStatusInfo {
    const status = this.active?.status() ?? 'disconnected';
    const info: FactoryStatusInfo = {
      kind: this.active?.kind ?? (this.activeConfig?.kind ?? null),
      status
    };
    if (this.activeConfig) info.config = redactConfig(this.activeConfig);
    if (this.connectedAt) info.connectedAt = this.connectedAt;
    if (this.lastError) info.error = this.lastError;
    return info;
  }

  async connect(input: unknown): Promise<FactoryActionResult<FactoryStatusInfo>> {
    let config: FactoryConfig;
    try {
      config = parseConfig(input);
    } catch (error) {
      return { ok: false, code: 'INVALID_CONFIG', message: readableError(error) };
    }

    if (!config.endpointUrl && config.kind === 'opcua') {
      return { ok: false, code: 'INVALID_CONFIG', message: '缺少必填参数：endpointUrl' };
    }
    if (!config.brokerUrl && config.kind === 'mqtt') {
      return { ok: false, code: 'INVALID_CONFIG', message: '缺少必填参数：brokerUrl' };
    }

    this.unsubscribeCurrent?.();
    this.unsubscribeCurrent = null;
    if (this.active) {
      try {
        await withTimeout(this.active.disconnect(), this.timeoutMs, '断开旧适配器');
      } catch (error) {
        // 切换适配器时旧连接可能已经失效；新连接结果会覆盖该错误，但保留日志便于排查。
        console.warn('[factory] 断开旧适配器失败', error);
      }
      this.active = null;
    }

    const adapter = this.adapterFor(config.kind);
    this.active = adapter;
    this.activeConfig = config;
    this.connectedAt = null;
    this.lastError = null;
    this.emit('status', this.getStatus());

    try {
      await withTimeout(adapter.connect(config), this.timeoutMs, '工厂连接');
      this.connectedAt = new Date().toISOString();
      try {
        this.writeConfig(config);
      } catch (error) {
        this.lastError = `工厂已连接，但配置保存失败：${readableError(error)}`;
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

  async disconnect(): Promise<FactoryActionResult<FactoryStatusInfo>> {
    this.unsubscribeCurrent?.();
    this.unsubscribeCurrent = null;
    const adapter = this.active;
    this.active = null;
    this.connectedAt = null;
    if (!adapter) {
      this.lastError = null;
      this.emit('status', this.getStatus());
      return { ok: true, data: this.getStatus() };
    }
    try {
      await withTimeout(adapter.disconnect(), this.timeoutMs, '断开工厂');
      this.lastError = null;
      this.emit('status', this.getStatus());
      return { ok: true, data: this.getStatus() };
    } catch (error) {
      this.lastError = `断开工厂失败：${readableError(error)}`;
      this.emit('status', this.getStatus());
      return { ok: false, code: 'DISCONNECT_FAILED', message: this.lastError };
    }
  }

  /** 应用退出时释放活动适配器、订阅与事件监听；可重复调用。 */
  async dispose(): Promise<void> {
    this.unsubscribeCurrent?.();
    this.unsubscribeCurrent = null;
    try {
      await this.disconnect();
    } finally {
      for (const adapter of this.adapters.values()) {
        if (adapter.status() === 'connected') {
          try {
            await adapter.disconnect();
          } catch (error) {
            console.warn('[factory] 退出时断开适配器失败', error instanceof Error ? error.message : String(error));
          }
        }
      }
      this.adapters.clear();
      this.removeAllListeners();
    }
  }

  async browse(nodeId?: string): Promise<FactoryActionResult<TagNode[]>> {
    return await this.run('浏览点位', (adapter) => adapter.browse(nodeId));
  }

  async readTags(ids: string[]): Promise<FactoryActionResult<Record<string, TagValue>>> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是字符串数组' };
    }
    return await this.run('读取点位', (adapter) => adapter.readTags(ids));
  }

  async writeTag(id: string, value: unknown): Promise<FactoryActionResult<null>> {
    if (typeof id !== 'string' || !id) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：点位 id' };
    }
    return await this.run('写入点位', async (adapter) => {
      await adapter.writeTag(id, value);
      return null;
    });
  }

  subscribe(ids: string[], callback: (value: TagValue) => void): FactoryActionResult<string[]> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '点位 id 必须是字符串数组' };
    }
    const adapter = this.requireConnected();
    if ('ok' in adapter) return adapter;
    try {
      this.unsubscribeCurrent?.();
      this.unsubscribeCurrent = adapter.subscribe(ids, callback);
      return { ok: true, data: ids };
    } catch (error) {
      return { ok: false, code: 'SUBSCRIBE_FAILED', message: `订阅点位失败：${readableError(error)}` };
    }
  }

  getConfig(): FactoryActionResult<ReturnType<typeof redactConfig> | null> {
    try {
      const config = this.activeConfig ?? this.readConfigFile();
      return { ok: true, data: config ? redactConfig(config) : null };
    } catch (error) {
      return { ok: false, code: 'CONFIG_READ_FAILED', message: `读取工厂配置失败：${readableError(error)}` };
    }
  }

  readConfigFile(): FactoryConfig | null {
    if (!existsSync(this.configFile)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configFile, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`factory.json 解析失败：${readableError(error)}`);
    }
    return parseConfig(parsed);
  }

  private adapterFor(kind: FactoryKind): FactoryAdapter {
    const existing = this.adapters.get(kind);
    if (existing) return existing;
    const adapter = this.createAdapter(kind);
    this.adapters.set(kind, adapter);
    return adapter;
  }

  private requireConnected(): FactoryAdapter | FactoryActionResult<never> {
    if (!this.active || this.active.status() !== 'connected') {
      return { ok: false, code: 'NOT_CONNECTED', message: '工厂适配器尚未连接' };
    }
    return this.active;
  }

  private async run<T>(
    label: string,
    operation: (adapter: FactoryAdapter) => Promise<T>
  ): Promise<FactoryActionResult<T>> {
    const adapter = this.requireConnected();
    if ('ok' in adapter) return adapter;
    try {
      const data = await withTimeout(operation(adapter), this.timeoutMs, label);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, code: 'OPERATION_FAILED', message: `${label}失败：${readableError(error)}` };
    }
  }

  private writeConfig(config: FactoryConfig): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    const temp = `${this.configFile}.tmp`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.configFile);
  }
}
