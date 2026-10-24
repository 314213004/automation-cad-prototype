import type {
  FactoryAdapter,
  FactoryConfig,
  FactoryStatus,
  TagDataType,
  TagNode,
  TagValue
} from './types';

type OpcUaSdk = typeof import('node-opcua');
type OpcUaClient = import('node-opcua').OPCUAClient;
type OpcUaSession = import('node-opcua').ClientSession;
type OpcUaSubscription = import('node-opcua').ClientSubscription;

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function localizedName(value: unknown): string {
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string' && text) return text;
  }
  return String(value ?? '');
}

function nodeIdText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof (value as { toString?: unknown }).toString === 'function') {
    const text = String(value);
    return text === '[object Object]' ? '' : text;
  }
  return '';
}

function inferDataType(value: unknown, sdk: OpcUaSdk): { dataType: number; value: unknown } {
  const { DataType } = sdk;
  if (typeof value === 'boolean') return { dataType: DataType.Boolean, value };
  if (typeof value === 'number' && Number.isInteger(value)) return { dataType: DataType.Int32, value };
  if (typeof value === 'number') return { dataType: DataType.Double, value };
  return { dataType: DataType.String, value: String(value ?? '') };
}

function valueType(value: unknown): TagDataType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  return 'unknown';
}

function dataValueToTagValue(id: string, dataValue: import('node-opcua').DataValue): TagValue {
  const statusCode = dataValue.statusCode;
  const good = !statusCode || statusCode.isGood?.() !== false;
  const value = dataValue.value?.value ?? null;
  const result: TagValue = {
    id,
    value,
    quality: good ? 'good' : 'bad',
    timestamp: (dataValue.sourceTimestamp ?? new Date()).toISOString(),
    dataType: valueType(value)
  };
  return result;
}

export class OpcUaFactoryAdapter implements FactoryAdapter {
  readonly kind = 'opcua' as const;
  private state: FactoryStatus = 'disconnected';
  private client: OpcUaClient | null = null;
  private session: OpcUaSession | null = null;
  private subscription: OpcUaSubscription | null = null;
  private sdk: OpcUaSdk | null = null;
  private errorText: string | null = null;

  async connect(config: FactoryConfig): Promise<void> {
    if (config.kind !== 'opcua') throw new Error(`OPC UA 适配器不接受 ${config.kind} 配置`);
    const endpointUrl = config.endpointUrl?.trim();
    if (!endpointUrl) throw new Error('缺少必填参数：endpointUrl');
    if (!/^opc\.tcp:\/\//i.test(endpointUrl)) {
      throw new Error('OPC UA 连接失败：endpointUrl 必须以 opc.tcp:// 开头');
    }
    const policy = config.securityPolicy ?? 'None';
    if (policy !== 'None' && policy !== 'Basic256Sha256') {
      throw new Error(`OPC UA 连接失败：暂不支持安全策略 ${policy}`);
    }
    if (policy !== 'None') {
      throw new Error('OPC UA 连接失败：当前版本仅支持 securityPolicy=None');
    }

    this.state = 'connecting';
    this.errorText = null;
    try {
      const sdk = await import('node-opcua');
      this.sdk = sdk;
      const client = sdk.OPCUAClient.create({
        applicationName: 'AutomationCAD',
        connectionStrategy: { initialDelay: 500, maxRetry: 0 },
        securityMode: sdk.MessageSecurityMode.None,
        securityPolicy: sdk.SecurityPolicy.None,
        endpointMustExist: false
      });
      this.client = client;
      client.on('backoff', () => {
        this.errorText = 'OPC UA 连接中断，正在等待重连';
      });
      client.on('connection_lost', () => {
        if (this.state === 'connected') {
          this.state = 'error';
          this.errorText = 'OPC UA 连接已断开';
        }
      });
      await client.connect(endpointUrl);
      this.session = config.username
        ? await client.createSession({
            type: sdk.UserTokenType.UserName,
            userName: config.username,
            password: config.password ?? ''
          })
        : await client.createSession();
      this.state = 'connected';
    } catch (error) {
      this.errorText = `OPC UA 连接失败：${readableError(error)}`;
      await this.cleanup();
      this.state = 'error';
      throw new Error(this.errorText);
    }
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
    this.state = 'disconnected';
    this.errorText = null;
  }

