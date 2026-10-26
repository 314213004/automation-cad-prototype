// 无限画布工作台 · P1 核心数据契约（纯类型，无 DOM / 无 Electron / 无三方依赖）
//
// 口径来源：docs/desktop/CANVAS-WORKBENCH.md 第 4 节「数据契约」。
// 与原型 docs/desktop/mockups/canvas-workbench.html 的差异（规格书第 3 节硬约束）：
//   1. 端口是结构化对象（family/holeDiaMm/pitchXMm/pitchYMm/count），不是字符串；
//      「SLIDER-M5x4-60x60」这类字符串只允许出现在元件库导入适配层，不进入本模块。
//   2. 节点不存 cost。BOM 金额一律由调用方注入的 priceLookup(partId) 现查，
//      查不到 → null → 进「待询价」，禁止写死单价。
//   3. stepSec 只服务甘特图与单轴伺服选型；整机 CT/UPH 必须由 metrics.ts 走
//      machine/flow.ts 的 evaluateFlow（ΣstepSec 是纯串行口径，会算错并行/单元式机器）。
//   4. 转接板节点带两端端口参数（adapterParams），作为 build123d 生成请求的入参，
//      而不是只留一句 "配打 XX 转 YY" 的文本。
//
// 单位口径：本模块所有长度字段单位 **mm**（字段名带 Mm 后缀），质量 kg，时间 s，
// 力矩 N·m。internal SI 换算只发生在 metrics.ts 的公式内部，并就地注明。

/** 端口族：决定两件之间「怎么装」，同族也可能因孔距/孔径不同而不兼容。 */
export type MountFamily =
  | 'grid' // 型材网格面（M6 沉头孔阵列）
  | 'slider' // 直线模组滑块顶面
  | 'body' // 执行器本体安装面
  | 'plate' // 平板/法兰安装面
  | 'dial' // 分割器转盘顶面
  | 'floor' // 地面/机架地脚（M12 化学锚栓）
  | 'optical' // 光学/相机视野接口（不出实体孔，只约束视野与法兰）
  | 'tip'; // 末端工具接口（吸盘/夹爪指尖，不接下一个模组）

/**
 * 结构化安装端口。兼容判定 = **五个字段全部相等**（见 graph.ts portsCompatible）。
 * 只比 family 会把 M5x4-60x60 与 M4x4-40x40 判成兼容，是原型里的假能力。
 */
export interface MountPort {
  family: MountFamily;
  /** 安装孔公称直径 mm（M5 通孔取 5.5 的场合由元件库给实际值，这里只存数）。 */
  holeDiaMm: number;
  /** 孔阵列 X 向孔距 mm；单孔时取 0。 */
  pitchXMm: number;
  /** 孔阵列 Y 向孔距 mm；单孔时取 0。 */
  pitchYMm: number;
  /** 孔数（含定位销孔以外的安装孔）。 */
  count: number;
}

/** 节点类别。adapter = 非标转接板（build123d 参数化件）。 */
export type CanvasNodeKind =
  | 'frame'
  | 'indexer'
  | 'linear'
  | 'actuator'
  | 'gripper'
  | 'vision'
  | 'adapter';

/** 节点 IO 需求：只记点数，不记点位地址（地址属于 PLC 配置，见 export.ts plcSt）。 */
export interface NodeIo {
  di: number;
  do: number;
  desc: string;
}

/**
 * 转接板生成请求参数（仅 adapter 节点持有）。
 * 目标是「可直接喂给 parametric sidecar / build123d」的最小参数集；
 * 内核不可用时降级为「仅参数 / 仅图纸」，不得声称已建模。
 */
