import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LanConfig {
  enabled: boolean;
  allowlist: string[];
  cdpEnabled: boolean;
}

export const LAN_CONFIG_FILENAME = 'lan-access.json';

export const DEFAULT_LAN_CONFIG: LanConfig = Object.freeze({
  enabled: false,
  allowlist: Object.freeze(['192.168.0.0/16']) as unknown as string[],
  cdpEnabled: false
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedIpv4Cidr {
  address: number;
  prefix: number;
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function parseIpv4Cidr(value: string): ParsedIpv4Cidr | null {
  const slash = value.indexOf('/');
  const addressText = slash >= 0 ? value.slice(0, slash) : value;
  const prefixText = slash >= 0 ? value.slice(slash + 1) : '32';
  const address = parseIpv4(addressText);
  if (address === null || !/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { address, prefix };
}

function ipv4InCidr(address: number, cidr: ParsedIpv4Cidr): boolean {
  if (cidr.prefix === 0) return true;
  const mask = (0xffffffff << (32 - cidr.prefix)) >>> 0;
  return ((address & mask) >>> 0) === ((cidr.address & mask) >>> 0);
}

export function normalizeRemoteAddress(value: unknown): string {
  if (typeof value !== 'string') return '';
  let address = value.trim();
  if (address.toLowerCase().startsWith('::ffff:')) address = address.slice(7);
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);
  return address;
}

export function isLoopbackAddress(value: unknown): boolean {
  const address = normalizeRemoteAddress(value);
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  const parsed = parseIpv4(address);
  return parsed !== null && (parsed >>> 24) === 127;
}

/** 白名单支持 IPv4 CIDR、单 IPv4、::1；回环地址永远放行。 */
export function isAddressAllowed(address: unknown, allowlist: readonly string[]): boolean {
  const remote = normalizeRemoteAddress(address);
  if (!remote) return false;
  if (isLoopbackAddress(remote)) return true;
  const remoteIpv4 = parseIpv4(remote);
  if (remoteIpv4 === null) return false;
  for (const entry of allowlist) {
    const cidr = parseIpv4Cidr(entry.trim());
    if (cidr && ipv4InCidr(remoteIpv4, cidr)) return true;
  }
  return false;
}

function validateAllowlistEntry(entry: string): void {
  if (entry === '::1') return;
  if (parseIpv4Cidr(entry) === null) {
    throw new Error(`CIDR 非法：${entry}。示例：192.168.0.0/16、10.0.0.0/8 或单 IP 192.168.2.117`);
  }
}

/** 文本或数组 → 去重后的白名单；逗号、中文逗号、换行分隔。 */
export function normalizeAllowlist(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(/[\n,，]+/)
      : [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = item.trim();
    if (!entry || seen.has(entry)) continue;
    validateAllowlistEntry(entry);
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function normalizeLanConfig(value: unknown): LanConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === true,
    allowlist: source.allowlist === undefined
      ? [...DEFAULT_LAN_CONFIG.allowlist]
      : normalizeAllowlist(source.allowlist),
    cdpEnabled: source.cdpEnabled === true
  };
}

export function lanConfigPath(userDataDir: string): string {
  return join(userDataDir, LAN_CONFIG_FILENAME);
}

/** 缺失或损坏时默认关闭；配置永远 fail-closed。 */
export function readLanConfig(userDataDir: string): LanConfig {
  const file = lanConfigPath(userDataDir);
  if (!existsSync(file)) return normalizeLanConfig(DEFAULT_LAN_CONFIG);
  try {
    return normalizeLanConfig(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    return normalizeLanConfig(DEFAULT_LAN_CONFIG);
  }
}

export function writeLanConfig(userDataDir: string, config: unknown): LanConfig {
  const normalized = normalizeLanConfig(config);
  mkdirSync(userDataDir, { recursive: true });
  const file = lanConfigPath(userDataDir);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`保存局域网配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

export function lanHost(config: Pick<LanConfig, 'enabled'>): '0.0.0.0' | '127.0.0.1' {
  return config.enabled ? '0.0.0.0' : '127.0.0.1';
}

