import ModbusRTU from 'modbus-serial';
import { parsePlcConfig } from './config.ts';
import type { PlcAdapter, PlcArea, PlcConfig, PlcPoint, PlcStatus, PlcValue } from './types.ts';

const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 500;

type ValueMap = Record<string, PlcValue>;

interface ReadGroup {
  area: PlcArea;
  address: number;
  points: PlcPoint[];
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

export function translateModbusError(error: unknown, fallback = 'Modbus 通信失败'): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const text = `${code} ${message}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return `${fallback}：无法解析 PLC 主机名（ENOTFOUND）`;
  if (/ECONNREFUSED/i.test(text)) return `${fallback}：PLC 拒绝连接，请检查 IP 与端口（ECONNREFUSED）`;
  if (/ETIMEDOUT|timeout|timed out/i.test(text)) return `${fallback}：连接超时（5 秒）`;
  if (/ECONNRESET|socket hang up/i.test(text)) return `${fallback}：连接被 PLC 重置（ECONNRESET）`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(text)) return `${fallback}：PLC 网络不可达`;
  return `${fallback}：${message}`;
}

function groupPoints(points: PlcPoint[]): ReadGroup[] {
  const buckets = new Map<string, PlcPoint[]>();
  for (const point of points) {
    const key = `${point.area}:${point.dataType}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }
  const groups: ReadGroup[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((left, right) => left.address - right.address);
    let current: ReadGroup | null = null;
    for (const point of sorted) {
      if (current && point.address === current.address + current.points.length && current.points.length < 16) {
        current.points.push(point);
      } else {
        current = { area: point.area, address: point.address, points: [point] };
        groups.push(current);
      }
    }
  }
  return groups;
}

export class ModbusPlcAdapter implements PlcAdapter {
  readonly kind = 'modbus' as const;
  private client: ModbusRTU | null = null;
  private state: PlcStatus = 'disconnected';
  private lastError: string | null = null;
  private config: PlcConfig | null = null;
  private points = new Map<string, PlcPoint>();
  private listeners = new Set<(values: ValueMap) => void>();
  private errorListeners = new Set<(message: string) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  async connect(config: PlcConfig): Promise<void> {
    const parsed = parsePlcConfig(config);
    if (parsed.kind !== 'modbus') throw new Error(`Modbus 适配器不接受 ${parsed.kind} 配置`);
    if (!parsed.host || !parsed.port) throw new Error('Modbus TCP 缺少 host 或 port');
    this.state = 'connecting';
    this.lastError = null;
    this.points = new Map(parsed.points.map((point) => [point.id, point]));
    const client = new ModbusRTU();
    this.client = client;
    client.setTimeout(CONNECT_TIMEOUT_MS);
    try {
      await withTimeout(client.connectTCP(parsed.host, { port: parsed.port }), CONNECT_TIMEOUT_MS, 'PLC 连接');
      client.setID(parsed.unitId ?? 1);
      this.config = parsed;
      this.state = 'connected';
    } catch (error) {
      this.state = 'error';
      this.lastError = translateModbusError(error, 'PLC 连接失败');
      try {
        client.close();
      } catch {
        // close 只做资源回收，不覆盖原始连接错误。
      }
      this.client = null;
      throw new Error(this.lastError);
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.listeners.clear();
    this.errorListeners.clear();
    const client = this.client;
    this.client = null;
    this.config = null;
    this.points.clear();
    this.state = 'disconnected';
    if (client) {
      try {
        client.close();
      } catch (error) {
        this.state = 'error';
        this.lastError = translateModbusError(error, 'PLC 断开失败');
        throw new Error(this.lastError);
      }
    }
  }

  async read(id: string): Promise<PlcValue> {
    this.assertConnected();
    const point = this.point(id);
    try {
      return await this.readPoint(point);
    } catch (error) {
      throw new Error(translateModbusError(error, `读取点位「${id}」失败`));
    }
  }

  async write(id: string, value: PlcValue): Promise<void> {
    this.assertConnected();
    const point = this.point(id);
    if (!point.writable) throw new Error(`点位「${point.name}」不可写`);
    const client = this.requireClient();
    try {
      if (point.area === 'coil') {
        if (typeof value !== 'boolean') throw new Error('线圈点位需要布尔值');
        await client.writeCoil(point.address, value);
      } else if (point.area === 'holding') {
        if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('寄存器点位需要整数');
        await client.writeRegister(point.address, value);
      } else {
        throw new Error(`${point.area} 区不可写`);
      }
    } catch (error) {
      throw new Error(translateModbusError(error, `写入点位「${id}」失败`));
    }
  }

  async readAll(): Promise<ValueMap> {
    this.assertConnected();
    const points = [...this.points.values()];
    try {
      const values: ValueMap = {};
      for (const group of groupPoints(points)) {
        const groupValues = await this.readGroup(group);
        for (const [id, value] of Object.entries(groupValues)) values[id] = value;
      }
      return values;
    } catch (error) {
      throw new Error(translateModbusError(error, '批量读取 PLC 点位失败'));
    }
  }

  subscribe(callback: (values: ValueMap) => void): () => void {
    this.assertConnected();
    this.listeners.add(callback);
    void this.pollOnce();
    this.startPolling();
    return () => {
      this.listeners.delete(callback);
    };
  }

  onError(callback: (message: string) => void): () => void {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  status(): PlcStatus {
    return this.state;
  }

  error(): string | null {
    return this.lastError;
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.state !== 'connected') return;
    this.polling = true;
    try {
      const values = await this.readAll();
      for (const listener of this.listeners) listener(values);
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stopPolling();
      for (const listener of this.errorListeners) listener(this.lastError);
    } finally {
      this.polling = false;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config?.pollMs ?? DEFAULT_POLL_MS;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, interval);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async readGroup(group: ReadGroup): Promise<ValueMap> {
    const client = this.requireClient();
    const values: ValueMap = {};
    if (group.area === 'coil' || group.area === 'discrete') {
      const result = group.area === 'coil'
        ? await client.readCoils(group.address, group.points.length)
        : await client.readDiscreteInputs(group.address, group.points.length);
      for (const [index, point] of group.points.entries()) values[point.id] = result.data[index] === true;
      return values;
    }
    const result = group.area === 'holding'
      ? await client.readHoldingRegisters(group.address, group.points.length)
      : await client.readInputRegisters(group.address, group.points.length);
    for (const [index, point] of group.points.entries()) {
      const raw = result.data[index] ?? 0;
      values[point.id] = point.dataType === 'int16' && raw > 32767 ? raw - 65536 : raw;
    }
    return values;
  }

  private async readPoint(point: PlcPoint): Promise<PlcValue> {
    const values = await this.readGroup({ area: point.area, address: point.address, points: [point] });
    const value = values[point.id];
    if (value === undefined) throw new Error(`PLC 未返回点位「${point.id}」`);
    return value;
  }

  private point(id: string): PlcPoint {
    const point = this.points.get(id);
    if (!point) throw new Error(`点位不存在：${id}`);
    return point;
  }

  private requireClient(): ModbusRTU {
    if (!this.client) throw new Error('Modbus 客户端尚未连接');
    return this.client;
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new Error(this.lastError ?? 'PLC 尚未连接');
  }
}
