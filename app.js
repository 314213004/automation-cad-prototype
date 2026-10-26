/* ============================================================
   滑台气缸装配体 · 自动化设计工作台
   纯原生 JS：无依赖、无构建。等轴测 SVG 由投影函数实时生成。
   ============================================================ */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const debounce = (fn, ms) => {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/* ---------------------------------------------------------------- icons */
const ICON = {
  check:   `<svg viewBox="0 0 16 16" class="ico"><path d="M2.6 8.5l3.3 3.3L13.6 3.9"/></svg>`,
  alert:   `<svg viewBox="0 0 16 16" class="ico"><path d="M8 2.4l5.9 10.2H2.1z"/><path d="M8 6.3v3.1"/><circle cx="8" cy="11.2" r=".7" fill="currentColor" stroke="none"/></svg>`,
  info:    `<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.3"/><circle cx="8" cy="5.2" r=".7" fill="currentColor" stroke="none"/></svg>`,
  chevronR:`<svg viewBox="0 0 16 16" class="ico"><path d="M6 3.6L10.4 8 6 12.4"/></svg>`,
  undo:    `<svg viewBox="0 0 16 16" class="ico"><path d="M4 5.5v3.2h3.2"/><path d="M4 8.7a5 5 0 108.6-3.4"/></svg>`,
  fit:     `<svg viewBox="0 0 16 16" class="ico"><path d="M2.5 2.5h3.2M2.5 2.5v3.2M13.5 2.5h-3.2M13.5 2.5v3.2M2.5 13.5h3.2M2.5 13.5v-3.2M13.5 13.5h-3.2M13.5 13.5v-3.2"/></svg>`,
  cube:    `<svg viewBox="0 0 16 16" class="ico"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14"/></svg>`,
  folder:  `<svg viewBox="0 0 16 16" class="ico"><path d="M2 4.2h4l1.4 1.8H14v6.6H2z"/></svg>`,
  part:    `<svg viewBox="0 0 16 16" class="ico"><path d="M8 2.2l4.6 2.6v6.4L8 13.8 3.4 11.2V4.8z"/><path d="M3.4 4.8L8 7.4l4.6-2.6M8 7.4v6.4"/></svg>`,
  cylinder:`<svg viewBox="0 0 16 16" class="ico"><ellipse cx="8" cy="4" rx="4.2" ry="1.9"/><path d="M3.8 4v8M12.2 4v8"/><ellipse cx="8" cy="12" rx="4.2" ry="1.9"/></svg>`,
  search:  `<svg viewBox="0 0 16 16" class="ico"><circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3L14 14"/></svg>`,
  close:   `<svg viewBox="0 0 16 16" class="ico"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>`,
  sheet:   `<svg viewBox="0 0 16 16" class="ico"><path d="M3 2.4h7l3 3v8.2H3z"/><path d="M10 2.4v3h3M5.4 8.4h5.2M5.4 10.8h5.2"/></svg>`,
  calc:    `<svg viewBox="0 0 16 16" class="ico"><rect x="3" y="2.4" width="10" height="11.2" rx="1"/><path d="M5.4 5.4h5.2M5.6 8.4h.1M8 8.4h.1M10.4 8.4h.1M5.6 11h.1M8 11h.1M10.4 11h.1"/></svg>`,
  download:`<svg viewBox="0 0 16 16" class="ico"><path d="M8 2.4v7.2M5.2 7.2L8 10l2.8-2.8M2.6 12.6h10.8"/></svg>`,
  target:  `<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="5.4"/><circle cx="8" cy="8" r="1.6"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/></svg>`,
  wrench:  `<svg viewBox="0 0 16 16" class="ico"><path d="M10.6 2.6a3.4 3.4 0 00-3.3 4.5L2.6 11.8l1.6 1.6 4.7-4.7a3.4 3.4 0 004.5-3.3l-1.9 1.9-1.5-1.5z"/></svg>`,
  layers:  `<svg viewBox="0 0 16 16" class="ico"><path d="M8 2.2l5.6 2.9L8 8 2.4 5.1z"/><path d="M2.4 8.4L8 11.3l5.6-2.9M2.4 11.2L8 14.1l5.6-2.9"/></svg>`,
  more:    `<svg viewBox="0 0 16 16" class="ico"><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/></svg>`,
  sort:    `<svg viewBox="0 0 16 16" class="ico"><path d="M8 3.4v9.2M5.2 6.2L8 3.4l2.8 2.8"/></svg>`,
  dot:     `<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/></svg>`,
  eye:     `<svg viewBox="0 0 16 16" class="ico"><path d="M1.6 8S4 4.2 8 4.2 14.4 8 14.4 8 12 11.8 8 11.8 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.7"/></svg>`,
};

/* ---------------------------------------------------------------- state */
const state = {
  view: 'assembly',
  selNode: 'cyl',
  selectedPart: 'cyl',
  multi: [],
  hoverPart: null,
  hitPart: null,
  issueIdx: 0,
  treeOpen: {},
  values: {},
  undoStack: [],
  redoStack: [],
  lastEdit: null,
  insertedParts: [],
  constraints: [],
  ignoredConstraints: [],
  constraintSuggestions: {},
  insertSeq: 0,
};

const VIEW_MODE = { assembly: 'assembly', sizing: 'model', library: 'assembly', check: 'check', drafting: 'drafting' };

/* ---------------------------------------------------------------- 结构树 */
const TREE = [{
  id: 'root', label: '滑台气缸装配体', kind: 'asm', open: true, path: ['装配'],
  children: [{
    id: 'g-slide', label: '滑台模组 SLD-40', kind: 'grp', open: true, path: ['装配', '滑台'],
    children: [
      { id: 'base',     label: '底板 BASE-01',      kind: 'part', part: 'base',     meta: 'AL6061', short: '底板' },
      { id: 'rail',     label: '直线导轨 HGR15',    kind: 'part', part: 'rail',     meta: 'GCr15',  short: '导轨' },
      { id: 'carriage', label: '滑台 CAR-32',       kind: 'part', part: 'carriage', meta: 'AL6061', dof: '1', short: '滑台' },
      {
        id: 'g-cyl', label: '气缸组 MXQ20-50', kind: 'grp', open: true, part: 'cyl', dof: '2',
        path: ['装配', '滑台', '气缸'], short: '气缸',
        children: [
          { id: 'cyl',    label: '缸体 CYL-032',       kind: 'part', part: 'cyl',    meta: 'AL6061' },
          { id: 'rod',    label: '活塞杆 ROD-12',      kind: 'part', part: 'rod',    meta: 'SUS304', dof: '1' },
          { id: 'sensor', label: '磁性开关 D-M9B',     kind: 'part', part: 'sensor', meta: '—' },
        ],
      },
    ],
  }, {
    id: 'g-std', label: '标准件', kind: 'folder', open: false, meta: '12',
    path: ['装配', '标准件'],
    children: [
      { id: 'std1', label: '内六角螺钉 M4×12', kind: 'part', part: 'base', meta: '×8' },
      { id: 'std2', label: '圆柱销 φ4×16',      kind: 'part', part: 'rail', meta: '×2' },
      { id: 'std3', label: '气管接头 KQ2H06',   kind: 'part', part: 'cyl',  meta: '×2' },
    ],
  }],
}];

/* 节点 id → 层级路径（用于状态栏） */
const NODE_PATH = {};
(function walk(list, parents) {
  list.forEach(n => {
    const p = n.path || parents;
    NODE_PATH[n.id] = p;
    if (n.children) walk(n.children, p);
  });
})(TREE, ['装配']);

const COORDS = {
  base: [105, 36, 4], rail: [105, 36, 15], carriage: [92, 36, 33],
  cyl: [92, 36, 76], rod: [92, 36, 122], sensor: [93, 51, 68],
};

/* 场景占位体的粗略包围盒：用于为新插入件搜索空闲位置 */
const SCENE_OCCUPANCY = [
  [0, 0, 0, 210, 72, 8],
  [12, 24, 8, 198, 48, 22],
  [62, 20, 22, 122, 52, 44],
  [72, 16, 44, 112, 56, 51],
  [77.8, 21.8, 51, 106.2, 50.2, 107],
  [86.8, 30.8, 113, 97.2, 41.2, 122],
  [88, 50, 70, 98, 60, 82],
];

/* ---------------------------------------------------------------- 零件属性 */
const PARTS = {
  cyl: {
    name: '缸体', code: 'CYL-032-050', tag: '自制件',
    groups: [
      { title: '基本', fields: [
        { k: '型号', key: 'model', type: 'text', v: 'MXQ20-50A' },
        { k: '名称', v: '薄型气缸', ro: true },
        { k: '零件号', v: 'CYL-032-050', mono: true, ro: true },
      ] },
      { title: '几何参数', fields: [
        { k: '缸径', key: 'bore', type: 'num', unit: 'mm', v: 32 },
        { k: '行程', key: 'stroke', type: 'num', unit: 'mm', v: 50 },
        { k: '安装距', key: 'mount', type: 'num', unit: 'mm', v: 46 },
        { k: '总长', v: '—', id: 'pv-total', mono: true, unit: 'mm', ro: true },
      ] },
      { title: '材料与工艺', fields: [
        { k: '材料', key: 'material', type: 'select', v: 'al6061', options: [['al6061', '铝合金 6061-T6'], ['sus304', '不锈钢 SUS304'], ['al7075', '铝合金 7075-T6']] },
        { k: '表面处理', key: 'finish', type: 'select', v: 'anod', options: [['anod', '阳极氧化 黑'], ['ni', '化学镀镍'], ['none', '无']] },
        { k: '质量', v: '0.42', id: 'pv-mass', mono: true, unit: 'kg', ro: true },
      ] },
      { title: '装配关系', fields: [
        { k: '配合', key: 'fit', type: 'select', v: 'h7', options: [['h7', 'H7 / g6 间隙'], ['k6', 'K6 过渡'], ['n6', 'N6 过盈']] },
        { k: '数量', v: '1', mono: true, ro: true },
      ] },
    ],
  },
  carriage: {
    name: '滑台', code: 'CAR-32', tag: '自制件',
    groups: [
      { title: '基本', fields: [
        { k: '型号', key: 'model', type: 'text', v: 'CAR-32-01' },
        { k: '零件号', v: 'CAR-32', mono: true, ro: true },
      ] },
      { title: '几何参数', fields: [
        { k: '宽度', v: '60', mono: true, unit: 'mm', ro: true },
        { k: '长度', v: '58', mono: true, unit: 'mm', ro: true },
        { k: '厚度', v: '22', mono: true, unit: 'mm', ro: true },
        { k: '质量', v: '0.28', mono: true, unit: 'kg', ro: true },
      ] },
      { title: '装配关系', fields: [
        { k: '配合', key: 'fit', type: 'select', v: 'h7', options: [['h7', 'H7 / g6 间隙'], ['k6', 'K6 过渡']] },
        { k: '自由度', v: '1 沿 X 平移', mono: true, ro: true },
      ] },
    ],
  },
  rail: {
    name: '直线导轨', code: 'HGR15-400', tag: '外购件',
    groups: [
      { title: '基本', fields: [
        { k: '品牌', key: 'brand', type: 'select', v: 'hiwin', options: [['hiwin', 'HIWIN 上银'], ['thk', 'THK'], ['cpc', 'CPC']] },
        { k: '型号', v: 'HGR15R-400', mono: true, ro: true },
      ] },
      { title: '几何参数', fields: [
        { k: '公称宽度', v: '15', mono: true, unit: 'mm', ro: true },
        { k: '长度', v: '186', mono: true, unit: 'mm', ro: true },
        { k: '额定动载', v: '11.8', mono: true, unit: 'kN', ro: true },
      ] },
      { title: '材料与工艺', fields: [
        { k: '材料', v: 'GCr15 轴承钢', ro: true },
        { k: '精度等级', key: 'grade', type: 'select', v: 'p', options: [['n', 'N 普通'], ['h', 'H 高'], ['p', 'P 精密']] },
      ] },
    ],
  },
  base: {
    name: '底板', code: 'BASE-01', tag: '自制件',
    groups: [
      { title: '基本', fields: [
        { k: '零件号', v: 'BASE-01', mono: true, ro: true },
        { k: '数量', v: '1', mono: true, ro: true },
      ] },
      { title: '几何参数', fields: [
        { k: '长 × 宽', v: '210 × 72', mono: true, unit: 'mm', ro: true },
        { k: '厚度', v: '8', mono: true, unit: 'mm', ro: true },
        { k: '安装孔', v: '4 × M4', mono: true, ro: true },
        { k: '质量', v: '0.86', mono: true, unit: 'kg', ro: true },
      ] },
      { title: '材料与工艺', fields: [
        { k: '材料', key: 'material', type: 'select', v: 'al6061', options: [['al6061', '铝合金 6061-T6'], ['q235', 'Q235 钢']] },
        { k: '表面处理', v: '阳极氧化 黑', ro: true },
      ] },
    ],
  },
  rod: {
    name: '活塞杆', code: 'ROD-12', tag: '自制件',
    groups: [
      { title: '基本', fields: [
        { k: '零件号', v: 'ROD-12', mono: true, ro: true },
        { k: '数量', v: '1', mono: true, ro: true },
      ] },
      { title: '几何参数', fields: [
        { k: '杆径', v: '12', mono: true, unit: 'mm', ro: true },
        { k: '有效行程', v: '50', mono: true, unit: 'mm', ro: true },
        { k: '螺纹', v: 'M8 × 1.25', mono: true, ro: true },
      ] },
      { title: '材料与工艺', fields: [
        { k: '材料', v: '不锈钢 SUS304', ro: true },
        { k: '硬度', v: 'HRC 58', mono: true, ro: true },
      ] },
    ],
  },
  sensor: {
    name: '磁性开关', code: 'D-M9B', tag: '外购件',
    groups: [
      { title: '基本', fields: [
        { k: '品牌', key: 'brand', type: 'select', v: 'smc', options: [['smc', 'SMC'], ['festo', 'FESTO'], ['airtac', '亚德客']] },
        { k: '型号', v: 'D-M9B', mono: true, ro: true },
      ] },
      { title: '电气参数', fields: [
        { k: '类型', v: '2 线固态', ro: true },
        { k: '电压', v: 'DC 24V', mono: true, ro: true },
        { k: '线长', v: '0.5', mono: true, unit: 'm', ro: true },
      ] },
      { title: '装配关系', fields: [
        { k: '数量', v: '2', mono: true, ro: true },
        { k: '安装槽', v: '缸体侧面', ro: true },
      ] },
    ],
  },
};

/* 初始化可编辑值 */
Object.entries(PARTS).forEach(([pid, def]) => {
  state.values[pid] = {};
  def.groups.forEach(g => g.fields.forEach(f => { if (f.key) state.values[pid][f.key] = f.v; }));
});

/* ---------------------------------------------------------------- 干涉项 */
const ISSUES = [
  { sev: 'error',   part: 'cyl',      title: '气缸体 ↔ 滑台上盖', sub: '干涉量 2.40 mm · 静态', gap: 2.4, allow: 0, x: 57, y: 37, path: '装配 > 滑台 > 气缸 > 缸体' },
  { sev: 'error',   part: 'rod',      title: '活塞杆 ↔ 防护罩',   sub: '干涉量 1.10 mm · 运动', gap: 1.1, allow: 0, x: 60, y: 22, path: '装配 > 滑台 > 气缸 > 活塞杆' },
  { sev: 'warning', part: 'rail',     title: '导轨 ↔ 底板 壁厚',  sub: '最小壁厚 1.80 mm（要求 ≥2.0）', gap: 1.8, allow: 2.0, x: 46, y: 56, path: '装配 > 滑台 > 导轨' },
  { sev: 'warning', part: 'sensor',   title: '磁性开关 ↔ 拖链',   sub: '间隙 0.60 mm（要求 ≥1.0）', gap: 0.6, allow: 1.0, x: 63, y: 46, path: '装配 > 滑台 > 气缸 > 磁性开关' },
  { sev: 'info',    part: 'base',     title: '螺钉 M4×12 长度富余', sub: '旋合长度 3.20 mm', gap: 3.2, allow: 3.0, x: 34, y: 62, path: '装配 > 滑台 > 底板' },
  { sev: 'info',    part: 'carriage', title: '滑台 ↔ 限位块 间隙', sub: '间隙 3.20 mm', gap: 3.2, allow: 2.0, x: 52, y: 48, path: '装配 > 滑台 > 滑台' },
  { sev: 'error',   part: 'cyl',      title: '气缸 ↔ 传感器支架', sub: '干涉量 0.90 mm · 静态', gap: 0.9, allow: 0, x: 66, y: 40, path: '装配 > 滑台 > 气缸 > 缸体' },
];
const SEV_LABEL = { error: '严重', warning: '警告', info: '提示' };
const SEV_ICON = { error: 'alert', warning: 'alert', info: 'info' };

/* ---------------------------------------------------------------- 等轴测投影 */
const ISO_C = Math.cos(Math.PI / 6);
const ISO_S = 0.5;

const TONE = {
  base:  { t: '#3E444B', l: '#2B3035', r: '#343A41', e: '#1B1F23' },
  rail:  { t: '#4C535B', l: '#383E45', r: '#424A51', e: '#1D2226' },
  car:   { t: '#5E666F', l: '#454C54', r: '#515961', e: '#20252A' },
  steel: { t: '#6C757E', l: '#525A62', r: '#5F676F', e: '#20252A' },
  dark:  { t: '#3A4046', l: '#292E33', r: '#31363B', e: '#191D21' },
  plate: { t: '#565E67', l: '#3F464D', r: '#495059', e: '#1B1F23' },
};

/* 立方体：可见面 x=max / y=max / z=max */
function box(x0, y0, z0, x1, y1, z1, tone) {
  const c = TONE[tone] || TONE.car;
  const e = `fill-rule="evenodd" stroke="${c.e}" stroke-width=".8" stroke-linejoin="round"`;
  return [
    poly2([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], `fill="${c.l}" ${e}`),
    poly2([[x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0]], `fill="${c.r}" ${e}`),
    poly2([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], `fill="${c.t}" ${e}`),
  ].join('');
}
/* 独立于 buildScene 的轻量投影（用于 box/ellipse 辅助函数） */
let CUR = null;
function poly2(list, attrs) { return CUR.poly(list, attrs); }
function boxSil(x0, y0, z0, x1, y1, z1) {
  const pts = [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y1, z1]];
  return 'M' + pts.map(p => { const q = CUR.P(p[0], p[1], p[2]); return q[0].toFixed(1) + ' ' + q[1].toFixed(1); }).join('L') + 'Z';
}
function ellipse(cx, cy, z, r, fill) {
  const ccx = (cx - cy) * ISO_C, ccy = (cx + cy) * ISO_S - z;
  const rx = r * 1.2247, ry = r * 0.7071;
  CUR.reg(ccx - rx, ccy); CUR.reg(ccx + rx, ccy); CUR.reg(ccx, ccy - ry); CUR.reg(ccx, ccy + ry);
  return `<ellipse cx="${ccx.toFixed(1)}" cy="${ccy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"
    fill="${fill}" stroke="#1B1F23" vector-effect="non-scaling-stroke" stroke-width=".8"/>`;
}
function cylShape(cx, cy, z0, z1, r, grad, capGrad) {
  const ccx = (cx - cy) * ISO_C, ccy = (cx + cy) * ISO_S;
  const rx = r * 1.2247, ry = r * 0.7071;
  CUR.reg(ccx - rx, ccy - z1); CUR.reg(ccx + rx, ccy - z1);
  CUR.reg(ccx - rx, ccy - z0); CUR.reg(ccx + rx, ccy - z0);
  CUR.reg(ccx, ccy - z1 - ry); CUR.reg(ccx, ccy - z0 + ry);
  const f = n => n.toFixed(1);
  const y0 = ccy - z0, y1 = ccy - z1;
  const bottom = '';
  const body = `<path d="M${f(ccx - rx)},${f(y0)} L${f(ccx - rx)},${f(y1)} A${f(rx)},${f(ry)} 0 0 1 ${f(ccx + rx)},${f(y1)} L${f(ccx + rx)},${f(y0)} A${f(rx)},${f(ry)} 0 0 1 ${f(ccx - rx)},${f(y0)}Z"
    fill="url(#${grad})" stroke="#1B1F23" vector-effect="non-scaling-stroke" stroke-width=".8"/>`;
  const top = `<ellipse cx="${f(ccx)}" cy="${f(y1)}" rx="${f(rx)}" ry="${f(ry)}" fill="url(#${grad === 'gRod' ? 'gSteel' : capGrad})" stroke="#1B1F23" vector-effect="non-scaling-stroke" stroke-width=".8"/>`;
  return bottom + body + top;
}
function cylSil(cx, cy, z0, z1, r) {
  const ccx = (cx - cy) * ISO_C, ccy = (cx + cy) * ISO_S;
  const rx = r * 1.2247, ry = r * 0.7071;
  const y0 = ccy - z0, y1 = ccy - z1;
  const f = n => n.toFixed(1);
  return `M${f(ccx - rx)},${f(y1)} L${f(ccx - rx)},${f(y0)} A${f(rx)},${f(ry)} 0 0 0 ${f(ccx + rx)},${f(y0)} L${f(ccx + rx)},${f(y1)} A${f(rx)},${f(ry)} 0 0 1 ${f(ccx - rx)},${f(y1)}Z`;
}
function part(id, svg, sil) { return { id, svg, sil }; }

