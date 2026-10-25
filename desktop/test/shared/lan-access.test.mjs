import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  DEFAULT_LAN_CONFIG,
  isAddressAllowed,
  isLoopbackAddress,
  lanConfigPath,
  lanHost,
  normalizeAllowlist,
  normalizeLanConfig,
  readLanConfig,
  writeLanConfig
} from '../../src/shared/lan-access.ts';

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cad-lan-access-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test('局域网默认关闭，仅回环监听、默认白名单 192.168.0.0/16', () => {
  assert.deepEqual(readLanConfig(sandbox), {
    enabled: false,
    allowlist: ['192.168.0.0/16'],
    cdpEnabled: false
  });
  assert.deepEqual(DEFAULT_LAN_CONFIG, readLanConfig(sandbox));
  assert.equal(lanHost(DEFAULT_LAN_CONFIG), '127.0.0.1');
  assert.equal(lanHost({ enabled: true }), '0.0.0.0');
});

test('CIDR 白名单命中与未命中', () => {
  assert.equal(isAddressAllowed('10.2.3.4', ['10.0.0.0/8']), true);
  assert.equal(isAddressAllowed('172.20.1.4', ['172.16.0.0/12']), true);
  assert.equal(isAddressAllowed('192.168.2.117', ['192.168.0.0/16']), true);
  assert.equal(isAddressAllowed('192.168.2.117', ['192.168.2.117']), true);
  assert.equal(isAddressAllowed('192.168.2.118', ['192.168.2.117']), false);
  assert.equal(isAddressAllowed('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(isAddressAllowed('192.168.1.1', ['10.0.0.0/8', '172.16.0.0/12']), false);
});

test('::ffff: 前缀归一化，回环与 ::1 永远放行', () => {
  assert.equal(isAddressAllowed('::ffff:192.168.2.117', ['192.168.0.0/16']), true);
  assert.equal(isAddressAllowed('127.0.0.1', []), true);
  assert.equal(isAddressAllowed('127.8.9.10', ['10.0.0.0/8']), true);
  assert.equal(isAddressAllowed('::1', []), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.2.1'), false);
});

test('非法 CIDR 保存时报中文错误且不落盘', () => {
  assert.throws(
    () => writeLanConfig(sandbox, { enabled: true, allowlist: ['192.168.0.0/99'], cdpEnabled: false }),
    /CIDR 非法/
  );
  assert.throws(() => normalizeAllowlist('10.0.0.0/8, 192.168.1'), /CIDR 非法/);
  assert.deepEqual(readLanConfig(sandbox), DEFAULT_LAN_CONFIG);
});

test('白名单文本支持中英文逗号与换行、去重', () => {
  assert.deepEqual(
    normalizeAllowlist('10.0.0.0/8, 192.168.0.0/16\n10.0.0.0/8，192.168.2.117'),
    ['10.0.0.0/8', '192.168.0.0/16', '192.168.2.117']
  );
});

test('局域网配置持久化往返且权限为 600', { skip: process.platform === 'win32' }, () => {
  const config = { enabled: true, allowlist: ['10.0.0.0/8', '192.168.2.117'], cdpEnabled: true };
  assert.deepEqual(writeLanConfig(sandbox, config), config);
  assert.deepEqual(readLanConfig(sandbox), config);
  assert.equal(statSync(lanConfigPath(sandbox)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(lanConfigPath(sandbox), 'utf8')), config);
  assert.deepEqual(normalizeLanConfig({}), DEFAULT_LAN_CONFIG);
});

