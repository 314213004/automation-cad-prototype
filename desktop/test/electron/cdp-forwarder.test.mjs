import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { after, test } from 'node:test';
import { CdpForwarder } from '../../electron/cdp-forwarder.ts';

const cleanup = [];
after(async () => {
  for (const stop of cleanup.reverse()) await stop();
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function waitFor(predicate, label, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}`));
      }
    }, 20);
  });
}

function connectAndSend(port, payload) {
  return new Promise((resolve, reject) => {
    const client = connect({ host: '127.0.0.1', port });
    const chunks = [];
    client.on('data', (chunk) => {
      chunks.push(chunk);
      resolve(Buffer.concat(chunks).toString('utf8'));
      client.destroy();
    });
    client.on('error', reject);
    client.write(payload);
  });
}

test('白名单/回环连接双向 pipe 到目标端口', async () => {
  const target = createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  cleanup.push(() => new Promise((resolve) => target.close(resolve)));
  const forwarder = new CdpForwarder({
    listenHost: '127.0.0.1',
    listenPort: 0,
    targetHost: '127.0.0.1',
    targetPort,
    allowlist: ['10.0.0.0/8'],
    onDenied: () => assert.fail('回环地址不应被拒绝')
  });
  await forwarder.start();
  cleanup.push(() => forwarder.stop());
  await waitFor(() => forwarder.state().targetReachable, '9229 probe');
  const port = forwarder.state().listeningPort;
  assert.ok(port > 0);
  assert.equal(forwarder.state().active, true);
  assert.equal(await connectAndSend(port, 'hello-cdp'), 'hello-cdp');
});

test('非白名单来源立即断开并回调 onDenied', async () => {
  const target = createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(target);
  cleanup.push(() => new Promise((resolve) => target.close(resolve)));
  const denied = [];
  const forwarder = new CdpForwarder({
    listenHost: '127.0.0.1',
    listenPort: 0,
    targetHost: '127.0.0.1',
    targetPort,
    allowlist: ['10.0.0.0/8'],
    resolveRemoteAddress: () => '203.0.113.9',
    onDenied: (address) => denied.push(address)
  });
  await forwarder.start();
  cleanup.push(() => forwarder.stop());
  const port = forwarder.state().listeningPort;
  await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('error', resolve);
    socket.on('close', resolve);
  });
  await waitFor(() => denied.length === 1, 'denied callback');
  assert.deepEqual(denied, ['203.0.113.9']);
});

test('端口被占用返回中文错误', async () => {
  const occupied = createServer();
  const port = await listen(occupied);
  cleanup.push(() => new Promise((resolve) => occupied.close(resolve)));
  const forwarder = new CdpForwarder({
    listenHost: '127.0.0.1',
    listenPort: port,
    targetHost: '127.0.0.1',
    targetPort: 9,
    allowlist: ['127.0.0.1'],
    onDenied: () => {}
  });
  await assert.rejects(() => forwarder.start(), new RegExp(`CDP 端口 ${port} 被占用`));
});
