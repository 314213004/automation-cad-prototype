/**
 * 持久工位身份与几何生成器的 stN 临时编号分离。
 * 新工位使用随机不可变键；legacy 键只为无稳定键且无可迁移偏移的旧配置建立初始基线，
 * 不能用于跨需求重算匹配工位。
 */
export type StationIdentity = string;
const MAX_STATION_IDENTITY_LENGTH = 256;

export function createStationIdentity(): StationIdentity {
  const cryptoApi = globalThis.crypto;
  const value = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `station:${value}`;
}

/** 旧设计没有工位偏移映射时，仅为当前配置快照建立确定性身份，不推断历史连续性。 */
export function baselineStationIdentities(configId: string, stationCount: number): StationIdentity[] {
  const owner = encodeURIComponent(configId || 'legacy-design');
  return Array.from({ length: stationCount }, (_unused, index) => `legacy:${owner}:${index + 1}`);
}

export function isStationIdentity(value: unknown): value is StationIdentity {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STATION_IDENTITY_LENGTH && value.trim() === value;
}

export function isStationIdentityList(value: unknown, stationCount: number): value is StationIdentity[] {
  if (!Array.isArray(value) || value.length !== stationCount || value.some((item) => !isStationIdentity(item))) return false;
  return new Set(value).size === value.length;
}

export function assertStationIdentityList(value: unknown, stationCount: number): StationIdentity[] {
  if (!isStationIdentityList(value, stationCount)) {
    throw new Error('design.stationIdentities 必须是与配置工位一一对应且不重复的稳定 ID 数组');
  }
  return [...value];
}

export function stationIdentitiesFor(configId: string, stationCount: number, value: unknown): StationIdentity[] {
  return isStationIdentityList(value, stationCount)
    ? [...value]
    : baselineStationIdentities(configId, stationCount);
}
