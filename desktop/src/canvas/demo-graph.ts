// 画布工作台初始拓扑（P2 演示数据，结构真实、价格留空）
//
// 这不是「AI 生成方案」：只用于打开工作台时有一张可操作的图。所有 partId 都是
// 元件库里的品类 id，具体型号/价格由 packs + 价格簿在 P3 接入；这里**没有单价**，
// 因此 BOM 全部落「待询价」，与真实缺价时的表现一致。
//
// 端口刻意保留一处真实不匹配：Y 轴滑块面 M5×4-60×60 对接 Z 轴气缸本体面
// M5×4-48×36 ——「⚡ 生成转接板」就是为这种场景准备的。
import type { CanvasNode, MachineGraph, MountPort } from './types.ts';

const FLOOR: MountPort = { family: 'floor', holeDiaMm: 12, pitchXMm: 700, pitchYMm: 550, count: 4 };
const GRID50: MountPort = { family: 'grid', holeDiaMm: 6.6, pitchXMm: 50, pitchYMm: 50, count: 4 };
const SLIDER60: MountPort = { family: 'slider', holeDiaMm: 5.5, pitchXMm: 60, pitchYMm: 60, count: 4 };
const BODY48: MountPort = { family: 'body', holeDiaMm: 5.5, pitchXMm: 48, pitchYMm: 36, count: 4 };
const PLATE32: MountPort = { family: 'plate', holeDiaMm: 4.5, pitchXMm: 32, pitchYMm: 32, count: 4 };
const TIP: MountPort = { family: 'tip', holeDiaMm: 0, pitchXMm: 0, pitchYMm: 0, count: 0 };
const OPTICAL: MountPort = { family: 'optical', holeDiaMm: 0, pitchXMm: 0, pitchYMm: 0, count: 0 };

function node(partial: Partial<CanvasNode> & Pick<CanvasNode, 'id' | 'kind' | 'name'>): CanvasNode {
  return {
    spec: '',
    portIn: GRID50,
    portOut: GRID50,
    strokeMm: 0,
    leadMm: 0,
    massKg: 1,
    stepSec: 0,
    dimsMm: [100, 100, 100],
    io: { di: 0, do: 0, desc: '' },
    pos: { x: 0, y: 0 },
    ortho: { x: 0, y: 0 },
    ...partial
  } as CanvasNode;
}

/** 三轴龙门视觉贴合机（6 节点 / 5 边，其中 1 条端口不匹配）。 */
export function demoCanvasGraph(): MachineGraph {
  const nodes: CanvasNode[] = [
    node({
      id: 'FRAME',
      kind: 'frame',
      partId: 'frame-4040-800x650',
      name: '机架 4040 + 16mm 底板',
      spec: '800×650×750mm · 6061-T6 铣平底板',
      portIn: FLOOR,
      portOut: GRID50,
      massKg: 48,
      dimsMm: [800, 650, 750],
      io: { di: 2, do: 1, desc: '急停回路 + 安全门联锁' },
      pos: { x: 60, y: 220 },
      ortho: { x: 0, y: 0 }
    }),
    node({
      id: 'AXIS-X',
      kind: 'linear',
      partId: 'linear-kk86-450',
      name: 'X 轴丝杠模组 KK86',
      spec: '行程 450mm · 导程 10mm · 400W 伺服',
      portIn: GRID50,
      portOut: SLIDER60,
      strokeMm: 450,
      leadMm: 10,
      massKg: 9.2,
      stepSec: 0.55,
      dimsMm: [620, 86, 74],
      io: { di: 3, do: 2, desc: '正负限位 + 原点 + 脉冲/方向' },
      pos: { x: 320, y: 120 },
      ortho: { x: 60, y: 120 }
    }),
    node({
      id: 'AXIS-Y',
      kind: 'linear',
      partId: 'linear-kk60-300',
      name: 'Y 轴丝杠滑台 KK60',
      spec: '行程 300mm · 导程 10mm · 200W 伺服',
      portIn: SLIDER60,
      portOut: SLIDER60,
      strokeMm: 300,
      leadMm: 10,
      massKg: 5.4,
      stepSec: 0.45,
      dimsMm: [440, 60, 55],
      io: { di: 3, do: 2, desc: '正负限位 + 原点 + 总线轴' },
      pos: { x: 600, y: 120 },
      ortho: { x: 420, y: 120 }
    }),
    node({
      id: 'AXIS-Z',
      kind: 'actuator',
      partId: 'mgpm25-100',
      name: 'Z 轴导杆气缸 MGPM25-100',
      spec: '缸径 25mm · 行程 100mm · 耐偏载铜套',
      portIn: BODY48,
      portOut: PLATE32,
      strokeMm: 100,
      massKg: 1.85,
      stepSec: 0.35,
      dimsMm: [80, 62, 195],
      io: { di: 2, do: 2, desc: '上下磁性开关 + 双电控阀' },
      pos: { x: 880, y: 120 },
      ortho: { x: 760, y: 150 }
    }),
    node({
      id: 'GRIP',
      kind: 'gripper',
      partId: 'gripper-rotary-vac',
      name: '旋转电爪 / 真空吸盘组',
      spec: '重复精度 ±0.02mm · 带真空压力表',
      portIn: PLATE32,
      portOut: TIP,
      strokeMm: 20,
      leadMm: 5,
      massKg: 0.95,
      stepSec: 0.25,
      dimsMm: [70, 70, 95],
      io: { di: 2, do: 2, desc: '真空达标 + 吸气/破真空' },
      pos: { x: 1160, y: 120 },
      ortho: { x: 860, y: 170 }
    }),
    node({
      id: 'CAM',
      kind: 'vision',
      partId: 'vision-5mp-telecentric',
      name: '500 万像素飞拍相机',
      spec: '全局快门 · 远心镜头 · 同轴光源',
      portIn: GRID50,
      portOut: OPTICAL,
      massKg: 1.4,
      stepSec: 0.25,
      dimsMm: [90, 90, 210],
      io: { di: 1, do: 2, desc: '硬件飞拍触发 + 光源频闪' },
      pos: { x: 320, y: 360 },
      ortho: { x: 560, y: 480 }
    })
  ];

  return {
    schemeId: 'demo-gantry-3axis',
    title: '三轴龙门视觉贴合机（演示）',
    layout: 'linear',
    transferSeconds: 0.2,
    nodes,
    edges: [
      { id: 'e-frame-x', from: 'FRAME', to: 'AXIS-X' },
      { id: 'e-x-y', from: 'AXIS-X', to: 'AXIS-Y' },
      { id: 'e-y-z', from: 'AXIS-Y', to: 'AXIS-Z' },
      { id: 'e-z-grip', from: 'AXIS-Z', to: 'GRIP' },
      { id: 'e-frame-cam', from: 'FRAME', to: 'CAM' }
    ]
  };
}

