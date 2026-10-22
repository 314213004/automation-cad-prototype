import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types';

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

export interface NotImplementedResult {
  ok: false;
  code: 'NOT_IMPLEMENTED';
  message: string;
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

function notImplemented(message: string): NotImplementedResult {
  return { ok: false, code: 'NOT_IMPLEMENTED', message };
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class AgentTools {
  private readonly registry: PackRegistry;
  private readonly tools = new Map<string, AgentTool>();

  constructor(registry: PackRegistry) {
    this.registry = registry;
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
      handler: async () => notImplemented('Agent 触发的 CAD 导入尚未接入渲染层事务通道。')
    });

    this.add({
      name: 'get_bom',
      description: '读取当前装配体的 BOM。',
      inputSchema: {
        type: 'object',
        properties: { assemblyId: { type: 'string' } },
        additionalProperties: true
      },
      handler: async () => notImplemented('当前原型尚未建立可事务读取的装配 BOM 数据源。')
    });

    this.add({
      name: 'run_interference_check',
      description: '对当前装配体执行包围盒级干涉初筛。',
      inputSchema: {
        type: 'object',
        properties: { assemblyId: { type: 'string' } },
        additionalProperties: true
      },
      handler: async () => notImplemented('干涉检查需要装配事务和真实零件姿态，当前版本仅提供查看器。')
    });

    this.add({
      name: 'insert_component',
      description: '把标准件插入当前装配体。',
      inputSchema: {
        type: 'object',
        properties: {
          partId: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' }
        },
        required: ['partId'],
        additionalProperties: false
      },
      handler: async () => notImplemented('插入操作必须与 UI 共用事务/撤销栈，当前版本尚未接入。')
    });
  }
}
