// Electron 诊断采集：环境、WebGL、内置数据包、KB、审计大小与最近错误。
import { BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KB_STATS } from '../src/agent/kb/search.ts';
import {
  buildDiagnosisReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
  type DiagnosisReport
} from '../src/shared/diagnostics.ts';

export interface WebglProbe {
  available: boolean;
  version?: string | null;
  renderer?: string | null;
}

export async function probeWebGL(): Promise<WebglProbe> {
  let window: BrowserWindow | null = null;
  try {
    window = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: {
        offscreen: true,
        sandbox: false,
        contextIsolation: true
      }
    });
    await window.loadURL('data:text/html,<html><body></body></html>');
    return await window.webContents.executeJavaScript(
      `(() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return { available: false };
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          return {
            available: true,
            version: String(gl.getParameter(gl.VERSION) || ''),
            renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '')
          };
        } catch (error) {
          return { available: false, renderer: String(error && error.message ? error.message : error) };
        }
      })()`
    ) as WebglProbe;
  } catch (error) {
    recordDiagnosticError('WEBGL_PROBE_FAILED', error);
    return { available: false };
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
  }
}

/** 读取内置数据包清单版本；只返回 id/version，不读取零件内容。 */
export function readBuiltinPackVersions(builtinDir: string): {
  version: string;
  count: number;
} {
  if (!existsSync(builtinDir)) return { version: 'missing', count: 0 };
  const manifests: Array<{ id: string; version: string }> = [];
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(builtinDir, entry.name, 'manifest.json');
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { id?: unknown; version?: unknown };
      manifests.push({
        id: typeof parsed.id === 'string' ? parsed.id : entry.name,
        version: typeof parsed.version === 'string' ? parsed.version : 'unknown'
      });
    } catch (error) {
      recordDiagnosticError('PACK_MANIFEST_READ_FAILED', error, { pack: entry.name });
    }
  }
  manifests.sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: manifests.length > 0
      ? manifests.map((manifest) => `${manifest.id}@${manifest.version}`).join(', ')
      : 'none',
    count: manifests.length
  };
}

export function auditFileBytes(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch (error) {
    recordDiagnosticError('AUDIT_STAT_FAILED', error, { fileName: path.split(/[\\/]/).pop() ?? '' });
    return 0;
  }
}

export async function collectDiagnosis(options: {
  appVersion: string;
  userDataPath: string;
  builtinDir: string;
  auditPath: string;
  webgl?: WebglProbe;
  generatedAt?: string;
}): Promise<DiagnosisReport> {
  const packs = readBuiltinPackVersions(options.builtinDir);
  const webgl = options.webgl ?? await probeWebGL();
  return buildDiagnosisReport({
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    appVersion: options.appVersion,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    userDataPath: options.userDataPath,
    webgl,
    dataPackVersion: packs.version,
    packCount: packs.count,
    kbDocs: KB_STATS.docs,
    kbChunks: KB_STATS.chunks,
    kbBytes: KB_STATS.bytes,
    auditPath: options.auditPath,
    auditBytes: auditFileBytes(options.auditPath),
    errors: recentDiagnosticErrors(20)
  });
}
