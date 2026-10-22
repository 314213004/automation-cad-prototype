import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import {
  DESIGN_MANIFEST_SCHEMA_VERSION,
  type DesignBomRow,
  type DesignFileEntry,
  type DesignFileKind,
  type DesignManifest
} from './types.ts';

export const PACKAGE_ENTRIES = {
  bom: 'bom.csv',
  pdf: 'report.pdf',
  glb: 'model.glb',
  dxf: 'drawing.dxf',
  manifest: 'manifest.json'
} as const;

export interface DesignPackageSources {
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt?: string;
  bom: readonly DesignBomRow[];
  bomCsv?: string | Uint8Array;
  pdf?: Uint8Array;
  glb?: Uint8Array;
  dxf?: string | Uint8Array;
}

export interface DesignPackageBuild {
  zip: Uint8Array;
  manifest: DesignManifest;
  manifestJson: string;
  zipSha256: string;
  skipped: string[];
}

interface SourceFile {
  path: string;
  kind: DesignFileKind;
  value: string | Uint8Array | undefined;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytesOf(value: string | Uint8Array): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function requireText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

/**
 * 固定产物路径打包，缺失或空文件跳过并记录，避免把空壳文件当作有效图纸上传。
 */
export function buildDesignPackage(sources: DesignPackageSources): DesignPackageBuild {
  const projectId = requireText(sources.projectId, 'projectId');
  const projectName = requireText(sources.projectName, 'projectName');
  const appVersion = requireText(sources.appVersion, 'appVersion');
  const createdAt = sources.createdAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('createdAt 必须是合法的 ISO 时间');

  const candidates: SourceFile[] = [
    { path: PACKAGE_ENTRIES.bom, kind: 'BOM', value: sources.bomCsv },
    { path: PACKAGE_ENTRIES.pdf, kind: 'PDF', value: sources.pdf },
    { path: PACKAGE_ENTRIES.glb, kind: 'GLTF', value: sources.glb },
    { path: PACKAGE_ENTRIES.dxf, kind: 'DXF', value: sources.dxf }
  ];

  const zip = new AdmZip();
  const files: DesignFileEntry[] = [];
  const skipped: string[] = [];
  let bomBytes: Uint8Array | null = null;

  for (const candidate of candidates) {
    const bytes = candidate.value === undefined ? null : bytesOf(candidate.value);
    if (bytes === null || bytes.byteLength === 0) {
      skipped.push(candidate.path);
      continue;
    }
    if (candidate.kind === 'BOM') bomBytes = bytes;
    const entry: DesignFileEntry = {
      path: candidate.path,
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
      kind: candidate.kind
    };
    files.push(entry);
    zip.addFile(candidate.path, Buffer.from(bytes));
  }

  if (files.length === 0) throw new Error('没有可打包的导出文件（BOM/PDF/GLB/DXF 均缺失）');

  const manifest: DesignManifest = {
    schemaVersion: DESIGN_MANIFEST_SCHEMA_VERSION,
    projectId,
    projectName,
    appVersion,
    createdAt,
    bomSha256: bomBytes ? sha256Hex(bomBytes) : '',
    files,
    bom: sources.bom.map((row) => ({ ...row }))
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  zip.addFile(PACKAGE_ENTRIES.manifest, Buffer.from(manifestJson, 'utf8'));
  const zipBytes = new Uint8Array(zip.toBuffer());

  return {
    zip: zipBytes,
    manifest,
    manifestJson,
    zipSha256: sha256Hex(zipBytes),
    skipped
  };
}
