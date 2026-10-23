/**
 * 与原型 app.js 的一致性：在 vm 里执行原型脚本（截到 init 之前，不触 DOM），
 * 直接比较原型 buildScene 的轮廓、放置算法与结构树，防止原型改动后 3D 悄悄跑偏。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { PROTO_SCENE_OCCUPANCY, buildAssembly, replicatePlacements } from '../../src/orbit/model.ts';
import {
  BORE_TOLERANCE,
  STANDARD_BORES,
  STANDARD_STROKES,
  STROKE_TOLERANCE,
  boreFromEllipseRx,
  snapValue,
  strokeFromRodPath
} from '../../src/orbit/proto-sync.ts';
import { effectiveBore, effectiveStroke } from '../../src/orbit/model.ts';
import { insertedIdsFromTree, nodeForPart, partsForNode, resolveSelection } from '../../src/orbit/selection.ts';

function loadPrototype() {
  const src = readFileSync(new URL('../../../app.js', import.meta.url), 'utf8');
  const cut = src.indexOf('/* ---------------------------------------------------------------- init */');
  assert.ok(cut > 0, '原型 init 分隔注释缺失');
  const code = src.slice(0, cut) +
    '\nglobalThis.__proto = { state, buildScene, findFreePlacement, SCENE_OCCUPANCY, TREE, addInsertedPartRecord, LIB };';
  const ctx = { document: {}, window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.__proto;
}

const ISO_C = Math.cos(Math.PI / 6);
const f = (n) => n.toFixed(1);
const P = (x, y, z) => [(x - y) * ISO_C, (x + y) * 0.5 - z];
function boxSil([x0, y0, z0], [x1, y1, z1]) {
  const pts = [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y1, z1]];
  return 'M' + pts.map((p) => { const q = P(...p); return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'Z';
}
function cylSil(cx, cy, z0, z1, r) {
  const ccx = (cx - cy) * ISO_C, ccy = (cx + cy) * 0.5;
  const rx = r * 1.2247, ry = r * 0.7071;
  const y0 = ccy - z0, y1 = ccy - z1;
  return `M${f(ccx - rx)},${f(y1)} L${f(ccx - rx)},${f(y0)} A${f(rx)},${f(ry)} 0 0 0 ${f(ccx + rx)},${f(y0)} L${f(ccx + rx)},${f(y1)} A${f(rx)},${f(ry)} 0 0 1 ${f(ccx - rx)},${f(y1)}Z`;
}
function outlines(svg) {
  const out = {};
  for (const m of svg.matchAll(/data-outline="([^"]+)" d="([^"]+)"/g)) out[m[1]] = m[2];
  return out;
}
function partSvg(svg, id) {
  const start = svg.indexOf(`<g class="part" data-part="${id}">`);
  assert.ok(start >= 0, `原型 SVG 缺少零件 ${id}`);
  return svg.slice(start, svg.indexOf('</g>', start));
}

const proto = loadPrototype();

test('原型一致性：占位包围盒常量与原型 SCENE_OCCUPANCY 相同', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(proto.SCENE_OCCUPANCY)), PROTO_SCENE_OCCUPANCY.map((a) => [...a]));
});

for (const cfg of [{ bore: 32, stroke: 50 }, { bore: 40, stroke: 75 }, { bore: 80, stroke: 5 }]) {
  test(`原型一致性：buildScene(${cfg.bore}/${cfg.stroke}) 每个零件轮廓与 3D 模型逐字相同`, () => {
    const svg = proto.buildScene(cfg).svg;
    const o = outlines(svg);
    const asm = buildAssembly({ ...cfg, inserted: [], overrides: {} });
    const get = (id) => asm.parts.find((p) => p.id === id);
    for (const id of ['base', 'rail', 'carriage', 'sensor']) {
      assert.equal(o[id], boxSil(get(id).bbox.min, get(id).bbox.max), id);
    }
    const body = get('cyl').prims[1];
    assert.equal(o.cyl, cylSil(body.center[0], body.center[1], body.z0, body.z1, body.r), 'cyl');
    const rod = get('rod').prims[0];
    assert.equal(o.rod, cylSil(rod.center[0], rod.center[1], rod.z0, rod.z1, rod.r), 'rod');
  });
}

