import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeApiKeyUrl, isLoopbackHostname } from '../../src/shared/api-key-transport.ts';

test('只把明确的 localhost 与 IP 回环地址视为本机目标', () => {
  for (const host of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.255.255.255', '[::1]']) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  for (const host of ['factory.example.com', 'localhost.localdomain', '10.0.0.1', '192.168.1.2', '[::2]']) {
    assert.equal(isLoopbackHostname(host), false, host);
  }
});

test('API key URL 仅允许 HTTPS 或 HTTP 回环地址', () => {
  for (const value of ['https://factory.example.com/v1', 'http://localhost:8000', 'http://127.4.3.2:8000', 'http://[::1]:8000']) {
    assert.doesNotThrow(() => assertSafeApiKeyUrl(new URL(value)), value);
  }
  for (const value of ['http://factory.example.com/v1', 'http://10.0.0.1:8000', 'ftp://localhost/resource']) {
    assert.throws(() => assertSafeApiKeyUrl(new URL(value)), /明文传输 API Key|必须以 http:\/\/ 或 https:\/\/ 开头/, value);
  }
});
