/* ============================================================
   电气设计域扩展 · electrical.js
   ------------------------------------------------------------
   在既有机械域原型之上「加而不改」：
   · 不改 app.js 的任何函数体，仅调用其公开的 setView / state
   · 所有电气 DOM 使用独立类名与 data 属性，避免命中 app.js 的
     全局点击委托（.mode / .tool / [data-tab] / [data-node] /
     [data-lib] / [data-cat] / [data-sort] / [data-seg] / [data-act]）
   · 图纸与柜体全部为内联 SVG，线宽 1px + non-scaling-stroke
   ============================================================ */
'use strict';
(function () {

  /* ------------------------------------------------------------ utils */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const round = (v) => Math.round(v);

  const ICO = {
    chev: '<svg viewBox="0 0 16 16" class="ico"><path d="M6 3.6L10.4 8 6 12.4"/></svg>',
    warn: '<svg viewBox="0 0 16 16" class="ico"><path d="M8 2.4l5.9 10.2H2.1z"/><path d="M8 6.3v3.1"/><circle cx="8" cy="11.2" r=".7" fill="currentColor" stroke="none"/></svg>',
    err: '<svg viewBox="0 0 16 16" class="ico"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>',
    ok: '<svg viewBox="0 0 16 16" class="ico"><path d="M2.6 8.5l3.3 3.3L13.6 3.9"/></svg>',
    page: '<svg viewBox="0 0 16 16" class="ico"><path d="M3 2.4h7l3 3v8.2H3z"/><path d="M10 2.4v3h3"/></svg>',
    folder: '<svg viewBox="0 0 16 16" class="ico"><path d="M2 4.2h4l1.4 1.8H14v6.6H2z"/></svg>',
    go: '<svg viewBox="0 0 16 16" class="ico"><path d="M3 8h9M9 5l3 3-3 3"/></svg>',
    cross: '<svg viewBox="0 0 16 16" class="ico"><path d="M8 2v12M2 8h12"/></svg>',
    pin: '<svg viewBox="0 0 16 16" class="ico"><circle cx="8" cy="8" r="3"/><path d="M8 1v3M8 12v3"/></svg>'
  };

  /* ------------------------------------------------------------ state */
  const ES = {
    domain: 'mech',
    view: 'schematic',
    lastMech: 'assembly',
    /* schematic */
    sym: null, hl: null, chk: null,
    place: null, seq: { Q: 1, K: 1, F: 1, M: 1, S: 1, H: 0, Y: 2, X: 1, A: 1 },
    defs: {},            /* 动态放置元件的属性 */
    split: 0.46,
    /* io */
    io: { sel: null, seg: null, tree: null, adopted: {}, ignored: false },
    /* enclosure */
    enc: {
      W: 800, H: 1200, D: 300, sel: null, comps: [], seq: { Q: 1, K: 1, A: 1, X: 1, G: 1, FN: 1 },
      place: null, drag: null, calc: false, res: { temp: 38, load: 62, margin: 18 }
    }
  };

  /* ------------------------------------------------------------
     机型参数：默认值就是 EL-001（滑台气缸控制柜）的样本值。
     工程图纸由 desktop/src/elec 引擎整页生成后经 setSchematic() 注入，
     这里保留示例值供演示页使用。
     ------------------------------------------------------------ */
  const MACHINE_DEFAULT = {
    kind: 'sample',
    project: '滑台气缸控制柜',
    drawingNo: 'EL-001',
    page: '3 / 12',
    breaker: { tag: '-QF1', model: 'iC65N 3P D32', spec: '32A' },
    contactor: { tag: '-KM1', model: 'LC1D18', spec: '18A' },
    thermal: { tag: '-FR1', model: 'LRD21', spec: '12–18A' },
    motor: { tag: '-M1', model: 'Y2-90L-4', power: '2.2kW' },
    devices: [
      ['-QF1', '断路器', '1'],
      ['-KM1', '接触器', '1'],
      ['-FR1', '热继电器', '1'],
      ['-M1', '三相异步电机', '1'],
      ['-SB1', '急停按钮', '1'],
      ['-KA1', '安全继电器', '1'],
      ['-A1', 'PLC 输出模块', '1'],
      ['-YV1/-YV2', '电磁阀线圈', '2'],
      ['-X1', '端子排', '1']
    ],
    io: []
  };
  let MACHINE = MACHINE_DEFAULT;
  /** 页码唯一来源：注入工程图纸后以 ES.machine.page 为准，示例页才回落 3/12 */
  const pageLabel = () => (ES.machine && ES.machine.page) || MACHINE.page || '3 / 12';
  const mc = (key, field) => (MACHINE && MACHINE[key] && MACHINE[key][field] != null ? MACHINE[key][field] : MACHINE_DEFAULT[key][field]);
  const mtag = (key) => (MACHINE && MACHINE[key] && MACHINE[key].tag) || MACHINE_DEFAULT[key].tag;

  /* ============================================================
     一、域切换器 / 模式组 / 上下文条
     ============================================================ */

  const ELEC_VIEWS = [
    { v: 'schematic', label: '原理图', ctx: 'schematic' },
    { v: 'io', label: 'IO 规划', ctx: 'io' },
    { v: 'enclosure', label: '柜体布置', ctx: 'enclosure' }
  ];

  function buildChrome() {
    /* 电气模式按钮组（独立类名 .emode，不命中 app.js 的 .mode 委托） */
    const nav = $('#modesElec');
    if (nav && !nav.dataset.built) {
      nav.innerHTML = ELEC_VIEWS.map(m =>
        `<button type="button" class="emode" data-emode="${m.v}" role="tab" aria-selected="false">${m.label}</button>`
      ).join('');
      nav.dataset.built = '1';
    }

    /* 电气上下文工具条：追加到 #ctxbar，默认隐藏 */
    const bar = $('#ctxbar');
    if (bar && !$('#ctxSchematic')) {
      bar.insertAdjacentHTML('beforeend', `
        <div class="ctx" data-ctx="schematic" id="ctxSchematic" hidden>
          <button class="tool is-active" type="button" data-etool>选择</button>
          <button class="tool" type="button" data-etool>画导线</button>
          <button class="tool" type="button" data-etool>放置端子</button>
          <span class="vsep"></span>
          <button class="tool" type="button" data-eact="check">${ICO.ok}校验</button>
          <button class="tool" type="button" data-eact="xref">交叉引用</button>
          <span class="vsep"></span>
          <label class="switch"><input type="checkbox" checked><span>栅格 4mm</span></label>
          <label class="switch"><input type="checkbox" checked><span>端子号</span></label>
          <div class="ctx-right"><span class="ctx-mono" id="elCtxPage">A3 420×297 · 1:1 · 页 ${pageLabel()}</span></div>
        </div>`, bar);
      bar.insertAdjacentHTML('beforeend', `
        <div class="ctx" data-ctx="io" id="ctxIo" hidden>
          <button class="tool is-active" type="button" data-etool>全部点位</button>
          <button class="tool" type="button" data-etool>按柜分组</button>
          <button class="tool" type="button" data-etool>按执行器</button>
          <span class="vsep"></span>
          <button class="tool" type="button" data-eact="io-sync">${ICO.ok}从机械同步</button>
          <button class="tool" type="button" data-eact="io-export">导出地址表</button>
          <div class="ctx-right"><span class="ctx-mono">PLC 型号 S7-1200 · 24 DI / 16 DO</span></div>
        </div>`, bar);
      bar.insertAdjacentHTML('beforeend', `
        <div class="ctx" data-ctx="enclosure" id="ctxEnclosure" hidden>
          <button class="tool is-active" type="button" data-etool>正视图</button>
          <button class="tool" type="button" data-etool>侧视图</button>
          <span class="vsep"></span>
          <label class="switch"><input type="checkbox" checked><span>吸附导轨</span></label>
          <label class="switch"><input type="checkbox" checked><span>有效区</span></label>
          <span class="vsep"></span>
          <button class="tool" type="button" data-eact="en-calc">${ICO.ok}重新校核</button>
          <div class="ctx-right"><span class="ctx-mono" id="enCtxScale">1:10 · 800×1200×300</span></div>
        </div>`, bar);
    }
  }

  function setDomain(d) {
    if (ES.domain === d) return;
    if (window.state && window.state.view) ES.lastMech = window.state.view;
    ES.domain = d;
    document.body.dataset.domain = d;

    const modes = $('#modes'), modesE = $('#modesElec'), st = $('.statusbar');
    if (modes) modes.hidden = d === 'elec';
    if (modesE) modesE.hidden = d !== 'elec';
    $$('.domsw-btn').forEach(b => b.classList.toggle('is-active', b.dataset.domain === d));
    if (st) st.classList.toggle('is-elec', d === 'elec');
    const stE = $('#stElec');
    if (stE) stE.hidden = d !== 'elec';

    if (d === 'elec') {
      showElecView(ES.view);
    } else {
      /* 交还给机械域：调用 app.js 原有的 setView，行为零改动 */
      $$('.view').forEach(s => { if (s.dataset.domain === 'elec') s.hidden = true; });
      $$('.ctx').forEach(c => { if (c.dataset.ctx) c.hidden = true; });
      const v = ES.lastMech || 'assembly';
      if (typeof window.setView === 'function') window.setView(v);
      else {
        const b = $('.mode[data-mode="' + (v === 'sizing' ? 'model' : v) + '"]');
        if (b) b.click();
      }
    }
  }

  function showElecView(v) {
    ES.view = v;
    $$('.view').forEach(s => { s.hidden = s.dataset.view !== v; });
    $$('.ctx').forEach(c => { if (c.dataset.ctx) c.hidden = c.dataset.ctx !== v; });
    $$('.emode').forEach(b => {
      const on = b.dataset.emode === v;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on);
    });
    if (v === 'schematic') statusSchematic();
    if (v === 'io') { ioTailFill(); renderIoRight(); statusIo(); }
    if (v === 'enclosure') { renderEnclosure(); renderEncRight(); }
  }

  /* 状态栏信息位 */
  function statusSlots(a, b, badge) {
    const ea = $('#stElA'), eb = $('#stElB'), bd = $('#stElBadge');
    if (ea) ea.textContent = a || '—';
    if (eb) eb.textContent = b || '—';
    if (bd) {
      if (!badge) { bd.hidden = true; return; }
      bd.hidden = false;
      bd.dataset.tone = badge.tone;
      bd.innerHTML = '<span class="badge-dot"></span>' + badge.text;
    }
  }
  function statusSchematic() {
    const el = $('#stElView');
    if (el) el.textContent = '电气 · 原理图';
    const d = ES.sym ? (ES.defs[ES.sym] || SYMDEF[ES.sym]) : null;
    statusSlots(d ? (d.tag + ' · ' + d.pot) : '未选中元件',
      '页 ' + pageLabel() + ' · A3 420×297 · 比例 1:1',
      { tone: 'ok', text: '交叉引用 ' + XREF.length + ' 条' });
  }
  function statusIo() {
    const el = $('#stElView');
    if (el) el.textContent = '电气 · IO 规划';
    const c = ioCounts();
    statusSlots(ioSummary(c), '上次同步 14:32',
      c.bad ? { tone: 'warn', text: c.bad + ' 处冲突待处理' } : { tone: 'ok', text: '无冲突' });
  }
  function statusEnclosure() {
    const el = $('#stElView');
    if (el) el.textContent = '电气 · 柜体布置';
    const c = ES.enc.comps.filter(x => x.id === ES.enc.sel)[0] || ES.enc.comps[0];
    const x = c ? round(c.x) : 0, y = c ? round(c.y) : 0;
    const r = ES.enc.res;
    statusSlots('X ' + x + ' mm · Y ' + y + ' mm',
      '温升 ' + r.temp + '°C · 载流 ' + r.load + '%',
      r.temp > 45 ? { tone: 'warn', text: '温升超限' } : { tone: 'ok', text: '校核通过' });
  }

  /* ============================================================
     二、电气原理图
     ============================================================ */

  const SYMDEF = {
    qf1: { tag: '-QF1', name: '断路器', model: 'iC65N 3P D32', amp: '32 A', pot: 'L1/L2/L3 · 380V AC', pins: ['1', '2', '3', '4', '5', '6'] },
    km1: { tag: '-KM1', name: '接触器', model: 'LC1D18 · 线圈 24VDC', amp: '18 A', pot: '主触头 380V AC', pins: ['1', '3', '5', '2', '4', '6'] },
    fr1: { tag: '-FR1', name: '热继电器', model: 'LRD21 · 12–18A', amp: '16 A 整定', pot: '380V AC', pins: ['2', '4', '6', '95', '96'] },
    m1: { tag: '-M1', name: '三相异步电机', model: 'Y2-90L-4', amp: '5.2 A', pot: '380V AC 3~', pins: ['U', 'V', 'W', 'PE'] },
    sb1: { tag: '-SB1', name: '急停按钮（蘑菇头）', model: 'XB2-BS542C', amp: '10 A', pot: '24V DC', pins: ['13', '14'] },
    ka1: { tag: '-KA1', name: '安全继电器', model: 'PNOZ X2.8P', amp: '6 A', pot: '24V DC', pins: ['A1', 'A2', '13', '14'] },
    a1: { tag: '-A1', name: 'PLC 输出模块', model: '6ES7 222-1BF22', amp: '2 A / 通道', pot: '24V DC', pins: ['L+', 'M', 'Q0.0', 'Q0.1', 'Q0.4'] },
    yv1: { tag: '-YV1', name: '电磁阀线圈', model: 'SY5120-5LZD', amp: '0.4 A', pot: '24V DC', pins: ['A1', 'A2'] },
    yv2: { tag: '-YV2', name: '电磁阀线圈', model: 'SY5120-5LZD', amp: '0.4 A', pot: '24V DC', pins: ['A1', 'A2'] },
    km1c: { tag: '-KM1', name: '接触器线圈', model: 'LC1D18 · A1/A2', amp: '0.09 A', pot: '24V DC', pins: ['A1', 'A2'] },
    x1: { tag: '-X1', name: '端子排', model: 'UK-2.5B × 8', amp: '24 A', pot: '混合', pins: ['1', '2', '3', '4', '5', '6', '7', '8'] }
  };

  const XREF = [
    { tag: '-KM1', kind: '线圈', pg: '3.2', target: 'km1c' },
    { tag: '-KM1', kind: '触点', pg: '5.4', target: 'km1' },
    { tag: '-KA1', kind: '线圈', pg: '3.1', target: 'ka1' },
    { tag: '-YV1', kind: '线圈', pg: '7.1', target: 'yv1' },
    { tag: '-SB1', kind: '触点', pg: '2.4', target: 'sb1' },
    { tag: '-A1', kind: '模块', pg: '3.3', target: 'a1' }
  ];

  const CHECKS = [
    { id: 'c1', sev: 'warning', t: '电位冲突', d: '-A1:Q0.2 与 -YV2 共用 24V 电源', target: 'a1' },
    { id: 'c2', sev: 'error', t: '未接端子', d: '-X1:7 端子无引出线', target: 'x1' },
    { id: 'c3', sev: 'warning', t: '载流量', d: '-QF1 32A < 计算负载 34.6A', target: 'qf1' }
  ];

  /* 页浏览器 */
  const PAGES = [
    {
      label: '电源', open: true, children: [
        { label: '1.1 主电源进线', meta: 'A3' },
        { label: '1.2 24V 控制电源', meta: 'A3', warn: 1 }
      ]
    },
    {
      label: '主回路', open: true, children: [
        { label: '2.1 主回路总览', meta: 'A3' },
        { label: '2.2 电机回路', meta: 'A3' },
        { label: '2.3 制动回路', meta: 'A3', warn: 2 }
      ]
    },
    {
      label: '控制回路', open: true, children: [
        { label: '3.1 安全与输出回路', meta: 'A3', cur: true },
        { label: '3.2 接触器控制', meta: 'A3' },
        { label: '3.3 手动 / 自动', meta: 'A3' },
        { label: '3.4 报警与复位', meta: 'A3', warn: 2 }
      ]
    },
    {
      label: 'IO', open: false, children: [
        { label: '4.1 数字量输入', meta: 'A3' },
        { label: '4.2 数字量输出', meta: 'A3', warn: 1 }
      ]
    },
    {
      label: '端子', open: false, children: [
        { label: '5.1 端子排 X1', meta: 'A3', warn: 1 }
      ]
    }
  ];

  /* ---- 12 个符号库类目 ---- */
  const LIB_SYM = [
    { key: 'breaker', name: '断路器', prefix: 'Q', model: 'iC65N 3P', amp: '32 A', pot: '380V AC' },
    { key: 'fuse', name: '熔断器', prefix: 'F', model: 'RT18-32', amp: '16 A', pot: '380V AC' },
    { key: 'contactor', name: '接触器触点', prefix: 'K', model: 'LC1D18', amp: '18 A', pot: '380V AC' },
    { key: 'coil', name: '继电器线圈', prefix: 'K', model: 'MY2NJ', amp: '0.05 A', pot: '24V DC' },
    { key: 'thermal', name: '热继电器', prefix: 'F', model: 'LRD21', amp: '16 A', pot: '380V AC' },
    { key: 'motor', name: '电机', prefix: 'M', model: 'Y2-90L-4', amp: '5.2 A', pot: '380V AC' },
    { key: 'button', name: '按钮（常开）', prefix: 'S', model: 'XB2-BA31C', amp: '10 A', pot: '24V DC' },
    { key: 'estop', name: '急停（蘑菇头）', prefix: 'S', model: 'XB2-BS542C', amp: '10 A', pot: '24V DC' },
    { key: 'lamp', name: '指示灯', prefix: 'H', model: 'XB2-BVM3LC', amp: '0.02 A', pot: '24V DC' },
    { key: 'valve', name: '电磁阀线圈', prefix: 'Y', model: 'SY5120-5LZD', amp: '0.4 A', pot: '24V DC' },
    { key: 'terminal', name: '端子', prefix: 'X', model: 'UK-2.5B', amp: '24 A', pot: '—' },
    { key: 'plc', name: 'PLC 模块', prefix: 'A', model: '6ES7 222-1BF22', amp: '2 A/ch', pot: '24V DC' }
  ];

  /* 单个符号（本地坐标 22×30，轴线 x=11） */
  function libSymbol(key) {
    const L = '<line class="ic"';
    let s = '';
    switch (key) {
      case 'breaker':
        s += `${L} x1="11" y1="0" x2="11" y2="7"/><circle class="ic" cx="11" cy="7" r="1.3"/>`;
        s += `${L} x1="11" y1="16" x2="11" y2="30"/>`;
        s += `${L} x1="11" y1="16" x2="17.4" y2="8.2"/>`;
        s += `${L} x1="15.9" y1="6.7" x2="19.2" y2="10"/><line class="ic" x1="19.2" y1="6.7" x2="15.9" y2="10"/>`;
        break;
      case 'fuse':
        s += `${L} x1="11" y1="0" x2="11" y2="9"/><line class="ic" x1="11" y1="21" x2="11" y2="30"/>`;
        s += '<rect class="ic" x="7" y="9" width="8" height="12"/>';
        s += `${L} x1="11" y1="9" x2="11" y2="21"/>`;
        break;
      case 'contactor':
        s += `${L} x1="11" y1="0" x2="11" y2="7"/>`;
        s += `${L} x1="8.6" y1="7" x2="13.4" y2="7"/>`;
        s += `${L} x1="11" y1="16" x2="11" y2="30"/>`;
        s += `${L} x1="11" y1="16" x2="17.4" y2="9.2"/><line class="ic" x1="17.4" y1="9.2" x2="17.4" y2="6.8"/>`;
        break;
      case 'coil':
        s += `${L} x1="11" y1="0" x2="11" y2="9"/><line class="ic" x1="11" y1="21" x2="11" y2="30"/>`;
        s += '<rect class="ic" x="4" y="9" width="14" height="12"/>';
        s += '<text class="it-s" x="11" y="17" text-anchor="middle" style="font-size:5px">KA</text>';
        break;
      case 'thermal':
        s += `${L} x1="11" y1="0" x2="11" y2="8"/><line class="ic" x1="11" y1="22" x2="11" y2="30"/>`;
        s += '<rect class="ic" x="5" y="8" width="12" height="14"/>';
        s += '<path class="ic" d="M7.5 15q1.6-3 3.4 0t3.4 0" style="stroke-width:1"/>';
        break;
      case 'motor':
        s += `${L} x1="11" y1="0" x2="11" y2="8"/><line class="ic" x1="11" y1="22" x2="11" y2="30"/>`;
        s += '<circle class="ic" cx="11" cy="15" r="7.4"/>';
        s += '<text class="it-m" x="11" y="18.2" text-anchor="middle" style="font-size:9px">M</text>';
        break;
      case 'button':
        s += `${L} x1="11" y1="0" x2="11" y2="8"/>`;
        s += `${L} x1="8.6" y1="8" x2="13.4" y2="8"/>`;
        s += `${L} x1="11" y1="17" x2="11" y2="30"/>`;
        s += `${L} x1="11" y1="17" x2="17.2" y2="10.2"/>`;
        s += `${L} x1="11" y1="8" x2="11" y2="4.6"/><line class="ic" x1="7.6" y1="4.6" x2="14.4" y2="4.6"/>`;
        break;
      case 'estop':
        s += `${L} x1="11" y1="0" x2="11" y2="8"/>`;
        s += `${L} x1="8.6" y1="8" x2="13.4" y2="8"/>`;
        s += `${L} x1="11" y1="17" x2="11" y2="30"/>`;
        s += `${L} x1="11" y1="17" x2="17.2" y2="10.2"/>`;
        s += '<path class="ic" d="M5.4 6.4a5.6 4.6 0 0111.2 0"/>';
        s += `${L} x1="5.4" y1="6.4" x2="16.6" y2="6.4"/><line class="ic" x1="11" y1="6.4" x2="11" y2="8"/>`;
        break;
      case 'lamp':
        s += `${L} x1="11" y1="0" x2="11" y2="7.4"/><line class="ic" x1="11" y1="22.6" x2="11" y2="30"/>`;
        s += '<circle class="ic" cx="11" cy="15" r="7.6"/>';
        s += `${L} x1="5.6" y1="9.6" x2="16.4" y2="20.4"/><line class="ic" x1="16.4" y1="9.6" x2="5.6" y2="20.4"/>`;
        break;
      case 'valve':
        s += `${L} x1="11" y1="0" x2="11" y2="9"/><line class="ic" x1="11" y1="21" x2="11" y2="30"/>`;
        s += '<rect class="ic" x="4" y="9" width="14" height="12"/>';
        s += `${L} x1="5.6" y1="19.4" x2="16.4" y2="10.6"/><path class="ic" d="M16.4 10.6l-3.4.5M16.4 10.6l-.5 3.4"/>`;
        break;
      case 'terminal':
        s += `${L} x1="11" y1="0" x2="11" y2="9"/><line class="ic" x1="11" y1="21" x2="11" y2="30"/>`;
        s += '<circle class="ic" cx="11" cy="15" r="4.2"/>';
        break;
      default: /* plc */
        s += `${L} x1="11" y1="0" x2="11" y2="7"/><line class="ic" x1="11" y1="23" x2="11" y2="30"/>`;
        s += '<rect class="ic" x="3.4" y="7" width="15.2" height="16"/>';
        s += `${L} x1="3.4" y1="12" x2="18.6" y2="12"/><line class="ic" x1="3.4" y1="17.4" x2="18.6" y2="17.4"/>`;
        s += '<circle class="if" cx="6.6" cy="9.6" r=".9"/><circle class="if" cx="10" cy="9.6" r=".9"/>';
    }
    return s;
  }

  const libBox = () => ({ w: 22, h: 30 });

  /* ---- 图框 / 分区 / 标题栏 ---- */
  function frameSVG() {
    let s = '<rect class="ic" x="5" y="5" width="410" height="287"/>';
    s += '<rect class="ic" x="10" y="10" width="400" height="277"/>';
    for (let i = 1; i < 8; i++) {
      const x = 10 + i * 50;
      s += `<line class="ic ic-t" x1="${x}" y1="5" x2="${x}" y2="10"/><line class="ic ic-t" x1="${x}" y1="287" x2="${x}" y2="292"/>`;
    }
    for (let n = 0; n < 8; n++) {
      const cx = 35 + n * 50;
      s += `<text class="it-s" x="${cx}" y="8.9" text-anchor="middle">${n + 1}</text>`;
      s += `<text class="it-s" x="${cx}" y="291.6" text-anchor="middle">${n + 1}</text>`;
    }
    for (let r = 1; r < 4; r++) {
      const y = 10 + r * 69.25;
      s += `<line class="ic ic-t" x1="5" y1="${y}" x2="10" y2="${y}"/><line class="ic ic-t" x1="410" y1="${y}" x2="415" y2="${y}"/>`;
    }
    ['A', 'B', 'C', 'D'].forEach((L, i) => {
      const cy = 44.6 + i * 69.25;
      s += `<text class="it-s" x="7.5" y="${cy}" text-anchor="middle">${L}</text>`;
      s += `<text class="it-s" x="412.5" y="${cy}" text-anchor="middle">${L}</text>`;
    });
    return s;
  }

  function titleBlockSVG() {
    const x = 288, y = 237, w = 122, h = 50;
    let s = `<g>
      <rect class="ic" x="${x}" y="${y}" width="${w}" height="${h}"/>
      <line class="ic" x1="${x}" y1="${y + 15}" x2="${x + w}" y2="${y + 15}"/>
      <line class="ic" x1="${x}" y1="${y + 29}" x2="${x + w}" y2="${y + 29}"/>
      <line class="ic" x1="${x}" y1="${y + 39}" x2="${x + w}" y2="${y + 39}"/>
      <line class="ic ic-t" x1="${x + 62}" y1="${y + 15}" x2="${x + 62}" y2="${y + 29}"/>
      <line class="ic ic-t" x1="${x + 46}" y1="${y + 29}" x2="${x + 46}" y2="${y + 39}"/>
      <line class="ic ic-t" x1="${x + 78}" y1="${y + 29}" x2="${x + 78}" y2="${y + 39}"/>
      <line class="ic ic-t" x1="${x + 40}" y1="${y + 39}" x2="${x + 40}" y2="${y + h}"/>
      <line class="ic ic-t" x1="${x + 78}" y1="${y + 39}" x2="${x + 78}" y2="${y + h}"/>
      <text class="it-b" x="${x + 4}" y="${y + 10}">${(MACHINE && MACHINE.project) || '滑台气缸控制柜'} · 电气原理图</text>
      <text class="it" x="${x + w - 4}" y="${y + 10}" text-anchor="end" style="font-size:4.4px">${(MACHINE && MACHINE.drawingNo) || 'EL-001'}</text>
      <text class="it-s" x="${x + 4}" y="${y + 21}">图号</text>
      <text class="it" x="${x + 20}" y="${y + 21.4}" style="font-size:4px">${(MACHINE && MACHINE.drawingNo) || 'EL-001'}</text>
      <text class="it-s" x="${x + 66}" y="${y + 21}">页</text>
      <text class="it" x="${x + 78}" y="${y + 21.4}" style="font-size:4px">${(MACHINE && MACHINE.page) || '3 / 12'}</text>
      <text class="it-s" x="${x + 4}" y="${y + 26}">比例</text>
      <text class="it" x="${x + 20}" y="${y + 26.4}" style="font-size:4px">1:1</text>
      <text class="it-s" x="${x + 66}" y="${y + 26}">幅面</text>
      <text class="it" x="${x + 78}" y="${y + 26.4}" style="font-size:4px">A3</text>
      <text class="it-s" x="${x + 4}" y="${y + 35}">设计</text>
      <text class="it-t" x="${x + 20}" y="${y + 35.4}" style="font-size:3.9px">睿克斯</text>
      <text class="it-s" x="${x + 50}" y="${y + 35}">日期</text>
      <text class="it" x="${x + 62}" y="${y + 35.4}" style="font-size:3.8px">2025-06-12</text>
      <text class="it-s" x="${x + 4}" y="${y + 45}">审核</text>
      <text class="it-t" x="${x + 20}" y="${y + 45.4}" style="font-size:3.9px">李工</text>
      <text class="it-s" x="${x + 44}" y="${y + 45}">版本</text>
      <text class="it" x="${x + 56}" y="${y + 45.4}" style="font-size:3.9px">A</text>
      <text class="it-s" x="${x + 82}" y="${y + 45}">单位</text>
      <text class="it" x="${x + 96}" y="${y + 45.4}" style="font-size:3.9px">mm</text>
    </g>`;
    return s;
  }

  /* ---- 元件包装 ---- */
  function sym(id, box, meta, inner) {
    const p = 2.6;
    const rx = (box[0] - p).toFixed(2), ry = (box[1] - p).toFixed(2);
    const rw = (box[2] + p * 2).toFixed(2), rh = (box[3] + p * 2).toFixed(2);
    return `<g class="esym" data-sym="${id}" data-tag="${meta.tag || ''}" data-pot="${meta.pot || ''}">` +
      `<rect class="ehit" x="${rx}" y="${ry}" width="${rw}" height="${rh}"/>` +
      `<rect class="esel-box" x="${rx}" y="${ry}" width="${rw}" height="${rh}" rx="1.2"/>` +
      inner + '</g>';
  }
  function pin(x, y, num, side) {
    const tx = side === 'r' ? x - 2 : x + 2;
    const anch = side === 'r' ? 'end' : 'start';
    return `<g class="epin"><circle class="pinhit" cx="${x}" cy="${y}" r="3.6"/>` +
      `<circle class="pindot" cx="${x}" cy="${y}" r="1.5"/>` +
      `<text class="pinlbl" x="${tx}" y="${y - 2.2}" text-anchor="${anch}">${num}</text></g>`;
  }

  /* ---- 主回路 ---- */
  function mainCircuitSVG() {
    const busY = [40, 48, 56], x = [68, 84, 100], bx0 = 26, bx1 = 128;
    let s = '<g class="circuit">';
    s += `<text class="it-t" x="26" y="32" style="font-size:4.2px">主回路 ·  AC 380V 50Hz</text>`;
    s += `<line class="ic ic-t" x1="26" y1="35" x2="130" y2="35" style="opacity:.55"/>`;
    for (let i = 0; i < 3; i++) {
      s += `<line class="ic ic-b" x1="${bx0}" y1="${busY[i]}" x2="${bx1}" y2="${busY[i]}"/>`;
      s += `<text class="it" x="${bx0 - 2.5}" y="${busY[i] - 1.8}" text-anchor="end" style="font-size:4.4px">L${i + 1}</text>`;
      s += `<circle class="if" cx="${x[i]}" cy="${busY[i]}" r="1"/>`;
    }
    /* QF1 三极断路器 */
    let q = '';
    for (let i = 0; i < 3; i++) {
      const px = x[i];
      q += `<line class="ic" x1="${px}" y1="${busY[i]}" x2="${px}" y2="72"/>`;
      q += `<circle class="ic" cx="${px}" cy="72" r="1.4"/>`;
      q += `<line class="ic" x1="${px}" y1="86" x2="${px}" y2="100"/>`;
      q += `<line class="ic" x1="${px}" y1="86" x2="${px + 7}" y2="73.6"/>`;
      q += `<line class="ic ic-t" x1="${px + 5.4}" y1="71.9" x2="${px + 8.6}" y2="75.1"/>`;
      q += `<line class="ic ic-t" x1="${px + 8.6}" y1="71.9" x2="${px + 5.4}" y2="75.1"/>`;
    }
    q += `<line class="ic ic-d" x1="${x[0]}" y1="80" x2="${x[2]}" y2="80"/>`;
    q += pin(x[0], 72, '2', 'r') + pin(x[1], 72, '4', 'r') + pin(x[2], 72, '6', 'r');
    q += pin(x[0], 86, '1', 'r') + pin(x[1], 86, '3', 'r') + pin(x[2], 86, '5', 'r');
    q += `<text class="it" x="58" y="80" text-anchor="end" style="font-size:5px">-QF1</text>`;
    q += `<text class="it-s" x="58" y="85" text-anchor="end">${mc('breaker', 'model')} · ${mc('breaker', 'spec')}</text>`;
    s += sym('qf1', [62, 70, 46, 18], SYMDEF.qf1, q);

    /* KM1 主触头 */
    let k = '';
    for (let i = 0; i < 3; i++) {
      const px = x[i];
      k += `<line class="ic" x1="${px}" y1="100" x2="${px}" y2="107"/>`;
      k += `<line class="ic" x1="${px - 2.6}" y1="107" x2="${px + 2.6}" y2="107"/>`;
      k += `<line class="ic" x1="${px}" y1="116" x2="${px}" y2="128"/>`;
      k += `<line class="ic" x1="${px}" y1="116" x2="${px + 7}" y2="109"/>`;
      k += `<line class="ic ic-t" x1="${px + 7}" y1="109" x2="${px + 7}" y2="106.6"/>`;
    }
    k += `<line class="ic ic-d" x1="${x[0]}" y1="110" x2="${x[2]}" y2="110"/>`;
    k += pin(x[0], 100, '1', 'r') + pin(x[1], 100, '3', 'r') + pin(x[2], 100, '5', 'r');
    k += pin(x[0], 116, '2', 'r') + pin(x[1], 116, '4', 'r') + pin(x[2], 116, '6', 'r');
    k += `<text class="it" x="58" y="106" text-anchor="end" style="font-size:5px">-KM1</text>`;
    k += `<text class="it-s" x="58" y="111" text-anchor="end">${mc('contactor', 'model')} · ${mc('contactor', 'spec')}</text>`;
    s += sym('km1', [62, 104, 46, 16], SYMDEF.km1, k);

    /* FR1 热继电器 */
    let f = '';
    for (let i = 0; i < 3; i++) {
      const px = x[i];
      f += `<line class="ic" x1="${px}" y1="128" x2="${px}" y2="130"/>`;
      f += `<rect class="ic" x="${px - 5.5}" y="130" width="11" height="9"/>`;
      f += `<path class="ic ic-t" d="M${px - 3.6} 134.5q1.8-2.6 3.6 0t3.6 0"/>`;
      f += `<line class="ic" x1="${px}" y1="139" x2="${px}" y2="166"/>`;
    }
    f += `<line class="ic ic-d" x1="${x[0]}" y1="145" x2="${x[2]}" y2="145"/>`;
    f += pin(x[0], 139, '2', 'r') + pin(x[1], 139, '4', 'r') + pin(x[2], 139, '6', 'r');
    f += `<text class="it" x="58" y="133" text-anchor="end" style="font-size:5px">-FR1</text>`;
    f += `<text class="it-s" x="58" y="138" text-anchor="end">${mc('thermal', 'model')} · ${mc('thermal', 'spec')}</text>`;
    s += sym('fr1', [62, 128, 46, 16], SYMDEF.fr1, f);

    /* 三相分别进电机（不再用横向母线，横线会被读成三相短接） */
    s += `<line class="ic" x1="${x[0]}" y1="166" x2="${x[0]}" y2="181"/>`;
    s += `<line class="ic" x1="${x[1]}" y1="166" x2="${x[1]}" y2="180"/>`;
    s += `<line class="ic" x1="${x[2]}" y1="166" x2="${x[2]}" y2="181"/>`;
    s += `<path class="ic" d="M${x[0]} 181q${(x[1] - x[0]) / 2} -5 ${x[1] - x[0]} 0"/>`;
    s += `<path class="ic" d="M${x[1]} 181q${(x[2] - x[1]) / 2} -5 ${x[2] - x[1]} 0"/>`;
    s += `<line class="ic" x1="${x[0]}" y1="181" x2="${x[0] + 4}" y2="185"/>`;
    s += `<line class="ic" x1="${x[2]}" y1="181" x2="${x[2] - 4}" y2="185"/>`;
    let m = `<circle class="ic" cx="84" cy="196" r="16"/>`;
    m += `<text class="it-m" x="84" y="199.4" text-anchor="middle" style="font-size:9px">M</text>`;
    m += `<text class="it-s" x="84" y="188" text-anchor="middle" style="font-size:3.6px">3~</text>`;
    /* 绕组星点：圆内三条短线汇聚到中心，表示 Y 接，不与外部三相短接 */
    m += `<line class="ic ic-t" x1="78.6" y1="188.6" x2="84" y2="193"/><line class="ic ic-t" x1="89.4" y1="188.6" x2="84" y2="193"/>`;
    m += `<line class="ic ic-t" x1="84" y1="186" x2="84" y2="193"/><circle class="if" cx="84" cy="193" r="0.8"/>`;
    m += `<line class="ic" x1="84" y1="212" x2="84" y2="218"/>`;
    m += `<line class="ic" x1="78" y1="218" x2="90" y2="218"/><line class="ic" x1="80" y1="220.6" x2="88" y2="220.6"/><line class="ic" x1="82" y1="223.2" x2="86" y2="223.2"/>`;
    m += `<text class="it-s" x="93" y="221" style="font-size:3.4px">PE</text>`;
    m += pin(x[0], 166, 'U', 'l') + pin(x[1], 166, 'V', 'l') + pin(x[2], 166, 'W', 'l');
    m += `<text class="it" x="56" y="192" text-anchor="end" style="font-size:5px">-M1</text>`;
    m += `<text class="it-s" x="56" y="197" text-anchor="end">${mc('motor', 'model')} · ${mc('motor', 'power')}</text>`;
    s += sym('m1', [66, 178, 38, 40], SYMDEF.m1, m);

    return s + '</g>';
  }

  /* ---- 控制回路（示例图纸；工程图纸由 elec 引擎整页生成后注入） ---- */
  function controlCircuitSVG() {
    return controlCircuitSampleSVG();
  }

  function controlCircuitSampleSVG() {
    let s = '<g class="circuit">';
    s += `<text class="it-t" x="204" y="32" style="font-size:4.2px">控制回路 ·  DC 24V</text>`;
    s += `<line class="ic ic-t" x1="204" y1="35" x2="400" y2="35" style="opacity:.55"/>`;

    /* 竖母线 */
    s += `<line class="ic ic-b" x1="204" y1="64" x2="204" y2="190"/>`;
    s += `<line class="ic ic-b" x1="400" y1="64" x2="400" y2="190"/>`;
    s += `<text class="it" x="204" y="59" text-anchor="middle" style="font-size:4.4px">+24V</text>`;
    s += `<text class="it" x="400" y="59" text-anchor="middle" style="font-size:4.4px">0V</text>`;

    /* 支路 1：24V → SB1 → KA1 → 0V */
    s += `<line class="ic" x1="204" y1="76" x2="222" y2="76"/><circle class="if" cx="204" cy="76" r="1"/>`;

    let sb = '';
    sb += `<line class="ic" x1="222" y1="71.4" x2="222" y2="80.6"/>`;              /* 固定触点 */
    sb += `<line class="ic" x1="231.6" y1="77.6" x2="222.4" y2="75.2"/>`;           /* 常闭刀片 */
    sb += `<line class="ic" x1="227" y1="66.6" x2="227" y2="73.4"/>`;               /* 推杆 */
    sb += `<line class="ic" x1="223.2" y1="66.6" x2="230.8" y2="66.6"/>`;           /* 蘑菇头底 */
    sb += `<path class="ic" d="M222.6 66.6a4.4 3.8 0 018.8 0"/>`;                   /* 蘑菇头 */
    sb += `<line class="ic" x1="231.6" y1="76" x2="256" y2="76"/>`;
    sb += `<text class="it-s" x="220.6" y="84" text-anchor="end">13</text>`;
    sb += `<text class="it-s" x="233.4" y="84">14</text>`;
    sb += `<text class="it" x="227" y="61.4" text-anchor="middle" style="font-size:5px">-SB1</text>`;
    sb += `<text class="it-s" x="239" y="71.6">急停</text>`;
    sb += pin(222, 76, '13', 'r') + pin(231.6, 76, '14', 'l');
    s += sym('sb1', [218, 62, 18, 22], SYMDEF.sb1, sb);

    let ka = `<rect class="ic" x="258" y="70" width="26" height="12"/>`;
    ka += `<line class="ic ic-t" x1="258" y1="76" x2="284" y2="76"/>`;
    ka += `<line class="ic" x1="284" y1="76" x2="400" y2="76"/>`;
    ka += `<text class="it-s" x="260" y="74" style="font-size:3.2px">A1</text>`;
    ka += `<text class="it-s" x="282" y="80.6" text-anchor="end" style="font-size:3.2px">A2</text>`;
    ka += `<text class="it" x="271" y="66.6" text-anchor="middle" style="font-size:5px">-KA1</text>`;
    ka += `<text class="it-s" x="271" y="87" text-anchor="middle">PNOZ X2.8P</text>`;
    ka += pin(258, 76, 'A1', 'r') + pin(284, 76, 'A2', 'l');
    s += sym('ka1', [256, 66, 30, 22], SYMDEF.ka1, ka);

    /* A1 模块 */
    let a = `<rect class="ic" x="256" y="100" width="96" height="76"/>`;
    a += `<text class="it" x="260" y="112" style="font-size:5px">-A1</text>`;
    a += `<text class="it-s" x="260" y="117.4">PLC 输出模块 · 8×DO</text>`;
    a += `<text class="it-s" x="260" y="121.8">6ES7 222-1BF22 · DC24V</text>`;
    a += `<line class="ic ic-t" x1="256" y1="125" x2="352" y2="125"/>`;
    /* 电源与公共端 */
    a += `<line class="ic" x1="204" y1="108" x2="256" y2="108"/><circle class="if" cx="204" cy="108" r="1"/>`;
    a += `<text class="it-s" x="250" y="106" text-anchor="end">L+</text>`;
    a += `<line class="ic" x1="304" y1="176" x2="304" y2="182"/><line class="ic" x1="304" y1="182" x2="400" y2="182"/>`;
    a += `<text class="it-s" x="299" y="180" text-anchor="end">M</text>`;
    /* 通道指示方块 */
    let chY = [130, 152, 174];
    chY.forEach((y, i) => {
      a += `<rect class="ic ic-t" x="262" y="${y - 3.4}" width="7" height="6.8"/>`;
      a += `<text class="it-s" x="266" y="${y + 1.4}" text-anchor="middle" style="font-size:2.8px">${i + 1}</text>`;
    });
    a += `<text class="it-s" x="278" y="146">Q0.0 / Q0.1 / Q0.4</text>`;
    a += `<text class="it-s" x="278" y="152">通道 1 · 2 · 5</text>`;
    a += `<text class="it-s" x="278" y="163">剩余 5 通道</text>`;
    a += `<text class="it-s" x="278" y="169">预留备用</text>`;
    a += pin(256, 108, 'L+', 'r') + pin(304, 176, 'M', 'l');
    a += pin(352, 130, 'Q0.0', 'r') + pin(352, 152, 'Q0.1', 'r') + pin(352, 174, 'Q0.4', 'r');
    s += sym('a1', [256, 100, 96, 76], SYMDEF.a1, a);

    /* 三个线圈 */
    const coils = [
      { id: 'yv1', tag: '-YV1', y: 130 },
      { id: 'yv2', tag: '-YV2', y: 152 },
      { id: 'km1c', tag: '-KM1', y: 174 }
    ];
    coils.forEach(c => {
      let g = `<line class="ic" x1="352" y1="${c.y}" x2="366" y2="${c.y}"/>`;
      g += `<rect class="ic" x="366" y="${c.y - 6}" width="22" height="12"/>`;
      g += `<line class="ic ic-t" x1="366" y1="${c.y}" x2="388" y2="${c.y}"/>`;
      g += `<line class="ic" x1="388" y1="${c.y}" x2="400" y2="${c.y}"/><circle class="if" cx="400" cy="${c.y}" r="1"/>`;
      g += `<text class="it" x="377" y="${c.y - 9}" text-anchor="middle" style="font-size:4.6px">${c.tag}</text>`;
      g += `<text class="it-s" x="367.6" y="${c.y - 1.2}" style="font-size:2.8px">A1</text>`;
      g += `<text class="it-s" x="386.4" y="${c.y + 4.6}" text-anchor="end" style="font-size:2.8px">A2</text>`;
      g += pin(366, c.y, 'A1', 'r') + pin(388, c.y, 'A2', 'l');
      const def = SYMDEF[c.id];
      s += sym(c.id, [364, c.y - 10, 28, 26], def, g);
    });

    /* 端子排 X1 */
    const X1X = 186, X1Y = 186;
    let x1 = `<text class="it" x="${X1X}" y="${X1Y - 2.4}" style="font-size:4.6px">-X1</text>`;
    x1 += `<text class="it-s" x="${X1X + 11}" y="${X1Y - 2.4}">8 位端子排 · UK-2.5B · 24A</text>`;
    for (let i = 0; i < 8; i++) {
      const tx = X1X + i * 11.6;
      x1 += `<rect class="ic" x="${tx}" y="${X1Y}" width="11" height="9"/>`;
      x1 += `<text class="it-s" x="${tx + 5.5}" y="${X1Y + 6.4}" text-anchor="middle" style="font-size:3.4px">${i + 1}</text>`;
      if (i >= 6) x1 += `<line class="ic ic-d" x1="${tx + 5.5}" y1="${X1Y + 9}" x2="${tx + 5.5}" y2="${X1Y + 15}"/>`;
    }
    x1 += `<text class="it-s" x="${X1X + 6 * 11.6 + 5.5}" y="${X1Y + 20}" text-anchor="middle" style="font-size:3.2px">未接</text>`;
    x1 += pin(X1X + 5.5, X1Y, '1', 'r');
    s += sym('x1', [X1X - 2, X1Y - 6, 96, 24], SYMDEF.x1, x1);

    /* 跨页中断点 → 7.2 */
    s += `<g><line class="ic-jump" x1="330" y1="206" x2="352" y2="206"/>`;
    s += `<path class="ic-jump" d="M352 201.4l5.2 4.6-5.2 4.6"/>`;
    s += `<line class="ic-jump" x1="357.2" y1="206" x2="368" y2="206"/>`;
    s += `<text class="it" x="371" y="208" style="font-size:4.4px">7.2</text>`;
    s += `<text class="it-s" x="330" y="202.4">续页</text></g>`;

    /* 技术要求 */
    s += `<g><text class="it-t" x="186" y="241" style="font-size:4px;font-weight:600">技术要求</text>`;
    s += `<line class="ic ic-t" x1="186" y1="243.2" x2="284" y2="243.2" style="opacity:.5"/>`;
    s += `<text class="it-s" x="186" y="248.6" style="font-size:3.1px">1. 急停回路按 EN ISO 13850 类别 0，双通道接线。</text>`;
    s += `<text class="it-s" x="186" y="253.4" style="font-size:3.1px">2. 24V 回路配 6A 熔断器 -FU1，导线 0.75 mm²。</text>`;
    s += `<text class="it-s" x="186" y="258.2" style="font-size:3.1px">3. 未注端子号见接线表 EL-001-T，导线套线号管。</text>`;
    s += `<text class="it-s" x="186" y="263" style="font-size:3.1px">4. 柜内导线按相序分色：L1 黄 / L2 绿 / L3 红 / N 蓝。</text>`;
    s += `<text class="it-s" x="186" y="267.8" style="font-size:3.1px">5. 图纸未注尺寸单位 mm，未注公差按 GB/T 1804-m。</text></g>`;

    return s + '</g>';
  }


  /* ---- 元件明细表（图纸左下，填充版面） ---- */
  function deviceTableSVG() {
    const x = 14, w = 166, cols = [0, 44, 140, 166];
    // 行数随机型变化，表格高度跟着算，不写死 9 行
    const rows = (MACHINE && Array.isArray(MACHINE.devices) && MACHINE.devices.length
      ? MACHINE.devices
      : MACHINE_DEFAULT.devices).slice(0, 14);
    // 行数多时自动压缩行高，保证不越过图纸下边框（原来 12 行会把最后一行截掉）
    const hh = 6;
    const bottomLimit = 286;
    const y = Math.max(226, bottomLimit - (hh + rows.length * 4.72));
    const rh = Math.min(4.72, (bottomLimit - y - hh) / Math.max(1, rows.length));
    const H = hh + rows.length * rh;
    let s = `<g><text class="it-t" x="${x}" y="${y - 2.6}" style="font-size:4.2px;font-weight:600">元件明细表</text>`;
    s += `<rect class="ic" x="${x}" y="${y}" width="${w}" height="${H}"/>`;
    s += `<line class="ic ic-t" x1="${x}" y1="${y + hh}" x2="${x + w}" y2="${y + hh}"/>`;
    s += `<line class="ic ic-t" x1="${x + cols[1]}" y1="${y}" x2="${x + cols[1]}" y2="${y + H}" style="opacity:.8"/>`;
    s += `<line class="ic ic-t" x1="${x + cols[2]}" y1="${y}" x2="${x + cols[2]}" y2="${y + H}" style="opacity:.8"/>`;
    s += `<text class="it-s" x="${x + cols[0] + 3}" y="${y + 4.2}" style="font-size:3.2px">代号</text>`;
    s += `<text class="it-s" x="${x + cols[1] + 4}" y="${y + 4.2}" style="font-size:3.2px">名称</text>`;
    s += `<text class="it-s" x="${x + w - 4}" y="${y + 4.2}" text-anchor="end" style="font-size:3.2px">数量</text>`;
    rows.forEach((r, i) => {
      const ry = y + hh + i * rh;
      if (i) s += `<line class="ic ic-t" x1="${x}" y1="${ry}" x2="${x + w}" y2="${ry}" style="opacity:.55"/>`;
      s += `<text class="it-s" x="${x + cols[0] + 3}" y="${ry + 3.4}" style="font-size:3.3px;fill:var(--ink)">${r[0]}</text>`;
      s += `<text class="it-s" x="${x + cols[1] + 4}" y="${ry + 3.4}" style="font-size:3.3px;fill:var(--ink)">${r[1]}</text>`;
      s += `<text class="it-s" x="${x + w - 4}" y="${ry + 3.4}" text-anchor="end" style="font-size:3.3px;fill:var(--ink)">${r[2]}</text>`;
    });
    return s + '</g>';
  }

  /* ---- 原理图渲染 ---- */
  function renderSheet() {
    const svg = $('#elSheet');
    if (!svg) return;
    let s = `<defs>
      <pattern id="elGrid" width="4" height="4" patternUnits="userSpaceOnUse">
        <path d="M4 0H0V4" class="ic-grid"/>
      </pattern>
    </defs>
    <rect x="0" y="0" width="420" height="297" fill="#fff"/>
    <rect x="0" y="0" width="420" height="297" fill="url(#elGrid)"/>`;
    s += frameSVG();
    s += mainCircuitSVG();
    s += controlCircuitSVG();
    s += deviceTableSVG();
    s += titleBlockSVG();
    s += `<g id="elPlaceLayer"></g>`;
    s += `<g id="elGhost" class="eghost" hidden></g>`;
    svg.innerHTML = s;
    applySheetState();
  }

  function applySheetState() {
    const svg = $('#elSheet');
    if (!svg) return;
    $$('.esym', svg).forEach(g => {
      const id = g.dataset.sym;
      g.dataset.sel = id === ES.sym ? '1' : '0';
      g.dataset.hl = id === ES.hl ? '1' : '0';
      g.dataset.chk = ES.chk && ES.chk.target === id ? String(ES.chk.sev === 'error' ? 2 : 1) : '0';
    });
  }

  /* ---- 左栏：页浏览器 + 符号库（可上下分区） ---- */
  function schematicLeftHTML() {
    return `
    <div class="el-left">
      <div class="el-zone" style="flex:${(ES.split * 100).toFixed(0)} 1 0">
        <div class="el-zone-head">
          <span class="t">页浏览器</span><span class="n">5 组 · 12 页</span>
          <span style="flex:1"></span>
          <span class="badge-warn-sm">${ICO.warn}6</span>
        </div>
        <div class="el-zone-body" id="elPageTree">${pageTreeHTML()}</div>
      </div>
      <div class="el-split" id="elSplit" title="拖动调整分区"></div>
      <div class="el-zone" style="flex:${((1 - ES.split) * 100).toFixed(0)} 1 0">
        <div class="el-zone-head"><span class="t">符号库</span><span class="n">12 项 · IEC 60617</span></div>
        <div class="slib-search">${ICO.page}<input type="search" id="elSymSearch" placeholder="搜索符号 / 类目…" autocomplete="off"></div>
        <div class="el-zone-body" id="elSymList">${symbolListHTML('')}</div>
      </div>
    </div>`;
  }

  function pageTreeHTML() {
    let s = '<div class="tree" role="tree">';
    PAGES.forEach((g, gi) => {
      const open = ES['pg' + gi] !== false;
      s += `<div class="prow ${open ? 'is-open' : ''}" data-pgfold="${gi}" style="padding-left:8px">
        <span class="tw ${open ? '' : ''}">${ICO.chev}</span>
        <span class="pt-ico">${ICO.folder}</span>
        <span class="lbl">${g.label}</span>
        <span class="pg">${g.children.length}</span>
      </div>`;
      s += `<div data-pglist="${gi}" ${open ? '' : 'hidden'}>`;
      g.children.forEach((p, pi) => {
        s += `<div class="prow ${p.cur ? 'is-sel' : ''}" data-pgrow="${gi}-${pi}" style="padding-left:30px">
          <span class="pt-ico">${ICO.page}</span>
          <span class="lbl">${p.label}</span>
          ${p.warn ? `<span class="badge-warn-sm">${ICO.warn}${p.warn}</span>` : ''}
          <span class="pg">${p.meta}</span>
        </div>`;
      });
      s += '</div>';
    });
    return s + '</div>';
  }

  function symbolListHTML(q) {
    const list = LIB_SYM.filter(x => !q || (x.name + x.model).toLowerCase().indexOf(q.toLowerCase()) >= 0);
    let s = `<div class="slib-sec">最近使用<span class="n">3</span></div>
      <div class="slib-recent">${['-QF2', '-YV3', '-FR2'].map(t => `<button class="slib-chip" type="button" data-erecent="${t}">${t}</button>`).join('')}</div>`;
    s += `<div class="slib-sec">全部符号<span class="n">${list.length}</span></div>`;
    if (!list.length) s += `<div class="hint-inline">没有匹配的符号</div>`;
    s += list.map(x => `
      <button class="slib-item ${ES.place && ES.place.key === x.key ? 'is-armed' : ''}" type="button" data-esym="${x.key}" title="点击后在图纸上放置">
        <span class="slib-ico"><svg viewBox="0 0 22 30">${libSymbol(x.key)}</svg></span>
        <span class="nm">${x.name}</span>
        <span class="cat">${x.model}</span>
      </button>`).join('');
    return s;
  }

  /* ---- 右栏 ---- */
  function schematicRightHTML() {
    const id = ES.sym;
    const d = id ? (ES.defs[id] || SYMDEF[id]) : null;
    let s = `<div class="el-props">
      <div class="t1">${d ? d.name : '未选中元件'}
        <span class="chip ${d ? '' : 'empty'}">${d ? '已选中' : '—'}</span></div>
      <div class="t2">${d ? d.tag + ' · ' + d.model : '在图纸中点击符号以查看属性'}</div>
    </div>
    <div class="panel-body">`;

    s += `<section class="pgroup" data-pgroup>
      <button class="pgroup-head" type="button" data-pgroup-head>元件属性<svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">${propsRows(d)}</div></div></div>
    </section>`;

    s += `<section class="pgroup" data-pgroup>
      <button class="pgroup-head" type="button" data-pgroup-head>交叉引用<span style="font-family:var(--font-mono);font-size:10px;color:var(--text-3);font-weight:400">${XREF.length}</span><svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad" style="padding:2px 0 4px">
        ${XREF.map((x, i) => `<button class="xref ${ES.hl === x.target ? 'is-on' : ''}" type="button" data-exref="${i}">
          <span class="tag">${x.tag}</span><span class="kind">${x.kind}</span>
          <span class="pg">${x.pg}</span><span class="ico">${ICO.go}</span>
        </button>`).join('')}
      </div></div></div>
    </section>`;

    s += `<section class="pgroup" data-pgroup>
      <button class="pgroup-head" type="button" data-pgroup-head>页属性<svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">
        <div class="field"><label>图号</label><div class="ctl-ro mono">${(ES.machine && ES.machine.drawingNo) || 'EL-001'}</div></div>
        <div class="field"><label>页</label><div class="ctl-ro mono">${pageLabel()}</div></div>
        <div class="field"><label>来源</label><div class="ctl-ro mono">${ES.machine ? (ES.machine.project || '工程生成') : '示例柜'}</div></div>
        <div class="field"><label>幅面</label><div class="ctl-ro mono">A3 · 420 × 297</div></div>
        <div class="field"><label>比例</label><div class="ctl-ro mono">1:1</div></div>
        <div class="field"><label>元件</label><div class="ctl-ro mono">${(ES.machine && ES.machine.devices ? ES.machine.devices.length : 11) + $$('#elPlaceLayer .esym').length} 个符号</div></div>
        <div class="field"><label>栅格</label><div class="ctl-ro mono">4 mm</div></div>
      </div></div></div>
    </section>
    <section class="pgroup is-collapsed" id="elChkGroup" data-pgroup>
      <button class="pgroup-head" type="button" data-pgroup-head>校验<span style="font-family:var(--font-mono);font-size:10px;color:var(--warning);font-weight:400">${CHECKS.length}</span><svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad" style="padding:2px 0 4px">
        ${CHECKS.map((c, i) => `<button class="chk ${ES.chk && ES.chk.id === c.id ? 'is-on' : ''}" type="button" data-echk="${i}" data-sev="${c.sev}">
          <span class="mk">${c.sev === 'error' ? ICO.err : ICO.warn}</span>
          <span class="tx"><span class="tt">${c.t}</span><span class="dd"><span class="mono">${c.d}</span></span></span>
        </button>`).join('')}
      </div></div></div>
    </section>
    </div>
    <div class="panel-foot"><button class="btn btn-block" type="button" data-eact="check">${ICO.ok}运行电气校验</button></div>`;
    return s;
  }

  function propsRows(d) {
    if (!d) return `<div class="hint-inline">未选中元件。点击图纸中的符号，或在符号库中选择后在图纸上放置。</div>`;
    const row = (k, v, mono) => `<div class="field"><label>${k}</label>
      <div class="ctl-ro ${mono ? 'mono' : ''}">${v}</div></div>`;
    return row('标签', d.tag, true) + row('型号', d.model, true) +
      row('额定电流', d.amp, true) + row('电位', d.pot, true) +
      `<div class="term-grid">${d.pins.map(p => `<span class="term-pill">${p}</span>`).join('')}</div>`;
  }

  /* ---- 交互 ---- */
  function selectSym(id) {
    ES.sym = id;
    applySheetState();
    const right = $('#elRight');
    if (right) right.innerHTML = schematicRightHTML();
    const d = id ? (ES.defs[id] || SYMDEF[id]) : null;
    const ea = $('#stElA');
    if (ea) statusSlots(d ? d.tag + ' · ' + d.pot : '未选中元件', '页 ' + MACHINE.page + ' · A3 420×297 · 比例 1:1',
      { tone: 'ok', text: '交叉引用 ' + XREF.length + ' 条' });
  }

  function svgPoint(svg, ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function ghostSVG(key) {
    const box = libBox();
    return `<g transform="translate(${-box.w / 2},${-box.h / 2})">${libSymbol(key)}</g>`;
  }

  function armPlace(key) {
    const def = LIB_SYM.filter(x => x.key === key)[0];
    if (!def) return;
    ES.place = def;
    $$('.slib-item').forEach(b => b.classList.toggle('is-armed', b.dataset.esym === key));
    const shell = $('#elPaper');
    if (shell) shell.classList.add('is-placing');
    const g = $('#elGhost');
    if (g) { g.innerHTML = ghostSVG(key); g.hidden = false; }
    const msg = $('#stElMsg');
    if (msg) { msg.hidden = false; msg.textContent = '已取用 ' + def.name + '，点击图纸放置（Esc 取消）'; }
  }
  function disarmPlace() {
    ES.place = null;
    $$('.slib-item').forEach(b => b.classList.remove('is-armed'));
    const shell = $('#elPaper');
    if (shell) shell.classList.remove('is-placing');
    const g = $('#elGhost');
    if (g) { g.hidden = true; g.innerHTML = ''; }
    const msg = $('#stElMsg');
    if (msg) msg.hidden = true;
  }

  function placeSymbol(x, y) {
    const def = ES.place;
    if (!def) return;
    const box = libBox();
    const px = clamp(x - box.w / 2, 12, 396);
    const py = clamp(y - box.h / 2, 12, 282);
    const n = ++ES.seq[def.prefix];
    const tag = '-' + def.prefix + n;
    const id = 'p' + def.prefix + n;
    ES.defs[id] = {
      tag: tag, name: def.name, model: def.model, amp: def.amp, pot: def.pot,
      pins: ['1', '2']
    };
    const layer = $('#elPlaceLayer');
    if (layer) {
      layer.insertAdjacentHTML('beforeend',
        sym(id, [px, py, box.w, box.h], ES.defs[id],
          `<g transform="translate(${px},${py})">${libSymbol(def.key)}</g>
           <text class="it" x="${px + box.w / 2}" y="${py - 3}" text-anchor="middle" style="font-size:4.6px">${tag}</text>
           <text class="it-s" x="${px + box.w / 2}" y="${py + box.h + 5}" text-anchor="middle">${def.model}</text>`));
    }
    selectSym(id);
    disarmPlace();
    statusSlots(tag + ' · ' + def.pot, '已放置 ' + def.name + ' · 自动编号 ' + tag + '（可从符号库继续取用）',
      { tone: 'ok', text: '页 ' + pageLabel() });
  }

  function bindSchematic() {
    const paper = $('#elPaper');
    if (!paper) return;
    paper.addEventListener('mousemove', e => {
      const g = $('#elGhost');
      if (!g || g.hidden || !ES.place) return;
      const svg = $('#elSheet');
      const p = svgPoint(svg, e);
      g.setAttribute('transform', `translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`);
    });
    paper.addEventListener('click', e => {
      const t = e.target;
      const symEl = t.closest('.esym');
      if (ES.place && !symEl) {
        const p = svgPoint($('#elSheet'), e);
        placeSymbol(p.x, p.y);
        return;
      }
      if (symEl) { selectSym(symEl.dataset.sym); return; }
      selectSym(null);
    });
    /* 左右分区拖拽 */
    const sp = $('#elSplit');
    if (sp) {
      let drag = false;
      sp.addEventListener('pointerdown', e => {
        drag = true;
        try { sp.setPointerCapture(e.pointerId); } catch (_) { }
        e.preventDefault();
      });
      sp.addEventListener('pointermove', e => {
        if (!drag) return;
        const left = $('.el-left');
        if (!left) return;
        const r = left.getBoundingClientRect();
        ES.split = clamp((e.clientY - r.top) / r.height, 0.2, 0.78);
        const zones = $$('.el-zone', left);
        zones[0].style.flex = (ES.split * 100).toFixed(0) + ' 1 0';
        zones[1].style.flex = ((1 - ES.split) * 100).toFixed(0) + ' 1 0';
      });
      sp.addEventListener('pointerup', () => { drag = false; });
    }
  }

  /* ============================================================
     三、IO 规划
     ============================================================ */

  /* 28 行 = 16 已分配 + 3 未分配 + 2 冲突 + 5 建议 + 2 已忽略
     （状态推导见 stOf：建议行被采纳后自动转为已分配） */
  const mkIo = (id, st, addr, dev, fn, sig, to, src, cab, cat, extra) => Object.assign({
    id, st, addr, dev, fn, sig, to, src, cab, cat,
    st2: src.indexOf('电气') === 0 ? 'e' : 'm'
  }, extra || {});

  const IO = [
    /* ---- DI 组 1（8/8） ---- */
    mkIo('r01', 'reco', 'DI 0.0', '滑台气缸 -YV1', '前进到位', '干接点', 'X1:1 → DI 0.0', '机械 · 滑台气缸 YV1', '柜 1 · 主控', '滑台气缸', { reco: true }),
    mkIo('r02', 'reco', 'DI 0.1', '滑台气缸 -YV2', '后退到位', '干接点', 'X1:2 → DI 0.1', '机械 · 滑台气缸 YV2', '柜 1 · 主控', '滑台气缸', { reco: true }),
    mkIo('r03', 'ok', 'DI 0.2', '夹紧气缸 -YV3', '松开到位', '干接点', 'X1:3 → DI 0.2', '机械 · 夹紧气缸', '柜 2 · 现场', '夹紧气缸'),
    mkIo('r04', 'ok', 'DI 0.3', '真空吸盘 -YV4', '真空建立', '干接点', 'X1:4 → DI 0.3', '机械 · 真空吸盘', '柜 2 · 现场', '真空吸盘'),
    mkIo('r05', 'ok', 'DI 0.4', '安全门 -SQ1', '门闭合', '双通道', 'X1:5/6 → DI 0.4', '机械 · 安全门', '柜 2 · 现场', '安全'),
    mkIo('r06', 'ok', 'DI 0.5', '安全门 -SQ2', '门锁反馈', '双通道', 'X1:7 → DI 0.5', '机械 · 安全门', '柜 2 · 现场', '安全'),
    mkIo('r07', 'ok', 'DI 0.6', '编码器 -B1', 'A 相脉冲', '24V PNP', 'X1:8 → DI 0.6', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    mkIo('r08', 'ok', 'DI 0.7', '编码器 -B1', 'B 相脉冲', '24V PNP', 'X1:9 → DI 0.7', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    /* ---- DI 组 2（3/8） ---- */
    mkIo('r09', 'reco', 'DI 1.0', '伺服轴 -M2', '伺服就绪', '24V PNP', 'X1:10 → DI 1.0', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴', { reco: true }),
    mkIo('r10', 'ok', 'DI 1.1', '伺服轴 -M2', '报警输出', '24V PNP', 'X1:11 → DI 1.1', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    mkIo('r11', 'ok', 'DI 1.2', '压力传感器 -BP1', '压力开关', '干接点', 'X1:12 → DI 1.2', '机械 · 气源处理', '柜 1 · 主控', '气源'),
    /* ---- DO 组 1（6/8） ---- */
    mkIo('r12', 'reco', 'DO 0.0', '滑台气缸 -YV1', '前进电磁阀', '24V / 0.4A', 'X1:13 → YV1:A1', '机械 · 滑台气缸 YV1', '柜 1 · 主控', '滑台气缸', { reco: true }),
    mkIo('r13', 'ok', 'DO 0.1', '滑台气缸 -YV2', '后退电磁阀', '24V / 0.4A', 'X1:14 → YV2:A1', '机械 · 滑台气缸 YV2', '柜 1 · 主控', '滑台气缸'),
    mkIo('r14', 'ok', 'DO 0.2', '夹紧气缸 -YV3', '夹紧电磁阀', '24V / 0.4A', 'X1:15 → YV3:A1', '机械 · 夹紧气缸', '柜 2 · 现场', '夹紧气缸'),
    mkIo('r15', 'ok', 'DO 0.3', '真空吸盘 -YV4', '吸盘电磁阀', '24V / 0.4A', 'X1:16 → YV4:A2', '机械 · 真空吸盘', '柜 2 · 现场', '真空吸盘'),
    mkIo('r16', 'ok', 'DO 0.4', '真空吸盘 -YV4', '破真空', '24V / 0.4A', 'X1:17 → YV4:A3', '机械 · 真空吸盘', '柜 2 · 现场', '真空吸盘'),
    mkIo('r17', 'reco', 'DO 0.5', '指示灯 -HL1', '报警灯', '24V / 0.1A', 'X2:1 → HL1:X1', '电气 · 柜面', '柜 1 · 主控', '柜面', { reco: true }),
    /* ---- 冲突（DO 12 越界重复占用） ---- */
    mkIo('r18', 'bad', 'DO 12', '真空吸盘 -YV4', '破真空（备用）', '24V / 0.4A', 'X1:18 → YV4:A4', '机械 · 真空吸盘', '柜 2 · 现场', '真空吸盘', { conflict: '与 -YV2 共用 DO 12' }),
    mkIo('r19', 'bad', 'DO 12', '电磁阀 -YV2', '后退（备用）', '24V / 0.4A', 'X1:19 → YV2:A2', '机械 · 滑台气缸 YV2', '柜 1 · 主控', '滑台气缸', { conflict: '与 -YV4 共用 DO 12' }),
    /* ---- AI / AO ---- */
    mkIo('r20', 'ok', 'AI 0.0', '压力传感器 -BP1', '气源压力', '4–20 mA', 'X1:20 → AI 0.0', '机械 · 气源处理', '柜 1 · 主控', '气源'),
    mkIo('r21', 'ok', 'AI 0.1', '伺服轴 -M2', '负载电流', '4–20 mA', 'X1:21 → AI 0.1', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    mkIo('r22', 'ok', 'AO 0.0', '比例阀 -YV5', '速度给定', '0–10 V', 'X1:22 → AO 0.0', '机械 · 滑台气缸', '柜 2 · 现场', '滑台气缸'),
    mkIo('r23', 'ok', 'AO 0.1', '伺服轴 -M2', '速度给定', '0–10 V', 'X1:23 → AO 0.1', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    /* ---- 未分配（3） ---- */
    mkIo('r24', 'none', '', '夹紧气缸 -YV3', '夹紧检测（备用）', '干接点', '—', '机械 · 夹紧气缸', '柜 2 · 现场', '夹紧气缸'),
    mkIo('r25', 'none', '', '伺服轴 -M2', '到位信号', '24V PNP', '—', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴'),
    mkIo('r26', 'none', '', '气源 -BP1', '露点报警', '干接点', '—', '机械 · 气源处理', '柜 1 · 主控', '气源'),
    /* ---- 已忽略（2，本轮不申请地址） ---- */
    mkIo('r27', 'ign', '', '伺服轴 -M2', '编码器 Z 相', '24V PNP', '—', '机械 · 伺服滑台', '柜 1 · 主控', '伺服轴', { note: '与 A/B 相共用 DI 1.3，本轮忽略' }),
    mkIo('r28', 'ign', '', '真空吸盘 -YV4', '真空度模拟量', '4–20 mA', '—', '机械 · 真空吸盘', '柜 2 · 现场', '真空吸盘', { note: '改用开关量，模拟量需求本轮忽略' })
  ];

  const ST_LABEL = { ok: ['✓', '已分配'], none: ['!', '未分配'], bad: ['✕', '冲突'], reco: ['+', '建议'], ign: ['–', '已忽略'] };
  const ST_ICO = {
    ok: ICO.ok, none: ICO.warn, bad: ICO.err,
    reco: '<svg viewBox="0 0 16 16" class="ico"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
    ign: '<svg viewBox="0 0 16 16" class="ico"><path d="M3.4 8h9.2"/></svg>'
  };

  /* 状态推导：建议行被采纳 → 已分配（计数条与表格永远同源） */
  function stOf(r) {
    return (r.st === 'reco' && ES.io.adopted[r.id]) ? 'ok' : r.st;
  }

  function ioCounts() {
    let ok = 0, none = 0, bad = 0, reco = 0, ign = 0;
    IO.forEach(r => {
      const s = stOf(r);
      if (s === 'ok') ok++;
      else if (s === 'none') none++;
      else if (s === 'bad') bad++;
      else if (s === 'reco') reco++;
      else ign++;
    });
    return { ok, none, bad, reco, ign, total: IO.length };
  }

  function ioSummary(c) {
    let s = `共 ${c.total} 点 · 已分配 ${c.ok} · 未分配 ${c.none} · 冲突 ${c.bad}`;
    if (c.reco) s += ` · 建议 ${c.reco}`;
    if (c.ign) s += ` · 已忽略 ${c.ign}`;
    return s;
  }

  function ioFiltered() {
    let rows = IO.slice();
    const f = ES.io.tree, seg = ES.io.seg;
    if (seg === 'none') rows = rows.filter(r => stOf(r) === 'none');
    else if (seg === 'bad') rows = rows.filter(r => stOf(r) === 'bad');
    else if (seg === 'reco') rows = rows.filter(r => stOf(r) === 'reco');
    if (f) {
      if (f.type === 'cat') rows = rows.filter(r => r.cat === f.v);
      else if (f.type === 'cab') rows = rows.filter(r => r.cab === f.v);
      else if (f.type === 'sig') rows = rows.filter(r => {
        if (f.v === '安全') return r.cat === '安全';
        return r.addr.split(' ')[0] === f.v;
      });
    }
    return rows;
  }

  function ioLeftHTML() {
    const c = ioCounts();
    const seg = (k, label, n) => `<button class="io-seg ${ES.io.seg === k ? 'is-on' : ''}" type="button" data-ioseg="${k}">
      <b>${n}</b><span>${label}</span></button>`;
    const groups = [
      {
        t: '按机械执行器', items: ['滑台气缸', '夹紧气缸', '真空吸盘', '伺服轴', '安全门', '气源'].map(v => ({
          v: v, n: IO.filter(r => r.cat === v).length
        }))
      },
      {
        t: '按柜', items: ['柜 1 · 主控', '柜 2 · 现场'].map(v => ({ v: v, n: IO.filter(r => r.cab === v).length }))
      },
      {
        t: '按信号类型', items: [
          { v: 'DI', n: IO.filter(r => r.addr.indexOf('DI ') === 0).length, sig: 'DI' },
          { v: 'DO', n: IO.filter(r => r.addr.indexOf('DO ') === 0).length, sig: 'DO' },
          { v: 'AI', n: IO.filter(r => r.addr.indexOf('AI ') === 0).length, sig: 'AI' },
          { v: 'AO', n: IO.filter(r => r.addr.indexOf('AO ') === 0).length, sig: 'AO' },
          { v: '安全', n: IO.filter(r => r.cat === '安全').length, sig: '安全' }
        ]
      }
    ];
    return `<div class="el-left">
      <div class="io-segs">${seg('none', '未分配', c.none)}${seg('bad', '冲突', c.bad)}${seg('reco', '建议', c.reco)}</div>
      <div class="el-zone-body">
        <div class="sec-title" style="padding-top:8px">分层筛选<span class="n">${ioFiltered().length} / ${IO.length}</span></div>
        <div class="io-tree">
          ${groups.map(g => `<div class="grp">${g.t}</div>` + g.items.map(it => {
      const on = ES.io.tree && ES.io.tree.type === (g.t === '按机械执行器' ? 'cat' : g.t === '按柜' ? 'cab' : 'sig') && ES.io.tree.v === it.v;
      return `<button class="io-node ${on ? 'is-on' : ''}" type="button"
              data-iotree="${g.t === '按机械执行器' ? 'cat' : g.t === '按柜' ? 'cab' : 'sig'}:${it.v}">
              <span class="dt" ${it.sig ? `data-sig="${it.sig}"` : ''}></span>
              <span>${it.v}</span><span class="n">${it.n}</span></button>`;
    }).join('')).join('')}
        </div>
      </div>
      <div class="panel-foot" style="display:flex;gap:6px">
        <button class="btn" type="button" data-eact="io-reset" style="flex:1">清除筛选</button>
        <button class="btn" type="button" data-eact="io-sync" style="flex:1">${ICO.ok}从机械同步</button>
      </div>
    </div>`;
  }

  function ioRowHTML(r) {
    const st = stOf(r);
    const adopted = st === 'ok' && r.st === 'reco';
    const isReco = st === 'reco';
    const addr = r.addr
      ? `<span>${r.addr}</span>`
      : `<span class="io-dash" title="${st === 'ign' ? '本轮已忽略' : '未分配地址'}">—</span>`;
    const op = isReco
      ? `<button class="io-op" type="button" data-eadopt="${r.id}" title="采纳建议地址">采纳</button>`
      : (adopted
        ? `<span class="io-op-done">已采纳</span>`
        : `<span class="io-op-dim">—</span>`);
    return `<tr class="io-row ${ES.io.sel === r.id ? 'is-sel' : ''} ${isReco ? 'is-reco' : ''} ${adopted ? 'is-adopted' : ''}"
        data-iorow="${r.id}" data-st="${st}">
      <td><span class="io-st" data-st="${st}">
        <span class="io-st-ico">${ST_ICO[st]}</span>
        ${ST_LABEL[st][1]}</span></td>
      <td class="io-ad-cell mono">${addr}</td>
      <td class="mono">${r.dev}</td>
      <td>${r.fn}</td>
      <td class="mono dim">${r.sig}</td>
      <td class="mono dim">${r.to}</td>
      <td title="${r.src}"><span class="io-src"><span class="d ${r.st2}"></span>${r.src}</span></td>
      <td class="io-op-cell">${op}</td>
    </tr>`;
  }

  function ioStageHTML() {
    const rows = ioFiltered();
    const sel = IO.filter(r => r.id === ES.io.sel)[0];
    const showBatch = sel && stOf(sel) === 'reco' && !ES.io.ignored;
    const c = ioCounts();
    return `<div class="io-wrap">
      ${showBatch ? `<div class="io-batch">
        <span class="t"><b>${c.reco}</b> 条建议</span>
        <span class="sp"></span>
        <button class="btn btn-primary" type="button" data-eact="io-adopt-all">采纳全部</button>
        <button class="btn" type="button" data-eact="io-adopt-sel">仅采纳选中</button>
        <button class="btn" type="button" data-eact="io-ignore">忽略本次</button>
      </div>` : ''}
      <div class="io-table-wrap">
        <div class="io-tbl-scroll">
          <table class="tbl io-tbl">
            <colgroup>
              <col class="c-st"><col class="c-ad"><col class="c-dev"><col class="c-fn">
              <col class="c-sig"><col class="c-to"><col class="c-src"><col class="c-op">
            </colgroup>
            <thead><tr>
              <th>状态</th><th class="io-th-num">地址</th><th>设备</th><th>功能</th>
              <th>信号</th><th>接线去向</th><th>来源</th><th>操作</th>
            </tr></thead>
            <tbody>${rows.map(ioRowHTML).join('') || `<tr><td colspan="8" class="dim" style="height:40px">当前筛选下无点位</td></tr>`}</tbody>
          </table>
        </div>
        <button class="io-add-row" type="button" data-eact="io-add">
          <span class="io-plus">+</span><span>新增点位（Ctrl+Enter）</span>
        </button>
      </div>
      ${ioAddrHTML()}
    </div>`;
  }

  /* 滚动区底部空余：用占位行把斑马纹补到容器底部（末行按剩余高度收窄），
     既不出现大面积页面底色，也不会把最后一行顶出滚动区 */
  function ioTailFill() {
    const sc = $('.io-tbl-scroll');
    const tb = sc && $('.io-tbl tbody', sc);
    if (!sc || !tb) return;
    $$('tr.io-fill', tb).forEach(tr => tr.parentNode.removeChild(tr));
    const first = $('tr', tb);
    if (!first) return;
    const rh = first.getBoundingClientRect().height;
    if (!rh) return;
    const rest = sc.clientHeight - $('.io-tbl', sc).getBoundingClientRect().height;
    if (rest < 3) return;
    const full = Math.floor(rest / rh);
    let html = '';
    for (let i = 0; i < full; i++) html += '<tr class="io-fill" aria-hidden="true"><td colspan="8"></td></tr>';
    const rem = Math.floor(rest - full * rh) - 1;
    if (rem > 2) {
      html += `<tr class="io-fill" aria-hidden="true" style="height:${rem}px">` +
        `<td colspan="8" style="height:${rem}px"></td></tr>`;
    }
    tb.insertAdjacentHTML('beforeend', html);
  }

  /* 地址占用块：PLC 通道分组（DI 3×8 / DO 2×8 / AI 4 / AO 2），
     每组一行：组号 + 起止地址 + 8 个位格 + 占用量条 */
  const PLC_GROUPS = [
    { sig: 'DI', groups: 3, per: 8 },
    { sig: 'DO', groups: 2, per: 8 },
    { sig: 'AI', groups: 1, per: 4 },
    { sig: 'AO', groups: 1, per: 2 }
  ];

  function ioAddrHTML() {
    /* addr "DI 1.3" → sig DI / major 1 / minor 3 */
    const map = {};
    IO.forEach(r => {
      if (!r.addr) return;
      const bits = r.addr.split(' ');
      const idx = (bits[1] || '').split('.');
      const key = bits[0] + '.' + idx[0];
      map[key] = map[key] || {};
      (map[key][idx[1]] = map[key][idx[1]] || []).push(r);
    });

    let used = 0, total = 0;
    const outside = IO.filter(r => stOf(r) === 'bad' && !PLC_GROUPS.some(g => {
      const bits = (r.addr || '').split(' ');
      const idx = (bits[1] || '').split('.');
      return bits[0] === g.sig && Number(idx[0]) < g.groups;
    }));
    const rows = [];
    PLC_GROUPS.forEach(g => {
      for (let gi = 0; gi < g.groups; gi++) {
        const slot = map[g.sig + '.' + gi] || {};
        const bits = [];
        let n = 0;
        for (let bi = 0; bi < g.per; bi++) {
          const owners = slot[String(bi)];
          let st = '', ttl = '空闲';
          if (owners) {
            st = owners.length > 1 ? 'bad' : stOf(owners[0]);
            ttl = owners.map(o => o.dev + ' · ' + o.fn).join(' / ');
            n++;
          }
          bits.push(`<i class="io-bit" data-s="${st}" title="${g.sig} ${gi}.${bi} · ${ttl}">${bi}</i>`);
        }
        used += n;
        total += g.per;
        const pct = Math.round(n / g.per * 100);
        const tone = n === 0 ? 'free' : (n === g.per ? 'full' : 'part');
        const note = n === g.per ? '已满' : (n === 0 ? '空闲' : '剩余 ' + (g.per - n));
        rows.push(`<div class="io-ag">
          <span class="io-ag-no">${gi + 1}</span>
          <span class="io-ag-k mono">${g.sig} ${gi}.0–${gi}.${g.per - 1}</span>
          <span class="io-bits">${bits.join('')}</span>
          <span class="io-ag-bar" title="已用 ${n} / ${g.per}"><i data-tone="${tone}" style="width:${pct}%"></i></span>
          <span class="io-ag-n mono">${n}/${g.per}</span>
          <span class="io-ag-note">${note}</span>
        </div>`);
      }
    });

    return `<div class="io-addr">
      <div class="h">地址占用<span class="n">PLC S7-1200 · ${total} 通道 · 已用 ${used}</span>
        ${outside.length ? `<span class="io-ag-cf" title="${outside.map(r => r.addr + ' ' + r.dev).join(' / ')}">${ICO.err}${outside.length} 点越界</span>` : ''}</div>
      <div class="body">${rows.join('')}</div>
      <div class="lg">
        <span><i data-s="ok"></i>已分配</span><span><i data-s="reco"></i>建议</span>
        <span><i data-s="none"></i>未分配</span><span><i data-s="bad"></i>冲突</span><span><i></i>空闲</span>
        <span class="sp"></span><span class="dim">悬停查看占用设备</span>
      </div>
    </div>`;
  }

  function ioRightHTML() {
    const r = IO.filter(x => x.id === ES.io.sel)[0];
    if (!r) {
      return `<div class="panel-head"><span class="ph-title">来源追溯</span><span class="ph-count">未选中</span></div>
        <div class="panel-body"><div class="hint-inline">点击左侧任意点位，查看从机械模型派生的完整链路。</div></div>`;
    }
    const chain = r.trace || defaultTrace(r);
    const st = stOf(r);
    let s = `<div class="panel-head"><span class="ph-title">来源追溯</span>
      <span class="ph-count">${r.addr || (st === 'ign' ? '已忽略' : '未分配')} · 只读</span></div><div class="panel-body">`;
    if (r.conflict) {
      s += `<div class="io-conflict">
        <div class="h">${ICO.err}<span>地址冲突</span></div>
        <div class="b">原因：<span class="mono">${r.conflict}</span><br>
          建议改派到空闲 <span class="mono">DO 0.6</span>，或合并同一电磁阀的两个动作位。</div>
      </div>`;
    }
    if (st === 'ign' && r.note) {
      s += `<div class="io-conflict is-ign">
        <div class="h">${ICO.warn}<span>本轮已忽略</span></div>
        <div class="b">${r.note}</div>
      </div>`;
    }
    s += `<div class="trace">${chain.map((c, i) => `
      <div class="step ${i === chain.length - 1 ? 'on' : ''}">
        <div class="k">${c.k}</div>
        <div class="v ${c.mono ? 'mono' : ''}">${c.v}</div>
      </div>`).join('')}</div>`;
    s += `<div class="note" style="padding:0 10px 10px">派生链只读：机械参数变更时，IO 地址随派生关系自动重算。</div>`;
    s += `<section class="pgroup" data-pgroup>
      <button class="pgroup-head" type="button" data-pgroup-head>点位详情<svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
      <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">
        <div class="field"><label>地址</label><div class="ctl-ro mono">${r.addr || '—'}</div></div>
        <div class="field"><label>设备</label><div class="ctl-ro mono">${r.dev}</div></div>
        <div class="field"><label>功能</label><div class="ctl-ro">${r.fn}</div></div>
        <div class="field"><label>信号</label><div class="ctl-ro mono">${r.sig}</div></div>
        <div class="field"><label>接线去向</label><div class="ctl-ro mono">${r.to}</div></div>
        <div class="field"><label>安装柜</label><div class="ctl-ro">${r.cab}</div></div>
      </div></div></div>
    </section></div>`;
    return s;
  }

  function defaultTrace(r) {
    const kind = r.addr.split(' ')[0] || 'DI';
    return [
      { k: '机械型号', v: r.cat === '滑台气缸' ? 'SMC MGP32-200' : (r.src.split('· ')[1] || r.cat), mono: true },
      { k: '行程', v: '200 mm', mono: true },
      { k: '磁性开关', v: '2 个（D-M9B）', mono: true },
      { k: '信号点', v: kind + ' 2 点', mono: true },
      { k: '当前映射地址', v: r.addr || '未分配', mono: true }
    ];
  }

  function renderIoStage() {
    const st = $('#elStageIo');
    if (st) {
      st.innerHTML = ioStageHTML();
      requestAnimationFrame(ioTailFill);
    }
  }
  function renderIoRight() {
    const r = $('#elRightIo');
    if (r) r.innerHTML = ioRightHTML();
    statusIo();
  }
  function renderIoLeft() {
    const l = $('#elLeftIo');
    if (l) l.innerHTML = ioLeftHTML();
  }

  function selectIoRow(id) {
    ES.io.sel = ES.io.sel === id ? null : id;   /* 再次点击取消选择 → 回到空状态 */
    ES.io.ignored = false;
    $$('.io-row').forEach(tr => tr.classList.toggle('is-sel', tr.dataset.iorow === ES.io.sel));
    renderIoStage();
    renderIoRight();
  }

  function adoptRows(list, keepSel) {
    list.forEach(r => { if (stOf(r) === 'reco') ES.io.adopted[r.id] = true; });
    if (!keepSel) ES.io.sel = null;
    renderIoStage();
    renderIoLeft();
    renderIoRight();
    const c = ioCounts();
    const msg = $('#stElMsg');
    if (msg) { msg.hidden = false; msg.textContent = '已采纳 ' + list.length + ' 条建议 · 剩余 ' + c.reco + ' 条'; }
    statusIo();
  }

  /* ============================================================
     四、柜体布置
     ============================================================ */

  const EN = { ox: 90, oy: 80, vbW: 1300, vbH: 1370 };
  const RAIL_Y = [300, 700, 1000];

  const EN_LIB = [
    { kind: 'breaker', name: '断路器', tag: '-Q', w: 54, h: 90, heat: 2, amps: 32, prefix: 'Q' },
    { kind: 'contactor', name: '接触器', tag: '-K', w: 45, h: 80, heat: 3, amps: 18, prefix: 'K' },
    { kind: 'relay', name: '安全继电器', tag: '-KA', w: 45, h: 80, heat: 2, amps: 6, prefix: 'KA' },
    { kind: 'drive', name: '驱动器', tag: '-A', w: 60, h: 180, heat: 20, amps: 12, prefix: 'A' },
    { kind: 'terminal', name: '端子排', tag: '-X', w: 120, h: 30, heat: 2, amps: 20, prefix: 'X' },
    { kind: 'psu', name: '开关电源', tag: '-G', w: 50, h: 100, heat: 12, amps: 10, prefix: 'G' },
    { kind: 'transformer', name: '变压器', tag: '-T', w: 80, h: 100, heat: 10, amps: 40, prefix: 'T' },
    { kind: 'fan', name: '风扇', tag: '-FN', w: 60, h: 60, heat: 0, amps: 0.3, prefix: 'FN' },
    { kind: 'lamp', name: '三色灯', tag: '-HL', w: 40, h: 40, heat: 1, amps: 0.1, prefix: 'HL' }
  ];

  function initEncComps() {
    ES.enc.seq = { Q: 3, K: 2, A: 2, X: 2, G: 1, FN: 2, KA: 1, T: 1, HL: 1 };
    ES.enc.comps = [
      /* 上导轨 y=300 */
      { id: 'qf1', tag: '-QF1', kind: 'breaker', w: 54, h: 90, x: 104, y: 255, rail: 0, heat: 2, amps: 32 },
      { id: 'qf2', tag: '-QF2', kind: 'breaker', w: 54, h: 90, x: 200, y: 255, rail: 0, heat: 2, amps: 32 },
      { id: 'qf3', tag: '-QF3', kind: 'breaker', w: 54, h: 90, x: 296, y: 255, rail: 0, heat: 2, amps: 10 },
      { id: 'ka1', tag: '-KA1', kind: 'relay', w: 45, h: 80, x: 392, y: 260, rail: 0, heat: 2, amps: 6 },
      { id: 'g1', tag: '-G1', kind: 'psu', w: 50, h: 100, x: 600, y: 250, rail: 0, heat: 12, amps: 10 },
      /* 中导轨 y=700 */
      { id: 'km1', tag: '-KM1', kind: 'contactor', w: 45, h: 80, x: 104, y: 660, rail: 1, heat: 3, amps: 18 },
      { id: 'km2', tag: '-KM2', kind: 'contactor', w: 45, h: 80, x: 200, y: 660, rail: 1, heat: 3, amps: 18 },
      { id: 'fr1', tag: '-FR1', kind: 'contactor', w: 45, h: 76, x: 296, y: 662, rail: 1, heat: 2, amps: 16 },
      { id: 'a1', tag: '-A1', kind: 'drive', w: 60, h: 180, x: 380, y: 610, rail: 1, heat: 20, amps: 12 },
      { id: 'a2', tag: '-A2', kind: 'drive', w: 60, h: 180, x: 480, y: 610, rail: 1, heat: 20, amps: 12 },
      /* 下导轨 y=1000 */
      { id: 'x1', tag: '-X1', kind: 'terminal', w: 400, h: 30, x: 100, y: 985, rail: 2, heat: 2, amps: 20 },
      { id: 't1', tag: '-T1', kind: 'transformer', w: 80, h: 100, x: 508, y: 950, rail: 2, heat: 10, amps: 40 },
      { id: 'x2', tag: '-X2', kind: 'terminal', w: 100, h: 30, x: 598, y: 985, rail: 2, heat: 2, amps: 20 },
      /* 柜门 */
      { id: 'hl1', tag: '-HL1', kind: 'lamp', w: 40, h: 40, x: 300, y: 68, rail: -1, heat: 1, amps: 0.1 },
      { id: 'fn1', tag: '-FN1', kind: 'fan', w: 60, h: 60, x: 636, y: 120, rail: -1, heat: 0, amps: 0.3 },
      { id: 'fn2', tag: '-FN2', kind: 'fan', w: 60, h: 60, x: 636, y: 420, rail: -1, heat: 0, amps: 0.3 }
    ];
  }

  function enCalc() {
    const c = ES.enc;
    const area = (c.W * c.H) / 1e6;
    const heat = c.comps.reduce((s, x) => s + (x.heat || 0), 0);
    const fanCool = c.comps.filter(x => x.kind === 'fan').length * 8;
    const net = Math.max(4, heat - fanCool);
    const temp = round(24 + net / (3.72 * Math.max(0.35, area)));
    const amps = c.comps.reduce((s, x) => s + (x.amps || 0), 0);
    const cap = 0.485 * c.W;
    const load = round(amps / cap * 100);
    const eff = (c.W - 100) * (c.H - 100);
    const used = c.comps.reduce((s, x) => s + x.w * x.h, 0)
      + 3 * (c.W - 100) * 35 + 2 * (c.H - 100) * 40 + eff * 0.55;
    const margin = Math.max(0, round(100 - used / eff * 100));
    return { temp: temp, load: load, margin: margin };
  }

  /* 元件内部简易符号（本地坐标 0..w / 0..h） */
  function enSym(c) {
    const w = c.w, h = c.h;
    let s = '';
    if (c.kind === 'breaker') {
      const n = 3, gap = w / (n + 1);
      for (let i = 0; i < n; i++) {
        const x = gap * (i + 1);
        s += `<rect class="ec-ink" x="${x - 5}" y="10" width="10" height="${h - 28}" rx="1"/>`;
        s += `<line class="ec-ink" x1="${x}" y1="14" x2="${x}" y2="${h - 32}"/>`;
      }
      s += `<line class="ec-ink" x1="6" y1="6" x2="${w - 6}" y2="6"/>`;
      s += `<line class="ec-ink" x1="6" y1="${h - 16}" x2="${w - 6}" y2="${h - 16}"/>`;
      s += `<rect class="ec-fill" x="6" y="${h - 24}" width="${w - 12}" height="3"/>`;
    } else if (c.kind === 'contactor') {
      s += `<line class="ec-ink" x1="8" y1="12" x2="${w - 8}" y2="12"/>`;
      s += `<line class="ec-ink" x1="8" y1="${h - 14}" x2="${w - 8}" y2="${h - 14}"/>`;
      for (let i = 0; i < 3; i++) {
        const x = 10 + i * ((w - 20) / 2);
        s += `<line class="ec-ink" x1="${x}" y1="12" x2="${x}" y2="${h - 14}"/>`;
        s += `<circle class="ec-ink" cx="${x}" cy="${h * 0.45}" r="2"/>`;
      }
      s += `<rect class="ec-ink" x="8" y="${h * 0.62}" width="${w - 16}" height="12" rx="1"/>`;
    } else if (c.kind === 'drive') {
      s += `<rect class="ec-ink" x="8" y="10" width="${w - 16}" height="34" rx="1"/>`;
      s += `<line class="ec-ink" x1="14" y1="20" x2="${w - 14}" y2="20"/>`;
      s += `<line class="ec-ink" x1="14" y1="28" x2="${w - 14}" y2="28"/>`;
      for (let i = 0; i < 5; i++) s += `<line class="ec-ink" x1="${12 + i * 8}" y1="${h * 0.5}" x2="${12 + i * 8}" y2="${h * 0.5 + 14}"/>`;
      s += `<rect class="ec-ink" x="10" y="${h - 34}" width="${w - 20}" height="20" rx="1"/>`;
      for (let i = 0; i < 4; i++) s += `<line class="ec-ink" x1="${16 + i * 9}" y1="${h - 26}" x2="${16 + i * 9}" y2="${h - 18}"/>`;
    } else if (c.kind === 'terminal') {
      for (let i = 0; i < 12; i++) {
        const x = 6 + i * ((w - 12) / 12);
        s += `<line class="ec-ink" x1="${x}" y1="4" x2="${x}" y2="${h - 4}"/>`;
        s += `<circle class="ec-fill" cx="${x + (w - 12) / 24}" cy="${h / 2}" r="2"/>`;
      }
    } else if (c.kind === 'relay') {
      /* 安全继电器：线圈 + 两组触点 */
      s += `<line class="ec-ink" x1="8" y1="14" x2="${w - 8}" y2="14"/>`;
      for (let i = 0; i < 2; i++) {
        const x = 12 + i * ((w - 24));
        s += `<line class="ec-ink" x1="${x}" y1="14" x2="${x}" y2="30"/>`;
        s += `<line class="ec-ink" x1="${x - 5}" y1="34" x2="${x + 5}" y2="30"/>`;
        s += `<line class="ec-ink" x1="${x}" y1="34" x2="${x}" y2="44"/>`;
      }
      s += `<rect class="ec-ink" x="8" y="${h * 0.6}" width="${w - 16}" height="16" rx="1"/>`;
      for (let i = 0; i < 3; i++) s += `<line class="ec-ink" x1="${14 + i * 8}" y1="${h * 0.62}" x2="${14 + i * 8}" y2="${h * 0.6 + 12}"/>`;
      s += `<line class="ec-ink" x1="8" y1="${h - 12}" x2="${w - 8}" y2="${h - 12}"/>`;
    } else if (c.kind === 'transformer') {
      /* 变压器：双绕组 + 铁芯 */
      s += `<rect class="ec-ink" x="10" y="12" width="${w / 2 - 14}" height="${h - 24}" rx="1"/>`;
      s += `<rect class="ec-ink" x="${w / 2 + 4}" y="12" width="${w / 2 - 14}" height="${h - 24}" rx="1"/>`;
      for (let i = 0; i < 4; i++) {
        const y = 22 + i * ((h - 44) / 3);
        s += `<line class="ec-ink" x1="14" y1="${y}" x2="${w / 2 - 4}" y2="${y}"/>`;
        s += `<line class="ec-ink" x1="${w / 2 + 8}" y1="${y}" x2="${w - 14}" y2="${y}"/>`;
      }
      s += `<line class="ec-ink" x1="${w / 2}" y1="12" x2="${w / 2}" y2="${h - 12}"/>`;
      s += `<line class="ec-ink" x1="${w / 2 - 2}" y1="12" x2="${w / 2 - 2}" y2="${h - 12}"/>`;
    } else if (c.kind === 'lamp') {
      /* 三色灯：三段叠层 */
      const r = (h - 8) / 6;
      for (let i = 0; i < 3; i++) {
        const cy = 4 + r + i * 2 * r;
        s += `<circle class="ec-ink" cx="${w / 2}" cy="${cy}" r="${r}"/>`;
        if (i === 0) s += `<circle class="ec-fill" cx="${w / 2}" cy="${cy}" r="${r * 0.45}"/>`;
        if (i === 1) s += `<line class="ec-ink" x1="${w / 2 - r * 0.6}" y1="${cy}" x2="${w / 2 + r * 0.6}" y2="${cy}"/>`;
      }
    } else if (c.kind === 'psu') {
      s += `<rect class="ec-ink" x="8" y="8" width="${w - 16}" height="${h - 30}" rx="1"/>`;
      for (let i = 0; i < 4; i++) s += `<line class="ec-ink" x1="12" y1="${18 + i * 8}" x2="${w - 12}" y2="${18 + i * 8}"/>`;
      s += `<circle class="ec-ink" cx="18" cy="${h - 14}" r="2"/><circle class="ec-ink" cx="${w - 18}" cy="${h - 14}" r="2"/>`;
    } else {
      s += `<circle class="ec-ink" cx="${w / 2}" cy="${h / 2}" r="${h / 2 - 5}"/>`;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + 0.4;
        s += `<path class="ec-ink" d="M${w / 2} ${h / 2} q${Math.cos(a) * 16} ${Math.sin(a) * 16} ${Math.cos(a + 1.2) * 8} ${Math.sin(a + 1.2) * 8}"/>`;
      }
      s += `<circle class="ec-fill" cx="${w / 2}" cy="${h / 2}" r="3"/>`;
    }
    return s;
  }

  function enCompHTML(c) {
    const r = ES.enc.res;
    const hot = r.temp > 45 ? '1' : '0';
    return `<g class="ec" data-id="${c.id}" data-sel="${ES.enc.sel === c.id ? '1' : '0'}" data-hot="${hot}"
      transform="translate(${EN.ox + c.x},${EN.oy + c.y})">
      <rect class="ec-body" x="0" y="0" width="${c.w}" height="${c.h}" rx="2"/>
      ${enSym(c)}
      <rect class="ec-halo" x="-3" y="-3" width="${c.w + 6}" height="${c.h + 6}" rx="3"/>
      <rect class="ec-hatch" x="0" y="0" width="${c.w}" height="${c.h}" rx="2"/>
      <text class="ec-label" x="${c.w / 2}" y="${c.h + 20}" text-anchor="middle">${c.tag}</text>
      <text class="ec-warn" x="${c.w / 2}" y="-9" text-anchor="middle">超出有效区</text>
    </g>`;
  }

  function enclosureSVG() {
    const c = ES.enc, W = c.W, H = c.H, OX = EN.ox, OY = EN.oy;
    const effL = 50, effT = 50, effW = W - 100, effH = H - 100;
    const railX = 100, railW = W - 200;
    let s = `<defs>
      <pattern id="enHatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="8" style="stroke:var(--error);stroke-width:1.6"/>
      </pattern>
      <pattern id="enPlate" width="50" height="50" patternUnits="userSpaceOnUse">
        <path d="M50 0H0V50" fill="none" style="stroke:#E3E6E9;stroke-width:1"/>
      </pattern>
    </defs>`;

    /* ---- 顶部/左侧 mm 标尺 ---- */
    s += `<g class="ruler-g">`;
    s += `<line class="ruler" x1="${OX}" y1="${OY - 22}" x2="${OX + W}" y2="${OY - 22}"/>`;
    for (let x = 0; x <= W; x += 50) {
      const major = x % 100 === 0;
      s += `<line class="ruler" x1="${OX + x}" y1="${OY - 22}" x2="${OX + x}" y2="${OY - 22 + (major ? 9 : 5)}"/>`;
      if (major && x % 200 === 0) s += `<text class="rtxt" x="${OX + x}" y="${OY - 27}" text-anchor="middle">${x}</text>`;
    }
    s += `<line class="ruler" x1="${OX - 22}" y1="${OY}" x2="${OX - 22}" y2="${OY + H}"/>`;
    for (let y = 0; y <= H; y += 50) {
      const major = y % 100 === 0;
      s += `<line class="ruler" x1="${OX - 22}" y1="${OY + y}" x2="${OX - 22 + (major ? 9 : 5)}" y2="${OY + y}"/>`;
      if (major && y % 200 === 0) s += `<text class="rtxt" x="${OX - 27}" y="${OY + y + 4}" text-anchor="end">${y}</text>`;
    }
    s += `</g>`;

    /* ---- 柜体正视图 ---- */
    s += `<rect class="cab-face" x="${OX}" y="${OY}" width="${W}" height="${H}"/>`;
    s += `<rect x="${OX + effL}" y="${OY + effT}" width="${effW}" height="${effH}" fill="url(#enPlate)"/>`;
    s += `<rect class="cab-in" x="${OX + effL}" y="${OY + effT}" width="${effW}" height="${effH}"/>`;

    /* 线槽（有效区内两侧） */
    [[56, 40], [W - 96, 40]].forEach(([dx, dw]) => {
      s += `<rect class="duct" x="${OX + dx}" y="${OY + 60}" width="${dw}" height="${H - 120}"/>`;
      for (let y = OY + 72; y < OY + H - 70; y += 16) {
        s += `<line class="duct-slot" x1="${OX + dx + 6}" y1="${y}" x2="${OX + dx + dw - 6}" y2="${y}"/>`;
      }
    });

    /* 导轨 */
    RAIL_Y.forEach((ry, i) => {
      s += `<rect class="rail" x="${OX + railX}" y="${OY + ry - 17.5}" width="${railW}" height="35"/>`;
      s += `<line class="ruler" x1="${OX + railX}" y1="${OY + ry}" x2="${OX + railX + railW}" y2="${OY + ry}" style="stroke-dasharray:10 6;opacity:.45"/>`;
    });

    /* PE / N 接地排（柜底） */
    s += `<g><rect class="rail" x="${OX + 100}" y="${OY + 1108}" width="260" height="18" rx="2"/>`;
    for (let i = 0; i < 6; i++) s += `<circle cx="${OX + 118 + i * 44}" cy="${OY + 1117}" r="3.4" fill="#9AA1A8"/>`;
    s += `<text class="rtxt" x="${OX + 372}" y="${OY + 1123}" style="font-size:11px">PE / N 接地排 260mm</text></g>`;
    /* 安装板固定孔 */
    [[62, 62], [W - 62, 62], [62, H - 62], [W - 62, H - 62]].forEach(([hx, hy]) => {
      s += `<circle class="ruler" cx="${OX + hx}" cy="${OY + hy}" r="5" style="fill:#E9EBED"/>`;
      s += `<line class="ruler" x1="${OX + hx - 3.5}" y1="${OY + hy}" x2="${OX + hx + 3.5}" y2="${OY + hy}"/>`;
      s += `<line class="ruler" x1="${OX + hx}" y1="${OY + hy - 3.5}" x2="${OX + hx}" y2="${OY + hy + 3.5}"/>`;
    });
    /* 导轨间距 */
    s += `<g>`;
    [300, 400, 300].forEach((gap, i) => {
      const y0 = OY + (i === 0 ? 0 : RAIL_Y[i - 1]);
      const y1 = OY + RAIL_Y[i];
      const dx = OX + W - 26;
      s += `<line class="ruler" x1="${dx}" y1="${y0}" x2="${dx}" y2="${y1}" style="stroke-dasharray:none;stroke:#A6ACB3"/>`;
      s += `<line class="ruler" x1="${dx - 5}" y1="${y0}" x2="${dx + 5}" y2="${y0}"/>`;
      s += `<line class="ruler" x1="${dx - 5}" y1="${y1}" x2="${dx + 5}" y2="${y1}"/>`;
      s += `<text class="rtxt" x="${dx - 8}" y="${(y0 + y1) / 2 + 5}" text-anchor="end" style="font-size:12px">${gap}</text>`;
    });
    s += `</g>`;
    /* 有效区标注 */
    s += `<text class="rtxt" x="${OX + 106}" y="${OY + 42}" style="font-size:10px">有效区 ${effW} × ${effH}</text>`;

    /* 柜门外框（后画，压在元件之上形成边框感） */
    s += `<g id="enComps">${c.comps.map(enCompHTML).join('')}</g>`;
    s += `<rect class="cab-out" x="${OX}" y="${OY}" width="${W}" height="${H}"/>`;

    /* 吸附参考线 + 放置预览 */
    s += `<line id="enSnap" class="snap-line" x1="${OX + railX}" y1="0" x2="${OX + railX + railW}" y2="0" style="opacity:0"/>`;
    s += `<g id="enGhost" hidden><rect class="ghost-rect" x="0" y="0" width="54" height="90"/></g>`;

    /* ---- 尺寸标注（宽 / 高） ---- */
    s += `<line class="ruler" x1="${OX}" y1="${OY - 52}" x2="${OX + W}" y2="${OY - 52}"/>`;
    s += `<line class="ruler" x1="${OX}" y1="${OY - 58}" x2="${OX}" y2="${OY - 46}"/>`;
    s += `<line class="ruler" x1="${OX + W}" y1="${OY - 58}" x2="${OX + W}" y2="${OY - 46}"/>`;
    s += `<text class="dimt" x="${OX + W / 2}" y="${OY - 56}" text-anchor="middle">${W}</text>`;
    s += `<line class="ruler" x1="${OX - 44}" y1="${OY}" x2="${OX - 44}" y2="${OY + H}"/>`;
    s += `<line class="ruler" x1="${OX - 50}" y1="${OY}" x2="${OX - 38}" y2="${OY}"/>`;
    s += `<line class="ruler" x1="${OX - 50}" y1="${OY + H}" x2="${OX - 38}" y2="${OY + H}"/>`;
    s += `<text class="dimt" x="${OX - 48}" y="${OY + H / 2}" transform="rotate(-90 ${OX - 48} ${OY + H / 2})" text-anchor="middle">${H}</text>`;

    /* ---- 图签 ---- */
    s += `<text class="dimt" x="${OX}" y="${OY + H + 46}" style="font-size:12px">柜体正视图 · ${W} × ${H} × ${c.D} mm · 有效区 ${effW} × ${effH}（边距 50）· 导轨 3 × TS35 · 元件 ${c.comps.length} 件</text>`;
    s += `<text class="rtxt" x="${OX + W}" y="${OY + H + 46}" text-anchor="end" style="font-size:11px">EL-001 · 1:10</text>`;
    return s;
  }

  /* 侧视（剖面）图：固定 150px 宽的窄栏。
     纵轴 = 柜高（按比例铺满栏高），横轴 = 深度（按真实 mm 压缩到栏宽），
     画出导轨 / 线槽断面与每个元件的深度投影，避免 150px 栏内出现大片留白。 */
  const CV_DEPTH = { breaker: 75, relay: 70, psu: 96, contactor: 84, drive: 110, terminal: 62, transformer: 90, lamp: 22, fan: 20 };

  function sideBox() {
    const el = $('#enSideSvg');
    const w = el ? el.clientWidth : 0, h = el ? el.clientHeight : 0;
    const vw = 150;
    const vh = (w > 20 && h > 20) ? Math.round(clamp(vw * h / w, 420, 1600)) : 900;
    return { vw: vw, vh: vh };
  }

  function sideSVG() {
    const c = ES.enc, H = c.H, D = c.D;
    const box = sideBox(), VW = box.vw, VH = box.vh;
    const PX = 12, PT = 14, PB = 34;          /* 左 / 上 / 下 内边距 */
    const dw = VW - PX - 10;                   /* 深度方向可用宽 */
    const plotH = VH - PT - PB;                /* 高度方向绘图高 */
    const sx = dw / D, sy = plotH / H;
    const X = (mm) => +(PX + mm * sx).toFixed(2);
    const Y = (mm) => +(PT + mm * sy).toFixed(2);
    const plate = D - 55;                      /* 安装板深度位 */

    let s = `<defs>
      <pattern id="cvHatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="0" y2="7" style="stroke:#4A5157;stroke-width:1.2"/>
      </pattern>
      <pattern id="cvPlate" width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M6 0H0V6" fill="none" style="stroke:#2F343A;stroke-width:1"/>
      </pattern>
    </defs>`;

    /* 柜体剖面外框 + 安装板纹 */
    s += `<rect class="cv-out" x="${PX}" y="${PT}" width="${dw}" height="${plotH}"/>`;
    s += `<rect x="${X(plate)}" y="${PT}" width="${(D - plate) * sx}" height="${plotH}" fill="url(#cvPlate)"/>`;
    /* 柜门（厚 22）+ 门内把手 */
    s += `<rect x="${PX}" y="${PT}" width="${22 * sx}" height="${plotH}" fill="url(#cvHatch)"/>`;
    s += `<line x1="${X(22)}" y1="${PT}" x2="${X(22)}" y2="${PT + plotH}"
      stroke="#8A9098" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
    s += `<rect x="${PX + 2}" y="${Y(H / 2) - 22}" width="${Math.max(2.4, 22 * sx - 4)}" height="44" rx="1" fill="#9AA1A8"/>`;
    /* 安装板线 */
    s += `<line x1="${X(plate)}" y1="${PT}" x2="${X(plate)}" y2="${PT + plotH}"
      stroke="#8A9098" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;

    /* 线槽断面：2 条浅灰竖条（纵向范围与主视图一致：60 ~ H-120） */
    [[56, 40], [D - 96, 40]].forEach(([d0, wmm]) => {
      s += `<rect class="cv-duct" x="${X(d0)}" y="${Y(60)}" width="${wmm * sx}" height="${(H - 180) * sy}"/>`;
      for (let y = 72; y < H - 130; y += 40) {
        s += `<line class="cv-tick" x1="${X(d0 + 5)}" y1="${Y(y)}" x2="${X(d0 + wmm - 5)}" y2="${Y(y)}"/>`;
      }
      s += `<text class="cv-t2" x="${X(d0 + wmm / 2)}" y="${Y(H - 96)}" text-anchor="middle">线槽</text>`;
    });

    /* 导轨断面：3 条细矩形贯穿侧视宽度，Y 与主视图导轨对齐 */
    RAIL_Y.forEach((ry, i) => {
      const y = Y(ry);
      s += `<rect class="cv-rail" x="${PX + 1}" y="${(y - 1.4).toFixed(2)}" width="${dw - 2}" height="2.8"/>`;
      s += `<rect class="cv-rail-x" x="${X(plate - 4)}" y="${(y - 3.4).toFixed(2)}" width="4" height="6.8"/>`;
      /* 导轨编号与 Y 坐标放在门与线槽之间的空白带，避免压住元件投影 */
      s += `<text class="cv-t" x="${X(28)}" y="${(y - 4).toFixed(2)}">${i + 1} · ${ry}</text>`;
    });

    /* 元件深度投影：同一导轨、同一高度带的元件合并为一个投影块（深度 60–110mm 不等） */
    const bands = {};
    c.comps.forEach(x => {
      const d = CV_DEPTH[x.kind] || 80;
      const key = x.rail + '|' + Math.round(x.y / 20) * 20;
      if (!bands[key]) bands[key] = { y0: x.y, y1: x.y + x.h, d: d, rail: x.rail, tags: [] };
      const b = bands[key];
      b.y0 = Math.min(b.y0, x.y);
      b.y1 = Math.max(b.y1, x.y + x.h);
      b.d = Math.max(b.d, d);
      b.tags.push(x.tag);
    });
    Object.keys(bands).forEach(k => {
      const b = bands[k];
      const isDoor = b.rail < 0;
      const w = isDoor ? 22 * sx : b.d * sx;
      const h = Math.max(2.6, (b.y1 - b.y0) * sy);
      const x0 = isDoor ? PX : X(plate - b.d);
      const y0 = Y(b.y0);
      const label = b.tags.length > 2 ? b.tags[0] + ' +' + (b.tags.length - 1) : b.tags.join(' ');
      s += `<g><title>${b.tags.join(' / ')} · 深 ${b.d} mm</title>
        <rect class="cv-comp" x="${x0}" y="${y0}" width="${w}" height="${h}"/>`;
      if (h >= 15) {
        /* 标签贴在投影块上沿，避免被导轨断面线穿过 */
        s += `<text class="cv-cl" x="${x0 + w / 2}" y="${(y0 + 6.5).toFixed(2)}"
          text-anchor="middle">${label}</text>`;
      }
      s += `</g>`;
    });

    /* 深度刻度 + 深度标注（底部） */
    const yb = PT + plotH + 12;
    s += `<line class="cv-tick" x1="${PX}" y1="${yb}" x2="${X(D)}" y2="${yb}"/>`;
    [0, 100, 200, D].forEach(mm => {
      s += `<line class="cv-tick" x1="${X(mm)}" y1="${yb}" x2="${X(mm)}" y2="${yb + 4}"/>`;
      s += `<text class="cv-t2" x="${X(mm)}" y="${yb + 13}" text-anchor="${mm === 0 ? 'start' : (mm === D ? 'end' : 'middle')}">${mm}</text>`;
    });
    s += `<text class="cv-t" x="${X(D / 2)}" y="${yb + 24}" text-anchor="middle">深 ${D} mm</text>`;
    return s;
  }

  function sideFtHTML() {
    const c = ES.enc;
    return `<div class="r"><span>柜门</span><b>22 mm</b></div>
      <div class="r"><span>深度</span><b>${c.D} mm</b></div>
      <div class="r"><span>元件</span><b>${c.comps.length} 件</b></div>`;
  }

  /* 把中列改成「正视图 + 固定 150px 侧视栏」的双栏工程视图（不动 index.html） */
  function buildEnStage() {
    const st = $('#elStageEn'), svg = $('#enSvg');
    if (!st || !svg || st.dataset.built) return;
    const main = document.createElement('div');
    main.className = 'en-main';
    const side = document.createElement('div');
    side.className = 'en-side';
    side.innerHTML = `<div class="en-side-h" id="enSideHead">侧视（深度 ${ES.enc.D}）</div>
      <svg id="enSideSvg" class="en-svg en-svg-side" viewBox="0 0 150 900"
           preserveAspectRatio="xMidYMid meet" role="img" aria-label="柜体侧视剖面图"></svg>
      <div class="en-side-ft">${sideFtHTML()}</div>`;
    st.insertBefore(main, svg);
    main.appendChild(svg);
    st.insertBefore(side, $('#enTip'));
    st.dataset.built = '1';
  }

  function renderEnclosure() {
    const svg = $('#enSvg');
    if (svg) {
      const c = ES.enc;
      svg.setAttribute('viewBox', '0 0 ' + (EN.ox + c.W + 44) + ' ' + (EN.oy + c.H + 76));
      svg.innerHTML = enclosureSVG();
    }
    const side = $('#enSideSvg');
    if (side) {
      const b = sideBox();
      side.setAttribute('viewBox', '0 0 ' + b.vw + ' ' + b.vh);
      side.innerHTML = sideSVG();
    }
    const sh = $('#enSideHead');
    if (sh) sh.textContent = '侧视（深度 ' + ES.enc.D + '）';
    const ft = $('.en-side-ft');
    if (ft) ft.innerHTML = sideFtHTML();
  }

  function enCompById(id) {
    return ES.enc.comps.filter(c => c.id === id)[0];
  }
  function enSelect(id) {
    ES.enc.sel = id;
    $$('.ec').forEach(g => { g.dataset.sel = g.dataset.id === id ? '1' : '0'; });
    statusEnclosure();
  }

  function enLeftHTML() {
    const c = ES.enc;
    return `<div class="el-left">
      <div class="el-zone" style="flex:0 0 auto">
        <div class="el-zone-head"><span class="t">柜体参数</span><span class="n">mm</span></div>
        <div class="el-zone-body" style="flex:0 0 auto;overflow:visible">
          <div class="en-param">
            <div class="field"><label>宽 W</label><span class="ctlr">
              <input class="ctl mono" type="number" data-en="W" value="${c.W}"><i class="suffix">mm</i></span></div>
            <div class="field"><label>高 H</label><span class="ctlr">
              <input class="ctl mono" type="number" data-en="H" value="${c.H}"><i class="suffix">mm</i></span></div>
            <div class="field"><label>深 D</label><span class="ctlr">
              <input class="ctl mono" type="number" data-en="D" value="${c.D}"><i class="suffix">mm</i></span></div>
            <div class="hint-inline" style="padding:4px 10px 2px">修改尺寸后 300ms 重算温升与载流量。</div>
          </div>
        </div>
      </div>
      <div class="el-zone" style="flex:1 1 0">
        <div class="el-zone-head"><span class="t">元件库</span><span class="n">${EN_LIB.length} 类</span></div>
        <div class="el-zone-body">
          <div class="en-lib">
            ${EN_LIB.map(x => `<button class="en-lib-item ${ES.enc.place && ES.enc.place.kind === x.kind ? 'is-armed' : ''}"
              type="button" data-enlib="${x.kind}" title="点击后在柜内放置">
              <span class="sw"><i style="width:${clamp(x.w / 4, 8, 18)}px;height:3px"></i></span>
              <span>${x.name}</span><span class="dim">${x.w}×${x.h}</span>
            </button>`).join('')}
          </div>
          <div class="sec-title" style="padding-top:6px">已放置<span class="n">${ES.enc.comps.length}</span></div>
          ${ES.enc.comps.map(x => `<div class="spec-row" style="${ES.enc.sel === x.id ? 'background:rgba(61,139,253,.13)' : ''}">
            <span class="k" style="width:auto">${x.tag}</span>
            <span class="v">${Math.round(x.x)}, ${Math.round(x.y)}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  function enBar(pct, tickPct, label) {
    return `<div class="en-bar"><i style="width:${clamp(pct, 0, 100)}%"></i>` +
      `<em data-l="${label}" style="left:${clamp(tickPct, 0, 100)}%"></em></div>`;
  }

  function renderEncRight() {
    const el = $('#elRightEn');
    if (!el) return;
    const c = ES.enc;
    if (c.calc) {
      el.innerHTML = `<div class="panel-head"><span class="ph-title">柜体校核</span><span class="ph-count">重算中</span></div>
        <div class="panel-body"><div class="en-calc"><span class="dt"></span><span>计算中</span></div>
        <div class="hint-inline">正在按柜体容积与元件功耗重算温升、载流量与空间余量（300ms 防抖）。</div></div>`;
      return;
    }
    const r = c.res;
    const overT = r.temp > 45, overL = r.load > 80, lowM = r.margin < 10;
    const head = (over, label, val, unit) =>
      `<div class="en-blk-h">${over ? `<span class="ico">${ICO.err}</span>` : ''}<span>${label}</span>` +
      `<span class="v"><b>${val}</b><span class="u">${unit}</span></span></div>`;
    el.innerHTML = `<div class="panel-head"><span class="ph-title">柜体校核</span>
        <span class="ph-count">${overT || overL || lowM ? '存在超限' : '校核通过'}</span></div>
      <div class="panel-body" style="padding-top:0">
        <div class="en-blk ${overT ? 'is-over' : ''}">
          ${head(overT, '柜内温升', r.temp, '°C')}
          ${enBar(Math.round(r.temp / 60 * 100), 75, '45')}
          <div class="en-blk-ft"><span>阈值 45°C</span><span style="margin-left:auto" class="${overT ? 'over' : ''}">
            ${overT ? '超限 +' + (r.temp - 45) + '°C' : '余量 ' + (45 - r.temp) + '°C'}</span></div>
        </div>
        <div class="en-blk ${overL ? 'is-over' : ''}">
          ${head(overL, '载流量占用', r.load, '%')}
          ${enBar(r.load, 80, '80')}
          <div class="en-blk-ft"><span>阈值 80%</span><span style="margin-left:auto" class="${overL ? 'over' : ''}">
            ${overL ? '超限 +' + (r.load - 80) + '%' : '可用 ' + (80 - r.load) + '%'}</span></div>
        </div>
        <div class="en-blk ${lowM ? 'is-over' : ''}">
          ${head(lowM, '空间余量', r.margin, '%')}
          ${enBar(r.margin, 10, '10')}
          <div class="en-blk-ft"><span>下限 10%</span><span style="margin-left:auto" class="${lowM ? 'over' : ''}">
            ${lowM ? '不足 ' + (10 - r.margin) + '%' : '满足'}</span></div>
        </div>
        <section class="pgroup" data-pgroup>
          <button class="pgroup-head" type="button" data-pgroup-head>计算依据<svg viewBox="0 0 16 16" class="ico"><path d="M4 6.5l4 4 4-4"/></svg></button>
          <div class="pgroup-body"><div class="pb-inner"><div class="pb-pad">
            <div class="field"><label>柜体容积</label><div class="ctl-ro mono">${(c.W * c.H * c.D / 1e9).toFixed(3)} m³</div></div>
            <div class="field"><label>元件功耗</label><div class="ctl-ro mono">${c.comps.reduce((s, x) => s + (x.heat || 0), 0)} W</div></div>
            <div class="field"><label>风扇散热</label><div class="ctl-ro mono">${c.comps.filter(x => x.kind === 'fan').length * 8} W</div></div>
            <div class="field"><label>元件数量</label><div class="ctl-ro mono">${c.comps.length} 件</div></div>
            <div class="field"><label>有效区</label><div class="ctl-ro mono">${c.W - 100} × ${c.H - 100} mm</div></div>
          </div></div></div>
        </section>
      </div>
      <div class="panel-foot"><button class="btn btn-primary btn-block" type="button" data-eact="en-calc">重新校核</button></div>`;

    /* 超限 → 元件叠斜纹 */
    const hot = r.temp > 45;
    $$('.ec').forEach(g => { g.dataset.hot = hot ? '1' : '0'; });
    statusEnclosure();
  }

  let encTimer;
  function scheduleEncCalc() {
    ES.enc.calc = true;
    renderEncRight();
    clearTimeout(encTimer);
    encTimer = setTimeout(() => {
      ES.enc.calc = false;
      ES.enc.res = enCalc();
      renderEncRight();
    }, 300);
  }

  function enToMM(ev) {
    const svg = $('#enSvg');
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x - EN.ox, y: p.y - EN.oy };
  }

  function snapRail(y, h) {
    let best = null, bd = 26;
    RAIL_Y.forEach(ry => {
      const d = Math.abs((y + h / 2) - ry);
      if (d < bd) { bd = d; best = ry; }
    });
    return best;
  }

  function enBounds(c) {
    return c.x >= 50 && c.y >= 50 && c.x + c.w <= ES.enc.W - 50 && c.y + c.h <= ES.enc.H - 50;
  }

  function bindEnclosure() {
    const svg = $('#enSvg');
    if (!svg) return;
    const snap = () => $('#enSnap');

    svg.addEventListener('pointerdown', e => {
      const g = e.target.closest('.ec');
      if (!g) return;
      const c = enCompById(g.dataset.id);
      if (!c) return;
      enSelect(c.id);
      const p = enToMM(e);
      ES.enc.drag = { id: c.id, dx: p.x - c.x, dy: p.y - c.y, moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch (_) { }
    });

    svg.addEventListener('pointermove', e => {
      /* 放置预览 */
      if (ES.enc.place) {
        const p = enToMM(e);
        const d = ES.enc.place;
        let x = p.x - d.w / 2, y = p.y - d.h / 2;
        const ry = snapRail(y, d.h);
        let sy = null;
        if (ry !== null) { y = ry - d.h / 2; sy = ry; }
        const gh = $('#enGhost');
        if (gh) {
          gh.hidden = false;
          gh.innerHTML = `<rect class="ghost-rect" x="${EN.ox + x}" y="${EN.oy + y}" width="${d.w}" height="${d.h}"/>`;
        }
        const ln = snap();
        if (ln) {
          if (sy !== null) {
            ln.setAttribute('y1', EN.oy + sy); ln.setAttribute('y2', EN.oy + sy);
            ln.setAttribute('x1', EN.ox + 50); ln.setAttribute('x2', EN.ox + ES.enc.W - 50);
            ln.style.opacity = .9;
          } else ln.style.opacity = 0;
        }
        return;
      }
      /* 拖动 */
      const dg = ES.enc.drag;
      if (!dg) return;
      const c = enCompById(dg.id);
      if (!c) return;
      const p = enToMM(e);
      let x = p.x - dg.dx, y = p.y - dg.dy;
      const ry = snapRail(y, c.h);
      let sy = null;
      if (ry !== null) { y = ry - c.h / 2; sy = ry; }
      c.x = clamp(x, -200, ES.enc.W + 200);
      c.y = clamp(y, -200, ES.enc.H + 200);
      dg.moved = true;
      const g = svg.querySelector(`.ec[data-id="${c.id}"]`);
      if (g) {
        g.setAttribute('transform', `translate(${EN.ox + c.x},${EN.oy + c.y})`);
        g.dataset.oob = enBounds(c) ? '0' : '1';
      }
      const ln = snap();
      if (ln) {
        if (sy !== null) {
          ln.setAttribute('y1', EN.oy + sy); ln.setAttribute('y2', EN.oy + sy);
          ln.setAttribute('x1', EN.ox + 50); ln.setAttribute('x2', EN.ox + ES.enc.W - 50);
          ln.style.opacity = .9;
        } else ln.style.opacity = 0;
      }
      statusSlots('X ' + round(c.x) + ' mm · Y ' + round(c.y) + ' mm',
        '温升 ' + ES.enc.res.temp + '°C · 载流 ' + ES.enc.res.load + '%',
        enBounds(c) ? { tone: 'ok', text: '校核通过' } : { tone: 'warn', text: '超出有效区' });
    });

    const endDrag = () => {
      const ln = snap();
      if (ln) ln.style.opacity = 0;
      if (ES.enc.drag) {
        const moved = ES.enc.drag.moved;
        ES.enc.drag = null;
        if (moved) {
          const l = $('#elLeftEn');
          if (l) l.innerHTML = enLeftHTML();
          scheduleEncCalc();
        }
      }
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    svg.addEventListener('click', e => {
      if (!ES.enc.place) return;
      if (e.target.closest('.ec')) return;
      const p = enToMM(e);
      const d = ES.enc.place;
      let x = p.x - d.w / 2, y = p.y - d.h / 2;
      const ry = snapRail(y, d.h);
      if (ry !== null) y = ry - d.h / 2;
      x = clamp(x, 50, ES.enc.W - 50 - d.w);
      y = clamp(y, 50, ES.enc.H - 50 - d.h);
      const n = ++ES.enc.seq[d.prefix];
      const id = 'e' + d.prefix + n;
      ES.enc.comps.push({
        id: id, tag: d.tag + n, kind: d.kind, w: d.w, h: d.h,
        x: x, y: y, heat: d.heat, amps: d.amps
      });
      ES.enc.place = null;
      renderEnclosure();
      enSelect(id);
      const l = $('#elLeftEn');
      if (l) l.innerHTML = enLeftHTML();
      const tip = $('#enTip');
      if (tip) { tip.hidden = false; tip.innerHTML = `${ICO.ok}<span>已放置 ${d.tag}${n} · 已吸附到最近导轨</span>`; }
      scheduleEncCalc();
    });
  }

  function enArm(kind) {
    const d = EN_LIB.filter(x => x.kind === kind)[0];
    if (!d) return;
    ES.enc.place = d;
    $$('.en-lib-item').forEach(b => b.classList.toggle('is-armed', b.dataset.enlib === kind));
    const tip = $('#enTip');
    if (tip) {
      tip.hidden = false;
      tip.innerHTML = `${ICO.pin}<span>已取用 ${d.name}，在柜内点击放置（Esc 取消）</span>`;
    }
  }

  /* ============================================================
     五、事件委托
     ============================================================ */

  function bindGlobal() {
    /* 域切换 */
    $$('.domsw-btn').forEach(b => b.addEventListener('click', () => setDomain(b.dataset.domain)));

    document.addEventListener('click', e => {
      const t = e.target;

      /* 电气模式 */
      const em = t.closest('[data-emode]');
      if (em) { showElecView(em.dataset.emode); return; }

      /* 左侧页浏览器折叠 */
      const pf = t.closest('[data-pgfold]');
      if (pf) {
        const i = pf.dataset.pgfold;
        const open = pf.classList.toggle('is-open');
        const list = $(`[data-pglist="${i}"]`);
        if (list) list.hidden = !open;
        ES['pg' + i] = open;
        return;
      }
      const pg = t.closest('[data-pgrow]');
      if (pg) {
        $$('.prow[data-pgrow]').forEach(r => r.classList.remove('is-sel'));
        pg.classList.add('is-sel');
        const msg = $('#stElMsg');
        if (msg) { msg.hidden = false; msg.textContent = '已切换页码：' + pg.querySelector('.lbl').textContent; }
        return;
      }

      /* 符号库 */
      const sy = t.closest('[data-esym]');
      if (sy) { armPlace(sy.dataset.esym); return; }
      const rc = t.closest('[data-erecent]');
      if (rc) {
        const map = { '-QF2': 'breaker', '-YV3': 'valve', '-FR2': 'thermal' };
        armPlace(map[rc.dataset.erecent] || 'breaker');
        return;
      }

      /* 交叉引用 */
      const xr = t.closest('[data-exref]');
      if (xr) {
        const x = XREF[Number(xr.dataset.exref)];
        ES.hl = x.target;
        applySheetState();
        $$('.xref').forEach(b => b.classList.remove('is-on'));
        xr.classList.add('is-on');
        const msg = $('#stElMsg');
        if (msg) { msg.hidden = false; msg.textContent = '已定位到页 ' + x.pg + ' · ' + x.tag + ' ' + x.kind; }
        return;
      }

      /* 校验项 */
      const ck = t.closest('[data-echk]');
      if (ck) {
        const c = CHECKS[Number(ck.dataset.echk)];
        ES.chk = c;
        applySheetState();
        $$('.chk').forEach(b => b.classList.remove('is-on'));
        ck.classList.add('is-on');
        const msg = $('#stElMsg');
        if (msg) { msg.hidden = false; msg.textContent = c.t + '：' + c.d; }
        return;
      }

      /* IO：筛选段 */
      const sg = t.closest('[data-ioseg]');
      if (sg) {
        ES.io.seg = ES.io.seg === sg.dataset.ioseg ? null : sg.dataset.ioseg;
        renderIoLeft(); renderIoStage();
        return;
      }
      /* IO：筛选树 */
      const tn = t.closest('[data-iotree]');
      if (tn) {
        const bits = tn.dataset.iotree.split(':');
        const cur = ES.io.tree;
        if (cur && cur.type === bits[0] && cur.v === bits[1]) ES.io.tree = null;
        else ES.io.tree = { type: bits[0], v: bits[1] };
        renderIoLeft(); renderIoStage();
        return;
      }
      /* IO：行内采纳 */
      const ad = t.closest('[data-eadopt]');
      if (ad) {
        const r = IO.filter(x => x.id === ad.dataset.eadopt)[0];
        if (r) adoptRows([r], true);
        return;
      }
      /* IO：行 */
      const ir = t.closest('[data-iorow]');
      if (ir) { selectIoRow(ir.dataset.iorow); return; }

      /* 柜体：元件库 */
      const el2 = t.closest('[data-enlib]');
      if (el2) { enArm(el2.dataset.enlib); return; }

      /* 动作 */
      const act = t.closest('[data-eact]');
      if (act) { handleElecAct(act.dataset.eact); return; }
    });

    /* 输入 */
    document.addEventListener('input', e => {
      const el = e.target;
      if (el.dataset.en) {
        const k = el.dataset.en;
        const v = Number(el.value);
        if (!isFinite(v)) return;
        ES.enc[k] = clamp(v, 400, 2000);
        renderEnclosure();
        const l = $('#elLeftEn');
        if (l) l.innerHTML = enLeftHTML();
        scheduleEncCalc();
        const sc = $('#enCtxScale');
        if (sc) sc.textContent = '1:10 · ' + ES.enc.W + '×' + ES.enc.H + '×' + ES.enc.D;
        return;
      }
      if (el.id === 'elSymSearch') {
        const list = $('#elSymList');
        if (list) list.innerHTML = symbolListHTML(el.value.trim());
      }
    });

    /* 键盘 */
    document.addEventListener('keydown', onKey, true);

    /* 命令面板中的机械命令：若当前在电气域，先切回机械域 */
    document.addEventListener('click', e => {
      if (ES.domain !== 'elec') return;
      if (e.target.closest('[data-pcmd]')) setDomain('mech');
    }, true);

    /* 视口变化：IO 表格占位行与侧视剖面按实际栏宽/栏高重算 */
    let rzT = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rzT);
      rzT = setTimeout(() => {
        if (ES.domain !== 'elec') return;
        if (ES.view === 'io') ioTailFill();
        if (ES.view === 'enclosure') renderEnclosure();
      }, 140);
    });
  }

  function handleElecAct(a) {
    switch (a) {
      case 'check': {
        const g = $('#elChkGroup');
        if (g) { g.classList.remove('is-collapsed'); g.scrollIntoView({ block: 'nearest' }); }
        ES.chk = CHECKS[0];
        applySheetState();
        const r = $('#elRight');
        if (r) r.innerHTML = schematicRightHTML();
        const g2 = $('#elChkGroup');
        if (g2) g2.classList.remove('is-collapsed');
        statusSlots('-A1 · 24V DC', '校验完成 · 3 条结果（1 错误 / 2 警告）',
          { tone: 'warn', text: '校验 3 项待处理' });
        break;
      }
      case 'xref': {
        const g = $('#elChkGroup');
        if (g) g.classList.add('is-collapsed');
        ES.hl = XREF[0].target;
        applySheetState();
        const r = $('#elRight');
        if (r) r.innerHTML = schematicRightHTML();
        break;
      }
      case 'io-adopt-all': {
        const list = IO.filter(r => stOf(r) === 'reco');
        adoptRows(list);
        break;
      }
      case 'io-adopt-sel': {
        const r = IO.filter(x => x.id === ES.io.sel)[0];
        if (r) adoptRows([r], true);
        break;
      }
      case 'io-add': {
        const msg = $('#stElMsg');
        if (msg) {
          msg.hidden = false;
          msg.textContent = '新增点位：从当前筛选派生一行空点位（原型为只读演示）';
        }
        break;
      }
      case 'io-ignore':
        ES.io.ignored = true;
        renderIoStage();
        break;
      case 'io-reset':
        ES.io.seg = null; ES.io.tree = null;
        renderIoLeft(); renderIoStage();
        break;
      case 'io-sync': {
        const c2 = ioCounts();
        statusSlots(ioSummary(c2), '上次同步 ' + new Date().toTimeString().slice(0, 5),
          c2.bad ? { tone: 'warn', text: c2.bad + ' 处冲突待处理' } : { tone: 'ok', text: '无冲突' });
        break;
      }
      case 'io-export':
        statusSlots('地址表已导出', 'EL-001-IO.csv · ' + IO.length + ' 行', { tone: 'ok', text: '导出完成' });
        break;
      case 'en-calc':
        scheduleEncCalc();
        break;
      default: break;
    }
  }

  function onKey(e) {
    /* 域切换快捷键 */
    if (e.ctrlKey && e.altKey && (e.key === '1' || e.key === '2')) {
      e.preventDefault();
      e.stopPropagation();
      setDomain(e.key === '2' ? 'elec' : 'mech');
      return;
    }
    if (ES.domain !== 'elec') return;
    const pal = $('#palette');
    if (pal && !pal.hidden) return;         /* 命令面板打开时交还给 app.js */

    if (e.key === 'Escape') {
      e.stopPropagation();
      if (ES.place) { disarmPlace(); return; }
      if (ES.enc.place) {
        ES.enc.place = null;
        $$('.en-lib-item').forEach(b => b.classList.remove('is-armed'));
        const gh = $('#enGhost'); if (gh) gh.hidden = true;
        return;
      }
      if (ES.sym) { selectSym(null); return; }
      const inp = document.activeElement;
      if (inp && /input|textarea/i.test(inp.tagName)) inp.blur();
      return;
    }
    if (e.key === 'f' || e.key === 'F') e.stopPropagation();
  }

  /* ============================================================
     六、初始化
     ============================================================ */
  function init() {
    buildChrome();

    /* 首屏不留空：原理图默认选中 -KM1，IO 默认选中第一条建议行 */
    ES.sym = 'km1';
    ES.io.sel = (IO.filter(r => r.reco)[0] || IO[0]).id;

    /* 左/右/中骨架 */
    const l = $('#elLeft'), r = $('#elRight');
    if (l) l.innerHTML = schematicLeftHTML();
    if (r) r.innerHTML = schematicRightHTML();

    const ioL = $('#elLeftIo'), ioR = $('#elRightIo'), ioM = $('#elStageIo');
    if (ioL) ioL.innerHTML = ioLeftHTML();
    if (ioR) ioR.innerHTML = ioRightHTML();
    if (ioM) ioM.innerHTML = ioStageHTML();

    initEncComps();
    ES.enc.res = enCalc();
    const enL = $('#elLeftEn'), enM = $('#elStageEn'), enR = $('#elRightEn');
    buildEnStage();
    if (enL) enL.innerHTML = enLeftHTML();
    if (enM) renderEnclosure();
    if (enR) renderEncRight();

    renderSheet();
    bindSchematic();
    bindEnclosure();
    bindGlobal();
    applySheetState();
    statusSchematic();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ---- 元器件包符号 → 内置符号库映射（按需放置 API） ---- */
  const PACK_SYMBOL_ALIASES = { fu1: 'fuse', es1: 'estop' };
  const PACK_SYMBOL_LIB = {
    qf1: 'breaker', km1: 'coil', km1c: 'contactor', fr1: 'thermal',
    ka1: 'coil', sb1: 'button', a1: 'plc', m1: 'motor',
    yv1: 'valve', yv2: 'valve', x1: 'terminal', hl1: 'lamp'
  };

  function resolvePackLibKey(key) {
    if (typeof key !== 'string' || !key) return null;
    const direct = LIB_SYM.filter(x => x.key === key)[0];
    if (direct) return direct.key;
    const mapped = Object.prototype.hasOwnProperty.call(PACK_SYMBOL_LIB, key)
      ? PACK_SYMBOL_LIB[key]
      : Object.prototype.hasOwnProperty.call(PACK_SYMBOL_ALIASES, key) ? PACK_SYMBOL_ALIASES[key] : null;
    if (!mapped) return null;
    return LIB_SYM.filter(x => x.key === mapped)[0] ? mapped : null;
  }

  function symbolAreaTaken(x, y, w, h) {
    const boxes = [
      { x: 288, y: 237, w: 122, h: 50 },
      { x: 14, y: 238, w: 166, h: 50 }
    ];
    const svg = $('#elSheet');
    if (svg) {
      $$('.esym', svg).forEach(g => {
        const r = g.querySelector('rect.ehit');
        if (!r) return;
        const bx = Number(r.getAttribute('x'));
        const by = Number(r.getAttribute('y'));
        const bw = Number(r.getAttribute('width'));
        const bh = Number(r.getAttribute('height'));
        if ([bx, by, bw, bh].every(Number.isFinite)) boxes.push({ x: bx, y: by, w: bw, h: bh });
      });
    }
    const pad = 1;
    return boxes.some(b => x < b.x + b.w + pad && x + w > b.x - pad && y < b.y + b.h + pad && y + h > b.y - pad);
  }

  function findFreeSymbolSpot(w, h) {
    let gx = 24, gy = 18, tries = 0;
    while (tries < 60) {
      const px = clamp(gx - w / 2, 12, 396);
      const py = clamp(gy - h / 2, 12, 282);
      if (!symbolAreaTaken(px, py, w, h)) return { x: px + w / 2, y: py + h / 2 };
      gx += 24;
      if (gx > 396) { gx = 24; gy += 18; }
      tries += 1;
    }
    return { x: 24, y: 18 };
  }

  function insertSymbol(key, opts) {
    try {
      const libKey = resolvePackLibKey(key);
      if (!libKey) return { ok: false, message: '原理图符号不存在：' + String(key) };
      if (ES.domain !== 'elec') setDomain('elec');
      if (ES.view !== 'schematic') showElecView('schematic');
      if (!$('#elPlaceLayer')) return { ok: false, message: '放置失败：原理图尚未渲染' };
      armPlace(libKey);
      if (!ES.place) return { ok: false, message: '放置失败：图纸尚未就绪' };
      const box = libBox();
      const hasX = Boolean(opts && typeof opts.x === 'number' && Number.isFinite(opts.x));
      const hasY = Boolean(opts && typeof opts.y === 'number' && Number.isFinite(opts.y));
      let x = hasX ? opts.x : null;
      let y = hasY ? opts.y : null;
      if (x === null || y === null) {
        const spot = findFreeSymbolSpot(box.w, box.h);
        if (x === null) x = spot.x;
        if (y === null) y = spot.y;
      }
      placeSymbol(x, y);
      const id = ES.sym;
      const def = id ? ES.defs[id] : null;
      if (!id || !def) return { ok: false, message: '放置失败：图纸尚未就绪' };
      return { ok: true, tag: def.tag, id: id };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    } finally {
      disarmPlace();
    }
  }

  /* 供调试/外部调用 */
  /**
   * 用「工程生成」的图纸替换示例页（EL-001 滑台气缸控制柜）。
   * 生成器在 desktop/src/elec/schematic.ts，按输送机的驱动/传感器/IO 出图。
   */
  function setSchematic(payload) {
    const svg = $('#elSheet');
    if (!svg) return false;
    if (!payload || typeof payload.svg !== 'string' || payload.svg.length < 100) return false;
    svg.innerHTML = payload.svg + '<g id="elPlaceLayer"></g><g id="elGhost" class="eghost" hidden></g>';
    if (payload.meta) {
      ES.machine = payload.meta;
      const label = $('#elSheetProject');
      if (label) label.textContent = payload.meta.project || '';
      renderMachinePageTree(payload.meta);
      // 上下文条与状态栏的页码是页面级常量，注入后必须显式刷新，
      // 否则顶部还写着示例的 3/12、页属性却是 1/8
      const ctxPage = $('#elCtxPage');
      if (ctxPage) ctxPage.textContent = 'A3 420×297 · 1:1 · 页 ' + pageLabel();
      if (typeof statusSchematic === 'function') statusSchematic();
    }
    applySheetState();
    ensureSheetsRerendered();
    return true;
  }

  /** 页浏览器同步成"工程图纸"，不再显示示例的 12 页 */
  function renderMachinePageTree(meta) {
    const tree = $('#elPageTree');
    if (!tree) return;
    const no = meta.drawingNo || 'EL-CV-001';
    const rows = (meta.devices || []).slice(0, 14).map((d) => {
      const tag = Array.isArray(d) ? d[0] : d.tag;
      const name = Array.isArray(d) ? d[1] : d.name;
      const qty = Array.isArray(d) ? d[2] : (d.qty || 1);
      return `
      <div class="prow" style="padding-left:30px">
        <span class="pt-ico">${ICO.page}</span>
        <span class="lbl">${tag || ''} ${name || ''}</span>
        <span class="pg">${qty || 1}</span>
      </div>`;
    }).join('');
    tree.innerHTML = `<div class="tree" role="tree">
      <div class="prow is-open" style="padding-left:8px">
        <span class="tw">${ICO.chev}</span><span class="pt-ico">${ICO.folder}</span>
        <span class="lbl">工程图纸</span><span class="pg">1</span>
      </div>
      <div class="prow is-sel" style="padding-left:30px">
        <span class="pt-ico">${ICO.page}</span>
        <span class="lbl">1.1 ${no} 原理图</span>
        <span class="pg">A3</span>
      </div>
      <div class="prow is-open" style="padding-left:8px">
        <span class="tw">${ICO.chev}</span><span class="pt-ico">${ICO.folder}</span>
        <span class="lbl">本页元件</span><span class="pg">${(meta.devices || []).length}</span>
      </div>
      <div>${rows}</div>
    </div>`;
  }

  /** 图纸换成工程生成版后，右栏元件属性表要跟着换 */
  function ensureSheetsRerendered() {
    const r = $('[data-panel="right"][data-for="schematic"]') || $('#elRight');
    if (r) r.innerHTML = schematicRightHTML();
  }

  window.ElecDomain = {
    setDomain: setDomain,
    setSchematic: setSchematic,
    hasMachineSheet: () => !!(ES.machine && ES.machine.generated),
    show: showElecView,
    insertSymbol: insertSymbol,
    state: ES
  };
})();
