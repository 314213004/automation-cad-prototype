import { createServer } from 'node:http';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue('--port'));
const token = argValue('--token') ?? '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('fake sidecar: --port 与 --token 必填');
  process.exit(2);
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, 200, {
      ok: true,
      kernel: 'fake',
      version: '0.0.0-fake',
      pid: process.pid
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/build') {
    if (!authorized(request)) {
      response.setHeader('www-authenticate', 'Bearer');
      send(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const payload = JSON.parse(await readBody(request));
      if (!Array.isArray(payload.ops) || payload.ops.length === 0) {
        send(response, 400, { ok: false, error: 'ops 必须是非空数组' });
        return;
      }
      send(response, 200, {
        ok: true,
        kernel: 'fake',
        stats: {
          volumeMm3: 71495.7,
          bbox: [120, 80, 8],
          faces: 19,
          edges: 30,
          solids: 1,
          ops: payload.ops.length
        },
        buildMs: 12,
        files: {
          step: { path: '/tmp/fake-part.step', bytes: 1234, ms: 2 },
          stl: { path: '/tmp/fake-part.stl', bytes: 4096, ms: 3 }
        }
      });
    } catch (error) {
      send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  send(response, 404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ ok: true, port, kernel: 'fake' }) + '\n');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 200).unref();
  });
}