// ---------------------------------------------------------------------------
// 模组库（通用模组模板，不是具体型号；partId 留空 → 必然待询价）
// ---------------------------------------------------------------------------

export interface PaletteItem {
  id: string;
  label: string;
  kind: CanvasNode['kind'];
  spec: string;
  portIn: MountPort;
  portOut: MountPort;
  strokeMm: number;
  leadMm: number;
  massKg: number;
  stepSec: number;
  dimsMm: [number, number, number];
  io: { di: number; do: number; desc: string };
}

export const CANVAS_PALETTE: PaletteItem[] = [
  {
    id: 'palette-frame',
    label: '铝型材机架',
    kind: 'frame',
    spec: '通用 4040 机架模板（型号待选）',
    portIn: FLOOR,
    portOut: GRID50,
    strokeMm: 0,
    leadMm: 0,
    massKg: 45,
    stepSec: 0,
    dimsMm: [800, 650, 750],
    io: { di: 2, do: 1, desc: '安全回路' }
  },
  {
    id: 'palette-linear',
    label: '单轴丝杠模组',
    kind: 'linear',
    spec: '通用丝杠模组模板（行程/导程可改，型号待选）',
    portIn: GRID50,
    portOut: SLIDER60,
    strokeMm: 300,
    leadMm: 10,
    massKg: 6.5,
    stepSec: 0.45,
    dimsMm: [480, 80, 70],
    io: { di: 3, do: 2, desc: '限位 + 原点 + 伺服使能' }
  },
  {
    id: 'palette-cylinder',
    label: '导杆气缸',
    kind: 'actuator',
    spec: '通用导杆气缸模板（缸径/行程可改，型号待选）',
    portIn: BODY48,
    portOut: PLATE32,
    strokeMm: 100,
    leadMm: 0,
    massKg: 1.8,
    stepSec: 0.35,
    dimsMm: [80, 62, 195],
    io: { di: 2, do: 2, desc: '磁性开关 + 电磁阀' }
  },
  {
    id: 'palette-gripper',
    label: '气动/真空末端',
    kind: 'gripper',
    spec: '通用末端执行器模板（型号待选）',
    portIn: PLATE32,
    portOut: TIP,
    strokeMm: 20,
    leadMm: 5,
    massKg: 0.9,
    stepSec: 0.25,
    dimsMm: [70, 70, 95],
    io: { di: 2, do: 2, desc: '夹紧/真空反馈' }
  },
  {
    id: 'palette-vision',
    label: '工业相机',
    kind: 'vision',
    spec: '通用飞拍相机模板（像素/视野待选）',
    portIn: GRID50,
    portOut: OPTICAL,
    strokeMm: 0,
    leadMm: 0,
    massKg: 1.4,
    stepSec: 0.25,
    dimsMm: [90, 90, 210],
    io: { di: 1, do: 2, desc: '触发 + 光源' }
  }
];

/** 把一个模组模板变成新节点（id 由调用方保证唯一）。 */
export function paletteNode(item: PaletteItem, id: string, pos: { x: number; y: number }, ortho: { x: number; y: number }): CanvasNode {
  return {
    id,
    kind: item.kind,
    name: item.label,
    spec: item.spec,
    portIn: { ...item.portIn },
    portOut: { ...item.portOut },
    strokeMm: item.strokeMm,
    leadMm: item.leadMm,
    massKg: item.massKg,
    stepSec: item.stepSec,
    dimsMm: [item.dimsMm[0], item.dimsMm[1], item.dimsMm[2]],
    io: { ...item.io },
    pos: { ...pos },
    ortho: { ...ortho }
  };
}
