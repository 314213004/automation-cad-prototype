/**
 * 电气出图测试矩阵：每一项是“工程/机型方案 → ElecDesign”的工厂函数。
 * 测试（drawing-matrix.test.mjs）与离线看图脚本共用同一份数据。
 */
import { readFileSync } from 'node:fs';
import { elecDesignFromMachine, elecDesignFromProject } from '../../src/elec/adapters.ts';
import { buildConveyorParts } from '../../src/machine/conveyor-assembly.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const DATE = '2026-10-25';

function conveyorProject(name, params) {
  const parts = buildConveyorParts(params);
  return elecDesignFromProject({
    id: `proj-${params.lengthMm}x${params.widthMm}`,
    name,
    process: 'conveyor',
    parts: parts.length,
    massKg: 38.5,
    partsList: parts.map((part, i) => ({ file: `part-${i}.stl`, name: part.name })),
    params
  }, { date: DATE });
}

const conveyorParams = (lengthMm, widthMm, pulleyDiameterMm) => ({ lengthMm, widthMm, beltHeightMm: 850, pulleyDiameterMm, beltThicknessMm: 4, frameSectionMm: 40 });

function fromBrief(brief) {
  return elecDesignFromMachine(synthMachine(parseMachineBrief(brief)), { date: DATE });
}

function machineCase() {
  const doc = JSON.parse(readFileSync(new URL('../../../docs/desktop/eval/machine-case.json', import.meta.url), 'utf8'));
  return elecDesignFromMachine({ ...doc.design, bomDraft: doc.bom ?? doc.design.bomDraft }, { ioRows: doc.ioMap.rows, date: DATE });
}

const base = () => ({
  project: '极端用例',
  drawingNo: 'EL-T-0001',
  source: '测试矩阵手工构造',
  supply: {},
  plc: { model: 'CPU 1214C DC/DC/DC' },
  psu: { model: 'LRS-350-24', watts: 350 },
  motors: [],
  inputs: [],
  outputs: [],
  safety: { estops: 1, curtains: [], relay: false },
  startStop: 'plc',
  notes: [],
  date: DATE
});

export const MATRIX = {
  // 输送机工程 3 档尺寸
  'conveyor-s': () => conveyorProject('皮带输送线 800×150', conveyorParams(800, 150, 40)),
  'conveyor-m': () => conveyorProject('皮带输送线 2400×400', conveyorParams(2400, 400, 50)),
  'conveyor-l': () => conveyorProject('皮带输送线 8000×1000', conveyorParams(8000, 1000, 100)),
  // 规则引擎 5 类工艺
  'screw-6st': () => machineCase(),
  'dispense-4st': () => fromBrief('四工位点胶机 每工位1个气缸 2个接近开关'),
  'assembly-3st': () => fromBrief('装配线 3工位 压力检测 安全光栅'),
  'inspection-2st': () => fromBrief('视觉检测机 2工位'),
  'packaging-4st': () => fromBrief('包装机 装箱 4 工位 伺服'),
  'conveyor-rule': () => fromBrief('皮带输送机 长2000 宽300'),
  // 极端
  'x-no-sensor': () => ({ ...base(), project: '无传感器', motors: [{ id: 'm1', name: '减速电机', starter: 'dol', powerKw: 0.18 }], startStop: 'hardwired' }),
  'x-io30': () => ({
    ...base(),
    project: '30 点 IO',
    motors: [{ id: 'm1', name: '输送电机', starter: 'dol', powerKw: 0.75 }],
    inputs: Array.from({ length: 18 }, (_, i) => ({ id: `i${i}`, device: ['photoelectric', 'proximity-2w', 'button-no', 'pressure', 'proximity', 'button-nc'][i % 6], purpose: `检测点${i + 1}` })),
    outputs: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, device: ['valve', 'lamp', 'buzzer', 'relay', 'valve'][i % 5], purpose: `输出${i + 1}` }))
  }),
  'x-4motors': () => ({
    ...base(),
    project: '四电机（直启×2/变频/伺服）',
    motors: [
      { id: 'a', name: '输送电机', purpose: '上料输送', starter: 'dol', powerKw: 0.37 },
      { id: 'b', name: '输送电机', purpose: '下料输送', starter: 'dol', powerKw: 0.55 },
      { id: 'c', name: '变频电机', purpose: '主轴', starter: 'vfd', powerKw: 2.2 },
      { id: 'd', name: '伺服电机', purpose: '分度', starter: 'servo', powerKw: 0.75 }
    ],
    inputs: [{ id: 'p', device: 'photoelectric', purpose: '来料' }],
    startStop: 'hardwired'
  }),
  'x-7motors-2pages': () => ({
    ...base(),
    project: '九路主回路分页',
    motors: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, name: '电机', purpose: `驱动${i + 1}`, starter: ['dol', 'vfd', 'servo'][i % 3], powerKw: [0.37, 1.5, 0.4][i % 3] }))
  }),
  'x-no-startstop': () => ({
    ...base(),
    project: '无启停按钮',
    motors: [{ id: 'v', name: '变频电机', starter: 'vfd', powerKw: 0.75 }],
    inputs: [{ id: 'a', device: 'proximity', purpose: '到位' }],
    outputs: [{ id: 'y', device: 'valve', purpose: '推料' }],
    startStop: 'none'
  }),
  'x-curtain': () => ({
    ...base(),
    project: '带安全光栅',
    motors: [{ id: 's', name: '伺服电机', starter: 'servo', powerKw: 0.4 }],
    inputs: [{ id: 'st', device: 'safety-status', purpose: '光栅状态', safetyOf: 'c1' }, { id: 'a', device: 'photoelectric', purpose: '工件检测', output: 'npn' }],
    outputs: [{ id: 'y', device: 'valve', purpose: '夹紧' }],
    safety: { estops: 3, curtains: [{ id: 'c1', name: '安全光栅', purpose: '上料口' }], relay: true }
  })
};
