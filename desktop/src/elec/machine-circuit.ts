/**
 * 由机型描述生成电路（机型无关）。
 *
 * 任何"一台电机 + 一组传感 + 起停"的机器都走同一条路径：
 * 主回路三相链 → 控制回路起保停 → PLC 输入输出。
 * 换机器只换 spec，不改这里的分支逻辑；结构对不对由 ERC 判，不由这里保证。
 */

import type { Circuit, CircuitDevice, CircuitNet, DeviceKind } from './circuit.ts';
import { PIN } from './circuit.ts';

export interface MachineElecSpec {
  project: string;
  drive: { powerKw: number; rpm: number; ratio: number };
  sensors: Array<{ tag: string; label: string; address: string }>;
  controls: { estop: boolean; startStop: boolean; lamp: boolean };
  selection: { breaker: string; contactor: string; thermal: string; currentA: number; thermalSetA: number };
  drawingNo?: string;
}

function device(
  tag: string,
  kind: DeviceKind,
  name: string,
  model: string,
  spec: string,
  pins: string[],
  extra: { displayTag?: string; estimated?: boolean } = {}
): CircuitDevice {
  return { tag, kind, name, model, spec, pins, ...extra };
}

export function buildMachineCircuit(spec: MachineElecSpec): Circuit {
  const devices: CircuitDevice[] = [];
  const nets: CircuitNet[] = [];
  const addNet = (id: string, label: string | undefined, pins: string[]): void => {
    nets.push({ id, ...(label ? { label } : {}), pins });
  };

  const { currentA, thermalSetA, breaker, contactor, thermal } = spec.selection;

  /* ---------------- 元件 ---------------- */
  devices.push(device('-QF1', 'breaker', '电机保护断路器', breaker, `${currentA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true }));
  devices.push(device('-KM1', 'contactor', '交流接触器', contactor, `${currentA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true }));
  devices.push(device('-FR1', 'thermal', '热过载继电器', thermal, `整定 ${thermalSetA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true }));
  devices.push(device('-M1', 'motor', '减速电机', '三相异步', `${spec.drive.powerKw} kW · ${spec.drive.rpm} rpm · i=${spec.drive.ratio}`, ['U', 'V', 'W', 'PE']));

  devices.push(device('-FU1', 'fuse', '熔断器', 'RT18-32', '6 A', ['1', '2'], { estimated: true }));
  devices.push(device('-PLC', 'plc', 'PLC', 'CPU 1214C DC/DC/DC', 'DI 8 / DO 6', ['L+', 'M', ...spec.sensors.map((sensor) => sensor.address), 'Q0.0']));
  for (const sensor of spec.sensors) {
    devices.push(device(sensor.tag, 'sensor', '光电传感器', 'E3Z-D61', 'NPN · 24V DC', ['+', '-', 'OUT']));
  }
  devices.push(device('-KM1A', 'no', '接触器辅助触点', contactor, '13/14 NO', ['13', '14'], { displayTag: '-KM1' }));
  devices.push(device('-KM1K', 'coil', '接触器线圈', contactor, '24V DC · A1/A2', ['A1', 'A2'], { displayTag: '-KM1' }));
  devices.push(device('-FR1NC', 'nc', '热继常闭触点', thermal, '95/96', ['95', '96'], { displayTag: '-FR1' }));
  if (spec.controls.estop) devices.push(device('-SB1', 'nc', '急停按钮（常闭）', 'XB2-BS542C', '蘑菇头 · 旋转复位', ['13', '14']));
  if (spec.controls.startStop) {
    devices.push(device('-SB3', 'nc', '停止按钮（常闭）', 'XB2-BA42C', '红色', ['13', '14']));
    devices.push(device('-SB2', 'no', '启动按钮（常开）', 'XB2-BA31C', '绿色', ['13', '14']));
  }
  if (spec.controls.lamp) devices.push(device('-HL1', 'lamp', '运行指示灯', 'XB2-BVM3LC', '24V DC', ['1', '2']));

  /* ---------------- 主回路：每相独立成网 ---------------- */
  const phaseIn = ['1', '3', '5'];
  const phaseOut = ['2', '4', '6'];
  const motorPins = ['U', 'V', 'W'];
  for (let index = 0; index < 3; index += 1) {
    const pinIn = phaseIn[index] ?? '1';
    const pinOut = phaseOut[index] ?? '2';
    const phase = `L${index + 1}`;
    addNet(phase, phase, [PIN('-QF1', pinIn)]);
    addNet(`N-QF-${pinOut}`, undefined, [PIN('-QF1', pinOut), PIN('-KM1', pinIn)]);
    addNet(`N-KM-${pinOut}`, undefined, [PIN('-KM1', pinOut), PIN('-FR1', pinIn)]);
    addNet(`N-FR-${pinOut}`, undefined, [PIN('-FR1', pinOut), PIN('-M1', motorPins[index] ?? 'U')]);
  }
  addNet('PE', 'PE', [PIN('-M1', 'PE')]);

  /* ---------------- 24V 电源 ---------------- */
  addNet('+24V', '+24V', [PIN('-FU1', '1'), PIN('-PLC', 'L+'), ...spec.sensors.map((sensor) => PIN(sensor.tag, '+'))]);
  addNet('0V', '0V', [
    PIN('-PLC', 'M'),
    ...spec.sensors.map((sensor) => PIN(sensor.tag, '-')),
    PIN('-KM1K', 'A2'),
    ...(spec.controls.lamp ? [PIN('-HL1', '2')] : [])
  ]);

  /* ---------------- 起保停串联链 ---------------- */
  const seriesTags: string[] = [];
  if (spec.controls.estop) seriesTags.push('-SB1');
  if (spec.controls.startStop) seriesTags.push('-SB3');
  const firstTag = seriesTags[0] ?? '-SB2';
  addNet('N-CTRL-FUSE', undefined, [PIN('-FU1', '2'), PIN(firstTag, '13')]);
  seriesTags.forEach((tag, index) => {
    const pins: string[] = [PIN(tag, '14')];
    const next = seriesTags[index + 1];
    if (next) pins.push(PIN(next, '13'));
    else pins.push(PIN('-SB2', '13'), PIN('-KM1A', '13'));
    addNet(`N-CTRL-S${index + 1}`, undefined, pins);
  });
  // 并联出口 → 热继 95/96 → 线圈 A1
  addNet('N-CTRL-PAR', undefined, [PIN('-SB2', '14'), PIN('-KM1A', '14'), PIN('-FR1NC', '95')]);
  addNet('N-CTRL-COIL', undefined, [PIN('-FR1NC', '96'), PIN('-KM1K', 'A1')]);

  /* ---------------- PLC 输入输出 ---------------- */
  for (const sensor of spec.sensors) {
    addNet(`N-IN-${sensor.address}`, undefined, [PIN(sensor.tag, 'OUT'), PIN('-PLC', sensor.address)]);
  }
  if (spec.controls.lamp) addNet('N-OUT-Q0.0', undefined, [PIN('-PLC', 'Q0.0'), PIN('-HL1', '1')]);

  return { devices, nets, supply: '3ph-380' };
}
