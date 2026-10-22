import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { PackRegistry } from '../packs/registry';
import { CAD_EXTENSIONS, isCadExtension } from '../shared/cad.ts';

export interface Bridge {
  call<T>(method: string, args?: unknown): Promise<T>;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: CommandError;
}

export interface CommandHistoryEntry {
  name: string;
  at: string;
  ok: boolean;
}

export interface CommandContext {
  registry: PackRegistry;
  bridge: Bridge;
}

interface CommandRunResult extends CommandResult {
  undoToken?: unknown;
}

export interface Command {
  name: string;
  run(args: Record<string, unknown>, ctx: CommandContext): Promise<CommandRunResult>;
  undo?(token: unknown, ctx: CommandContext): Promise<void>;
}

interface UndoRecord {
  command: Command;
  token: unknown;
}

interface BridgeFailure {
  ok: false;
  message?: string;
}

interface InsertBridgeResult {
  ok: boolean;
  meshIndex?: number;
  name?: string;
  message?: string;
}

interface ImportBridgeResult {
  ok: boolean;
  meshCount?: number;
  triangleCount?: number;
  message?: string;
}

interface InterferenceBridgeItem {
  a: string;
  b: string;
  volume: number;
  severity: string;
}

interface InterferenceBridgeResult {
  hits: number;
  items: InterferenceBridgeItem[];
}

export interface BridgeWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed?(): boolean;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  };
}

const BRIDGE_METHODS = new Set([
  'ready',
  'getScene',
  'getSelection',
  'getBom',
  'insertComponent',
  'removeComponent',
  'runInterference',
  'importPath'
]);

export const SIMPLE_BOM_NOTE = '简化 BOM：由当前 CAD 零件与已插入占位件生成；型号取零件名称，材料统一记为“—”。';

export class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandFailure';
    this.code = code;
  }
}

function failed(code: string, message: string): CommandResult {
  return { ok: false, error: { code, message } };
}

