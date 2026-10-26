import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  affectedPartKeys,
  applyJobResults,
  canonicalJson,
  drawingStatus,
  emptyManifest,
  geometryHashOf,
  parseDrawingManifest,
  partKeyOf,
  planDrawingParts
} from '../../src/drawings/stale.ts';
import { partFileStem } from '../../src/drawings/protocol.ts';

const plate = (length = 200) => [
  { id: 'f1', type: 'box', name: '底板', params: { length, width: 120, height: 15 } },
  { id: 'f2', type: 'holes', name: '孔', params: { diameter: 8, positions: [[-40, 0], [40, 0]] } }
];

function assembly(instances) {
  return { schemaVersion: 2, updatedAt: '2026-10-26T09:00:00Z', instances };
}

function inst(id, partId, features, name = id, transform = { x: 0, y: 0, z: 0, rz: 0 }) {
  return { id, name, ...(partId ? { partId } : {}), transform, features };
}

function okResult(part) {
  return { partId: part.partId, ok: true, files: { pdf: `${part.fileStem}.pdf`, dxf: `${part.fileStem}.dxf` }, warnings: [], paper: 'A3', scale: '1:1' };
}

test('canonicalJson：键序无关、数组保序', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('partKeyOf / geometryHashOf：物料号优先；摆位、名称、抑制特征不影响几何哈希', () => {
  assert.equal(partKeyOf({ id: 'p1', partId: ' P-001 ' }), 'P-001');
  assert.equal(partKeyOf({ id: 'p1' }), 'inst:p1');
  const base = geometryHashOf(plate());
  assert.equal(geometryHashOf(plate().map((f) => ({ ...f, name: `改名-${f.name}` }))), base);
  assert.equal(geometryHashOf([...plate(), { id: 'f3', type: 'fillet', name: 'r', params: { radius: 2 }, suppressed: true }]), base);
  assert.notEqual(geometryHashOf(plate(201)), base);
});

test('planDrawingParts：同物料号合并计数，选中实例只出其所属零件，空实体跳过', () => {
  const doc = assembly([
    inst('p1', 'P-001', plate(), '转接板'),
    inst('p2', 'P-001', plate(), '转接板', { x: 300, y: 0, z: 0, rz: 90 }),
    inst('p3', null, [{ id: 'f1', type: 'cylinder', name: '滚筒', params: { diameter: 60, height: 300 } }], '滚筒'),
    inst('p4', null, [], '空')
  ]);
  const all = planDrawingParts(doc, { meta: { 'P-001': { material: '6061-T6', drawingNo: 'AC-001' } } });
  assert.deepEqual(all.parts.map((part) => part.partKey), ['P-001', 'inst:p3']);
  const first = all.parts[0];
  assert.equal(first.quantity, 2);
  assert.deepEqual(first.instanceIds, ['p1', 'p2']);
  assert.equal(first.material, '6061-T6');
  assert.equal(first.drawingNo, 'AC-001');
  assert.equal(first.fileStem, partFileStem('P-001'));
  assert.equal(first.conflict, false);
  assert.equal(all.parts[1].drawingNo, 'p3', '未填图号时默认用 partId/实体 id');
  assert.deepEqual(all.skipped.map((item) => item.instanceId), ['p4']);
  const selected = planDrawingParts(doc, { instanceIds: ['p2'] });
  assert.deepEqual(selected.parts.map((part) => part.partKey), ['P-001']);
  assert.equal(selected.parts[0].quantity, 2, '选中一个实例也按整个物料号出图并计数');
});

test('planDrawingParts：同物料号几何不一致 → conflict + 警告，按第一个实例出图', () => {
  const plan = planDrawingParts(assembly([inst('p1', 'X', plate(200), 'A'), inst('p2', 'X', plate(220), 'B')]));
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0].conflict, true);
  assert.equal(plan.parts[0].name, 'A');
  assert.match(plan.warnings[0], /几何不一致/);
});

