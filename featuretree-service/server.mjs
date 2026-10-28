// FeatureTree 契约服务：本地 HTTP，只监听 127.0.0.1；端口默认 18080（环境变量 FT_PORT）。
// 端点（契约第 12 节拟议接口）：
//   GET  /v1/tree?documentId=demo-adapter
//   POST /v1/operations   { documentId, expectedRevision, actor, agentId?, operation, ... }
//   GET  /v1/revisions?documentId=demo-adapter
//   POST /v1/undo          { documentId, expectedRevision, actor?, steps? }
//   GET  /v1/events?documentId=demo-adapter   (SSE，变更时推送)
import { createServer } from 'node:http';
import { Store } from './store.mjs';

export const seedDoc = {
  schemaVersion: 1,
  features: [
    { id: 'f-body', type: 'box', name: '90×90×12 板体', params: { length: 90, width: 90, height: 12, centered: true } },
    { id: 'f-cb-in', type: 'counterbore', name: '母件侧沉头孔 Ø5.5 / Ø8.5×5（M5）', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, depth: 'through', positions: [[-30, -30], [30, -30], [-30, 30], [30, 30]] } },
    { id: 'f-holes-out', type: 'holes', name: '子件侧孔阵列（body）', params: { diameter: 5.5, depth: 'through', positions: [[-24, -18], [24, -18], [-24, 18], [24, 18]] } },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
  ],
  updatedAt: '2026-10-28T00:00:00+08:00'
};

const store = new Store(seedDoc);
const sseClients = new Set();
store.onChange((change) => {
  const line = `data: ${JSON.stringify(change)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { /* ignore */ } }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/v1/tree') return send(res, 200, store.envelope());
    if (req.method === 'GET' && url.pathname === '/v1/revisions') return send(res, 200, { documentId: 'demo-adapter', revision: store.revision, history: store.history });
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ documentId: 'demo-adapter', revision: store.revision, hello: true })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/operations') {
      const body = await readBody(req);
      const out = store.applyOperation(body);
      if (out.error) return send(res, out.error === 'CONFLICT_STALE_REVISION' ? 409 : out.error === 'NOT_FOUND' ? 404 : 422, out);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/v1/undo') {
      const body = await readBody(req);
      const out = store.undo(body.expectedRevision, body.actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual', body.steps ?? 1);
      if (out.error) return send(res, out.error === 'CONFLICT_STALE_REVISION' ? 409 : out.error === 'NOT_FOUND' ? 404 : 422, out);
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'NOT_FOUND', message: `未知路径：${url.pathname}` });
  } catch (e) {
    return send(res, 400, { error: 'VALIDATION_FAILED', message: e.message });
  }
});

const port = Number(process.env.FT_PORT || 18080);
server.listen(port, '127.0.0.1', () => console.log(`FeatureTree 服务已启动：http://127.0.0.1:${port}（仅本地回环）`));