function errorResult(error: unknown, fallbackCode = 'COMMAND_FAILED'): CommandResult {
  if (error instanceof CommandFailure) return failed(error.code, error.message);
  return failed(fallbackCode, error instanceof Error ? error.message : String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBridgeFailure(value: unknown): value is BridgeFailure {
  return isRecord(value) && value.ok === false;
}

function bridgeFailureMessage(value: unknown, fallback: string): string {
  return isBridgeFailure(value) && typeof value.message === 'string' && value.message.trim()
    ? value.message
    : fallback;
}

function requiredString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandFailure('INVALID_ARGUMENT', `${label}不能为空`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class CommandBus {
  private readonly context: CommandContext;
  private readonly commands = new Map<string, Command>();
  private readonly records: CommandHistoryEntry[] = [];
  private readonly undoStack: UndoRecord[] = [];

  constructor(context: CommandContext) {
    this.context = context;
  }

  register(command: Command): void {
    if (this.commands.has(command.name)) {
      throw new Error(`重复注册命令：${command.name}`);
    }
    this.commands.set(command.name, command);
  }

  async execute(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const command = this.commands.get(name);
    if (!command) {
      return failed('UNKNOWN_COMMAND', `未知命令：${name}`);
    }

    let result: CommandRunResult;
    try {
      result = await command.run(args, this.context);
    } catch (error) {
      this.record(name, false);
      return errorResult(error);
    }

    const ok = result.ok === true;
    this.record(name, ok);
    if (!ok) {
      return {
        ok: false,
        error: result.error ?? { code: 'COMMAND_FAILED', message: '命令执行失败' }
      };
    }

    if (command.undo && result.undoToken !== undefined) {
      this.undoStack.push({ command, token: result.undoToken });
    }
    return {
      ok: true,
      ...(result.data !== undefined ? { data: result.data } : {})
    };
  }

  async undoLast(): Promise<CommandResult> {
    const record = this.undoStack.pop();
    if (!record) {
      return failed('NOTHING_TO_UNDO', '没有可撤销的命令');
    }
    if (!record.command.undo) {
      return failed('UNDO_UNAVAILABLE', `命令不可撤销：${record.command.name}`);
    }
    try {
      await record.command.undo(record.token, this.context);
      return { ok: true, data: { command: record.command.name } };
    } catch (error) {
      this.undoStack.push(record);
      return errorResult(error, 'UNDO_FAILED');
    }
  }

  history(): CommandHistoryEntry[] {
    return this.records.map((record) => ({ ...record }));
  }

  private record(name: string, ok: boolean): void {
    this.records.push({ name, at: new Date().toISOString(), ok });
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
  }
}

export class RendererBridge implements Bridge {
  private readonly getWindow: () => BridgeWindow | null;
  private readonly timeoutMs: number;

  constructor(getWindow: () => BridgeWindow | null, timeoutMs = 10_000) {
    this.getWindow = getWindow;
    this.timeoutMs = timeoutMs;
  }

  async call<T>(method: string, args?: unknown): Promise<T> {
    if (!BRIDGE_METHODS.has(method)) {
      throw new CommandFailure('INVALID_METHOD', `不支持的渲染桥方法：${method}`);
    }
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) {
      throw new CommandFailure('RENDERER_UNAVAILABLE', '渲染层窗口不存在或已销毁');
    }

    const serializedArgs = args === undefined
      ? ''
      : Array.isArray(args)
        ? args.map((value) => JSON.stringify(value)).join(', ')
        : JSON.stringify(args);
    const script = `(async () => {
      const bridge = window.__AgentBridge;
      if (!bridge || typeof bridge.${method} !== 'function') {
        return { ok: false, message: '渲染层尚未就绪' };
      }
      return await bridge.${method}(${serializedArgs});
    })()`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CommandFailure(
            'RENDERER_TIMEOUT',
            `渲染层调用超时（${Math.round(this.timeoutMs / 1000)} 秒）：${method}`
          ));
        }, this.timeoutMs);
      });
      return await Promise.race([
        window.webContents.executeJavaScript(script) as Promise<T>,
        timeout
      ]);
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      throw new CommandFailure(
        'RENDERER_ERROR',
        `渲染层调用失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function registerInsertCommand(bus: CommandBus): void {
  bus.register({
    name: 'insert_component',
    async run(args, ctx) {
      const partId = requiredString(args, 'partId', 'partId');
      const part = ctx.registry.listParts().find((candidate) => candidate.id === partId);
      if (!part) {
        throw new CommandFailure('PART_NOT_FOUND', `元器件不存在：${partId}`);
      }
      const requestedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      const name = requestedName ?? part.model;
      const payload = {
        id: part.id,
        model: name,
        category: part.category,
        ...(part.vendor ? { vendor: part.vendor } : {})
      };
      const result = await ctx.bridge.call<InsertBridgeResult>('insertComponent', [payload]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(result, `插入元器件失败：${name}`));
      }
      if (!Number.isInteger(result.meshIndex) || (result.meshIndex ?? -1) < 0) {
        throw new CommandFailure('RENDERER_ERROR', '渲染层未返回有效的 meshIndex');
      }
      const meshIndex = result.meshIndex as number;
      return {
        ok: true,
        data: { partId, meshIndex, name: result.name ?? name },
        undoToken: meshIndex
      };
    },
    async undo(token, ctx) {
      const meshIndex = typeof token === 'number' ? token : Number(token);
      if (!Number.isInteger(meshIndex)) throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      const result = await ctx.bridge.call<{ ok: boolean; message?: string }>('removeComponent', [meshIndex]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('UNDO_FAILED', bridgeFailureMessage(result, '撤销插入失败'));
      }
    }
  });
}

function registerImportCommand(bus: CommandBus): void {
  bus.register({
    name: 'import_cad',
    async run(args, ctx) {
      const path = requiredString(args, 'path', 'CAD 文件路径');
      const extension = extname(path).toLowerCase();
      if (!isCadExtension(extension)) {
        throw new CommandFailure(
          'UNSUPPORTED_FORMAT',
          `不支持的 CAD 格式：${extension || '(无扩展名)'}；允许 ${CAD_EXTENSIONS.join(' / ')}`
        );
      }
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new CommandFailure('FILE_NOT_FOUND', `CAD 文件不存在：${path}`);
      }
      const result = await ctx.bridge.call<ImportBridgeResult>('importPath', [path]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('IMPORT_FAILED', bridgeFailureMessage(result, `导入 CAD 失败：${path}`));
      }
      return {
        ok: true,
        data: {
          path,
          meshCount: Number(result.meshCount ?? 0),
          triangleCount: Number(result.triangleCount ?? 0)
        }
      };
    }
  });
}

function registerReadCommands(bus: CommandBus): void {
  bus.register({
    name: 'list_components',
    async run(args, ctx) {
      const filter: { q?: string; category?: string; packId?: string } = {};
      const q = optionalString(args, 'q');
      const category = optionalString(args, 'category');
      const packId = optionalString(args, 'packId');
      if (q) filter.q = q;
      if (category) filter.category = category;
      if (packId) filter.packId = packId;
      const components = ctx.registry.listParts(filter);
      return { ok: true, data: { count: components.length, components } };
    }
  });

  bus.register({
    name: 'search_components',
    async run(args, ctx) {
      const q = requiredString(args, 'q', 'q');
      const filter: { q: string; category?: string; packId?: string } = { q };
      const category = optionalString(args, 'category');
      const packId = optionalString(args, 'packId');
      if (category) filter.category = category;
      if (packId) filter.packId = packId;
      const components = ctx.registry.listParts(filter);
      return { ok: true, data: { query: q, count: components.length, components } };
    }
  });

  bus.register({
    name: 'get_bom',
    async run(_args, ctx) {
      const rows = await ctx.bridge.call<unknown>('getBom');
      if (!Array.isArray(rows)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(rows, '读取 BOM 失败'));
      }
      return { ok: true, data: { rows, note: SIMPLE_BOM_NOTE } };
    }
  });

  bus.register({
    name: 'run_interference',
    async run(_args, ctx) {
      const result = await ctx.bridge.call<InterferenceBridgeResult>('runInterference');
      if (!result || isBridgeFailure(result) || !Array.isArray(result.items)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(result, '干涉检查失败'));
      }
      return {
        ok: true,
        data: {
          hits: Number(result.hits ?? result.items.length),
          items: result.items
        }
      };
    }
  });
}

export function createAgentCommandBus(registry: PackRegistry, bridge: Bridge): CommandBus {
  const bus = new CommandBus({ registry, bridge });
  registerInsertCommand(bus);
  registerImportCommand(bus);
  registerReadCommands(bus);
  return bus;
}
