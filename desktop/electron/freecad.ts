/**
 * FreeCAD 无界面后台任务运行器（可选组件，LGPL，独立进程调用）。
 *
 * - 探测：设置里指定的路径 → AUTOMATIONCAD_FREECAD_CMD → 常见安装路径（Windows `C:\Program Files\FreeCAD 1.x\bin\freecadcmd.exe` 等）→ PATH。
 * - 版本：`freecadcmd --version`，要求 FreeCAD ≥ 1.0（TechDraw 第一角投影组、范围尺寸）。
 * - 作业：串行队列；每个作业一个临时目录（in/ STEP 副本、out/ 产物、job.json），超时/取消杀进程树，
 *   stderr 环形收集，结束后无论成败都清理临时目录。产物按 fileStem 写入调用方给定的输出目录。
 * - 协议：desktop/src/drawings/protocol.ts（内核无关 JSON，与 build123d sidecar 同风格）。
 *
 * 本文件不依赖 electron，便于用假 freecadcmd（scripts/fake-freecadcmd.mjs）做集成测试。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import {
  buildDrawingJob,
  parseDrawingJobResult,
  parseProgressLine,
  serializeDrawingJob,
  type DrawingFormat,
  type DrawingHoleSpec,
  type DrawingJob,
  type DrawingJobOptions,
  type DrawingJobPart,
  type DrawingJobResult,
  type DrawingPaper,
  type DrawingPartResult,
  type DrawingTitleBlock
} from '../src/drawings/protocol.ts';

export const FREECAD_INSTALL_HINT =
  'FreeCAD 是可选组件，只影响工程图/钣金展开/FEM 等后台任务，建模不受影响。请从 https://www.freecad.org/downloads.php 安装 FreeCAD 1.0 或更新版本（Windows 默认装到 C:\\Program Files\\FreeCAD 1.0），'
  + '然后在「工程图」里点「重新检测」，或「指定 freecadcmd 路径」选择安装目录 bin 下的 freecadcmd.exe。';

export type FreecadSource = 'configured' | 'env' | 'detected';

export interface FreecadInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: FreecadSource | null;
  reason: string;
  installHint: string;
  checkedAt: string | null;
}

export interface FreecadVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

export interface FreecadCandidate {
  path: string;
  source: FreecadSource;
}

export interface CandidateOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  configuredPath?: string | null;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

interface CommandSpec {
  command: string;
  args: string[];
}

const COMMAND_NAMES = ['freecadcmd', 'FreeCADCmd'];
const EXECUTABLE_BASENAME = /^(freecadcmd|freecad\.cmd)(\.exe)?$/i;

function defaultExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function versionOfDirName(name: string): number[] {
  const match = /FreeCAD[ _-]?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : [0, 0, 0];
}

/** 设置里只接受 freecadcmd 可执行文件（拒绝 GUI 版 FreeCAD.exe 和任意程序）。 */
export function isFreecadCmdPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof path !== 'string' || !path.trim()) return false;
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(path)) return false;
  return EXECUTABLE_BASENAME.test(pathApi.basename(path));
}

