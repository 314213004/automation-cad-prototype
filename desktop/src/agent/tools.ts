import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types';
import type { CommandResult } from './commands';

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

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
      name: 'undo_last',
      description: '撤销最近一次可撤销的写操作（当前支持占位件插入）。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        if (!this.commands) return this.unavailable();
        return commandSuccess(await this.commands.undoLast());
      }
    });
  }
}