test('原型一致性：连续插入 7 件，放置复刻与原型 findFreePlacement 一致，SVG 轮廓相同', () => {
  const ids = [];
  for (let i = 1; i <= 7; i += 1) {
    const placement = proto.findFreePlacement();
    proto.addInsertedPartRecord(proto.LIB[i % proto.LIB.length], `ins${i}`, placement);
    ids.push(`ins${i}`);
  }
  const theirs = proto.state.insertedParts.map((p) => [p.id, p.x, p.y, p.z, p.w, p.d, p.h]);
  const ours = replicatePlacements(ids).map((p) => [p.id, p.x, p.y, p.z, p.w, p.d, p.h]);
  assert.deepEqual(ours, JSON.parse(JSON.stringify(theirs)));
  assert.deepEqual(insertedIdsFromTree(JSON.parse(JSON.stringify(proto.TREE))), ids);
  const svg = proto.buildScene({ bore: 32, stroke: 50 }).svg;
  const o = outlines(svg);
  const asm = buildAssembly({ bore: 32, stroke: 50, inserted: replicatePlacements(ids), overrides: {} });
  ids.forEach((id) => {
    const b = asm.parts.find((p) => p.id === id).bbox;
    assert.equal(o[id], boxSil(b.min, b.max), id);
  });
});

test('SVG 反算缸径/行程：吸附到标准值或用户输入值，误差在容差内', () => {
  const cases = [[40, 75], [32, 50], [33, 47], [50, 125], [63, 200]];
  for (const [bore, stroke] of cases) {
    const svg = proto.buildScene({ bore, stroke }).svg;
    const rx = Number(/<ellipse[^>]*rx="([\d.]+)"/.exec(partSvg(svg, 'cyl'))[1]);
    const rodPath = /<path d="([^"]+)"/.exec(partSvg(svg, 'rod'))[1];
    const approxBore = boreFromEllipseRx(rx);
    const approxStroke = strokeFromRodPath(rodPath);
    assert.ok(Math.abs(approxBore - bore) <= BORE_TOLERANCE, `bore ${approxBore} vs ${bore}`);
    assert.ok(Math.abs(approxStroke - stroke) <= STROKE_TOLERANCE, `stroke ${approxStroke} vs ${stroke}`);
    const borePool = [...STANDARD_BORES, bore];
    const strokePool = [...STANDARD_STROKES, stroke];
    assert.deepEqual(snapValue(approxBore, borePool, BORE_TOLERANCE, effectiveBore), { value: bore, exact: true });
    assert.deepEqual(snapValue(approxStroke, strokePool, STROKE_TOLERANCE, effectiveStroke), { value: stroke, exact: true });
  }
});

test('结构树 ↔ 3D：用原型真实 TREE 做组展开、代理节点与反查', () => {
  const tree = JSON.parse(JSON.stringify(proto.TREE));
  assert.deepEqual(partsForNode(tree, 'g-cyl'), ['cyl', 'rod', 'sensor']);
  assert.deepEqual(partsForNode(tree, 'g-slide'), ['base', 'rail', 'carriage', 'cyl', 'rod', 'sensor']);
  assert.deepEqual(partsForNode(tree, 'g-std').slice(0, 1), ['ins1'], '标准件文件夹只展开插入件，不含 std 代理');
  assert.equal(nodeForPart(tree, 'cyl'), 'cyl');
  assert.equal(nodeForPart(tree, 'ins3'), 'ins3');
  assert.deepEqual(resolveSelection(tree, ['carriage'], 'g-slide').length, 6);
});
