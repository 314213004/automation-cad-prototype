import type {
  FactoryAdapter,
  FactoryConfig,
  FactoryStatus,
  TagDataType,
  TagNode,
  TagValue
} from './types';
import { trackedClearInterval, trackedSetInterval } from '../shared/resources.ts';

interface DemoTickTag {
  id: string;
  name: string;
  station: string;
  dataType: TagDataType;
  unit?: string;
  writable: boolean;
  value: unknown;
}

interface DemoStation {
  id: string;
  name: string;
  tags: DemoTickTag[];
}

const STATIONS: DemoStation[] = [
  {
    id: 'press-station',
    name: '压装工位',
    tags: [
      { id: 'press.run', name: '运行', station: '压装工位', dataType: 'boolean', writable: true, value: true },
      { id: 'press.cycle', name: '节拍', station: '压装工位', dataType: 'number', unit: 's', writable: false, value: 4.2 },
      { id: 'press.good', name: '良品数', station: '压装工位', dataType: 'number', unit: '件', writable: false, value: 1280 },
      { id: 'press.alarm', name: '报警', station: '压装工位', dataType: 'boolean', writable: true, value: false }
    ]
  },
  {
    id: 'screw-station',
    name: '锁付工位',
    tags: [
      { id: 'screw.run', name: '运行', station: '锁付工位', dataType: 'boolean', writable: true, value: true },
      { id: 'screw.cycle', name: '节拍', station: '锁付工位', dataType: 'number', unit: 's', writable: false, value: 3.6 },
      { id: 'screw.good', name: '良品数', station: '锁付工位', dataType: 'number', unit: '件', writable: false, value: 942 },
      { id: 'screw.alarm', name: '报警', station: '锁付工位', dataType: 'boolean', writable: true, value: false }
    ]
  }
];

function cloneStations(): DemoStation[] {
  return STATIONS.map((station) => ({
    id: station.id,
    name: station.name,
    tags: station.tags.map((tag) => ({ ...tag }))
  }));
}

function tagValue(tag: DemoTickTag): TagValue {
  return {
    id: tag.id,
    value: tag.value,
    quality: 'good',
    timestamp: new Date().toISOString(),
    dataType: tag.dataType,
    ...(tag.unit ? { unit: tag.unit } : {})
  };
}

export class DemoFactoryAdapter implements FactoryAdapter {
  readonly kind = 'demo' as const;
  private state: FactoryStatus = 'disconnected';
  private stations = cloneStations();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private readonly listeners = new Set<{ ids: Set<string>; callback: (value: TagValue) => void }>();

  async connect(config: FactoryConfig): Promise<void> {
    if (config.kind !== 'demo') throw new Error(`仿真适配器不接受 ${config.kind} 配置`);
    this.state = 'connecting';
    await Promise.resolve();
    this.state = 'connected';
    this.startSimulation();
  }

  async disconnect(): Promise<void> {
    this.stopSimulation();
    this.listeners.clear();
    this.state = 'disconnected';
  }

  async browse(nodeId?: string): Promise<TagNode[]> {
    this.assertConnected();
    const nodes = this.stations.map((station) => ({
      id: station.id,
      name: station.name,
      kind: 'station' as const,
      station: station.name,
      children: station.tags.map((tag) => this.toNode(tag))
    }));
    if (!nodeId) return nodes;
    const station = this.stations.find((item) => item.id === nodeId);
    return station ? station.tags.map((tag) => this.toNode(tag)) : [];
  }

  async readTags(ids: string[]): Promise<Record<string, TagValue>> {
    this.assertConnected();
    const values: Record<string, TagValue> = {};
    for (const id of ids) {
      const tag = this.findTag(id);
      if (!tag) throw new Error(`点位不存在：${id}`);
      values[id] = tagValue(tag);
    }
    return values;
  }

  async writeTag(id: string, value: unknown): Promise<void> {
    this.assertConnected();
    const tag = this.findTag(id);
    if (!tag) throw new Error(`点位不存在：${id}`);
    if (!tag.writable) throw new Error(`点位「${tag.name}」不可写`);
    if (tag.dataType === 'boolean' && typeof value !== 'boolean') throw new Error('该点位需要布尔值');
    if (tag.dataType === 'number' && typeof value !== 'number') throw new Error('该点位需要数字');
    tag.value = value;
    this.emit(id);
  }

  subscribe(ids: string[], callback: (value: TagValue) => void): () => void {
    this.assertConnected();
    for (const id of ids) {
      if (!this.findTag(id)) throw new Error(`点位不存在：${id}`);
    }
    const listener = { ids: new Set(ids), callback };
    this.listeners.add(listener);
    for (const id of ids) {
      const tag = this.findTag(id);
      if (tag) callback(tagValue(tag));
    }
    this.startSimulation();
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): FactoryStatus {
    return this.state;
  }

  private toNode(tag: DemoTickTag): TagNode {
    return {
      id: tag.id,
      name: tag.name,
      kind: 'tag',
      dataType: tag.dataType,
      writable: tag.writable,
      station: tag.station,
      ...(tag.unit ? { unit: tag.unit } : {})
    };
  }

  private findTag(id: string): DemoTickTag | undefined {
    for (const station of this.stations) {
      const tag = station.tags.find((item) => item.id === id);
      if (tag) return tag;
    }
    return undefined;
  }

  private assertConnected(): void {
    if (this.state !== 'connected') throw new Error('仿真产线尚未连接');
  }

  private startSimulation(): void {
    if (this.timer) return;
    this.timer = trackedSetInterval(() => this.step(), 1000);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) this.timer.unref();
  }

  private stopSimulation(): void {
    if (!this.timer) return;
    trackedClearInterval(this.timer);
    this.timer = null;
  }

  private step(): void {
    this.tick += 1;
    const running = this.tick % 12 < 10;
    const alarm = this.tick % 17 === 0;
    const cycleDelta = (this.tick % 7) * 0.11;
    if (this.stations.length > 0) {
      this.setValue('press.run', running);
      this.setValue('press.cycle', Number((4.1 + cycleDelta).toFixed(2)));
      this.setValue('press.good', Number(this.findTag('press.good')?.value ?? 1280) + (running ? 6 : 0));
      this.setValue('press.alarm', alarm);
    }
    if (this.stations.length > 1) {
      this.setValue('screw.run', running);
      this.setValue('screw.cycle', Number((3.5 + cycleDelta * 0.8).toFixed(2)));
      this.setValue('screw.good', Number(this.findTag('screw.good')?.value ?? 942) + (running ? 4 : 0));
      this.setValue('screw.alarm', alarm && this.tick % 34 === 0);
    }
    for (const listener of this.listeners) {
      for (const id of listener.ids) {
        const tag = this.findTag(id);
        if (tag) listener.callback(tagValue(tag));
      }
    }
  }

  private setValue(id: string, value: unknown): void {
    const tag = this.findTag(id);
    if (tag) tag.value = value;
  }

  private emit(id: string): void {
    const tag = this.findTag(id);
    if (!tag) return;
    for (const listener of this.listeners) {
      if (listener.ids.has(id)) listener.callback(tagValue(tag));
    }
  }
}
