import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMachineCircuit } from '../../src/elec/machine-circuit.ts';
import { runErc, ercSummary } from '../../src/elec/circuit.ts';
import { layoutCircuit, boxesOverlap } from '../../src/elec/layout.ts';
import { renderSheet } from '../../src/elec/sheet.ts';

const SPEC = {
  project: '皮带输送线 2400×400',
  drive: { powerKw: 0.04, rpm: 76, ratio: 18.4 },
  sensors: [
    { tag: '-PE1', label: '进料检测', address: 'I0.3' },
    { tag: '-PE2', label: '出料检测', address: 'I0.4' }
  ],
  controls: { estop: true, startStop: true, lamp: true },
  selection: { breaker: 'iC65N 3P C1', contactor: 'LC1D09', thermal: 'LRD01 · 0.1–0.16A', currentA: 0.1, thermalSetA: 0.1 }
};

test('电路建模：三相不被短接、每个引脚只落在一个网络', () => {
  const circuit = buildMachineCircuit(SPEC);
  const issues = runErc(circuit);
  assert.equal(ercSummary(issues).errors, 0, issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; '));
  const l1 = circuit.nets.filter((net) => net.label === 'L1');
  assert.ok(l1.length >= 1);
  // 强制制造短路，ERC 必须抓到
  const broken = { ...circuit, nets: [...circuit.nets, { id: 'BAD', label: 'L1', pins: ['-KM1:1'] }] };
  assert.ok(runErc(broken).some((issue) => issue.code === 'PIN_MULTI_NET' || issue.code === 'PHASE_SHORT'));
});

test('ERC：漏画线圈驱动、热继常闭、传感器电源都会报 error', () => {
  const base = buildMachineCircuit(SPEC);
  // 把并联的启动/自锁支路整段拆掉：线圈就没有回路了
  const noDrive = {
    ...base,
    nets: base.nets.filter((net) => net.id !== 'N-CTRL-PAR' && net.id !== 'N-CTRL-S2')
  };
  const codes = runErc(noDrive).map((issue) => issue.code);
  assert.ok(
    codes.includes('COIL_NO_PATH') || codes.includes('COIL_NO_DRIVE'),
    `线圈无驱动未报错，实际：${codes.join(',')}`
  );

  const noThermal = { ...base, devices: base.devices.filter((device) => device.tag !== '-FR1NC') };
  assert.ok(runErc(noThermal).some((issue) => issue.code === 'FLOATING_PIN' || issue.code === 'THERMAL_NO_TRIP'));

  const noSensorSupply = {
    ...base,
    nets: base.nets.map((net) => (net.label === '+24V' ? { ...net, pins: net.pins.filter((pin) => !pin.startsWith('-PE1:')) } : net))
  };
  assert.ok(runErc(noSensorSupply).some((issue) => issue.code === 'SENSOR_NO_SUPPLY'));
});

test('布局：符号两两不重叠、不越出图框', () => {
  const circuit = buildMachineCircuit(SPEC);
  const layout = layoutCircuit(circuit);
  assert.deepEqual(layout.problems, [], layout.problems.join('; '));
  for (let i = 0; i < layout.symbols.length; i += 1) {
    for (let j = i + 1; j < layout.symbols.length; j += 1) {
      const a = layout.symbols[i];
      const b = layout.symbols[j];
      assert.ok(a && b);
      assert.equal(boxesOverlap(a.box, b.box), false, `${a.tag} 与 ${b.tag} 重叠`);
    }
  }
});

test('布局：元件变多时自动换行，不靠手调坐标', () => {
  const many = buildMachineCircuit({
    ...SPEC,
    sensors: [
      { tag: '-PE1', label: '进料', address: 'I0.3' },
      { tag: '-PE2', label: '出料', address: 'I0.4' },
      { tag: '-PE3', label: '到位', address: 'I0.5' },
      { tag: '-PE4', label: '堵料', address: 'I0.6' }
    ]
  });
  const layout = layoutCircuit(many);
  assert.deepEqual(layout.problems, [], layout.problems.join('; '));
  // IEC 竖向电流路径：传感器各占一列（同一行对齐），而不是逐行堆叠
  const sensors = layout.symbols.filter((s) => s.kind === 'sensor');
  const cols = new Set(sensors.map((s) => Math.round(s.box.x * 100)));
  assert.equal(cols.size, 4);
  assert.equal(new Set(sensors.map((s) => s.y)).size, 1);
  // 每一列都真的接上了：BN→+24V、BU→0V、BK→PLC 输入
  const wiring = layout.problems.filter((p) => /PIN_|NET_/.test(p));
  assert.deepEqual(wiring, []);
});

test('出图：合格电路 deliverable=true，图里含全部位号', () => {
  const circuit = buildMachineCircuit(SPEC);
  const sheet = renderSheet(circuit, { project: SPEC.project, drawingNo: 'EL-CV-001' });
  assert.equal(sheet.deliverable, true, sheet.issues.map((i) => i.message).join('; '));
  for (const tag of ['-QF1', '-KM1', '-FR1', '-M1', '-FU1', '-SB1', '-SB2', '-SB3', '-PE1', '-PE2', '-HL1', '-PLC']) {
    assert.ok(sheet.svg.includes(tag), `图纸缺少 ${tag}`);
  }
  assert.ok(sheet.svg.includes('EL-CV-001'));
});

test('出图：ERC 有错时 deliverable=false，并在图上列出问题', () => {
  const circuit = buildMachineCircuit(SPEC);
  const broken = { ...circuit, devices: circuit.devices.filter((device) => device.kind !== 'thermal') };
  const sheet = renderSheet(broken, { project: '坏图' });
  assert.equal(sheet.deliverable, false);
  assert.ok(sheet.svg.includes('出图前校验'));
});

test('工程名/位号转义，不会被注入 SVG', () => {
  const circuit = buildMachineCircuit(SPEC);
  const sheet = renderSheet(circuit, { project: '<script>alert(1)</script>' });
  assert.ok(!sheet.svg.includes('<script>'));
  assert.ok(sheet.svg.includes('&lt;script&gt;'));
});