/* 构建等轴测场景：返回 {svg, viewBox} */
function buildScene(cfg) {
  cfg = cfg || {};
  const bore = clamp(Number(cfg.bore) || 32, 12, 63);
  const stroke = clamp(Number(cfg.stroke) || 50, 10, 200);
  const section = !!cfg.section;

  let X0 = 1e9, Y0 = 1e9, X1 = -1e9, Y1 = -1e9;
  let track = false;
  const reg = (x, y) => {
    if (!track) return;
    if (x < X0) X0 = x; if (x > X1) X1 = x;
    if (y < Y0) Y0 = y; if (y > Y1) Y1 = y;
  };
  const f = n => (Math.round(n * 10) / 10).toString();
  const P = (x, y, z) => { const sx = (x - y) * ISO_C, sy = (x + y) * ISO_S - z; reg(sx, sy); return [sx, sy]; };
  const pp = (x, y, z) => { const p = P(x, y, z); return f(p[0]) + ',' + f(p[1]); };
  const NS = 'vector-effect="non-scaling-stroke"';
  const poly = (list, attrs) => `<polygon points="${list.map(p => pp(p[0], p[1], p[2])).join(' ')}" ${NS} ${attrs}/>`;
  const line = (a, b, attrs) => {
    const p1 = P(a[0], a[1], a[2]), p2 = P(b[0], b[1], b[2]);
    return `<line x1="${f(p1[0])}" y1="${f(p1[1])}" x2="${f(p2[0])}" y2="${f(p2[1])}" ${NS} ${attrs}/>`;
  };
  CUR = { P, reg, poly, pp };

  /* 地面网格 */
  let grid = '';
  const gx0 = -48, gx1 = 258, gy0 = -40, gy1 = 112, step = 16;
  for (let x = gx0; x <= gx1; x += step) {
    const major = ((x - gx0) / step) % 4 === 0;
    grid += line([x, gy0, 0], [x, gy1, 0], major ? 'stroke="#474E55" stroke-width="1"' : 'stroke="#393F45" stroke-width=".7"');
  }
  for (let y = gy0; y <= gy1; y += step) {
    const major = ((y - gy0) / step) % 4 === 0;
    grid += line([gx0, y, 0], [gx1, y, 0], major ? 'stroke="#474E55" stroke-width="1"' : 'stroke="#393F45" stroke-width=".7"');
  }

  track = true;

  const r = 4 + bore * 0.32;
  const cyx = 92, cyy = 36;
  const flangeTop = 51;
  const bodyTop = flangeTop + 56;
  const rodTop = bodyTop + 16 + stroke * 0.12;
  const rodR = Math.max(3.2, r * 0.34);
  const parts = [];

  /* 底板 */
  let s = box(0, 0, 0, 210, 72, 8, 'base');
  [[18, 14], [192, 14], [18, 58], [192, 58]].forEach(([hx, hy]) => { s += ellipse(hx, hy, 8, 3.2, '#23272C'); });
  parts.push(part('base', s, boxSil(0, 0, 0, 210, 72, 8)));

  /* 导轨 */
  s = box(12, 24, 8, 198, 48, 22, 'rail');
  s += line([16, 30, 22.1], [194, 30, 22.1], 'stroke="#2F353B" stroke-width=".8"');
  s += line([16, 42, 22.1], [194, 42, 22.1], 'stroke="#2F353B" stroke-width=".8"');
  s += line([16, 36, 22.1], [194, 36, 22.1], 'stroke="#5E666E" stroke-width=".6"');
  parts.push(part('rail', s, boxSil(12, 24, 8, 198, 48, 22)));

  /* 滑台 */
  s = box(62, 20, 22, 122, 52, 44, 'car');
  s += line([66, 26, 44.1], [118, 26, 44.1], 'stroke="#3A4047" stroke-width=".7"');
  s += line([66, 46, 44.1], [118, 46, 44.1], 'stroke="#3A4047" stroke-width=".7"');
  s += ellipse(92, 36, 44.1, 3.6, '#2C3136');
  parts.push(part('carriage', s, boxSil(62, 20, 22, 122, 52, 44)));

  /* 气缸 */
  s = box(cyx - 20, cyy - 20, 44, cyx + 20, cyy + 20, flangeTop, 'plate');
  s += cylShape(cyx, cyy, flangeTop, bodyTop, r, 'gCyl', 'gCap');
  s += cylShape(cyx, cyy, bodyTop, bodyTop + 6, r * 0.86, 'gCap', 'gSteel');
  parts.push(part('cyl', s, cylSil(cyx, cyy, flangeTop, bodyTop, r)));

  /* 活塞杆 */
  s = cylShape(cyx, cyy, bodyTop + 6, rodTop, rodR, 'gRod', 'gSteel');
  parts.push(part('rod', s, cylSil(cyx, cyy, bodyTop + 6, rodTop, rodR)));

  /* 磁性开关 */
  s = box(cyx - 4, cyy + r - 3, 70, cyx + 6, cyy + r + 4, 82, 'dark');
  parts.push(part('sensor', s, boxSil(cyx - 4, cyy + r - 3, 70, cyx + 6, cyy + r + 4, 82)));

  /* 从标准件库插入的占位体 */
  (state.insertedParts || []).forEach(p => {
    s = box(p.x, p.y, p.z, p.x + p.w, p.y + p.d, p.z + p.h, p.tone || 'steel');
    parts.push(part(p.id, s, boxSil(p.x, p.y, p.z, p.x + p.w, p.y + p.d, p.z + p.h)));
  });

  let planeBack = '', planeFront = '';
  if (section) {
    const px = 92;
    const a = P(px, -6, 0), b = P(px, 82, 0), c = P(px, 82, 146), d = P(px, -6, 146);
    const pts = [a, b, c, d].map(p => f(p[0]) + ',' + f(p[1])).join(' ');
    planeBack = `<polygon points="${pts}" fill="rgba(78,156,245,.085)"/>`;
    planeFront = `<polygon points="${pts}" fill="none" stroke="rgba(78,156,245,.55)" stroke-dasharray="4 5" ${NS} stroke-width="1"/>
      <text x="${f(d[0] - 12)}" y="${f(d[1] + 4)}" font-size="11" fill="#6FA8F0" font-family="monospace">A</text>
      <text x="${f(b[0] + 6)}" y="${f(b[1] - 2)}" font-size="11" fill="#6FA8F0" font-family="monospace">A</text>`;
  }

  const pad = 26;
  const vx = X0 - pad, vy = Y0 - pad, vw = (X1 - X0) + pad * 2, vh = (Y1 - Y0) + pad * 2;
  const outlines = parts.map(p => `<path class="outline-path" data-outline="${p.id}" d="${p.sil}"/>`).join('');
  const body = parts.map(p => `<g class="part" data-part="${p.id}">${p.svg}<path class="hitwash" d="${p.sil}"/></g>`).join('');

  const svg = `
    <defs>
      <linearGradient id="gCyl" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#454B52"/><stop offset=".22" stop-color="#78818B"/>
        <stop offset=".42" stop-color="#8B949E"/><stop offset=".72" stop-color="#626A73"/>
        <stop offset="1" stop-color="#3D4349"/>
      </linearGradient>
      <linearGradient id="gRod" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4C535B"/><stop offset=".35" stop-color="#A7B0B9"/>
        <stop offset=".62" stop-color="#8B949D"/><stop offset="1" stop-color="#454C53"/>
      </linearGradient>
      <linearGradient id="gCap" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#3C4248"/><stop offset=".45" stop-color="#7A838D"/>
        <stop offset="1" stop-color="#3A4046"/>
      </linearGradient>
      <linearGradient id="gSteel" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#525A62"/><stop offset=".5" stop-color="#8C959E"/>
        <stop offset="1" stop-color="#4F575F"/>
      </linearGradient>
    </defs>
    <g>${grid}</g>
    ${planeBack}
    ${body}
    ${planeFront}
    <g class="outline-layer">${outlines}</g>`;

  return { svg, viewBox: `${f(vx)} ${f(vy)} ${f(vw)} ${f(vh)}` };
}

/* ---------------------------------------------------------------- 面板渲染 */
function tabsHTML(active) {
  const items = [['assembly', '结构树'], ['sizing', '选型'], ['library', '标准件库']];
  const dim = state.view === 'check' || state.view === 'drafting';
  return `<div class="tabs" role="tablist" aria-label="左栏视图">` + items.map(([v, l]) =>
    `<button type="button" class="tab ${active === v ? 'is-active' : ''} ${dim ? 'is-dim' : ''}"
      data-tab="${v}" role="tab" aria-selected="${active === v}" title="${dim ? '返回装配工作台' : l}">${l}</button>`
  ).join('') + `</div>`;
}

/* ---- 结构树 ---- */
function treeHTML() {
  const rows = [];
  const walk = (list, depth) => {
    list.forEach(n => {
      const kids = n.children || [];
      const open = state.treeOpen[n.id] !== undefined ? state.treeOpen[n.id] : n.open !== false;
      const icon = (n.kind === 'part') ? (n.part === 'cyl' || n.part === 'rod' ? 'cylinder' : 'part') : 'folder';
      rows.push(`<div class="tree-row ${state.selNode === n.id ? 'is-sel' : ''} ${open ? 'is-open' : ''}"
          data-node="${n.id}" data-part="${n.part || ''}" style="padding-left:${8 + depth * 16}px" role="treeitem">
          <span class="tw ${kids.length ? '' : 'empty'}" data-tw="${n.id}">${ICON.chevronR}</span>
          <span class="pt-ico">${ICON[icon]}</span>
          <span class="lbl">${n.label}</span>
          ${n.dof ? `<span class="dof" title="自由度 ${n.dof}">${n.dof}</span>` : ''}
          ${n.meta ? `<span class="meta">${n.meta}</span>` : ''}
        </div>`);
      if (kids.length && open) walk(kids, depth + 1);
    });
  };
  walk(TREE, 0);
  return `<div class="tree" role="tree">${rows.join('')}</div>`;
}

function getDofTotal() {
  let total = 0;
  (function walk(list) {
    list.forEach(n => {
      total += Math.max(0, Number(n.dof) || 0);
      if (n.children) walk(n.children);
    });
  })(TREE);
  return total;
}

function countAssemblyParts() {
  let count = 0;
  (function walk(list, inStd) {
    list.forEach(n => {
      const std = inStd || n.id === 'g-std';
      const legacyStd = std && n.kind === 'part' && !String(n.id).startsWith('ins');
      if (n.kind === 'part' && !legacyStd) count += 1;
      if (n.children) walk(n.children, std);
    });
  })(TREE, false);
  return count;
}

function updateAssemblyCounters() {
  const parts = $('#assemblyPartCount');
  if (parts) parts.textContent = `${countAssemblyParts()} 零件 · 3 子装配`;
  const dof = $('#dofTotal');
  if (dof) dof.textContent = getDofTotal();
}

