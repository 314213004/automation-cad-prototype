/**
 * 由整机工程生成电气原理图（A3 单页）。
 *
 * 只输出图纸必需的客观数据：主回路器件（按电机功率选型）、控制回路的操作件与
 * 传感输入、IO 点位、元件表、标题栏。不做"看起来很专业"的装饰，也不臆造型号：
 * 型号来自 drive 估计与标准件命名规则，估算项用 `est:` 前缀标出。
 *
 * 生成的 SVG 复用电气域既有样式类（ic / it / it-s / it-t / esym），保证与手工页一致。
 */

export interface ElectricMachineModel {
  /** 工程名，进标题栏 */
  project: string;
  /** 驱动：功率 kW、转速 rpm、减速比 */
  drive: { powerKw: number; rpm: number; ratio: number; voltage: 380 | 220 };
  /** 传感器（光电/接近开关），按工艺顺序 */
  sensors: Array<{ tag: string; label: string; type: 'photo' | 'proximity' }>;
  /** 是否配急停与启动/停止按钮 */
  controls: { estop: boolean; startStop: boolean };
  /** 输送线参数，标注在图纸说明里 */
  notes?: string[];
  /** 图纸编号 */
  drawingNo?: string;
}

export interface ElectricDevice {
  tag: string;
  name: string;
  model: string;
  spec: string;
  qty: number;
  /** 选型来自估算而非样本 */
  estimated?: boolean;
}

export interface ElectricSheet {
  svg: string;
  devices: ElectricDevice[];
  io: Array<{ address: string; tag: string; label: string; direction: 'DI' | 'DO' }>;
}

