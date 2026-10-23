import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { ServerTCP } from 'modbus-serial';
import { ModbusPlcAdapter, translateModbusError } from '../../src/plc/modbus.ts';

const point = { id: 'Y0', name: '输出', area: 'coil', address: 0, dataType: 'bool', writable: true };

test('Modbus 参数校验：缺少点位/host/port 不发起连接', async () => {
  const adapter = new ModbusPlcAdapter();
  await assert.rejects(() => adapter.connect({ kind: 'modbus', points: [] }), /点位表不能为空/);
  await assert.rejects(
    () => adapter.connect({ kind: 'modbus', points: [point] }),
    /缺少必填参数：host/
  );
  await assert.rejects(
    () => adapter.connect({ kind: 'modbus', host: '127.0.0.1', points: [point] }),
    /缺少必填参数：port/
  );
  assert.equal(adapter.status(), 'disconnected');
});

test('Modbus 点位类型与地址校验使用中文错误', async () => {
  const adapter = new ModbusPlcAdapter();
  await assert.rejects(
    () => adapter.connect({ kind: 'modbus', host: '127.0.0.1', port: 502, points: [{ ...point, dataType: 'uint16' }] }),
    /数据类型必须是 bool/
  );
  await assert.rejects(
    () => adapter.connect({ kind: 'modbus', host: '127.0.0.1', port: 502, points: [{ ...point, address: 70000 }] }),
    /地址必须是 0 ~ 65535/
  );
  await assert.rejects(
    () => adapter.connect({ kind: 'modbus', host: '127.0.0.1', port: 70000, points: [point] }),
    /端口必须是 1 ~ 65535/
  );
});

test('Modbus 错误翻译覆盖 ENOTFOUND / ECONNREFUSED / 超时', () => {
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND plc.local'), { code: 'ENOTFOUND' });
  assert.match(translateModbusError(dns, 'PLC 连接失败'), /无法解析 PLC 主机名/);
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:502'), { code: 'ECONNREFUSED' });
  assert.match(translateModbusError(refused, 'PLC 连接失败'), /拒绝连接/);
  assert.match(translateModbusError(new Error('Timed out'), 'PLC 连接失败'), /超时（5 秒）/);
  assert.match(translateModbusError(new Error('socket hang up'), 'PLC 连接失败'), /连接被 PLC 重置/);
});

test('Modbus TCP 通过本地服务验证 FC01/02/03/04/05/06 读写', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 502;
  await new Promise((resolve) => probe.close(resolve));
  const coils = new Map();
  const discrete = new Map();
  const holding = new Map();
  const input = new Map();
  const server = new ServerTCP({
    getCoil: (addr) => coils.get(addr) ?? false,
    getDiscreteInput: (addr) => discrete.get(addr) ?? false,
    getHoldingRegister: (addr) => holding.get(addr) ?? 0,
    getInputRegister: (addr) => input.get(addr) ?? 0,
    setCoil: (addr, value) => { coils.set(addr, value); },
    setRegister: (addr, value) => { holding.set(addr, value); }
  }, { host: '127.0.0.1', port, unitID: 1, debug: false });
  await new Promise((resolve, reject) => {
    server.on('initialized', resolve);
    server.on('serverError', reject);
    setTimeout(() => reject(new Error('Modbus 测试服务启动超时')), 2000).unref();
  });
  const adapter = new ModbusPlcAdapter();
  try {
    await adapter.connect({
      kind: 'modbus',
      host: '127.0.0.1',
      port,
      unitId: 1,
      points: [
        { id: 'Y0', name: '线圈', area: 'coil', address: 0, dataType: 'bool', writable: true },
        { id: 'X0', name: '离散输入', area: 'discrete', address: 0, dataType: 'bool' },
        { id: 'AO0', name: '保持寄存器', area: 'holding', address: 0, dataType: 'uint16', writable: true },
        { id: 'AI0', name: '输入寄存器', area: 'input', address: 0, dataType: 'uint16' }
      ]
    });
    await adapter.write('Y0', true);
    await adapter.write('AO0', 456);
    discrete.set(0, true);
    input.set(0, 789);
    assert.equal(await adapter.read('Y0'), true);
    assert.equal(await adapter.read('X0'), true);
    assert.equal(await adapter.read('AO0'), 456);
    assert.equal(await adapter.read('AI0'), 789);
    assert.deepEqual(await adapter.readAll(), { Y0: true, X0: true, AO0: 456, AI0: 789 });
  } finally {
    await adapter.disconnect();
    await new Promise((resolve) => server.close(resolve));
  }
});
