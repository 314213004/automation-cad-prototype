// 契约验收用例（契约第 14 节的子集，可直接跑）：
//   node tests.mjs   （需先启动服务：FT_PORT=18080 node server.mjs）
// 断言失败即退出码非 0；全部通过打印 PASS 行。
const BASE = process.env.FT_BASE || 'http://127.0.0.1:18080';
let n = 0;
function ok(cond, label, extra = '') {
  n += 1;
  if (!cond) { console.error(`FAIL ${n}: ${label} ${extra}`); process.exit(1); }
  console.log(`PASS ${n}: ${label}`);
}
async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
const tree0 = await req('GET', '/v1/tree');
ok(tree0.status === 200 && tree0.json.revision === 0, '初始版本为 0');
ok(tree0.json.doc.features.length === 4, '种子树有 4 个特征（板体/沉孔/孔阵列/圆角）');
// 1. 手动改拉伸高度 12 -> 14，版本 +1
const edit1 = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 0, actor: 'manual', operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 14 } });
ok(edit1.status === 200 && edit1.json.revision === 1 && edit1.json.doc.features[0].params.height === 14, '手动改板厚 12→14，版本 0→1');
// 2. 旧版本提交必须被拒绝，文档不变
const stale = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 0, actor: 'manual', operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 99 } });
ok(stale.status === 409 && stale.json.error === 'CONFLICT_STALE_REVISION', '旧版本提交返回 CONFLICT_STALE_REVISION');
const treeAfterStale = await req('GET', '/v1/tree');
ok(treeAfterStale.json.doc.features[0].params.height === 14, '冲突后文档不变，仍为 14');
// 3. Agent 改圆角半径 3 -> 4，版本 +1（双向：另一方应能读到）
const edit2 = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 1, actor: 'agent', agentId: 'demo-agent', operation: 'updateFeatureParams', featureId: 'f-fillet', patch: { radius: 4 } });
ok(edit2.status === 200 && edit2.json.revision === 2 && edit2.json.history.at(-1).actor === 'agent:demo-agent', 'Agent 改圆角 3→4，版本 1→2 且留痕');
// 4. 非法值：沉窝直径 <= 孔径，必须拒绝且版本不变
const bad = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 2, actor: 'manual', operation: 'updateFeatureParams', featureId: 'f-cb-in', patch: { cbDiameter: 5.5 } });
ok(bad.status === 422 && bad.json.error === 'VALIDATION_FAILED', '沉窝直径 <= 孔径被拒绝');
// 5. 未知字段拒绝
const unk = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 2, actor: 'manual', operation: 'updateFeatureParams', featureId: 'f-body', patch: { bogus: 1 } });
ok(unk.status === 422 && unk.json.error === 'UNKNOWN_FIELD', '未知字段被拒绝');
// 6. 批量事务：其中一个子操作非法则整单回滚
const tx = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 2, actor: 'manual', operation: 'applyTransaction', operations: [
  { operation: 'updateFeatureParams', featureId: 'f-body', patch: { length: 100 } },
  { operation: 'updateFeatureParams', featureId: 'f-fillet', patch: { radius: -1 } }
] });
ok(tx.status === 422, '批量事务含非法子操作时整单失败');
const treeAfterTx = await req('GET', '/v1/tree');
ok(treeAfterTx.json.revision === 2 && treeAfterTx.json.doc.features[0].params.length === 90, '事务回滚后版本与长度不变');
// 7. 压缩圆角后编译跳过它，再解除压缩恢复（版本各 +1）
const sup = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 2, actor: 'manual', operation: 'setSuppressed', featureId: 'f-fillet', suppressed: true });
ok(sup.status === 200 && sup.json.revision === 3 && sup.json.doc.features[3].suppressed === true, '压缩圆角，版本 2→3');
const unsup = await req('POST', '/v1/operations', { documentId: 'demo-adapter', expectedRevision: 3, actor: 'manual', operation: 'setSuppressed', featureId: 'f-fillet', suppressed: false });
ok(unsup.status === 200 && unsup.json.revision === 4, '解除压缩，版本 3→4');
// 8. undo 回到上一版本（板厚仍为 14，圆角仍为 4，版本 +1）
const und = await req('POST', '/v1/undo', { documentId: 'demo-adapter', expectedRevision: 4, actor: 'manual', steps: 1 });
ok(und.status === 200 && und.json.revision === 5 && und.json.doc.features[3].suppressed === true, 'undo 后回到压缩态，版本 4→5');
// 9. 历史留痕：manual 与 agent 都有记录
const revs = await req('GET', '/v1/revisions');
ok(revs.json.history.length === 5 && revs.json.history.some(h => h.actor.startsWith('agent:')), '历史 5 条且含 Agent 记录');
console.log(`全部通过：${n} 条`);