function esc(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/** 按电机功率选断路器/接触器/热继（IEC 常规档位，不是灵异数字） */
export function selectMotorProtection(powerKw: number): { breaker: string; contactor: string; thermal: string; currentA: number } {
  // 380V 三相：I ≈ P / (√3 × U × cosφ × η)，取 cosφ·η = 0.8
  const currentA = Math.round(((powerKw * 1000) / (1.732 * 380 * 0.8)) * 10) / 10;
  const breaker = currentA <= 1 ? 'iC65N 3P C1' : currentA <= 2 ? 'iC65N 3P C2' : currentA <= 4 ? 'iC65N 3P C4' : currentA <= 6.3 ? 'iC65N 3P C6' : 'iC65N 3P C10';
  const contactor = currentA <= 1 ? 'LC1D09' : currentA <= 4 ? 'LC1D09' : currentA <= 7 ? 'LC1D12' : 'LC1D18';
  const thermal = currentA <= 1 ? 'LRD05 (0.63~1A)' : currentA <= 2 ? 'LRD07 (1.6~2.5A)' : currentA <= 4 ? 'LRD08 (2.5~4A)' : currentA <= 6 ? 'LRD10 (4~6A)' : 'LRD12 (5.5~8A)';
  return { breaker, contactor, thermal, currentA };
}

export function buildElectricalSheet(model: ElectricMachineModel): ElectricSheet {
  const { powerKw, rpm, ratio } = model.drive;
  const prot = selectMotorProtection(powerKw);
  const drawingNo = model.drawingNo ?? 'EL-CV-001';
  const sensors = model.sensors.slice(0, 8);

  const devices: ElectricDevice[] = [
    { tag: '-QF1', name: '电机保护断路器 3P', model: prot.breaker, spec: `${prot.currentA} A`, qty: 1, estimated: true },
    { tag: '-KM1', name: '交流接触器', model: prot.contactor, spec: `线圈 220V AC · ${prot.currentA} A`, qty: 1, estimated: true },
    { tag: '-FR1', name: '热过载继电器', model: prot.thermal, spec: `整定 ${prot.currentA} A`, qty: 1, estimated: true },
    { tag: '-M1', name: '减速电机', model: `0.37~${powerKw} kW 级`, spec: `${rpm} rpm · i=${ratio}`, qty: 1 },
    { tag: '-G1', name: '开关电源 24V', model: 'NDR-120-24', spec: '24V DC / 5A', qty: 1 }
  ];
  if (model.controls.estop) devices.push({ tag: '-SB1', name: '急停按钮（常闭）', model: 'XB2-BS542C', spec: '蘑菇头 · 旋转复位', qty: 1 });
  if (model.controls.startStop) {
    devices.push({ tag: '-SB2', name: '启动按钮（常开）', model: 'XB2-BA31C', spec: '绿色', qty: 1 });
    devices.push({ tag: '-SB3', name: '停止按钮（常闭）', model: 'XB2-BA42C', spec: '红色', qty: 1 });
  }
  devices.push({ tag: '-KA1', name: '中间继电器', model: 'MY2NJ', spec: '24V DC · 2 组转换', qty: 1 });
  devices.push({ tag: '-A1', name: 'PLC', model: 'CPU + DI/DO 模块', spec: `DI ${sensors.length + 3} 点 / DO 4 点`, qty: 1, estimated: true });
  for (const sensor of sensors) {
    devices.push({
      tag: sensor.tag,
      name: sensor.type === 'photo' ? '光电传感器' : '接近开关',
      model: sensor.type === 'photo' ? 'E3Z-D61' : 'TL-Q5MC1',
      spec: 'NPN · 24V DC',
      qty: 1
    });
  }
  devices.push({ tag: '-X1', name: '端子排', model: 'UK-2.5B', spec: '2.5 mm² · 24 位', qty: 1 });

  const io: ElectricSheet['io'] = [
    { address: 'DI0.0', tag: '-SB1', label: '急停（常闭）', direction: 'DI' },
    ...(model.controls.startStop
      ? [
          { address: 'DI0.1', tag: '-SB2', label: '启动', direction: 'DI' as const },
          { address: 'DI0.2', tag: '-SB3', label: '停止', direction: 'DI' as const }
        ]
      : []),
    ...sensors.map((sensor, index) => ({
      address: `DI${sensors.some((s) => s.tag === '-SB2') ? 1 : 0}.${index + (model.controls.startStop ? 3 : 1)}`,
      tag: sensor.tag,
      label: sensor.label,
      direction: 'DI' as const
    })),
    { address: 'DO0.0', tag: '-KM1', label: '输送电机运行', direction: 'DO' },
    { address: 'DO0.1', tag: '-HL1', label: '运行指示', direction: 'DO' }
  ];

  return { svg: renderSheet(model, devices, io, prot, drawingNo), devices, io };
}

function renderSheet(
  model: ElectricMachineModel,
  devices: ElectricDevice[],
  io: ElectricSheet['io'],
  prot: { breaker: string; contactor: string; thermal: string; currentA: number },
  drawingNo: string
): string {
  const W = 420;
  const H = 297;
  const out: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, cls = 'ic'): string =>
    `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const text = (x: number, y: number, value: string, cls = 'it-s', size = 3.4, anchor = 'start'): string =>
    `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}" style="font-size:${size}px">${esc(value)}</text>`;

  out.push('<defs><pattern id="elGrid" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M4 0H0V4" class="ic-grid"/></pattern></defs>');
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#elGrid)"/>`);
  // 图框：必须描边（.if 是 fill，会把整张纸刷成墨色）
  out.push(`<rect class="ic" x="6" y="6" width="${W - 12}" height="${H - 12}"/>`);
  out.push(`<rect class="ic" x="10" y="10" width="${W - 20}" height="${H - 20}"/>`);

  out.push(text(14, 20, `${model.project} · 皮带输送线电气原理图`, 'it-t', 5));
  out.push(text(W - 16, 20, `${drawingNo} · 由工程 BOM 自动生成`, 'it-s', 3.2, 'end'));

  /* ---- 主回路 ---- */
  const mx = 30;
  const top = 44;
  const bottom = 214;
  out.push(text(mx + 46, 38, '主回路 · AC 380V 50Hz', 'it-t', 4.2));
  ['L1', 'L2', 'L3'].forEach((phase, index) => {
    const x = mx + index * 12;
    out.push(line(x, top, x, bottom, 'ic ic-b'));
    out.push(text(x, top - 4, phase, 'it', 3.6, 'middle'));
  });
  out.push(line(mx + 24, top, mx + 24, bottom, 'ic ic-b'));

  const branch = (y: number, tag: string, name: string, model2: string): void => {
    for (let index = 0; index < 3; index += 1) {
      out.push(line(mx + index * 12, y, mx + 48, y));
    }
    out.push(`<rect class="ic" x="${mx + 30}" y="${y - 9}" width="16" height="18"/>`);
    for (let index = 0; index < 3; index += 1) {
      out.push(line(mx + index * 12 + 5, y - 5, mx + index * 12 + 11, y + 5));
    }
    out.push(text(mx + 52, y + 1.2, tag, 'it', 4.2));
    out.push(text(mx + 52, y + 5.4, `${name} · ${model2}`, 'it-s', 3.1));
  };

  branch(70, '-QF1', '电机保护断路器', prot.breaker);
  branch(112, '-KM1', '接触器主触头', prot.contactor);
  branch(154, '-FR1', '热继电器', prot.thermal);

  // 电机
  const my = 186;
  for (let index = 0; index < 3; index += 1) out.push(line(mx + index * 12, 176, mx + index * 12, my - 12));
  out.push(`<circle class="ic" cx="${mx + 24}" cy="${my}" r="13"/>`);
  out.push(text(mx + 24, my + 1.6, 'M', 'it', 5.4, 'middle'));
  out.push(text(mx + 24, my + 6.4, '3~', 'it-s', 3.2, 'middle'));
  out.push(line(mx + 24, my + 13, mx + 24, bottom));
  // PE
  out.push(line(mx + 40, my, mx + 46, my));
  out.push(line(mx + 40, my + 6, mx + 46, my + 6));
  out.push(text(mx + 48, my + 1.4, 'PE', 'it-s', 3.2));
  out.push(text(mx + 48, my + 7.4, '-M1', 'it', 4.2));
  out.push(text(mx + 48, my + 11.6, `${model.drive.powerKw} kW · ${model.drive.rpm} rpm · i=${model.drive.ratio}`, 'it-s', 3.1));

  /* ---- 控制回路 ---- */
  const cx0 = 150;
  const cx1 = 268;
  const cy0 = 62;
  const cy1 = 200;
  out.push(text(cx0, 38, '控制回路 · DC 24V', 'it-t', 4.2));
  out.push(line(cx0, cy0, cx0, cy1, 'ic ic-b'));
  out.push(line(cx1, cy0, cx1, cy1, 'ic ic-b'));
  out.push(text(cx0, cy0 - 4, '+24V', 'it', 3.6, 'middle'));
  out.push(text(cx1, cy0 - 4, '0V', 'it', 3.6, 'middle'));

  let row = cy0 + 18;
  const coil = (y: number, tag: string, label: string): void => {
    out.push(line(cx0, y, cx0 + 14, y));
    out.push(`<rect class="ic" x="${cx0 + 14}" y="${y - 7}" width="14" height="14"/>`);
    out.push(line(cx0 + 28, y, cx1, y));
    out.push(text(cx0 + 32, y + 1.2, tag, 'it', 3.8));
    out.push(text(cx0 + 32, y + 4.8, label, 'it-s', 3));
  };
  if (model.controls.estop) coil(row, '-SB1', '急停（常闭）');
  row += 18;
  if (model.controls.startStop) {
    coil(row, '-SB2', '启动（常开）');
    row += 18;
    coil(row, '-SB3', '停止（常闭）');
    row += 18;
  }
  coil(row, '-KA1', '继电器线圈 · 自锁');
  row += 18;
  coil(row, '-KM1', '接触器线圈（DO0.0）');

  // 传感输入
  let sy = cy0 + 18;
  for (const sensor of model.sensors.slice(0, 6)) {
    out.push(line(cx1 + 40, sy, cx1 + 58, sy));
    out.push(`<rect class="ic" x="${cx1 + 58}" y="${sy - 6}" width="12" height="12"/>`);
    out.push(text(cx1 + 74, sy + 1.2, sensor.tag, 'it', 3.6));
    out.push(text(cx1 + 74, sy + 4.8, sensor.label, 'it-s', 2.9));
    sy += 14;
  }

  /* ---- IO 表 ---- */
  const ix = 330;
  out.push(text(ix, 38, 'IO 点位', 'it-t', 4.2));
  out.push(text(ix, 45, '地址', 'it-s', 3, 'start'));
  out.push(text(ix + 26, 45, '元件', 'it-s', 3, 'start'));
  out.push(text(ix + 52, 45, '功能', 'it-s', 3, 'start'));
  let iy = 52;
  for (const point of io.slice(0, 14)) {
    out.push(text(ix, iy, point.address, 'it-s', 3));
    out.push(text(ix + 26, iy, point.tag, 'it-s', 3));
    out.push(text(ix + 52, iy, point.label, 'it-s', 3));
    iy += 7;
  }

  /* ---- 元件表 ---- */
  const tx = 14;
  const ty = 226;
  out.push(text(tx, ty - 4, '元件表', 'it-t', 4));
  out.push(text(tx, ty + 3, '位号', 'it-s', 3));
  out.push(text(tx + 26, ty + 3, '名称', 'it-s', 3));
  out.push(text(tx + 92, ty + 3, '型号', 'it-s', 3));
  out.push(text(tx + 176, ty + 3, '规格', 'it-s', 3));
  out.push(text(tx + 250, ty + 3, '数量', 'it-s', 3));
  const perRow = 2;
  const rowH = 7;
  devices.slice(0, 16).forEach((device, index) => {
    const col = Math.floor(index / (devices.length > 8 ? 8 : 8));
    const line2 = index % 8;
    const x = tx + col * 200;
    const y = ty + 10 + line2 * rowH;
    out.push(text(x, y, device.tag, 'it-s', 2.9));
    out.push(text(x + 26, y, device.estimated ? `${device.name} *` : device.name, 'it-s', 2.9));
    out.push(text(x + 92, y, device.model, 'it-s', 2.9));
    out.push(text(x + 176, y, `${device.spec}${device.qty > 1 ? ` ×${device.qty}` : ''}`, 'it-s', 2.9));
    out.push(text(x + 250, y, String(device.qty), 'it-s', 2.9));
  });
  void perRow;

  /* ---- 说明 + 标题栏 ---- */
  const noteY = H - 16;
  const notes = ['* 型号为按功率/点位的选型估算，需按供应商样本复核', ...(model.notes ?? [])].slice(0, 2);
  notes.forEach((note, index) => out.push(text(tx, noteY + index * 4 - 2, note, 'it-s', 2.9)));

  out.push(`<rect class="ic" x="${W - 132}" y="${H - 34}" width="118" height="20"/>`);
  out.push(text(W - 128, H - 27, model.project, 'it', 3.8));
  out.push(text(W - 128, H - 21, `图号 ${drawingNo}`, 'it-s', 3));
  out.push(text(W - 128, H - 17, 'A3 · 1:1 · 第 1/1 页', 'it-s', 3));

  return out.join('');
}