test('drawingStatus：missing → 出图后 fresh → 改参数 stale → 改材料 stale → 失败保留旧图且判 stale', () => {
  const docV1 = assembly([inst('p1', 'P-001', plate(200), '转接板'), inst('p2', 'P-002', plate(100), '小板')]);
  let manifest = emptyManifest('proj-1');
  let plan = planDrawingParts(docV1);
  let report = drawingStatus(manifest, plan);
  assert.deepEqual(report.missingKeys, ['P-001', 'P-002']);

  manifest = applyJobResults(manifest, {
    jobId: 'fc-1', freecadVersion: '1.0.0',
    parts: plan.parts.map((part) => ({ plan: part, result: okResult(part), stepSha256: 'a'.repeat(64) })),
    now: new Date('2026-10-26T09:10:00Z')
  });
  report = drawingStatus(manifest, plan);
  assert.deepEqual(report.parts.map((item) => item.status), ['fresh', 'fresh']);
  assert.equal(manifest.entries['P-001'].stepSha256, 'a'.repeat(64));
  assert.equal(manifest.entries['P-001'].freecadVersion, '1.0.0');

  // 只改 P-001 的长度：只有 P-001 过期
  const docV2 = assembly([inst('p1', 'P-001', plate(210), '转接板'), inst('p2', 'P-002', plate(100), '小板')]);
  report = drawingStatus(manifest, planDrawingParts(docV2));
  assert.deepEqual(report.staleKeys, ['P-001']);
  assert.match(report.parts[0].reason, /几何/);
  assert.deepEqual(affectedPartKeys(docV1, docV2), ['P-001']);

  // 改材料（标题栏字段）也过期，原因不同
  report = drawingStatus(manifest, planDrawingParts(docV1, { meta: { 'P-002': { material: 'SUS304' } } }));
  assert.deepEqual(report.staleKeys, ['P-002']);
  assert.match(report.parts[1].reason, /标题栏/);

  // 重出失败：旧图纸保留，但标记 lastError → stale
  const v2Plan = planDrawingParts(docV2);
  manifest = applyJobResults(manifest, {
    jobId: 'fc-2',
    parts: [{ plan: v2Plan.parts[0], result: { partId: 'P-001', ok: false, files: {}, warnings: [], error: '投影超时' } }]
  });
  assert.ok(manifest.entries['P-001'].files.pdf, '失败不删除旧图纸');
  assert.equal(manifest.entries['P-001'].lastError, '投影超时');
  report = drawingStatus(manifest, planDrawingParts(docV1));
  assert.equal(report.parts[0].status, 'stale');
  assert.match(report.parts[0].reason, /重出失败/);

  // 重出成功后清除 lastError
  manifest = applyJobResults(manifest, { jobId: 'fc-3', parts: [{ plan: v2Plan.parts[0], result: okResult(v2Plan.parts[0]) }] });
  assert.equal(manifest.entries['P-001'].lastError, undefined);
  assert.equal(drawingStatus(manifest, v2Plan).parts[0].status, 'fresh');
});

test('drawingStatus：删除零件后清单条目成为 orphan（不自动删除）', () => {
  const doc = assembly([inst('p1', 'A', plate()), inst('p2', 'B', plate(90))]);
  const plan = planDrawingParts(doc);
  const manifest = applyJobResults(emptyManifest('k'), { jobId: 'fc', parts: plan.parts.map((part) => ({ plan: part, result: okResult(part) })) });
  const report = drawingStatus(manifest, planDrawingParts(assembly([inst('p1', 'A', plate())])));
  assert.deepEqual(report.orphans.map((entry) => entry.partKey), ['B']);
});

test('affectedPartKeys：首次出图视为全部受影响；新增零件受影响；仅摆位变化不受影响', () => {
  const v1 = assembly([inst('p1', 'A', plate())]);
  assert.deepEqual(affectedPartKeys(null, v1), ['A']);
  const moved = assembly([inst('p1', 'A', plate(), 'p1', { x: 500, y: 20, z: 0, rz: 45 })]);
  assert.deepEqual(affectedPartKeys(v1, moved), []);
  const added = assembly([inst('p1', 'A', plate()), inst('p9', 'Z', plate(50))]);
  assert.deepEqual(affectedPartKeys(v1, added), ['Z']);
});

test('parseDrawingManifest：丢弃伪造文件名与不匹配 fileStem 的条目', () => {
  const stem = partFileStem('A');
  const manifest = parseDrawingManifest({
    schemaVersion: 1,
    entries: {
      A: { partKey: 'A', fingerprint: 'f', fileStem: stem, files: { pdf: `${stem}.pdf`, dxf: '../../evil.dxf' }, warnings: ['w', 1] },
      B: { partKey: 'B', fingerprint: 'f', fileStem: '../x', files: {} },
      C: { partKey: 'D', fingerprint: 'f', fileStem: partFileStem('C'), files: {} }
    }
  }, 'proj');
  assert.deepEqual(Object.keys(manifest.entries), ['A']);
  assert.deepEqual(manifest.entries.A.files, { pdf: `${stem}.pdf` });
  assert.deepEqual(manifest.entries.A.warnings, ['w']);
  assert.deepEqual(parseDrawingManifest('garbage', 'p').entries, {});
});