/* ---- 属性字段 ---- */
function fieldHTML(pid, f) {
  if (f.type === 'select') {
    return `<div class="field"><label>${f.k}</label>
      <span class="sel"><select class="ctl" data-field="${f.key}" data-part="${pid}">
        ${f.options.map(o => `<option value="${o[0]}" ${String(state.values[pid][f.key]) === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
      </select></span></div>`;
  }
  if (f.type === 'text' || f.type === 'num') {
    const val = state.values[pid][f.key];
    return `<div class="field"><label>${f.k}</label>
      <span class="ctlr"><input class="ctl mono" type="${f.type}" value="${val}"
        data-field="${f.key}" data-part="${pid}" spellcheck="false">
        ${f.unit ? `<i class="suffix">${f.unit}</i>` : ''}</span></div>`;
  }
  return `<div class="field"><label>${f.k}</label>
    <div class="ctl-ro mono" ${f.id ? `id="${f.id}"` : ''}>${f.v}${f.unit ? ` <i class="ro-unit">${f.unit}</i>` : ''}</div></div>`;
}

function propsHTML(pid) {
  const def = PARTS[pid];
  if (!def) return `<div class="hint-inline">所选为文件夹，包含多个零件。请在结构树中选择具体零件。</div>`;
  return def.groups.map((g, i) => `
    <section class="pgroup ${i > 2 ? 'is-collapsed' : ''}" data-pgroup>
      <button type="button" class="pgroup-head" data-pgroup-head>${g.title}
        <svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg>
      </button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">
        ${g.fields.map(f => fieldHTML(pid, f)).join('')}
      </div></div></div>
    </section>`).join('');
}

function leftHTML(view) {
  if (view === 'assembly') {
    return tabsHTML('assembly') + `
      <div class="panel-head">
        <span class="ph-title">结构树</span>
        <span class="ph-count" id="assemblyPartCount">${countAssemblyParts()} 零件 · 3 子装配</span>
        <div class="ph-actions">
          <button class="iconbtn" type="button" title="全部展开" data-tree-open>${ICON.layers}</button>
          <button class="iconbtn" type="button" title="更多">${ICON.more}</button>
        </div>
      </div>
      <div class="panel-body">${treeHTML()}</div>
      <div class="panel-foot" style="display:flex;align-items:center;gap:6px">
        <span class="mono" style="font-size:10px;color:var(--text-3)">DOF 合计 <b id="dofTotal">${getDofTotal()}</b></span>
        <span style="flex:1"></span>
        <button class="btn" type="button" data-act="fit" style="height:24px">${ICON.fit}缩放到适合</button>
      </div>`;
  }
  if (view === 'sizing') {
    return tabsHTML('sizing') + `
      <div class="panel-head"><span class="ph-title">工况参数</span><span class="ph-count">6 项必填</span></div>
      <div class="panel-body">
        <div class="form">
          <div class="field"><label>负载质量</label><span class="ctlr"><input class="ctl mono" type="number" data-sizing="mass" value="2.5"><i class="suffix">kg</i></span></div>
          <div class="field"><label>安装姿态</label><span class="sel"><select class="ctl" data-sizing="pose">
            <option value="h">水平</option><option value="v">垂直</option><option value="i">侧装</option></select></span></div>
          <div class="field"><label>最大加速度</label><span class="ctlr"><input class="ctl mono" type="number" data-sizing="accel" value="20"><i class="suffix">m/s²</i></span></div>
          <div class="field"><label>摩擦系数</label><span class="ctlr"><input class="ctl mono" type="number" step="0.05" data-sizing="mu" value="0.2"></span></div>
          <div class="field"><label>安全系数</label><span class="ctlr"><input class="ctl mono" type="number" step="0.1" data-sizing="safety" value="1.5"></span></div>
          <div class="field"><label>气源压力</label><span class="ctlr"><input class="ctl mono" type="number" step="0.05" data-sizing="pressure" value="0.6"><i class="suffix">MPa</i></span></div>
          <div class="field"><label>推荐行程</label><span class="ctlr"><input class="ctl mono" type="number" data-sizing="stroke" value="50"><i class="suffix">mm</i></span></div>
          <div class="field"><label>动作频率</label><span class="ctlr"><input class="ctl mono" type="number" data-sizing="freq" value="30"><i class="suffix">cpm</i></span></div>
        </div>
        <div class="hint-inline">修改任一参数，中央估算结果与右侧推荐型号将实时刷新（防抖 150ms）。</div>
      </div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="calc">重新估算</button></div>`;
  }
  if (view === 'library') {
    return tabsHTML('library') + `
      <div class="panel-head"><span class="ph-title">品牌 / 品类</span><span class="ph-count">1,284</span></div>
      <div class="panel-body">
        <div class="sec-title" style="padding-top:10px">最近使用<span class="n">3</span></div>
        ${['MXQ20-32-50', 'HGR15R-400', 'D-M9B'].map(m2 => `
          <div class="cat-row" data-lib="${m2}" style="padding-left:10px">${ICON.clock || ICON.cube}<span class="mono" style="font-size:11px">${m2}</span></div>`).join('')}
        <div class="sec-title" style="padding-top:10px">品牌<span class="n">4</span></div>
        ${['FESTO 费斯托|386|气缸|导轨|阀岛', 'SMC|512|气缸|滑台|传感器', '亚德客 AirTAC|268|气缸|接头|导轨', '米思米 MISUMI|118|支座|螺钉|导向轴'].map((b, bi) => {
          const [name, n, ...cats] = b.split('|');
          return `<div class="brand-row" data-brand="${name}">${ICON.folder}<span>${name}</span><span class="n">${n}</span></div>
            ${cats.map((c, ci) => `<div class="cat-row ${bi === 1 && ci === 0 ? 'is-sel' : ''}" data-cat="${c}"
                style="padding-left:28px">${ICON.cube}<span>${c}</span></div>`).join('')}`;
        }).join('')}
      </div>
      <div class="panel-foot"><button class="btn btn-block" type="button" data-act="sync">${ICON.download}同步品牌索引</button></div>`;
  }
  if (view === 'check') {
    const counts = { error: 0, warning: 0, info: 0 };
    ISSUES.forEach(i => counts[i.sev]++);
    return tabsHTML(null) + `
      <div class="panel-head"><span class="ph-title">校核结果</span><span class="ph-count">${ISSUES.length} 处</span></div>
      <div class="check-sum">
        <span class="chip-count" data-sev="error"><span class="dot"></span>${counts.error}</span>
        <span class="chip-count" data-sev="warning"><span class="dot"></span>${counts.warning}</span>
        <span class="chip-count" data-sev="info"><span class="dot"></span>${counts.info}</span>
        <span style="flex:1"></span>
        <span class="mono" style="font-size:10px;color:var(--text-3)">间隙/干涉</span>
      </div>
      <div class="panel-body">${ISSUES.map((i, idx) => `
        <button class="issue ${idx === state.issueIdx ? 'is-sel' : ''}" data-issue="${idx}" data-sev="${i.sev}" type="button">
          <span class="mark"></span>
          <span class="txt">
            <span class="tt"><span class="sev">${SEV_LABEL[i.sev]}</span>${i.title}<span class="idx">${String(idx + 1).padStart(2, '0')}</span></span>
            <span class="dd">${i.sub}</span>
          </span>
        </button>`).join('')}</div>
      <div class="panel-foot" style="display:flex;gap:6px">
        <button class="btn" type="button" data-act="prev" style="flex:1">上一处</button>
        <button class="btn" type="button" data-act="next" style="flex:1">下一处</button>
      </div>`;
  }
  /* drafting */
  return tabsHTML(null) + `
    <div class="panel-head"><span class="ph-title">图纸</span><span class="ph-count">3 视图</span></div>
    <div class="panel-body">
      <div class="sec-title">图纸目录<span class="n">A2</span></div>
      ${['ASM-001 装配图|1:2|当前', 'CYL-032 缸体零件图|1:1|', 'CAR-32 滑台零件图|1:1|'].map((r, i) => {
        const [n, s, cur] = r.split('|');
        return `<div class="cat-row ${i === 0 ? 'is-sel' : ''}" style="padding-left:10px">${ICON.sheet}<span>${n}</span><span class="meta" style="margin-left:auto;font-family:var(--font-mono);font-size:10px;color:var(--text-3)">${s}</span></div>`;
      }).join('')}
      <div class="sec-title">视图<span class="n">3</span></div>
      ${['主视图（前视）', '剖视图 A-A', '侧视图'].map((v, i) => `
        <div class="tree-row ${i === 0 ? 'is-sel' : ''}" style="padding-left:14px">${ICON.eye}<span class="lbl">${v}</span></div>`).join('')}
      <div class="sec-title">图层<span class="n">4</span></div>
      ${[['轮廓线', '#E6E9EC'], ['中心线', '#6E777F'], ['尺寸标注', '#4E9CF5'], ['剖面线', '#A8B0B8']].map(([n, c]) => `
        <div class="spec-row"><span class="k" style="width:auto">${n}</span><span class="v" style="color:${c}">━ ━ ━</span></div>`).join('')}
      <div class="hint-inline">图框 A2 · 594 × 420 mm · 比例 1:2 · 第三角投影</div>
    </div>
    <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="export">${ICON.download}导出 PDF</button></div>`;
}

function rightHTML(view) {
  if (view === 'assembly') {
    const pid = state.selectedPart;
    const def = PARTS[pid];
    return `<div class="panel-head"><span class="ph-title">属性</span>
        <span class="ph-count">${state.multi.length ? state.multi.length + ' 个对象' : '1 个对象'}</span>
        <div class="ph-actions"><button class="iconbtn" type="button" title="更多">${ICON.more}</button></div>
      </div>
      ${constraintCardHTML(pid)}
      ${def ? `<div class="props-head">
        <div class="ph-row"><span class="name">${def.name}</span><span class="chip">已选中</span></div>
        <div class="sub">${def.code} · ${def.tag}</div>
      </div>` : ''}
      <div class="panel-body">${propsHTML(pid)}</div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="apply">应用到同系列零件</button></div>`;
  }
  if (view === 'sizing') {
    const r = sizingCalc(state.sizing);
    return `<div class="panel-head"><span class="ph-title">推荐型号</span><span class="ph-count">${r.recos.length} 个</span></div>
      <div class="panel-body">
        <div class="reco-list">${r.recos.map((x, i) => `
          <button class="reco ${i === 0 ? 'is-sel' : ''}" type="button" data-reco="${i}">
            <div class="r1"><span class="pn">${x.model}</span><span class="pct">${x.match}%</span></div>
            <div class="r2"><span>${x.brand}</span><span class="sep">|</span><span>推力 ${x.force} N</span><span class="sep">|</span><span>寿命 ${x.life} km</span></div>
          </button>`).join('')}</div>
        <div class="hint-inline">按负载率 ≤ 30% 与寿命目标排序，点击型号可直接写入装配属性。</div>
        <div class="sec-title">选型摘要<span class="n">实时</span></div>
        <dl class="kv" style="padding:0 10px 10px">
          <dt>需求推力</dt><dd>${r.force} N</dd>
          <dt>推荐缸径</dt><dd>φ${r.rec} mm</dd>
          <dt>目标寿命</dt><dd>${r.life} km</dd>
          <dt>负载率</dt><dd>${(r.ratio * 100).toFixed(0)} %</dd>
          <dt>工况</dt><dd>${state.sizing.pose === 'h' ? '水平' : state.sizing.pose === 'v' ? '垂直' : '侧装'} / ${state.sizing.freq} cpm</dd>
        </dl>
      </div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="apply-reco">应用 ${r.recos[0].model}</button></div>`;
  }
  if (view === 'library') {
    const m = state.libSel;
    const base = m.model.includes('-') ? m.model.split('-').slice(0, -1).join('-') : m.model;
    return `<div class="panel-head"><span class="ph-title">规格预览</span><span class="ph-count">${m.model}</span>
        <div class="ph-actions"><button class="iconbtn" type="button" title="在库中查看">${ICON.eye}</button></div></div>
      <div class="preview-thumb">${thumbCyl()}</div>
      <div class="panel-body">
        <div class="spec-list">
          <div class="spec-row hl"><span class="k">型号</span><span class="v">${m.model}</span></div>
          <div class="spec-row"><span class="k">品牌</span><span class="v">${m.brand}</span></div>
          <div class="spec-row"><span class="k">品类</span><span class="v">${m.cat}</span></div>
          <div class="spec-row"><span class="k">缸径</span><span class="v">φ${m.bore} mm</span></div>
          <div class="spec-row"><span class="k">行程</span><span class="v">${m.stroke} mm</span></div>
          <div class="spec-row"><span class="k">接口</span><span class="v">${m.port}</span></div>
          <div class="spec-row"><span class="k">工作压力</span><span class="v">0.1 – 1.0 MPa</span></div>
          <div class="spec-row"><span class="k">重复精度</span><span class="v">±0.02 mm</span></div>
          <div class="spec-row"><span class="k">单价</span><span class="v">¥ ${m.price}</span></div>
          <div class="spec-row"><span class="k">库存</span><span class="v" style="color:var(--success)">${m.stock} 件</span></div>
        </div>
        <div class="hint-inline">插入后将自动匹配滑台安装孔位（4 × M4，孔距 40 mm）。</div>
        <div class="sec-title">同系列规格<span class="n">4</span></div>
        <table class="tbl tbl-xs" style="table-layout:fixed">
          <colgroup><col style="width:106px"><col style="width:42px"><col style="width:62px"><col style="width:46px"></colgroup>
          <thead><tr><th>型号</th><th class="num">行程</th><th class="num">单价</th><th class="num">库存</th></tr></thead>
          <tbody>
            <tr class="is-sel"><td class="mono">${m.model}</td><td class="num">${m.stroke}</td><td class="num">${m.price.toFixed(2)}</td><td class="num">${m.stock}</td></tr>
            <tr><td class="mono">${base}-75</td><td class="num">75</td><td class="num">${(m.price * 1.12).toFixed(2)}</td><td class="num">12</td></tr>
            <tr><td class="mono">${base}-100</td><td class="num">100</td><td class="num">${(m.price * 1.26).toFixed(2)}</td><td class="num">6</td></tr>
            <tr><td class="mono">${base}-125</td><td class="num">125</td><td class="num">${(m.price * 1.41).toFixed(2)}</td><td class="num">4</td></tr>
          </tbody>
        </table>
      </div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="insert">${ICON.part}插入到装配</button></div>`;
  }
  if (view === 'check') {
    const it = ISSUES[state.issueIdx];
    const pct = it.allow > 0 ? clamp(it.gap / it.allow * 100, 6, 100) : 100;
    return `<div class="panel-head"><span class="ph-title">冲突详情</span><span class="ph-count">${state.issueIdx + 1} / ${ISSUES.length}</span></div>
      <div class="panel-body">
        <div class="detail">
          <h4>${it.title}</h4>
          <div class="path">${it.path}</div>
          <div class="meter">
            <div class="mh"><span>${it.allow > 0 ? '实测间隙' : '干涉量'}</span><b>${it.gap.toFixed(2)} mm</b></div>
            <div class="track"><i style="width:${pct}%;background:${it.sev === 'info' ? 'var(--info)' : it.sev === 'warning' ? 'var(--warning)' : 'var(--error)'}"></i><em style="left:${100}%"></em></div>
          </div>
          <dl class="kv">
            <dt>判定</dt><dd style="color:${it.sev === 'error' ? 'var(--error)' : it.sev === 'warning' ? 'var(--warning)' : 'var(--info)'}">${SEV_LABEL[it.sev]}</dd>
            <dt>${it.allow > 0 ? '要求值' : '允许值'}</dt><dd>${it.allow > 0 ? '≥ ' + it.allow.toFixed(2) : '0.00'} mm</dd>
            <dt>检测方式</dt><dd>静态 / 扫掠</dd>
            <dt>对象</dt><dd>${it.part.toUpperCase()}</dd>
          </dl>
          <div class="sec-title" style="padding-left:0">建议修改</div>
          <div class="fix-list">
            <button class="fix" type="button" data-act="fix">${ICON.wrench}<span><span class="t">增大安装距 3 mm</span><span class="d">预计消解 2.4 mm 干涉，需复核行程</span></span></button>
            <button class="fix" type="button" data-act="fix">${ICON.wrench}<span><span class="t">上移滑台 2 mm</span><span class="d">影响导轨安装面，需重算平面度</span></span></button>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn" type="button" data-act="ignore" style="flex:1">忽略此项</button>
            <button class="btn" type="button" data-act="locate" style="flex:1">${ICON.target}定位</button>
          </div>
        </div>
      </div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="rerun">重新运行校核</button></div>`;
  }
  /* BOM */
  const bom = BOM;
  return `<div class="panel-head"><span class="ph-title">BOM 明细表</span><span class="ph-count">${bom.length} 项</span>
      <div class="ph-actions"><button class="iconbtn" type="button" title="导出">${ICON.download}</button></div></div>
    <div class="panel-body" style="padding-top:0">
      <table class="tbl tbl-sm" style="table-layout:fixed">
        <colgroup><col style="width:26px"><col style="width:66px"><col style="width:104px"><col style="width:28px"><col style="width:72px"></colgroup>
        <thead><tr><th>序号</th><th>名称</th><th>规格</th><th class="num">数量</th><th>材料</th></tr></thead>
        <tbody>${bom.map((b, i) => `<tr>
          <td class="num dim">${b.no}</td><td>${b.name}</td>
          <td class="mono dim" title="${b.spec}">${b.spec}</td>
          <td class="num">${b.qty}</td><td class="dim">${b.mat}</td></tr>`).join('')}</tbody>
      </table>
      <div class="hint-inline">合计 7 项 · 15 件 · 总质量 2.86 kg（不含标准件）</div>
    </div>
    <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-act="export">${ICON.download}导出 BOM (CSV)</button></div>`;
}

/* ---------------------------------------------------------------- 2. 选型计算逻辑 */
state.sizing = { mass: 2.5, accel: 20, mu: 0.2, safety: 1.5, pressure: 0.6, stroke: 50, freq: 30, pose: 'h' };

function sizingCalc(p) {
  const force = p.mass * (9.81 * p.mu + p.accel) * p.safety;       // 默认 82.4 N
  const bores = [16, 20, 25, 32, 40, 50, 63];
  let rec = 63;
  for (const d of bores) {
    const area = Math.PI * d * d / 4;
    const avail = p.pressure * area * 0.85;
    if (force / avail <= 0.30) { rec = d; break; }
  }
  const life = 4200
    * Math.pow(rec / 32, 1.8)
    * Math.pow(p.pressure / 0.6, 0.8)
    * Math.pow(2.5 / Math.max(0.2, p.mass), 1.1)
    * Math.pow(50 / Math.max(5, p.stroke), 0.4);
  const avail = p.pressure * Math.PI * rec * rec / 4 * 0.85;
  const ratio = force / avail;
  return {
    force: Math.round(force),
    life: Math.round(life / 10) * 10,
    rec,
    ratio,
    avail: Math.round(avail),
    recos: [
      { model: 'MXQ20-32-50', brand: 'SMC', force: Math.round(avail), life: Math.round(life / 10) * 10, match: 96 },
      { model: 'ADN-32-50-A-P-A', brand: 'FESTO', force: Math.round(avail * 0.98), life: Math.round(life * 0.97 / 10) * 10, match: 92 },
      { model: `SDA${rec}×${Math.round(p.stroke)}`, brand: '亚德客', force: Math.round(avail * 0.94), life: Math.round(life * 0.92 / 10) * 10, match: 88 },
      { model: `CDQ2B${rec}-${Math.round(p.stroke)}DZ`, brand: 'SMC', force: Math.round(avail * 0.9), life: Math.round(life * 0.86 / 10) * 10, match: 84 },
      { model: `DFM-${rec}-${Math.round(p.stroke)}-P-A`, brand: 'FESTO', force: Math.round(avail * 0.86), life: Math.round(life * 0.8 / 10) * 10, match: 79 },
    ],
  };
}

function renderSizing() {
  const p = state.sizing;
  const r = sizingCalc(p);
  const bars = [
    { k: '负载率', v: r.ratio, max: 1, fmt: (v) => (v * 100).toFixed(0) + '%', ok: r.ratio <= 0.3 },
    { k: '推力余量', v: 1 - r.ratio, max: 1, fmt: (v) => (v * 100).toFixed(0) + '%', ok: true },
    { k: '行程利用率', v: clamp(p.stroke / 100, 0, 1), max: 1, fmt: (v) => (v * 100).toFixed(0) + '%', ok: p.stroke <= 60 },
    { k: '频率利用率', v: clamp(p.freq / 60, 0, 1), max: 1, fmt: (v) => (v * 100).toFixed(0) + '%', ok: p.freq <= 45 },
  ];
  const stage = $('#stageSizing');
  if (!stage) return;
  stage.innerHTML = `
    <div class="sizing">
      <div class="sizing-head">
        <h2>实时估算</h2>
        <span class="sub">求解 12ms · 已同步工况</span>
        <span class="spacer"></span>
        <div class="seg">
          <button class="is-active" type="button" data-seg>标准</button>
          <button type="button" data-seg>高速</button>
          <button type="button" data-seg>重载</button>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat">
          <div class="k">需求推力</div>
          <div class="v"><b id="szForce">${r.force}</b><i>N</i></div>
          <div class="t">F = m·(gμ + a)·S · 缸径 φ${r.rec}</div>
        </div>
        <div class="stat">
          <div class="k">预估寿命</div>
          <div class="v"><b id="szLife">${r.life}</b><i>km</i></div>
          <div class="t">按 <em>ISO 19973</em> 折算 · 润滑正常</div>
        </div>
        <div class="stat stat-reco">
          <span class="corner">推荐</span>
          <div class="k">推荐缸径</div>
          <div class="v"><b id="szBore">φ${r.rec}</b><i>mm</i></div>
          <div class="t">${r.rec} × ${Math.round(p.stroke)} mm · 负载率 ${(r.ratio * 100).toFixed(0)}%</div>
        </div>
      </div>
      <div class="bars">
        <div class="card">
          <h3>负载与裕度<span class="mono">阈值 30%</span></h3>
          ${bars.map(b => `<div class="bar-row"><span>${b.k}</span>
            <span class="bar"><i class="${b.ok ? 'ok' : 'warn'}" style="width:${clamp(b.v / b.max * 100, 2, 100).toFixed(0)}%"></i><em style="left:30%"></em></span>
            <span class="num">${b.fmt(b.v)}</span></div>`).join('')}
          <div class="note" style="margin-top:8px">可用推力 <b>${r.avail} N</b> @ ${p.pressure} MPa，需求 <b>${r.force} N</b>。</div>
        </div>
        <div class="card">
          <h3>计算结论<span class="mono">v0.9</span></h3>
          <div class="note">
            工况：<b>${p.pose === 'h' ? '水平' : p.pose === 'v' ? '垂直' : '侧装'}</b>安装，负载 <b>${p.mass} kg</b>，
            加速度 <b>${p.accel} m/s²</b>，安全系数 <b>${p.safety}</b>。<br>
            建议选 <b>φ${r.rec}</b> 缸径、<b>${Math.round(p.stroke)} mm</b> 行程薄型气缸，配 <b>HGR15</b> 导轨，
            预计寿命 <b>${r.life} km</b>，满足 ${p.freq} cpm 动作频率。<br>
            注意：行程 &gt; 60 mm 时请复核活塞杆稳定性。
          </div>
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="btn" type="button" data-act="report">${ICON.download}计算书</button>
            <button class="btn" type="button" data-act="apply-sizing">写入装配</button>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>缸径系列对比<span class="mono">气源 ${p.pressure} MPa · 安全系数 ${p.safety}</span></h3>
        <table class="tbl">
          <thead><tr>
            <th style="width:90px">缸径</th><th class="num">理论推力 / N</th><th class="num">负载率</th>
            <th class="num">预估寿命 / km</th><th style="width:110px">判定</th>
          </tr></thead>
          <tbody>${[
            [16, 20, 25, 32, 40, 50, 63].map(d => {
              const area = Math.PI * d * d / 4;
              const avail = p.pressure * area * 0.85;
              const ratio = r.force / avail;
              const life = 4200 * Math.pow(d / 32, 1.8) * Math.pow(p.pressure / 0.6, 0.8)
                * Math.pow(2.5 / Math.max(0.2, p.mass), 1.1) * Math.pow(50 / Math.max(5, p.stroke), 0.4);
              return { d, avail: Math.round(avail), ratio, life: Math.round(life / 10) * 10 };
            }),
          ][0].map(x => `<tr class="${x.d === r.rec ? 'is-reco' : ''}">
            <td class="mono">φ${x.d}${x.d === r.rec ? ' <span class="tag-reco">推荐</span>' : ''}</td>
            <td class="num">${x.avail}</td>
            <td class="num" style="color:${x.ratio > 0.3 ? 'var(--warning)' : 'var(--success)'}">${(x.ratio * 100).toFixed(0)}%</td>
            <td class="num">${x.life}</td>
            <td class="dim">${x.ratio > 0.6 ? '推力不足' : x.ratio > 0.3 ? '裕度偏小' : '满足'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="bars">
        <div class="card">
          <h3>计算过程<span class="mono">SI 单位</span></h3>
          <dl class="kv">
            <dt>需求推力 F</dt><dd>${p.mass} × (9.81 × ${p.mu} + ${p.accel}) × ${p.safety} = ${r.force.toFixed(2)} N</dd>
            <dt>推荐缸径 φ${r.rec}</dt><dd>A = π φ² / 4 = ${(Math.PI * r.rec * r.rec / 4).toFixed(0)} mm²</dd>
            <dt>可用推力</dt><dd>${p.pressure} MPa × A × 0.85 = ${r.avail} N</dd>
            <dt>负载率</dt><dd>${(r.ratio * 100).toFixed(1)} % （≤ 30% 合格）</dd>
            <dt>寿命折算</dt><dd>4200 × (φ/32)^1.8 × (p/0.6)^0.8 = ${r.life} km</dd>
          </dl>
        </div>
        <div class="card">
          <h3>假设与限制<span class="mono">v0.9</span></h3>
          <div class="note">
            · 气源压力稳定在 ${p.pressure} MPa，波动 ±5% 内；<br>
            · 导轨润滑正常，按 ISO 19973 折算寿命；<br>
            · 负载质心与轴线偏差 ≤ 15 mm，忽略偏载力矩；<br>
            · 行程 &gt; 60 mm 需复核活塞杆稳定性与缓冲能力。
          </div>
          <div class="note" style="margin-top:8px;color:var(--text-2)">当前结论：<b>${r.ratio <= 0.3 ? '满足设计要求' : '推力裕度不足，建议加大缸径'}</b></div>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- 3. 标准件库 */
const LIB = [
  { model: 'MXQ20-32-50', brand: 'SMC', cat: '气缸', bore: 32, stroke: 50, port: 'M5×0.8', price: 386, stock: 24 },
  { model: 'MXS16-40', brand: 'SMC', cat: '滑台', bore: 16, stroke: 40, port: 'M5×0.8', price: 512, stock: 12 },
  { model: 'ADN-32-50-A-P-A', brand: 'FESTO', cat: '气缸', bore: 32, stroke: 50, port: 'G1/8', price: 428, stock: 8 },
  { model: 'HGR15R-400', brand: 'HIWIN', cat: '导轨', bore: 15, stroke: 400, port: '—', price: 268, stock: 36 },
  { model: 'SDA32×50', brand: '亚德客', cat: '气缸', bore: 32, stroke: 50, port: 'G1/8', price: 96, stock: 120 },
  { model: 'D-M9B', brand: 'SMC', cat: '传感器', bore: 0, stroke: 0, port: '2 线', price: 78, stock: 60 },
  { model: 'KQ2H06-01AS', brand: 'SMC', cat: '接头', bore: 6, stroke: 0, port: 'R1/8', price: 12, stock: 300 },
  { model: 'CDQ2B32-50DZ', brand: 'SMC', cat: '气缸', bore: 32, stroke: 50, port: 'G1/8', price: 342, stock: 16 },
  { model: 'DFM-32-50-P-A', brand: 'FESTO', cat: '气缸', bore: 32, stroke: 50, port: 'G1/8', price: 466, stock: 5 },
  { model: 'HGH20CA', brand: 'HIWIN', cat: '导轨', bore: 20, stroke: 300, port: '—', price: 318, stock: 22 },
  { model: 'LM12UU', brand: 'MISUMI', cat: '导轨', bore: 12, stroke: 200, port: '—', price: 64, stock: 88 },
  { model: 'E-MXQ20-40', brand: '亚德客', cat: '气缸', bore: 20, stroke: 40, port: 'M5×0.8', price: 118, stock: 44 },
  { model: 'DSBC-40-80-PPVA', brand: 'FESTO', cat: '气缸', bore: 40, stroke: 80, port: 'G1/4', price: 712, stock: 3 },
  { model: 'CY3B25-50', brand: 'SMC', cat: '滑台', bore: 25, stroke: 50, port: 'M5×0.8', price: 638, stock: 6 },
  { model: 'HGR20R-600', brand: 'HIWIN', cat: '导轨', bore: 20, stroke: 600, port: '—', price: 396, stock: 18 },
  { model: 'SHF16', brand: 'MISUMI', cat: '支座', bore: 16, stroke: 0, port: '—', price: 42, stock: 160 },
  { model: 'SHF20', brand: 'MISUMI', cat: '支座', bore: 20, stroke: 0, port: '—', price: 54, stock: 120 },
  { model: 'SF-12-300', brand: 'MISUMI', cat: '导向轴', bore: 12, stroke: 300, port: '—', price: 86, stock: 74 },
  { model: 'SF-16-400', brand: 'MISUMI', cat: '导向轴', bore: 16, stroke: 400, port: '—', price: 124, stock: 41 },
  { model: 'CD85N20-50-B', brand: 'SMC', cat: '气缸', bore: 20, stroke: 50, port: 'M5×0.8', price: 214, stock: 30 },
  { model: 'D-M9P', brand: 'SMC', cat: '传感器', bore: 0, stroke: 0, port: '3 线', price: 92, stock: 48 },
  { model: 'KQ2L06-01AS', brand: 'SMC', cat: '接头', bore: 6, stroke: 0, port: 'R1/8', price: 15, stock: 260 },
  { model: 'CB-M4-12', brand: 'MISUMI', cat: '螺钉', bore: 4, stroke: 12, port: '—', price: 1.8, stock: 900 },
  { model: 'CB-M5-16', brand: 'MISUMI', cat: '螺钉', bore: 5, stroke: 16, port: '—', price: 2.4, stock: 760 },
];
state.libSort = { key: null, dir: 1 };
state.libSel = LIB[0];
state.libCat = null;

function libRows() {
  let rows = LIB.filter(r => !state.libCat || r.cat === state.libCat);
  if (state.libSort.key) {
    const k = state.libSort.key, d = state.libSort.dir;
    rows = rows.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d);
  }
  return rows;
}

function renderLibrary() {
  const stage = $('#stageLibrary');
  if (!stage) return;
  const rows = libRows();
  const th = (k, label, cls) => {
    const sorted = state.libSort.key === k;
    const dirCls = sorted ? (state.libSort.dir > 0 ? 'asc' : 'desc') : '';
    return `<th class="${cls || ''} ${sorted ? 'is-sorted' : ''} ${dirCls}" data-sort="${k}">
      <button class="sort" type="button">${label}${sorted ? ICON.sort : ''}</button></th>`;
  };
  stage.innerHTML = `
    <div class="lib-wrap">
      <div class="lib-bar">
        <span class="searchbox">${ICON.search}<input class="ctl" type="search" placeholder="搜索型号 / 品牌 / 规格…" data-lib-search></span>
        <span class="count">${rows.length} / ${LIB.length} 条</span>
        <span style="flex:1"></span>
        <span class="count">${state.libCat ? '品类：' + state.libCat : '全部品类'}${state.libSort.key ? ' · 已排序' : ''}</span>
      </div>
      <div class="lib-table">
        <table class="tbl">
          <thead><tr>
            ${th('model', '型号')}${th('brand', '品牌')}${th('cat', '品类')}
            ${th('bore', '缸径', 'num')}${th('stroke', '行程', 'num')}${th('port', '接口')}${th('price', '单价 / ¥', 'num')}
          </tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr class="${r.model === state.libSel.model ? 'is-sel' : ''}" data-lib="${r.model}"
                draggable="true" title="拖动到装配视口，或双击插入">
              <td class="mono">${r.model}</td><td>${r.brand}</td><td class="dim">${r.cat}</td>
              <td class="num">${r.bore || '—'}</td><td class="num">${r.stroke || '—'}</td>
              <td class="mono dim">${r.port}</td><td class="num">${r.price.toFixed(2)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="lib-bar" style="border-top:1px solid var(--divider);border-bottom:0">
        <span class="count">双击行插入 · 共 ${rows.length} 条</span>
        <span style="flex:1"></span>
        <span class="count">单位 mm · 含税单价</span>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- 4. 图纸 */
const BOM = [
  { no: 1, name: '底板', spec: 'BASE-01 210×72×8', qty: 1, mat: 'AL6061' },
  { no: 2, name: '直线导轨', spec: 'HGR15R-400', qty: 1, mat: 'GCr15' },
  { no: 3, name: '滑台', spec: 'CAR-32', qty: 1, mat: 'AL6061' },
  { no: 4, name: '气缸', spec: 'MXQ20-32-50', qty: 1, mat: '—' },
  { no: 5, name: '活塞杆', spec: 'ROD-12×120', qty: 1, mat: 'SUS304' },
  { no: 6, name: '内六角螺钉', spec: 'M4×12', qty: 8, mat: 'SUS304' },
  { no: 7, name: '磁性开关', spec: 'D-M9B', qty: 2, mat: '—' },
];

function renderSheet() {
  const svg = $('#sheet');
  if (!svg) return;
  const ink = '#1A1D20';
  const hair = 0.9;
  const H = (x1, x2, y, txt) => `
    <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${ink}" stroke-width="${hair}"
      marker-start="url(#arw)" marker-end="url(#arw)"/>
    <line x1="${x1}" y1="${y - 16}" x2="${x1}" y2="${y + 6}" stroke="${ink}" stroke-width=".6"/>
    <line x1="${x2}" y1="${y - 16}" x2="${x2}" y2="${y + 6}" stroke="${ink}" stroke-width=".6"/>
    <text x="${(x1 + x2) / 2}" y="${y - 7}" text-anchor="middle" font-size="13" font-family="monospace" fill="${ink}">${txt}</text>`;
  const V = (x, y1, y2, txt) => `
    <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${ink}" stroke-width="${hair}"
      marker-start="url(#arw)" marker-end="url(#arw)"/>
    <line x1="${x - 16}" y1="${y1}" x2="${x + 6}" y2="${y1}" stroke="${ink}" stroke-width=".6"/>
    <line x1="${x - 16}" y1="${y2}" x2="${x + 6}" y2="${y2}" stroke="${ink}" stroke-width=".6"/>
    <text x="${x - 9}" y="${(y1 + y2) / 2}" text-anchor="middle" font-size="13" font-family="monospace" fill="${ink}"
      transform="rotate(-90 ${x - 9} ${(y1 + y2) / 2})">${txt}</text>`;

  const hatch = 'url(#hatch)';

  svg.innerHTML = `
    <defs>
      <pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="7" stroke="${ink}" stroke-width=".7"/>
      </pattern>
      <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1.2L9 5L0 8.8z" fill="${ink}"/>
      </marker>
      <marker id="arwS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1.2L9 5L0 8.8z" fill="${ink}"/>
      </marker>
    </defs>

    <!-- 图框 -->
    <rect x="0" y="0" width="1180" height="820" fill="#fff"/>
    <rect x="14" y="14" width="1152" height="792" fill="none" stroke="${ink}" stroke-width="1.6"/>
    <rect x="30" y="30" width="1120" height="760" fill="none" stroke="${ink}" stroke-width=".9"/>
    <line x1="30" y1="30" x2="30" y2="790" stroke="${ink}" stroke-width=".9"/>

    <!-- 视图区：主视图（前视，全剖） -->
    <g>
      <!-- 底板 -->
      <rect x="170" y="498" width="420" height="24" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <!-- 导轨 -->
      <rect x="200" y="462" width="360" height="36" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <!-- 滑台 -->
      <rect x="320" y="416" width="150" height="46" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <!-- 气缸体 -->
      <rect x="345" y="272" width="100" height="144" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <!-- 端盖 -->
      <rect x="338" y="258" width="114" height="14" fill="#fff" stroke="${ink}" stroke-width="1.1"/>
      <!-- 活塞杆 -->
      <rect x="378" y="196" width="34" height="62" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <!-- 杆端板 -->
      <rect x="366" y="180" width="58" height="16" fill="#fff" stroke="${ink}" stroke-width="1.1"/>
      <!-- 中心线 -->
      <line x1="395" y1="150" x2="395" y2="546" stroke="${ink}" stroke-width=".8" stroke-dasharray="16 4 3 4"/>
      <line x1="150" y1="330" x2="640" y2="330" stroke="${ink}" stroke-width=".8" stroke-dasharray="16 4 3 4"/>
      <!-- 螺钉孔 -->
      <line x1="200" y1="504" x2="200" y2="516" stroke="${ink}" stroke-width=".8"/>
      <line x1="560" y1="504" x2="560" y2="516" stroke="${ink}" stroke-width=".8"/>
    </g>

    <!-- 侧视图（右） -->
    <g transform="translate(880,250)">
      <line x1="-90" y1="0" x2="90" y2="0" stroke="${ink}" stroke-width=".8" stroke-dasharray="14 4 3 4"/>
      <line x1="0" y1="-90" x2="0" y2="90" stroke="${ink}" stroke-width=".8" stroke-dasharray="14 4 3 4"/>
      <circle cx="0" cy="0" r="50" fill="#fff" stroke="${ink}" stroke-width="1.1"/>
      <circle cx="0" cy="0" r="32" fill="none" stroke="${ink}" stroke-width=".9"/>
      <circle cx="0" cy="0" r="17" fill="${hatch}" stroke="${ink}" stroke-width="1.1"/>
      <line x1="-58" y1="0" x2="-40" y2="0" stroke="${ink}" stroke-width=".7"/>
      <line x1="40" y1="0" x2="58" y2="0" stroke="${ink}" stroke-width=".7"/>
      <line x1="0" y1="-58" x2="0" y2="-40" stroke="${ink}" stroke-width=".7"/>
      <line x1="0" y1="40" x2="0" y2="58" stroke="${ink}" stroke-width=".7"/>
      <!-- 引出标注 -->
      <path d="M35 -35 L66 -62 L150 -62" fill="none" stroke="${ink}" stroke-width=".8"/>
      <text x="72" y="-57" font-size="13" font-family="monospace" fill="${ink}">φ${32}</text>
      <path d="M12 12 L60 44 L150 44" fill="none" stroke="${ink}" stroke-width=".8"/>
      <text x="66" y="49" font-size="13" font-family="monospace" fill="${ink}">φ12</text>
      <text x="-52" y="84" font-size="12" fill="${ink}" font-family="monospace">A—A</text>
    </g>

    <!-- 尺寸 -->
    ${V(120, 180, 522, '342')}
    ${H(170, 590, 560, '210')}
    ${H(200, 560, 600, '160')}
    ${V(470, 196, 272, '50')}
    <path d="M345 300 L300 276 L246 276" fill="none" stroke="${ink}" stroke-width=".8"/>
    <text x="200" y="281" font-size="13" font-family="monospace" fill="${ink}">φ32</text>
    <path d="M320 440 L280 468 L238 468" fill="none" stroke="${ink}" stroke-width=".8"/>
    <text x="196" y="473" font-size="13" font-family="monospace" fill="${ink}">24</text>

    <!-- 技术要求 -->
    <g font-size="12" fill="${ink}" font-family="'HarmonyOS Sans SC','PingFang SC',sans-serif">
      <text x="90" y="632" font-size="13" font-weight="600">技术要求</text>
      <text x="90" y="652">1. 未注圆角 R2，未注公差按 GB/T 1804-m。</text>
      <text x="90" y="670">2. 装配后 0.6MPa 气密试验，保压 3min 无泄漏。</text>
      <text x="90" y="688">3. 滑台行程 50mm，重复定位精度 ±0.02mm。</text>
    </g>

    <!-- 标题栏 -->
    <g stroke="${ink}" fill="none" stroke-width=".9">
      <rect x="790" y="670" width="360" height="120"/>
      <line x1="790" y1="700" x2="1150" y2="700"/>
      <line x1="790" y1="730" x2="1150" y2="730"/>
      <line x1="790" y1="760" x2="1150" y2="760"/>
      <line x1="910" y1="700" x2="910" y2="730"/>
      <line x1="1040" y1="700" x2="1040" y2="730"/>
      <line x1="890" y1="730" x2="890" y2="790"/>
      <line x1="1010" y1="730" x2="1010" y2="790"/>
      <line x1="1090" y1="730" x2="1090" y2="790"/>
    </g>
    <g fill="${ink}" font-family="'HarmonyOS Sans SC','PingFang SC',sans-serif">
      <text x="800" y="692" font-size="14" font-weight="600">滑台气缸装配图</text>
      <text x="1080" y="692" font-size="12">ASM-001</text>
      <text x="800" y="720" font-size="11" fill="#6B7178">图号</text><text x="836" y="720" font-size="12">ASM-001</text>
      <text x="920" y="720" font-size="11" fill="#6B7178">比例</text><text x="952" y="720" font-size="12" font-family="monospace">1:2</text>
      <text x="1050" y="720" font-size="11" fill="#6B7178">张次</text><text x="1082" y="720" font-size="12" font-family="monospace">1 / 1</text>
      <text x="800" y="750" font-size="11" fill="#6B7178">设计</text><text x="836" y="750" font-size="12">睿克斯</text>
      <text x="920" y="750" font-size="11" fill="#6B7178">审核</text><text x="952" y="750" font-size="12">李工</text>
      <text x="1050" y="750" font-size="11" fill="#6B7178">日期</text><text x="1082" y="750" font-size="11" font-family="monospace">2025-06-12</text>
      <text x="800" y="780" font-size="11" fill="#6B7178">材料</text><text x="836" y="780" font-size="12">—</text>
      <text x="920" y="780" font-size="11" fill="#6B7178">数量</text><text x="952" y="780" font-size="12" font-family="monospace">1</text>
      <text x="1050" y="780" font-size="11" fill="#6B7178">单位</text><text x="1082" y="780" font-size="12" font-family="monospace">mm</text>
    </g>
    <text x="70" y="66" font-size="12" fill="#6B7178" font-family="monospace">第三角投影 · 未注单位 mm · 比例 1:2</text>
    <text x="1108" y="66" text-anchor="end" font-size="12" fill="#6B7178" font-family="monospace">ASM-001 / 01</text>`;
}

/* 规格预览缩略图 */
function thumbCyl() {
  return `<svg viewBox="0 0 140 130" fill="none">
    <path d="M44 96V34a26 9 0 0152 0v62a26 9 0 01-52 0z" fill="url(#tg)" stroke="#6A737D" stroke-width=".9"/>
    <ellipse cx="70" cy="96" rx="26" ry="9" fill="#2A2F34" stroke="#6A737D" stroke-width=".9"/>
    <ellipse cx="70" cy="34" rx="26" ry="9" fill="#4A5158" stroke="#8D969E" stroke-width=".9"/>
    <ellipse cx="70" cy="34" rx="18" ry="6.2" fill="#3A4046" stroke="#7C858F" stroke-width=".8"/>
    <rect x="64" y="12" width="12" height="22" fill="#8D969E" stroke="#4A5158" stroke-width=".8"/>
    <ellipse cx="70" cy="12" rx="6" ry="2.6" fill="#A8B0B8" stroke="#4A5158" stroke-width=".8"/>
    <line x1="70" y1="4" x2="70" y2="112" stroke="#5A626A" stroke-width=".8" stroke-dasharray="10 3 2 3"/>
    <defs><linearGradient id="tg" x1="0" x2="1"><stop offset="0" stop-color="#454B52"/><stop offset=".3" stop-color="#7C858F"/><stop offset=".55" stop-color="#8B949E"/><stop offset="1" stop-color="#3D4349"/></linearGradient></defs>
  </svg>`;
}

/* ---------------------------------------------------------------- 视图切换 */
function setView(v) {
  state.view = v;
  $$('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
  $$('.ctx').forEach(c => { c.hidden = c.dataset.ctx !== v; });
  const mode = VIEW_MODE[v];
  $$('.mode').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on);
  });
  /* 左栏 tabs 激活态 */
  $$('.tab').forEach(t => {
    const on = t.dataset.tab === v;
    t.classList.toggle('is-active', on);
    t.classList.toggle('is-dim', v === 'check' || v === 'drafting');
    t.setAttribute('aria-selected', on);
  });
  /* 状态栏校核段 */
  const st = $('#stCheck');
  st.hidden = v !== 'check';
  if (v === 'check') st.textContent = `第 ${state.issueIdx + 1}/${ISSUES.length} 处`;
  if (v === 'check') {
    $('#stBadge').className = 'badge badge-warning';
    $('#stBadge').innerHTML = `<span class="badge-dot"></span>校核 3 项待处理`;
    applyIssue(state.issueIdx, true);
    return;
  }
  state.hitPart = null;
  applySceneState();
}

function setMode(m) {
  const map = { model: 'sizing', assembly: 'assembly', check: 'check', drafting: 'drafting' };
  setView(map[m] || 'assembly');
}

/* ---------------------------------------------------------------- 选中态 */
function applySceneState() {
  const sel = state.multi.length ? state.multi : (state.selectedPart ? [state.selectedPart] : []);
  ['#scene3d', '#sceneCheck'].forEach(sel2 => {
    const root = $(sel2);
    if (!root) return;
    $$('.part', root).forEach(g => {
      const id = g.dataset.part;
      const isSel = state.view !== 'check' && sel.includes(id);
      g.dataset.sel = isSel ? '1' : '0';
      g.dataset.hover = (!isSel && state.hoverPart === id) ? '1' : '0';
      g.dataset.hit = (state.hitPart === id) ? '1' : '0';
    });
    $$('.outline-path', root).forEach(p => {
      const id = p.dataset.outline;
      const isSel = state.view !== 'check' && sel.includes(id);
      p.dataset.sel = isSel ? '1' : '0';
      p.dataset.hover = (!isSel && state.hoverPart === id) ? '1' : '0';
      p.dataset.hit = (state.hitPart === id) ? '1' : '0';
    });
  });
}

function selectPart(partId, nodeId) {
  state.multi = [];
  if (partId) state.selectedPart = partId;
  if (nodeId) state.selNode = nodeId;
  else if (partId) state.selNode = partId;
  const left = $('[data-panel="left"][data-for="assembly"]');
  if (left) {
    const body = $('.panel-body', left);
    if (body) body.innerHTML = treeHTML();
  }
  const right = $('[data-panel="right"][data-for="assembly"]');
  if (right) right.innerHTML = rightHTML('assembly');
  applySceneState();
  updateAssemblyCounters();
  updateStatus();
}

function updateStatus() {
  const path = NODE_PATH[state.selNode] || ['装配'];
  $('#stHier').textContent = '当前层级：' + path.join(' > ');
  const c = COORDS[state.selectedPart] || [0, 0, 0];
  $('#stX').textContent = c[0].toFixed(2);
  $('#stY').textContent = c[1].toFixed(2);
  $('#stZ').textContent = c[2].toFixed(2);
}

let msgTimer;
function statusMsg(text) {
  const el = $('#stMsg');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

let toastTimer;
/* ============ 工程下拉 ============ */
const FILE_MENU_ICON = '<svg viewBox="0 0 16 16" class="ico" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.2"><path d="M2.5 4.5A1 1 0 013.5 3.5h3l1.3 1.6h4.7a1 1 0 011 1v6.4a1 1 0 01-1 1H3.5a1 1 0 01-1-1z"/></svg>';

function fmtProjectTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderFileMenu(records) {
  const menu = $('#fileMenu');
  if (!menu) return;
  const list = Array.isArray(records) ? records : [];
  const head = `<div class="file-menu-section">已保存工程 · ${list.length}</div>`;
  const body = list.length === 0
    ? `<div class="file-menu-empty">还没有工程。<br>用智能体 <code>build_machine_model</code> 生成整机，或让我导出 .acproj。</div>`
    : list.map((r) => {
        const meta = [
          r.parts + ' 件',
          r.massKg != null ? r.massKg + ' kg' : null,
          r.envelope ? `${Math.round(r.envelope[0])}×${Math.round(r.envelope[1])}×${Math.round(r.envelope[2])}` : null,
          fmtProjectTime(r.createdAt)
        ].filter(Boolean).join(' · ');
        return `<div class="file-menu-item" role="menuitem" tabindex="0" data-project-open="${attr(r.id)}">
          <span class="nm">${FILE_MENU_ICON} ${esc(r.name)}</span>
          <span class="mt">${esc(meta)}</span>
          <button type="button" class="del" data-project-delete="${attr(r.id)}" title="删除该工程">×</button>
        </div>`;
      }).join('');
  menu.innerHTML = head + body;
}

let currentProjectRecord = null;

/**
 * 打开工程后，外壳的演示 3D（示例滑台气缸）必须让位：
 * 换成工程卡片 + 左侧零件清单 + 右侧工程参数，避免"选了输送机却还是气缸"。
 */
function applyProjectStage(record) {
  currentProjectRecord = record || null;
  const stage = $('#stageProject');
  const scene = $('#scene3d');
  if (!record) {
    if (stage) stage.hidden = true;
    if (scene) scene.style.display = '';
    document.getElementById('app')?.classList.remove('is-project');
    return;
  }
  if (scene) scene.style.display = 'none';
  if (stage) stage.hidden = false;
  const title = $('#spTitle');
  const meta = $('#spMeta');
  if (title) title.textContent = record.name;
  const env = Array.isArray(record.envelope)
    ? `${Math.round(record.envelope[0])}×${Math.round(record.envelope[1])}×${Math.round(record.envelope[2])} mm`
    : '—';
  if (meta) {
    meta.innerHTML = [
      `零件 ${record.parts} 件`,
      record.massKg != null ? `总质量 ${record.massKg} kg` : null,
      `包络 ${env}`,
      `保存于 ${fmtProjectTime(record.createdAt)}`
    ].filter(Boolean).join(' · ');
  }
  document.getElementById('app')?.classList.add('is-project');
  renderProjectTree(record);
}

/** 左侧结构树改成工程零件清单：按名称前缀分组、全部列出、可点选（演示装配的 6 件不再冒充） */
function projectGroupOf(name) {
  // 支持两种前缀：「直线·入料段」（画布示意装配）与「托条-L17-2」（工程逐件 STL）
  const text = String(name || '');
  const dot = /^([^·]+)·/.exec(text);
  if (dot) return dot[1];
  const dash = /^([^-]+)-/.exec(text);
  return dash ? dash[1] : '其他';
}
let treeProjectId = '';
let treeSearchQuery = '';
/** 结构树折叠状态按工程 id 存 localStorage；key = T:顶层 或 S:顶层/子层 */
function treeCollapseKey(id) { return 'acw.treeCollapsed.' + id; }
function loadTreeCollapsed(id) {
  try {
    const raw = localStorage.getItem(treeCollapseKey(id));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
  } catch { return new Set(); }
}
function saveTreeCollapsed(id, set) {
  try { localStorage.setItem(treeCollapseKey(id), JSON.stringify([...set])); } catch { /* 隐私模式/配额满：忽略，不影响树 */ }
}

function renderProjectTree(record) {
  const left = $('[data-panel="left"][data-for="assembly"]');
  const body = left && left.querySelector('.panel-body');
  if (!body) return;
  const items = (Array.isArray(record.partsList) ? record.partsList : [])
    .map((item) => ({
      name: String(item && item.name || '').trim(),
      path: item && Array.isArray(item.path) ? item.path.filter((p) => typeof p === 'string' && p.trim()).slice(0, 8) : []
    }))
    .filter((item) => item.name);
  const hasPath = items.some((item) => item.path.length > 0);

  /** 路径分组：总装 > 子装配 > 零件；没有路径的件归到「未分层」 */
  const byTop = new Map();
  for (const item of items) {
    const top = hasPath ? (item.path[0] || '未分层') : projectGroupOf(item.name);
    const sub = hasPath ? (item.path[1] || '') : '';
    if (!byTop.has(top)) byTop.set(top, new Map());
    const bucket = byTop.get(top);
    if (!bucket.has(sub)) bucket.set(sub, []);
    bucket.get(sub).push(item);
  }

  const rowHtml = (item) => {
    const title = item.path.length > 0 ? ` title="${attr(item.path.join(' > '))}"` : '';
    const search = [item.name, ...item.path].join(' ').toLowerCase();
    return `<div class="tree-row pt-row" role="button" tabindex="0" data-project-part="${attr(item.name)}" data-pt-search="${attr(search)}"${title}>
      <span class="pt-name">${esc(item.name)}</span>
    </div>`;
  };
  const collapsed = loadTreeCollapsed(record.id);
  treeProjectId = record.id;
  const sections = Array.from(byTop.entries()).map(([top, bucket], groupIndex) => {
    const total = Array.from(bucket.values()).reduce((sum, list) => sum + list.length, 0);
    const inner = Array.from(bucket.entries()).map(([sub, list]) => {
      if (!sub) return list.map(rowHtml).join('');
      const subKey = `S:${top}/${sub}`;
      return `<details class="pt-group pt-sub" data-tree-key="${attr(subKey)}" ${collapsed.has(subKey) ? '' : 'open'}>
        <summary class="pt-group-head">${esc(sub)}<span class="pt-count">${list.length}</span></summary>
        ${list.map(rowHtml).join('')}
      </details>`;
    }).join('');
    const topKey = `T:${top}`;
    const defaultOpen = groupIndex === 0 || total <= 8;
    return `<details class="pt-group" data-tree-key="${attr(topKey)}" ${collapsed.has(topKey) ? '' : (defaultOpen ? 'open' : '')}>
      <summary class="pt-group-head">${esc(top)}<span class="pt-count">${total}</span></summary>
      ${inner}
    </details>`;
  }).join('');

  body.innerHTML = `
    <div class="panel-section">
      <div class="panel-section-head">工程零件 · ${record.parts} 件 · ${byTop.size} 组${hasPath ? ' · 按装配层级' : ''}</div>
      <div class="pt-search-wrap">
        <input type="search" class="pt-search" id="projectTreeSearch" placeholder="搜索零件名 / 装配路径（如 托条、机架）" aria-label="搜索工程零件">
        <span class="pt-search-count" id="projectTreeSearchCount" role="status" aria-live="polite"></span>
      </div>
      ${sections || '<div class="panel-empty">工程里没有零件记录</div>'}
      ${items.length !== record.parts ? `<div class="panel-empty">工程记录 ${record.parts} 件，清单 ${items.length} 件</div>` : ''}
    </div>`;
  body.querySelectorAll('.pt-row').forEach((row) => {
    const pick = () => {
      const name = row.dataset.projectPart;
      if (!name) return;
      if (typeof window.__projectTreeSelect === 'function') window.__projectTreeSelect(name);
      else window.__projectTreeSetSelected?.(name);
    };
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
    });
  });
  const searchInput = body.querySelector('#projectTreeSearch');
  const searchCount = body.querySelector('#projectTreeSearchCount');
  const applySearch = (raw) => {
    const query = String(raw || '').trim().toLowerCase();
    let matched = 0;
    body.querySelectorAll('[data-project-part]').forEach((row) => {
      const hit = query === '' || (row.dataset.ptSearch || '').includes(query);
      row.hidden = !hit;
      if (hit) matched += 1;
    });
    // 命中的组自动展开，空组收起，免得搜到了却藏在折叠里
    body.querySelectorAll('details[data-tree-key]').forEach((node) => {
      const visible = [...node.querySelectorAll('[data-project-part]')].some((row) => !row.hidden);
      node.hidden = query !== '' && !visible;
      if (query !== '' && visible) node.open = true;
    });
    if (searchCount) {
      searchCount.textContent = query === '' ? '' : `匹配 ${matched} / ${items.length} 件`;
    }
  };
  searchInput?.addEventListener('input', () => {
    treeSearchQuery = searchInput.value;
    applySearch(searchInput.value);
  });
  // 重新渲染后保留搜索词（切工程/选零件会重绘树）
  if (treeSearchQuery) {
    if (searchInput) searchInput.value = treeSearchQuery;
    applySearch(treeSearchQuery);
  }
  body.querySelectorAll('details[data-tree-key]').forEach((node) => {
    node.addEventListener('toggle', () => {
      const key = node.dataset.treeKey;
      if (!key || treeProjectId !== record.id) return;
      if (node.hidden) return; // 搜索过滤导致的收起不记进折叠状态
      const next = loadTreeCollapsed(record.id);
      if (node.open) next.delete(key); else next.add(key);
      saveTreeCollapsed(record.id, next);
    });
  });
  window.__projectTreeSetSelected?.(currentProjectPartName());
}
window.__projectTreeSetSelected = function (name) {
  document.querySelectorAll('[data-project-part]').forEach((row) => {
    row.classList.toggle('is-sel', !!name && row.dataset.projectPart === name);
  });
};
function currentProjectPartName() {
  try { return window.__AgentBridge?.getSelection?.()?.name ?? null; } catch { return null; }
}

/** 供扩展在打开工程后刷新标题/元信息/工程零件树（结构树分组依赖这里） */
window.__applyProjectStage = function (record) {
  if (!record) return;
  try { applyProjectStage(record); } catch (e) { /* 原型 UI 未就绪时忽略 */ }
};

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(v) { return esc(v).replace(/`/g, ''); }

function refreshFileMenu() {
  const api = window.AutomationCadProjects;
  if (!api) { renderFileMenu([]); return; }
  Promise.resolve(api.list()).then((records) => renderFileMenu(records)).catch(() => renderFileMenu([]));
}

function toggleFileMenu() {
  const menu = $('#fileMenu');
  const btn = $('#fileBtn');
  if (!menu || !btn) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) { syncFileName(); refreshFileMenu(); statusMsg('工程列表'); }
}

function closeFileMenu() {
  const menu = $('#fileMenu');
  const btn = $('#fileBtn');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/** 顶栏文件名跟随当前打开的工程 */
function syncFileName() {
  const api = window.AutomationCadProjects;
  const name = $('#fileCurrentName');
  const ext = $('#fileCurrentExt');
  if (!name || !api) return;
  const current = String(api.current() || '');
  if (!current) return;
  const clean = current.replace(/（\d+ 件）$/, '');
  name.textContent = clean;
  const dot = clean.lastIndexOf('.');
  if (ext) ext.textContent = dot > 0 ? clean.slice(dot) : '.asm';
  if (dot > 0) name.textContent = clean.slice(0, dot);
}

// 原型页与测试沙箱都会加载本文件：事件绑定前先确认是真实 DOM 环境
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => { syncFileName(); restoreLastProjectStage(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFileMenu(); });
}

function toast(msg, tone) {
  const t = $('#toast');
  t.dataset.tone = tone || '';
  t.innerHTML = (tone === 'warn' ? ICON.alert : ICON.check) + `<span>${msg}</span>`;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2200);
}

/* ---------------------------------------------------------------- 多步历史 */
const HISTORY_LIMIT = 50;

function refreshHistoryUI() {
  const undo = $('#stUndo');
  const redo = $('#stRedo');
  if (!undo) return;
  undo.disabled = state.undoStack.length === 0;
  if (redo) redo.disabled = state.redoStack.length === 0;
  const undoText = $('#stUndoText');
  const redoText = $('#stRedoText');
  if (undoText) undoText.textContent = `撤销 ${state.undoStack.length}`;
  if (redoText) redoText.textContent = `重做 ${state.redoStack.length}`;
  undo.title = state.undoStack.length
    ? `撤销：${state.undoStack[state.undoStack.length - 1].label}（Ctrl+Z）`
    : '没有可撤销的操作';
  if (redo) {
    redo.title = state.redoStack.length
      ? `重做：${state.redoStack[state.redoStack.length - 1].label}（Ctrl+Shift+Z）`
      : '没有可重做的操作';
  }
}

function setupHistoryControls() {
  const undo = $('#stUndo');
  if (!undo) return;
  undo.hidden = false;
  let redo = $('#stRedo');
  if (!redo) {
    redo = document.createElement('button');
    redo.type = 'button';
    redo.id = 'stRedo';
    redo.className = 'st-undo';
    redo.innerHTML = `<svg viewBox="0 0 16 16" class="ico"><path d="M12 5.5v3.2H8.8"/><path d="M12 8.7a5 5 0 10-8.6-3.4"/></svg><span id="stRedoText">重做 0</span>`;
    undo.insertAdjacentElement('afterend', redo);
  }
  if (undo.dataset.historyBound !== '1') {
    undo.dataset.historyBound = '1';
    undo.addEventListener('click', () => undoAction());
  }
  if (redo.dataset.historyBound !== '1') {
    redo.dataset.historyBound = '1';
    redo.addEventListener('click', () => redoAction());
  }
  refreshHistoryUI();
}

function pushHistory(entry) {
  if (!entry) return;
  state.undoStack.push(entry);
  if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
  state.redoStack.length = 0;
  state.lastEdit = null;
  refreshHistoryUI();
}

function undoAction() {
  if (!state.undoStack.length) return { ok: false, message: '没有可撤销的操作' };
  const item = state.undoStack.pop();
  try {
    item.undo();
  } catch (error) {
    state.undoStack.push(item);
    refreshHistoryUI();
    return { ok: false, message: `撤销失败：${error && error.message ? error.message : error}` };
  }
  state.redoStack.push(item);
  state.lastEdit = null;
  refreshHistoryUI();
  statusMsg(`已撤销：${item.label}`);
  toast(`已撤销：${item.label}`);
  return { ok: true, label: item.label };
}

function redoAction() {
  if (!state.redoStack.length) return { ok: false, message: '没有可重做的操作' };
  const item = state.redoStack.pop();
  try {
    item.redo();
  } catch (error) {
    state.redoStack.push(item);
    refreshHistoryUI();
    return { ok: false, message: `重做失败：${error && error.message ? error.message : error}` };
  }
  state.undoStack.push(item);
  if (state.undoStack.length > HISTORY_LIMIT) state.undoStack.shift();
  state.lastEdit = null;
  refreshHistoryUI();
  statusMsg(`已重做：${item.label}`);
  toast(`已重做：${item.label}`);
  return { ok: true, label: item.label };
}

/* ---------------------------------------------------------------- 属性编辑 */
function flashField(el) {
  el.classList.remove('is-flash');
  void el.offsetWidth;
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 800);
}

function computedFields(pid) {
  if (pid !== 'cyl') return;
  const v = state.values.cyl;
  const total = Number(v.mount || 0) + Number(v.stroke || 0) + 60;
  const mass = 0.42 + (Number(v.bore) - 32) * 0.006 + (Number(v.stroke) - 50) * 0.0012;
  const t = $('#pv-total'); if (t) t.innerHTML = total + ' <i class="ro-unit">mm</i>';
  const m = $('#pv-mass'); if (m) m.innerHTML = mass.toFixed(2) + ' <i class="ro-unit">kg</i>';
}

const FIELD_LABELS = { bore: '缸径', stroke: '行程', mount: '安装距', model: '型号', material: '材料', finish: '表面处理', fit: '配合' };

function applyFieldValue(pid, key, val, shouldFlash) {
  if (!state.values[pid]) state.values[pid] = {};
  state.values[pid][key] = val;
  $$(`[data-field="${key}"][data-part="${pid}"]`).forEach(input => {
    input.value = val;
    if (shouldFlash) flashField(input);
  });
  if (pid === 'cyl') {
    const cfg = { bore: Number(state.values.cyl.bore), stroke: Number(state.values.cyl.stroke) };
    mountScene('#scene3d', cfg);
    mountScene('#sceneCheck', Object.assign({ section: true }, cfg));
    applySceneState();
    computedFields('cyl');
    if (key === 'bore' || key === 'stroke') renderSizing();
  }
}

function pushEdit(pid, key, prev, val, label) {
  const now = Date.now();
  const editKey = `${pid}::${key}`;
  const top = state.undoStack[state.undoStack.length - 1];
  if (state.lastEdit && state.lastEdit.key === editKey && top === state.lastEdit.entry &&
      now - state.lastEdit.at <= 800) {
    state.lastEdit.entry.label = `${label} ${state.lastEdit.start}→${val}`;
    state.lastEdit.entry.redo = () => applyFieldValue(pid, key, val, true);
    state.lastEdit.at = now;
    refreshHistoryUI();
    return;
  }
  const entry = {
    label: `${label} ${prev}→${val}`,
    undo: () => applyFieldValue(pid, key, prev, true),
    redo: () => applyFieldValue(pid, key, val, true),
  };
  pushHistory(entry);
  state.lastEdit = { key: editKey, at: now, entry, start: prev };
}

const commitField = debounce(function (pid, key, val, prev, el) {
  applyFieldValue(pid, key, val, false);
  const label = FIELD_LABELS[key] || key;
  pushEdit(pid, key, prev, val, label);
  statusMsg(`${label} 已更新`);
}, 150);

/* ---------------------------------------------------------------- 插入与约束 */
function findConstraintSuggestion(id) {
  for (const list of Object.values(state.constraintSuggestions)) {
    const found = list.find(item => item.id === id);
    if (found) return found;
  }
  return null;
}

function makeConstraintSuggestions(partId, lib) {
  const rows = lib.cat === '气缸'
    ? [['concentric', '同心配合', '轴线与安装孔同轴'], ['coincident', '端面贴合', '法兰面贴合法兰面'], ['parallel', '轴线平行', '轴线平行于导轨']]
    : lib.cat === '导轨'
      ? [['coincident', '端面贴合', '基准面贴合安装面'], ['parallel', '轴线平行', '轴线平行于滑台']]
      : [['coincident', '端面贴合', '贴合当前安装面']];
  return rows.map(([type, label, detail], index) => ({
    id: `${partId}-c${index + 1}`,
    part: partId,
    model: lib.model,
    cat: lib.cat,
    type,
    label,
    detail,
  }));
}

function constraintCardHTML(pid) {
  const list = state.constraintSuggestions[pid] || [];
  if (!list.length) return '';
  const adopted = list.filter(item => state.constraints.some(c => c.id === item.id)).length;
  return `<section class="constraint-card" aria-label="约束建议">
    <div class="cc-head"><span>约束建议</span><span class="cc-count">${adopted}/${list.length} 已采用</span></div>
    <div class="cc-list">${list.map(item => {
      const isAdopted = state.constraints.some(c => c.id === item.id);
      const isIgnored = state.ignoredConstraints.includes(item.id);
      const cls = isAdopted ? 'is-adopted' : isIgnored ? 'is-ignored' : '';
      return `<div class="cc-item ${cls}">
        <div class="cc-main"><span class="cc-name">${item.label}</span><span class="cc-detail">${item.detail}</span></div>
        <div class="cc-actions">
          <button class="cc-btn cc-accept" type="button" data-constraint-accept="${item.id}" ${isAdopted || isIgnored ? 'disabled' : ''}>${isAdopted ? '已采用' : '采用'}</button>
          <button class="cc-btn" type="button" data-constraint-ignore="${item.id}" ${isAdopted || isIgnored ? 'disabled' : ''}>${isIgnored ? '已忽略' : '忽略'}</button>
        </div>
      </div>`;
    }).join('')}</div>
  </section>`;
}

function refreshConstraintUI(pid) {
  const left = $('[data-panel="left"][data-for="assembly"]');
  if (left) {
    const body = $('.panel-body', left);
    if (body) body.innerHTML = treeHTML();
  }
  updateAssemblyCounters();
  if (state.view === 'assembly') {
    const right = $('[data-panel="right"][data-for="assembly"]');
    if (right) right.innerHTML = rightHTML('assembly');
  }
  applySceneState();
  updateStatus();
}

function adoptConstraint(id) {
  const suggestion = findConstraintSuggestion(id);
  if (!suggestion) return { ok: false, message: `约束不存在：${id}` };
  if (state.constraints.some(c => c.id === id)) return { ok: true };
  if (state.ignoredConstraints.includes(id)) return { ok: false, message: `约束已忽略：${id}` };
  const node = findNode(suggestion.part);
  if (!node) return { ok: false, message: `零件不存在：${suggestion.part}` };
  const prevDof = Math.max(0, Number(node.dof) || 0);
  const nextDof = Math.max(0, prevDof - 1);
  const record = {
    id: suggestion.id,
    part: suggestion.part,
    model: suggestion.model,
    type: suggestion.type,
    label: suggestion.label,
  };
  const apply = () => {
    if (!state.constraints.some(c => c.id === id)) state.constraints.push({ ...record });
    const current = findNode(suggestion.part);
    if (current) current.dof = String(nextDof);
  };
  const remove = () => {
    state.constraints = state.constraints.filter(c => c.id !== id);
    const current = findNode(suggestion.part);
    if (current) current.dof = String(prevDof);
  };
  apply();
  pushHistory({
    label: `采用约束 ${suggestion.label}`,
    undo: () => { remove(); refreshConstraintUI(suggestion.part); },
    redo: () => { apply(); refreshConstraintUI(suggestion.part); },
  });
  refreshConstraintUI(suggestion.part);
  statusMsg(`已采用约束：${suggestion.label}`);
  toast(`已采用约束：${suggestion.label}`);
  return { ok: true };
}

function ignoreConstraint(id) {
  const suggestion = findConstraintSuggestion(id);
  if (!suggestion) return { ok: false, message: `约束不存在：${id}` };
  if (state.constraints.some(c => c.id === id)) return { ok: false, message: '约束已采用，无法忽略' };
  if (state.ignoredConstraints.includes(id)) return { ok: true };
  const apply = () => { if (!state.ignoredConstraints.includes(id)) state.ignoredConstraints.push(id); };
  const remove = () => { state.ignoredConstraints = state.ignoredConstraints.filter(item => item !== id); };
  apply();
  pushHistory({
    label: `忽略约束 ${suggestion.label}`,
    undo: () => { remove(); refreshConstraintUI(suggestion.part); },
    redo: () => { apply(); refreshConstraintUI(suggestion.part); },
  });
  refreshConstraintUI(suggestion.part);
  statusMsg(`已忽略约束：${suggestion.label}`);
  return { ok: true };
}

function nextInsertedId() {
  let id;
  do {
    state.insertSeq += 1;
    id = `ins${state.insertSeq}`;
  } while (findNode(id) || PARTS[id]);
  return id;
}

function overlapsAabb(a, b) {
  return a[0] < b[3] && a[3] > b[0] && a[1] < b[4] && a[4] > b[1] && a[2] < b[5] && a[5] > b[2];
}

function findFreePlacement() {
  const w = 20, d = 20, h = 20;
  const occupied = SCENE_OCCUPANCY.slice();
  state.insertedParts.forEach(p => occupied.push([p.x, p.y, p.z, p.x + p.w, p.y + p.d, p.z + p.h]));
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      const candidate = { x: 4 + col * 40, y: 2 + row * 14, z: 8, w, d, h };
      const bounds = [candidate.x, candidate.y, candidate.z, candidate.x + w, candidate.y + d, candidate.z + h];
      if (!occupied.some(item => overlapsAabb(bounds, item))) return candidate;
    }
  }
  const index = state.insertedParts.length;
  return { x: 4 + (index % 5) * 40, y: 2 + (Math.floor(index / 5) % 5) * 14, z: 8 + Math.floor(index / 25) * h, w, d, h };
}

function genericPartDefinition(lib) {
  return {
    name: lib.model,
    code: lib.model,
    tag: '标准件',
    groups: [
      { title: '基本', fields: [
        { k: '型号', v: lib.model, mono: true, ro: true },
        { k: '品牌', v: lib.brand, ro: true },
        { k: '类别', v: lib.cat, ro: true },
        { k: '数量', v: '1', mono: true, ro: true },
      ] },
      { title: '材料与工艺', fields: [
        { k: '材料', v: '—', ro: true },
      ] },
      { title: '装配关系', fields: [
        { k: '自由度', v: '2', mono: true, ro: true },
      ] },
    ],
  };
}

function addInsertedPartRecord(lib, id, placement) {
  const group = findNode('g-std');
  if (!group) throw new Error('标准件组不存在');
  if (findNode(id) || PARTS[id]) return;
  const node = { id, label: lib.model, kind: 'part', part: id, meta: lib.brand, dof: '2' };
  group.children = group.children || [];
  group.children.push(node);
  group.meta = String((Number(group.meta) || 0) + 1);
  PARTS[id] = genericPartDefinition(lib);
  state.values[id] = {};
  const tone = lib.cat === '气缸' ? 'steel' : lib.cat === '导轨' ? 'rail' : 'car';
  state.insertedParts.push({ id, model: lib.model, ...placement, tone });
  state.constraintSuggestions[id] = makeConstraintSuggestions(id, lib);
  NODE_PATH[id] = ['装配', '标准件'];
  COORDS[id] = [placement.x + placement.w / 2, placement.y + placement.d / 2, placement.z + placement.h / 2];
}

function removeInsertedPartRecord(id) {
  const group = findNode('g-std');
  if (group && group.children) {
    const before = group.children.length;
    group.children = group.children.filter(node => node.id !== id);
    if (group.children.length !== before) group.meta = String(Math.max(0, (Number(group.meta) || 0) - 1));
  }
  delete PARTS[id];
  delete state.values[id];
  delete NODE_PATH[id];
  delete COORDS[id];
  delete state.constraintSuggestions[id];
  state.insertedParts = state.insertedParts.filter(part => part.id !== id);
  state.constraints = state.constraints.filter(item => item.part !== id);
  state.ignoredConstraints = state.ignoredConstraints.filter(item => !String(item).startsWith(`${id}-`));
}

function insertLibPart(model) {
  const lib = LIB.find(item => item.model === model);
  if (!lib) return { ok: false, message: `型号不存在：${model}` };
  try {
    const id = nextInsertedId();
    const placement = findFreePlacement();
    const previous = {
      part: state.selectedPart,
      node: state.selNode,
      stdOpen: Object.prototype.hasOwnProperty.call(state.treeOpen, 'g-std') ? state.treeOpen['g-std'] : undefined,
    };
    addInsertedPartRecord(lib, id, placement);
    state.treeOpen['g-std'] = true;
    setView('assembly');
    mountScenes();
    selectPart(id, id);
    updateAssemblyCounters();
    pushHistory({
      label: `插入 ${lib.model}`,
      undo: () => {
        removeInsertedPartRecord(id);
        if (previous.stdOpen === undefined) delete state.treeOpen['g-std'];
        else state.treeOpen['g-std'] = previous.stdOpen;
        const fallbackPart = findNode(previous.part) ? previous.part : 'cyl';
        const fallbackNode = findNode(previous.node) ? previous.node : fallbackPart;
        mountScenes();
        selectPart(fallbackPart, fallbackNode);
        updateAssemblyCounters();
      },
      redo: () => {
        addInsertedPartRecord(lib, id, placement);
        state.treeOpen['g-std'] = true;
        setView('assembly');
        mountScenes();
        selectPart(id, id);
        updateAssemblyCounters();
      },
    });
    toast(`已插入 ${lib.model}`);
    statusMsg(`已插入 ${lib.model}，等待约束确认`);
    return { ok: true, id, label: lib.model };
  } catch (error) {
    return { ok: false, message: `插入失败：${error && error.message ? error.message : error}` };
  }
}

/* ---------------------------------------------------------------- 3D 挂载 */
function mountScene(target, cfg) {
  const el = $(target);
  if (!el) return;
  const { svg, viewBox } = buildScene(cfg);
  el.setAttribute('viewBox', viewBox);
  el.innerHTML = svg;
}
function mountScenes() {
  const cfg = { bore: Number(state.values.cyl.bore), stroke: Number(state.values.cyl.stroke) };
  mountScene('#scene3d', cfg);
  mountScene('#sceneCheck', Object.assign({ section: true }, cfg));
  applySceneState();
}

/* ---------------------------------------------------------------- 干涉步进 */
function applyIssue(idx, silent) {
  state.issueIdx = (idx + ISSUES.length) % ISSUES.length;
  const it = ISSUES[state.issueIdx];
  state.hitPart = it.part;
  applySceneState();

  /* 列表 */
  $$('.issue').forEach((row, i) => row.classList.toggle('is-sel', i === state.issueIdx));
  const active = $(`.issue[data-issue="${state.issueIdx}"]`);
  if (active && !silent) active.scrollIntoView({ block: 'nearest' });

  /* 详情 */
  const right = $('[data-panel="right"][data-for="check"]');
  if (right) right.innerHTML = rightHTML('check');

  /* 状态栏 */
  $('#stCheck').textContent = `第 ${state.issueIdx + 1}/${ISSUES.length} 处`;
  $('#ctxCheckIdx').textContent = `${state.issueIdx + 1} / ${ISSUES.length}`;

  /* 视口气泡 */
  const callout = $('#checkCallout');
  callout.hidden = false;
  callout.style.left = it.x + '%';
  callout.style.top = it.y + '%';
  $('#checkCalloutText').textContent = `${SEV_LABEL[it.sev]} · ${it.sub}`;
  callout.style.borderColor = it.sev === 'error' ? 'rgba(240,68,56,.55)'
    : it.sev === 'warning' ? 'rgba(245,165,36,.55)' : 'rgba(78,156,245,.55)';
}

/* ---------------------------------------------------------------- 命令面板 */
const CMDS = [
  { label: '切换到 装配工作台', grp: '视图', icon: 'cube', run: () => setView('assembly') },
  { label: '切换到 选型计算', grp: '视图', icon: 'calc', run: () => setView('sizing') },
  { label: '切换到 标准件库', grp: '视图', icon: 'lib', run: () => setView('library') },
  { label: '切换到 干涉校核', grp: '视图', icon: 'alert', run: () => setView('check') },
  { label: '切换到 出图与 BOM', grp: '视图', icon: 'sheet', run: () => setView('drafting') },
  { label: '缩放到适合', grp: '视图', icon: 'fit', run: () => doFit() },
  { label: '运行干涉校核', grp: '命令', icon: 'check', run: () => { setView('check'); applyIssue(0); toast('校核完成：7 处结果'); } },
  { label: '导出 BOM 为 CSV', grp: '命令', icon: 'download', run: () => toast('BOM 已导出：ASM-001-BOM.csv') },
];
let palOpen = false, palIdx = 0, palFiltered = CMDS.slice();

function renderPalette() {
  $('#paletteList').innerHTML = palFiltered.map((c, i) => `
    <li class="pcmd ${i === palIdx ? 'is-active' : ''}" data-pcmd="${i}" role="option" aria-selected="${i === palIdx}">
      ${ICON[c.icon] || ICON.dot}<span>${c.label}</span><span class="grp">${c.grp}</span>
    </li>`).join('') || `<li class="pcmd" style="color:var(--text-3);cursor:default">无匹配命令</li>`;
}
function openPalette() {
  palOpen = true;
  palIdx = 0;
  palFiltered = CMDS.slice();
  $('#palette').hidden = false;
  const input = $('#paletteInput');
  input.value = '';
  renderPalette();
  input.focus();
}
function closePalette() {
  palOpen = false;
  $('#palette').hidden = true;
}
function paletteMove(d) {
  if (!palFiltered.length) return;
  palIdx = (palIdx + d + palFiltered.length) % palFiltered.length;
  renderPalette();
  const el = $(`.pcmd[data-pcmd="${palIdx}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function paletteRun(i) {
  const c = palFiltered[i];
  if (!c) return;
  closePalette();
  c.run();
  toast(`已执行：${c.label}`);
}

/* ---------------------------------------------------------------- 缩放适合 */
function doFit() {
  toast('已缩放到适合');
  statusMsg('缩放到适合：视图已适配视口 (F)');
}

/* ---------------------------------------------------------------- 框选 */
function bindMarquee(stage, box) {
  if (!stage || !box) return;
  let start = null, active = false;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.vp-tools, .vp-hud, .vp-hint, .vp-axis, .vp-callout')) return;
    // 3D 视口有自己的 OrbitControls 与框选：这里再 setPointerCapture 会把指针从画布抢到 stage 上，
    // 画布再也收不到 pointerup，OrbitControls 内部状态永久停在 ROTATE（按住没反应 / 滚轮失效 /
    // 不按键也跟动）。所以 3D 画布及其内部元素一律不接管。
    if (e.target.closest('.orbit-canvas') || e.target.tagName === 'CANVAS') return;
    start = { x: e.clientX, y: e.clientY };
    active = false;
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!active && Math.hypot(dx, dy) < 5) return;
    active = true;
    const r = stage.getBoundingClientRect();
    box.hidden = false;
    box.style.left = Math.min(start.x, e.clientX) - r.left + 'px';
    box.style.top = Math.min(start.y, e.clientY) - r.top + 'px';
    box.style.width = Math.abs(dx) + 'px';
    box.style.height = Math.abs(dy) + 'px';
  });
  stage.addEventListener('pointerup', e => {
    if (!start) return;
    const was = active;
    start = null; active = false;
    if (!was) { box.hidden = true; return; }
    state.justMarqueed = performance.now();
    const r = box.getBoundingClientRect();
    box.hidden = true;
    const scene = $('.scene', stage);
    const hits = $$('.part', scene).filter(g => {
      const b = g.getBoundingClientRect();
      return !(b.right < r.left || b.left > r.right || b.bottom < r.top || b.top > r.bottom);
    }).map(g => g.dataset.part);
    if (hits.length) {
      state.multi = hits;
      applySceneState();
      statusMsg(`已选中 ${hits.length} 个对象`);
      toast(`框选：${hits.length} 个对象`);
    } else {
      statusMsg('框选结束：未命中对象');
    }
  });
}

/* ---------------------------------------------------------------- 事件绑定 */
function bind() {
  /* 顶部模式 */
  $$('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  /* 全局点击委托 */
  document.addEventListener('click', e => {
    const t = e.target;

    /* 左栏 tab */
    const tab = t.closest('[data-tab]');
    if (tab) { setView(tab.dataset.tab); return; }

    /* 上下文工具条：激活态 */
    const tool = t.closest('.tool');
    if (tool && !tool.dataset.act) {
      const grp = tool.parentElement;
      $$('.tool', grp).forEach(x => x.classList.remove('is-active'));
      tool.classList.add('is-active');
      return;
    }

    /* 视口工具 */
    const vp = t.closest('[data-vp]');
    if (vp) {
      const act = vp.dataset.act;
      if (act === 'fit') doFit();
      else if (act === 'prev') applyIssue(state.issueIdx - 1);
      else if (act === 'next') applyIssue(state.issueIdx + 1);
      else {
        $$('[data-vp]', vp.parentElement).forEach(x => x.classList.remove('is-active'));
        vp.classList.add('is-active');
      }
      return;
    }

    /* 结构树 */
    const tw = t.closest('[data-tw]');
    if (tw) {
      const id = tw.dataset.tw;
      const cur = state.treeOpen[id];
      const node = findNode(id);
      state.treeOpen[id] = cur === undefined ? !(node && node.open !== false) : !cur;
      const body = $('[data-panel="left"][data-for="assembly"] .panel-body');
      if (body) body.innerHTML = treeHTML();
      return;
    }
    const nodeRow = t.closest('[data-node]');
    if (nodeRow) {
      const id = nodeRow.dataset.node;
      const part = nodeRow.dataset.part;
      if (part) selectPart(part, id);
      else {
        state.selNode = id;
        const body = $('[data-panel="left"][data-for="assembly"] .panel-body');
        if (body) body.innerHTML = treeHTML();
        updateStatus();
        toast('文件夹：包含 12 项标准件');
      }
      return;
    }

    /* 属性分组折叠 */
    const ph = t.closest('[data-pgroup-head]');
    if (ph) { ph.parentElement.classList.toggle('is-collapsed'); return; }

    /* 干涉项 */
    const issue = t.closest('[data-issue]');
    if (issue) { applyIssue(Number(issue.dataset.issue)); return; }

    /* 推荐型号 */
    const reco = t.closest('[data-reco]');
    if (reco) {
      $$('.reco').forEach(r => r.classList.remove('is-sel'));
      reco.classList.add('is-sel');
      toast('已选中 ' + reco.querySelector('.pn').textContent);
      return;
    }

    /* 约束建议 */
    const acceptConstraintBtn = t.closest('[data-constraint-accept]');
    if (acceptConstraintBtn) { adoptConstraint(acceptConstraintBtn.dataset.constraintAccept); return; }
    const ignoreConstraintBtn = t.closest('[data-constraint-ignore]');
    if (ignoreConstraintBtn) { ignoreConstraint(ignoreConstraintBtn.dataset.constraintIgnore); return; }

    /* 标准件库行 */
    const libRow = t.closest('[data-lib]');
    if (libRow) {
      const m = LIB.find(x => x.model === libRow.dataset.lib);
      if (m) {
        state.libSel = m;
        $$('[data-lib]').forEach(row => row.classList.toggle('is-sel', row.dataset.lib === m.model));
        const right = $('[data-panel="right"][data-for="library"]');
        if (right) right.innerHTML = rightHTML('library');
      }
      return;
    }
    /* 排序 */
    const th = t.closest('[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (state.libSort.key === k) state.libSort.dir *= -1;
      else state.libSort = { key: k, dir: 1 };
      renderLibrary();
      return;
    }

    /* 品牌 / 品类 */
    const cat = t.closest('[data-cat]');
    if (cat) {
      $$('.cat-row').forEach(c => c.classList.remove('is-sel'));
      cat.classList.add('is-sel');
      state.libCat = cat.dataset.cat;
      renderLibrary();
      statusMsg(`已筛选品类：${state.libCat}`);
      return;
    }

    /* 树工具 */
    if (t.closest('[data-tree-open]')) {
      state.treeOpen = {};
      const body = $('[data-panel="left"][data-for="assembly"] .panel-body');
      if (body) body.innerHTML = treeHTML();
      return;
    }

    /* 命令面板行 */
    const pcmd = t.closest('[data-pcmd]');
    if (pcmd) { paletteRun(Number(pcmd.dataset.pcmd)); return; }

    /* 分段控件 */
    const seg = t.closest('[data-seg]');
    if (seg) {
      $$('[data-seg]', seg.parentElement).forEach(x => x.classList.remove('is-active'));
      seg.classList.add('is-active');
      statusMsg('工况预设：' + seg.textContent);
      return;
    }

    /* 通用动作 */
    const act = t.closest('[data-act]');
    if (act) { handleAct(act.dataset.act); return; }

    /* 文件名菜单 → 工程列表（userData/projects，由 CAD 覆盖层的 AutomationCadProjects 提供） */
  if (t.closest('#fileBtn')) {
    toggleFileMenu();
    return;
  }
  const projItem = t.closest('[data-project-open]');
  if (projItem) {
    const id = projItem.dataset.projectOpen;
    closeFileMenu();
    const api = window.AutomationCadProjects;
    if (!api) { toast('工程接口未就绪', 'warn'); return; }
    Promise.resolve(api.open(id))
      .then((record) => {
        if (!record) { toast('工程打开失败，看 CAD 视图里的提示', 'warn'); return; }
        applyProjectStage(record);
        syncFileName();
        // 选了工程就直接进 CAD 视图，不停在外壳画布
        if (api.show) api.show();
        statusMsg('已打开工程：' + record.name);
      })
      .catch((error) => toast('打开工程失败：' + (error && error.message ? error.message : error), 'warn'));
    return;
  }
  if (t.closest('[data-project-reopen]')) {
    const api = window.AutomationCadProjects;
    const id = api && api.currentId ? api.currentId() : null;
    const target = id || (currentProjectRecord && currentProjectRecord.id);
    if (!target) { toast('没有选中的工程', 'warn'); return; }
    Promise.resolve(api.open(target)).then((record) => { if (record) { applyProjectStage(record); syncFileName(); } });
    return;
  }
  const projDel = t.closest('[data-project-delete]');
  if (projDel) {
    const id = projDel.dataset.projectDelete;
    const api = window.AutomationCadProjects;
    if (!api) return;
    Promise.resolve(api.remove(id)).then(() => { renderFileMenu(); statusMsg('已删除工程：' + id); });
    return;
  }
  if (!t.closest('.file-menu-wrap')) closeFileMenu();

  /* 顶部右侧按钮 */
    const tbtn = t.closest('.tbtn');
    if (tbtn) {
      const a = tbtn.dataset.act;
      if (a === 'help') openPalette();
      else if (a === 'measure') { toast('测量工具已激活：拾取两点'); statusMsg('测量：请拾取第一点'); }
      else { toast('显示设置：着色 + 边线'); }
      return;
    }
  });

  /* 属性输入 */
  document.addEventListener('input', e => {
    const el = e.target;

    /* 3D 属性 */
    if (el.dataset.field && el.dataset.part) {
      const pid = el.dataset.part, key = el.dataset.field;
      const prev = state.values[pid][key];
      flashField(el);
      if (String(prev) === String(el.value)) return;
      commitField(pid, key, el.value, prev, el);
      return;
    }

    /* 选型参数 */
    if (el.dataset.sizing) {
      const key = el.dataset.sizing;
      const raw = el.type === 'number' ? Number(el.value) : el.value;
      if (el.type === 'number' && !isFinite(raw)) return;
      state.sizing[key] = raw;
      sizingCommit();
      return;
    }

    /* 库搜索 */
    if (el.dataset.libSearch !== undefined || el.hasAttribute('data-lib-search')) {
      const q = el.value.trim().toLowerCase();
      const rows = LIB.filter(r => !state.libCat || r.cat === state.libCat)
        .filter(r => !q || (r.model + r.brand + r.cat).toLowerCase().includes(q));
      $$('[data-lib]').forEach(tr => {
        tr.style.display = rows.some(r => r.model === tr.dataset.lib) ? '' : 'none';
      });
    }
  });

  /* 命令面板输入 */
  $('#paletteInput').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    palFiltered = CMDS.filter(c => c.label.toLowerCase().includes(q) || c.grp.toLowerCase().includes(q));
    palIdx = 0;
    renderPalette();
  });
  $('#palette').addEventListener('mousedown', e => { if (e.target.id === 'palette') closePalette(); });

  /* 提示气泡：点击整体或关闭按钮都收起 */
  const closeHint = () => {
    if ($('#hint').hidden) return;
    $('#hint').hidden = true;
    statusMsg('提示已关闭，可从标准件库拖入零件');
  };
  $('#hint').addEventListener('click', closeHint);
  $('#hintClose').addEventListener('click', e => { e.stopPropagation(); closeHint(); });

  /* 标准件库拖放 */
  document.addEventListener('dragstart', e => {
    const row = e.target.closest('[data-lib]');
    if (!row || !e.dataTransfer) return;
    e.dataTransfer.setData('application/x-lib-model', row.dataset.lib);
    e.dataTransfer.setData('text/plain', row.dataset.lib);
    e.dataTransfer.effectAllowed = 'copy';
  });
  document.addEventListener('dblclick', e => {
    const row = e.target.closest('[data-lib]');
    if (row) insertLibPart(row.dataset.lib);
  });
  ['#stageAssembly', '#stageCheck'].forEach(sel => {
    const st = $(sel);
    if (!st) return;
    st.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      st.classList.add('is-dragover');
    });
    st.addEventListener('dragleave', e => {
      if (!st.contains(e.relatedTarget)) st.classList.remove('is-dragover');
    });
    st.addEventListener('drop', e => {
      e.preventDefault();
      st.classList.remove('is-dragover');
      const model = e.dataTransfer ? e.dataTransfer.getData('application/x-lib-model') : '';
      if (model) insertLibPart(model);
      else statusMsg('未识别拖入的零件型号');
    });
  });

  /* 3D 零件点击 */
  ['#stageAssembly', '#stageCheck'].forEach(s => {
    const stage = $(s);
    if (!stage) return;
    stage.addEventListener('click', e => {
      if (performance.now() - (state.justMarqueed || 0) < 140) return;
      const g = e.target.closest('.part');
      if (!g) return;
      if (state.view === 'check') {
        const idx = ISSUES.findIndex(i => i.part === g.dataset.part);
        if (idx >= 0) applyIssue(idx);
        return;
      }
      selectPart(g.dataset.part, g.dataset.part);
    });
    /* hover 预览 */
    stage.addEventListener('mouseover', e => {
      const g = e.target.closest('.part');
      if (!g) return;
      state.hoverPart = g.dataset.part;
      applySceneState();
    });
    stage.addEventListener('mouseleave', () => { state.hoverPart = null; applySceneState(); });
  });

  /* 结构树 hover 联动 */
  document.addEventListener('mouseover', e => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const p = row.dataset.part;
    if (!p) return;
    state.hoverPart = p;
    applySceneState();
  });
  document.addEventListener('mouseout', e => {
    if (!e.target.closest('.tree-row')) return;
    state.hoverPart = null;
    applySceneState();
  });

  /* 键盘 */
  document.addEventListener('keydown', e => {
    const typing = /input|textarea|select/i.test((e.target.tagName || ''));

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palOpen ? closePalette() : openPalette();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const shortcut = e.key.toLowerCase();
      if (shortcut === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoAction();
        else undoAction();
        return;
      }
      if (shortcut === 'y') {
        e.preventDefault();
        redoAction();
        return;
      }
    }
    if (palOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); paletteRun(palIdx); }
      return;
    }
    if (e.key === 'Escape') {
      if (typing) { e.target.blur(); }
      state.multi = [];
      state.hitPart = null;
      applySceneState();
      statusMsg('已取消当前操作');
      toast('已取消当前操作', 'warn');
      return;
    }
    if (!typing && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      doFit();
    }
  });

  /* 框选 */
  bindMarquee($('#stageAssembly'), $('#marquee'));
  bindMarquee($('#stageCheck'), $('#marquee2'));

  /* 阻止浏览器直接打开被拖入的文件 */
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

