#!/usr/bin/env node
// 生成运动学自动识别用的合成 STEP 装配体夹具：test/fixtures/kinematics-assembly.stp
// 只用 FACETED_BREP（平面多边形面），圆柱用 16 棱柱近似；全部零件按世界坐标建模、装配变换为单位阵。
// 用法：node scripts/gen-kinematics-fixture.mjs [输出路径]
// 注意：脚本放在 scripts/ 而不是 test/，避免 node --test 把它当测试执行。

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? resolve(here, '../test/fixtures/kinematics-assembly.stp'));

const lines = [];
let nextId = 1;
const add = (text) => {
  const id = nextId;
  nextId += 1;
  lines.push(`#${id}=${text};`);
  return `#${id}`;
};

const num = (value) => {
  const rounded = Math.round(value * 1e6) / 1e6;
  const text = String(rounded);
  return text.includes('.') || text.includes('e') ? text : `${text}.`;
};

/** ISO 10303-21 字符串：非 ASCII 用 \X2\…\X0\（UTF-16 大端十六进制）。 */
function stepString(value) {
  let out = '';
  let wide = '';
  const flush = () => {
    if (wide) {
      out += `\\X2\\${wide}\\X0\\`;
      wide = '';
    }
  };
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x80) {
      flush();
      out += char === "'" ? "''" : char === '\\' ? '\\\\' : char;
    } else {
      wide += code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  flush();
  return `'${out}'`;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

// ---------- 全局上下文 ----------
const appContext = add(`APPLICATION_CONTEXT('automotive design')`);
add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appContext})`);
const productContext = add(`PRODUCT_CONTEXT('',${appContext},'mechanical')`);
const pdContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`);
const mm = add(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`);
const rad = add(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`);
const sr = add(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`);
const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','confusion accuracy')`);
const ctx = add(
  `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('Context3D','3D') )`
);
const point = (p) => add(`CARTESIAN_POINT('',(${num(p[0])},${num(p[1])},${num(p[2])}))`);
const direction = (d) => add(`DIRECTION('',(${num(d[0])},${num(d[1])},${num(d[2])}))`);
const axis2 = (origin, z, x) => add(`AXIS2_PLACEMENT_3D('',${point(origin)},${direction(z)},${direction(x)})`);

// ---------- 多面体 ----------
/** faces: 顶点索引数组，从外侧看逆时针。 */
function facetedBrep(vertices, faces) {
  const refs = vertices.map((vertex) => point(vertex));
  const faceRefs = faces.map((face) => {
    const loop = add(`POLY_LOOP('',(${face.map((index) => refs[index]).join(',')}))`);
    const bound = add(`FACE_OUTER_BOUND('',${loop},.T.)`);
    const p0 = vertices[face[0]];
    const p1 = vertices[face[1]];
    const p2 = vertices[face[2]];
    const normal = norm(cross(sub(p1, p0), sub(p2, p0)));
    const ref = norm(sub(p1, p0));
    const plane = add(`PLANE('',${axis2(p0, normal, ref)})`);
    return add(`FACE_SURFACE('',(${bound}),${plane},.T.)`);
  });
  const shell = add(`CLOSED_SHELL('',(${faceRefs.join(',')}))`);
  return add(`FACETED_BREP('',${shell})`);
}

function box(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
  ];
  const f = [
    [0, 3, 2, 1], // -Z
    [4, 5, 6, 7], // +Z
    [0, 1, 5, 4], // -Y
    [2, 3, 7, 6], // +Y
    [1, 2, 6, 5], // +X
    [0, 4, 7, 3] // -X
  ];
  return facetedBrep(v, f);
}

/** 沿主轴 axis（0/1/2）的正 n 棱柱：start 为起点圆心，长度 length，外接圆半径 radius。 */
function prism(axis, start, length, radius, sides = 16) {
  const u = (axis + 1) % 3;
  const w = (axis + 2) % 3;
  const vertices = [];
  for (const offset of [0, length]) {
    for (let i = 0; i < sides; i += 1) {
      const angle = (2 * Math.PI * i) / sides;
      const p = [...start];
      p[axis] += offset;
      p[u] += radius * Math.cos(angle);
      p[w] += radius * Math.sin(angle);
      vertices.push(p);
    }
  }
  const faces = [];
  const bottom = [];
  const top = [];
  for (let i = 0; i < sides; i += 1) {
    bottom.push(sides - 1 - i);
    top.push(sides + i);
    const a = i;
    const b = (i + 1) % sides;
    faces.push([a, b, sides + b, sides + a]);
  }
  faces.push(bottom, top);
  return facetedBrep(vertices, faces);
}

