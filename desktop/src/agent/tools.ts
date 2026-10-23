import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types';
import type { CommandResult } from './commands';
import { resolvePartReference } from './placement.ts';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentCommandExecutor {
  execute(name: string, args?: Record<string, unknown>): Promise<CommandResult>;
  undoLast(): Promise<CommandResult>;
}

const COMPONENT_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: '全文搜索词' },
    category: { type: 'string', description: '类别精确筛选' },
    packId: { type: 'string', description: '数据包 id 筛选' }
  },
  additionalProperties: false
};

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

const PLACE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    partId: { type: 'string', description: '数据包中的元器件 id；也接受唯一命中的型号' },
    x: { type: 'number', description: '放置位置左上角 X（mm）' },
    y: { type: 'number', description: '放置位置左上角 Y（mm）' },
    rotate: { type: 'boolean', description: '是否旋转 90°（宽高互换）', default: false },
    railSnap: { type: 'boolean', description: '导轨安装件是否吸附到最近导轨', default: true }
  },
  required: ['partId', 'x', 'y'],
  additionalProperties: false
};

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandFailure(result: CommandResult): Record<string, unknown> {
  return {
    ok: false,
    code: result.error?.code ?? 'COMMAND_FAILED',
    message: result.error?.message ?? '命令执行失败'
  };
}

function commandSuccess(result: CommandResult): Record<string, unknown> {
  if (!result.ok) return commandFailure(result);
  return {
    ok: true,
    ...(isRecord(result.data) ? result.data : result.data === undefined ? {} : { data: result.data })
  };
}

const ELEC_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    wires: {
      type: 'array',
      description: '导线清单：no 线号、net 网络、potential 电位、from/to 端点，可选 sectionMm2/currentA',
      items: {
        type: 'object',
        properties: {
          no: { type: 'string' },
          net: { type: 'string' },
          potential: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          sectionMm2: { type: 'number' },
          currentA: { type: 'number' }
        }
      }
    },
    loads: {
      type: 'array',
      description: '负载清单：tag 编号、powerKw 额定功率、phase 取 3P/L1/L2/L3/DC24，可选 cosPhi/efficiency/quantity',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          powerKw: { type: 'number' },
          phase: { type: 'string', enum: ['3P', 'L1', 'L2', 'L3', 'DC24'] },
          cosPhi: { type: 'number' },
          efficiency: { type: 'number' },
          quantity: { type: 'number' }
        },
        required: ['powerKw']
      }
    },
    circuits: {
      type: 'array',
      description: '回路清单：wireNo 线号、currentA 工作电流，可选 sectionMm2 截面、breakerA 断路器',
      items: {
        type: 'object',
        properties: {
          wireNo: { type: 'string' },
          currentA: { type: 'number' },
          sectionMm2: { type: 'number' },
          breakerA: { type: 'number' }
        },
        required: ['wireNo', 'currentA']
      }
    },
    options: {
      type: 'object',
      description: '可选电气参数：voltage3P/voltage1P/voltageDc/demandFactor/psuRatedA',
      properties: {
        voltage3P: { type: 'number' },
        voltage1P: { type: 'number' },
        voltageDc: { type: 'number' },
        demandFactor: { type: 'number' },
        psuRatedA: { type: 'number' }
      }
    }
  },
  additionalProperties: false
};

