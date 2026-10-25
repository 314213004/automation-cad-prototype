/**
 * CDP 外部转发器。
 *
 * Electron 只可靠地把 DevTools 监听在 127.0.0.1:9229（remote-debugging-address 会被忽略），
 * 这里用 node:net 在 0.0.0.0:9222 建一个白名单网关，双向 pipe 到回环 9229。
 * 非白名单来源在 TCP 建连后立即销毁并回调 onDenied，便于主进程写审计。
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { isAddressAllowed, normalizeRemoteAddress } from '../src/shared/lan-access.ts';

export interface CdpForwarderOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  allowlist: readonly string[];
  onDenied: (remoteAddress: string) => void;
  /** 仅测试注入；默认直接使用 socket.remoteAddress。 */
  resolveRemoteAddress?: (remoteAddress: string | undefined) => string | undefined;
}

export interface CdpForwarderState {
  running: boolean;
  listeningPort: number | null;
  targetReachable: boolean;
  /** 9229 可连且转发器在跑，面板 cdpActive 使用该值。 */
  active: boolean;
  error: string | null;
}

export class CdpForwarder {
  private readonly options: CdpForwarderOptions;
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private targetReachable = false;
  private lastError: string | null = null;
  private listening = false;
  private listeningPort: number | null = null;

  constructor(options: CdpForwarderOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.server = null;
        this.lastError = portError(error, this.options.listenPort);
        reject(new Error(this.lastError));
      };
      const onListening = (): void => {
        server.off('error', onError);
        this.listening = true;
        const address = server.address();
        this.listeningPort = typeof address === 'object' && address ? address.port : this.options.listenPort;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: this.options.listenHost, port: this.options.listenPort });
    });
    server.on('error', (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
    // 首轮探测完成后再返回，确保启动后的第一次面板/health 读取就能拿到真实 active 状态。
    await this.probeTarget();
    this.probeTimer = setInterval(() => { void this.probeTarget(); }, 1000);
  }

  async stop(): Promise<void> {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
    this.listening = false;
    this.listeningPort = null;
    this.targetReachable = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  state(): CdpForwarderState {
    return {
      running: this.server !== null && this.listening,
      listeningPort: this.listening ? this.listeningPort : null,
      targetReachable: this.targetReachable,
      active: this.listening && this.targetReachable,
      error: this.lastError
    };
  }

  private accept(socket: Socket): void {
    const raw = this.options.resolveRemoteAddress?.(socket.remoteAddress) ?? socket.remoteAddress;
    const remote = normalizeRemoteAddress(raw);
    if (!isAddressAllowed(remote, this.options.allowlist)) {
      this.options.onDenied(remote);
      socket.destroy();
      return;
    }
    const upstream = connect({ host: this.options.targetHost, port: this.options.targetPort });
    this.sockets.add(socket);
    this.sockets.add(upstream);
    const close = (): void => {
      this.sockets.delete(socket);
      this.sockets.delete(upstream);
    };
    socket.on('close', close);
    upstream.on('close', close);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      this.targetReachable = true;
      socket.pipe(upstream).pipe(socket);
    });
  }

  private async probeTarget(): Promise<void> {
    if (!this.listening) return;
    this.targetReachable = await probeTcp(this.options.targetHost, this.options.targetPort);
  }
}

function portError(error: unknown, port: number): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const detail = error instanceof Error ? error.message : String(error);
  return code === 'EADDRINUSE'
    ? `CDP 端口 ${port} 被占用：${detail}`
    : `CDP 转发器启动失败（${port}）：${detail}`;
}

function probeTcp(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

let current: CdpForwarder | null = null;

export async function startCdpForwarder(options: CdpForwarderOptions): Promise<CdpForwarder> {
  await stopCdpForwarder();
  const forwarder = new CdpForwarder(options);
  await forwarder.start();
  current = forwarder;
  return forwarder;
}

export async function stopCdpForwarder(): Promise<void> {
  const forwarder = current;
  current = null;
  if (forwarder) await forwarder.stop();
}

export function cdpForwarderState(): CdpForwarderState {
  return current?.state() ?? {
    running: false,
    listeningPort: null,
    targetReachable: false,
    active: false,
    error: null
  };
}

export function isCdpForwarderActive(): boolean {
  return cdpForwarderState().active;
}
