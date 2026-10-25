import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildElectricalSheet, selectMotorProtection } from '../../src/elec/schematic.ts';

const MODEL = {
  project: '皮带输送线 2400×400',
  drive: { powerKw: 0.37, rpm: 76, ratio: 18, voltage: 380 },
  sensors: [
    { tag: '-PE1', label: '进料检测', type: 'photo' },
    { tag: '-PE2', label: '出料检测', type: 'photo' }
  ],
  controls: { estop: true, startStop: true },
  notes: ['线体 2400×400 mm'],
  drawingNo: 'EL-CV-001'
};

test('电机保护按功率算电流并选档（0.37 kW 三相 ≈ 0.7 A）', () => {
  const sel = selectMotorProtection(0.37);
  assert.equal(sel.currentA, 0.7);
  assert.match(sel.breaker, /C1|C2/);
  assert.match(sel.thermal, /LRD0/);
  assert.equal(selectMotorProtection(2.2).currentA, 4.2, '2.2 kW 应落在 4 A 档附近');
});

test('图纸包含主回路与电机标注，不再出现示例柜的滑台气缸', () => {
  const { svg } = buildElectricalSheet(MODEL);
  for (const tag of ['-QF1', '-KM1', '-FR1', '-M1', '-SB1', '-SB2', '-SB3', '-KA1', '-PE1', '-PE2']) {
    assert.ok(svg.includes(tag), `图纸缺少 ${tag}`);
  }
  assert.ok(svg.includes('0.37 kW'), '电机功率没标');
  assert.ok(svg.includes('皮带输送线 2400×400'), '标题栏没写工程名');
  assert.ok(!svg.includes('滑台气缸'), '不应残留示例柜内容');
  assert.ok(svg.includes('PE'), '缺 PE 线');
});

test('IO 点位从元件推出来，地址不重复', () => {
  const { io } = buildElectricalSheet(MODEL);
  const addresses = io.map((point) => point.address);
  assert.equal(new Set(addresses).size, addresses.length, 'IO 地址重复');
  assert.ok(io.some((point) => point.tag === '-PE1' && point.direction === 'DI'));
  assert.ok(io.some((point) => point.direction === 'DO' && point.tag === '-KM1'));
  assert.ok(io.length >= 6);
});

test('元件表与图纸一致：每个位号都有型号与规格', () => {
  const { devices } = buildElectricalSheet(MODEL);
  assert.ok(devices.length >= 10);
  for (const device of devices) {
    assert.ok(device.tag.startsWith('-'), `${device.tag} 位号格式不对`);
    assert.ok(device.model.length > 0, `${device.tag} 缺型号`);
    assert.ok(device.spec.length > 0, `${device.tag} 缺规格`);
    assert.ok(device.qty >= 1);
  }
  // 估算项必须能被识别，不能冒充样本值
  const estimated = devices.filter((device) => device.estimated).map((device) => device.tag);
  assert.ok(estimated.includes('-QF1') && estimated.includes('-A1'), '选型估算项未标注');
});

test('没有急停/按钮的机型不生成对应器件', () => {
  const minimal = buildElectricalSheet({
    ...MODEL,
    controls: { estop: false, startStop: false },
    sensors: [{ tag: '-PE1', label: '工件到位', type: 'proximity' }]
  });
  const tags = minimal.devices.map((device) => device.tag);
  assert.ok(!tags.includes('-SB1'));
  assert.ok(!tags.includes('-SB2'));
  assert.ok(tags.includes('-PE1'));
  assert.ok(minimal.devices.some((device) => device.tag === '-X1'));
});

test('工程名/图号会转义，不会被注入到 SVG 里', () => {
  const risky = buildElectricalSheet({ ...MODEL, project: '<script>alert(1)</script>', drawingNo: 'EL-"1"' });
  assert.ok(!risky.svg.includes('<script>'));
  assert.ok(risky.svg.includes('&lt;script&gt;'));
});