const COST_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    bom: {
      type: 'array',
      description: '物料明细；不传则使用当前场景 BOM（场景零件无物料号，会被计入「缺物料号」）',
      items: {
        type: 'object',
        properties: {
          partId: { type: 'string', description: '价格簿物料号，缺省则无法计价' },
          name: { type: 'string' },
          model: { type: 'string' },
          category: { type: 'string' },
          spec: { type: 'string' },
          specs: { type: 'object', description: '结构化规格，可含「接线点数」' },
          qty: { type: 'number', description: '正整数' },
          terminationPoints: { type: 'number' },
          assemblyMinutesPerUnit: { type: 'number' }
        },
        required: ['name', 'qty']
      }
    },
    pricebook: { type: 'object', description: '价格簿 JSON；缺省读取桌面版内置价格簿（示例条目不计价）' },
    placements: {
      type: 'array',
      description: '底板布置（毫米），用于线缆长度估算：id/partId/model/x/y/w/h',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          partId: { type: 'string' },
          model: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' }
        },
        required: ['x', 'y']
      }
    },
    plate: {
      type: 'object',
      description: '底板尺寸（毫米）与导轨，用于导轨/线槽辅材估算',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        rails: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              y: { type: 'number' },
              height: { type: 'number' },
              label: { type: 'string' }
            }
          }
        }
      },
      required: ['width', 'height']
    },
    plc: {
      type: 'object',
      description: 'PLC 配置：ioPoints 点数 + modules 模块清单（partId/qty）',
      properties: {
        ioPoints: { type: 'number' },
        modules: {
          type: 'array',
          items: {
            type: 'object',
            properties: { partId: { type: 'string' }, qty: { type: 'number' } },
            required: ['partId']
          }
        }
      },
      required: ['modules']
    },
    options: {
      type: 'object',
      description: '报价参数：markupRate 加成率、taxRate 税率、freight 运费（元）',
      properties: {
        markupRate: { type: 'number' },
        taxRate: { type: 'number' },
        freight: { type: 'number' }
      }
    },
    overrides: { type: 'object', description: '按物料号手工改价：{ partId: 单价 }' },
    wireSection: { type: 'string', description: '线缆截面档位，如 "2.5"' },
    now: { type: 'string', description: '计算基准时间（ISO 8601），用于核对价格时效' }
  },
  additionalProperties: false
};

const COST_EXPORT_SCHEMA = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['pdf', 'csv'],
      description: '导出格式：pdf 为 A4 纵向报告，csv 为 UTF-8 BOM（Excel 中文不乱码）'
    },
    fileName: {
      type: 'string',
      description: '可选，不含扩展名；非法字符会被移除，扩展名按 format 强制为 .pdf / .csv'
    },
    overwrite: {
      type: 'boolean',
      description: '可选，默认 false；同名文件存在时自动追加 (1)、(2)，为 true 时直接覆盖'
    },
    ...COST_REPORT_SCHEMA.properties
  },
  required: ['format'],
  additionalProperties: false
};

export class AgentTools {
  private readonly registry: PackRegistry;
  private readonly commands: AgentCommandExecutor | undefined;
  private readonly tools = new Map<string, AgentTool>();