/** 候选列表（按优先级，去重）；纯函数，fs 访问可注入。 */
export function freecadCandidates(options: CandidateOptions = {}): FreecadCandidate[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;
  const listDir = options.listDir ?? defaultListDir;
  const pathApi = platform === 'win32' ? win32 : posix;
  const list: FreecadCandidate[] = [];
  const push = (path: string, source: FreecadSource): void => {
    if (path && !list.some((item) => item.path.toLowerCase() === path.toLowerCase())) list.push({ path, source });
  };

  const configured = options.configuredPath?.trim();
  if (configured) push(configured, 'configured');
  const fromEnv = env.AUTOMATIONCAD_FREECAD_CMD?.trim();
  if (fromEnv) push(fromEnv, 'env');

  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files',
      env.LOCALAPPDATA ? pathApi.join(env.LOCALAPPDATA, 'Programs') : undefined]
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    const found: Array<{ path: string; version: number[] }> = [];
    for (const root of [...new Set(roots)]) {
      for (const entry of listDir(root)) {
        if (!/^FreeCAD[ _-]?1\.\d+/i.test(entry)) continue;
        const candidate = pathApi.join(root, entry, 'bin', 'freecadcmd.exe');
        if (exists(candidate)) found.push({ path: candidate, version: versionOfDirName(entry) });
      }
    }
    found.sort((a, b) => (b.version[0]! - a.version[0]!) || (b.version[1]! - a.version[1]!) || (b.version[2]! - a.version[2]!));
    for (const item of found) push(item.path, 'detected');
    for (const fixed of ['C:\\Program Files\\FreeCAD 1.0\\bin\\freecadcmd.exe', 'C:\\Program Files\\FreeCAD 1.1\\bin\\freecadcmd.exe']) {
      if (exists(fixed)) push(fixed, 'detected');
    }
  } else if (platform === 'darwin') {
    for (const fixed of ['/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd', '/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd']) {
      if (exists(fixed)) push(fixed, 'detected');
    }
  } else {
    for (const fixed of ['/usr/bin/freecadcmd', '/usr/local/bin/freecadcmd', '/usr/lib/freecad/bin/freecadcmd', '/snap/bin/freecad.cmd']) {
      if (exists(fixed)) push(fixed, 'detected');
    }
  }

  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const separator = platform === 'win32' ? ';' : delimiterFor(platform);
  for (const directory of (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean)) {
    for (const name of COMMAND_NAMES) {
      for (const extension of extensions) {
        const candidate = pathApi.join(directory, `${name}${extension.toLowerCase()}`);
        if (exists(candidate)) push(candidate, 'detected');
      }
    }
  }
  return list;
}

function delimiterFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : (platform === process.platform ? delimiter : ':');
}

/** 解析 `FreeCAD 1.0.0 Revision: 39109 (Git)` 一类输出。 */
export function parseFreecadVersion(text: string): FreecadVersion | null {
  const match = /FreeCAD\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(text ?? '');
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return { major, minor, patch, text: `${major}.${minor}.${patch}` };
}

export function isSupportedFreecadVersion(version: FreecadVersion | null): boolean {
  return Boolean(version && version.major >= 1);
}

function isJavaScriptFile(path: string): boolean {
  return ['.js', '.mjs', '.cjs'].includes(extname(path).toLowerCase());
}

function commandFor(path: string): CommandSpec {
  // 测试桩：.mjs/.js 用当前 node 运行（仅环境变量/测试注入会走到这里，设置界面只收 freecadcmd）
  if (isJavaScriptFile(path)) return { command: process.execPath, args: [path] };
  return { command: path, args: [] };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => undefined);
    } catch {
      // 进程可能已退出
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 忽略退出竞态
    }
  }
}

interface ProcessRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
}

/** stderr/stdout 环形缓冲：只保留最后 limit 字节，避免 FreeCAD 刷屏占内存。 */
export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  private readonly limit: number;
  constructor(limit = 64 * 1024) {
    this.limit = limit;
  }
  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    if (this.size > this.limit && this.chunks.length === 1) {
      this.chunks[0] = this.chunks[0]!.slice(-this.limit);
      this.size = this.chunks[0].length;
    }
  }
  text(): string {
    return this.chunks.join('');
  }
}