  async browse(nodeId?: string): Promise<TagNode[]> {
    this.assertConnected();
    if (!this.session) throw new Error('OPC UA 会话不存在');
    const root = nodeId ?? 'RootFolder';
    let result: import('node-opcua').BrowseResult;
    try {
      result = await this.session.browse(root);
    } catch (error) {
      throw new Error(`OPC UA 浏览失败：${readableError(error)}`);
    }
    const nodes = this.referencesToNodes(result);
    for (const node of nodes) {
      try {
        const childResult = await this.session.browse(node.id);
        const children = this.referencesToNodes(childResult);
        if (children.length > 0) node.children = children;
      } catch (error) {
        // 叶子节点或权限受限节点没有可浏览子项，保留该节点本身。
        console.warn(`[OPCUA_BROWSE_CHILD_FAILED]`, { site: 'desktop/src/factory/opcua.ts:152' }, error);
      }
    }
    return nodes;
  }

  async readTags(ids: string[]): Promise<Record<string, TagValue>> {
    this.assertConnected();
    if (!this.session) throw new Error('OPC UA 会话不存在');
    const sdk = this.requireSdk();
    const values: Record<string, TagValue> = {};
    for (const id of ids) {
      try {
        const dataValue = await this.session.read({ nodeId: id, attributeId: sdk.AttributeIds.Value });
        values[id] = dataValueToTagValue(id, dataValue);
      } catch (error) {
        throw new Error(`OPC UA 读取点位 ${id} 失败：${readableError(error)}`);
      }
    }
    return values;
  }

  async writeTag(id: string, value: unknown): Promise<void> {
    this.assertConnected();
    if (!this.session) throw new Error('OPC UA 会话不存在');
    const sdk = this.requireSdk();
    try {
      const current = await this.session.read({ nodeId: id, attributeId: sdk.AttributeIds.DataType });
      const currentType = typeof current.value?.value === 'number' ? current.value.value : null;
      const inferred = inferDataType(value, sdk);
      const dataType = currentType ?? inferred.dataType;
      await this.session.write({
        nodeId: id,
        attributeId: sdk.AttributeIds.Value,
        value: { value: { dataType, value } }
      });
    } catch (error) {
      throw new Error(`OPC UA 写入点位 ${id} 失败：${readableError(error)}`);
    }
  }

  subscribe(ids: string[], callback: (value: TagValue) => void): () => void {
    this.assertConnected();
    if (!this.session) throw new Error('OPC UA 会话不存在');
    const session = this.session;
    const sdk = this.requireSdk();
    let closed = false;
    void (async () => {
      try {
        const subscription = await session.createSubscription2({
          requestedPublishingInterval: 1000,
          requestedLifetimeCount: 60,
          requestedMaxKeepAliveCount: 10,
          maxNotificationsPerPublish: 100,
          publishingEnabled: true,
          priority: 10
        });
        this.subscription = subscription;
        for (const id of ids) {
          const item = await subscription.monitor(
            { nodeId: id, attributeId: sdk.AttributeIds.Value },
            { samplingInterval: 1000, queueSize: 1, discardOldest: true },
            sdk.TimestampsToReturn.Both
          );
          item.on('changed', (dataValue: import('node-opcua').DataValue) => {
            if (!closed) callback(dataValueToTagValue(id, dataValue));
          });
        }
      } catch (error) {
        if (!closed) {
          this.state = 'error';
          this.errorText = `OPC UA 订阅失败：${readableError(error)}`;
        }
      }
    })();
    return () => {
      closed = true;
      const subscription = this.subscription;
      this.subscription = null;
      if (subscription) void subscription.terminate();
    };
  }

  status(): FactoryStatus {
    return this.state;
  }

  getError(): string | null {
    return this.errorText;
  }

  private referencesToNodes(result: import('node-opcua').BrowseResult): TagNode[] {
    const references = result.references ?? [];
    return references
      .map<TagNode | null>((reference) => {
        const id = nodeIdText(reference.nodeId);
        if (!id) return null;
        const name = localizedName(reference.browseName?.name ?? reference.displayName);
        return {
          id,
          name: name || id,
          kind: 'folder' as const
        };
      })
      .filter((node): node is TagNode => node !== null);
  }

  private requireSdk(): OpcUaSdk {
    if (!this.sdk) throw new Error('OPC UA SDK 尚未加载');
    return this.sdk;
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new Error('OPC UA 尚未连接');
  }

  private async cleanup(): Promise<void> {
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) {
      try {
        await subscription.terminate();
      } catch (error) {
        // 清理阶段不再覆盖原始连接错误，但记录资源回收失败。
        console.warn('[factory/opcua] 终止订阅失败', error);
      }
    }
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch (error) {
        // 清理阶段不再覆盖原始连接错误，但记录资源回收失败。
        console.warn('[factory/opcua] 关闭会话失败', error);
      }
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        // 清理阶段不再覆盖原始连接错误，但记录资源回收失败。
        console.warn('[factory/opcua] 断开客户端失败', error);
      }
    }
  }
}
