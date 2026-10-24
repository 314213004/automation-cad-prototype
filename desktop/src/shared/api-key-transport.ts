import { isIP } from 'node:net';

/** 明确识别本机回环主机名与地址；不尝试解析任意 DNS 名称。 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith('127.');
  return version === 6 && normalized === '::1';
}

/**
 * API key/token 会作为 HTTP header 发送时，只能使用 HTTPS；明文 HTTP 仅允许
 * 明确的本机回环目标，避免密钥在网络中裸传。
 */
export function assertSafeApiKeyUrl(url: URL, field = 'baseUrl'): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} 必须以 http:// 或 https:// 开头`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(`${field} 使用 HTTP 会明文传输 API Key；远程服务必须使用 HTTPS，本机服务仅允许 localhost、127.0.0.0/8 或 ::1`);
  }
}