function runProcess(spec: CommandSpec, options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
}): Promise<ProcessRun> {
  return new Promise((resolveRun) => {
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      resolveRun({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false,
        spawnError: (error as NodeJS.ErrnoException).code ?? String(error) });
      return;
    }
    let pending = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout.push(chunk);
      if (!options.onStdoutLine) return;
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        options.onStdoutLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
      if (pending.length > 64 * 1024) pending = pending.slice(-1024);
    });
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      cancelled = true;
      killTree(child);
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (run: Omit<ProcessRun, 'stdout' | 'stderr' | 'timedOut' | 'cancelled'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (pending && options.onStdoutLine) options.onStdoutLine(pending);
      resolveRun({ ...run, stdout: stdout.text(), stderr: stderr.text(), timedOut, cancelled });
    };
    child.once('error', (error: NodeJS.ErrnoException) => finish({ code: null, signal: null, spawnError: error.code ?? error.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

/** 运行 `<cmd> --version` 并解析版本；失败给出中文原因。 */
export async function probeFreecad(path: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{
  ok: boolean;
  version?: FreecadVersion;
  reason?: string;
}> {
  const spec = commandFor(path);
  const baseEnv = options.env ?? process.env;
  const run = await runProcess({ command: spec.command, args: [...spec.args, '--version'] }, {
    env: isJavaScriptFile(path) ? { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } : baseEnv,
    timeoutMs: options.timeoutMs ?? 30_000
  });
  if (run.spawnError) return { ok: false, reason: `无法启动 ${path}（${run.spawnError}）` };
  if (run.timedOut) return { ok: false, reason: `${path} --version 超时` };
  const version = parseFreecadVersion(`${run.stdout}\n${run.stderr}`);
  if (!version) return { ok: false, reason: `${path} 不是可识别的 FreeCAD 命令行程序` };
  if (!isSupportedFreecadVersion(version)) {
    return { ok: false, version, reason: `FreeCAD ${version.text} 版本过旧，需要 1.0 或更新版本` };
  }
  return { ok: true, version };
}

export type FreecadJobState = 'queued' | 'preparing' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timeout';

export interface FreecadJobPartSpec {
  partKey: string;
  partId: string;
  fileStem: string;
  name: string;
  material: string;
  drawingNo: string;
  quantity: number;
  scale?: string;
  paper?: DrawingPaper;
  /** 特征树孔语义（随作业 JSON 下发）；缺省时 FreeCAD 侧按圆柱面几何识别 */
  holes?: DrawingHoleSpec[];
}

export interface FreecadJobSpec {
  label?: string;
  parts: FreecadJobPartSpec[];
  /** 取得零件 STEP（例如让 build123d sidecar 现场导出）；返回的文件会被复制进作业临时目录 */
  resolveStep: (part: FreecadJobPartSpec, signal: AbortSignal) => Promise<string>;
  outputDir: string;
  options?: Partial<DrawingJobOptions>;
  titleBlock?: Partial<DrawingTitleBlock>;
  /** 作业结束（含失败/取消）后回调，用于更新清单；抛错不影响队列 */
  onSettled?: (outcome: FreecadJobOutcome) => void | Promise<void>;
}

export interface FreecadJobPartOutcome {
  part: FreecadJobPartSpec;
  result: DrawingPartResult;
  stepSha256?: string;
}

export interface FreecadJobOutcome {
  jobId: string;
  state: Exclude<FreecadJobState, 'queued' | 'preparing' | 'running'>;
  message: string;
  freecadVersion?: string;
  parts: FreecadJobPartOutcome[];
  stderrTail: string;
  durationMs: number;
}

export interface FreecadJobSnapshot {
  jobId: string;
  label: string;
  state: FreecadJobState;
  total: number;
  done: number;
  currentPartId: string | null;
  message: string;
  createdAt: string;
  finishedAt: string | null;
  outcome?: FreecadJobOutcome;
}

export interface FreecadRunnerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** techdraw_job.py 路径解析；返回 null 表示脚本缺失 */
  resolveScript: () => string | null;
  getConfiguredPath?: () => string | null;
  /** 覆盖探测（测试用），优先级最高 */
  command?: string;
  tempRoot?: string;
  baseTimeoutMs?: number;
  perPartTimeoutMs?: number;
  maxTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** FreeCAD 侧 PDF 渲染失败时的兜底（主进程用 Electron 打印 SVG） */
  svgToPdf?: (svgPath: string, pdfPath: string, paper: string) => Promise<void>;
  onJob?: (snapshot: FreecadJobSnapshot) => void;
  keepTemp?: boolean;
  candidateOptions?: Omit<CandidateOptions, 'configuredPath' | 'env' | 'platform'>;
}

interface QueuedJob {
  snapshot: FreecadJobSnapshot;
  spec: FreecadJobSpec;
  controller: AbortController;
}

const MAX_HISTORY = 20;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function failedParts(parts: readonly FreecadJobPartSpec[], message: string): FreecadJobPartOutcome[] {
  return parts.map((part) => ({ part, result: { partId: part.partId, ok: false, files: {}, warnings: [], error: message } }));
}

export class FreecadRunner {
  private readonly options: FreecadRunnerOptions;
  private infoCache: FreecadInfo | null = null;
  private detecting: Promise<FreecadInfo> | null = null;
  private readonly queue: QueuedJob[] = [];
  private readonly history: FreecadJobSnapshot[] = [];
  private running: QueuedJob | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 额外的作业事件监听（IPC 广播在注册时挂上） */
  onJobListener: ((snapshot: FreecadJobSnapshot) => void) | null = null;

  constructor(options: FreecadRunnerOptions) {
    this.options = options;
  }

  /** 最近一次探测结果（未探测过时返回“未检测”）。 */
  info(): FreecadInfo {
    return this.infoCache ? { ...this.infoCache } : {
      available: false,
      path: null,
      version: null,
      source: null,
      reason: '尚未检测 FreeCAD',
      installHint: FREECAD_INSTALL_HINT,
      checkedAt: null
    };
  }

  /** 探测并缓存；force=false 时复用缓存。 */
  async detect(force = false): Promise<FreecadInfo> {
    if (!force && this.infoCache) return this.info();
    if (this.detecting) return await this.detecting;
    const work = this.detectOnce().then((info) => {
      this.infoCache = info;
      return { ...info };
    });
    this.detecting = work.finally(() => {
      this.detecting = null;
    });
    return await this.detecting;
  }

  private async detectOnce(): Promise<FreecadInfo> {
    const env = this.options.env ?? process.env;
    const checkedAt = new Date().toISOString();
    const configured = this.options.getConfiguredPath?.() ?? null;
    const candidates: FreecadCandidate[] = this.options.command
      ? [{ path: this.options.command, source: 'env' }]
      : freecadCandidates({
        ...(this.options.candidateOptions ?? {}),
        platform: this.options.platform ?? process.platform,
        env,
        configuredPath: configured
      });
    const unavailable = (reason: string): FreecadInfo => ({
      available: false, path: null, version: null, source: null, reason, installHint: FREECAD_INSTALL_HINT, checkedAt
    });
    if (!this.options.resolveScript()) return unavailable('FreeCAD 作业脚本 techdraw_job.py 缺失，安装包可能不完整');
    if (candidates.length === 0) return unavailable('未找到 FreeCAD（freecadcmd）');
    const reasons: string[] = [];
    for (const candidate of candidates) {
      if (!isJavaScriptFile(candidate.path) && !existsSync(candidate.path)) {
        reasons.push(`${candidate.source === 'configured' ? '设置中的路径' : candidate.path} 不存在`);
        continue;
      }
      const probe = await probeFreecad(candidate.path, { env, timeoutMs: this.options.probeTimeoutMs ?? 30_000 });
      if (probe.ok && probe.version) {
        return {
          available: true,
          path: candidate.path,
          version: probe.version.text,
          source: candidate.source,
          reason: `FreeCAD ${probe.version.text} 可用`,
          installHint: FREECAD_INSTALL_HINT,
          checkedAt
        };
      }
      reasons.push(probe.reason ?? `${candidate.path} 不可用`);
    }
    return unavailable(reasons.join('；'));
  }

  jobs(): FreecadJobSnapshot[] {
    const active = [this.running, ...this.queue].filter((item): item is QueuedJob => item !== null).map((item) => ({ ...item.snapshot }));
    return [...active, ...this.history.map((item) => ({ ...item }))];
  }

  /** 入队；FreeCAD 不可用或脚本缺失时在执行阶段失败（UI 应先看 info()）。 */
  enqueue(spec: FreecadJobSpec): FreecadJobSnapshot {
    if (this.disposed) throw new Error('FreeCAD 运行器已关闭');
    if (!Array.isArray(spec.parts) || spec.parts.length === 0) throw new Error('作业没有零件');
    const jobId = `fc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const snapshot: FreecadJobSnapshot = {
      jobId,
      label: spec.label ?? `${spec.parts.length} 个零件工程图`,
      state: 'queued',
      total: spec.parts.length,
      done: 0,
      currentPartId: null,
      message: '排队中',
      createdAt: new Date().toISOString(),
      finishedAt: null
    };
    const job: QueuedJob = { snapshot, spec, controller: new AbortController() };
    this.queue.push(job);
    this.emit(job);
    this.chain = this.chain.then(() => this.runNext(job), () => this.runNext(job));
    return { ...snapshot };
  }

  /** 取消排队或运行中的作业；返回是否找到。 */
  cancel(jobId: string): boolean {
    const queued = this.queue.find((job) => job.snapshot.jobId === jobId);
    if (queued) {
      queued.controller.abort();
      return true;
    }
    if (this.running?.snapshot.jobId === jobId) {
      this.running.controller.abort();
      return true;
    }
    return false;
  }

  /** 等待队列清空（测试/退出用）。 */
  async idle(): Promise<void> {
    await this.chain;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.queue) job.controller.abort();
    this.running?.controller.abort();
    await this.chain.catch(() => undefined);
  }

  private emit(job: QueuedJob): void {
    try {
      this.options.onJob?.({ ...job.snapshot });
      this.onJobListener?.({ ...job.snapshot });
    } catch (error) {
      console.warn('[FREECAD_JOB_LISTENER_FAILED]', error);
    }
  }

  private update(job: QueuedJob, patch: Partial<FreecadJobSnapshot>): void {
    Object.assign(job.snapshot, patch);
    this.emit(job);
  }

  private async runNext(job: QueuedJob): Promise<void> {
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.running = job;
    let outcome: FreecadJobOutcome;
    try {
      outcome = await this.execute(job);
    } catch (error) {
      outcome = {
        jobId: job.snapshot.jobId,
        state: 'failed',
        message: `作业异常：${error instanceof Error ? error.message : String(error)}`,
        parts: failedParts(job.spec.parts, '作业异常'),
        stderrTail: '',
        durationMs: 0
      };
    }
    this.running = null;
    this.update(job, {
      state: outcome.state,
      message: outcome.message,
      finishedAt: new Date().toISOString(),
      done: outcome.parts.filter((part) => part.result.ok).length,
      currentPartId: null,
      outcome
    });
    this.history.unshift({ ...job.snapshot });
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    try {
      await job.spec.onSettled?.(outcome);
    } catch (error) {
      console.warn('[FREECAD_JOB_SETTLE_FAILED]', error);
    }
  }

  private timeoutFor(parts: number): number {
    const base = this.options.baseTimeoutMs ?? 120_000;
    const per = this.options.perPartTimeoutMs ?? 60_000;
    const max = this.options.maxTimeoutMs ?? 30 * 60_000;
    return Math.min(max, base + per * parts);
  }

  private async execute(job: QueuedJob): Promise<FreecadJobOutcome> {
    const started = Date.now();
    const { spec, controller, snapshot } = job;
    const cancelledOutcome = (message = '已取消'): FreecadJobOutcome => ({
      jobId: snapshot.jobId, state: 'cancelled', message, parts: failedParts(spec.parts, '已取消'), stderrTail: '',
      durationMs: Date.now() - started
    });
    if (controller.signal.aborted) return cancelledOutcome();

    const info = await this.detect(false);
    if (!info.available || !info.path) {
      return {
        jobId: snapshot.jobId, state: 'failed', message: `FreeCAD 不可用：${info.reason}`,
        parts: failedParts(spec.parts, 'FreeCAD 不可用'), stderrTail: '', durationMs: Date.now() - started
      };
    }
    const script = this.options.resolveScript();
    if (!script) {
      return {
        jobId: snapshot.jobId, state: 'failed', message: 'FreeCAD 作业脚本缺失',
        parts: failedParts(spec.parts, '脚本缺失'), stderrTail: '', durationMs: Date.now() - started
      };
    }

    const tempRoot = this.options.tempRoot ?? tmpdir();
    mkdirSync(tempRoot, { recursive: true });
    const temp = mkdtempSync(join(tempRoot, 'automationcad-freecad-'));
    try {
      const inDir = join(temp, 'in');
      const outDir = join(temp, 'out');
      mkdirSync(inDir);
      mkdirSync(outDir);

      // 1) 准备 STEP：逐件向内核要产物，单件失败不阻断其他零件
      this.update(job, { state: 'preparing', message: '正在导出零件 STEP…' });
      const prepared: Array<{ part: FreecadJobPartSpec; step: string; sha: string }> = [];
      const prepFailures: FreecadJobPartOutcome[] = [];
      for (const part of spec.parts) {
        if (controller.signal.aborted) return cancelledOutcome();
        this.update(job, { currentPartId: part.partId, message: `导出 STEP：${part.name}` });
        try {
          const source = await spec.resolveStep(part, controller.signal);
          if (!source || !existsSync(source)) throw new Error('内核未返回 STEP 文件');
          const target = join(inDir, `${part.fileStem}.step`);
          copyFileSync(source, target);
          prepared.push({ part, step: target, sha: sha256File(target) });
        } catch (error) {
          prepFailures.push({
            part,
            result: { partId: part.partId, ok: false, files: {}, warnings: [], error: `STEP 导出失败：${error instanceof Error ? error.message : String(error)}` }
          });
        }
      }
      if (controller.signal.aborted) return cancelledOutcome();
      if (prepared.length === 0) {
        return {
          jobId: snapshot.jobId, state: 'failed', message: '没有可出图的零件（STEP 导出全部失败）',
          parts: prepFailures, stderrTail: '', durationMs: Date.now() - started
        };
      }

      // 2) 写作业 JSON 并运行 freecadcmd
      const jobParts: DrawingJobPart[] = prepared.map(({ part, step }) => ({
        partId: part.partId,
        fileStem: part.fileStem,
        name: part.name,
        material: part.material,
        drawingNo: part.drawingNo,
        quantity: part.quantity,
        step,
        ...(part.scale ? { scale: part.scale } : {}),
        ...(part.paper ? { paper: part.paper } : {}),
        ...(part.holes ? { holes: part.holes } : {})
      }));
      const drawingJob: DrawingJob = buildDrawingJob({
        jobId: snapshot.jobId,
        outputDir: outDir,
        parts: jobParts,
        ...(spec.options ? { options: spec.options } : {}),
        ...(spec.titleBlock ? { titleBlock: spec.titleBlock } : {})
      });
      const jobPath = join(temp, 'job.json');
      writeFileSync(jobPath, serializeDrawingJob(drawingJob), 'utf8');
      this.update(job, { state: 'running', done: 0, message: `FreeCAD 出图中（0/${prepared.length}）` });
      const command = commandFor(info.path);
      const env: NodeJS.ProcessEnv = {
        ...(this.options.env ?? process.env),
        AUTOMATIONCAD_FREECAD_JOB: jobPath,
        // 测试桩（.mjs）在 Electron 主进程里经 process.execPath 运行时需要按 node 模式启动
        ...(isJavaScriptFile(info.path) ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      };
      let done = 0;
      const run = await runProcess({ command: command.command, args: [...command.args, script] }, {
        cwd: temp,
        env,
        timeoutMs: this.timeoutFor(prepared.length),
        signal: controller.signal,
        onStdoutLine: (line) => {
          const event = parseProgressLine(line);
          if (!event) return;
          if (event.event === 'part-start') {
            this.update(job, { currentPartId: event.partId, message: `FreeCAD 出图中（${done}/${prepared.length}）：${event.partId}` });
          } else if (event.event === 'part-done') {
            done += 1;
            this.update(job, { done, message: `FreeCAD 出图中（${done}/${prepared.length}）` });
          }
        }
      });
      const stderrTail = run.stderr.slice(-2_000);
      if (run.cancelled) return { ...cancelledOutcome(), stderrTail };
      if (run.timedOut) {
        return {
          jobId: snapshot.jobId, state: 'timeout', message: `FreeCAD 作业超时（${Math.round(this.timeoutFor(prepared.length) / 1000)} 秒），已终止进程`,
          parts: [...failedParts(prepared.map((item) => item.part), '超时'), ...prepFailures], stderrTail, durationMs: Date.now() - started
        };
      }
      if (run.spawnError) {
        return {
          jobId: snapshot.jobId, state: 'failed', message: `无法启动 FreeCAD（${run.spawnError}）`,
          parts: [...failedParts(prepared.map((item) => item.part), '无法启动 FreeCAD'), ...prepFailures], stderrTail, durationMs: Date.now() - started
        };
      }

      // 3) 读结果、PDF 兜底、交付到输出目录
      const resultPath = join(outDir, 'result.json');
      let parsed: DrawingJobResult;
      if (!existsSync(resultPath)) {
        const detail = stderrTail.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        return {
          jobId: snapshot.jobId, state: 'failed',
          message: `FreeCAD 进程退出（code=${run.code ?? 'null'}${run.signal ? `, ${run.signal}` : ''}）但没有写出结果${detail ? `：${detail}` : ''}`,
          parts: [...failedParts(prepared.map((item) => item.part), 'FreeCAD 未写出结果'), ...prepFailures], stderrTail, durationMs: Date.now() - started
        };
      }
      try {
        parsed = parseDrawingJobResult(JSON.parse(readFileSync(resultPath, 'utf8')), drawingJob);
      } catch (error) {
        parsed = parseDrawingJobResult(null, drawingJob);
        parsed.error = `结果 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
      }
      const wantsPdf = drawingJob.options.formats.includes('pdf');
      mkdirSync(spec.outputDir, { recursive: true });
      const outcomes: FreecadJobPartOutcome[] = [];
      for (const item of prepared) {
        const result = parsed.parts.find((entry) => entry.partId === item.part.partId)
          ?? { partId: item.part.partId, ok: false, files: {}, warnings: [], error: '未返回结果' };
        if (result.ok && wantsPdf && !result.files.pdf && result.files.svg && this.options.svgToPdf) {
          const pdfName = `${item.part.fileStem}.pdf`;
          try {
            await this.options.svgToPdf(join(outDir, result.files.svg), join(outDir, pdfName), result.paper ?? 'A3');
            if (existsSync(join(outDir, pdfName))) {
              result.files.pdf = pdfName;
              result.warnings.push('PDF 由主进程根据 SVG 兜底生成');
            }
          } catch (error) {
            result.warnings.push(`PDF 兜底失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (result.ok) {
          const delivered: Partial<Record<DrawingFormat, string>> = {};
          for (const [format, name] of Object.entries(result.files) as Array<[DrawingFormat, string]>) {
            const source = join(outDir, name);
            if (!existsSync(source)) {
              result.warnings.push(`${format} 文件缺失`);
              continue;
            }
            const target = join(spec.outputDir, name);
            const staging = `${target}.${snapshot.jobId}.tmp`;
            copyFileSync(source, staging);
            renameSync(staging, target);
            delivered[format] = name;
          }
          result.files = delivered;
          if (Object.keys(delivered).length === 0) {
            result.ok = false;
            result.error = '产物文件缺失';
          }
        }
        outcomes.push({ part: item.part, result, stepSha256: item.sha });
      }
      outcomes.push(...prepFailures);
      const okCount = outcomes.filter((entry) => entry.result.ok).length;
      const state: FreecadJobOutcome['state'] = okCount === outcomes.length ? 'succeeded' : okCount > 0 ? 'partial' : 'failed';
      const message = state === 'succeeded'
        ? `已生成 ${okCount} 张工程图`
        : state === 'partial'
          ? `已生成 ${okCount}/${outcomes.length} 张工程图，其余失败`
          : `工程图生成失败${parsed.error ? `：${parsed.error}` : ''}`;
      return {
        jobId: snapshot.jobId,
        state,
        message,
        ...(parsed.freecadVersion ? { freecadVersion: parsed.freecadVersion } : {}),
        parts: outcomes,
        stderrTail,
        durationMs: Date.now() - started
      };
    } finally {
      if (!this.options.keepTemp && process.env.AUTOMATIONCAD_FREECAD_KEEP_TEMP !== '1') {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  }
}

/** 开发态用仓库内 spike 脚本，打包态用 resources/freecad/techdraw_job.py。 */
export function resolveTechdrawScript(options: { isPackaged?: boolean; resourcesPath?: string; appRoot?: string } = {}): string | null {
  if (options.isPackaged) {
    const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
    const path = resources ? join(resources, 'freecad', 'techdraw_job.py') : '';
    return path && existsSync(path) ? path : null;
  }
  const roots = [options.appRoot, process.cwd(), resolve(process.cwd(), '..')].filter((item): item is string => Boolean(item));
  for (const root of roots) {
    const path = join(root, 'spike', 'freecad', 'techdraw_job.py');
    if (existsSync(path)) return path;
  }
  return null;
}

export function isAbsolutePathLike(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}
