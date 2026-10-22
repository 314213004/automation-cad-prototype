// 临时假 sidecar：验证 SMOKE_PARAMETRIC_SIDECAR_OK
import http from 'node:http';

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(get('--port') ?? 7430);
const token = get('--token') ?? '';
const version = '0.0.0-fake';

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, kernel: 'build123d', version, pid: process.pid });
  }
  if (req.method === 'POST' && req.url === '/build') {
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      send(200, {
        ok: true,
        kernel: 'build123d',
        stats: { volumeMm3: 71495.7, bbox: [120, 80, 8], faces: 19, edges: 48, solids: 1 },
        buildMs: 12,
        files: {
          step: { path: '/tmp/fake.step', bytes: 63488, ms: 11.1 },
          stl: { path: '/tmp/fake.stl', bytes: 153484, ms: 19 }
        }
      });
    });
    return;
  }
  send(404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ok: true, port, token, version })));