// ---------- 产品树 ----------
function productDefinition(name) {
  const product = add(`PRODUCT(${stepString(name)},${stepString(name)},'',(${productContext}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definition = add(`PRODUCT_DEFINITION('design','',${formation},${pdContext})`);
  const shape = add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  return { definition, shape };
}

const identity = () => axis2([0, 0, 0], [0, 0, 1], [1, 0, 0]);
let nauoSerial = 0;

function part(name, brep) {
  const pd = productDefinition(name);
  const rep = add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepString(name)},(${brep},${identity()}),${ctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${pd.shape},${rep})`);
  return { name, pd, rep };
}

function assembly(name, children) {
  const pd = productDefinition(name);
  const origin = identity();
  const rep = add(`SHAPE_REPRESENTATION(${stepString(name)},(${origin}),${ctx})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${pd.shape},${rep})`);
  for (const child of children) {
    nauoSerial += 1;
    const nauo = add(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE('NAUO${nauoSerial}',${stepString(child.name)},'',${pd.definition},${child.pd.definition},$)`
    );
    const nauoShape = add(`PRODUCT_DEFINITION_SHAPE('','',${nauo})`);
    const transform = add(`ITEM_DEFINED_TRANSFORMATION('','',${origin},${identity()})`);
    const relation = add(
      `( REPRESENTATION_RELATIONSHIP('','',${child.rep},${rep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${transform}) SHAPE_REPRESENTATION_RELATIONSHIP() )`
    );
    add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${relation},${nauoShape})`);
  }
  return { name, pd, rep };
}

// ---------- 装配内容（单位 mm） ----------
// 工位 1：CDJ2 圆形气缸，沿 +X 伸出；缸体 Ø20 × 90，活塞杆 Ø8 × 120（外露 30）。
const st1Cylinder = assembly('ST1_CYL_A1_CDJ2B16-50', [
  part('CDJ2B16-50_body', prism(0, [0, 100, 60], 90, 10)),
  part('CDJ2B16-50_rod', prism(0, [0, 100, 60], 120, 4))
]);
// 工位 1：MGN12 直线导轨 300 mm（沿 Y）+ 滑块 45 mm，滑块靠近 -Y 端。
const st1Rail = part('ST1_RAIL_MGN12_L300', box([200, 0, 0], [212, 300, 8]));
const st1Carriage = part('ST1_CARRIAGE_MGN12H', box([193, 5, 8], [219, 50, 18]));
const st1 = assembly('ST1_PRESS', [st1Cylinder, st1Rail, st1Carriage]);

// 工位 2：MSQ 旋转台，台面 Ø50 × 8，法向 +Z。
const st2Rotary = assembly('ST2_ROT_A1_MSQB20A', [
  part('MSQB20A_body', box([400, 0, 0], [460, 60, 30])),
  part('MSQB20A_table', prism(2, [430, 30, 30], 8, 25))
]);
// 工位 2：MHZ2-16D 平行夹爪，两指沿 X 开合。
const st2Gripper = assembly('ST2_GRIP_A2_MHZ2-16D', [
  part('MHZ2-16D_body', box([500, 0, 0], [530, 20, 40])),
  part('finger_L', box([502, 5, 40], [508, 15, 60])),
  part('finger_R', box([522, 5, 40], [528, 15, 60]))
]);
const st2 = assembly('ST2_PICK', [st2Rotary, st2Gripper]);

// 注意：occt-import-js 会把只含零件的子装配压平到上一级节点，所以叶子名自带型号；夹爪手指故意用通用名，
// 用来验证「同级相邻件归组」。
// 固定件：底板 + 伺服电机（应进入低置信度或被跳过）。
const basePlate = part('BASE_PLATE', box([-50, -50, -20], [650, 350, -10]));
const servo = part('伺服电机_400W', prism(2, [600, 250, -10], 80, 20));

assembly('KIN_DEMO_MACHINE', [st1, st2, basePlate, servo]);

const header = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('AutomationCAD kinematics auto-suggest fixture'),'2;1');",
  "FILE_NAME('kinematics-assembly.stp','2026-10-24T00:00:00',('AutomationCAD'),('AutomationCAD'),'gen-kinematics-fixture.mjs','AutomationCAD','');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
  'ENDSEC;',
  'DATA;'
];
const text = `${[...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')}\n`;
writeFileSync(output, text);
console.log(`已写入 ${output}（${text.length} 字节，${nextId - 1} 个实体）`);