const sizingCommit = debounce(() => {
  renderSizing();
  const right = $('[data-panel="right"][data-for="sizing"]');
  if (right) right.innerHTML = rightHTML('sizing');
  statusMsg('估算已更新');
}, 150);

function findNode(id) {
  let found = null;
  (function walk(list) {
    list.forEach(n => { if (n.id === id) found = n; if (n.children) walk(n.children); });
  })(TREE);
  return found;
}

function handleAct(a) {
  switch (a) {
    case 'fit': doFit(); break;
    case 'prev': applyIssue(state.issueIdx - 1); break;
    case 'next': applyIssue(state.issueIdx + 1); break;
    case 'calc': sizingCommit(); toast('估算已刷新'); break;
    case 'apply':
      toast('已应用到同系列 3 个零件');
      statusMsg('属性已批量应用');
      break;
    case 'apply-reco': {
      const r = sizingCalc(state.sizing);
      toast(`已应用 ${r.recos[0].model}`);
      statusMsg(`型号写入：${r.recos[0].model}`);
      break;
    }
    case 'apply-sizing': {
      const r = sizingCalc(state.sizing);
      state.values.cyl.bore = String(r.rec);
      state.values.cyl.stroke = String(Math.round(state.sizing.stroke));
      mountScenes();
      const right = $('[data-panel="right"][data-for="assembly"]');
      if (right) right.innerHTML = rightHTML('assembly');
      toast(`已写入装配：φ${r.rec} × ${Math.round(state.sizing.stroke)}`);
      statusMsg(`装配参数已更新：缸径 φ${r.rec}`);
      break;
    }
    case 'report': toast('计算书已生成：SIZING-032.pdf'); break;
    case 'insert':
      insertLibPart(state.libSel.model);
      break;
    case 'sync': toast('品牌索引已更新（1,284 条）'); break;
    case 'export': toast('已导出：ASM-001-BOM.csv'); statusMsg('导出完成'); break;
    case 'locate':
      toast('已定位到 ' + ISSUES[state.issueIdx].title);
      statusMsg('视图已缩放至冲突位置');
      break;
    case 'fix':
      toast('已应用修改建议，请重新校核');
      statusMsg('修改已应用：待重新校核');
      break;
    case 'ignore':
      toast('已忽略此项', 'warn');
      break;
    case 'rerun':
      applyIssue(0);
      toast('校核完成：3 严重 / 2 警告 / 2 提示');
      break;
    case 'measure': toast('测量工具已激活'); break;
    default: break;
  }
}