  constructor(registry: PackRegistry, commands?: AgentCommandExecutor) {
    this.registry = registry;
    this.commands = commands;
    this.registerDefaults();
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  summaries(): AgentToolSummary[] {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return await tool.handler(args);
  }

  private add(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`重复注册工具：${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  private componentQuery(args: Record<string, unknown>): ComponentPart[] {
    const filter: { q?: string; category?: string; packId?: string } = {};
    const q = getString(args.q);
    const category = getString(args.category);
    const packId = getString(args.packId);
    if (q) filter.q = q;
    if (category) filter.category = category;
    if (packId) filter.packId = packId;
    return this.registry.listParts(filter);
  }

  private unavailable(): Record<string, unknown> {
    return {
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      message: '命令总线未接入渲染层，请在 AutomationCAD 桌面应用内调用'
    };
  }

  private async execute(name: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> {
    if (!this.commands) return null;
    return await this.commands.execute(name, args);
  }

  private registerDefaults(): void {
    this.add({
      name: 'list_components',
      description: '列出已启用数据包中的元器件，可按类别和数据包筛选。',
      inputSchema: COMPONENT_FILTER_SCHEMA,
      handler: async (args) => {
        const components = this.componentQuery(args);
        return { ok: true, count: components.length, components };
      }
    });

    this.add({
      name: 'search_components',
      description: '按型号、品牌、类别和规格搜索元器件。',
      inputSchema: {
        ...COMPONENT_FILTER_SCHEMA,
        required: ['q']
      },
      handler: async (args) => {
        const q = getString(args.q);
        if (!q) return { ok: false, code: 'INVALID_ARGUMENT', message: 'search_components 需要 q 参数' };
        const components = this.componentQuery(args);
        return { ok: true, query: q, count: components.length, components };
      }
    });

    this.add({
      name: 'import_cad',
      description: '把 STEP/IGES/BREP/STL/OBJ/GLTF/GLB 文件导入当前查看会话。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '本机 CAD 文件绝对路径' } },
        required: ['path'],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = await this.execute('import_cad', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_bom',
      description: '读取当前装配体的简化 BOM（当前 CAD 零件 + 已插入占位件）。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('get_bom');
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'run_interference_check',
      description: '对当前装配体执行包围盒级干涉初筛，返回命中数与前 20 条。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('run_interference');
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const items = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
        return {
          ok: true,
          hits: Number(data.hits ?? items.length),
          items
        };
      }
    });

    this.add({
      name: 'insert_component',
      description: '把数据包中的标准件作为占位件插入当前装配体。',
      inputSchema: {
        type: 'object',
        properties: {
          partId: { type: 'string', description: '数据包中的元器件 id' },
          name: { type: 'string', description: '可选的显示名称，缺省使用型号' }
        },
        required: ['partId'],
        additionalProperties: false
      },
      handler: async (args) => {
        const partId = getString(args.partId);
        if (!partId) return { ok: false, code: 'INVALID_ARGUMENT', message: 'insert_component 需要 partId 参数' };
        const part = this.registry.listParts().find((candidate) => candidate.id === partId);
        if (!part) return { ok: false, code: 'PART_NOT_FOUND', message: `元器件不存在：${partId}` };
        const name = getString(args.name);
        const result = await this.execute('insert_component', { partId, ...(name ? { name } : {}) });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'place_component',
      description:
        '把元器件放到电箱底板指定坐标（mm）：可旋转 90°、导轨件可吸附；越界与重叠以 warnings 返回而不是直接拒绝。需要用户确认，可用 undo_last 撤销。',
      inputSchema: PLACE_COMPONENT_SCHEMA,
      handler: async (args) => {
        const partId = getString(args.partId);
        if (!partId) return { ok: false, code: 'INVALID_ARGUMENT', message: 'place_component 需要 partId 参数' };
        const x = getNumber(args.x);
        const y = getNumber(args.y);
        if (x === undefined || y === undefined) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'place_component 需要 x/y 坐标（mm）' };
        }
        const resolution = resolvePartReference(this.registry.listParts(), partId);
        if (!resolution.ok) {
          return {
            ok: false,
            code: resolution.code,
            message: resolution.message,
            ...(resolution.candidates ? { candidates: resolution.candidates } : {})
          };
        }
        const part = resolution.part;
        const dims = part.dims;
        if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
          return {
            ok: false,
            code: 'NO_DIMENSIONS',
            message: `元器件 ${part.model} 缺少外形尺寸（dims.w/dims.h），无法放置到底板`
          };
        }
        const result = await this.execute('place_component', {
          partId: part.id,
          x,
          y,
          rotate: args.rotate === true,
          railSnap: args.railSnap !== false
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'run_electrical_check',
      description: '按线号/负载/回路数据执行电气校验：线号合规、功率统计（kW·kVA、分相电流、主断路器与进线建议、24V 余量）、导线截面与断路器配合，按严重级别返回问题清单。',
      inputSchema: ELEC_CHECK_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('run_electrical_check', args);
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const findings = Array.isArray(data.findings) ? data.findings : [];
        const counts = isRecord(data.counts) ? data.counts : {};
        return {
          ok: true,
          counts: {
            error: Number(counts.error ?? 0),
            warning: Number(counts.warning ?? 0),
            info: Number(counts.info ?? 0)
          },
          summary: isRecord(data.summary) ? data.summary : {},
          findings: findings.slice(0, 50),
          truncated: findings.length > 50
        };
      }
    });

    this.add({
      name: 'run_cost_report',
      description:
        '按 BOM 与价格簿计算机台硬件成本：硬件/辅材/人工小计、加成、税、运费与合计，附分类小计、缺价与告警；只读，不生成文件。未传 bom 时使用当前场景 BOM（场景零件没有物料号，会如实计入缺价而非按 0 处理）。',
      inputSchema: COST_REPORT_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('run_cost_report', args);
        if (!result) return this.unavailable();
        return commandSuccess(result);
      }
    });

    this.add({
      name: 'export_cost_report',
      description:
        '按 BOM 与价格簿生成成本报告并写文件到用户数据目录 exports/（PDF 为 A4 纵向，CSV 带 UTF-8 BOM）。需要用户确认；不会覆盖已有文件，除非 overwrite=true。返回实际落盘路径、字节数、明细行数与合计；未传 bom 时使用当前场景 BOM（可能全部缺物料号）。',
      inputSchema: COST_EXPORT_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('export_cost_report', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'undo_last',
      description: '撤销最近一次可撤销的写操作（当前支持占位件插入与底板放置），返回 removed id。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        if (!this.commands) return this.unavailable();
        return commandSuccess(await this.commands.undoLast());
      }
    });
  }
}
