import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentTools } from './tools';
import { authorizeAgentToolCall, type ConfirmAgentToolWrite } from './policy.ts';
import type { AgentAuditRecord } from './audit.ts';
import {
  isAddressAllowed,
  isLoopbackAddress,
  normalizeRemoteAddress
} from '../shared/lan-access.ts';

export interface AgentRpcOptions {
  tools: AgentTools;
  token: string;
  version: string;
  host?: string;
  port?: number;
  confirmWrite?: ConfirmAgentToolWrite;
  lanEnabled?: boolean;
  allowlist?: string[];
  cdpPort?: number | null;
  audit?: (record: AgentAuditRecord) => void;
}

export interface AgentRpcInfo {
  host: string;
  port: number;
  url: string;
  tokenFile?: string;
}

export interface AgentRpcAccessConfig {
  lanEnabled: boolean;
  allowlist: string[];
  cdpPort: number | null;
}

class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RpcError(-32600, '请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AgentRpcServer {
  readonly tools: AgentTools;
  readonly token: string;
  readonly version: string;
  readonly port: number;
  readonly confirmWrite: ConfirmAgentToolWrite | undefined;
  private hostValue: string;
  private lanEnabledValue: boolean;
  private allowlistValue: string[];
  private cdpPortValue: number | null;
  private readonly audit: ((record: AgentAuditRecord) => void) | undefined;
  private server: Server | null = null;
  private actualPort = 0;
  private tokenFile: string | undefined;

  constructor(options: AgentRpcOptions) {
    this.tools = options.tools;
    this.token = options.token;
    this.version = options.version;
    this.hostValue = options.host ?? '127.0.0.1';
    this.port = options.port ?? 7420;
    this.confirmWrite = options.confirmWrite;
    this.lanEnabledValue = options.lanEnabled === true;
    this.allowlistValue = [...(options.allowlist ?? [])];
    this.cdpPortValue = options.cdpPort ?? null;
    this.audit = options.audit;
  }

  get host(): string {
    return this.hostValue;
  }

  async start(tokenFile?: string): Promise<AgentRpcInfo> {
    if (this.server) return this.info(tokenFile);
    if (tokenFile !== undefined) this.tokenFile = tokenFile;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error): void => reject(error);
        this.server!.once('error', fail);
        this.server!.listen(this.port, this.hostValue, () => {
          this.server!.off('error', fail);
          resolve();
        });
      });
    } catch (error) {
      const server = this.server;
      this.server = null;
      this.actualPort = 0;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(agentListenError(error, this.hostValue, this.port));
    }
    const address = this.server.address() as AddressInfo;
    this.actualPort = address.port;
    return this.info(tokenFile);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.actualPort = 0;
  }

  /**
   * 关闭旧 server 后在同一端口监听新地址；失败时尝试恢复旧地址，避免把本机服务留成停止态。
   * 端口被其它进程占用时抛中文错误，由 IPC 返回 UI 展示。
   */
  async restart(host: string, access?: Partial<AgentRpcAccessConfig>): Promise<AgentRpcInfo> {
    const previousHost = this.hostValue;
    await this.stop();
    this.hostValue = host;
    if (access?.lanEnabled !== undefined) this.lanEnabledValue = access.lanEnabled;
    if (access?.allowlist !== undefined) this.allowlistValue = [...access.allowlist];
    if (access?.cdpPort !== undefined) this.cdpPortValue = access.cdpPort;
    try {
      return await this.start();
    } catch (error) {
      this.hostValue = previousHost;
      let rollback = '';
      try {
        await this.start();
      } catch (rollbackError) {
        rollback = `；恢复旧监听也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}${rollback}`);
    }
  }

  info(tokenFile?: string): AgentRpcInfo {
    const file = tokenFile ?? this.tokenFile;
    return {
      host: this.host,
      port: this.actualPort || this.port,
      url: `http://${this.host}:${this.actualPort || this.port}`,
      ...(file ? { tokenFile: file } : {})
    };
  }

  private requestAccess(request: IncomingMessage): { remoteAddress: string; origin: 'local' | 'lan'; allowed: boolean } {
    const remoteAddress = normalizeRemoteAddress(request.socket.remoteAddress);
    const allowed = isAddressAllowed(remoteAddress, this.allowlistValue);
    return {
      remoteAddress,
      origin: isLoopbackAddress(remoteAddress) ? 'local' : 'lan',
      allowed
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${this.host}`);
      const access = this.requestAccess(request);
      if (!access.allowed) {
        this.audit?.({
          tool: 'lan_access_check',
          ok: false,
          code: 'LAN_NOT_ALLOWED',
          source: 'rpc',
          args: { path: url.pathname },
          message: `来源地址不在白名单：${access.remoteAddress || '(未知)'}`,
          remoteAddress: access.remoteAddress,
          origin: access.origin
        });
        sendJson(response, 403, { ok: false, error: 'LAN_NOT_ALLOWED' });
        return;
      }
      if (!tokenMatches(request.headers.authorization, this.token)) {
        response.setHeader('www-authenticate', 'Bearer');
        sendJson(response, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          version: this.version,
          toolCount: this.tools.list().length,
          host: this.host,
          port: this.actualPort || this.port,
          lanEnabled: this.lanEnabledValue,
          allowlist: [...this.allowlistValue],
          cdpPort: this.cdpPortValue
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/rpc') {
        const body = await readBody(request);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          sendJson(response, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
          return;
        }
        if (Array.isArray(parsed)) {
          const results = await Promise.all(parsed.map((item) => this.handleRpc(item, access)));
          sendJson(response, 200, results);
          return;
        }
        sendJson(response, 200, await this.handleRpc(parsed, access));
        return;
      }

      sendJson(response, 404, { ok: false, error: '接口不存在' });
    } catch (error) {
      const status = error instanceof RpcError && error.code === -32600 ? 413 : 500;
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async handleRpc(
    payload: unknown,
    access: { remoteAddress: string; origin: 'local' | 'lan' }
  ): Promise<unknown> {
    const id = isRecord(payload) && (payload.id === null || typeof payload.id === 'string' || typeof payload.id === 'number')
      ? payload.id
      : null;
    if (!isRecord(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: '请求格式不合法' } };
    }
    try {
      const params = isRecord(payload.params) ? payload.params : {};
      let result: unknown;
      if (payload.method === 'tools/list') {
        result = { tools: this.tools.summaries() };
      } else if (payload.method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!this.tools.has(name)) throw new RpcError(-32601, `工具不存在：${name || '(空)'}`);
        const args = isRecord(params.arguments) ? params.arguments : {};
        const toolResult = await this.callTool(name, args, access);
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult) }],
          structuredContent: toolResult,
          isError: isRecord(toolResult) && toolResult.ok === false
        };
      } else if (this.tools.has(payload.method)) {
        result = await this.callTool(payload.method, params, access);
      } else {
        throw new RpcError(-32601, `方法不存在：${payload.method}`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const rpcError = error instanceof RpcError
        ? error
        : new RpcError(-32000, error instanceof Error ? error.message : String(error));
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: rpcError.code,
          message: rpcError.message,
          ...(rpcError.data !== undefined ? { data: rpcError.data } : {})
        }
      };
    }
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    access: { remoteAddress: string; origin: 'local' | 'lan' }
  ): Promise<unknown> {
    const started = Date.now();
    const authorization = await authorizeAgentToolCall(name, args, this.confirmWrite);
    const result = authorization.ok ? await this.tools.call(name, args) : authorization;
    const record = isRecord(result) ? result : null;
    this.audit?.({
      tool: name,
      ok: record?.ok !== false,
      ...(typeof record?.code === 'string' ? { code: record.code } : {}),
      source: 'rpc',
      args,
      ...(typeof record?.message === 'string' ? { message: record.message } : {}),
      elapsedMs: Date.now() - started,
      remoteAddress: access.remoteAddress,
      origin: access.origin
    });
    return result;
  }
}

function agentListenError(error: unknown, host: string, port: number): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const detail = error instanceof Error ? error.message : String(error);
  if (code === 'EADDRINUSE') {
    return `Agent 端口被占用：${host}:${port} 无法监听。请关闭占用 ${port} 端口的程序后重试。`;
  }
  return `Agent 服务启动失败（${host}:${port}）：${detail}`;
}

/** 主进程热重启入口；保留显式函数名，方便测试与 UI 调用链定位。 */
export async function restartAgentServer(
  server: AgentRpcServer,
  host: string,
  access?: Partial<AgentRpcAccessConfig>
): Promise<AgentRpcInfo> {
  return await server.restart(host, access);
}

export function createAgentToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createAgentTokenFile(userDataDir: string): { token: string; tokenFile: string } {
  const token = createAgentToken();
  const tokenFile = join(userDataDir, 'agent-token');
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return { token, tokenFile };
}