/* ---------------------------------------------------------------- init */
function init() {
  /* 面板骨架 */
  $$('[data-panel]').forEach(p => {
    p.innerHTML = p.dataset.panel === 'left' ? leftHTML(p.dataset.for) : rightHTML(p.dataset.for);
  });

  renderSizing();
  renderLibrary();
  renderSheet();
  mountScenes();
  setupHistoryControls();
  bind();
  updateStatus();
  setView('assembly');
  computedFields('cyl');

  setTimeout(() => statusMsg('就绪 · 选择结构树节点或拖拽框选'), 400);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

/* ---------------------------------------------------------------- 公共 API */
window.ProtoApi = {
  version: 1,
  getTree: () => {
    try { return JSON.parse(JSON.stringify(TREE)); }
    catch (_) { return []; }
  },
  getDofTotal: () => {
    try { return getDofTotal(); }
    catch (_) { return 0; }
  },
  insertPart: (model) => {
    try { return insertLibPart(model); }
    catch (error) { return { ok: false, message: `插入失败：${error && error.message ? error.message : error}` }; }
  },
  undo: () => {
    try { return undoAction(); }
    catch (error) { return { ok: false, message: `撤销失败：${error && error.message ? error.message : error}` }; }
  },
  redo: () => {
    try { return redoAction(); }
    catch (error) { return { ok: false, message: `重做失败：${error && error.message ? error.message : error}` }; }
  },
  listConstraints: () => {
    try { return state.constraints.map(item => ({ ...item })); }
    catch (_) { return []; }
  },
  acceptConstraint: (id) => {
    try { return adoptConstraint(id); }
    catch (error) { return { ok: false, message: `采用约束失败：${error && error.message ? error.message : error}` }; }
  },
};

/** 冷启动：把上次打开的工程卡片恢复到外壳（外壳的演示场景不该抢戏） */
function restoreLastProjectStage() {
  const api = window.AutomationCadProjects;
  if (!api || typeof api.lastOpened !== 'function') return;
  try {
    const record = api.lastOpened();
    if (record) applyProjectStage(record);
  } catch (_error) { /* 忽略：没有最近工程就保持演示场景 */ }
}

/* CAD 视图切回电气域时，外壳给出上下文提示（工程名带过去） */
window.addEventListener('automation-cad-domain', (event) => {
  const detail = (event && event.detail) || {};
  if (detail.domain !== 'elec') return;
  const name = detail.project && detail.project.name ? detail.project.name : '当前工程';
  try { statusMsg('已切到电气域 · 上下文：' + name); } catch (_error) { /* 忽略 */ }
});