export interface AdapterParams {
  /** 上游（母件）端口：转接板靠这一面的孔与 from.portOut 配打。 */
  fromPort: MountPort;
  /** 下游（子件）端口：转接板靠这一面的孔与 to.portIn 配打。 */
  toPort: MountPort;
  /** 外形尺寸 [X, Y, Z] mm（Z 通常等于板厚）。 */
  plateDimsMm: [number, number, number];
  /** 板厚 mm。 */
  thicknessMm: number;
  /** 材料牌号，如 '6061-T6'。 */
  material: string;
  /** 需要配打的沉头孔（母件侧）是否沉头；false = 通孔。 */
  counterBore: boolean;
  /** 定位销孔直径 mm；0 = 不设销孔。 */
  dowelDiaMm: number;
  /** 质量 kg（由入参工厂提供，用于惯量链与 BOM）。 */
  massKg: number;
  /** 询价结果（元）。null = 未询到价，进「待询价」，不计入总额。 */
  costYuan: number | null;
}

/** 画布节点。端口 + 几何 + 节拍 + IO 四组信息，不含任何金额。 */
export interface CanvasNode {
  /** 全局唯一 id（normalizeGraph 负责去重与清理）。 */
  id: string;
  kind: CanvasNodeKind;
  /** 元件库型号 id（packs/builtin 下 parts.json）。缺省 = 待选型，价格必然待询价。 */
  partId?: string;
  name: string;
  spec: string;
  /** 上游对接端口（本件怎么被装上去）。 */
  portIn: MountPort;
  /** 下游对接端口（下一个模组怎么装到本件上）。 */
  portOut: MountPort;
  /** 有效行程 mm（旋转轴用分度圆周行程近似）。 */
  strokeMm: number;
  /** 丝杠/同步带导程 mm；0 = 无回转传动（气缸、纯结构件）。 */
  leadMm: number;
  /** 本件质量 kg。 */
  massKg: number;
  /** 单步耗时 s。只用于甘特与单轴选型，**不用于整机 CT/UPH**。 */
  stepSec: number;
  /** 包围盒尺寸 [X, Y, Z] mm。 */
  dimsMm: [number, number, number];
  io: NodeIo;
  /** true = 非标转接板；等价于 kind === 'adapter'，保留给 UI 快速判定。 */
  adapter?: boolean;
  /** 转接板参数（仅 adapter 节点）。 */
  adapterParams?: AdapterParams;
  /** 所属工位索引（0-based）；缺省时由 metrics.ts 按链序推导。 */
  station?: number;
  /** 拓扑画布坐标（px，纯显示）。 */
  pos: { x: number; y: number };
  /** 2D 正交平面坐标（mm，俯视图）。 */
  ortho: { x: number; y: number };
  /** 自由备注（选型依据、采购备注等）。 */
  notes?: string;
}

/** 有向边：from.portOut 对接 to.portIn。 */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

/** 整机拓扑。schemeId 对应 design/ 里的候选方案 id。 */
export interface MachineGraph {
  schemeId: string;
  /** 方案名，导出时写入注释头。 */
  title?: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * 产能布局口径，直接透传给 machine/flow.ts 的 FlowModel.layout。
   * 缺省 'single'（整机单工位串行），此时 CT 确实等于工序之和——但由 evaluateFlow 算出来，
   * 不是本模块自己 Σ。
   */
  layout?: FlowLayout;
  /** 目标产能（件/分钟），透传 FlowModel.targetPerMin。 */
  targetPerMin?: number;
  /** 工位间转移时间 s（linear/cell 有效），透传 FlowModel.transferSeconds。 */
  transferSeconds?: number;
  /** 转盘分度时间 s（dial 有效），透传 FlowModel.indexSeconds。 */
  indexSeconds?: number;
  /** 并行轨道数（cell 有效）。 */
  lanes?: number;
}

/** 与 flow.ts MachineLayout 同名同义的布局集合（此处独立声明，避免类型循环依赖）。 */
export type FlowLayout = 'single' | 'linear' | 'dial' | 'parallel' | 'cell';

/** 端口差异字段名，用于 UI 标红与报错文案。 */
export type PortField = 'family' | 'holeDiaMm' | 'pitchXMm' | 'pitchYMm' | 'count';
