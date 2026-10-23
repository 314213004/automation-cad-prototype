import type {
  FactoryAdapter,
  FactoryConfig,
  FactoryStatus,
  TagDataType,
  TagNode,
  TagValue
} from './types';

type MqttClient = import('mqtt').MqttClient;

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function parsePayload(payload: Uint8Array): unknown {
  const text = Buffer.from(payload).toString('utf8').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'value' in parsed) {
      return (parsed as { value: unknown }).value;
    }
    return parsed;
  } catch {
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
}

function valueType(value: unknown): TagDataType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

function normalizeTopicMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MQTT 连接失败：topicMap 必须是从 topic 到点位 id 的对象');
  }
  const result: Record<string, string> = {};
  for (const [topic, tagId] of Object.entries(value)) {
    if (typeof tagId !== 'string' || !tagId.trim()) {
      throw new Error(`MQTT 连接失败：topicMap["${topic}"] 必须是非空字符串`);
    }
    result[topic] = tagId.trim();
  }
  if (Object.keys(result).length === 0) throw new Error('MQTT 连接失败：topicMap 不能为空');
  return result;
}

export class MqttFactoryAdapter implements FactoryAdapter {
  readonly kind = 'mqtt' as const;
  private state: FactoryStatus = 'disconnected';
  private client: MqttClient | null = null;
  private topicMap: Record<string, string> = {};
  private readonly latest = new Map<string, TagValue>();
  private readonly listeners = new Map<string, Set<(value: TagValue) => void>>();
  private errorText: string | null = null;

  async connect(config: FactoryConfig): Promise<void> {
    if (config.kind !== 'mqtt') throw new Error(`MQTT 适配器不接受 ${config.kind} 配置`);
    const brokerUrl = config.brokerUrl?.trim();
    if (!brokerUrl) throw new Error('缺少必填参数：brokerUrl');
    if (!/^(mqtt|mqtts|ws|wss):\/\//i.test(brokerUrl)) {
      throw new Error('MQTT 连接失败：brokerUrl 必须以 mqtt://、mqtts://、ws:// 或 wss:// 开头');
    }
    const topicMap = normalizeTopicMap(config.topicMap);
    this.state = 'connecting';
    this.topicMap = topicMap;
    this.errorText = null;

    let mqttModule: typeof import('mqtt');
    try {
      mqttModule = await import('mqtt');
    } catch (error) {
      this.state = 'error';
      throw new Error(`MQTT 连接失败：无法加载 mqtt.js（${readableError(error)}）`);
    }

    await new Promise<void>((resolve, reject) => {
      const client = mqttModule.connect(brokerUrl, {
        connectTimeout: 10000,
        reconnectPeriod: 2000,
        clientId: `automationcad-${Math.random().toString(16).slice(2, 10)}`,
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {})
      });
      this.client = client;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('MQTT 连接失败：连接超时（10 秒）'));
      }, 10000);

      client.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = 'connected';
        this.errorText = null;
        resolve();
      });
      client.on('connect', () => {
        this.state = 'connected';
        this.errorText = null;
      });
      client.once('error', (error) => {
        if (settled) {
          this.errorText = `MQTT 连接异常：${readableError(error)}`;
          this.state = 'error';
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(new Error(`MQTT 连接失败：${readableError(error)}`));
      });
      client.on('message', (topic, payload) => {
        const tagId = this.topicMap[topic];
        if (!tagId) return;
        const value = parsePayload(payload);
        const tagValue: TagValue = {
          id: tagId,
          value,
          quality: 'good',
          timestamp: new Date().toISOString(),
          dataType: valueType(value)
        };
        this.latest.set(tagId, tagValue);
        const callbacks = this.listeners.get(tagId);
        if (callbacks) for (const callback of callbacks) callback(tagValue);
      });
      client.on('close', () => {
        if (this.state === 'connected') {
          this.state = 'error';
          this.errorText = 'MQTT 连接已断开，等待自动重连';
        }
      });
    }).catch(async (error: unknown) => {
      await this.disconnectClient();
      this.state = 'error';
      this.errorText = readableError(error);
      throw new Error(this.errorText);
    });

    await new Promise<void>((resolve, reject) => {
      this.client?.subscribe(Object.keys(this.topicMap), { qos: 0 }, (error) => {
        if (error) reject(new Error(`MQTT 订阅失败：${readableError(error)}`));
        else resolve();
      });
      if (!this.client) reject(new Error('MQTT 连接失败：客户端未创建'));
    }).catch(async (error: unknown) => {
      await this.disconnectClient();
      this.state = 'error';
      this.errorText = readableError(error);
      throw new Error(this.errorText);
    });

    this.state = 'connected';
  }

  async disconnect(): Promise<void> {
    this.listeners.clear();
    await this.disconnectClient();
    this.state = 'disconnected';
    this.errorText = null;
  }

  async browse(nodeId?: string): Promise<TagNode[]> {
    this.assertConnected();
    const nodes = Object.entries(this.topicMap).map(([topic, id]) => ({
      id,
      name: id,
      kind: 'tag' as const,
      dataType: this.latest.get(id)?.dataType ?? 'unknown',
      writable: true,
      station: topic
    }));
    if (!nodeId) return nodes;
    return nodes.filter((node) => node.id === nodeId || node.station === nodeId);
  }

  async readTags(ids: string[]): Promise<Record<string, TagValue>> {
    this.assertConnected();
    const result: Record<string, TagValue> = {};
    for (const id of ids) {
      if (!Object.values(this.topicMap).includes(id)) throw new Error(`点位不存在：${id}`);
      const current = this.latest.get(id);
      result[id] = current ?? {
        id,
        value: null,
        quality: 'bad',
        timestamp: new Date().toISOString(),
        dataType: 'unknown'
      };
    }
    return result;
  }

  async writeTag(id: string, value: unknown): Promise<void> {
    this.assertConnected();
    const topic = Object.entries(this.topicMap).find(([, tagId]) => tagId === id)?.[0];
    if (!topic) throw new Error(`点位不存在：${id}`);
    const client = this.client;
    if (!client) throw new Error('MQTT 客户端未连接');
    await new Promise<void>((resolve, reject) => {
      client.publish(topic, JSON.stringify(value), { qos: 0 }, (error) => {
        if (error) reject(new Error(`MQTT 写入点位 ${id} 失败：${readableError(error)}`));
        else resolve();
      });
    });
  }

  subscribe(ids: string[], callback: (value: TagValue) => void): () => void {
    this.assertConnected();
    for (const id of ids) {
      if (!Object.values(this.topicMap).includes(id)) throw new Error(`点位不存在：${id}`);
      let callbacks = this.listeners.get(id);
      if (!callbacks) {
        callbacks = new Set();
        this.listeners.set(id, callbacks);
      }
      callbacks.add(callback);
      const current = this.latest.get(id);
      if (current) callback(current);
    }
    return () => {
      for (const id of ids) {
        const callbacks = this.listeners.get(id);
        callbacks?.delete(callback);
        if (callbacks && callbacks.size === 0) this.listeners.delete(id);
      }
    };
  }

  status(): FactoryStatus {
    return this.state;
  }

  getError(): string | null {
    return this.errorText;
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new Error('MQTT 尚未连接');
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => {
      client.end(false, {}, () => resolve());
      setTimeout(resolve, 1500);
    });
  }
}
