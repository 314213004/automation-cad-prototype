import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpcUaFactoryAdapter } from '../../src/factory/opcua.ts';
import { MqttFactoryAdapter } from '../../src/factory/mqtt.ts';
import { FactoryManager } from '../../src/factory/manager.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('OPC UA 参数校验：缺少/非法 endpointUrl 不发起网络连接', async () => {
  const adapter = new OpcUaFactoryAdapter();
  await assert.rejects(() => adapter.connect({ kind: 'opcua' }), /缺少必填参数：endpointUrl/);
  await assert.rejects(() => adapter.connect({ kind: 'opcua', endpointUrl: 'http://127.0.0.1' }), /opc\.tcp:\/\//);
  await assert.rejects(
    () => adapter.connect({ kind: 'opcua', endpointUrl: 'opc.tcp://127.0.0.1:4840', securityPolicy: 'Basic256Sha256' }),
    /仅支持 securityPolicy=None/
  );
  assert.equal(adapter.status(), 'disconnected');
});

test('MQTT 参数校验：缺少 brokerUrl / topicMap 不发起网络连接', async () => {
  const adapter = new MqttFactoryAdapter();
  await assert.rejects(() => adapter.connect({ kind: 'mqtt' }), /缺少必填参数：brokerUrl/);
  await assert.rejects(() => adapter.connect({ kind: 'mqtt', brokerUrl: 'http://127.0.0.1' }), /brokerUrl/);
  await assert.rejects(
    () => adapter.connect({ kind: 'mqtt', brokerUrl: 'mqtt://127.0.0.1:1883' }),
    /topicMap 必须/
  );
  await assert.rejects(
    () => adapter.connect({ kind: 'mqtt', brokerUrl: 'mqtt://127.0.0.1:1883', topicMap: {} }),
    /topicMap 不能为空/
  );
  assert.equal(adapter.status(), 'disconnected');
});

test('manager 拒绝未知适配器类型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-protocol-test-'));
  const manager = new FactoryManager({ configFile: join(dir, 'factory.json'), timeoutMs: 200 });
  const result = await manager.connect({ kind: 'rest' });
  assert.equal(result.ok, false);
  assert.match(result.message, /不支持的适配器类型/);
});
